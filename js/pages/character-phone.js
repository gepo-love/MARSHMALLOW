import { back, navigate, navigateDismissing, syncCurrentRoute } from '../core/router.js';
import { icon } from '../components/svg-icons.js';
import { showToast } from '../components/toast.js';
import { setButtonLoading } from '../components/generation-busy.js';
import { bindLongPress } from '../components/chat-bubble-menu.js';
import { openChatRowSheet } from '../components/chat-row-sheet.js';
import { saveImageSrc } from '../components/image-lightbox.js';
import { fileToCroppedCompressedDataUrl, fileToCroppedOptimizedAvatarDataUrl, IMAGE_CROP_PRESETS } from '../components/image-crop-modal.js';
import { fileToOptimizedAvatarDataUrl } from '../core/chat/chat-image-utils.js';
import { listBeautifyAssets } from '../core/beautify-assets.js';
import { ensureDefaultUser } from '../core/user-slot.js';
import * as db from '../core/db.js';
import {
  listCharacters,
  getCharacter,
  saveCharacterForUser,
} from '../core/character-store.js';
import { loadContactGroupsConfig, resolveCharacterGroupId } from '../core/contact-groups.js';
import { resolveCharacterPhoneSelection } from '../core/character-phone-selection.js';
import { loadRelationshipNetwork } from '../core/relationship-network.js';
import { canPhoneCharactersKnowEachOther } from '../core/phone-social-eligibility.js';
import { loadAcquaintanceLedger } from '../core/acquaintance-ledger.js';
import { characterAvatarHtml } from '../components/scrapbook-illustrations.js';
import { getIconSvg } from '../data/home-layout.js';
import { getCommercialHomeIcon } from '../data/home-commercial-icons.js';
import {
  hydrateHomeCustomIconFallbacks,
  renderHomeIconLayers,
} from '../core/home-custom-icons.js';
import { detectLinkPlatform } from '../core/link-platforms.js';
import { getNowForUser } from '../core/time-mode.js';
import { buildAmapStaticMapUrl, isAmapLocation, loadAmapConfig, loadAmapJsApi } from '../core/amap-tools.js';
import { bindCommitSearch } from '../components/search-field.js';
import { isStrangerInterceptChat, isUserAliasBlockedByCharacter } from '../core/stranger-thread-model.js';
import { openParticipantPicker } from '../components/participant-picker.js';
import {
  openPhoneContactCreateModal,
  openPhoneNpcGenerateModal,
  openPhoneQuickGroupModal,
} from '../components/character-phone-contact-tools-modal.js';
import { listLightweightNpcs, updateLightweightNpcAvatar } from '../core/lightweight-npc.js';
import {
  clearCharacterPhoneSchedules,
  getDailyLifePlanForDate,
  isPlanBlockActiveAt,
  pruneExpiredCharacterPhoneSchedules,
  dateKeyFromTimestamp,
  pickCurrentPlanBlock,
  pickCurrentFlowStep,
  pickCurrentTriggerWindow,
  schedulePointMinuteForBlock,
  scheduleTimelineMinuteAt,
  minutesOfDayFromTimestamp,
  parseTimeRangeStartMinutes,
  parseTimeRangeEndMinutes,
  loadCharacterPhone,
  loadCharacterPhoneAutoSettings,
  loadPhoneAppearancePresets,
  savePhoneAppearancePreset,
  deletePhoneAppearancePreset,
  saveCharacterPhone,
  updateCharacterPhoneShellPreferences,
  saveCharacterPhoneAutoSettings,
  isDailyLifeAutoEnabled,
  togglePhoneNoteComplete,
  getScheduleProactiveSettings,
  saveScheduleProactiveSettings,
  SCHEDULE_PROACTIVE_MIN_GAP_OPTIONS,
  formatRouteMetaLine,
  resolvePhoneAppSeenAt,
  applyElapsedScheduleMapVisits,
} from '../core/character-phone-store.js';
import {
  loadCharacterRuntimeState,
  resolveEffectiveCharacterState,
} from '../core/character-effective-state.js';
import { loadCharacterLiveState } from '../core/character-live-state.js';
import { listSearchCallLog, summarizeSearchCallLog, searchLogDayKey, reasonLabel } from '../core/search-usage-log.js';
import { loadMusicLibrary, normalizeRemoteCoverUrl } from '../core/music-library.js';
import { sanitizeGeneratedForumAuthor } from '../core/forum-identity.js';
import {
  loadCharacterPhoneContacts,
  savePhoneUserRemark,
  upsertPhoneContact,
  upsertPhoneContactGroup,
  findPhoneContactByActorId,
  resolvePhoneGroupParticipantIds,
  matchPhoneContactGroupForChat,
  deletePhoneContacts,
  deletePhoneContactGroups,
  removePhoneLinkedCharacters,
  promotePhoneContactToCharacter,
  phoneContactDisplayActorId,
  isPhoneLocalLightContact,
  resolvePhoneContactAvatar,
  syncPhoneContactAvatarsAcrossOwners,
  ensurePhoneSocialActorContact,
  syncPhoneContactGroupFromChat,
} from '../core/character-phone-contacts.js';
import {
  createPhoneAddressBookActorDirectory,
  createPhoneSocialActorDirectory,
  phoneContactCanonicalActorId,
  phoneSocialActorToContactInput,
  resolvePhoneSocialActorDisplayName,
} from '../core/phone-social-actor-directory.js';
import { saveCharacterPhoneAutomationConfig } from '../core/character-phone-automation-store.js';
import { loadFlatStickerPool } from '../core/moments/moments-stickers.js';
import { bindNarrationTranslationToggle } from '../core/narration-translation.js';
import {
  messageLikelyNeedsTranslation,
  sanitizeAiTranslation,
} from '../core/translation-utils.js';

const SCHEDULE_GENERATION_TIMEOUT_MS = 420000;
const SCHEDULE_LANGUAGE_FOLLOW_CHARACTER = 'followCharacter';
const EVENT_SEARCH_DAILY_LIMIT_DEFAULT = 2;
const PHONE_RECORD_SCOPES = Object.freeze({
  browser: { label: '浏览器记录' },
  photos: { label: '相册记录' },
  calls: { label: '通话记录' },
  music: { label: '音乐记录' },
  interests: { label: '兴趣记录' },
  map: { label: '地图候选' },
});
const SHARE_DAILY_TARGET_MAX = 20;
const AUTO_TRACK_INTERVAL_HOURS_MIN = 4;
const AUTO_TRACK_INTERVAL_HOURS_MAX = 72;
const AUTO_TRACK_CANDIDATES_MAX = 5;
const DEFAULT_PROACTIVE_DAILY_LIMIT = 20;
const REAL_PERSON_IDLE_REPLY_FLOOR_MIN_SECONDS = 1;
const REAL_PERSON_IDLE_REPLY_FLOOR_MAX_SECONDS = 24 * 60 * 60;
const SOCIAL_SEARCH_CHANNELS = Object.freeze(['xiaohongshu', 'weibo', 'bilibili']);
const SOCIAL_SEARCH_CHANNEL_LABELS = Object.freeze({
  xiaohongshu: '小红书',
  weibo: '微博',
  bilibili: 'B站',
});
const SHARE_SEARCH_CHANNELS = Object.freeze(['web', ...SOCIAL_SEARCH_CHANNELS]);
const SHARE_SEARCH_CHANNEL_LABELS = Object.freeze({
  web: '通用网页',
  ...SOCIAL_SEARCH_CHANNEL_LABELS,
});
const INTEREST_CHANNELS = Object.freeze(['staple', 'hobby', 'shopping', 'follow', 'casual']);
const INTEREST_CHANNEL_LABELS = Object.freeze({
  staple: '日常',
  hobby: '爱好',
  shopping: '种草',
  follow: '在追',
  casual: '泛兴趣',
});
const INTEREST_CHANNELS_WITH_PROGRESS = Object.freeze(['hobby', 'shopping', 'follow']);
const INTEREST_VOLUMES = Object.freeze(['large', 'medium', 'light']);
const INTEREST_VOLUME_LABELS = Object.freeze({ large: '内容多', medium: '适中', light: '内容少' });
const INTEREST_SURFACE_MODES = Object.freeze(['open', 'quiet']);
const INTEREST_SURFACE_MODE_LABELS = Object.freeze({ open: '会分享', quiet: '私下成长' });

export function createRetryableLazyLoader(importer, onLoaded = null) {
  let pending = null;
  return function loadLazyRuntime() {
    if (pending) return pending;
    const request = Promise.resolve()
      .then(() => importer())
      .then((module) => {
        onLoaded?.(module);
        return module;
      });
    let guarded = null;
    guarded = request.catch((error) => {
      if (pending === guarded) pending = null;
      throw error;
    });
    pending = guarded;
    return guarded;
  };
}

function normalizeSelectedChannels(raw, allowed) {
  const list = Array.isArray(raw)
    ? raw.map((value) => String(value || '').trim()).filter((value) => allowed.includes(value))
    : [];
  return list.length ? [...new Set(list)] : [...allowed];
}

const normalizeSocialSearchChannels = (raw) => normalizeSelectedChannels(raw, SOCIAL_SEARCH_CHANNELS);
const normalizeShareSearchChannels = (raw) => normalizeSelectedChannels(raw, SHARE_SEARCH_CHANNELS);

let interestTableRuntime = null;
const loadInterestTableRuntime = createRetryableLazyLoader(
  () => import('../core/character-interest-table.js'),
  (module) => { interestTableRuntime = module; },
);

async function callInterestTable(name, ...args) {
  const module = await loadInterestTableRuntime();
  return module[name](...args);
}

const listInterestEntries = (...args) => callInterestTable('listInterestEntries', ...args);
const saveInterestEntry = (...args) => callInterestTable('saveInterestEntry', ...args);
const deleteInterestEntry = (...args) => callInterestTable('deleteInterestEntry', ...args);
const growInterestTableFromContext = (...args) => callInterestTable('growInterestTableFromContext', ...args);
const loadInterestTrackingSettings = (...args) => callInterestTable('loadInterestTrackingSettings', ...args);
const saveInterestTrackingSettings = (...args) => callInterestTable('saveInterestTrackingSettings', ...args);
const applyInterestProgressPatch = (...args) => callInterestTable('applyInterestProgressPatch', ...args);
const reclassifyInterestChannels = (...args) => callInterestTable('reclassifyInterestChannels', ...args);
const growInterestBackstories = (...args) => callInterestTable('growInterestBackstories', ...args);
const saveInterestBackstory = (...args) => callInterestTable('saveInterestBackstory', ...args);
function isUsableInterestKeyword(keyword = '') {
  if (interestTableRuntime?.isUsableInterestKeyword) {
    return interestTableRuntime.isUsableInterestKeyword(keyword);
  }
  const value = String(keyword || '').replace(/\s+/g, ' ').trim();
  return value.length >= 2 && value.length <= 60;
}
function pickRootForSplit(entries = []) {
  return interestTableRuntime?.pickRootForSplit?.(entries) || null;
}

const syncInterestProgressFromSchedule = async (...args) => (
  (await import('../core/interest-schedule-progress.js')).syncInterestProgressFromSchedule(...args)
);
const loadWebSearchConfig = async (...args) => (
  (await import('../core/web-search-tools.js')).loadWebSearchConfig(...args)
);
const loadSocialLinkConfig = async (...args) => (
  (await import('../core/social-link-tools.js')).loadSocialLinkConfig(...args)
);
const loadShareImpulseSettings = async (...args) => (
  (await import('../core/share-impulse.js')).loadShareImpulseSettings(...args)
);
const saveShareImpulseSettings = async (...args) => (
  (await import('../core/share-impulse.js')).saveShareImpulseSettings(...args)
);

const loadUserSocialWatchRuntime = createRetryableLazyLoader(
  () => import('../core/user-social-watch.js'),
);
const loadUserSocialWatchSettings = async (...args) => (await loadUserSocialWatchRuntime()).loadUserSocialWatchSettings(...args);
const saveUserSocialWatchSettings = async (...args) => (await loadUserSocialWatchRuntime()).saveUserSocialWatchSettings(...args);
const resetUserSocialWatchProgress = async (...args) => (await loadUserSocialWatchRuntime()).resetUserSocialWatchProgress(...args);
const listUserSocialPosts = async (...args) => (await loadUserSocialWatchRuntime()).listUserSocialPosts(...args);
const checkUserSocialUpdates = async (...args) => (await loadUserSocialWatchRuntime()).checkUserSocialUpdates(...args);

const loadPhonePhotoRuntime = createRetryableLazyLoader(
  () => import('../core/character-phone-photo-images.js'),
);
const generatePhonePhotoImagesForPhone = async (...args) => (await loadPhonePhotoRuntime()).generatePhonePhotoImagesForPhone(...args);
const isPhoneAlbumImageGenEnabled = async (...args) => (await loadPhonePhotoRuntime()).isPhoneAlbumImageGenEnabled(...args);
function phonePhotoNeedsGeneration(record = {}, { forceReroll = false } = {}) {
  if (!record || typeof record !== 'object') return false;
  const cleanValue = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const url = cleanValue(record.imageUrl || record.url || '');
  if (forceReroll) {
    return !!(cleanValue(record.imagePrompt) || cleanValue(record.textImageCaption) || record.title || record.caption);
  }
  if (record.wantsImage === false) return false;
  if (record.imageKind === 'textimg' || record.imageKind === 'pending' || record.imageError) return true;
  if (url) return false;
  return record.wantsImage === true
    || !!cleanValue(record.imagePrompt)
    || !!cleanValue(record.textImageCaption);
}
const openPhoneAlbumGenImageModal = async (...args) => (
  (await import('../components/moments-gen-image-modal.js')).openPhoneAlbumGenImageModal(...args)
);
const openChatCardModal = (...args) => {
  void import('../components/chat-interactive-modals.js')
    .then((module) => module.openChatCardModal(...args))
    .catch(() => {});
};

let cardRenderRuntime = null;
const loadCardRenderRuntime = createRetryableLazyLoader(
  () => import('../core/chat/card-render.js'),
  (module) => { cardRenderRuntime = module; },
);
function textImageDetailHtml(...args) {
  return cardRenderRuntime?.textImageDetailHtml?.(...args) || '';
}

let linkCardRuntime = null;
const loadLinkCardRuntime = createRetryableLazyLoader(
  () => import('../core/link-card-enhancer.js'),
  (module) => { linkCardRuntime = module; },
);
function displaySocialImageUrl(...args) {
  return linkCardRuntime?.displaySocialImageUrl?.(...args) || String(args[0] || '').trim();
}
const bindLinkPreviewAnchors = async (...args) => (
  (await import('../components/link-preview-sheet.js')).bindLinkPreviewAnchors(...args)
);

function normalizePhoneTimezone(value = '') {
  const timeZone = String(value || '').trim();
  if (!timeZone) return '';
  try {
    Intl.DateTimeFormat(undefined, { timeZone });
    return timeZone;
  } catch (_) {
    return '';
  }
}

function formatClockInTimezone(timestamp, timeZone) {
  const zone = normalizePhoneTimezone(timeZone);
  if (!zone) return '';
  return new Date(Number(timestamp) || Date.now()).toLocaleString('zh-CN', {
    timeZone: zone,
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
}

const PHONE_CHINA_TIMEZONE_CITIES = new Set([
  '北京', '广州', '杭州', '青岛', '昆明', '南京', '西安',
  '上海', '苏州', '武汉', '天津', '成都', '绵阳',
]);

async function resolveCharacterScheduleTimezone(userId, characterId, character = null) {
  const uid = String(userId || '').trim();
  const cid = String(characterId || '').trim();
  if (!uid || !cid) return '';
  try {
    const chats = await db.getAllByIndex('chats', 'userId', uid);
    const chat = (Array.isArray(chats) ? chats : []).find((item) => {
      const metadata = item?.metadata || {};
      const groupSettings = item?.groupSettings || {};
      const participants = Array.isArray(item?.participants) ? item.participants : [];
      const anonymous = item?.type === 'anonymous'
        || metadata.channel === 'anonymous'
        || metadata.anonymousMode === true
        || String(metadata.anonymousRoomKind || '').trim()
        || String(metadata.anonymousRoomId || '').trim()
        || item?.anonymousPrivateConfig
        || groupSettings.anonymousRoomConfig
        || groupSettings.anonymousIdentities;
      return item?.type !== 'group'
        && !anonymous
        && String(metadata.channelKind || '') !== 'stranger_intercept'
        && metadata.firstEncounterPending !== true
        && participants.includes('user')
        && participants.includes(cid);
    });
    if (!chat?.id) return '';
    const prefs = (await db.get(`chatPrefs_${chat.id}`))?.value || {};
    if (prefs.timezoneEnabled !== true) return '';
    const explicit = normalizePhoneTimezone(prefs.characterTimezone);
    if (explicit) return explicit;
    if (!character) return '';
    const { getEffectiveWeatherCityForCharacter } = await import('../core/weather-location.js');
    const cityInfo = getEffectiveWeatherCityForCharacter(character);
    // weatherCity 已把「北京市」等别名归一化；优先用它，避免直接拿原始映射名漏判。
    const city = String(cityInfo.weatherCity || cityInfo.realCityMap || '').trim();
    return PHONE_CHINA_TIMEZONE_CITIES.has(city) ? 'Asia/Shanghai' : '';
  } catch (_) {
    return '';
  }
}

/** 桌面角标只需会话时间戳；不要为它触发手机消息的迁移、关系网与联系人全链。 */
async function listCharacterPhoneBadgeChats(userId, characterId) {
  const uid = String(userId || '').trim();
  const cid = String(characterId || '').trim();
  if (!uid || !cid) return [];
  const rows = await db.getAllByIndex('chats', 'userId', uid).catch(() => []);
  return (Array.isArray(rows) ? rows : [])
    .filter((chat) => {
      if (!chat || !Array.isArray(chat.participants) || !chat.participants.includes(cid)) return false;
      const metadata = chat.metadata || {};
      const groupSettings = chat.groupSettings || {};
      const anonymous = chat.type === 'anonymous'
        || metadata.channel === 'anonymous'
        || metadata.anonymousMode === true
        || String(metadata.anonymousRoomKind || '').trim()
        || String(metadata.anonymousRoomId || '').trim()
        || chat.anonymousPrivateConfig
        || groupSettings.anonymousRoomConfig
        || groupSettings.anonymousIdentities;
      if (anonymous) return false;
      return String(metadata.phoneChannel || '') !== 'intercept'
        && !isStrangerInterceptChat(chat);
    })
    .sort((a, b) => Number(b.lastActivity || 0) - Number(a.lastActivity || 0));
}

const loadChatStoreRuntime = createRetryableLazyLoader(
  () => import('../core/chat-store.js'),
);
const listChatsForUser = async (...args) => (await loadChatStoreRuntime()).listChatsForUser(...args);
const listMessagesForChat = async (...args) => (await loadChatStoreRuntime()).listMessagesForChat(...args);
const ensurePrivateChat = async (...args) => (await loadChatStoreRuntime()).ensurePrivateChat(...args);
const ensureBackstageChat = async (...args) => (await loadChatStoreRuntime()).ensureBackstageChat(...args);
const deleteChatWithData = async (...args) => (await loadChatStoreRuntime()).deleteChatWithData(...args);
const getChat = async (...args) => (await loadChatStoreRuntime()).getChat(...args);
const saveChat = async (...args) => (await loadChatStoreRuntime()).saveChat(...args);
const listStrangerThreadsForCharacter = async (...args) => (
  (await import('../core/stranger-thread-store.js')).listStrangerThreadsForCharacter(...args)
);

let activityRuntime = null;
const loadActivityRuntime = createRetryableLazyLoader(
  () => import('../core/activity-sessions.js'),
  (module) => { activityRuntime = module; },
);
const createActivitySessionFromCurrentBlock = async (...args) => (await loadActivityRuntime()).createActivitySessionFromCurrentBlock(...args);
async function listActivitySessions(userId) {
  const uid = encodeURIComponent(String(userId || '').trim() || 'guest');
  const row = await db.get('settings', `activitySessions_${uid}`);
  const source = row?.value?.sessions || row?.value;
  return (Array.isArray(source) ? source : [])
    .filter(Boolean)
    .sort((a, b) => Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0));
}
function isActivitySessionExpired(session = {}, now = Date.now()) {
  const status = String(session.status || 'planned').trim();
  if (status === 'done' || status === 'cancelled') return false;
  const timestamp = Number(now) || Date.now();
  const expectedEnd = Number(session.expectedEndAt || 0) || 0;
  if (expectedEnd > 0 && timestamp > expectedEnd + 5 * 60 * 1000) return true;
  const startAt = Number(session.startAt || session.createdAt || 0) || 0;
  return startAt > 0 && timestamp - startAt > 24 * 60 * 60 * 1000;
}
async function reconcileExpiredActivitySessions(userId, now = Date.now()) {
  const sessions = await listActivitySessions(userId);
  let updated = 0;
  const next = sessions.map((session) => {
    const status = String(session?.status || 'planned').trim();
    if (!['planned', 'active'].includes(status) || !isActivitySessionExpired(session, now)) return session;
    updated += 1;
    return {
      ...session,
      status: 'cancelled',
      currentStep: 'expired',
      cancelReason: 'expired',
      expiredAt: now,
      updatedAt: Date.now(),
    };
  });
  if (updated) {
    const uid = encodeURIComponent(String(userId || '').trim() || 'guest');
    await db.put('settings', { key: `activitySessions_${uid}`, value: { sessions: next.slice(0, 80) } });
  }
  return { updated };
}
function getEffectiveActivityStatus(session, now = Date.now()) {
  const status = String(session?.status || 'planned').trim();
  if (['planned', 'active'].includes(status) && isActivitySessionExpired(session, now)) return 'expired';
  return status;
}
function findResumableActivitySession(sessions = [], characterId = '', now = Date.now()) {
  const cid = String(characterId || '').trim();
  if (!cid) return null;
  return (Array.isArray(sessions) ? sessions : []).find((session) => (
    (session?.characterIds || []).includes(cid)
    && getEffectiveActivityStatus(session, now) === 'planned'
  )) || null;
}

let autonomyRuntime = null;
const loadAutonomyRuntime = createRetryableLazyLoader(
  () => import('../core/character-autonomy-settings.js'),
  (module) => { autonomyRuntime = module; },
);
const loadCharacterAutonomySettings = async (...args) => (await loadAutonomyRuntime()).loadCharacterAutonomySettings(...args);
const saveCharacterAutonomySettings = async (...args) => (await loadAutonomyRuntime()).saveCharacterAutonomySettings(...args);
const saveCharacterProactiveEnabled = async (...args) => (await loadAutonomyRuntime()).saveCharacterProactiveEnabled(...args);
function isAutonomyMuteHourActive(...args) {
  return autonomyRuntime?.isAutonomyMuteHourActive?.(...args) === true;
}

let proactiveUsageRuntime = null;
const loadProactiveUsageRuntime = createRetryableLazyLoader(
  () => import('../core/character-proactive-usage.js'),
  (module) => { proactiveUsageRuntime = module; },
);
const getCharacterProactiveUsageStatus = async (...args) => (await loadProactiveUsageRuntime()).getCharacterProactiveUsageStatus(...args);
function proactiveReasonLabel(...args) {
  return proactiveUsageRuntime?.proactiveReasonLabel?.(...args) || '';
}

let dailyLifeRuntime = null;
const loadDailyLifeRuntime = createRetryableLazyLoader(
  () => import('../core/character-daily-life.js'),
  (module) => { dailyLifeRuntime = module; },
);

async function callDailyLife(name, ...args) {
  const module = await loadDailyLifeRuntime();
  return module[name](...args);
}

const changeDailyLifePlanByCharacter = (...args) => callDailyLife('changeDailyLifePlanByCharacter', ...args);
const ensureDailyLifePlan = (...args) => callDailyLife('ensureDailyLifePlan', ...args);
const ensureWeeklyLifePlans = (...args) => callDailyLife('ensureWeeklyLifePlans', ...args);
const tryApplyDailyScheduleFromRaw = (...args) => callDailyLife('tryApplyDailyScheduleFromRaw', ...args);
const tryApplyWeeklyScheduleFromRaw = (...args) => callDailyLife('tryApplyWeeklyScheduleFromRaw', ...args);
const tryApplyChangeScheduleFromRaw = (...args) => callDailyLife('tryApplyChangeScheduleFromRaw', ...args);
const loadScheduleEventSettings = (...args) => callDailyLife('loadScheduleEventSettings', ...args);
const saveScheduleEventSettings = (...args) => callDailyLife('saveScheduleEventSettings', ...args);
const repairDailyLifePlanTranslations = (...args) => callDailyLife('repairDailyLifePlanTranslations', ...args);
function dailyLifePlanNeedsTranslation(...args) {
  return dailyLifeRuntime?.dailyLifePlanNeedsTranslation?.(...args) === true;
}

let phoneMessagesRuntime = null;
const loadPhoneMessagesRuntime = createRetryableLazyLoader(
  () => import('../core/character-phone-messages.js'),
  (module) => { phoneMessagesRuntime = module; },
);

async function callPhoneMessages(name, ...args) {
  const module = await loadPhoneMessagesRuntime();
  return module[name](...args);
}

const listCharacterPhoneChats = (...args) => callPhoneMessages('listCharacterPhoneChats', ...args);
const listCharacterPhoneInterceptChats = (...args) => callPhoneMessages('listCharacterPhoneInterceptChats', ...args);
const generatePhoneLifeBatch = (...args) => callPhoneMessages('generatePhoneLifeBatch', ...args);
const loadLastPhoneLifeBatch = (...args) => callPhoneMessages('loadLastPhoneLifeBatch', ...args);
const undoLastPhoneLifeBatch = (...args) => callPhoneMessages('undoLastPhoneLifeBatch', ...args);
const rerollLastPhoneLifeBatch = (...args) => callPhoneMessages('rerollLastPhoneLifeBatch', ...args);
const ensurePhonePeerChat = (...args) => callPhoneMessages('ensurePhonePeerChat', ...args);
const resolvePhoneMainParentChatId = (...args) => callPhoneMessages('resolvePhoneMainParentChatId', ...args);
const loadPhoneChatAutoSettings = (...args) => callPhoneMessages('loadPhoneChatAutoSettings', ...args);
const savePhoneChatAutoSettings = (...args) => callPhoneMessages('savePhoneChatAutoSettings', ...args);
const adoptPhoneSessionOrphanAsContact = (...args) => callPhoneMessages('adoptPhoneSessionOrphanAsContact', ...args);
const reconcilePhoneContactNpcIdentities = (...args) => callPhoneMessages('reconcilePhoneContactNpcIdentities', ...args);
const dismissPhoneSessionOrphanPeer = (...args) => callPhoneMessages('dismissPhoneSessionOrphanPeer', ...args);
const purgePhoneUserImpersonators = (...args) => callPhoneMessages('purgePhoneUserImpersonators', ...args);
function resolvePhoneChatTitle(...args) {
  return phoneMessagesRuntime?.resolvePhoneChatTitle?.(...args) || '聊天';
}
function resolvePhoneUserPeerIdentity(...args) {
  return phoneMessagesRuntime?.resolvePhoneUserPeerIdentity?.(...args) || null;
}
function isPhoneSessionOrphanPeer(...args) {
  return phoneMessagesRuntime?.isPhoneSessionOrphanPeer?.(...args) === true;
}

const loadInterestSearchRuntime = createRetryableLazyLoader(
  () => import('../core/interest-search-orchestrator.js'),
);
const runManualInterestSearch = async (...args) => (await loadInterestSearchRuntime()).runManualInterestSearch(...args);
const listVerifiedPosts = async (...args) => (await loadInterestSearchRuntime()).listVerifiedPosts(...args);
const runManualInterestSplit = async (...args) => (await loadInterestSearchRuntime()).runManualInterestSplit(...args);
const runDailyInterestRotationForCharacter = async (...args) => (await loadInterestSearchRuntime()).runDailyInterestRotationForCharacter(...args);

const loadPhoneRecordsRuntime = createRetryableLazyLoader(
  () => import('../core/character-phone-records.js'),
);
const generateCharacterPhoneRecords = async (...args) => (await loadPhoneRecordsRuntime()).generateCharacterPhoneRecords(...args);
function getPhoneRecordScopeLabel(scope) {
  return PHONE_RECORD_SCOPES[String(scope || '').trim()]?.label || '手机记录';
}

const loadNpcExtractRuntime = createRetryableLazyLoader(
  () => import('../core/character-npc-extract.js'),
);
const extractNpcCandidatesFromCharacter = async (...args) => (await loadNpcExtractRuntime()).extractNpcCandidatesFromCharacter(...args);
const generateNpcCandidatesFromCharacter = async (...args) => (await loadNpcExtractRuntime()).generateNpcCandidatesFromCharacter(...args);
const generatePhoneUserRemark = async (...args) => (await loadNpcExtractRuntime()).generatePhoneUserRemark(...args);
const saveNpcCandidatesToPhone = async (...args) => (await loadNpcExtractRuntime()).saveNpcCandidatesToPhone(...args);

const loadPhoneMomentsRuntime = createRetryableLazyLoader(
  () => import('../core/character-phone-moments.js'),
);
const generateCharacterPhoneMoments = async (...args) => (await loadPhoneMomentsRuntime()).generateCharacterPhoneMoments(...args);
const listCharacterPhoneMoments = async (...args) => (await loadPhoneMomentsRuntime()).listCharacterPhoneMoments(...args);
const putCharacterPhoneMomentPost = async (...args) => (await loadPhoneMomentsRuntime()).putCharacterPhoneMomentPost(...args);
const deleteCharacterPhoneMomentPost = async (...args) => (await loadPhoneMomentsRuntime()).deleteCharacterPhoneMomentPost(...args);

let momentsUiRuntime = null;
const loadMomentsUiRuntime = createRetryableLazyLoader(
  () => import('../core/moments/moments-ui.js'),
  (module) => { momentsUiRuntime = module; },
);
function renderMomentPostCard(...args) {
  return momentsUiRuntime?.renderMomentPostCard?.(...args) || '';
}

const loadPhoneInterceptRuntime = createRetryableLazyLoader(
  () => import('../core/character-phone-intercept.js'),
);
const generatePhoneInterceptBatch = async (...args) => (await loadPhoneInterceptRuntime()).generatePhoneInterceptBatch(...args);
const loadLastPhoneInterceptBatch = async (...args) => (await loadPhoneInterceptRuntime()).loadLastPhoneInterceptBatch(...args);

const getInterestRotationDebugStatus = async (...args) => (
  (await import('../core/background-scheduler.js')).getInterestRotationDebugStatus(...args)
);
async function syncTravelCharTrips({ userId, characterId } = {}) {
  const uid = String(userId || '').trim();
  const cid = String(characterId || '').trim();
  if (!uid || !cid) return { finished: 0 };
  const row = await db.get(`travelCharTrips_${encodeURIComponent(uid || 'guest')}`).catch(() => null);
  const trips = Array.isArray(row?.value?.trips) ? row.value.trips : [];
  const now = await getNowForUser(uid).catch(() => Date.now());
  const hasDueTrip = trips.some((trip) => (
    trip?.status === 'away'
    && (trip.characterIds || []).includes(cid)
    && Number(trip.expectedReturnAt || 0) > 0
    && Number(trip.expectedReturnAt) <= now
  ));
  if (!hasDueTrip) return { finished: 0 };
  return (await import('../core/travel-char.js')).syncTravelCharTrips({ userId: uid, characterId: cid });
}
const maybeGrowCharacterPhoneMapForDailyPlan = async (...args) => (
  (await import('../core/character-phone-map-grower.js')).maybeGrowCharacterPhoneMapForDailyPlan(...args)
);
const loadOfflineSession = async (...args) => (
  (await import('../core/offline-session.js')).loadOfflineSession(...args)
);
const startOfflineSessionFromActivitySession = async (...args) => (
  (await import('../core/offline-session.js')).startOfflineSessionFromActivitySession(...args)
);
const beginLongTaskNotice = async (...args) => (
  (await import('../core/long-task-notifications.js')).beginLongTaskNotice(...args)
);

async function showPhoneGenerationError(error, context = {}) {
  try {
    const [{ showGenerationErrorReport }, { generationErrorFromCatch }] = await Promise.all([
      import('../components/generation-error-report.js'),
      import('../core/generation-error-guide.js'),
    ]);
    showGenerationErrorReport(generationErrorFromCatch(error, context));
  } catch (_) {}
}

function esc(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function scheduleAutomationControlsHtml({
  autoOn = false,
  proactive = {},
  hasTodayPlan = false,
} = {}) {
  const proactiveOn = proactive?.enabled === true;
  const needsTodayPlan = proactiveOn && !hasTodayPlan && !autoOn;
  return `
    <section class="cphone-settings-group cphone-schedule-automation" aria-label="日程自动化">
      <h2>自动化</h2>
      <label class="cphone-settings-row">
        <span><b>自动生成日程</b></span>
        <input type="checkbox" class="cphone-auto-toggle" ${autoOn ? 'checked' : ''}>
      </label>
      <label class="cphone-settings-row">
        <span>
          <b>按日程主动</b>
          ${needsTodayPlan ? '<em class="cphone-schedule-automation-status" role="status">主动已开，但今日无计划，且自动生成已关闭</em>' : ''}
        </span>
        <input type="checkbox" class="cphone-proactive-toggle" ${proactiveOn ? 'checked' : ''}>
      </label>
    </section>`;
}

function phoneTranslationSuffixHtml(source = '', translation = '', record = {}) {
  const src = String(source || '').trim();
  if (!src) return '';
  const sanitized = sanitizeAiTranslation(src, translation);
  if (!sanitized && !messageLikelyNeedsTranslation(src)) return '';
  const show = sanitized || '';
  const recordType = String(record.type || '').trim();
  const recordId = String(record.id || '').trim();
  const recordKey = String(record.key || '').trim();
  const label = String(record.label || '翻译').trim() || '翻译';
  const recordAttrs = recordType && recordId
    ? ` data-phone-translation-type="${esc(recordType)}" data-phone-translation-id="${esc(recordId)}"${recordKey ? ` data-phone-translation-key="${esc(recordKey)}"` : ''}`
    : '';
  return `<button type="button" class="chat-bubble-translate-btn" data-translation-toggle data-translation-source="${esc(src)}"${recordAttrs} aria-expanded="false">${esc(label)}</button><div class="chat-bubble-translation" hidden><div class="chat-bubble-translation-divider"></div><div class="chat-bubble-translation-text">${esc(show)}</div></div>`;
}

function phoneDisplayTranslation(block = {}, key = '', source = '') {
  const src = String(source || '').trim();
  const row = block?.displayTranslations?.[key];
  if (!src || !row || typeof row !== 'object') return '';
  return String(row.source || '').trim() === src ? String(row.translation || row.zh || '').trim() : '';
}

function scheduleDisplayTranslationHtml(block = {}, key = '', source = '', label = '翻译') {
  const blockId = String(block?.id || '').trim();
  if (!blockId) return '';
  return phoneTranslationSuffixHtml(source, phoneDisplayTranslation(block, key, source), {
    type: 'schedule-display',
    id: blockId,
    key,
    label,
  });
}

function plain(value = '', max = 220) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function nameOf(character, fallback = 'TA') {
  return resolvePhoneSocialActorDisplayName(character) || String(fallback || 'TA').trim() || 'TA';
}

function phoneRemarkOf(contact = null) {
  return String(contact?.remark || contact?.remarkName || '').replace(/\s+/g, ' ').trim();
}

function phoneAvatarLetter(title = '', fallback = '?') {
  const chars = [...String(title || '').trim()];
  return chars.slice(0, 2).join('') || fallback;
}

function phoneAvatarHtml(entry = {}, options = {}) {
  const fallback = options.fallback || '?';
  const title = options.title || entry?.nickname || entry?.name || entry?.customNickname || fallback;
  const avatar = String(entry?.avatar || entry?.avatarUrl || '').trim();
  const className = options.className || 'cphone-chat-avatar';
  const letter = phoneAvatarLetter(title, fallback);
  return `<span class="${esc(className)}${avatar ? ' has-image' : ' is-letter'}" data-avatar-fallback="${esc(letter)}">${
    avatar ? `<img src="${esc(avatar)}" alt="">` : esc(letter)
  }</span>`;
}

/** 轻量群头像：自定义图 > 成员拼贴 > 群名首字 */
function phoneGroupAvatarHtml(group = {}, memberEntries = [], options = {}) {
  const title = options.title || group?.name || '群聊';
  const className = options.className || 'cphone-chat-group-avatar';
  const uploaded = String(group?.avatar || group?.avatarUrl || '').trim();
  const groupLetter = phoneAvatarLetter(title, '群');
  if (uploaded) {
    return `<span class="${esc(className)} has-image" data-avatar-fallback="${esc(groupLetter)}"><img src="${esc(uploaded)}" alt=""></span>`;
  }
  const tiles = (Array.isArray(memberEntries) ? memberEntries : [])
    .filter((item) => item && (item.name || item.avatar || item.avatarUrl))
    .slice(0, 4)
    .map((item) => {
      const avatar = String(item.avatar || item.avatarUrl || '').trim();
      const label = item.name || item.nickname || item.customNickname || '?';
      const letter = phoneAvatarLetter(label, '?');
      if (avatar) return `<i data-avatar-fallback="${esc(letter)}"><img src="${esc(avatar)}" alt=""></i>`;
      return `<i data-avatar-fallback="${esc(letter)}">${esc(letter)}</i>`;
    });
  if (tiles.length >= 2) {
    return `<span class="${esc(className)} is-collage" title="${esc(title)}">${tiles.join('')}</span>`;
  }
  return phoneAvatarHtml({ name: title }, { className, title });
}

function phoneGroupMemberAvatarEntries(group = {}, ownerId = '', contacts = [], charMap = {}) {
  const peers = resolvePhoneGroupParticipantIds(ownerId, group, contacts);
  return peers.map((id) => {
    if (id === ownerId) {
      const owner = charMap[ownerId] || {};
      return {
        name: owner.realName || owner.name || owner.customNickname || '成员',
        avatar: owner.avatar || owner.avatarUrl || '',
      };
    }
    const contact = findPhoneContactByActorId(contacts, id);
    if (contact) {
      const linked = contact.linkedCharacterId ? charMap[contact.linkedCharacterId] : null;
      return {
        name: contact.name || contact.nickname || linked?.name || '成员',
        avatar: resolvePhoneContactAvatar(contact, charMap) || linked?.avatar || '',
      };
    }
    const char = charMap[id] || {};
    return {
      name: char.realName || char.name || char.customNickname || '成员',
      avatar: char.avatar || char.avatarUrl || '',
    };
  });
}

function formatAgoShort(ts, referenceNow = Date.now()) {
  const diff = Number(referenceNow || Date.now()) - Number(ts || 0);
  if (!Number.isFinite(diff) || diff < 0) return '刚刚';
  if (diff < 60 * 1000) return '刚刚';
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / (60 * 1000))} 分钟前`;
  if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / (60 * 60 * 1000))} 小时前`;
  return `${Math.floor(diff / (24 * 60 * 60 * 1000))} 天前`;
}

const INTEREST_ROTATION_SKIP_LABELS = {
  'search-not-configured': '未检测到可用的联网/社媒搜索配置',
  'nothing-due': '所有开启追踪的角色都还在冷却中（按各自设置的搜索间隔，默认 12 小时一轮）',
  'deferred-user-active': '你正在用 App，已让路，稍后自动补',
  'in-flight': '上一轮还没跑完',
};

/** 兴趣页「后台自动检查」状态行：不用再靠猜，直接告诉用户后台上次到底跑没跑、跑到没跑到这个角色。 */
function formatInterestRotationDebugLine(debug, characterId) {
  if (!debug?.at) return '后台自动检查：还没有运行记录（先确认已开启相关搜索开关）';
  const ago = formatAgoShort(debug.at);
  if (!debug.ok) {
    const label = INTEREST_ROTATION_SKIP_LABELS[debug.resultReason] || debug.resultReason || '未知原因';
    return `后台自动检查：${ago} · 未执行（${label}）`;
  }
  if (debug.skipped) {
    const label = INTEREST_ROTATION_SKIP_LABELS[debug.resultReason] || debug.resultReason || '已跳过';
    return `后台自动检查：${ago} · 跳过（${label}）`;
  }
  const processed = Array.isArray(debug.processedCharacterIds) ? debug.processedCharacterIds : [];
  const includesThis = characterId && processed.includes(characterId);
  if (!includesThis) {
    return `后台自动检查：${ago} · 处理了 ${processed.length} 个角色，未轮到这个角色（单次最多处理 6 个，下一轮/约 2 小时后会继续按冷却排队）`;
  }
  const mine = debug.perCharacter?.[characterId] || {};
  if (mine.error) return `后台自动检查：${ago} · 处理了这个角色但失败了（${mine.error}）`;
  const materials = Number(mine.materials || 0);
  const sharePosts = Number(mine.sharePosts || 0);
  return `后台自动检查：${ago} · 处理了这个角色，新增素材 ${materials} 条，深读可分享 ${sharePosts} 条`;
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('file read failed'));
    reader.readAsDataURL(file);
  });
}

async function phoneWallpaperDataUrl(file, cropOpts = IMAGE_CROP_PRESETS.wallpaper) {
  return fileToCroppedCompressedDataUrl(file, {
    ...IMAGE_CROP_PRESETS.wallpaper,
    ...cropOpts,
    compress: cropOpts.compress || { maxSize: 1440, quality: 0.84 },
    outputMaxEdge: cropOpts.outputMaxEdge || 1440,
  });
}

function topicText(value = '') {
  return String(value || '').replace(/^#|#$/g, '').trim();
}

function isForumBrowserRecord(record = {}) {
  if (record.linkType === 'forum_post') return true;
  const hay = [record.platform, record.sourceName].map((x) => String(x || '').toLowerCase()).join(' ');
  return /forum|论坛|贴吧|社区/.test(hay);
}

/**
 * 「站内微博」特指 AI 生成的站内虚构话题（linkType: 'weibo_hot'，点进去是本地模拟的微博话题页）。
 * 真实抓取的微博链接（linkType: 'real'，来自 TikHub 精搜/兴趣搜索）不算站内——它们有真实 url，
 * 应该走「网页小窗」的外链预览路径，不能因为 url/sourceName 里含"微博"字样就被误判成站内话题
 * （否则会被路由去开一个不存在的本地话题，而不是真正打开/预览这条帖子）。
 */
function isWeiboBrowserRecord(record = {}) {
  if (isForumBrowserRecord(record)) return false;
  return record.linkType === 'weibo_hot';
}

/** 真实社媒外链禁止 iframe 内嵌（X-Frame-Options），改展示精搜快照封面。 */
function isBlockedSocialEmbed(url = '') {
  return /xiaohongshu\.com|xhslink\.(?:com|cn)|weibo\.(?:com|cn)|bilibili\.com|b23\.tv/i.test(String(url || ''));
}

const WEIBO_AUTHOR_TYPE_DEFAULTS = {
  media: '媒体快讯',
  marketing: '营销号',
  org: '官方账号',
  fan: '微博网友',
};

/** 微博热搜/话题记录的发帖人：只有 self 才是角色本人，否则是媒体/营销号/路人等 */
function resolveWeiboRecordAuthor(record = {}, { selectedId = '', charName = 'TA' } = {}) {
  const type = String(record.weiboAuthorType || '').trim().toLowerCase();
  const isSelf = type === 'self';
  if (isSelf) {
    return { isSelf: true, type: 'self', authorId: selectedId || 'phone_record', authorName: charName };
  }
  const fallbackName = WEIBO_AUTHOR_TYPE_DEFAULTS[type] || '';
  const authorName = String(record.weiboAuthorName || '').trim()
    || fallbackName
    || (String(record.sourceName || '').trim() && record.sourceName !== '网页' ? record.sourceName : '')
    || '微博网友';
  const slug = encodeURIComponent(authorName).replace(/%/g, '').slice(0, 24) || 'src';
  return {
    isSelf: false,
    type: type || 'fan',
    authorId: `weibo_src_${slug}`,
    authorName,
  };
}

function topicFromBrowserRecord(record = {}) {
  return topicText(record.query || record.title || record.summary || '微博话题');
}

function scheduleGenerationTimeoutMessage() {
  return '日程生成等太久了，已停止等待。长 JSON 非流式可能要 3～6 分钟，请检查 API 速度或稍后重试；若后台仍在生成，刷新页面后可能已写入。';
}

function scheduleGenerationErrorMessage(error, fallback = '日程生成失败') {
  const message = String(error?.message || error || '').trim();
  if (error?.name === 'AbortError' || /aborted|abort/i.test(message)) return scheduleGenerationTimeoutMessage();
  return message ? `${fallback}：${message}` : fallback;
}

function offerScheduleJsonRecovery(error, {
  mode = 'daily',
  onApplied,
} = {}) {
  const raw = String(error?.rawResponse || error?.rawText || '').trim();
  if (!raw) return;
  void import('../components/schedule-json-error-modal.js')
    .then(({ openScheduleJsonErrorModal }) => openScheduleJsonErrorModal({
      rawText: raw,
      partialParsed: error?.partialParsed || null,
      mode,
      onTryApply: async (text) => {
        const result = await onApplied?.(text);
        if (result?.salvaged) {
          showToast('已从截断原文救回并填入（可能不完整）', 5000);
        } else {
          showToast('已从原文解析并填入', 3500);
        }
        return result;
      },
    }))
    .catch(() => {});
}

function createScheduleGenerationTimeout() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SCHEDULE_GENERATION_TIMEOUT_MS);
  return {
    signal: controller.signal,
    abort: () => controller.abort(),
    clear: () => clearTimeout(timeout),
  };
}

async function withScheduleGenerationTimeout(task, timeoutState) {
  let fallbackTimer = null;
  const timeoutPromise = new Promise((_, reject) => {
    fallbackTimer = setTimeout(() => {
      const err = new Error(scheduleGenerationTimeoutMessage());
      err.name = 'AbortError';
      reject(err);
    }, SCHEDULE_GENERATION_TIMEOUT_MS + 250);
  });
  try {
    return await Promise.race([task(), timeoutPromise]);
  } finally {
    if (fallbackTimer) clearTimeout(fallbackTimer);
  }
}

function mapRelationLabel(status = '') {
  const key = String(status || '').trim();
  const map = {
    visited: '去过',
    unvisited: '没去过',
    want_to_go: '想去',
    avoid: '避雷',
    revisit: '下次还能去',
    maybe: '待观察',
  };
  return map[key] || key;
}

function mapStateSourceLabel(source = '') {
  const key = String(source || '').trim().toLowerCase();
  if (/amap|api|poi/.test(key)) return '地图 API';
  if (/textmodel|ai/.test(key)) return '文字模拟';
  if (/schedule|daily/.test(key)) return '日程推演';
  return '模拟位置';
}

function mapRefreshFingerprint(phone = {}) {
  const current = phone?.currentMapState && typeof phone.currentMapState === 'object' ? phone.currentMapState : {};
  const route = phone?.routeState && typeof phone.routeState === 'object' ? phone.routeState : {};
  return JSON.stringify({
    current: [current.placeName, current.location, current.activity, current.source, current.updatedAt],
    route: [route.origin, route.destination, route.originLocation, route.destinationLocation, route.updatedAt],
    pins: (Array.isArray(phone?.mapPins) ? phone.mapPins : []).slice(0, 16).map((pin) => [pin.placeName, pin.location, pin.source]),
    itineraries: (Array.isArray(phone?.mapItineraries) ? phone.mapItineraries : []).slice(0, 6).map((item) => [item.title, item.updatedAt]),
    grow: phone?.mapGrowState || {},
  });
}

function parseLngLat(value = '') {
  const text = String(value || '').trim();
  if (!isAmapLocation(text)) return null;
  const [lng, lat] = text.split(',').map(Number);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  return [lng, lat];
}

function collectMapCoordinateItems(phone = {}) {
  const route = phone?.routeState && typeof phone.routeState === 'object' ? phone.routeState : {};
  const current = phone?.currentMapState && typeof phone.currentMapState === 'object' ? phone.currentMapState : {};
  const items = [];
  if (route.originLocation) items.push({ label: '起', name: route.origin || '起点', location: route.originLocation, kind: 'route' });
  if (route.destinationLocation) items.push({ label: '终', name: route.destination || '终点', location: route.destinationLocation, kind: 'route' });
  if (current.location) items.push({ label: '现', name: current.placeName || current.area || current.activity || '此刻', location: current.location, kind: 'current' });
  (Array.isArray(phone?.mapItineraries) ? phone.mapItineraries : [])
    .flatMap((item) => Array.isArray(item?.stops) ? item.stops : [])
    .forEach((stop, index) => {
      if (stop?.location) items.push({ label: String(index + 1), name: stop.placeName || '行程点', location: stop.location, kind: 'itinerary' });
    });
  (Array.isArray(phone?.mapPins) ? phone.mapPins : [])
    .filter((pin) => !isMapCandidate(pin))
    .forEach((pin, index) => {
    if (pin?.location) items.push({ label: String(index + 1), name: pin.placeName || '地图钉', location: pin.location, kind: 'pin' });
    });
  const seen = new Set();
  return items
    .filter((item) => parseLngLat(item.location))
    .filter((item) => {
      const key = `${item.name}|${item.location}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 24);
}

function collectFauxMapItems(phone = {}) {
  const current = phone?.currentMapState && typeof phone.currentMapState === 'object' ? phone.currentMapState : {};
  const out = [];
  if (current.placeName || current.area || current.target) {
    out.push({
      label: '现',
      name: current.placeName || current.target || current.area || '此刻',
      kind: 'current',
    });
  }
  (Array.isArray(phone?.mapItineraries) ? phone.mapItineraries : [])
    .flatMap((item) => Array.isArray(item?.stops) ? item.stops : [])
    .forEach((stop, index) => {
      if (stop?.placeName) out.push({ label: String(index + 1), name: stop.placeName, kind: 'itinerary' });
    });
  (Array.isArray(phone?.mapPins) ? phone.mapPins : [])
    .filter((pin) => !isMapCandidate(pin))
    .forEach((pin, index) => {
    if (pin?.placeName) out.push({ label: String(index + 1), name: pin.placeName, kind: 'pin' });
    });
  const seen = new Set();
  return out.filter((item) => {
    const key = String(item.name || '').trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 8);
}

function fauxMapHtml(phone = {}) {
  const items = collectFauxMapItems(phone);
  if (!items.length) return '<span class="cphone-faux-road road-a"></span><span class="cphone-faux-road road-b"></span><span class="cphone-faux-area"></span>';
  const slots = [
    [18, 24],
    [54, 18],
    [78, 34],
    [35, 48],
    [64, 58],
    [22, 70],
    [46, 78],
    [82, 72],
  ];
  return `
    <span class="cphone-faux-road road-a"></span>
    <span class="cphone-faux-road road-b"></span>
    <span class="cphone-faux-road road-c"></span>
    <span class="cphone-faux-area"></span>
    ${items.map((item, index) => {
      const [left, top] = slots[index % slots.length];
      return `
        <span class="cphone-faux-pin is-${esc(item.kind || 'pin')}" style="left:${left}%;top:${top}%;">
          <b>${esc(item.label || String(index + 1))}</b>
          <em>${esc(item.name || '地点')}</em>
        </span>`;
    }).join('')}
  `;
}

function dayTypeLabel(t) {
  const map = {
    workday: '工作日',
    rest: '休息日',
    busy: '忙碌',
    travel: '出行',
    mixed: '混合',
  };
  return map[String(t || '').trim()] || '日常';
}

function flowStepsHtml(block, currentStep = null) {
  const steps = Array.isArray(block?.flowSteps) ? block.flowSteps.filter(Boolean).slice(0, 6) : [];
  if (!steps.length) return '';
  return `
    <div class="cphone-flow">
      ${steps.map((step, index) => {
        const active = currentStep && String(currentStep.id || '') === String(step.id || '');
        const meta = [step.at, step.placeName, step.transit].filter(Boolean).map(esc).join(' · ');
        const sid = String(step.id || index).trim();
        const titleSource = String(step.action || step.shareCandidate || '').trim();
        const metaSource = [step.placeName, step.transit].filter(Boolean).join(' · ');
        const shareSource = step.action && step.shareCandidate ? step.shareCandidate : '';
        const translationSource = [titleSource, metaSource, shareSource].filter(Boolean).join('；');
        return `
          <div class="cphone-flow-step ${active ? 'is-active' : ''}">
            <span class="cphone-flow-dot">${index + 1}</span>
            <div class="cphone-flow-body">
              <strong>${esc(step.action || step.shareCandidate || '流程')}</strong>
              ${meta ? `<em>${meta}</em>` : ''}
              ${step.shareCandidate ? `<small>${esc(step.shareCandidate)}</small>` : ''}
              ${scheduleDisplayTranslationHtml(block, `flow:${sid}`, translationSource, '译步骤')}
            </div>
          </div>
        `;
      }).join('')}
    </div>`;
}

function routeHintHtml(block) {
  const route = block?.routeHint && typeof block.routeHint === 'object' ? block.routeHint : null;
  if (!route) return '';
  const line = [route.origin, route.destination].filter(Boolean).join(' → ');
  const meta = formatRouteMetaLine(route);
  const metaSource = [route.mode, route.durationText, route.distanceText].filter(Boolean).join(' · ');
  const translationSource = [line, metaSource].filter(Boolean).join('；');
  if (!line && !meta) return '';
  return `
    <div class="cphone-route-hint">
      ${line ? `<strong>${esc(line)}</strong>` : ''}
      ${meta ? `<span>${esc(meta)}</span>` : ''}
      ${scheduleDisplayTranslationHtml(block, 'route', translationSource, '译路线')}
    </div>`;
}

function blockHtml(block, { current = false, currentStep = null, tappable = false } = {}) {
  const rawNarrative = String(block.narrative || '').trim();
  const legacyOfflineStatus = block.origin === 'offline_active' && rawNarrative === '线下会面进行中';
  const narrative = legacyOfflineStatus ? '' : rawNarrative;
  const statusLabel = String(block.statusLabel || (legacyOfflineStatus ? rawNarrative : '')).trim();
  const activity = String(block.activity || '').trim();
  const paras = narrative
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${esc(p)}</p>`)
    .join('');
  const locationSource = [block.placeName, block.city].filter(Boolean).join(' · ');
  const meta = [block.timeRange, block.placeName, block.city].filter(Boolean).map(esc).join(' · ');
  const blockId = String(block.id || '').trim();
  const activityTranslate = phoneTranslationSuffixHtml(activity, block.activityTranslation || '', {
    type: 'schedule-activity',
    id: blockId,
    label: '译活动',
  });
  const narrativeTranslate = phoneTranslationSuffixHtml(narrative, block.narrativeTranslation || '', {
    type: 'schedule-narrative',
    id: blockId,
    label: '译叙述',
  });
  return `
    <article class="cphone-block scrapbook-card ${current ? 'is-current' : ''} ${tappable ? 'is-tappable' : ''} ${block.busy ? 'is-busy' : ''} ${block.status ? `is-${esc(block.status)}` : ''}"${tappable ? ' data-start-offline role="button" tabindex="0"' : ''}>
      <header class="cphone-block-head">
        <span class="cphone-block-time">${esc(block.timeRange || '时段')}</span>
        <span class="cphone-block-badges">
          ${block.status === 'changed' ? '<span class="cphone-block-changed">已改</span>' : ''}
          ${block.busy ? '<span class="cphone-block-busy">忙碌</span>' : ''}
          ${tappable ? '<span class="cphone-block-go">去找TA ›</span>' : ''}
        </span>
      </header>
      <div class="cphone-block-act">${esc(activity)}${activityTranslate}</div>
      ${block.changeReason ? `<div class="cphone-change-reason">${esc(block.changeReason)}${scheduleDisplayTranslationHtml(block, 'changeReason', block.changeReason, '译原因')}</div>` : ''}
      ${meta ? `<div class="cphone-block-meta">${meta}</div>` : ''}
      ${locationSource ? scheduleDisplayTranslationHtml(block, 'location', locationSource, '译地点') : ''}
      ${routeHintHtml(block)}
      ${flowStepsHtml(block, currentStep)}
      ${narrative ? `<div class="cphone-block-body">${paras}${narrativeTranslate}</div>` : ''}
      ${statusLabel ? `<div class="cphone-block-live-status" role="status">${esc(statusLabel)}</div>` : ''}
      ${block.eventNote ? `<div class="cphone-block-event-note">${esc(block.eventNote)}${scheduleDisplayTranslationHtml(block, 'eventNote', block.eventNote, '译备注')}</div>` : ''}
      ${block.shareCandidates?.length ? `<div class="cphone-block-share">${block.shareCandidates.slice(0, 2).map((s) => `<span>${esc(s)}</span>`).join('')}${scheduleDisplayTranslationHtml(block, 'shareCandidates', block.shareCandidates.slice(0, 2).join('；'), '译分享')}</div>` : ''}
    </article>`;
}

function noteItemHtml(n) {
  return `
    <li class="cphone-note ${n.completed ? 'is-done' : ''}" data-note-id="${esc(n.id)}" data-record-id="${esc(n.id)}">
      <label class="cphone-note-check">
        <input type="checkbox" class="cphone-note-toggle" ${n.completed ? 'checked' : ''} />
        <span class="cphone-note-box"></span>
      </label>
      <div class="cphone-note-body">
        ${n.title ? `<div class="cphone-note-title">${esc(n.title)}</div>` : ''}
        <div class="cphone-note-text">${esc(n.text)}${phoneTranslationSuffixHtml(n.text, n.translation || '', { type: 'note', id: n.id })}</div>
      </div>
    </li>`;
}

function notesHtml(notes = []) {
  const all = (notes || []).filter(Boolean);
  const open = all.filter((n) => !n.completed);
  const done = all.filter((n) => n.completed);
  if (!open.length && !done.length) {
    return '<div class="cphone-empty-note">还没有备忘录 · 生成今日骨架时会写入结构化 memo</div>';
  }
  return `
    ${open.length ? `<ul class="cphone-notes">${open.map(noteItemHtml).join('')}</ul>` : ''}
    ${done.length ? `
      <div class="cphone-notes-done-label">已完成 · ${done.length}</div>
      <ul class="cphone-notes cphone-notes-done">${done.map(noteItemHtml).join('')}</ul>
    ` : ''}`;
}

function timeLabel(ts) {
  const n = Number(ts || 0);
  if (!n) return '';
  try {
    return new Date(n).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch (_) {
    return '';
  }
}

function recordMeta(parts = []) {
  return parts.filter(Boolean).map(esc).join(' · ');
}

function isMapCandidate(pin = {}) {
  return pin?.relationStatus === 'candidate' || pin?.visibility === 'candidate';
}

async function buildMapPreviewUrl(phone = {}) {
  const cfg = await loadAmapConfig().catch(() => null);
  if (!cfg?.enabled || !cfg?.apiKey) return '';
  const route = phone?.routeState && typeof phone.routeState === 'object' ? phone.routeState : {};
  const itineraries = Array.isArray(phone?.mapItineraries) ? phone.mapItineraries : [];
  const pins = Array.isArray(phone?.mapPins) ? phone.mapPins.filter((pin) => !isMapCandidate(pin)) : [];
  const current = phone?.currentMapState && typeof phone.currentMapState === 'object' ? phone.currentMapState : {};
  const routeMarkers = [
    route.originLocation ? { label: '起', location: route.originLocation } : null,
    route.destinationLocation ? { label: '终', location: route.destinationLocation } : null,
  ].filter(Boolean);
  const itineraryMarkers = itineraries
    .flatMap((item) => Array.isArray(item?.stops) ? item.stops : [])
    .filter((stop) => stop?.location)
    .slice(0, 6)
    .map((stop, index) => ({ label: String(index + 1), location: stop.location }));
  const pinMarkers = pins
    .filter((pin) => pin?.location)
    .slice(0, 6)
    .map((pin, index) => ({ label: String(index + 1), location: pin.location }));
  const markers = routeMarkers.length >= 2 ? routeMarkers : (itineraryMarkers.length ? itineraryMarkers : pinMarkers);
  const center = current.location
    || route.destinationLocation
    || route.originLocation
    || markers[0]?.location
    || '';
  if (!center && !markers.length) return '';
  return buildAmapStaticMapUrl({
    key: cfg.apiKey,
    center,
    zoom: markers.length > 2 ? 13 : 15,
    size: '520*230',
    markers,
    paths: route.polyline?.length ? [{ points: route.polyline }] : [],
  });
}

function browserRecordsHtml(records = []) {
  const list = (records || []).slice(0, 24);
  if (!list.length) return '<div class="cphone-empty">还没有浏览记录</div>';
  return `
    <div class="cphone-browser-chrome">
      <div class="cphone-browser-address"><span>⌕</span><span>搜索或输入网址</span></div>
      <div class="cphone-browser-actions" aria-hidden="true"><span>‹</span><span>›</span><span>□</span><span>＋</span><span>•••</span></div>
    </div>
    <div class="cphone-browser-history-title">历史记录</div>
    <div class="cphone-record-list cphone-browser-history">
      ${list.map((r) => {
        const linkType = String(r.linkType || '').trim();
        const isForum = isForumBrowserRecord(r);
        const isWeibo = isWeiboBrowserRecord(r);
        const isLocal = !isForum && !isWeibo && (linkType === 'fictional' || !r.url);
        const kicker = isWeibo ? '站内微博' : (isForum ? '站内论坛' : (isLocal ? '剧情网页' : '网页小窗'));
        const openLabel = (isWeibo || isForum) ? '站内' : '打开';
        const metaSource = r.sourceName || (isForum ? '站内论坛' : (isLocal ? '本地网页' : '网页'));
        const meta = recordMeta([metaSource, r.query ? `搜索：${r.query}` : '', timeLabel(r.visitedAt || r.createdAt)]);
        const shareStatusTag = r.shareStatus === 'pending'
          ? '<span class="cphone-record-share-status is-pending">待分享</span>'
          : (r.shareStatus === 'shared' ? '<span class="cphone-record-share-status is-shared">已分享</span>' : '');
        const summaryTranslationHtml = r.summary
          ? phoneTranslationSuffixHtml(r.summary, r.summaryTranslation || (!r.body ? r.translation : '') || '', { type: 'browser-summary', id: r.id })
          : '';
        const judgementTranslationHtml = r.aiJudgement
          ? phoneTranslationSuffixHtml(r.aiJudgement, r.aiJudgementTranslation || '', { type: 'browser-judgement', id: r.id })
          : '';
        return `
          <article class="cphone-record cphone-browser-record" data-browser-id="${esc(r.id)}"${r._interestLink ? '' : ` data-record-id="${esc(r.id)}"`}>
            <div class="cphone-browser-record-content">
              <button type="button" class="cphone-record-main" data-record-detail="${esc(r.id)}">
                <span class="cphone-record-kicker">${esc(kicker)}</span>${shareStatusTag}
                <strong>${esc(r.title || '网页记录')}</strong>
                ${r.summary ? `<span>${esc(r.summary)}</span>` : ''}
                ${r.aiJudgement ? `<span class="cphone-record-judgement">${esc(r.aiJudgement)}</span>` : ''}
                ${meta ? `<em>${meta}</em>` : ''}
              </button>
              ${summaryTranslationHtml ? `<div class="cphone-browser-record-translation">${summaryTranslationHtml}</div>` : ''}
              ${judgementTranslationHtml ? `<div class="cphone-browser-record-translation">${judgementTranslationHtml}</div>` : ''}
            </div>
            <button type="button" class="cphone-record-open" data-record-detail="${esc(r.id)}">${esc(openLabel)}</button>
          </article>`;
      }).join('')}
    </div>`;
}

function mapPinsHtml(phone = {}, mapPreviewUrl = '', character = {}, { refreshing = false } = {}) {
  const pins = Array.isArray(phone?.mapPins)
    ? phone.mapPins.filter((pin) => !isMapCandidate(pin)).slice(0, 36)
    : [];
  const itineraries = Array.isArray(phone?.mapItineraries) ? phone.mapItineraries.slice(0, 8) : [];
  const current = phone?.currentMapState && typeof phone.currentMapState === 'object' ? phone.currentMapState : {};
  const route = phone?.routeState && typeof phone.routeState === 'object' ? phone.routeState : {};
  const coordinateItems = collectMapCoordinateItems(phone);
  const sourceLabel = mapStateSourceLabel(current.source);
  const currentLine = [current.city, current.area, current.placeName, current.activity].filter(Boolean).join(' · ');
  const routePath = route.origin && route.destination
    ? `${route.origin} → ${route.destination}`
    : (route.origin || route.destination || '');
  const routeMeta = formatRouteMetaLine(route);
  const routeLine = [routePath, routeMeta].filter(Boolean).join(' · ');
  const visitedPins = pins.filter((pin) => ['visited', 'revisit'].includes(pin.relationStatus) || Number(pin.visitCount || 0) > 0);
  const frequentPins = visitedPins.filter((pin) => pin.relationStatus === 'revisit' || Number(pin.visitCount || 0) >= 2);
  const nearbyPins = pins.filter((pin) => !visitedPins.includes(pin));
  const activityRows = [
    ...itineraries.map((item) => ({
      id: item.id,
      title: item.title || '地图行程',
      detail: item.summary || (Array.isArray(item.stops) ? item.stops.map((stop) => stop.placeName).filter(Boolean).join(' → ') : ''),
      meta: item.city || item.anchorName || '行程',
      kind: 'route',
    })),
    ...visitedPins.map((pin) => ({
      id: pin.id,
      title: pin.placeName || '地点',
      detail: pin.aiJudgement || pin.address || '',
      meta: recordMeta([pin.visitVerdict || mapRelationLabel(pin.relationStatus), pin.lastVisitAt ? timeLabel(pin.lastVisitAt) : '', Number(pin.visitCount || 0) > 1 ? `${pin.visitCount} 次` : '']),
      kind: 'visit',
    })),
  ].slice(0, 8);
  const pinRowHtml = (pin, kind) => {
    const relation = mapRelationLabel(pin.relationStatus);
    const verdict = pin.visitVerdict || relation;
    const meta = recordMeta([verdict, pin.bucketLabel || pin.bucket, pin.district, pin.distance ? `${pin.distance}m` : '', Number(pin.visitCount || 0) > 1 ? `${pin.visitCount} 次` : '']);
    return `
      <article class="cphone-map-place is-${kind}"${pin.id ? ` data-record-id="${esc(pin.id)}"` : ''}>
        <span class="cphone-map-place-mark" aria-hidden="true"></span>
        <span class="cphone-map-place-main">
          <strong>${esc(pin.placeName || '地点')}</strong>
          ${pin.address ? `<span>${esc(pin.address)}</span>` : ''}
          ${pin.aiJudgement ? `<span class="cphone-record-judgement">${esc(pin.aiJudgement)}${phoneTranslationSuffixHtml(pin.aiJudgement, pin.aiJudgementTranslation || '', { type: 'map-judgement', id: pin.id })}</span>` : ''}
          ${meta ? `<em>${meta}</em>` : ''}
        </span>
      </article>`;
  };
  if (!pins.length && !itineraries.length && !currentLine && !routeLine) return '<div class="cphone-empty">还没有地图钉</div>';
  return `
    <div class="cphone-map-product">
      <div class="cphone-map-source is-checking" data-cphone-map-source>
        <span data-cphone-map-source-label>${esc(sourceLabel)}</span>
        <em data-cphone-map-source-detail>正在检查地图服务…</em>
      </div>
      <article class="cphone-map-live ${coordinateItems.length ? '' : 'is-text-only'}">
        <div class="cphone-map-live-canvas" data-cphone-live-map>
          ${coordinateItems.length ? '' : fauxMapHtml(phone)}
          ${coordinateItems.length ? '' : `<span class="cphone-map-person-pin">${characterAvatarHtml(character, { className: 'cphone-map-person-avatar' })}<i></i></span>`}
        </div>
        <div class="cphone-map-live-status" data-cphone-live-map-status>${coordinateItems.length ? '小地图加载中' : '暂无坐标，先收纳文本地图钉'}</div>
        <button type="button" class="cphone-map-refresh cphone-refresh-map" aria-label="${refreshing ? '正在刷新地图' : '刷新当前位置与周边'}" ${refreshing ? 'disabled' : ''}>${refreshing ? '…' : '↻'}</button>
      </article>
      ${mapPreviewUrl ? `
        <article class="cphone-map-preview cphone-map-static-fallback">
          <img src="${esc(mapPreviewUrl)}" alt="" loading="lazy" decoding="async" />
        </article>` : ''}
      <section class="cphone-map-sheet">
        ${currentLine ? `
        <article class="cphone-map-now">
          ${characterAvatarHtml(character, { className: 'cphone-map-now-avatar' })}
          <div class="cphone-map-card-body">
            <span class="cphone-record-kicker">现在 · ${esc(sourceLabel)}</span>
            <strong>${esc(currentLine)}</strong>
            ${current.updatedAt ? `<em>${esc(timeLabel(current.updatedAt))}</em>` : ''}
          </div>
        </article>` : ''}
        ${routeLine ? `
        <article class="cphone-map-route">
          <span class="cphone-map-route-icon" aria-hidden="true">↗</span>
          <div class="cphone-map-card-body">
            <span class="cphone-record-kicker">当前路线</span>
            <strong>${esc(routeLine)}</strong>
            ${route.distance ? `<span>${esc(`${Math.round(Number(route.distance) || 0)}m`)}</span>` : ''}
          </div>
        </article>` : ''}
        <section class="cphone-map-activity">
          <div class="cphone-map-section-head"><strong>活动记录</strong><span>${activityRows.length}</span></div>
          ${activityRows.length ? `<div class="cphone-map-timeline">${activityRows.map((item) => `
            <article class="is-${item.kind}"${item.id ? ` data-record-id="${esc(item.id)}"` : ''}>
              <i aria-hidden="true"></i>
              <div><strong>${esc(item.title)}</strong>${item.detail ? `<span>${esc(item.detail)}</span>` : ''}${item.meta ? `<em>${item.meta}</em>` : ''}</div>
            </article>`).join('')}</div>` : '<div class="cphone-map-empty-row">还没有活动记录</div>'}
        </section>
        <details class="cphone-map-place-library">
          <summary><span>地图钉与店铺消息</span><em>${pins.length} 条</em></summary>
          <div class="cphone-map-place-groups">
            <section>
              <h3>去过 <span>${visitedPins.length}</span></h3>
              ${visitedPins.length ? visitedPins.map((pin) => pinRowHtml(pin, 'visited')).join('') : '<div class="cphone-map-empty-row">还没有去过的地点</div>'}
            </section>
            <section>
              <h3>周围 <span>${nearbyPins.length}</span></h3>
              ${nearbyPins.length ? nearbyPins.map((pin) => pinRowHtml(pin, 'nearby')).join('') : '<div class="cphone-map-empty-row">周围还没有新地点</div>'}
            </section>
            <section>
              <h3>常去 <span>${frequentPins.length}</span></h3>
              ${frequentPins.length ? frequentPins.map((pin) => pinRowHtml(pin, 'frequent')).join('') : '<div class="cphone-map-empty-row">到访两次后会出现在这里</div>'}
            </section>
          </div>
        </details>
      </section>
    </div>`;
}

function simpleRecordsHtml(records = [], options = {}) {
  const list = (records || []).slice(0, 24);
  if (!list.length) return `<div class="cphone-empty">还没有${esc(options.empty || '记录')}</div>`;
  return `
    <div class="cphone-record-grid">
      ${list.map((r) => {
        const title = r.title || r.contactName || '记录';
        const desc = r.caption || r.summary || r.detail || r.note || r.description || '';
        const judgement = r.aiJudgement || r.judgement || r.verdict || '';
        const meta = recordMeta([
          r.location || r.platform || r.category || r.contactName || '',
          r.durationText || r.artist || r.strength || '',
          timeLabel(r.takenAt || r.occurredAt || r.playedAt || r.updatedAt || r.createdAt),
        ]);
        return `
          <article class="cphone-mini-record"${r.id ? ` data-record-id="${esc(r.id)}"` : ''}>
            <strong>${esc(title)}</strong>
            ${desc ? `<span>${esc(desc)}${phoneTranslationSuffixHtml(desc, r.translation || '', { type: 'interest-detail', id: r.id })}</span>` : ''}
            ${judgement ? `<span class="cphone-record-judgement">${esc(judgement)}${phoneTranslationSuffixHtml(judgement, r.aiJudgementTranslation || '', { type: 'interest-judgement', id: r.id })}</span>` : ''}
            ${meta ? `<em>${meta}</em>` : ''}
            ${r.url ? `<a class="cphone-record-open cphone-link-preview" href="${esc(r.url)}">站内预览</a>` : ''}
          </article>`;
      }).join('')}
    </div>`;
}

function callRecordsHtml(records = []) {
  const list = (records || []).slice(0, 36);
  if (!list.length) return '<div class="cphone-empty">还没有通话记录</div>';
  return `<div class="cphone-call-list">${list.map((record) => {
    const direction = String(record.direction || '').toLowerCase();
    const missed = direction === 'missed';
    const arrow = direction === 'outgoing' ? '↗' : (missed ? '↙' : '↙');
    return `<article class="cphone-call-row${missed ? ' is-missed' : ''}"${record.id ? ` data-record-id="${esc(record.id)}"` : ''}>
      <span class="cphone-call-avatar">${esc(String(record.contactName || '?').slice(0, 1))}</span>
      <span><strong>${esc(record.contactName || '未知联系人')}</strong><em>${arrow} ${esc(missed ? '未接来电' : (direction === 'outgoing' ? '呼出' : '呼入'))}${record.durationText ? ` · ${esc(record.durationText)}` : ''}</em></span>
      <time>${esc(timeLabel(record.occurredAt || record.createdAt))}</time>
      ${record.summary ? `<div class="cphone-call-summary">${esc(record.summary)}${phoneTranslationSuffixHtml(record.summary, record.translation || '', { type: 'call', id: record.id })}</div>` : ''}
    </article>`;
  }).join('')}</div>`;
}

function looksLikeImageFilename(value = '') {
  const name = String(value || '').trim();
  if (!name) return false;
  return /\.(jpe?g|png|gif|webp|heic|heif|bmp|avif)$/i.test(name)
    || /^IMG[-_\s]?\d/i.test(name)
    || /^Screenshot/i.test(name)
    || /^微信图片/i.test(name)
    || /^mmexport\d/i.test(name);
}

function avatarDisplayTitle(record = {}) {
  const title = String(record?.title || '').trim();
  if (title && !looksLikeImageFilename(title)) return plain(title, 16);
  return '用户导入头像';
}

function avatarLibraryHtml(records = [], pending = null) {
  const list = (records || []).slice(0, 48);
  const pendingUrl = String(pending?.imageUrl || '').trim();
  return `
    <section class="cphone-avatar-import scrapbook-panel">
      <strong>导入头像备选</strong>
      <label class="cphone-avatar-upload">
        <input type="file" accept="image/*" hidden data-avatar-import-file>
        <span class="btn btn-outline btn-sm">${pendingUrl ? '重新选择' : '选择图片'}</span>
      </label>
      ${pendingUrl ? `
        <div class="cphone-avatar-pending">
          <img src="${esc(pendingUrl)}" alt="" decoding="async" />
          <span>已选好，写完描述后点加入</span>
        </div>` : ''}
      <textarea class="cphone-avatar-desc" rows="3" placeholder="给这张头像写一点描述，比如表情、氛围、适合什么时候换"></textarea>
      <button type="button" class="btn btn-primary btn-sm cphone-avatar-save" ${pendingUrl ? '' : 'disabled'}>加入头像库</button>
      <button type="button" class="btn btn-soft btn-sm cphone-avatar-pick" ${list.some((item) => item.imageUrl) ? '' : 'disabled'}>让 TA 自己挑一张</button>
    </section>
    ${list.length ? `
      <div class="cphone-photo-grid cphone-avatar-grid">
        ${list.map((r) => {
          const imageUrl = imageUrlFromRecord(r);
          const title = avatarDisplayTitle(r);
          const desc = plain(r.description || r.summary || r.imagePrompt || '', 36);
          // 预览只带 id，避免把整段 base64 再塞进 data-photo-url（iOS 上会显著拖慢渲染）。
          return `
            <article class="cphone-photo-record cphone-avatar-record" data-avatar-id="${esc(r.id)}" data-record-id="${esc(r.id)}">
              <button type="button" class="cphone-photo-thumb" ${r.id && imageUrl ? `data-avatar-preview="${esc(r.id)}"` : ''} aria-label="${esc(title)}">
                ${imageUrl ? `<img src="${esc(imageUrl)}" alt="" loading="lazy" decoding="async" />` : '<span>待补图</span>'}
              </button>
              <strong title="${esc(String(r.title || title))}">${esc(title)}</strong>
              ${desc ? `<span title="${esc(String(r.description || r.summary || r.imagePrompt || ''))}">${esc(desc)}</span>` : ''}
              <button type="button" class="btn btn-xs btn-primary" data-use-avatar="${esc(r.id)}" ${imageUrl ? '' : 'disabled'}>设为头像</button>
            </article>`;
        }).join('')}
      </div>`
      : '<div class="cphone-empty">还没有头像记录</div>'}
  `;
}

function compactMusicMatchText(value = '') {
  return String(value || '').toLowerCase().replace(/[\s·・\-—_()[\]【】]/g, '');
}

function resolvePhoneMusicRecord(record = {}, library = {}) {
  const tracks = Array.isArray(library?.tracks) ? library.tracks : [];
  const title = String(record?.title || record?.songName || '').trim();
  const artist = String(record?.artist || record?.singer || '').trim();
  const titleKey = compactMusicMatchText(title);
  const artistKey = compactMusicMatchText(artist);
  const matched = tracks.find((track) => {
    const trackTitle = compactMusicMatchText(track?.title);
    const trackArtist = compactMusicMatchText(track?.artist);
    return trackTitle && trackTitle === titleKey && (!artistKey || trackArtist === artistKey);
  }) || null;
  return {
    id: String(record?.id || '').trim(),
    title: matched?.title || title,
    artist: matched?.artist || artist,
    album: String(matched?.album || '').trim(),
    duration: String(matched?.duration || '').trim(),
    coverUrl: String(matched?.coverUrl || '').trim(),
    query: String(record?.searchQuery || `${title} ${artist}`).trim(),
  };
}

function phoneMusicCoverHtml(item = {}, { compact = false } = {}) {
  const cover = normalizeRemoteCoverUrl(item?.coverUrl);
  return `<span class="cphone-music-cover${cover ? ' has-image' : ''}${compact ? ' is-compact' : ''}">
    ${cover ? `<img src="${esc(cover)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : icon('music', 'cphone-music-placeholder-icon')}
  </span>`;
}

function musicLibraryHtml(phoneRecords = [], library = {}) {
  // TA 自己的听歌记录是这页的主体；用户全局音乐库只是只读镜像，折叠收纳，别把 TA 的记录挤到底下
  const allTracks = Array.isArray(library?.tracks) ? library.tracks : [];
  const tracks = allTracks.slice(0, 18);
  const playlists = Array.isArray(library?.playlists) ? library.playlists.slice(0, 8) : [];
  const recent = (phoneRecords || []).slice(0, 24).map((record) => resolvePhoneMusicRecord(record, library));
  const phonePart = `
    <section class="cphone-section">
      <div class="cphone-section-head"><div class="cphone-section-title">TA 最近在听</div><span class="cphone-music-source">网易云音乐</span></div>
      ${recent.length ? `<div class="cphone-phone-music-list">${recent.map((record, index) => `
        <article class="cphone-phone-music-row${index === 0 ? ' is-current' : ''}"${record.id ? ` data-record-id="${esc(record.id)}"` : ''}>
          ${phoneMusicCoverHtml(record)}
          <button type="button" class="cphone-phone-music-main" data-phone-music-search="${esc(record.query)}" aria-label="在网易云搜索并播放《${esc(record.title)}》">
            <strong>${esc(record.title)}</strong>
            <em>${esc([record.artist, record.album, record.duration].filter(Boolean).join(' · ') || '网易云音乐')}</em>
          </button>
          <button type="button" class="cphone-music-search-action" data-phone-music-search="${esc(record.query)}" aria-label="搜索《${esc(record.title)}》">⌕</button>
        </article>`).join('')}</div>` : `
          <div class="cphone-music-empty-state">
            <span aria-hidden="true">♫</span>
            <p>还没有音乐记录</p>
            <button type="button" class="btn btn-xs btn-outline" data-open-music-app>去音乐页搜索</button>
          </div>`}
    </section>`;
  const libraryPart = tracks.length || playlists.length
    ? `
      <details class="cphone-music-user-lib">
        <summary>我的音乐库 · ${playlists.length ? `${playlists.length} 个歌单 · ` : ''}${allTracks.length} 首</summary>
        <div class="cphone-music-user-lib-body">
          <button type="button" class="btn btn-outline btn-sm" data-open-music-app>打开播放器</button>
          ${playlists.length ? `
            <div class="cphone-music-playlists">
              ${playlists.map((p) => `<button type="button" class="cphone-music-chip" data-open-music-app>${esc(p.title || '歌单')}<small>${esc(`${(p.trackIds || []).length} 首`)}</small></button>`).join('')}
            </div>` : ''}
          ${tracks.length ? `
            <div class="cphone-record-grid cphone-music-tracks">
              ${tracks.map((track) => `
                <article class="cphone-mini-record">
                  <strong>${esc(track.title || '歌曲')}</strong>
                  <span>${esc([track.artist, track.album].filter(Boolean).join(' · ') || '音乐')}</span>
                  <em>${esc(track.provider === 'netease' || track.source === 'netease' ? '网易云' : (track.source || '本地'))}</em>
                  <button type="button" class="btn btn-xs btn-primary" data-open-music-app>去播放</button>
                </article>
              `).join('')}
            </div>` : ''}
        </div>
      </details>`
    : '<button type="button" class="cphone-music-lib-empty-link" data-open-music-app>我的音乐库还没有歌 · 打开音乐页导入</button>';
  return `${phonePart}${libraryPart}`;
}

function imageUrlFromRecord(record = {}) {
  if (record?.imageKind === 'textimg') return '';
  return String(record.imageUrl || record.url || record.content || '').trim();
}

/** 相册网格与预览弹层共用同一条全文回退链，兼容各时期的记录字段。 */
export function resolvePhonePhotoFullText(record = {}, preview = null) {
  const values = [
    record?.caption,
    preview?.caption,
    record?.summary,
    preview?.summary,
    record?.description,
    preview?.description,
    record?.imagePrompt,
    preview?.imagePrompt,
    record?.textImageCaption,
    preview?.textImageCaption,
  ];
  for (const value of values) {
    const text = String(value || '').trim();
    if (text) return text;
  }
  return '';
}

export function summarizePhonePhotoText(record = {}, maxLength = 96) {
  return plain(resolvePhonePhotoFullText(record), maxLength);
}

/** 相册文字图正文：优先 textImageCaption，兼容只写在 caption/title 的旧数据。 */
function resolvePhotoTextImage(record = {}, preview = null) {
  const fromFields = [
    record?.textImageCaption,
    preview?.textImageCaption,
    record?.imageKind === 'textimg' ? record?.caption : '',
    record?.imageKind === 'textimg' ? record?.title : '',
  ];
  for (const value of fromFields) {
    const text = String(value || '').trim();
    if (text) return text;
  }
  return '';
}

function photoThumbInnerHtml(record = {}) {
  const imageUrl = imageUrlFromRecord(record);
  const textImage = resolvePhotoTextImage(record);
  if (imageUrl) {
    return `<img src="${esc(imageUrl)}" alt="" loading="lazy" decoding="async" />`;
  }
  if (textImage) {
    const lines = textImage.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const title = lines[0] || '文字图';
    const preview = lines.slice(1, 3).map((line) => `<em>${esc(line)}</em>`).join('');
    return `<span class="cphone-photo-textimg"><b>${esc(title)}</b>${preview}</span>`;
  }
  return '<span>待补图</span>';
}

function photoRecordCanReroll(record = {}) {
  return !!(
    cleanPhotoPrompt(record)
    || String(record.textImageCaption || '').trim()
    || String(record.title || '').trim()
    || String(record.caption || '').trim()
  );
}

function cleanPhotoPrompt(record = {}) {
  return String(record.imagePrompt || record.prompt || '').trim();
}

export function photoRecordsHtml(records = [], chatImages = [], {
  selecting = false,
  selectedIds = null,
  visibleLimit = 24,
} = {}) {
  const albumList = (records || []).slice(0, visibleLimit).map((r) => ({ r, selectable: true }));
  const chatList = (chatImages || []).slice(0, visibleLimit).map((r) => ({ r, selectable: false }));
  if (!albumList.length && !chatList.length) return '<div class="cphone-empty">还没有相册记录</div>';
  const gridHtml = (list) => `
    <div class="cphone-photo-grid">
      ${list.map(({ r, selectable }) => {
        const imageUrl = imageUrlFromRecord(r);
        const textImage = resolvePhotoTextImage(r);
        const fullText = resolvePhonePhotoFullText(r);
        const title = r.title || fullText || '相册记录';
        const desc = summarizePhonePhotoText(r);
        const selected = selectable && selectedIds?.has?.(String(r.id || ''));
        const thumbKind = imageUrl ? 'photo' : (textImage || r.imageKind === 'textimg' ? 'textimg' : 'pending');
        const previewAttrs = selectable && r.id
          ? ` data-photo-id="${esc(r.id)}" data-record-id="${esc(r.id)}" data-photo-preview="${esc(r.id)}"`
          : '';
        // 聊天同步进来的真图仍挂在缩略钮上；手机相册记录改挂整卡，点标题/摘要也能打开。
        const thumbUrlAttr = !selectable && imageUrl
          ? ` data-photo-url="${esc(imageUrl)}"${r.id ? ` data-photo-record-id="${esc(r.id)}"` : ''}`
          : '';
        return `
          <article class="cphone-photo-record${selectable && selecting ? ' is-photo-selectable' : ''}${selected ? ' is-selected' : ''}${selectable && r.id && !selecting ? ' is-photo-openable' : ''}"${previewAttrs}>
            <button type="button" class="cphone-photo-thumb is-${esc(thumbKind)}"${thumbUrlAttr} aria-label="${esc(title)}">
              ${photoThumbInnerHtml(r)}
            </button>
            <strong>${esc(title)}</strong>
            ${desc ? `<span class="cphone-photo-summary">${esc(desc)}${phoneTranslationSuffixHtml(fullText, r.translation || '', { type: 'photo', id: r.id })}</span>` : ''}
            <em>${recordMeta([r.sourceName || r.location || '', timeLabel(r.takenAt || r.timestamp || r.createdAt)])}</em>
          </article>`;
      }).join('')}
    </div>`;
  const hasMore = (records || []).length > albumList.length || (chatImages || []).length > chatList.length;
  return `
    ${albumList.length ? `<section class="cphone-photo-section">
      ${chatList.length ? '<h3>TA 的相册</h3>' : ''}
      ${gridHtml(albumList)}
    </section>` : ''}
    ${chatList.length ? `<section class="cphone-photo-section">
      ${albumList.length ? '<h3>聊天图片</h3>' : ''}
      ${gridHtml(chatList)}
    </section>` : ''}
    ${hasMore ? '<button type="button" class="btn btn-ghost btn-sm cphone-photo-load-more" data-photo-load-more>加载更多</button>' : ''}`;
}

function activityStatusLabel(status) {
  const map = {
    planned: '待探索',
    active: '进行中',
    done: '已收纳',
    cancelled: '已取消',
    expired: '已过期',
  };
  return map[String(status || '').trim()] || '记录';
}

function activityCardsHtml(sessions = [], now = Date.now()) {
  const list = (sessions || []).slice(0, 12);
  if (!list.length) return '';
  return `
    <section class="cphone-section">
      <div class="cphone-section-title">探索小卡片</div>
      <div class="cphone-activity-cards">
        ${list.map((s) => {
          const effectiveStatus = getEffectiveActivityStatus(s, now);
          const resumable = effectiveStatus === 'planned';
          const route = s.routePlan || {};
          const detailCards = Array.isArray(s.detailCards) ? s.detailCards : [];
          const outputs = Array.isArray(s.outputs) ? s.outputs : [];
          const details = [
            route.summary,
            s.motivation,
            ...detailCards.map((x) => x.summary || x.title || ''),
            ...outputs.map((x) => x.summary || x.title || ''),
          ].filter(Boolean).slice(0, 5);
          const expiredNote = effectiveStatus === 'expired' || (effectiveStatus === 'cancelled' && s.cancelReason === 'expired')
            ? '<p class="cphone-activity-expired-note">这个时段已过，不会再注入聊天或主动消息。</p>'
            : '';
          const resumeBtn = resumable && s.activityGroupChatId
            ? `<button type="button" class="btn btn-primary btn-sm btn-block cphone-resume-activity" data-resume-activity="${esc(s.id)}" data-resume-chat="${esc(s.activityGroupChatId)}">继续线下探索 ›</button>`
            : '';
          return `
            <details class="cphone-activity-card${effectiveStatus === 'expired' || s.cancelReason === 'expired' ? ' is-expired' : ''}${resumable ? ' is-resumable' : ''}">
              <summary>
                <span>
                  <b>${esc(s.title || route.destination || '探索')}</b>
                  <em>${recordMeta([activityStatusLabel(effectiveStatus === 'cancelled' && s.cancelReason === 'expired' ? 'expired' : effectiveStatus), route.destination, timeLabel(s.updatedAt || s.createdAt)])}</em>
                </span>
              </summary>
              <div class="cphone-activity-detail">
                ${resumeBtn}
                ${expiredNote}
                ${details.length ? details.map((d) => `<p>${esc(d)}</p>`).join('') : '<p>细节会在探索推进或总结后收进这里。</p>'}
                ${route.waypoints?.length ? `<div class="cphone-waypoints">${route.waypoints.map((w) => `<span>${esc(w.label || '')}</span>`).join('')}</div>` : ''}
              </div>
            </details>`;
        }).join('')}
      </div>
    </section>`;
}

function proactiveStatsHtml(usage = {}, expanded = false) {
  const sentRounds = Math.max(0, Number(usage.sentRounds || 0));
  const dailyLimit = Math.max(1, Number(usage.limit || DEFAULT_PROACTIVE_DAILY_LIMIT));
  const messageCount = Math.max(0, Number(usage.messageCount || 0));
  const history = Array.isArray(usage.log) ? usage.log : [];
  const failedCount = history.filter((item) => item.status === 'failed').reduce((sum, item) => sum + Number(item.count || 1), 0);
  const skippedCount = history.filter((item) => item.status === 'skipped').reduce((sum, item) => sum + Number(item.count || 1), 0);
  const recent = history.slice(0, 8);
  const label = `今日主动 ${sentRounds}/${dailyLimit} · 气泡 ${messageCount}`;
  const evidenceHtml = (item) => {
    const error = String(item?.error || '').trim();
    const rawText = String(item?.rawText || '').trim();
    const reasoningText = String(item?.reasoningText || '').trim();
    const responseText = String(item?.responseText || '').trim();
    const meta = [
      item?.statusCode ? `HTTP ${item.statusCode}` : '',
      item?.requestModel ? `模型 ${item.requestModel}` : '',
      item?.requestStream === true ? '流式' : (item?.requestStream === false ? '非流式' : ''),
      item?.finishReason ? `finish_reason: ${item.finishReason}` : '',
    ].filter(Boolean).join(' · ');
    if (!error && !rawText && !reasoningText && !responseText && !meta) return '';
    return `
      <details class="cphone-proactive-log-evidence">
        <summary>查看本次完整返回</summary>
        ${meta ? `<p>${esc(meta)}</p>` : ''}
        ${error ? `<section><b>错误信息</b><pre>${esc(error)}</pre></section>` : ''}
        ${responseText ? `<section><b>接口原文</b><pre>${esc(responseText)}</pre></section>` : ''}
        ${rawText ? `<section><b>模型原文</b><pre>${esc(rawText)}</pre></section>` : ''}
        ${reasoningText ? `<section><b>推理原文</b><pre>${esc(reasoningText)}</pre></section>` : ''}
      </details>`;
  };
  return `
    <div class="cphone-proactive-stats">
      <button type="button" class="cphone-proactive-stats-btn" data-proactive-stats>
        <span>${esc(label)}</span>
        ${failedCount ? `<b>${esc(`${failedCount} 失败`)}</b>` : ''}
      </button>
      ${expanded ? `
        <div class="cphone-proactive-stats-panel">
          <div class="cphone-proactive-stats-grid">
            <span>成功轮次</span><strong>${esc(String(sentRounds))}/${esc(String(dailyLimit))}</strong>
            <span>实际气泡</span><strong>${esc(String(messageCount))}</strong>
            <span>失败</span><strong>${esc(String(failedCount))}</strong>
            <span>暂缓</span><strong>${esc(String(skippedCount))}</strong>
          </div>
          ${recent.length ? `
            <div class="cphone-proactive-log">
              ${recent.slice(0, 8).map((item) => `
                <div class="cphone-proactive-log-item">
                  <div class="cphone-proactive-log-row is-${esc(item.status || 'failed')}">
                    <span>${esc(timeLabel(item.at))}</span>
                    <strong>${esc(item.status === 'sent' ? '已发送' : (item.status === 'failed' ? '失败' : '暂缓'))}</strong>
                    <em>${esc([
                      item.channel || '',
                      item.messageCount ? `${item.messageCount} 条` : '',
                      proactiveReasonLabel(item.reason || ''),
                      Number(item.count || 1) > 1 ? `重复 ${item.count} 次` : '',
                    ].filter(Boolean).join(' · '))}</em>
                  </div>
                  ${item.status === 'failed' ? evidenceHtml(item) : ''}
                </div>
              `).join('')}
            </div>` : '<div class="cphone-proactive-log-empty">今天还没有主动记录</div>'}
        </div>` : ''}
    </div>`;
}

function blockIsActiveNow(block, timestamp = Date.now(), timeZone = '') {
  return isPlanBlockActiveAt(block, timestamp, timeZone);
}

function mapStateFromCurrentScheduleBlock(plan, timestamp = Date.now(), timeZone = '') {
  const block = plan ? pickCurrentPlanBlock(plan, timestamp, timeZone) : null;
  if (!block || !isPlanBlockActiveAt(block, timestamp, timeZone)) return null;
  const route = block.routeHint && typeof block.routeHint === 'object' ? block.routeHint : {};
  const waypoint = Array.isArray(route.waypoints)
    ? [...route.waypoints].reverse().find((item) => item?.location)
    : null;
  const placeName = block.placeName || route.destination || waypoint?.label || block.anchor || '';
  if (!placeName && !block.city && !block.activity) return null;
  return {
    city: block.city || '',
    area: block.anchor || '',
    placeName,
    activity: block.activity || '',
    location: waypoint?.location || '',
    source: 'dailyLifePlan',
    confidence: 0.72,
    updatedAt: timestamp,
    expiresAt: timestamp + 2 * 60 * 60 * 1000,
  };
}

function routeStateFromCurrentScheduleBlock(plan, timestamp = Date.now(), timeZone = '') {
  const block = plan ? pickCurrentPlanBlock(plan, timestamp, timeZone) : null;
  if (!block || !isPlanBlockActiveAt(block, timestamp, timeZone)) return null;
  const route = block.routeHint && typeof block.routeHint === 'object' ? block.routeHint : null;
  if (!route || !(route.origin || route.destination || route.mode || route.durationText)) return null;
  const waypoints = Array.isArray(route.waypoints) ? route.waypoints : [];
  const originPoint = waypoints.find((item) => item?.kind === 'origin' && item.location)?.location || '';
  const destinationPoint = [...waypoints].reverse().find((item) => item?.location)?.location || '';
  return {
    origin: route.origin || block.anchor || '',
    originLocation: originPoint,
    destination: route.destination || block.placeName || '',
    destinationLocation: destinationPoint,
    mode: route.mode || '',
    activity: block.activity || '',
    distance: 0,
    duration: 0,
    summary: formatRouteMetaLine(route),
    polyline: [],
    source: 'dailyLifePlan',
    updatedAt: timestamp,
    expiresAt: timestamp + 2 * 60 * 60 * 1000,
  };
}

function virtualMapStateFromContext({ phone = {}, plan = null, character = {}, timestamp = Date.now(), timeZone = '' } = {}) {
  const scheduled = mapStateFromCurrentScheduleBlock(plan, timestamp, timeZone);
  if (scheduled) return { ...scheduled, source: 'virtualScheduleMap' };
  const existing = phone?.currentMapState && typeof phone.currentMapState === 'object'
    ? phone.currentMapState
    : {};
  if (existing.placeName || existing.area || existing.city || existing.activity) {
    return { ...existing, source: existing.source || 'virtualMap', updatedAt: timestamp };
  }
  const block = plan ? pickCurrentPlanBlock(plan, timestamp, timeZone) : null;
  const anchor = character?.residenceAnchor && typeof character.residenceAnchor === 'object'
    ? character.residenceAnchor
    : {};
  const placeName = block?.placeName || block?.anchor || anchor.label || anchor.mapQuery || anchor.area || anchor.city || '日常活动范围';
  return {
    city: block?.city || anchor.city || '',
    area: block?.anchor || anchor.area || '',
    placeName,
    activity: block?.activity || character?.currentStatus || '日常活动中',
    location: '',
    source: 'virtualMapFallback',
    confidence: 0.45,
    updatedAt: timestamp,
    expiresAt: timestamp + 2 * 60 * 60 * 1000,
  };
}

function browserPageModal(record) {
  if (!record) return '';
  const isForum = isForumBrowserRecord(record);
  const isWeibo = isWeiboBrowserRecord(record);
  const socialBlocked = isBlockedSocialEmbed(record.url);
  const canEmbed = /^https?:\/\//i.test(String(record.url || '')) && !isWeibo && !isForum && !socialBlocked;
  const platformId = detectLinkPlatform(record.url || '')?.id || '';
  const coverRaw = String(record.coverUrl || '').trim();
  const coverSrc = coverRaw ? displaySocialImageUrl(coverRaw, platformId) : '';
  const imageCount = Math.max(Number(record.imageCount || 0) || 0, coverSrc ? 1 : 0);
  const coverBadge = imageCount > 1 ? `<span class="cphone-record-cover-count">${esc(String(imageCount))} 图</span>` : '';
  const coverHtml = coverSrc
    ? `<div class="cphone-record-cover">${coverBadge}<img src="${esc(coverSrc)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" /></div>`
    : '';
  const body = String(record.body || record.summary || '')
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
  const query = plain(record.query || topicFromBrowserRecord(record), 80);
  const source = plain(record.sourceName || record.platform || (isWeibo ? '微博' : (isForum ? '站内论坛' : '网页')), 40);
  const searchLabel = isForum
    ? (record.forumSection ? `站内论坛 · ${plain(record.forumSection, 24)}` : '站内论坛')
    : (record.linkType === 'platform_search' || record.linkType === 'weibo_hot'
      ? `${source} · ${query ? `搜索 ${query}` : '搜索结果'}`
      : source);
  const chips = (Array.isArray(record.tags) ? record.tags : []).slice(0, 5).map((x) => `<span>${esc(x)}</span>`).join('');
  const fallbackBody = [
    record.summary || '',
    query ? `TA 留下这条记录时，重点看的不是泛泛关键词，而是「${query}」附近的具体讨论。` : '',
    record.url && !isWeibo && !isForum ? '外部网页可能拒绝嵌入，这里保留为手机里的阅读快照。' : '',
  ].filter(Boolean);
  const paragraphs = body.length ? body : fallbackBody;
  const kickerLabel = isWeibo ? '站内微博话题' : (isForum ? '站内论坛帖' : searchLabel);
  let actionHtml = '';
  if (isWeibo) {
    actionHtml = `<button type="button" class="btn btn-primary cphone-modal-link" data-open-weibo-topic="${esc(topicFromBrowserRecord(record))}">查看站内微博</button>`;
  } else if (isForum) {
    actionHtml = `<button type="button" class="btn btn-primary cphone-modal-link" data-open-forum-thread="${esc(record.id)}">进入站内论坛帖</button>`;
  } else if (record.url) {
    actionHtml = `<a class="btn btn-outline cphone-modal-link cphone-link-preview" href="${esc(record.url)}">站内预览</a>`;
  }
  return `
    <div class="cphone-modal cphone-web-modal" role="dialog" aria-modal="true">
      <div class="cphone-modal-card cphone-web-card">
        <button type="button" class="cphone-modal-close" data-close-record aria-label="关闭">×</button>
        <div class="cphone-web-chrome">
          <span></span><span></span><span></span>
          <div>${esc(searchLabel || '网页快照')}</div>
        </div>
        <article class="cphone-faux-web-page ${isWeibo ? 'is-weibo' : ''} ${isForum ? 'is-forum' : ''} ${socialBlocked ? 'is-social-snapshot' : ''}">
          ${coverHtml}
          ${canEmbed ? `
            <div class="cphone-web-frame-wrap">
              <iframe class="cphone-web-frame" src="${esc(record.url)}" title="${esc(record.title || '网页')}" loading="lazy" sandbox="allow-scripts allow-same-origin allow-forms allow-popups"></iframe>
            </div>` : ''}
          <header class="cphone-faux-web-header">
            <div class="cphone-record-kicker">${esc(kickerLabel)}</div>
            ${record.shareStatus === 'pending' ? '<span class="cphone-record-share-status is-pending">待分享</span>' : ''}
            ${record.shareStatus === 'shared' ? '<span class="cphone-record-share-status is-shared">已分享</span>' : ''}
            <h2>${esc(record.title || query || '网页记录')}</h2>
            ${record.summary ? `<p>${esc(record.summary)}${phoneTranslationSuffixHtml(record.summary, record.summaryTranslation || (!record.body ? record.translation : '') || '', { type: 'browser-summary', id: record.id })}</p>` : ''}
            ${chips ? `<div class="cphone-faux-web-tags">${chips}</div>` : ''}
          </header>
          <div class="cphone-faux-web-body">
            ${paragraphs.map((p) => `<p>${esc(p)}</p>`).join('')}
            ${record.body ? phoneTranslationSuffixHtml(record.body, record.translation || '', { type: 'browser', id: record.id }) : ''}
            ${record.aiJudgement ? `<p class="cphone-record-judgement">${esc(record.aiJudgement)}${phoneTranslationSuffixHtml(record.aiJudgement, record.aiJudgementTranslation || '', { type: 'browser-judgement', id: record.id })}</p>` : ''}
          </div>
          ${actionHtml}
        </article>
      </div>
    </div>`;
}

export function photoPreviewModal(preview, record = null, {
  generating = false,
  generatingRecordId = '',
} = {}) {
  if (!preview && !record) return '';
  const imageUrl = preview?.url || imageUrlFromRecord(record || {});
  const textImage = resolvePhotoTextImage(record || {}, preview);
  const canReroll = record ? photoRecordCanReroll(record) : !!preview?.canReroll;
  const recordId = String(record?.id || preview?.recordId || '').trim();
  const rerolling = generating && recordId === String(generatingRecordId || '');
  const body = imageUrl
    ? `<img src="${esc(imageUrl)}" alt="" />`
    : (textImage ? textImageDetailHtml({ type: 'textimg', content: textImage }, esc, { insCard: true }) : '<div class="cphone-empty">还没有可预览的图</div>');
  const fullText = resolvePhonePhotoFullText(record || {}, preview);
  const actionButtons = [
    '<button type="button" class="btn btn-soft btn-sm" data-close-photo>关闭</button>',
    imageUrl ? '<button type="button" class="btn btn-primary btn-sm" data-photo-save>保存</button>' : '',
    recordId && canReroll
      ? `<button type="button" class="btn btn-outline btn-sm" data-photo-reroll="${esc(recordId)}" ${generating ? 'disabled' : ''} ${rerolling ? 'aria-busy="true"' : ''}>${rerolling ? '正在重 roll…' : (generating ? '正在生成其他图片' : `${icon('reroll')} 重 roll`)}</button>`
      : '',
    rerolling ? '<button type="button" class="btn btn-ghost btn-sm" data-photo-reroll-cancel>取消</button>' : '',
  ].filter(Boolean).join('');
  const captionHtml = fullText && fullText !== textImage
    ? `<div class="cphone-photo-modal-caption">${esc(fullText)}${phoneTranslationSuffixHtml(fullText, record?.translation || '', { type: 'photo', id: recordId })}</div>`
    : '';
  return `
    <div class="cphone-modal cphone-photo-modal" role="dialog" aria-modal="true">
      <div class="cphone-modal-card cphone-photo-card">
        <button type="button" class="cphone-modal-close" data-close-photo aria-label="关闭">×</button>
        ${body}
        ${captionHtml}
        <div class="cphone-photo-modal-actions">${actionButtons}</div>
      </div>
    </div>`;
}

const PHONE_APPS = [
  { id: 'chat', label: 'Chat' },
  { id: 'browser', label: '浏览器' },
  { id: 'map', label: '地图' },
  { id: 'photos', label: '相册' },
  { id: 'calls', label: '通话' },
  { id: 'music', label: '音乐' },
  { id: 'interests', label: '兴趣' },
  { id: 'avatars', label: '头像库' },
  { id: 'memo', label: '备忘录' },
  { id: 'settings', label: '设置' },
];

// “他的手机”默认图标统一取自 Lucide（ISC），许可证见 /vendor/lucide/LICENSE。
const PHONE_APP_ICON_IDS = {
  schedule: 'calendar',
  chat: 'chat',
  browser: 'browser',
  map: 'map',
  photos: 'photos',
  calls: 'calls',
  music: 'music',
  interests: 'interests',
  avatars: 'avatars',
  memo: 'memo',
  settings: 'settings',
};

function phoneAppIconHtml(app, shell = {}) {
  const customIcon = String(shell?.appIcons?.[app?.id] || '').trim();
  const commercialIconId = PHONE_APP_ICON_IDS[app?.id] || 'settings';
  const defaultIcon = getCommercialHomeIcon(commercialIconId) || getIconSvg('settings');
  const iconLayers = renderHomeIconLayers(customIcon, defaultIcon, {
    className: 'cphone-custom-icon',
    escape: esc,
  });
  return `<span class="cphone-app-badge is-ios is-${esc(app?.id || 'settings')}${customIcon ? ' has-custom-icon' : ''}">${iconLayers}</span>`;
}

const PHONE_ALBUM_IMAGE_SELECTOR = [
  '.cphone-photo-thumb img',
  '.cphone-widget-photos img',
  '.cphone-photo-card img',
].join(', ');

/** Android WebView 回前台后偶发丢失 data URL 位图；重绑 src 让其重新解码。 */
function recoverBlankPhoneAlbumImages(root = document) {
  if (!root?.querySelectorAll) return;
  root.querySelectorAll(PHONE_ALBUM_IMAGE_SELECTOR).forEach((img) => {
    const src = String(img.getAttribute?.('src') || '').trim();
    if (!src || Number(img.naturalWidth || 0) > 0) return;
    img.setAttribute('src', src);
    if (typeof img.decode === 'function') img.decode().catch(() => {});
  });
}

function recoverBrokenPhoneAvatarImages(root = document) {
  if (!root?.querySelectorAll) return;
  root.querySelectorAll('.cphone-chat-avatar img, .cphone-chat-group-avatar img').forEach((img) => {
    if (img.dataset.avatarFallbackBound === '1') return;
    img.dataset.avatarFallbackBound = '1';
    const recover = () => {
      const frame = img.parentElement;
      if (!frame) return;
      const fallback = String(frame.getAttribute('data-avatar-fallback') || '?').trim() || '?';
      frame.classList.remove('has-image');
      frame.classList.add('is-letter');
      frame.textContent = fallback;
    };
    img.addEventListener('error', recover, { once: true });
    if (img.complete && Number(img.naturalWidth || 0) === 0) recover();
  });
}

function schedulePhoneAlbumImageRecovery(root = document) {
  const recover = () => recoverBlankPhoneAlbumImages(root);
  if (typeof window === 'undefined') return;
  if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(recover);
  window.setTimeout(recover, 280);
}

if (typeof window !== 'undefined') {
  window.addEventListener('marshmallow-app-foreground', () => {
    recoverBlankPhoneAlbumImages(document);
    window.setTimeout(() => recoverBlankPhoneAlbumImages(document), 280);
  });
}

/** 首帧骨架：数据到达前先画出手机页占位，避免路由「加载中」出现 */
function renderPhoneSkeleton(container) {
  container.innerHTML = `
    <div class="page-skeleton" aria-hidden="true">
      <div class="sk-row">
        <span class="sk-block sk-circle"></span>
        <span class="sk-block sk-bar" style="width:30%"></span>
      </div>
      <span class="sk-block" style="height:160px"></span>
      <div class="sk-grid">
        <span class="sk-block sk-tile"></span><span class="sk-block sk-tile"></span>
        <span class="sk-block sk-tile"></span><span class="sk-block sk-tile"></span>
        <span class="sk-block sk-tile"></span><span class="sk-block sk-tile"></span>
        <span class="sk-block sk-tile"></span><span class="sk-block sk-tile"></span>
      </div>
    </div>`;
}

export default async function render(container, params = {}) {
  const hasShell = !!container.querySelector('.cphone-scroll');
  if (!hasShell) renderPhoneSkeleton(container);
  const user = await ensureDefaultUser();
  const [all, groupConfig, loadedAutoSettings] = await Promise.all([
    listCharacters({ excludeAnonNpc: true, userId: user.id, identityScoped: true }),
    loadContactGroupsConfig().catch(() => ({ groups: [] })),
    loadCharacterPhoneAutoSettings(user.id),
  ]);
  const characters = (all || []).filter((c) => c && c.id);

  const initialSelection = resolveCharacterPhoneSelection(params.character, characters);
  let selectedId = initialSelection.selectedId;
  let unavailableRequestedId = initialSelection.unavailableRequestedId;
  // 从聊天设定进入时关机回该角色 chat；从选手机列表进入时关机回选手机页。
  const entryFrom = String(params.from || '').trim();
  const entryChatId = String(params.chatId || '').trim();
  let chooserQuery = '';

  let phone = null;
  let phoneAppearancePresets = [];
  let resolvedPhoneWallpaper = '';
  let resolvedPhoneWallpaperAssetId = null;
  let plan = null;
  let runtimeState = null;
  let liveState = null;
  let dateKey = '';
  let scheduleTimeZone = '';
  let autoSettings = loadedAutoSettings;
  let activitySessions = [];
  let chatPhotoRecords = [];
  let photoVisibleLimit = 24;
  let phoneMusicLibrary = { tracks: [], playlists: [] };
  let mapPreviewUrl = '';
  let nowTs = Date.now();
  let openRecordId = '';
  let photoPreview = null;
  let suppressPhotoClickUntil = 0;
  let pendingAvatarImport = null;
  let phoneChatRows = [];
  let phoneInterceptRows = [];
  let displayCharacters = [];
  /** 关系网轻量 NPC（lightnpc_*），消息列表标题/头像用；不在 characters 表 */
  let lightweightNpcRoster = [];
  let phoneSocialDirectory = createPhoneSocialActorDirectory();
  const PHONE_CHAT_SECTIONS = new Set(['messages', 'contacts', 'discover', 'intercept']);
  let phoneChatSection = PHONE_CHAT_SECTIONS.has(String(params.chatTab || '').trim())
    ? String(params.chatTab).trim()
    : 'messages';
  let phoneChatBusy = false;
  let phoneInterceptBusy = false;
  let lastPhoneLifeBatch = null;
  let lastPhoneInterceptBatch = null;
  let chatManageMode = false;
  const chatSelectedIds = new Set();
  const contactSelectedIds = new Set();
  let interceptRowClickSuppressUntil = 0;
  let phoneContactEditId = String(params.contact || '').trim();
  let phoneMoments = [];
  let phoneMomentsBusy = false;
  let phoneMomentStickerPool = [];
  const mergePhoneMomentRows = (rows = [], promotedRows = []) => {
    const merged = new Map((Array.isArray(rows) ? rows : [])
      .filter((post) => post?.id)
      .map((post) => [post.id, post]));
    for (const post of Array.isArray(promotedRows) ? promotedRows : []) {
      if (!post?.id) continue;
      merged.set(post.id, {
        ...post,
        userId: String(post.userId || post.ownerUserId || user.id),
      });
    }
    return [...merged.values()].sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0));
  };
  let phoneGeneration = {
    active: false,
    scope: '',
    message: '',
    controller: null,
  };
  let phoneChatAuto = { enabled: false, intervalMinutes: 120, dailyLimit: 6, allowUser: true, allowPeers: true, allowGroups: true, allowProactive: false };
  let phoneChatQuery = '';
  let autonomySettings = null;
  let proactiveUsage = null;
  let phoneContacts = { contacts: [], groups: [] };
  // 人设提取可能比切换手机更晚返回；令牌使旧角色的迟到结果不能占用新角色的确认框。
  let phoneContactOperationId = 0;
  let activeApp = [...PHONE_APPS, { id: 'schedule' }].some((app) => app.id === params.app) ? String(params.app) : 'home';
  let busy = false;
  let photoGenBusy = false;
  let photoGenRecordId = '';
  let lastPaintCtx = null;
  // App 软切换复用短时核心状态；角色时钟按经过的真实毫秒平滑前进，
  // 30 秒后再重新读取运行态与在线态，避免每点一个图标都串行查四份状态。
  let phoneCoreStateLoadedAt = 0;
  let phoneCoreClockSampledAt = 0;
  let phoneCoreStateCharacterId = '';
  let liveMapInstance = null;
  let liveMapToken = 0;
  let showProactiveStats = false;
  let chooserExpanded = !selectedId;
  let scheduleBusyLabel = '';
  let calendarSelectedDate = '';
  let rerollThemeDraft = '';
  let scheduleEventSettings = {
    eventNewsEnabled: false,
    eventSearchDailyLimit: EVENT_SEARCH_DAILY_LIMIT_DEFAULT,
    scheduleLanguageMode: 'chinese',
  };
  let recordSelectApp = '';
  const recordSelectedIds = new Set();
  let interestTable = [];
  let interestExpandedId = '';
  let interestGrowBusy = false;
  let interestReclassifyBusy = false;
  let menuCloseController = null;
  let interestTracking = {
    autoTrackEnabled: false,
    autoTrackIntervalHours: 12,
    autoTrackCandidatesPerRound: 2,
    sharePostSearchEnabled: false,
    shareDailyTarget: 1,
    shareEagerness: 'normal',
    avoidNotes: '',
    includeHotComments: false,
    socialSearchChannels: [...SOCIAL_SEARCH_CHANNELS],
    shareSearchChannels: [...SHARE_SEARCH_CHANNELS],
  };
  let shareImpulseSettings = { coldReplyHours: 6, shareIntervalHours: 48 };
  let interestRotationDebug = null;
  let interestRotationTestBusy = false;
  let interestChannelsAvailable = { web: false, xiaohongshu: false, weibo: false, bilibili: false };
  let manualSearchChannel = 'web';
  let manualSearchBusyId = '';
  let splitBusyId = '';
  let backstoryBusyId = '';
  let interestSetupBusy = false;
  let showUsageStats = false;
  let usageStatsSummary = null;
  let showMaterialPool = false;
  let materialPoolPosts = [];
  let sharePostKeyword = '';
  let sharePostIncludeComments = false;
  let sharePostBusy = false;
  let userSocialWatch = { enabled: false, profileInput: '', disclosureMode: 'secret', initialized: false, lastCheckedAt: 0, lastError: '' };
  let userSocialWatchPosts = [];
  let userSocialWatchProfileDraft = '';
  let userSocialWatchBusy = false;
  let showUserSocialPosts = false;
  let photoGenSelectApp = '';
  const photoGenSelectedIds = new Set();
  const pinnedKey = `characterPhonePinned:${user.id || 'guest'}`;
  const loadPinnedCharacters = () => {
    try {
      return new Set(JSON.parse(localStorage.getItem(pinnedKey) || '[]').map(String).filter(Boolean));
    } catch (_) {
      return new Set();
    }
  };
  let pinnedCharacters = loadPinnedCharacters();
  const hydratedHomeCharacters = new Set();
  const pendingHomeHydrationCharacters = new Set();
  const purgedPhoneUserImpersonatorCharacters = new Set();
  const savePinnedCharacters = () => {
    try { localStorage.setItem(pinnedKey, JSON.stringify([...pinnedCharacters])); } catch (_) {}
  };

  container.className = 'page scrapbook-page cphone-page';

  async function resolvePhoneWallpaper() {
    const shell = phone?.shellPreferences || {};
    const assetId = String(shell.wallpaperAssetId || '').trim();
    const fallback = String(shell.wallpaper || '').trim();
    if (!assetId) {
      resolvedPhoneWallpaperAssetId = '';
      resolvedPhoneWallpaper = fallback;
      return;
    }
    if (resolvedPhoneWallpaperAssetId === assetId) return;
    const asset = await db.getRecord('beautifyAssets', assetId).catch(() => null);
    const source = String(asset?.dataUrl || '').trim();
    resolvedPhoneWallpaperAssetId = assetId;
    resolvedPhoneWallpaper = /^(?:data:image\/|https:\/\/)/i.test(source) ? source : fallback;
  }

  function destroyLiveMap() {
    liveMapToken += 1;
    if (liveMapInstance && typeof liveMapInstance.destroy === 'function') {
      try {
        liveMapInstance.destroy();
      } catch (_) {}
    }
    liveMapInstance = null;
  }

  async function loadState(options = {}) {
    // soft: app switch / progress tick — keep shell data, only fetch what the active app needs.
    // Avoids re-scanning chat photos / trip sync on every icon tap (major APK lag source).
    const soft = options.soft === true && !!phone;
    if (!selectedId) {
      phone = null;
      phoneAppearancePresets = [];
      plan = null;
      runtimeState = null;
      liveState = null;
      scheduleTimeZone = '';
      activitySessions = [];
      chatPhotoRecords = [];
      phoneMusicLibrary = { tracks: [], playlists: [] };
      mapPreviewUrl = '';
      phoneChatRows = [];
      phoneInterceptRows = [];
      displayCharacters = [];
      phoneContacts = { contacts: [], groups: [] };
      lastPhoneLifeBatch = null;
      lastPhoneInterceptBatch = null;
      chatManageMode = false;
      chatSelectedIds.clear();
      contactSelectedIds.clear();
      phoneContactEditId = '';
      return;
    }
    const wallNow = Date.now();
    const reuseCoreState = soft
      && phoneCoreStateCharacterId === selectedId
      && phoneCoreStateLoadedAt > 0
      && wallNow - phoneCoreStateLoadedAt < 30_000;
    if (reuseCoreState) {
      const elapsed = Math.max(0, wallNow - (phoneCoreClockSampledAt || wallNow));
      nowTs = Number(nowTs || wallNow) + elapsed;
      phoneCoreClockSampledAt = wallNow;
      dateKey = dateKeyFromTimestamp(nowTs, scheduleTimeZone);
    } else {
      const [now, nextScheduleTimeZone] = await Promise.all([
        getNowForUser(user.id),
        resolveCharacterScheduleTimezone(user.id, selectedId, selectedCharacter()).catch(() => ''),
      ]);
      nowTs = now;
      scheduleTimeZone = nextScheduleTimeZone;
      dateKey = dateKeyFromTimestamp(now, scheduleTimeZone);
      [runtimeState, liveState] = await Promise.all([
        loadCharacterRuntimeState(user.id, selectedId, { now }).catch(() => null),
        loadCharacterLiveState(user.id, selectedId, { now, presenceNow: wallNow }).catch(() => null),
      ]);
      phoneCoreStateLoadedAt = wallNow;
      phoneCoreClockSampledAt = wallNow;
      phoneCoreStateCharacterId = selectedId;
    }
    const applyScheduleMapState = () => {
      plan = getDailyLifePlanForDate(phone, dateKey);
      const mapClearedAt = Number(phone?.mapGrowState?.userClearedMapAt || 0) || 0;
      if (mapClearedAt && Number(plan?.generatedAt || 0) <= mapClearedAt) return;
      const scheduleMapState = mapStateFromCurrentScheduleBlock(plan, nowTs, scheduleTimeZone);
      const scheduleRouteState = routeStateFromCurrentScheduleBlock(plan, nowTs, scheduleTimeZone);
      if (scheduleMapState || scheduleRouteState) {
        phone = {
          ...phone,
          currentMapState: scheduleMapState || phone.currentMapState || {},
          routeState: scheduleRouteState || phone.routeState || {},
        };
      }
    };
    if (!soft) {
      const loadedPhone = await loadCharacterPhone(user.id, selectedId);
      const reconciledPhone = applyElapsedScheduleMapVisits(loadedPhone, {
        timestamp: nowTs,
        timeZone: scheduleTimeZone,
      });
      if (reconciledPhone !== loadedPhone) await saveCharacterPhone(reconciledPhone);
      phone = (await pruneExpiredCharacterPhoneSchedules(user.id, selectedId, dateKey)).phone;
      applyScheduleMapState();
      if (activeApp === 'map' && !Object.values(phone?.currentMapState || {}).some(Boolean)) {
        phone = {
          ...phone,
          currentMapState: virtualMapStateFromContext({
            phone,
            plan,
            character: selectedCharacter() || {},
            timestamp: nowTs,
            timeZone: scheduleTimeZone,
          }),
        };
      }
      // 桌面首帧只依赖手机本体。过期会话整理、旅行同步、群绑定修复等都是
      // 维护任务，留到桌面出现后再做，避免用骨架屏承担整套数据保养。
      if (activeApp !== 'home') {
      await reconcileExpiredActivitySessions(user.id, nowTs).catch(() => {});
      activitySessions = (await listActivitySessions(user.id).catch(() => []))
        .filter((s) => (s.characterIds || []).includes(selectedId));
      const syncedTrips = await syncTravelCharTrips({ userId: user.id, characterId: selectedId }).catch(() => null);
      if (syncedTrips?.finished) {
        phone = (await pruneExpiredCharacterPhoneSchedules(user.id, selectedId, dateKey)).phone;
        applyScheduleMapState();
        if (activeApp === 'map') {
          mapPreviewUrl = await buildMapPreviewUrl(phone).catch(() => '');
        }
        showToast(`旅行char带回了 ${syncedTrips.finished} 个收集物`);
      }
      // Badge counts on home need chat rows; full enter always refreshes.
      await purgePhoneUserImpersonators({ user, ownerId: selectedId }).catch(() => {});
      phoneChatRows = await listCharacterPhoneChats(user.id, selectedId).catch(() => []);
      phoneContacts = await loadCharacterPhoneContacts(user.id, selectedId).catch(() => ({ contacts: [], groups: [] }));
      let repairedPhoneGroupBinding = false;
      for (const groupChat of phoneChatRows.filter((row) => row?.type === 'group')) {
        const synced = await syncPhoneContactGroupFromChat(user.id, groupChat, { ownerId: selectedId }).catch(() => null);
        if (!synced?.synced) continue;
        if (String(groupChat.metadata?.phoneContactGroupId || '') !== String(synced.groupId)
          || String(groupChat.metadata?.phoneOwnerId || '') !== String(synced.ownerId)) {
          groupChat.metadata = {
            ...(groupChat.metadata || {}),
            phoneContactGroupId: synced.groupId,
            phoneOwnerId: synced.ownerId,
          };
          await saveChat(groupChat);
          repairedPhoneGroupBinding = true;
        }
      }
      if (repairedPhoneGroupBinding) {
        phoneContacts = await loadCharacterPhoneContacts(user.id, selectedId).catch(() => phoneContacts);
      }
      phoneChatAuto = await loadPhoneChatAutoSettings(user.id, selectedId).catch(() => phoneChatAuto);
      lastPhoneLifeBatch = await loadLastPhoneLifeBatch(user.id, selectedId).catch(() => null);
      lastPhoneInterceptBatch = await loadLastPhoneInterceptBatch(user.id, selectedId).catch(() => null);
      }
    } else {
      applyScheduleMapState();
    }
    if (activeApp === 'map' && (!soft || !mapPreviewUrl)) {
      mapPreviewUrl = await buildMapPreviewUrl(phone).catch(() => '');
    }
    if (activeApp === 'browser') await loadLinkCardRuntime().catch(() => null);
    if (activeApp === 'photos') {
      await loadCardRenderRuntime().catch(() => null);
      chatPhotoRecords = await collectChatPhotoRecords(user.id, selectedId).catch(() => []);
    } else if (!soft) {
      chatPhotoRecords = [];
    }
    if (activeApp === 'chat') {
      if (soft && !purgedPhoneUserImpersonatorCharacters.has(selectedId)) {
        await purgePhoneUserImpersonators({ user, ownerId: selectedId }).catch(() => {});
        purgedPhoneUserImpersonatorCharacters.add(selectedId);
      }
      if (phoneChatSection === 'discover') await loadMomentsUiRuntime().catch(() => null);
      const needsInterceptData = phoneChatSection === 'intercept';
      const needsDiscoverData = phoneChatSection === 'discover';
      const needsDirectoryData = phoneChatSection === 'contacts';
      const [
        nextPhoneChatRows,
        nextPhoneContacts,
        legacyInterceptRows,
        sharedStrangerRows,
        nextPhoneMoments,
        nextPhoneMomentStickerPool,
        nextDisplayCharacters,
        nextLightweightNpcRoster,
        relationshipNet,
        contactGroupsConfig,
        acquaintanceLedger,
      ] = await Promise.all([
        soft ? listCharacterPhoneChats(user.id, selectedId).catch(() => phoneChatRows) : Promise.resolve(phoneChatRows),
        soft ? loadCharacterPhoneContacts(user.id, selectedId).catch(() => phoneContacts) : Promise.resolve(phoneContacts),
        needsInterceptData ? listCharacterPhoneInterceptChats(user.id, selectedId).catch(() => []) : Promise.resolve(phoneInterceptRows),
        needsInterceptData ? listStrangerThreadsForCharacter(user.id, selectedId).catch(() => []) : Promise.resolve([]),
        needsDiscoverData ? listCharacterPhoneMoments(user.id, selectedId).catch(() => []) : Promise.resolve(phoneMoments),
        needsDiscoverData ? loadFlatStickerPool().catch(() => []) : Promise.resolve(phoneMomentStickerPool),
        displayCharacters.length ? Promise.resolve(displayCharacters) : listCharacters({
          includeInternal: true,
          userId: user.id,
          identityScoped: true,
        }).catch(() => characters),
        lightweightNpcRoster.length ? Promise.resolve(lightweightNpcRoster) : listLightweightNpcs().catch(() => []),
        needsDirectoryData ? loadRelationshipNetwork().catch(() => null) : Promise.resolve(null),
        needsDirectoryData ? loadContactGroupsConfig().catch(() => ({ groups: [] })) : Promise.resolve({ groups: [] }),
        needsDirectoryData ? loadAcquaintanceLedger().catch(() => ({ entries: [] })) : Promise.resolve({ entries: [] }),
      ]);
      phoneChatRows = nextPhoneChatRows;
      phoneContacts = nextPhoneContacts;
      phoneInterceptRows = [...legacyInterceptRows, ...sharedStrangerRows]
        .filter((row, index, all) => all.findIndex((item) => item.id === row.id) === index)
        .sort((a, b) => {
          const aBlocked = isUserAliasBlockedByCharacter(a) ? 1 : 0;
          const bBlocked = isUserAliasBlockedByCharacter(b) ? 1 : 0;
          if (aBlocked !== bBlocked) return bBlocked - aBlocked;
          return Number(b.lastActivity || 0) - Number(a.lastActivity || 0);
        });
      // 生成或互动写入已经返回了事务提交后的完整记录。旧 WebView 的 userId 索引
      // 可能在这一拍仍漏掉新值，因此当前绘制必须把本批记录直接合并进来。
      phoneMoments = mergePhoneMomentRows(nextPhoneMoments, options.promotedMomentPosts);
      phoneMomentStickerPool = nextPhoneMomentStickerPool;
      // Need NPC characters for chat headers/avatars.
      displayCharacters = nextDisplayCharacters;
      // 幕后群/后台私聊里的 lightnpc_* 不在 characters 表，会话内靠 getLightweightNpc；
      // 消息列表也要并进 charMap，否则标题会直接露出原始 id。
      lightweightNpcRoster = nextLightweightNpcRoster;
      const owner = displayCharacters.find((row) => row.id === selectedId)
        || characters.find((row) => row.id === selectedId);
      if (needsDirectoryData) {
        phoneSocialDirectory = createPhoneSocialActorDirectory({
          ownerId: selectedId,
          characters: displayCharacters,
          relationshipNetwork: relationshipNet,
          contacts: phoneContacts.contacts || [],
          removedLinkedCharacterIds: phoneContacts.removedLinkedCharacterIds || [],
          removedLinkedActorIds: phoneContacts.removedLinkedActorIds || [],
          canUseCharacter: (candidate) => canPhoneCharactersKnowEachOther(
            owner,
            candidate,
            relationshipNet,
            contactGroupsConfig,
            acquaintanceLedger,
          ),
        });
        lightweightNpcRoster = [
          ...lightweightNpcRoster,
          ...phoneSocialDirectory.candidates
            .filter((actor) => actor.kind === 'relationship-npc')
            .map((actor) => ({
              id: actor.id,
              name: actor.name,
              realName: actor.name,
              avatar: actor.avatar || '',
              metadata: { isLightweightNpc: true, isRelationshipNpc: true },
              _lightweightNpc: true,
            })),
        ].filter((row, index, all) => all.findIndex((item) => item.id === row.id) === index);
      }
    } else if (activeApp === 'settings') {
      [phoneContacts, phoneChatAuto] = await Promise.all([
        loadCharacterPhoneContacts(user.id, selectedId).catch(() => phoneContacts),
        loadPhoneChatAutoSettings(user.id, selectedId).catch(() => phoneChatAuto),
      ]);
      phoneAppearancePresets = await loadPhoneAppearancePresets(user.id).catch(() => phoneAppearancePresets);
      if (phone?.shellPreferences?.appearancePresets?.length) {
        phone = {
          ...phone,
          shellPreferences: {
            ...(phone.shellPreferences || {}),
            appearancePresets: [],
          },
        };
      }
      // 设置页联系人头像也要以角色卡为准，避免仍吃添加时的旧快照。
      displayCharacters = await listCharacters({
        includeInternal: true,
        userId: user.id,
        identityScoped: true,
      }).catch(() => characters);
      const [relationshipNet, contactGroupsConfig, acquaintanceLedger] = await Promise.all([
        loadRelationshipNetwork().catch(() => null),
        loadContactGroupsConfig().catch(() => ({ groups: [] })),
        loadAcquaintanceLedger().catch(() => ({ entries: [] })),
      ]);
      const owner = displayCharacters.find((row) => row.id === selectedId)
        || characters.find((row) => row.id === selectedId);
      phoneSocialDirectory = createPhoneSocialActorDirectory({
        ownerId: selectedId,
        characters: displayCharacters,
        relationshipNetwork: relationshipNet,
        contacts: phoneContacts.contacts || [],
        removedLinkedCharacterIds: phoneContacts.removedLinkedCharacterIds || [],
        removedLinkedActorIds: phoneContacts.removedLinkedActorIds || [],
        canUseCharacter: (candidate) => canPhoneCharactersKnowEachOther(
          owner,
          candidate,
          relationshipNet,
          contactGroupsConfig,
          acquaintanceLedger,
        ),
      });
      autonomySettings = await loadCharacterAutonomySettings(user.id, selectedId, {
        phone,
        chats: await listChatsForUser(user.id).catch(() => []),
        dailyScheduleEnabled: isDailyLifeAutoEnabled(autoSettings, selectedId),
        references: {
          interestEnabled: interestTracking.autoTrackEnabled === true,
          shareEnabled: interestTracking.sharePostSearchEnabled === true,
        },
      }).catch(() => autonomySettings);
      proactiveUsage = await getCharacterProactiveUsageStatus(user.id, selectedId, nowTs).catch(() => proactiveUsage);
    } else if (!soft) {
      phoneInterceptRows = [];
      phoneMoments = [];
    }
    // 桌面的最近听歌卡片已自带歌名/歌手，不需要为了补一张封面读取整个音乐库。
    // musicTracks 含本地 audioBlob，大音频库的整表克隆会直接占满 WebView 内存并拖慢路由。
    if (activeApp === 'music') {
      if (!soft || !(phoneMusicLibrary?.tracks?.length || phoneMusicLibrary?.playlists?.length)) {
        phoneMusicLibrary = await loadMusicLibrary().catch(() => ({ tracks: [], playlists: [] }));
      }
    } else if (!soft && activeApp !== 'home') {
      phoneMusicLibrary = { tracks: [], playlists: [] };
    }
    if (activeApp === 'interests' || activeApp === 'settings') {
      await syncInterestProgressFromSchedule({
        userId: user.id,
        characterId: selectedId,
        phone,
        now: nowTs,
        timeZone: scheduleTimeZone,
      }).catch(() => {});
      interestTable = await listInterestEntries(user.id, selectedId).catch(() => []);
      interestTracking = await loadInterestTrackingSettings(user.id, selectedId).catch(() => interestTracking);
      sharePostIncludeComments = interestTracking.includeHotComments === true;
      shareImpulseSettings = await loadShareImpulseSettings(user.id, selectedId).catch(() => shareImpulseSettings);
      interestRotationDebug = await getInterestRotationDebugStatus().catch(() => null);
      const webCfg = await loadWebSearchConfig().catch(() => null);
      const socialCfg = await loadSocialLinkConfig().catch(() => null);
      {
        const socialOk = !!(socialCfg?.enabled && socialCfg?.apiKey);
        interestChannelsAvailable = {
          web: !!webCfg?.enabled,
          xiaohongshu: socialOk,
          weibo: socialOk,
          bilibili: socialOk,
        };
      }
      if (!interestChannelsAvailable.web && interestChannelsAvailable.xiaohongshu) manualSearchChannel = 'xiaohongshu';
      // 分享渠道多选已持久化；不可用的渠道只是灰掉/不展示，不再强行改回网页
      userSocialWatch = await loadUserSocialWatchSettings(user.id, selectedId).catch(() => userSocialWatch);
      userSocialWatchProfileDraft = userSocialWatch.profileInput;
      userSocialWatchPosts = await listUserSocialPosts(user.id, selectedId).catch(() => []);
    } else if (!soft) {
      interestTable = [];
    }
    if (activeApp === 'schedule' || activeApp === 'settings') {
      scheduleEventSettings = await loadScheduleEventSettings(user.id, selectedId).catch(() => scheduleEventSettings);
    }
    await resolvePhoneWallpaper();
  }

  function scheduleHomeHydration() {
    const targetId = String(selectedId || '').trim();
    if (!targetId || activeApp !== 'home'
      || hydratedHomeCharacters.has(targetId)
      || pendingHomeHydrationCharacters.has(targetId)) return;
    pendingHomeHydrationCharacters.add(targetId);

    const hydrate = async () => {
      if (selectedId !== targetId || activeApp !== 'home') {
        pendingHomeHydrationCharacters.delete(targetId);
        return;
      }
      try {
        await reconcileExpiredActivitySessions(user.id, nowTs).catch(() => {});
        const [
          allSessions,
          syncedTrips,
          nextPhoneChatRows,
          nextPhoneContacts,
          nextDisplayCharacters,
          nextLightweightNpcRoster,
        ] = await Promise.all([
          listActivitySessions(user.id).catch(() => []),
          syncTravelCharTrips({ userId: user.id, characterId: targetId }).catch(() => null),
          listCharacterPhoneBadgeChats(user.id, targetId).catch(() => phoneChatRows),
          loadCharacterPhoneContacts(user.id, targetId).catch(() => phoneContacts),
          listCharacters({
            includeInternal: true,
            userId: user.id,
            identityScoped: true,
          }).catch(() => displayCharacters),
          listLightweightNpcs().catch(() => lightweightNpcRoster),
        ]);

        if (selectedId !== targetId) return;
        phoneChatRows = nextPhoneChatRows;
        phoneContacts = nextPhoneContacts;
        displayCharacters = nextDisplayCharacters;
        lightweightNpcRoster = nextLightweightNpcRoster;
        activitySessions = (allSessions || []).filter((session) => (
          (session.characterIds || []).includes(targetId)
        ));
        if (syncedTrips?.finished) {
          phone = (await pruneExpiredCharacterPhoneSchedules(user.id, targetId, dateKey)).phone;
          plan = getDailyLifePlanForDate(phone, dateKey);
          showToast(`旅行char带回了 ${syncedTrips.finished} 个收集物`);
        }
        hydratedHomeCharacters.add(targetId);
        if (activeApp === 'home') await paint({ soft: true, showLoading: false });
      } finally {
        pendingHomeHydrationCharacters.delete(targetId);
      }
    };

    const run = () => {
      if (!container.isConnected || selectedId !== targetId || activeApp !== 'home') {
        pendingHomeHydrationCharacters.delete(targetId);
        return;
      }
      const activity = globalThis.__mm_update_safety_state__ || {};
      const recentlyActive = Date.now() - Number(activity.lastInteractionAt || 0) < 2500;
      if (document.hidden || recentlyActive || Number(activity.criticalCount || 0) > 0) {
        window.setTimeout(run, 1500);
        return;
      }
      void hydrate().catch(() => {});
    };
    // 壁纸与桌面先稳定，再做一轮只读角标快照；RIC timeout 真触发时 run 仍会二次避让。
    window.setTimeout(() => {
      if (typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(run, { timeout: 2500 });
      } else {
        run();
      }
    }, 800);
  }

  async function collectChatPhotoRecords(userId, characterId) {
    const chats = (await listChatsForUser(userId)).filter((chat) => (
      Array.isArray(chat?.participants) && chat.participants.includes(characterId)
    ));
    const out = [];
    for (const chat of chats.slice(0, 12)) {
      const messages = await listMessagesForChat(chat.id, 180).catch(() => []);
      for (const msg of messages) {
        if (!msg || msg.type !== 'image' || msg.deleted || msg.recalled || msg.metadata?.generationFailed) continue;
        const url = String(msg.content || msg.metadata?.url || msg.metadata?.imageUrl || '').trim();
        if (!url) continue;
        const fromCharacter = String(msg.senderId || '') === characterId;
        out.push({
          id: `chatimg_${msg.id}`,
          title: msg.metadata?.caption || msg.metadata?.text || (fromCharacter ? 'TA 发来的图片' : '聊天图片'),
          caption: msg.metadata?.caption || msg.metadata?.text || '',
          imageUrl: url,
          sourceName: fromCharacter ? '聊天 · TA' : '聊天',
          timestamp: msg.timestamp,
          createdAt: msg.timestamp,
        });
      }
    }
    return out.sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0)).slice(0, 36);
  }

  function selectedCharacter() {
    return characters.find((c) => c.id === selectedId) || null;
  }

  function characterSearchText(c = {}) {
    return [
      c.name,
      c.realName,
      c.customNickname,
      c.currentRole,
      c.currentStatus,
      ...(Array.isArray(c.aliases) ? c.aliases : []),
    ].filter(Boolean).join(' ').toLowerCase();
  }

  function phoneCharacterButton(c) {
    const name = c.customNickname || c.name || '角色';
    const meta = [c.currentRole, c.currentStatus].filter(Boolean).join(' · ');
    const pinned = pinnedCharacters.has(c.id);
    return `
      <div class="cphone-char-row ${c.id === selectedId ? 'is-active' : ''} ${pinned ? 'is-pinned' : ''}">
        <button type="button" class="cphone-char" data-char="${esc(c.id)}">
          ${characterAvatarHtml(c, { className: 'cphone-char-avatar' })}
          <span class="cphone-char-main">
            <span class="cphone-char-name">${esc(name)}</span>
            ${meta ? `<span class="cphone-char-meta">${esc(meta)}</span>` : ''}
          </span>
        </button>
        <button type="button" class="cphone-char-pin ${pinned ? 'is-on' : ''}" data-pin-char="${esc(c.id)}" aria-label="${pinned ? '取消置顶' : '置顶角色'}">${icon('pin')}</button>
      </div>
    `;
  }

  function chooserHtml({ compact = false } = {}) {
    if (!characters.length) {
      return '<div class="cphone-no-char">还没有角色，先去通讯录创建一个吧。</div>';
    }
    const current = selectedCharacter();
    if (compact && current && !chooserExpanded) {
      const name = current.customNickname || current.name || '角色';
      const meta = [current.currentRole, current.currentStatus].filter(Boolean).join(' · ');
      return `
        <div class="cphone-chooser is-collapsed">
          <button type="button" class="cphone-current-char" data-toggle-chooser>
            ${characterAvatarHtml(current, { className: 'cphone-char-avatar' })}
            <span class="cphone-char-main">
              <span class="cphone-char-name">${esc(name)}</span>
              ${meta ? `<span class="cphone-char-meta">${esc(meta)}</span>` : '<span class="cphone-char-meta">当前手机</span>'}
            </span>
            <span class="cphone-current-switch">切换</span>
          </button>
        </div>`;
    }
    const q = chooserQuery.trim().toLowerCase();
    const source = q ? characters.filter((c) => characterSearchText(c).includes(q)) : characters;
    const groups = Array.isArray(groupConfig?.groups) && groupConfig.groups.length
      ? groupConfig.groups
      : [{ id: 'default', name: '默认' }];
    const sections = [];
    if (q) {
      sections.push(`
        <div class="cphone-chooser-section">
          <div class="cphone-chooser-section-title">搜索结果 · ${source.length}</div>
          <div class="cphone-char-list">${source.map(phoneCharacterButton).join('') || '<div class="cphone-empty-note">没有匹配的角色</div>'}</div>
        </div>
      `);
    } else {
      for (const group of groups) {
        const members = source
          .filter((c) => resolveCharacterGroupId(c) === group.id)
          .sort((a, b) => {
            const pa = pinnedCharacters.has(a.id) ? 1 : 0;
            const pb = pinnedCharacters.has(b.id) ? 1 : 0;
            if (pa !== pb) return pb - pa;
            return String(a.customNickname || a.name || '').localeCompare(String(b.customNickname || b.name || ''), 'zh');
          });
        if (!members.length) continue;
        sections.push(`
          <div class="cphone-chooser-section">
            <div class="cphone-chooser-section-title">${esc(group.name || '默认')} · ${members.length}</div>
            <div class="cphone-char-list">${members.map(phoneCharacterButton).join('')}</div>
          </div>
        `);
      }
    }
    return `
      <div class="cphone-chooser ${compact ? 'is-compact' : ''}">
        ${compact && current ? `
          <button type="button" class="cphone-chooser-collapse" data-toggle-chooser>收起角色列表</button>
        ` : ''}
        <label class="cphone-character-search">
          <button type="button" class="search-icon-submit" data-chooser-search-submit aria-label="搜索">${icon('search')}</button>
          <input type="search" class="cphone-character-search-input" placeholder="搜索角色名 / 别名，回车搜索" value="${esc(chooserQuery)}" autocomplete="off">
          ${chooserQuery ? '<button type="button" class="cphone-character-search-clear" aria-label="清空">×</button>' : ''}
        </label>
        <div class="cphone-chooser-sections">
          ${sections.join('') || '<div class="cphone-empty-note">没有可显示的角色</div>'}
        </div>
      </div>`;
  }

  function appCount(appId) {
    if (!phone) return 0;
    if (appId === 'schedule') return (plan?.blocks || []).length;
    if (appId === 'chat') return phoneChatRows.length;
    if (appId === 'browser') return (phone.browserRecords || []).length;
    if (appId === 'map') return (phone.mapPins || []).filter((pin) => !isMapCandidate(pin)).length + (phone.mapItineraries || []).length;
    if (appId === 'photos') return (phone.photoRecords || []).length;
    if (appId === 'calls') return (phone.callRecords || []).length;
    if (appId === 'music') return (phone.musicRecords || []).length;
    if (appId === 'interests') return (phone.interestRecords || []).length;
    if (appId === 'avatars') return (phone.avatarLibrary || []).length;
    if (appId === 'memo') return (phone.notes || []).filter((n) => !n.completed).length;
    return 0;
  }

  function appUnreadCount(appId) {
    if (appId === 'chat') {
      const seenAt = Number(phone?.appReadState?.chat?.seenAt || 0);
      return phoneChatRows.filter((chat) => Number(chat.lastActivity || 0) > seenAt).length;
    }
    const total = appCount(appId);
    if (!total) return 0;
    const read = phone?.appReadState && typeof phone.appReadState === 'object'
      ? phone.appReadState[appId]
      : null;
    const seen = Math.max(0, Math.floor(Number(read?.count || 0) || 0));
    return Math.max(0, total - seen);
  }

  async function markAppRead(appId) {
    const id = String(appId || '').trim();
    if (!id || id === 'home' || !phone?.characterId) return;
    const total = appCount(id);
    const current = phone.appReadState && typeof phone.appReadState === 'object'
      ? phone.appReadState[id]
      : null;
    const seen = Math.max(0, Math.floor(Number(current?.count || 0) || 0));
    const latestChatAt = id === 'chat'
      ? Math.max(0, ...phoneChatRows.map((chat) => Number(chat.lastActivity || 0)))
      : 0;
    if (id === 'chat' ? Number(current?.seenAt || 0) >= latestChatAt : seen === total) return;
    phone = await saveCharacterPhone({
      ...phone,
      appReadState: {
        ...(phone.appReadState || {}),
        [id]: {
          count: total,
          seenAt: resolvePhoneAppSeenAt(latestChatAt),
        },
      },
    });
  }

  function phoneDesktopHtml({
    name,
    character,
    currentBlock,
    effectiveState,
    plan: currentPlan,
  }) {
    const now = new Date(nowTs);
    const dateLabel = now.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' });
    const shell = phone?.shellPreferences || {};
    const dockIds = new Set(Array.isArray(shell.dock)
      ? shell.dock
      : ['chat', 'calls', 'browser', 'settings']);
    // 空数组代表用户明确关闭全部组件，不能再回退到默认组件。
    const widgetIds = new Set(Array.isArray(shell.widgets)
      ? shell.widgets
      : ['calendar', 'music', 'photos', 'status']);
    const desktopApps = [
      { id: 'schedule', label: '日历', bg: 'bg-cream' },
      ...PHONE_APPS,
    ].filter((app) => !dockIds.has(app.id));
    const dockApps = [...dockIds]
      .map((id) => PHONE_APPS.find((app) => app.id === id))
      .filter(Boolean);
    const recentMusic = resolvePhoneMusicRecord((phone?.musicRecords || [])[0], phoneMusicLibrary);
    const recentMusicMeta = [recentMusic.artist, recentMusic.album].filter(Boolean).join(' · ');
    const recentPhotos = (phone?.photoRecords || []).filter((item) => (
      !!imageUrlFromRecord(item)
      || (item?.imageKind === 'textimg' && !!String(item?.textImageCaption || '').trim())
    )).slice(0, 3);
    const nowMinute = minutesOfDayFromTimestamp(nowTs, scheduleTimeZone);
    const scheduleBlocks = (Array.isArray(currentPlan?.blocks) ? currentPlan.blocks : [])
      .filter((block) => !['changed', 'cancelled', 'skipped'].includes(String(block?.status || 'planned')))
      .map((block) => ({ block, start: parseTimeRangeStartMinutes(block?.timeRange) }))
      .filter((item) => item.start >= 0)
      .sort((a, b) => a.start - b.start);
    const currentIndex = scheduleBlocks.findIndex((item) => item.block?.id && item.block.id === currentBlock?.id);
    const nextSchedule = currentIndex >= 0
      ? scheduleBlocks[currentIndex + 1]
      : scheduleBlocks.find((item) => item.start > nowMinute);
    const nextBlock = nextSchedule?.block || null;
    const nextTime = String(nextBlock?.timeRange || '').match(/\d{1,2}:\d{2}/)?.[0] || '';
    const currentActivity = effectiveState?.activity || currentBlock?.activity || '暂时空闲';
    const currentMeta = effectiveState?.scheduleOverridden
      ? '实时状态'
      : (currentBlock?.timeRange || currentPlan?.mood || '今天没有正在进行的安排');
    return `
      <section class="cphone-home-screen">
        <div class="cphone-home-head">
          <button type="button" class="cphone-power-off" data-phone-power-off aria-label="关闭手机">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v9" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><path d="M7.2 6.4a7 7 0 1 0 9.6 0" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>
          </button>
          <div class="cphone-home-identity">
            ${characterAvatarHtml(character || {}, { className: 'cphone-home-owner-avatar' })}
            <span><b>${esc(name)} 的手机</b><small>${esc(dateLabel)}</small></span>
          </div>
          <details class="cphone-more-menu">
            <summary aria-label="手机菜单">•••</summary>
            <div class="cphone-more-popover">
              <button type="button" class="cphone-go-space">TA 的空间</button>
              <button type="button" class="cphone-gen-records">补充手机记录</button>
              <button type="button" data-app="settings">手机设置</button>
              <button type="button" data-phone-power-off>关闭手机</button>
            </div>
          </details>
        </div>

        <div class="cphone-home-content">
        <div class="cphone-widget-grid ${widgetIds.size ? '' : 'is-empty'}">
          ${widgetIds.has('status') ? `
          <button type="button" class="cphone-widget cphone-widget-calendar cphone-widget-agenda is-now" data-app="schedule">
            <span class="cphone-agenda-item">
              <small>此刻</small><strong>${esc(currentActivity)}</strong><em>${esc(currentMeta)}</em>
            </span>
          </button>` : ''}
          ${widgetIds.has('calendar') ? `
          <button type="button" class="cphone-widget cphone-widget-calendar cphone-widget-agenda is-next" data-app="schedule">
            <span class="cphone-agenda-item">
              <small>接下来${nextTime ? ` · ${esc(nextTime)}` : ''}</small><strong>${esc(nextBlock?.activity || '今天没有后续安排')}</strong><em>${esc(nextBlock?.placeName || nextBlock?.anchor || currentPlan?.dayTheme || '打开日程查看')}</em>
            </span>
          </button>` : ''}
          ${widgetIds.has('music') ? `
          <section class="cphone-widget cphone-widget-music">
            <span class="cphone-widget-label">正在听</span>
            <div class="cphone-widget-music-body">
              ${phoneMusicCoverHtml(recentMusic, { compact: true })}
              <button type="button" class="cphone-widget-music-main" data-phone-music-search="${esc(recentMusic.query)}" ${recentMusic.query ? `aria-label="在网易云搜索并播放《${esc(recentMusic.title)}》"` : 'aria-label="打开音乐页搜索歌曲"'}>
                <strong>${esc(recentMusic.title || '还没有播放记录')}</strong>
                ${recentMusicMeta ? `<em>${esc(recentMusicMeta)}</em>` : ''}
              </button>
            </div>
            <button type="button" class="cphone-music-controls" data-phone-music-search="${esc(recentMusic.query)}" aria-label="${recentMusic.query ? `搜索《${esc(recentMusic.title)}》` : '打开音乐页'}">${recentMusic.query ? '搜索' : '打开'}</button>
          </section>` : ''}
          ${widgetIds.has('photos') ? `
          <button type="button" class="cphone-widget cphone-widget-photos${phone?.shellPreferences?.photosCover ? ' has-cover' : ` photo-count-${recentPhotos.length}`}" data-app="photos">
            ${phone?.shellPreferences?.photosCover
              ? `<img src="${esc(phone.shellPreferences.photosCover)}" alt="">`
              : (recentPhotos.length
                ? recentPhotos.map((item) => photoThumbInnerHtml(item)).join('')
                : '<span class="cphone-photo-placeholder">相册</span>')}
          </button>` : ''}
        </div>

        <div class="cphone-app-grid">
          ${desktopApps.map((app) => {
            const unread = appUnreadCount(app.id);
            return `
              <button type="button" class="cphone-phone-app" data-app="${esc(app.id)}">
                ${phoneAppIconHtml(app, shell)}
                <b>${esc(app.label)}</b>
                ${unread ? `<em>${unread}</em>` : ''}
              </button>
            `;
          }).join('')}
        </div>
        <nav class="cphone-dock" aria-label="常用应用">
          ${dockApps.map((app) => {
            const unread = appUnreadCount(app.id);
            return `<button type="button" class="cphone-phone-app" data-app="${esc(app.id)}" aria-label="${esc(app.label)}">
              ${phoneAppIconHtml(app, shell)}
              ${unread ? `<em>${unread}</em>` : ''}
            </button>`;
          }).join('')}
        </nav>
        </div>
      </section>`;
  }

  function subPageShell(title, inner, {
    actions = '',
    primaryAction = '',
    selecting = false,
    bodyClass = '',
    imeScroll = false,
  } = {}) {
    return `
      <section class="cphone-subpage${selecting ? ' is-record-selecting' : ''}">
        <div class="cphone-subpage-head">
          <button type="button" class="cphone-phone-home" aria-label="返回手机桌面">‹</button>
          <div class="cphone-subpage-title">${esc(title)}</div>
          ${primaryAction || actions ? `<div class="cphone-subpage-head-actions">${primaryAction}${actions ? `<details class="cphone-more-menu cphone-app-more"><summary aria-label="更多操作">•••</summary><div class="cphone-more-popover">${actions}</div></details>` : ''}</div>` : '<span class="cphone-subpage-spacer"></span>'}
        </div>
        <div class="cphone-subpage-body${bodyClass ? ` ${esc(bodyClass)}` : ''}"${imeScroll ? ' data-ime-scroll-region' : ''}>${inner}</div>
      </section>`;
  }

  function scheduleAppHtml({
    name,
    currentBlock,
    currentStep,
    effectiveState,
    autoOn,
    proactive,
    canVisitNow,
    resumableSession,
  }) {
    const offlineReady = canVisitNow || !!resumableSession;
    const offlineLabel = resumableSession ? '继续线下探索' : '去找TA · 进入线下';
    const dateParts = String(dateKey || '').split('-').map(Number);
    const calendarYear = dateParts[0] || new Date(nowTs).getFullYear();
    const calendarMonth = (dateParts[1] || (new Date(nowTs).getMonth() + 1)) - 1;
    const firstWeekday = new Date(calendarYear, calendarMonth, 1).getDay();
    const daysInMonth = new Date(calendarYear, calendarMonth + 1, 0).getDate();
    const calendarDateKeys = new Set([
      ...(phone?.dailyLifePlans || []).map((item) => String(item?.dateKey || '')),
      ...(phone?.offlineScheduleOverrides || []).map((item) => String(item?.dateKey || '')),
    ].filter(Boolean));
    const calendarPlans = new Map(
      [...calendarDateKeys]
        .map((key) => [key, getDailyLifePlanForDate(phone, key)])
        .filter(([, dayPlan]) => dayPlan?.blocks?.length),
    );
    const viewedDateKey = calendarSelectedDate || dateKey;
    const viewedPlan = calendarPlans.get(viewedDateKey) || (viewedDateKey === dateKey ? plan : null);
    const viewingToday = viewedDateKey === dateKey;
    const rerollThemePlaceholder = viewedPlan
      ? '重roll时指定主题，比如：陪妈妈逛街 / 在家赶稿（留空则不限定）'
      : (viewingToday
        ? '想让今天发生什么，比如：请假在家躺一天（留空则不限定）'
        : '想让这天发生什么（留空则不限定）');
    const generateDayLabel = viewedPlan
      ? (viewingToday ? '重新生成今日' : '重新生成这天')
      : (viewingToday ? '生成今日' : '生成这天');
    const monthCells = [
      ...Array.from({ length: firstWeekday }, () => ''),
      ...Array.from({ length: daysInMonth }, (_, index) => String(index + 1)),
    ];
    const body = `
      <section class="cphone-today cphone-today-plain">
        <div class="cphone-today-ribbon">今日 · ${esc(dateKey)}${scheduleTimeZone ? ` · TA 当地 ${esc(formatClockInTimezone(nowTs, scheduleTimeZone) || '')}` : ''}</div>
        <div class="cphone-today-head">
          <div>
            <div class="cphone-today-name">${esc(name)} 的日程</div>
            ${plan ? `
              <div class="cphone-today-tags">
                <span>${esc(dayTypeLabel(plan.dayType))}</span>
                <span>原计划 · 可覆盖</span>
                ${plan.mood ? `<span>${esc(plan.mood)}${phoneTranslationSuffixHtml(plan.mood, plan.moodTranslation || '', { type: 'schedule-mood', id: plan.dateKey || dateKey, label: '译心情' })}</span>` : ''}
              </div>
              ${plan.dayTheme ? `<div class="cphone-today-theme">${esc(plan.dayTheme)}${phoneTranslationSuffixHtml(plan.dayTheme, plan.dayThemeTranslation || '', { type: 'schedule-theme', id: plan.dateKey || dateKey, label: '译主题' })}</div>` : ''}
            ` : '<div class="cphone-today-empty">还没有今日骨架</div>'}
          </div>
        </div>
        <p class="cphone-schedule-reference-note">日程仅供参考，会随聊天推进、线下经历与实时状态调整。</p>
        ${effectiveState?.scheduleOverridden ? `
          <div class="cphone-live-override" role="status">
            <span>此刻 · 实时状态</span>
            <strong>${esc(effectiveState.activity)}</strong>
            <em>暂时覆盖下方原计划</em>
          </div>
        ` : ''}
        ${currentBlock ? `
          <div class="cphone-now-label">${effectiveState?.scheduleOverridden ? '原计划' : '此刻计划'}</div>
          ${blockHtml(currentBlock, { current: true, currentStep, tappable: canVisitNow })}
        ` : ''}
        ${offlineReady ? `
          <button type="button" class="btn btn-primary btn-block cphone-start-activity cphone-start-activity-hero">${esc(offlineLabel)} ›</button>
        ` : ''}
      </section>
      ${scheduleAutomationControlsHtml({
        autoOn,
        proactive,
        hasTodayPlan: !!plan?.blocks?.length,
      })}
      <section class="cphone-calendar-card">
        <header><strong>${calendarYear}年${calendarMonth + 1}月</strong><span>${esc(viewedDateKey)}</span></header>
        <div class="cphone-calendar-week">${'日一二三四五六'.split('').map((item) => `<span>${item}</span>`).join('')}</div>
        <div class="cphone-calendar-month">
          ${monthCells.map((day) => {
            if (!day) return '<span class="is-blank"></span>';
            const key = `${calendarYear}-${String(calendarMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
            return `<button type="button" data-phone-calendar-date="${key}" class="${key === dateKey ? 'is-today' : ''} ${key === viewedDateKey ? 'is-selected' : ''}"><b>${day}</b>${calendarPlans.has(key) ? '<i></i>' : ''}</button>`;
          }).join('')}
        </div>
      </section>
      <div class="cphone-section-head">
        <div class="cphone-section-title">${viewedDateKey === dateKey ? '今日日程' : `${Number(viewedDateKey.slice(5, 7))}月${Number(viewedDateKey.slice(8, 10))}日`}</div>
      </div>
      ${viewedPlan?.blocks?.length
        ? `<div class="cphone-timeline">${viewedPlan.blocks.map((b) => blockHtml(b, {
          current: viewedDateKey === dateKey && b.id === currentBlock?.id,
          currentStep: viewedDateKey === dateKey && b.id === currentBlock?.id ? currentStep : null,
        })).join('')}</div>`
        : '<div class="cphone-empty">这天还没有日程</div>'}
      ${activityCardsHtml(activitySessions, nowTs)}
      <section class="cphone-actions cphone-actions-flat">
        <div class="cphone-reroll-theme-row">
          <input type="text" class="form-input cphone-reroll-theme-input" maxlength="60" placeholder="${esc(rerollThemePlaceholder)}" value="${esc(rerollThemeDraft)}" autocomplete="off" enterkeyhint="done" />
        </div>
        <div class="cphone-action-row">
          <button type="button" class="btn btn-primary cphone-gen-day" ${busy ? 'disabled' : ''}>${scheduleBusyLabel || generateDayLabel}</button>
          <button type="button" class="btn btn-outline cphone-gen-week" ${busy ? 'disabled' : ''}>${scheduleBusyLabel ? '请稍等' : '生成本周'}</button>
          <button type="button" class="btn btn-outline cphone-clear-schedule" ${phone?.dailyLifePlans?.length ? '' : 'disabled'}>清空日程</button>
        </div>
        ${(() => {
          const targetPlan = viewedPlan || plan;
          const showTranslate = !!targetPlan?.blocks?.length && (
            scheduleEventSettings.scheduleLanguageMode === SCHEDULE_LANGUAGE_FOLLOW_CHARACTER
            || dailyLifePlanNeedsTranslation(targetPlan)
          );
          if (!showTranslate) return '';
          return `<button type="button" class="btn btn-outline cphone-translate-schedule" data-schedule-translate-date="${esc(viewedDateKey)}" ${busy ? 'disabled' : ''}>翻译日程</button>`;
        })()}
        ${scheduleBusyLabel ? `<div class="cphone-generating-panel"><span></span><strong>${esc(scheduleBusyLabel)}</strong><em>正在请求模型，完成后会自动刷新；可离开本页，完成时会尽量提醒。</em></div>` : ''}
        <button type="button" class="btn btn-outline cphone-change-plan" ${busy || !currentBlock ? 'disabled' : ''}>${scheduleBusyLabel && /校准行程/.test(scheduleBusyLabel) ? '校准中…' : '按当前事实校准'}</button>
        ${!currentBlock && plan?.blocks?.length
          ? '<p class="cphone-change-plan-hint">当前不在任一日程时段内时，无法临时改行程。可先生成今日，或等进入某个时段后再试。</p>'
          : (currentBlock && !busy
            ? '<p class="cphone-change-plan-hint">只在天气、位置、聊天约定或已发生事件确实冲突时调整；没有新事实会保留原计划。</p>'
            : '')}
      </section>`;
    return subPageShell('日程', body, { imeScroll: true });
  }

  function clearableAppCount(appId) {
    if (!phone) return 0;
    if (appId === 'browser') return (phone.browserRecords || []).length;
    if (appId === 'map') return (phone.mapPins || []).filter((pin) => !isMapCandidate(pin)).length + (phone.mapItineraries || []).length + (Object.keys(phone.currentMapState || {}).length ? 1 : 0);
    if (appId === 'photos') return (phone.photoRecords || []).length;
    if (appId === 'calls') return (phone.callRecords || []).length;
    if (appId === 'music') return (phone.musicRecords || []).length;
    if (appId === 'interests') return (phone.interestRecords || []).length;
    if (appId === 'avatars') return (phone.avatarLibrary || []).length;
    if (appId === 'memo') return (phone.notes || []).length;
    return 0;
  }

  function photoGenActionsHtml() {
    const list = phone?.photoRecords || [];
    const pendingCount = list.filter((row) => phonePhotoNeedsGeneration(row)).length;
    const selecting = photoGenSelectApp === 'photos';
    if (selecting) {
      return `
        <button type="button" class="btn btn-primary btn-sm cphone-photo-gen-run" ${photoGenSelectedIds.size ? '' : 'disabled'}>补生图(${photoGenSelectedIds.size})</button>
        <button type="button" class="btn btn-soft btn-sm cphone-photo-gen-cancel">取消</button>`;
    }
    return `
      <button type="button" class="btn btn-primary btn-sm cphone-photo-gen-batch" ${pendingCount ? '' : 'disabled'}>补生图</button>
      <button type="button" class="btn btn-outline btn-sm cphone-photo-gen-select" ${list.length ? '' : 'disabled'}>选图补生</button>`;
  }

  function recordActionsHtml(appId) {
    const canClear = clearableAppCount(appId) > 0;
    const generate = (appId === 'memo' || appId === 'avatars')
      ? ''
      : '<button type="button" class="btn btn-primary btn-sm cphone-gen-records">批量生成</button>';
    const photoGen = appId === 'photos' ? photoGenActionsHtml() : '';
    const refresh = appId === 'map'
      ? '<button type="button" class="btn btn-outline btn-sm cphone-refresh-map">刷新地图</button>'
      : '';
    const selecting = recordSelectApp === appId;
    const manage = selecting
      ? `<button type="button" class="btn is-danger btn-sm cphone-record-delete" data-record-app="${esc(appId)}" ${recordSelectedIds.size ? '' : 'disabled'}>删除(${recordSelectedIds.size})</button>`
        + `<button type="button" class="btn btn-soft btn-sm cphone-record-select-cancel">取消</button>`
      : `<button type="button" class="btn btn-outline btn-sm cphone-record-select" data-record-app="${esc(appId)}" ${canClear ? '' : 'disabled'}>多选删除</button>`;
    return `${selecting ? '' : `${generate}${photoGen}${refresh}`}${manage}`;
  }

  function autonomyScheduleStatusHtml() {
    // 自查链：按后台真实闸门的顺序解释「TA 为什么暂时不会来找你」，
    // 每一层只报第一个卡住的原因，避免用户对着一堆开关猜。
    const roleDefaults = autonomySettings?.roleDefaults || {};
    const schedule = {
      ...getScheduleProactiveSettings(phone),
      ...(roleDefaults.scheduleProactive || {}),
    };
    if (roleDefaults.totalEnabled !== true) {
      return '<span><b>不会主动来找你</b><em>「允许主动行为」未开启，TA 只会被动回复</em></span>';
    }
    if (schedule.enabled !== true || Number(schedule.dailyCount || 0) <= 0) {
      return '<span><b>不会主动来找你</b><em>「按日程主动」未开启（在下方详细设置里）</em></span>';
    }
    const todayPlan = getDailyLifePlanForDate(phone, dateKey);
    if (!todayPlan?.blocks?.length) {
      return '<span><b>今日日程</b><em>尚未生成；没有日程时 TA 不会主动来找你</em></span><button type="button" class="cphone-autonomy-generate">生成今日日程</button>';
    }
    const muteHours = autonomySettings?.roleDefaults?.muteHours || {};
    if (isAutonomyMuteHourActive({ muteHours }, nowTs, scheduleTimeZone)) {
      return `<span><b>静音中</b><em>${esc(Number(muteHours.start))}–${esc(Number(muteHours.end))} 点内不主动发</em></span>`;
    }
    const latestPause = (proactiveUsage?.log || []).find((item) => (
      item.status === 'skipped'
      && nowTs - Number(item.at || 0) < 30 * 60 * 1000
      && [
        'active-offline-session',
        'composer-active',
        'foreground-streaming',
        'headless-in-flight',
        'autonomy-guard',
        'failure-backoff',
        'tick-generation-cap',
        'catch-up-generation-cap',
      ].includes(String(item.reason || ''))
    ));
    if (latestPause) {
      return `<span><b>主动消息暂缓</b><em>${esc(proactiveReasonLabel(latestPause.reason))}</em></span>`;
    }
    const latestProblem = (proactiveUsage?.log || []).find((item) => item.status === 'failed');
    if (latestProblem && nowTs - Number(latestProblem.at || 0) < 24 * 60 * 60 * 1000) {
      return `<span><b>最近一次主动失败</b><em>${esc(proactiveReasonLabel(latestProblem.reason))}</em></span>`;
    }
    const usedToday = Math.max(0, Number(proactiveUsage?.sentRounds || 0));
    const dailyCap = Math.max(1, Number(proactiveUsage?.limit || roleDefaults.proactiveDailyLimit || DEFAULT_PROACTIVE_DAILY_LIMIT));
    if (usedToday >= dailyCap) {
      return `<span><b>今日主动已用完</b><em>已发 ${esc(usedToday)}/${esc(dailyCap)} 次，明天恢复；可在详细设置调每日次数</em></span>`;
    }
    const currentBlock = pickCurrentPlanBlock(todayPlan, nowTs, scheduleTimeZone);
    if (!isPlanBlockActiveAt(currentBlock, nowTs, scheduleTimeZone)) {
      return '<span><b>当前在日程空档</b><em>到下个时段再按日程开口；固定兜底仍可接管</em></span>';
    }
    const effectiveState = resolveEffectiveCharacterState({
      runtimeState,
      sceneFact: liveState?.sceneFact || null,
      scheduleBlock: currentBlock,
      allowSceneScheduleOverride: liveState?.policy?.sceneScheduleOverrideAllowed !== false,
      now: nowTs,
    });
    if (effectiveState.scheduleOverridden) {
      return `<span><b>${esc(effectiveState.activity)}</b><em>实时状态已覆盖原计划，本时段不按旧日程主动开口</em></span>`;
    }
    const currentTrigger = pickCurrentTriggerWindow(currentBlock, nowTs, scheduleTimeZone);
    const futureTriggers = (todayPlan.blocks || []).flatMap((block) => (
      (block.triggerWindows || []).map((trigger) => {
        const pointMinute = schedulePointMinuteForBlock(block, trigger);
        const nowMinute = scheduleTimelineMinuteAt(block, nowTs, scheduleTimeZone);
        return { block, trigger, deltaMinute: pointMinute - nowMinute };
      })
    )).filter(({ deltaMinute }) => Number.isFinite(deltaMinute) && deltaMinute >= -1)
      .sort((a, b) => a.deltaMinute - b.deltaMinute);
    const next = currentTrigger
      ? `${currentTrigger.at || '此刻'} ${currentTrigger.reason || '日程触发'}`
      : futureTriggers[0]
        ? `${futureTriggers[0].trigger.at || ''} ${futureTriggers[0].trigger.reason || futureTriggers[0].block.activity || ''}`.trim()
        : '今天暂无下一次触发';
    return `<span><b>${esc(currentBlock?.activity || '日程已就绪')}</b><em>预计 ${esc(next)}</em></span>`;
  }

  function phoneSettingsHtml() {
    const autoOn = isDailyLifeAutoEnabled(autoSettings, selectedId);
    const proactive = getScheduleProactiveSettings(phone);
    const autonomy = autonomySettings?.roleDefaults || {
      totalEnabled: proactive.enabled,
      scheduleProactive: proactive,
      fixedFallback: { enabled: false, intervalMs: 300000 },
      realPersonMode: {
        enabled: false,
        frequencyPreset: 'normal',
        idleReplyFloorEnabled: false,
        idleReplyFloorSeconds: 3,
      },
      muteHours: { enabled: false, start: 23, end: 7 },
    };
    const realPerson = autonomy.realPersonMode || {};
    const fixedFallback = autonomy.fixedFallback || {};
    const muteHours = autonomy.muteHours || { enabled: false, start: 23, end: 7 };
    const shell = phone?.shellPreferences || {};
    const wallpaper = String(resolvedPhoneWallpaper || '').trim();
    const hasWallpaper = !!(wallpaper || String(shell.wallpaperAssetId || '').trim());
    const selectedWidgets = new Set(Array.isArray(shell.widgets)
      ? shell.widgets
      : ['calendar', 'music', 'photos', 'status']);
    const selectedDock = new Set(Array.isArray(shell.dock)
      ? shell.dock
      : ['chat', 'calls', 'browser', 'settings']);
    const shellChecks = (field, selected, choices) => `
      <div class="cphone-shell-checks" role="group">
        ${choices.map(({ id, label }) => `<label><input type="checkbox" value="${id}" data-phone-shell-list="${field}" ${selected.has(id) ? 'checked' : ''}>${label}</label>`).join('')}
      </div>`;
    return subPageShell('设置', `
      <div class="cphone-settings-list">
        <section class="cphone-settings-group">
          <h2>外观</h2>
          <label class="cphone-settings-wallpaper">
            <span class="cphone-settings-wallpaper-preview">${wallpaper ? `<img src="${esc(wallpaper)}" alt="">` : '<i>默认</i>'}</span>
            <span><b>壁纸</b><em>从相册选择</em></span>
            <input type="file" accept="image/*" data-phone-wallpaper hidden>
          </label>
          <button type="button" class="cphone-settings-link is-library" data-phone-wallpaper-library-toggle>壁纸库</button>
          <div class="cphone-wallpaper-library" hidden>
            <div class="cphone-wallpaper-library-grid"></div>
          </div>
          <div class="cphone-settings-inline-input">
            <input type="url" placeholder="粘贴壁纸图片 URL（https://…）" data-phone-wallpaper-url>
            <button type="button" data-phone-wallpaper-url-save>替换</button>
          </div>
          ${hasWallpaper ? '<button type="button" class="cphone-settings-link" data-phone-wallpaper-remove>移除壁纸</button>' : ''}
          <label class="cphone-settings-wallpaper">
            <span class="cphone-settings-wallpaper-preview">${shell.photosCover ? `<img src="${esc(shell.photosCover)}" alt="">` : '<i>最近</i>'}</span>
            <span><b>相册封面</b><em>桌面相册组件展示的图</em></span>
            <input type="file" accept="image/*" data-phone-photos-cover hidden>
          </label>
          ${shell.photosCover ? '<button type="button" class="cphone-settings-link" data-phone-photos-cover-remove>移除相册封面</button>' : ''}
          <label class="cphone-settings-row"><span><b>壁纸预设</b></span><select data-phone-shell-field="wallpaperPreset">
            <option value="default" ${shell.wallpaperPreset === 'default' ? 'selected' : ''}>默认</option>
            <option value="mist" ${shell.wallpaperPreset === 'mist' ? 'selected' : ''}>雾白</option>
            <option value="sea" ${shell.wallpaperPreset === 'sea' ? 'selected' : ''}>海面</option>
            <option value="window" ${shell.wallpaperPreset === 'window' ? 'selected' : ''}>窗边</option>
          </select></label>
          <label class="cphone-settings-row"><span><b>壁纸遮罩</b></span><input type="range" min="0" max="0.82" step="0.02" value="${esc(shell.wallpaperOverlay ?? 0.28)}" data-phone-shell-field="wallpaperOverlay"></label>
          <label class="cphone-settings-row"><span><b>图标色调</b></span><select data-phone-shell-field="iconTone">
            <option value="graphite" ${shell.iconTone === 'graphite' ? 'selected' : ''}>石墨</option>
            <option value="mist" ${shell.iconTone === 'mist' ? 'selected' : ''}>雾白</option>
            <option value="sea" ${shell.iconTone === 'sea' ? 'selected' : ''}>海蓝</option>
          </select></label>
        </section>
        <section class="cphone-settings-group">
          <h2>桌面</h2>
          <div class="cphone-settings-row cphone-settings-row-stack"><span><b>小组件</b></span>${shellChecks('widgets', selectedWidgets, [
            { id: 'calendar', label: '日历' }, { id: 'music', label: '音乐' }, { id: 'photos', label: '相册' }, { id: 'status', label: '此刻' },
          ])}</div>
          <div class="cphone-settings-row cphone-settings-row-stack"><span><b>底部常用应用</b></span>${shellChecks('dock', selectedDock, PHONE_APPS.map((app) => ({ id: app.id, label: app.label })))}</div>
        </section>
        <section class="cphone-settings-group">
          <h2>图标与美化预设</h2>
          <div class="cphone-settings-icon-grid">
            ${[{ id: 'schedule', label: '日历', bg: 'bg-cream' }, ...PHONE_APPS].map((app) => `
              <label class="cphone-settings-icon-item">
                ${phoneAppIconHtml(app, shell)}
                <span>${esc(app.label)}</span>
                <input type="file" accept="image/*" hidden data-phone-app-icon="${esc(app.id)}">
              </label>`).join('')}
          </div>
          <div class="cphone-settings-inline-input">
            <input type="url" placeholder="图标图片 URL（先选择一个图标）" data-phone-app-icon-url>
            <select data-phone-app-icon-target>${[{ id: 'schedule', label: '日历' }, ...PHONE_APPS].map((app) => `<option value="${esc(app.id)}">${esc(app.label)}</option>`).join('')}</select>
            <button type="button" data-phone-app-icon-url-save>替换</button>
          </div>
          <p class="cphone-settings-inline-note">点图标可上传；已替换的图标再次上传即可覆盖。</p>
          <div class="cphone-settings-inline-input">
            <input type="text" maxlength="32" placeholder="给当前美化取名" data-phone-appearance-preset-name>
            <button type="button" data-phone-appearance-preset-save>保存预设</button>
          </div>
          ${phoneAppearancePresets.length ? `<div class="cphone-appearance-presets">
            ${phoneAppearancePresets.map((preset) => `<div><b>${esc(preset.name)}</b><button type="button" data-phone-appearance-preset-apply="${esc(preset.id)}">套用</button><button type="button" data-phone-appearance-preset-delete="${esc(preset.id)}">删除</button></div>`).join('')}
          </div>` : '<p class="cphone-settings-inline-note">保存后可在所有角色手机中套用壁纸、组件、Dock 和图标。</p>'}
        </section>
        <section class="cphone-settings-group cphone-autonomy-settings">
          <h2>真人感回复</h2>
          <div class="cphone-settings-hint">开启后不需要点击推进，TA 会自己回复你，并自行决定回复频率；闲置续聊频率也由 TA 决定，不用另外打开闲置续聊，也不用管理等待时间。推荐设置日程和兴趣、搜索等模块，TA 的回复和话题会与之相关。</div>
          <label class="cphone-settings-row"><span><b>真人感模式</b><em>开启后不需点推进，TA 自己回、自己定频率</em></span><input type="checkbox" class="cphone-real-person-toggle" ${realPerson.enabled ? 'checked' : ''}></label>
          <label class="cphone-settings-row"><span><b>自动生成日程</b><em>独立开关；每天后台补一份当天日程</em></span><input type="checkbox" class="cphone-auto-toggle" ${autoOn ? 'checked' : ''}></label>
          <label class="cphone-settings-row ${realPerson.enabled ? '' : 'is-disabled'}"><span><b>发送已登记的系统回复</b><em>角色自行进入忙碌时，发送 TA 预先留下的留言</em></span><input type="checkbox" class="cphone-system-auto-reply-toggle" ${realPerson.systemAutoReplyEnabled ? 'checked' : ''} ${realPerson.enabled ? '' : 'disabled'}></label>
          <label class="cphone-settings-row ${realPerson.enabled ? '' : 'is-disabled'}"><span><b>允许 TA 自行完全下线</b><em>这是角色的自主权限，不代表当前已经下线</em></span><input type="checkbox" class="cphone-hard-offline-toggle" ${realPerson.allowHardOffline ? 'checked' : ''} ${realPerson.enabled ? '' : 'disabled'}></label>
          <label class="cphone-settings-row"><span><b>回复频率</b></span><select class="cphone-autonomy-frequency">
            <option value="low" ${realPerson.frequencyPreset === 'low' ? 'selected' : ''}>低</option>
            <option value="normal" ${!realPerson.frequencyPreset || realPerson.frequencyPreset === 'normal' ? 'selected' : ''}>适中</option>
            <option value="high" ${realPerson.frequencyPreset === 'high' ? 'selected' : ''}>高</option>
            <option value="custom" ${realPerson.frequencyPreset === 'custom' ? 'selected' : ''}>自定义</option>
          </select></label>
        <label class="cphone-settings-row"><span><b>自定义无输入等待</b><em>关掉时默认约 2.5 秒；打开后可设停止输入后多久接话</em></span><input type="checkbox" class="cphone-idle-reply-floor-toggle" ${realPerson.idleReplyFloorEnabled ? 'checked' : ''}></label>
        <label class="cphone-settings-row cphone-idle-reply-floor-seconds ${realPerson.idleReplyFloorEnabled ? '' : 'is-disabled'}"><span><b>无输入后等待（秒）</b><em>最少 1 秒；用于普通在线接话</em></span><input type="number" class="cphone-idle-reply-floor-seconds-input" min="${REAL_PERSON_IDLE_REPLY_FLOOR_MIN_SECONDS}" max="${REAL_PERSON_IDLE_REPLY_FLOOR_MAX_SECONDS}" step="1" value="${esc(realPerson.idleReplyFloorSeconds || 3)}" ${realPerson.idleReplyFloorEnabled ? '' : 'disabled'}></label>
        </section>
        <section class="cphone-settings-group cphone-autonomy-settings">
          <h2>主动来找你</h2>
          <div class="cphone-settings-hint">管「你没发消息时 TA 来不来找你」：按日程或定时主动开腔。和上面的真人感回复互不重叠，可以同开。</div>
          <label class="cphone-settings-row"><span><b>允许主动行为</b><em>日程主动、固定兜底、朋友圈跟进的总开关</em></span><input type="checkbox" class="cphone-autonomy-total" ${autonomy.totalEnabled ? 'checked' : ''}></label>
          <label class="cphone-settings-row"><span><b>主动消息最低间隔（分钟）</b><em>0 = 不额外覆盖，由追发等各自的间隔决定；正数为统一下限</em></span><input type="number" class="cphone-proactive-gap" min="0" max="1440" step="5" value="${esc(autonomy.scheduleProactive?.minGapMinutes ?? 20)}"></label>
          <label class="cphone-settings-row"><span><b>静音时段</b><em>时段内不主动找你</em></span><input type="checkbox" class="cphone-mute-hours-toggle" ${muteHours.enabled ? 'checked' : ''}></label>
          <label class="cphone-settings-row cphone-mute-hours-range ${muteHours.enabled ? '' : 'is-disabled'}"><span><b>几点到几点</b><em>可跨午夜，如 23–7</em></span>
            <span class="cphone-mute-hours-inputs">
              <input type="number" min="0" max="23" step="1" class="cphone-mute-hours-start" value="${esc(muteHours.start ?? 23)}" ${muteHours.enabled ? '' : 'disabled'}>
              <small>至</small>
              <input type="number" min="0" max="23" step="1" class="cphone-mute-hours-end" value="${esc(muteHours.end ?? 7)}" ${muteHours.enabled ? '' : 'disabled'}>
              <small>点</small>
            </span>
          </label>
          <div class="cphone-settings-row cphone-autonomy-status">${autonomyScheduleStatusHtml()}</div>
          ${proactiveStatsHtml(proactiveUsage || {
            sentRounds: 0,
            messageCount: 0,
            limit: autonomy.proactiveDailyLimit || DEFAULT_PROACTIVE_DAILY_LIMIT,
            log: [],
          }, showProactiveStats)}
          <details class="cphone-autonomy-details">
            <summary>详细设置</summary>
            <label class="cphone-settings-row"><span><b>按角色语言写日程</b><em>默认中文；勾选后跟角色卡语言，可用「翻译日程」补中文</em></span><input type="checkbox" class="cphone-schedule-lang-toggle" ${scheduleEventSettings.scheduleLanguageMode === SCHEDULE_LANGUAGE_FOLLOW_CHARACTER ? 'checked' : ''}></label>
            <label class="cphone-settings-row"><span><b>按日程主动</b></span><input type="checkbox" class="cphone-proactive-toggle" ${autonomy.scheduleProactive?.enabled ? 'checked' : ''}></label>
            <label class="cphone-settings-row"><span><b>每日主动上限</b><em>成功主动一轮计 1 次，多气泡仍只计一次</em></span><input type="number" class="cphone-proactive-count" min="1" step="1" value="${esc(autonomy.proactiveDailyLimit || DEFAULT_PROACTIVE_DAILY_LIMIT)}"></label>
            <label class="cphone-settings-row"><span><b>固定间隔兜底</b></span><input type="checkbox" class="cphone-fixed-fallback-toggle" ${fixedFallback.enabled ? 'checked' : ''}></label>
            <label class="cphone-settings-row"><span><b>兜底间隔（分钟）</b></span><input type="number" class="cphone-fixed-fallback-interval" min="1" max="1440" value="${esc(Math.max(1, Math.round((fixedFallback.intervalMs || 300000) / 60000)))}"></label>
          </details>
        </section>
        <section class="cphone-settings-group">
          <h2>手机内会话托管</h2>
          <div class="cphone-settings-hint">只处理 TA 与其他联系人的手机会话；不会进入你所在的私聊或群聊。</div>
          <label class="cphone-settings-row"><span><b>自动处理手机内消息</b></span><input type="checkbox" data-phone-chat-auto="enabled" ${phoneChatAuto.enabled ? 'checked' : ''}></label>
          <div class="cphone-settings-hint">后台每 5 分钟扫描一次；只有命中需要回复的会话且过了冷却时间才调用 AI。</div>
          <label class="cphone-settings-row"><span><b>手机内回复冷却（分钟）</b><em>同一角色两次托管回复的最短间隔</em></span><input type="number" min="15" max="1440" step="5" value="${esc(phoneChatAuto.intervalMinutes || 120)}" data-phone-chat-auto="intervalMinutes"></label>
          <label class="cphone-settings-row"><span><b>每日回复上限</b></span><input type="number" min="1" max="30" step="1" value="${esc(phoneChatAuto.dailyLimit || 6)}" data-phone-chat-auto="dailyLimit"></label>
          <label class="cphone-settings-row"><span><b>回复其他角色</b></span><input type="checkbox" data-phone-chat-auto="allowPeers" ${phoneChatAuto.allowPeers !== false ? 'checked' : ''}></label>
          <label class="cphone-settings-row"><span><b>回复群聊</b></span><input type="checkbox" data-phone-chat-auto="allowGroups" ${phoneChatAuto.allowGroups !== false ? 'checked' : ''}></label>
          <label class="cphone-settings-row"><span><b>允许主动开话题</b><em>无新消息时极低频发起；默认关闭以避免独角戏</em></span><input type="checkbox" data-phone-chat-auto="allowProactive" ${phoneChatAuto.allowProactive === true ? 'checked' : ''}></label>
        </section>
        <section class="cphone-settings-group">
          <h2>联网与兴趣</h2>
          <label class="cphone-settings-row"><span><b>自动追踪兴趣</b></span><input type="checkbox" class="cphone-interest-track-input" ${interestTracking.autoTrackEnabled ? 'checked' : ''}></label>
          <label class="cphone-settings-row"><span><b>日程参考新资讯</b></span><input type="checkbox" class="cphone-event-news-toggle" ${scheduleEventSettings.eventNewsEnabled ? 'checked' : ''}></label>
          <label class="cphone-settings-row"><span><b>主动寻找可分享内容</b></span><input type="checkbox" class="cphone-share-post-toggle" ${interestTracking.sharePostSearchEnabled ? 'checked' : ''}></label>
        </section>
      </div>
    `);
  }

  function recordsAppHtml(appId) {
    if (appId === 'chat') return phoneChatAppHtml();
    if (appId === 'settings') return phoneSettingsHtml();
    const actions = recordActionsHtml(appId);
    const selecting = recordSelectApp === appId;
    if (appId === 'browser') {
      const collectedLinks = (phone?.interestRecords || []).filter((item) => item?.url || item?.link).map((item) => ({
        ...item,
        id: item.id || `interest_link_${encodeURIComponent(item.url || item.link)}`,
        title: item.title || item.detail || '收藏链接',
        sourceName: item.sourceName || '兴趣收藏',
        url: item.url || item.link,
        linkType: 'real',
        _interestLink: true,
      }));
      return subPageShell('浏览器', browserRecordsHtml([...(phone?.browserRecords || []), ...collectedLinks]), { actions, selecting });
    }
    if (appId === 'map') {
      const character = selectedCharacter() || {};
      const hasCurrentMapState = Object.values(phone?.currentMapState || {}).some(Boolean);
      const mapPhone = hasCurrentMapState ? phone : {
        ...phone,
        currentMapState: virtualMapStateFromContext({
          phone,
          plan,
          character,
          timestamp: nowTs,
          timeZone: scheduleTimeZone,
        }),
      };
      return subPageShell('地图', mapPinsHtml(mapPhone, mapPreviewUrl, character, {
        refreshing: busy && phoneGeneration?.active && phoneGeneration.scope === '刷新地图',
      }), { actions, selecting, bodyClass: 'is-map-product' });
    }
    if (appId === 'photos') return subPageShell('相册', photoRecordsHtml(phone?.photoRecords, chatPhotoRecords, {
      selecting: photoGenSelectApp === 'photos',
      selectedIds: photoGenSelectedIds,
      visibleLimit: photoVisibleLimit,
    }), { actions, selecting: recordSelectApp === appId || photoGenSelectApp === 'photos' });
    if (appId === 'calls') return subPageShell('通话', callRecordsHtml(phone?.callRecords), { actions, selecting });
    if (appId === 'music') return subPageShell('音乐', musicLibraryHtml(phone?.musicRecords, phoneMusicLibrary), { actions, selecting });
    if (appId === 'interests') {
      const interestRecords = (phone?.interestRecords || []).filter((item) => !item?.url && !item?.link);
      return subPageShell('兴趣', `${interestKeywordsHtml()}${simpleRecordsHtml(interestRecords, { empty: '兴趣记录' })}`, { actions, selecting });
    }
    if (appId === 'avatars') return subPageShell('头像库', avatarLibraryHtml(phone?.avatarLibrary, pendingAvatarImport), { actions, selecting });
    if (appId === 'memo') return subPageShell('备忘录', notesHtml(phone?.notes), { actions, selecting });
    return '';
  }


  function categoryLabelOf(category) {
    return ({
      family: '家人', work: '工作', friend: '朋友', rival: '关系紧张', other: '其他',
    }[category] || '联系人');
  }

  function phoneContactEditHtml(contact) {
    if (!contact) {
      return subPageShell('联系人', `
        <div class="cphone-empty-note">联系人不存在或已删除</div>
        <button type="button" class="cphone-settings-link" data-phone-contact-edit-back>返回通讯录</button>
      `, { bodyClass: 'is-contact-edit' });
    }
    const capsule = contact.personaCapsule || {};
    const translationProfile = contact.translationProfile || {};
    const traits = Array.isArray(capsule.traits) ? capsule.traits.join('、') : '';
    const displayName = phoneRemarkOf(contact) || contact.name || contact.nickname || '联系人';
    const linkedId = String(contact.linkedCharacterId || '').trim();
    const linkedChar = linkedId ? characters.find((row) => row.id === linkedId) : null;
    if (linkedChar) {
      const remark = phoneRemarkOf(contact);
      return subPageShell(displayName, `
        <div class="cphone-contact-edit">
          <div class="cphone-contact-edit-hero">
            <label class="cphone-contact-edit-avatar-wrap" title="更换头像">
              ${phoneAvatarHtml(linkedChar, { className: 'cphone-contact-edit-avatar', title: nameOf(linkedChar, displayName) })}
              <span>换头像</span>
              <input type="file" accept="image/*" hidden data-phone-contact-edit-avatar="${esc(contact.id)}">
            </label>
            <b>${esc(nameOf(linkedChar, displayName))}</b>
            <em>${remark ? `备注 · ${esc(remark)}` : '已在通讯录'}</em>
          </div>
          <form class="cphone-contact-edit-form cphone-contact-remark-form" data-phone-contact-remark-form="${esc(contact.id)}">
            <label><span>备注</span><input name="remark" maxlength="40" value="${esc(remark)}" placeholder="角色会在这部手机里看到的称呼"></label>
            <button type="submit" class="cphone-contact-edit-primary">保存备注</button>
          </form>
          <div class="cphone-contact-edit-actions">
            <button type="button" class="cphone-contact-edit-primary" data-phone-contact-open-character="${esc(linkedChar.id)}">编辑角色</button>
            <button type="button" data-phone-contact-open-chat="${esc(linkedChar.id)}">发消息</button>
            <button type="button" class="cphone-contact-edit-remove" data-phone-contact-remove-linked="${esc(linkedChar.id)}">从手机移除</button>
            <button type="button" data-phone-contact-edit-back>返回</button>
          </div>
        </div>
      `, { bodyClass: 'is-contact-edit' });
    }
    return subPageShell(displayName, `
      <div class="cphone-contact-edit">
        <div class="cphone-contact-edit-hero">
          <label class="cphone-contact-edit-avatar-wrap" title="更换头像">
            ${phoneAvatarHtml(contact, { className: 'cphone-contact-edit-avatar', title: displayName })}
            <span>换头像</span>
            <input type="file" accept="image/*" hidden data-phone-contact-edit-avatar="${esc(contact.id)}">
          </label>
          <em>轻量联系人 · ${esc(categoryLabelOf(contact.category))}</em>
        </div>
        <form class="cphone-contact-edit-form" data-phone-contact-edit-form="${esc(contact.id)}">
          <label><span>姓名</span><input name="name" maxlength="80" value="${esc(contact.name || '')}" required></label>
          <label><span>备注</span><input name="remark" maxlength="40" value="${esc(phoneRemarkOf(contact))}"></label>
          <label><span>分类</span><select name="category">
            ${['family', 'work', 'friend', 'rival', 'other'].map((id) => `
              <option value="${id}" ${contact.category === id ? 'selected' : ''}>${esc(categoryLabelOf(id))}</option>
            `).join('')}
          </select></label>
          <label><span>关系</span><input name="relationship" maxlength="120" value="${esc(capsule.relationship || '')}" placeholder="和手机主人的关系"></label>
          <label><span>人设摘要</span><textarea name="summary" maxlength="280" rows="3" placeholder="身份、性格等">${esc(capsule.summary || '')}</textarea></label>
          <label><span>特质</span><input name="traits" maxlength="120" value="${esc(traits)}" placeholder="用顿号分隔"></label>
          <label><span>说话风格</span><input name="speechStyle" maxlength="120" value="${esc(capsule.speechStyle || '')}"></label>
          <label><span>聊天语言</span><select name="translationMode">
            <option value="off" ${translationProfile.mode === 'off' ? 'selected' : ''}>中文</option>
            <option value="full" ${translationProfile.mode === 'full' ? 'selected' : ''}>外语 / 方言 + 中文翻译</option>
            <option value="mixed" ${translationProfile.mode === 'mixed' ? 'selected' : ''}>中文夹外语 / 方言</option>
          </select></label>
          <label><span>主要外语 / 方言</span><input name="translationLanguage" maxlength="40" value="${esc(translationProfile.language || '')}" placeholder="如英语、日语、粤语"></label>
          <label><span>夹用方式</span><input name="translationDialectNote" maxlength="120" value="${esc(translationProfile.dialectNote || '')}" placeholder="仅混合模式"></label>
          <label><span>边界</span><input name="boundary" maxlength="120" value="${esc(capsule.boundary || '')}"></label>
          <label><span>备注</span><textarea name="note" maxlength="240" rows="2">${esc(contact.note || '')}</textarea></label>
          <div class="cphone-contact-edit-actions">
            <button type="submit" class="cphone-contact-edit-primary">保存</button>
            <button type="button" data-phone-contact-promote="${esc(contact.id)}">加入通讯录</button>
            <button type="button" data-phone-contact-open-chat="${esc(contact.id)}">发消息</button>
            <button type="button" data-phone-contact-edit-back>返回</button>
          </div>
        </form>
      </div>
    `, { bodyClass: 'is-contact-edit' });
  }

  function phoneChatAppHtml() {
    if (phoneContactEditId) {
      if (phoneContactEditId === 'user') {
        const userName = user.name || user.displayName || '用户';
        return subPageShell(phoneContacts.userRemark || userName, `
          <div class="cphone-contact-edit cphone-user-remark-edit">
            <div class="cphone-contact-edit-hero">
              ${phoneAvatarHtml({ name: userName, avatar: user.avatar || user.avatarUrl || '' }, { className: 'cphone-contact-edit-avatar', title: userName })}
              <b>${esc(userName)}</b>
              <em>角色手机里的用户名片</em>
            </div>
            <form class="cphone-contact-edit-form" data-phone-user-remark-form>
              <label><span>TA 给你的备注</span><input name="remark" maxlength="40" value="${esc(phoneContacts.userRemark || '')}" placeholder="未设置时显示你的名字"></label>
              <div class="cphone-contact-edit-actions">
                <button type="submit" class="cphone-contact-edit-primary">保存</button>
                <button type="button" data-phone-user-remark-generate>让 TA 填写</button>
                <button type="button" data-phone-contact-edit-back>返回</button>
              </div>
            </form>
          </div>
        `, { bodyClass: 'is-contact-edit' });
      }
      const editing = (phoneContacts.contacts || []).find((item) => (
        item.id === phoneContactEditId || item.linkedCharacterId === phoneContactEditId
      )) || null;
      return phoneContactEditHtml(editing);
    }
    const displayRoster = displayCharacters.length ? displayCharacters : characters;
    const charMap = Object.fromEntries([
      ...displayRoster.map((row) => [row.id, { ...row, avatar: row.avatar || row.avatarUrl || '' }]),
      // 关系网轻量 NPC：优先于裸 id，但会被手机通讯录同 id 条目覆盖
      ...(lightweightNpcRoster || []).map((row) => [row.id, {
        ...row,
        name: resolvePhoneSocialActorDisplayName(row) || '联系人',
        avatar: row.avatar || row.avatarUrl || '',
        _phoneLightContact: true,
      }]),
      ...(phoneContacts.contacts || []).map((row) => {
        const linked = row.linkedCharacterId
          ? displayRoster.find((c) => c.id === row.linkedCharacterId)
          : null;
        const actor = phoneSocialDirectory.resolve(phoneContactCanonicalActorId(row));
        const trueName = resolvePhoneSocialActorDisplayName(
          row.name,
          linked,
          actor,
          row.nickname,
        );
        const remark = phoneRemarkOf(row);
        return [row.id, {
          id: row.id,
          name: remark || trueName || '联系人',
          realName: trueName,
          phoneRemark: remark,
          nickname: row.nickname || '',
          // 不把备注塞进 customNickname，避免列表/标题显示「爸爸」
          customNickname: '',
          avatar: resolvePhoneContactAvatar(row, displayRoster),
          _phoneLightContact: !linked,
        }];
      }),
      ...(phoneContacts.contacts || [])
        .filter((row) => row.linkedCharacterId)
        .map((row) => {
          const linked = displayRoster.find((c) => c.id === row.linkedCharacterId);
          const trueName = linked?.realName || linked?.name || row.name || row.linkedCharacterId;
          const remark = phoneRemarkOf(row);
          return [row.linkedCharacterId, {
            ...(linked || { id: row.linkedCharacterId }),
            name: remark || trueName,
            realName: trueName,
            phoneRemark: remark,
            customNickname: linked?.customNickname || '',
            // 已链接：角色卡头像优先，避免添加联系人时的旧快照盖住换头
            avatar: linked?.avatar || linked?.avatarUrl || row.avatar || '',
          }];
        }),
      ...(phoneContacts.contacts || [])
        .filter((row) => row.linkedActorId)
        .map((row) => {
          const actor = phoneSocialDirectory.resolve(row.linkedActorId);
          const trueName = resolvePhoneSocialActorDisplayName(row, actor) || '联系人';
          const remark = phoneRemarkOf(row);
          return [row.linkedActorId, {
            id: row.linkedActorId,
            name: remark || trueName,
            realName: trueName,
            phoneRemark: remark,
            nickname: row.nickname || '',
            customNickname: '',
            avatar: row.avatar || actor?.avatar || '',
            _phoneLightContact: true,
          }];
        }),
    ]);
    const participantIds = [...new Set(phoneChatRows.flatMap((chat) => (
      chat.participants || []
    )).filter((id) => id !== selectedId && id !== 'user'))];
    const lightweightContacts = phoneContacts?.contacts || [];
    const lightweightGroups = phoneContacts?.groups || [];
    // 轻量 NPC（无 linkedCharacterId）只出现在「轻量联系人」分区，不因聊过天再挤进主联系人列表
    const lightOnlyIds = new Set(
      lightweightContacts
        .filter((item) => isPhoneLocalLightContact(item))
        .map((item) => item.id),
    );
    // displayRoster 还包含匿名 NPC 等只为会话补姓名/头像的内部角色，不能把它们
    // 当成主通讯录成员；否则仅在会话里出现的人会混进普通「联系人」分区。
    const userRosterIds = characters.map((row) => row.id);
    const contactRows = participantIds
      .map((id) => charMap[id])
      .filter((row) => row && !lightOnlyIds.has(row.id))
      .sort((a, b) => nameOf(a).localeCompare(nameOf(b), 'zh-CN'));
    const groupRows = phoneChatRows.filter((chat) => chat.type === 'group');
    // 通讯录去重：已链接主角色只列一次；轻量 NPC 单独分区；分类做副标题不粘在姓名后
    const linkedByCharacterId = new Map();
    for (const item of lightweightContacts) {
      const actorId = phoneContactCanonicalActorId(item);
      if (item?.id && actorId !== item.id) linkedByCharacterId.set(actorId, item);
    }
    const chatPeerIds = new Set(participantIds);
    const mainContactRows = [];
    const sessionOrphanRows = [];
    const seenMainIds = new Set();
    const seenOrphanIds = new Set();
    const pushMain = (row) => {
      const actorId = phoneContactDisplayActorId(row?.id, lightweightContacts);
      if (!row?.id || !actorId || seenMainIds.has(actorId) || actorId === selectedId || lightOnlyIds.has(row.id)) return;
      seenMainIds.add(actorId);
      mainContactRows.push(charMap[actorId] || row);
    };
    for (const person of contactRows) {
      if (isPhoneSessionOrphanPeer(person.id, {
        phoneContacts: lightweightContacts,
        userCharacterIds: userRosterIds,
        peerName: nameOf(person),
      })) {
        if (!seenOrphanIds.has(person.id)) {
          seenOrphanIds.add(person.id);
          sessionOrphanRows.push(person);
        }
        continue;
      }
      pushMain(person);
    }
    for (const linkedId of linkedByCharacterId.keys()) {
      if (chatPeerIds.has(linkedId) && seenMainIds.has(linkedId)) continue;
      pushMain(charMap[linkedId] || { id: linkedId, name: linkedId });
    }
    mainContactRows.sort((a, b) => nameOf(a).localeCompare(nameOf(b), 'zh-CN'));
    sessionOrphanRows.sort((a, b) => nameOf(a).localeCompare(nameOf(b), 'zh-CN'));
    const lightOnlyContacts = lightweightContacts.filter((item) => (
      item?.id && lightOnlyIds.has(item.id) && !item.interceptSource && !item.blocked
    ));
    const interceptContacts = lightweightContacts.filter((item) => (
      item?.id && (item.interceptSource || item.blocked)
    ));
    const groupChatTitles = new Set(groupRows.map((chat) => (
      resolvePhoneChatTitle(chat, selectedId, charMap, user.name || '用户', { userId: user.id, user })
    )));
    const uniqueLightGroups = lightweightGroups.filter((group) => {
      const name = String(group?.name || '').trim();
      return name && !groupChatTitles.has(name);
    });
    const selectingChats = chatManageMode && phoneChatSection === 'messages';
    const selectingContacts = chatManageMode && phoneChatSection === 'contacts';
    const selectingIntercept = chatManageMode && phoneChatSection === 'intercept';
    const selecting = selectingChats || selectingContacts || selectingIntercept;
    const resolvePhoneContactRef = (peerId = '') => {
      const id = String(peerId || '').trim();
      if (!id) return '';
      const hit = lightweightContacts.find((item) => (
        item.id === id || item.linkedCharacterId === id || item.linkedActorId === id
      ));
      return hit?.id || '';
    };
    const rows = phoneChatRows.map((chat) => {
      const peerId = (chat.participants || []).find((id) => id !== selectedId && id !== 'user');
      const peer = peerId ? charMap[peerId] : null;
      const matchedGroup = chat.type === 'group'
        ? matchPhoneContactGroupForChat(selectedId, chat, lightweightGroups, lightweightContacts)
        : null;
      const isUserThread = chat.type !== 'group' && !peerId && (chat.participants || []).includes('user');
      const userPeer = isUserThread
        ? resolvePhoneUserPeerIdentity(chat, user.id, user)
        : null;
      const title = isUserThread
        ? (phoneContacts.userRemark || userPeer.displayName || user.name || '用户')
        : resolvePhoneChatTitle(chat, selectedId, charMap, user.name || '用户', { userId: user.id, user });
      const avatar = chat.type === 'group'
        ? phoneGroupAvatarHtml(
          matchedGroup || { name: title },
          matchedGroup
            ? phoneGroupMemberAvatarEntries(matchedGroup, selectedId, lightweightContacts, charMap)
            : (chat.participants || [])
              .filter((id) => id && id !== 'user')
              .map((id) => {
                const contact = findPhoneContactByActorId(lightweightContacts, id);
                const char = charMap[id] || {};
                return {
                  name: phoneRemarkOf(contact) || contact?.name || char.realName || char.name || title,
                  avatar: (contact ? resolvePhoneContactAvatar(contact, charMap) : '') || char.avatar || '',
                };
              }),
          { className: 'cphone-chat-group-avatar', title },
        )
        : (isUserThread
          ? phoneAvatarHtml({ name: title, avatar: userPeer?.avatar || '' }, { title })
          : phoneAvatarHtml(peer || {}, { title: peer ? nameOf(peer) : '联系人' }));
      const subtitle = isUserThread && userPeer?.handle
        ? `ID ${userPeer.handle}`
        : plain(chat.lastMessage || '暂无消息', 60);
      const checked = chatSelectedIds.has(chat.id);
      const searchText = [title, subtitle].join(' ').toLocaleLowerCase();
      if (selectingChats) {
        return `
          <label class="cphone-chat-row is-selecting ${checked ? 'is-checked' : ''}">
            <input type="checkbox" data-phone-chat-select="${esc(chat.id)}" ${checked ? 'checked' : ''}>
            ${avatar}
            <span class="cphone-chat-row-main"><b>${esc(title)}</b><span class="cphone-chat-row-preview">${esc(subtitle)}</span></span>
              <time>${esc(formatAgoShort(chat.lastActivity, nowTs))}</time>
          </label>`;
      }
      return `
        <button type="button" class="cphone-chat-row" data-phone-chat-id="${esc(chat.id)}" data-phone-chat-search-text="${esc(searchText)}">
          ${avatar}
          <span class="cphone-chat-row-main"><b>${esc(title)}</b><span class="cphone-chat-row-preview">${esc(subtitle)}</span></span>
            <time>${esc(formatAgoShort(chat.lastActivity, nowTs))}</time>
        </button>`;
    }).join('');
    const messagesView = `
      <form class="cphone-chat-search" data-phone-chat-search-form>
        ${icon('search')}
        <input type="search" value="${esc(phoneChatQuery)}" placeholder="搜索" aria-label="搜索会话" data-phone-chat-search>
      </form>
      ${selectingChats ? `
        <div class="cphone-chat-manage-bar">
          <button type="button" class="cphone-chat-manage-delete" data-phone-chat-delete-selected ${chatSelectedIds.size ? '' : 'disabled'}>删除(${chatSelectedIds.size})</button>
          <button type="button" data-phone-chat-manage-exit>完成</button>
        </div>` : ''}
      <div class="cphone-chat-list">${rows || '<div class="cphone-empty-note">角色参与的私聊和群聊会显示在这里</div>'}</div>`;
    const renderMainContactRow = (person) => {
      const contactRef = resolvePhoneContactRef(person.id);
      const contact = lightweightContacts.find((item) => item.id === contactRef);
      const trueName = person.realName || contact?.name || nameOf(person);
      const displayName = phoneRemarkOf(contact) || nameOf(person);
      const selectable = !!contactRef;
      const checked = contactRef && contactSelectedIds.has(contactRef);
      if (selectingContacts) {
        if (!selectable) {
          return `
            <div class="cphone-contact-row is-selecting is-disabled">
              ${phoneAvatarHtml(person, { title: displayName })}
              <span class="cphone-contact-meta"><b>${esc(displayName)}</b><em>仅会话，未写入通讯录</em></span>
            </div>`;
        }
        return `
          <label class="cphone-contact-row is-selecting ${checked ? 'is-checked' : ''}">
            <input type="checkbox" data-phone-contact-select="${esc(contactRef)}" ${checked ? 'checked' : ''}>
            ${phoneAvatarHtml(person, { title: displayName })}
            <span class="cphone-contact-meta"><b>${esc(displayName)}</b>${displayName !== trueName ? `<em>${esc(trueName)}</em>` : ''}</span>
          </label>`;
      }
      return `
        <div class="cphone-contact-row-wrap">
          <button type="button" class="cphone-contact-row" data-phone-contact-id="${esc(person.id)}">
            ${phoneAvatarHtml(person, { title: displayName })}
            <span class="cphone-contact-meta"><b>${esc(displayName)}</b>${displayName !== trueName ? `<em>${esc(trueName)}</em>` : ''}</span>
          </button>
          <button type="button" class="cphone-contact-chat-start" data-phone-contact-chat="${esc(person.id)}" aria-label="与${esc(displayName)}发起聊天">聊天</button>
        </div>`;
    };
    const renderLightContactRow = (person) => {
      const trueName = person.name || person.nickname || '联系人';
      const displayName = phoneRemarkOf(person) || trueName;
      const checked = contactSelectedIds.has(person.id);
      if (selectingContacts) {
        return `
          <label class="cphone-contact-row is-selecting ${checked ? 'is-checked' : ''}">
            <input type="checkbox" data-phone-contact-select="${esc(person.id)}" ${checked ? 'checked' : ''}>
            ${phoneAvatarHtml({ name: displayName, avatar: person.avatar || '' }, { title: displayName })}
            <span class="cphone-contact-meta">
              <b>${esc(displayName)}</b>
              <em>${esc(displayName !== trueName ? trueName : categoryLabelOf(person.category))}</em>
            </span>
          </label>`;
      }
      return `
        <div class="cphone-contact-row-wrap">
          <button type="button" class="cphone-contact-row" data-phone-light-contact-id="${esc(person.id)}">
            ${phoneAvatarHtml({ name: displayName, avatar: person.avatar || '' }, { title: displayName })}
            <span class="cphone-contact-meta">
              <b>${esc(displayName)}</b>
              <em>${esc(displayName !== trueName ? trueName : categoryLabelOf(person.category))}</em>
            </span>
          </button>
          <button type="button" class="cphone-contact-chat-start" data-phone-contact-chat="${esc(person.id)}" aria-label="与${esc(displayName)}发起聊天">聊天</button>
        </div>`;
    };
    const renderSessionOrphanRow = (person) => {
      const displayName = nameOf(person) || '联系人';
      return `
        <div class="cphone-contact-row-wrap is-session-orphan">
          <div class="cphone-contact-row is-static">
            ${phoneAvatarHtml(person, { title: displayName })}
            <span class="cphone-contact-meta">
              <b>${esc(displayName)}</b>
              <em>仅会话 · 未入通讯录</em>
            </span>
          </div>
          ${selectingContacts ? '' : `
          <div class="cphone-contact-orphan-actions">
            <button type="button" class="cphone-contact-chat-start" data-phone-orphan-adopt="${esc(person.id)}">加入</button>
            <button type="button" class="cphone-contact-orphan-dismiss" data-phone-orphan-dismiss="${esc(person.id)}">移除</button>
          </div>`}
        </div>`;
    };
    const contactsView = `
      ${selectingContacts ? `
        <div class="cphone-chat-manage-bar">
          <button type="button" class="cphone-chat-manage-delete" data-phone-contact-delete-selected ${contactSelectedIds.size ? '' : 'disabled'}>删除(${contactSelectedIds.size})</button>
          <button type="button" data-phone-chat-manage-exit>完成</button>
        </div>` : `
      <div class="cphone-contact-shortcuts">
        <button type="button" data-phone-contact-action="new">${icon('plusCircle')}<b>新的联系人</b></button>
        <button type="button" data-phone-contact-action="groups">${icon('lucideUser')}<b>新建群聊</b><em>${groupRows.length + uniqueLightGroups.length}</em></button>
      </div>`}
      <div class="cphone-contact-index">
        ${selectingContacts ? '' : `
        <div class="cphone-contact-letter">我的名片</div>
        <button type="button" class="cphone-contact-row cphone-user-contact-row" data-phone-user-contact>
          ${phoneAvatarHtml({ name: user.name || '用户', avatar: user.avatar || user.avatarUrl || '' }, { title: phoneContacts.userRemark || user.name || '用户' })}
          <span class="cphone-contact-meta"><b>${esc(phoneContacts.userRemark || user.name || '用户')}</b>${phoneContacts.userRemark ? `<em>${esc(user.name || '用户')}</em>` : '<em>TA 尚未设置备注</em>'}</span>
          ${icon('chevron')}
        </button>`}
        <div class="cphone-contact-letter">联系人</div>
        ${mainContactRows.map((person) => renderMainContactRow(person)).join('')
          || ((lightOnlyContacts.length || sessionOrphanRows.length) ? '' : '<div class="cphone-empty-note">还没有联系人</div>')}
        ${lightOnlyContacts.length ? `<div class="cphone-contact-letter">轻量联系人</div>${lightOnlyContacts.map((person) => renderLightContactRow(person)).join('')}` : ''}
        ${sessionOrphanRows.length ? `<div class="cphone-contact-letter">未入通讯录</div>${sessionOrphanRows.map((person) => renderSessionOrphanRow(person)).join('')}` : ''}
        ${selectingContacts ? '' : `
        ${groupRows.length ? `<div class="cphone-contact-letter">群聊</div>${groupRows.map((chat) => {
          const gTitle = resolvePhoneChatTitle(chat, selectedId, charMap, user.name || '用户');
          const matched = matchPhoneContactGroupForChat(selectedId, chat, lightweightGroups, lightweightContacts);
          const memberEntries = matched
            ? phoneGroupMemberAvatarEntries(matched, selectedId, lightweightContacts, charMap)
            : (chat.participants || []).filter((id) => id && id !== 'user').map((id) => {
              const contact = findPhoneContactByActorId(lightweightContacts, id);
              const char = charMap[id] || {};
              return {
                name: phoneRemarkOf(contact) || contact?.name || char.realName || char.name || gTitle,
                avatar: (contact ? resolvePhoneContactAvatar(contact, charMap) : '') || char.avatar || '',
            };
            });
          return `
          <button type="button" class="cphone-contact-row" data-phone-chat-id="${esc(chat.id)}">
            ${phoneGroupAvatarHtml(matched || { name: gTitle }, memberEntries, { className: 'cphone-chat-group-avatar', title: gTitle })}
            <span class="cphone-contact-meta"><b>${esc(gTitle)}</b></span>
          </button>`;
        }).join('')}` : ''}
        ${uniqueLightGroups.length ? `${groupRows.length ? '' : '<div class="cphone-contact-letter">群聊</div>'}${uniqueLightGroups.map((group) => `
          <button type="button" class="cphone-contact-row" data-phone-light-group-id="${esc(group.id)}">
            ${phoneGroupAvatarHtml(
              group,
              phoneGroupMemberAvatarEntries(group, selectedId, lightweightContacts, charMap),
              { className: 'cphone-chat-group-avatar', title: group.name },
            )}
            <span class="cphone-contact-meta">
              <b>${esc(group.name)}</b>
              <em>${esc(`${group.memberIds?.length || 0} 人`)}</em>
            </span>
          </button>`).join('')}` : ''}
        `}
      </div>`;
    const phoneMomentNameMap = new Map([
      ...characters.map((item) => [item.id, nameOf(item)]),
      ...displayRoster.map((item) => [item.id, nameOf(item)]),
      ...(phoneContacts.contacts || []).flatMap((item) => {
        const label = item.name || item.nickname || '';
        const rows = [];
        if (item.id) rows.push([item.id, label || item.id]);
        if (item.linkedCharacterId) {
          const linked = characters.find((c) => c.id === item.linkedCharacterId);
          rows.push([item.linkedCharacterId, nameOf(linked, label || item.linkedCharacterId)]);
          if (label) rows.push([item.id, nameOf(linked, label)]);
        }
        return rows;
      }),
    ]);
    const phoneMomentAvatarMap = new Map([
      ...characters.map((item) => [item.id, item.avatar || item.avatarUrl || '']),
      ...displayRoster.map((item) => [item.id, item.avatar || item.avatarUrl || '']),
      ...(phoneContacts.contacts || []).map((item) => [
        item.id,
        resolvePhoneContactAvatar(item, displayRoster),
      ]),
      ...(phoneContacts.contacts || [])
        .filter((item) => item.linkedCharacterId)
        .map((item) => {
          const linked = displayRoster.find((c) => c.id === item.linkedCharacterId);
          return [item.linkedCharacterId, linked?.avatar || linked?.avatarUrl || item.avatar || ''];
        }),
      ...(phoneContacts.contacts || [])
        .filter((item) => item.linkedActorId)
        .map((item) => [item.linkedActorId, resolvePhoneContactAvatar(item, displayRoster)]),
    ]);
    const momentsView = `
      <section class="cphone-moments-feed">
        <header class="cphone-moments-head">
          <div class="cphone-moments-head-title"><strong>朋友圈</strong><em>联系人最近的动态</em></div>
          <div class="cphone-moments-head-actions">
            <button type="button" data-phone-own-moments>TA 的主页</button>
          </div>
        </header>
        ${phoneMoments.length
          ? phoneMoments.map((post) => renderMomentPostCard(post, {
            user,
            nameMap: phoneMomentNameMap,
            avatarMap: phoneMomentAvatarMap,
            actors: [],
            stickerPool: phoneMomentStickerPool,
          })).join('')
          : '<div class="cphone-empty-note">这里会显示 TA 通讯录里的人发的朋友圈</div>'}
      </section>`;
    const interceptRowsHtml = phoneInterceptRows.map((chat) => {
      const peerId = (chat.participants || []).find((id) => id !== selectedId && id !== 'user');
      const peer = peerId ? charMap[peerId] : null;
      const isUserSide = !peerId && (chat.participants || []).includes('user');
      const userPeer = isUserSide || isStrangerInterceptChat(chat)
        ? resolvePhoneUserPeerIdentity(chat, user.id, user)
        : null;
      const blocked = !!(userPeer?.blocked || isUserAliasBlockedByCharacter(chat));
      const title = userPeer?.displayName
        || resolvePhoneChatTitle(chat, selectedId, charMap, user.name || '用户', { userId: user.id, user });
      const handleHint = userPeer?.handle ? `ID ${userPeer.handle}` : '';
      const hasMessage = !!String(chat.lastMessage || '').trim();
      const preview = !hasMessage
        ? '暂无拦截消息 · 生成一轮可补入'
        : (blocked
          ? (handleHint ? `已拉黑 · ${handleHint}` : '已拉黑 · 骚扰拦截')
          : (handleHint || plain(chat.lastMessage, 60)));
      const avatar = phoneAvatarHtml(
        userPeer?.isAlias
          ? { name: title, avatar: userPeer.avatar || '' }
          : (peer || { name: title, avatar: userPeer?.avatar || '' }),
        { title },
      );
      const main = `
          <span class="cphone-chat-row-main">
            <b>${esc(title)}${blocked ? '<em class="cphone-chat-blocked-tag">拉黑</em>' : ''}</b>
            <span class="cphone-chat-row-preview">${esc(preview)}</span>
          </span>
            <time>${esc(formatAgoShort(chat.lastActivity, nowTs))}</time>`;
      if (selectingIntercept) {
        const checked = chatSelectedIds.has(chat.id);
        return `
          <label class="cphone-chat-row is-intercept is-selecting${blocked ? ' is-blocked' : ''}${checked ? ' is-checked' : ''}">
            <input type="checkbox" data-phone-chat-select="${esc(chat.id)}" ${checked ? 'checked' : ''}>
            ${avatar}
            ${main}
          </label>`;
      }
      return `
        <button type="button" class="cphone-chat-row is-intercept${blocked ? ' is-blocked' : ''}" data-phone-chat-id="${esc(chat.id)}" data-phone-chat-empty="${hasMessage ? '0' : '1'}">
          ${avatar}
          ${main}
        </button>`;
    }).join('');
    const interceptContactRowsHtml = interceptContacts
      .filter((person) => {
        const peerId = phoneContactCanonicalActorId(person);
        return !phoneInterceptRows.some((chat) => (chat.participants || []).includes(peerId));
      })
      .map((person) => {
        const displayName = person.name || person.nickname || '联系人';
        if (selectingIntercept) {
          const checked = contactSelectedIds.has(person.id);
          return `
            <label class="cphone-chat-row is-intercept is-selecting ${checked ? 'is-checked' : ''}">
              <input type="checkbox" data-phone-contact-select="${esc(person.id)}" ${checked ? 'checked' : ''}>
              ${phoneAvatarHtml({ name: displayName, avatar: person.avatar || '' }, { title: displayName })}
              <span class="cphone-chat-row-main">
                <b>${esc(displayName)}</b>
                <span class="cphone-chat-row-preview">黑名单联系人</span>
              </span>
            </label>`;
        }
        return `
          <button type="button" class="cphone-chat-row is-intercept" data-phone-intercept-contact-id="${esc(person.id)}">
            ${phoneAvatarHtml({ name: displayName, avatar: person.avatar || '' }, { title: displayName })}
            <span class="cphone-chat-row-main">
              <b>${esc(displayName)}</b>
              <span class="cphone-chat-row-preview">黑名单 · 暂无拦截消息</span>
            </span>
          </button>`;
      }).join('');
    const interceptView = `
      <header class="cphone-intercept-head">
        <div>
          <strong>拦截</strong>
          <em>陌生马甲、骚扰与已拉黑</em>
        </div>
        ${selectingIntercept ? '' : '<span></span>'}
      </header>
      ${selectingIntercept ? `
        <div class="cphone-chat-manage-bar">
          <button type="button" class="cphone-chat-manage-delete" data-phone-intercept-delete-selected ${chatSelectedIds.size || contactSelectedIds.size ? '' : 'disabled'}>删除(${chatSelectedIds.size + contactSelectedIds.size})</button>
          <button type="button" data-phone-chat-manage-exit>完成</button>
        </div>` : ''}
      <div class="cphone-chat-list">
        ${interceptRowsHtml || interceptContactRowsHtml
          ? `${interceptRowsHtml}${interceptContactRowsHtml}`
          : '<div class="cphone-empty-note">被拦下的陌生消息会显示在这里</div>'}
      </div>`;
    const sectionBody = phoneChatSection === 'contacts'
      ? contactsView
      : (phoneChatSection === 'discover'
        ? momentsView
        : (phoneChatSection === 'intercept' ? interceptView : messagesView));
    const hasLastBatch = !!lastPhoneLifeBatch?.batchId;
    const actions = selecting
      ? `<button type="button" data-phone-chat-manage-exit>退出管理</button>`
      : `
      ${phoneChatSection === 'discover' ? '' : `<button type="button" data-phone-chat-manage>${phoneChatSection === 'contacts' ? '管理联系人' : (phoneChatSection === 'intercept' ? '管理拦截' : '管理会话')}</button>`}
      <button type="button" data-phone-chat-debug-open>调试与生成</button>`;
    return subPageShell('Chat', `
      <div class="cphone-chat-section">${sectionBody}</div>
      <nav class="cphone-chat-tabs" aria-label="Chat 导航">
        <button type="button" data-phone-chat-tab="messages" class="${phoneChatSection === 'messages' ? 'is-active' : ''}">${icon('message')}<span>消息</span></button>
        <button type="button" data-phone-chat-tab="contacts" class="${phoneChatSection === 'contacts' ? 'is-active' : ''}" ${selecting ? 'disabled' : ''}>${icon('lucideUser')}<span>通讯录</span></button>
        <button type="button" data-phone-chat-tab="discover" class="${phoneChatSection === 'discover' ? 'is-active' : ''}" ${selecting ? 'disabled' : ''}>${icon('lucideCompass')}<span>动态</span></button>
        <button type="button" data-phone-chat-tab="intercept" class="${phoneChatSection === 'intercept' ? 'is-active' : ''}" ${selecting ? 'disabled' : ''}>${icon('shield')}<span>拦截</span></button>
      </nav>
      <div class="cphone-chat-debug-proxies" hidden>
        <button type="button" data-phone-chat-batch ${phoneChatBusy ? 'disabled' : ''}></button>
        <button type="button" data-phone-chat-undo ${!hasLastBatch || phoneChatBusy ? 'disabled' : ''}></button>
        <button type="button" data-phone-chat-reroll ${!hasLastBatch || phoneChatBusy ? 'disabled' : ''}></button>
        <button type="button" data-phone-contact-action="extract"></button>
        <button type="button" data-phone-contact-action="generate"></button>
        <button type="button" data-phone-moments-generate></button>
        <button type="button" data-phone-intercept-generate></button>
        <button type="button" data-app="settings"></button>
      </div>
    `, { actions, selecting });
  }

  function interestKeywordsHtml() {
    const active = interestTable.filter((e) => e.status === 'active');
    const channelOptions = [
      interestChannelsAvailable.web ? { id: 'web', label: '网页' } : null,
      interestChannelsAvailable.xiaohongshu ? { id: 'xiaohongshu', label: '小红书' } : null,
      interestChannelsAvailable.weibo ? { id: 'weibo', label: '微博' } : null,
      interestChannelsAvailable.bilibili ? { id: 'bilibili', label: 'B站' } : null,
    ].filter(Boolean);
    if (channelOptions.length > 1) channelOptions.push({ id: 'all', label: '都要' });
    const channelPickerHtml = channelOptions.length ? `
      <div class="cphone-interest-channel-picker">
        <span class="cphone-interest-channel-label">手动查走</span>
        <div class="cphone-interest-channel-seg">
          ${channelOptions.map((opt) => `
            <button type="button" class="cphone-interest-channel-opt ${manualSearchChannel === opt.id ? 'is-active' : ''}" data-manual-channel="${opt.id}">${opt.label}</button>
          `).join('')}
        </div>
      </div>
    ` : '';
    const noChannelNote = channelOptions.length ? '' : '<div class="cphone-empty-note">还没配置联网搜索/小红书解析，手动补充查询暂时用不了，去 API 设置里开一下</div>';
    const socialChannelPickerHtml = SOCIAL_SEARCH_CHANNELS.some((id) => interestChannelsAvailable[id]) ? `
      <div class="cphone-interest-channel-picker">
        <span class="cphone-interest-channel-label">后台社媒渠道</span>
        <div class="cphone-interest-channel-seg">
          ${SOCIAL_SEARCH_CHANNELS.filter((id) => interestChannelsAvailable[id]).map((id) => {
            const active = interestTracking.socialSearchChannels.includes(id);
            return `<button type="button" class="cphone-interest-channel-opt ${active ? 'is-active' : ''}" data-social-search-channel="${id}" aria-pressed="${active ? 'true' : 'false'}">${SOCIAL_SEARCH_CHANNEL_LABELS[id]}</button>`;
          }).join('')}
        </div>
      </div>
    ` : '';

    const rows = active.map((entry) => {
      const hasProgress = INTEREST_CHANNELS_WITH_PROGRESS.includes(entry.channel) && entry.progress;
      const expanded = interestExpandedId === entry.id;
      const metaBits = [
        INTEREST_CHANNEL_LABELS[entry.channel] || entry.channel,
        entry.depth === 'deep' ? '深' : '浅',
        entry.kind === 'root' ? (INTEREST_VOLUME_LABELS[entry.volume] || entry.volume) : '',
        entry.surfaceMode === 'quiet' ? '私下' : '',
      ].filter(Boolean).join(' · ');
      const detailPanel = expanded ? `
        <div class="cphone-int-row-detail">
          <div class="cphone-int-detail-field">
            <span class="cphone-int-detail-label">频道</span>
            <div class="cphone-interest-channel-seg">
              ${INTEREST_CHANNELS.map((c) => `<button type="button" class="cphone-interest-channel-opt ${entry.channel === c ? 'is-active' : ''}" data-interest-channel-set="${esc(entry.id)}" data-value="${c}">${esc(INTEREST_CHANNEL_LABELS[c])}</button>`).join('')}
            </div>
          </div>
          <div class="cphone-int-detail-field">
            <span class="cphone-int-detail-label">提起方式</span>
            <div class="cphone-interest-channel-seg">
              ${INTEREST_SURFACE_MODES.map((mode) => `<button type="button" class="cphone-interest-channel-opt ${entry.surfaceMode === mode ? 'is-active' : ''}" data-interest-surface-set="${esc(entry.id)}" data-value="${mode}" aria-pressed="${entry.surfaceMode === mode ? 'true' : 'false'}">${esc(INTEREST_SURFACE_MODE_LABELS[mode])}</button>`).join('')}
            </div>
          </div>
          ${entry.kind === 'root' ? `
            <div class="cphone-int-detail-field">
              <span class="cphone-int-detail-label" title="内容量决定搜索/裂变的频率：内容多搜得更勤，内容少搜太勤只会搜出重复">体量</span>
              <div class="cphone-interest-channel-seg">
                ${INTEREST_VOLUMES.map((v) => `<button type="button" class="cphone-interest-channel-opt ${entry.volume === v ? 'is-active' : ''}" data-interest-volume-set="${esc(entry.id)}" data-value="${v}">${esc(INTEREST_VOLUME_LABELS[v])}</button>`).join('')}
              </div>
            </div>
          ` : ''}
          ${entry.kind === 'root' ? `
            <div class="cphone-int-detail-field cphone-int-backstory-field">
              <span class="cphone-int-detail-label" title="TA 和这个东西的关系：为什么喜欢、什么时候入坑的。搜索简报、日程、分享的语气都会贴着这层关系来；深/浅档也按这段背景自动判定，不用手动调">背景</span>
              <textarea class="form-input cphone-int-backstory-input" data-interest-backstory="${esc(entry.id)}" maxlength="300" rows="2" placeholder="TA 为什么喜欢这个？可以手写，也可以让 AI 补">${esc(entry.backstory || '')}</textarea>
              <button type="button" class="cphone-interest-kw-manual" data-interest-backstory-ai="${esc(entry.id)}" ${backstoryBusyId ? 'disabled' : ''}>${backstoryBusyId === entry.id ? '补全中…' : 'AI 补背景'}</button>
            </div>
          ` : ''}
          ${hasProgress ? `
            <div class="cphone-interest-progress-card">
              <label class="cphone-interest-progress-field">
                <span>阶段</span>
                <input type="text" class="form-input cphone-interest-progress-stage" data-progress-stage="${esc(entry.id)}" maxlength="40" value="${esc(entry.progress.stage)}" placeholder="没记录" />
              </label>
              ${entry.progress.log.length ? `
                <div class="cphone-interest-progress-log">
                  ${entry.progress.log.slice(-5).reverse().map((l) => `<div class="cphone-interest-progress-log-line">${esc(l.note)}</div>`).join('')}
                </div>
              ` : '<div class="cphone-empty-note">还没有查过，搜过之后这里会记录进展</div>'}
              ${entry.progress.nextGoals.length ? `<div class="cphone-interest-progress-goals">下一步：${entry.progress.nextGoals.map(esc).join('、')}</div>` : ''}
            </div>
          ` : ''}
          <div class="cphone-int-detail-actions">
            ${entry.kind === 'root' && entry.depth === 'deep' ? `<button type="button" class="cphone-interest-kw-manual" data-interest-split="${esc(entry.id)}" ${(splitBusyId || !interestChannelsAvailable.web) ? 'disabled' : ''} title="立即裂变出具体子话题，不用等每日轮转">${splitBusyId === entry.id ? '裂变中…' : '裂变'}</button>` : ''}
            <button type="button" class="cphone-interest-kw-manual" data-interest-manual="${esc(entry.id)}" ${(manualSearchBusyId || !channelOptions.length) ? 'disabled' : ''} title="立即手动查一次，不占日配额">${manualSearchBusyId === entry.id ? '查中…' : '查一次'}</button>
            <button type="button" class="cphone-interest-kw-avoid ${entry.contentPref === 'open' ? '' : 'is-safe'}" data-interest-content-pref="${esc(entry.id)}" title="搜这个词时是否避开拉踩对立/引战骂战、嗑CP同人配对类内容——默认避开，点一下切成不介意看到这些">${entry.contentPref === 'open' ? '不避雷' : '避雷'}</button>
            <button type="button" class="cphone-int-row-del" data-interest-del="${esc(entry.id)}">删除这个词</button>
          </div>
        </div>
      ` : '';
      return `
      <div class="cphone-int-row ${expanded ? 'is-open' : ''}" data-interest-id="${esc(entry.id)}">
        <button type="button" class="cphone-int-row-head" data-interest-toggle="${esc(entry.id)}">
          <span class="cphone-int-row-title">
            <span class="cphone-int-row-name">${esc(entry.keyword)}</span>
            ${entry.kind === 'sub' ? '<span class="cphone-int-row-subtag">子话题</span>' : ''}
          </span>
          <span class="cphone-int-row-tags">${esc(metaBits)}</span>
          <span class="cphone-int-row-caret" aria-hidden="true">${expanded ? '︿' : '﹀'}</span>
        </button>
        ${entry.topic ? `<div class="cphone-int-row-topic">${esc(entry.topic)}</div>` : ''}
        ${detailPanel}
      </div>
    `;
    }).join('');

    const setupCardHtml = (!interestTracking.autoTrackEnabled && !interestTracking.setupCardDismissed) ? `
      <section class="cphone-interest-keywords cphone-interest-setup-card">
        <div class="cphone-section-title">让 TA 的兴趣先跑起来</div>
        <div class="cphone-empty-note">一键按推荐配置开启：${active.length ? '' : 'AI 先按人设铺一批兴趣词，'}后台自动追踪 + 日程参考新资讯，之后想细调再回来改</div>
        <div class="cphone-interest-kw-actions">
          <button type="button" class="btn btn-primary btn-sm cphone-interest-setup-run" ${interestSetupBusy ? 'disabled' : ''}>${interestSetupBusy ? '开启中…' : '一键开启'}</button>
          <button type="button" class="btn btn-outline btn-sm cphone-interest-setup-dismiss" ${interestSetupBusy ? 'disabled' : ''}>先不用</button>
        </div>
      </section>
    ` : '';

    return `
      ${setupCardHtml}
      <section class="cphone-interest-keywords">
        <div class="cphone-section-head">
          <div class="cphone-section-title">兴趣关键词</div>
          <label class="cphone-interest-track-toggle" title="默认关闭，开启后这个角色才会参与后台自动轮转；关掉词表还在，只是不会被后台自动搜">
            <input type="checkbox" class="cphone-interest-track-input" ${interestTracking.autoTrackEnabled ? 'checked' : ''} />
            <span>自动追踪</span>
          </label>
        </div>
        ${interestTracking.autoTrackEnabled ? `
          <div class="cphone-interest-kw-actions">
            <label class="cphone-interest-track-toggle" title="后台自动轮转的冷却间隔，隔多久才让这个角色搜一次">
              <span>多久搜一次（小时）</span>
              <input type="number" class="form-input cphone-share-impulse-input" data-track-field="autoTrackIntervalHours" min="${AUTO_TRACK_INTERVAL_HOURS_MIN}" max="${AUTO_TRACK_INTERVAL_HOURS_MAX}" step="1" value="${interestTracking.autoTrackIntervalHours}" />
            </label>
            <label class="cphone-interest-track-toggle" title="每次自动轮转搜几个候选词，越多越全但越费额度">
              <span>一轮搜几条</span>
              <input type="number" class="form-input cphone-share-impulse-input" data-track-field="autoTrackCandidatesPerRound" min="1" max="${AUTO_TRACK_CANDIDATES_MAX}" step="1" value="${interestTracking.autoTrackCandidatesPerRound}" />
            </label>
          </div>
          <div class="cphone-usage-stats-line">${dailyBudgetLine()}</div>
        ` : ''}
        ${socialChannelPickerHtml}
        ${inProgressLine()}
        ${rows || '<div class="cphone-empty-note">这张表是 TA 的搜索候选词池：深档的大类词会先裂变出具体子话题（如「XX 最新活动」），再去搜索沉淀成简报，聊天时 TA 能主动聊起——开启上面的「自动追踪」后台才会自动搜</div>'}
        <div class="cphone-interest-kw-add">
          <input type="text" class="form-input cphone-interest-kw-input" maxlength="60" placeholder="加一个具体的词（作品名 / 品名 / 地点…）" />
          <button type="button" class="btn btn-primary btn-sm cphone-interest-kw-add-btn">添加</button>
        </div>
        <div class="cphone-interest-kw-actions cphone-interest-kw-toolbar">
          <button type="button" class="btn btn-outline btn-sm cphone-interest-grow" ${interestGrowBusy ? 'disabled' : ''}>${interestGrowBusy ? '补充中…' : 'AI 补充关键词'}</button>
          ${active.length ? `<button type="button" class="btn btn-outline btn-sm cphone-interest-reclassify" ${interestReclassifyBusy ? 'disabled' : ''} title="老词条升级前只能粗略归类，点一下让 AI 按词条本身重新判断频道">${interestReclassifyBusy ? '分类中…' : '重新分类频道'}</button>` : ''}
          ${channelPickerHtml}
        </div>
        ${noChannelNote}
      </section>
      <section class="cphone-interest-keywords cphone-share-post-section">
        <div class="cphone-section-head">
          <div class="cphone-section-title">分享真实帖子精搜</div>
          <label class="cphone-interest-track-toggle" title="搜列表 → AI 挑一条 TA 真会点开的 → 深读全文存进素材池和浏览记录，聊天时可分享真实链接。会多消耗解析额度，默认关。">
            <input type="checkbox" class="cphone-share-post-toggle" ${interestTracking.sharePostSearchEnabled ? 'checked' : ''} />
            <span>开启</span>
          </label>
        </div>
        ${interestTracking.sharePostSearchEnabled ? `
          <div class="cphone-debug-line">
            <span>${esc(formatInterestRotationDebugLine(interestRotationDebug, selectedId))}</span>
            <button type="button" class="cphone-debug-line-btn cphone-interest-rotation-test" ${interestRotationTestBusy ? 'disabled' : ''}>${interestRotationTestBusy ? '测试中…' : '立即测试一次'}</button>
          </div>
        ` : ''}
        ${interestTracking.sharePostSearchEnabled ? `
          ${SHARE_SEARCH_CHANNELS.some((id) => interestChannelsAvailable[id]) ? `
            <div class="cphone-interest-channel-picker">
              <span class="cphone-interest-channel-label">分享渠道</span>
              <div class="cphone-interest-channel-seg">
                ${SHARE_SEARCH_CHANNELS.filter((id) => interestChannelsAvailable[id]).map((id) => {
                  const active = normalizeShareSearchChannels(interestTracking.shareSearchChannels).includes(id);
                  return `<button type="button" class="cphone-interest-channel-opt ${active ? 'is-active' : ''}" data-share-post-channel="${id}" aria-pressed="${active ? 'true' : 'false'}">${SHARE_SEARCH_CHANNEL_LABELS[id]}${id === 'web' ? '（免费）' : ''}</button>`;
                }).join('')}
              </div>
            </div>
          ` : ''}
          <div class="cphone-interest-kw-add">
            <input type="text" class="form-input cphone-share-post-input" maxlength="60" placeholder="想让 TA 去搜的关键词" value="${esc(sharePostKeyword)}" />
            <button type="button" class="btn btn-primary btn-sm cphone-share-post-run" ${sharePostBusy || !SHARE_SEARCH_CHANNELS.some((id) => interestChannelsAvailable[id] && normalizeShareSearchChannels(interestTracking.shareSearchChannels).includes(id)) ? 'disabled' : ''}>${sharePostBusy ? '精搜中…' : '立即精搜'}</button>
          </div>
          <div class="cphone-interest-kw-actions">
            <button type="button" class="btn btn-outline btn-sm cphone-share-post-auto" ${sharePostBusy || !SHARE_SEARCH_CHANNELS.some((id) => interestChannelsAvailable[id] && normalizeShareSearchChannels(interestTracking.shareSearchChannels).includes(id)) ? 'disabled' : ''} title="从 TA 的兴趣表自动挑词（优先最新衍生子话题），只在上方勾选的分享渠道里搜">${sharePostBusy ? '精搜中…' : 'AI 选词精搜'}</button>
          </div>
          ${normalizeShareSearchChannels(interestTracking.shareSearchChannels).some((id) => id !== 'web' && interestChannelsAvailable[id]) ? `<label class="cphone-interest-track-toggle cphone-share-post-comments">
            <input type="checkbox" class="cphone-share-post-comments-input" ${interestTracking.includeHotComments ? 'checked' : ''} />
            <span>连带热评一起看（多一次调用）</span>
          </label>` : ''}
          <div class="cphone-interest-kw-add">
            <input type="text" class="form-input cphone-avoid-notes-input" maxlength="200" placeholder="不想看到的雷点（如：CP同人、骂战），精搜挑内容时会避开" value="${esc(interestTracking.avoidNotes)}" />
            <button type="button" class="btn btn-outline btn-sm cphone-avoid-notes-save">保存</button>
          </div>
          ${!SHARE_SEARCH_CHANNELS.some((id) => interestChannelsAvailable[id]) ? '<div class="cphone-empty-note">还没配置网页搜索或小红书/微博/B站解析，去 API 设置里填一下</div>' : ''}
        ` : ''}
      </section>
      <section class="cphone-interest-keywords">
        <div class="cphone-section-head">
          <div class="cphone-section-title">主动分享节奏</div>
        </div>
        <label class="cphone-interest-track-toggle" title="TA 每天最多攒/分享几条真实帖子；调到 0 等于暂停主动分享，但精搜/浏览记录不受影响">
          <span>每天最多分享（条）</span>
          <input type="number" class="form-input cphone-share-impulse-input" data-track-field="shareDailyTarget" min="0" max="${SHARE_DAILY_TARGET_MAX}" step="1" value="${interestTracking.shareDailyTarget}" />
        </label>
        <div class="cphone-interest-channel-picker">
          <span class="cphone-interest-channel-label">主动性</span>
          <div class="cphone-interest-channel-seg">
            ${[
              { id: 'low', label: '偶尔' },
              { id: 'normal', label: '正常' },
              { id: 'high', label: '常想分享' },
            ].map((opt) => `
              <button type="button" class="cphone-interest-channel-opt ${interestTracking.shareEagerness === opt.id ? 'is-active' : ''}" data-share-eagerness="${opt.id}">${opt.label}</button>
            `).join('')}
          </div>
        </div>
        <label class="cphone-interest-track-toggle" title="TA 发的最后一条消息，你超过这个时长没回，允许 TA 拿分享当由头破冰">
          <span>已读不回超过（小时）</span>
          <input type="number" class="form-input cphone-share-impulse-input" data-impulse-field="coldReplyHours" min="1" max="72" step="1" value="${shareImpulseSettings.coldReplyHours}" />
        </label>
        <label class="cphone-interest-track-toggle" title="距上次真的分享出去超过这个时长（含从没分享过），允许主动分享一次，不用死等随机时机">
          <span>没分享超过（小时）</span>
          <input type="number" class="form-input cphone-share-impulse-input" data-impulse-field="shareIntervalHours" min="1" max="240" step="1" value="${shareImpulseSettings.shareIntervalHours}" />
        </label>
      </section>
      ${userSocialWatchHtml()}
      <div class="cphone-interest-tutorial-link">
        <button type="button" class="cphone-quiet-link cphone-interest-tutorial-btn">使用说明：TikHub、调用成本、各档位是什么意思 →</button>
      </div>
    `;
  }

  function userSocialWatchHtml() {
    const cfg = userSocialWatch;
    const lastCheckedLabel = cfg.lastCheckedAt
      ? new Date(cfg.lastCheckedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
      : '还没看过';
    const postsRows = userSocialWatchPosts.slice(0, 8).map((p) => {
      const date = p.foundAt ? new Date(p.foundAt) : null;
      const dateStr = date ? `${date.getMonth() + 1}/${date.getDate()}` : '';
      const title = esc(p.title || (p.desc || '').slice(0, 24) || '（无标题）');
      const head = p.url ? `<a class="cphone-link-preview" href="${esc(p.url)}">${title}</a>` : title;
      return `<div class="cphone-usage-stats-row cphone-material-pool-row">
        <span>${head}</span>
        <span>${dateStr ? `${dateStr} · ` : ''}${p.images?.length ? `配图${p.images.length} · ` : ''}${p.commentHighlights?.length ? `热评${p.commentHighlights.length}` : ''}</span>
      </div>`;
    }).join('');
    return `
      <section class="cphone-interest-keywords cphone-user-social-section">
        <div class="cphone-section-head">
          <div class="cphone-section-title">TA 关注你的小红书</div>
          <label class="cphone-interest-track-toggle" title="只读小红书上公开可见的内容；抓取用你自己的 TikHub key，内容只存在你的设备上，我们不会额外保存或上传">
            <input type="checkbox" class="cphone-user-social-toggle" ${cfg.enabled ? 'checked' : ''} ${cfg.profileInput ? '' : 'disabled'} />
            <span>开启</span>
          </label>
        </div>
        ${cfg.profileInput ? '' : '<div class="cphone-empty-note">粘贴你自己的小红书主页分享链接，授权后 TA 大约每天看一次你发了什么，聊天里能自然接上。只读公开内容，抓取走你自己的 TikHub key，内容只存本地。</div>'}
        <div class="cphone-interest-kw-add">
          <input type="text" class="form-input cphone-user-social-input" maxlength="500" placeholder="你的小红书主页分享链接" value="${esc(userSocialWatchProfileDraft)}" />
          <button type="button" class="btn btn-primary btn-sm cphone-user-social-save">保存</button>
        </div>
        ${cfg.enabled ? `
          <div class="cphone-interest-channel-picker">
            <span class="cphone-interest-channel-label">披露方式</span>
            <div class="cphone-interest-channel-seg">
              <button type="button" class="cphone-interest-channel-opt ${cfg.disclosureMode === 'secret' ? 'is-active' : ''}" data-social-disclosure="secret">偷偷关注</button>
              <button type="button" class="cphone-interest-channel-opt ${cfg.disclosureMode === 'open' ? 'is-active' : ''}" data-social-disclosure="open">光明正大</button>
            </div>
          </div>
          <div class="cphone-interest-kw-actions">
            <button type="button" class="btn btn-outline btn-sm cphone-user-social-check" ${userSocialWatchBusy ? 'disabled' : ''}>${userSocialWatchBusy ? '查看中…' : '立即看一次'}</button>
            <button type="button" class="btn btn-outline btn-sm cphone-user-social-posts-toggle">${showUserSocialPosts ? '收起动态 ▲' : `已同步 ${userSocialWatchPosts.length} 条 ▾`}</button>
            <button type="button" class="btn btn-outline btn-sm cphone-user-social-reset" title="换链接或想清空重来时用">重新连接</button>
          </div>
          ${showUserSocialPosts ? `<div class="cphone-usage-stats-panel">
            <div class="cphone-usage-stats-line">上次查看：${esc(lastCheckedLabel)}${cfg.lastError ? ` · 上次出错：${esc(cfg.lastError)}` : ''}</div>
            <div class="cphone-usage-stats-body">${postsRows || '<div class="cphone-usage-stats-row cphone-usage-stats-empty">还没同步到内容</div>'}</div>
          </div>` : ''}
        ` : ''}
      </section>
      <section class="cphone-interest-databar">
        <button type="button" class="cphone-databar-toggle cphone-usage-stats-toggle">${showUsageStats ? '收起今日调用 ▲' : '今日调用 ▾'}</button>
        <button type="button" class="cphone-databar-toggle cphone-material-pool-toggle">${showMaterialPool ? '收起素材池 ▲' : '素材池 ▾'}</button>
      </section>
      ${showUsageStats ? `<div class="cphone-usage-stats-panel">${usageStatsHtml()}</div>` : ''}
      ${showMaterialPool ? `<div class="cphone-usage-stats-panel">${materialPoolHtml()}</div>` : ''}
    `;
  }

  function usageStatsHtml() {
    if (!usageStatsSummary) return '<div class="cphone-usage-stats-body">加载中…</div>';
    const reasonRows = Object.entries(usageStatsSummary.byReason || {})
      .map(([reason, count]) => `<div class="cphone-usage-stats-row"><span>· ${esc(reasonLabel(reason) || reason)}</span><span>${count}</span></div>`)
      .join('');
    return `
      <div class="cphone-usage-stats-body">
        <div class="cphone-usage-stats-line">今日共 ${usageStatsSummary.total} 次 · 成功 ${usageStatsSummary.ok} · 失败 ${usageStatsSummary.fail}${usageStatsSummary.manual ? ` · 手动 ${usageStatsSummary.manual}` : ''}</div>
        ${Object.entries(usageStatsSummary.byCategory).map(([cat, count]) => `<div class="cphone-usage-stats-row"><span>${esc(usageCategoryLabel(cat))}</span><span>${count}</span></div>`).join('') || '<div class="cphone-usage-stats-row cphone-usage-stats-empty">今天还没有调用记录</div>'}
        ${usageStatsSummary.fail ? `<div class="cphone-usage-stats-line" style="margin-top:6px;">失败原因</div>${reasonRows}` : ''}
      </div>
    `;
  }

  function materialPoolHtml() {
    const sourceLabel = { web: '网页', xiaohongshu: '小红书', weibo: '微博', bilibili: 'B站' };
    const todayKey = dateKey;
    const isToday = (ts) => ts && searchLogDayKey(ts) === todayKey;
    const readyPosts = materialPoolPosts.filter((p) => p.depth === 'read' && p.url);
    const pendingCount = readyPosts.filter((p) => !p.sharedAt).length;
    const sharedTodayCount = readyPosts.filter((p) => p.sharedAt && isToday(p.sharedAt)).length;
    const target = Number(interestTracking.shareDailyTarget) || 0;
    const summaryLine = interestTracking.sharePostSearchEnabled
      ? `<div class="cphone-usage-stats-line">今日已分享 ${sharedTodayCount} 条 · 目标 ${target} 条 · 待分享池 ${pendingCount} 条${pendingCount === 0 && target > 0 ? '（池子空了，等下一轮补货或手动精搜一次）' : ''}</div>`
      : '';
    if (!materialPoolPosts.length) {
      return `<div class="cphone-usage-stats-body">${summaryLine}<div class="cphone-usage-stats-row cphone-usage-stats-empty">素材池还是空的——手动查一次或等后台轮转攒一些</div></div>`;
    }
    const ordered = [...materialPoolPosts].sort((a, b) => (b.depth === 'read' ? 1 : 0) - (a.depth === 'read' ? 1 : 0));
    const rows = ordered.slice(0, 15).map((p) => {
      const date = p.foundAt ? new Date(p.foundAt) : null;
      const dateStr = date ? `${date.getMonth() + 1}/${date.getDate()}` : '';
      const name = esc(p.title || p.summary || '').slice(0, 60) || '（无标题）';
      const head = p.url ? `<a class="cphone-link-preview" href="${esc(p.url)}">${name}</a>` : name;
      const depthTag = p.depth === 'read' ? (p.sharedAt ? '★ 已分享过' : '★ 深读可分享') : '列表扫过';
      return `<div class="cphone-usage-stats-row cphone-material-pool-row">
        <span>${head}${p.reason ? `<em class="cphone-material-pool-reason">精搜理由：${esc(p.reason)}</em>` : ''}</span>
        <span>${depthTag} · ${esc(sourceLabel[p.source] || p.source || '')}${p.keyword ? ` · ${esc(p.keyword)}` : ''}${dateStr ? ` · ${dateStr}` : ''}</span>
      </div>`;
    }).join('');
    return `<div class="cphone-usage-stats-body">
      ${summaryLine}
      <div class="cphone-usage-stats-line">TA 最近刷到过的——「★ 深读可分享」是精搜细看过全文，聊天里能详细聊+主动分享；「列表扫过」只是搜索时扫到标题，只能顺口带一句</div>
      ${rows}
    </div>`;
  }

  /** 把 interval+candidates 两个滑块换算成一句"大概每天搜几次"，配合今日调用里的实际次数对照着看。 */
  function dailyBudgetLine() {
    const interval = Number(interestTracking.autoTrackIntervalHours) || 12;
    const perRound = Number(interestTracking.autoTrackCandidatesPerRound) || 2;
    const roundsPerDay = 24 / Math.max(1, interval);
    const estPerDay = Math.max(1, Math.round(roundsPerDay * perRound * 10) / 10);
    const actualToday = usageStatsSummary
      ? Object.entries(usageStatsSummary.byCategory || {})
        .filter(([cat]) => cat === 'interest_orchestrator' || cat === 'interest_social' || cat === 'interest_xhs')
        .reduce((sum, [, count]) => sum + count, 0)
      : null;
    const splitToday = usageStatsSummary ? (usageStatsSummary.byCategory?.interest_split || 0) : 0;
    const nextSplit = pickRootForSplit(interestTable);
    return `预计每天约搜 ${estPerDay} 次${actualToday !== null ? `（今天实际已搜 ${actualToday} 次）` : ''} · 今天裂变 ${splitToday} 次${nextSplit ? ` · 下一个待裂变：${esc(nextSplit.keyword)}` : ''}`;
  }

  /** 摘出「正在推进」的兴趣：最近 3 天有过进展记录、或最近被搜过一次的具体子话题，让用户一眼看到"什么在动"。 */
  function inProgressLine() {
    const now = Date.now();
    const RECENT_MS = 3 * 86400000;
    const active = interestTable.filter((e) => e.status === 'active');
    const progressing = active
      .filter((e) => (e.progress?.lastAdvancedAt && now - e.progress.lastAdvancedAt < RECENT_MS) || (e.kind === 'sub' && e.lastUsedAt && now - e.lastUsedAt < RECENT_MS))
      .sort((a, b) => Math.max(b.progress?.lastAdvancedAt || 0, b.lastUsedAt || 0) - Math.max(a.progress?.lastAdvancedAt || 0, a.lastUsedAt || 0))
      .slice(0, 5);
    if (!progressing.length) return '';
    const names = progressing.map((e) => esc(e.keyword)).join('、');
    return `<div class="cphone-usage-stats-line">推进中：${names}</div>`;
  }

  function usageCategoryLabel(cat) {
    const map = {
      interest_orchestrator: '兴趣自动轮转',
      interest_social: '兴趣自动轮转 · 社媒',
      interest_manual: '兴趣手动补充',
      interest_split: '大类词裂变',
      interest_xhs: '兴趣 · 小红书',
      share_post_search: '分享帖精搜 · 搜列表',
      share_post_detail: '分享帖精搜 · 取正文',
      need_search: '聊天联网查证',
      user_social_watch: 'TA 关注你的小红书',
    };
    return map[cat] || cat || '其他';
  }

  function mainHtml() {
    if (!selectedId) {
      return `
        <section class="cphone-intro">
          <div class="cphone-intro-title">选择一部手机</div>
          ${unavailableRequestedId ? '<div class="cphone-empty-note">当前身份未绑定这位角色，无法打开其手机</div>' : ''}
          ${chooserHtml()}
        </section>`;
    }

    const detailRecord = (phone?.browserRecords || []).find((r) => r.id === openRecordId)
      || (phone?.interestRecords || []).find((r) => r.id === openRecordId);
    const previewRecord = photoPreview?.recordId
      ? (phone?.photoRecords || []).find((r) => String(r.id || '') === String(photoPreview.recordId))
        || (chatPhotoRecords || []).find((r) => String(r.id || '') === String(photoPreview.recordId))
      : null;
    const wallpaper = String(resolvedPhoneWallpaper || '').trim();
    const overlay = Math.max(0, Math.min(0.82, Number(phone?.shellPreferences?.wallpaperOverlay ?? 0.28) || 0));
    const statusTime = new Date(nowTs).toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    return `
      <div class="cphone-stage">
        <section class="cphone-device-frame is-${esc(phone?.shellPreferences?.iconTone || 'graphite')} is-wallpaper-${esc(phone?.shellPreferences?.wallpaperPreset || 'default')}${wallpaper ? ' has-wallpaper' : ''}">
          <div class="cphone-device-screen">
            ${wallpaper ? `<img class="cphone-device-wallpaper" src="${esc(wallpaper)}" alt="" decoding="async" fetchpriority="low">` : ''}
            <span class="cphone-device-wallpaper-overlay" style="--cphone-wallpaper-overlay:${overlay}"></span>
            <div class="cphone-statusbar">
              <time class="cphone-status-time">${esc(statusTime)}</time>
              <span class="cphone-dynamic-island" aria-hidden="true"></span>
              <span class="cphone-status-icons" aria-hidden="true">
                <svg viewBox="0 0 18 12" aria-hidden="true"><path d="M1 10h2V7H1zm4 0h2V5H5zm4 0h2V3H9zm4 0h2V1h-2z" fill="currentColor"/></svg>
                <svg viewBox="0 0 16 12" aria-hidden="true"><path d="M1 4.8C4.8 1 11.2 1 15 4.8M3.7 7.4c2.4-2.3 6.2-2.3 8.6 0M6.4 10c.9-.8 2.3-.8 3.2 0" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>
                <svg viewBox="0 0 23 12" aria-hidden="true"><rect x="1" y="2" width="18" height="8" rx="2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M20.5 4.3v3.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><rect x="3" y="4" width="12" height="4" rx="1" fill="currentColor"/></svg>
              </span>
            </div>
            <div class="cphone-os-content is-${esc(activeApp)}">${activeAppHtml()}</div>
            ${phoneGeneration.active ? generationHudHtml() : ''}
            <button type="button" class="cphone-home-indicator cphone-phone-home" aria-label="返回手机桌面"></button>
          </div>
        </section>
      </div>
      ${browserPageModal(detailRecord)}
      ${photoPreviewModal(photoPreview, previewRecord, {
        generating: photoGenBusy,
        generatingRecordId: photoGenRecordId,
      })}`;
  }

  function generationHudHtml() {
    return `
      <section class="cphone-generation-hud" role="status" aria-live="polite">
        <span class="cphone-generation-spinner" aria-hidden="true"></span>
        <div><strong>${esc(phoneGeneration.scope || '正在生成')}</strong><em>${esc(phoneGeneration.message || '正在请求模型…')}</em></div>
        <button type="button" data-phone-generation-cancel>取消</button>
      </section>`;
  }

  function updateGenerationHudMessage(message) {
    phoneGeneration.message = message;
    const em = container.querySelector('.cphone-generation-hud em');
    if (em) {
      em.textContent = message || '正在请求模型…';
      return true;
    }
    return false;
  }

  /** Inner OS screen for the active app (desktop or subpage). Used by soft paint. */
  function activeAppHtml() {
    const character = selectedCharacter();
    const name = character?.customNickname || character?.name || 'TA';
    const pickedBlock = plan ? pickCurrentPlanBlock(plan, nowTs, scheduleTimeZone) : null;
    const currentBlock = isPlanBlockActiveAt(pickedBlock, nowTs, scheduleTimeZone) ? pickedBlock : null;
    const effectiveState = resolveEffectiveCharacterState({
      runtimeState,
      sceneFact: liveState?.sceneFact || null,
      scheduleBlock: currentBlock,
      allowSceneScheduleOverride: liveState?.policy?.sceneScheduleOverrideAllowed !== false,
      now: nowTs,
    });
    const currentStep = currentBlock ? pickCurrentFlowStep(currentBlock, nowTs, scheduleTimeZone) : null;
    const canVisitNow = currentBlock && !effectiveState.scheduleOverridden
      ? blockIsActiveNow(currentBlock, nowTs, scheduleTimeZone)
      : false;
    const resumableSession = findResumableActivitySession(activitySessions, selectedId, nowTs);
    const autoOn = isDailyLifeAutoEnabled(autoSettings, selectedId);
    const proactive = getScheduleProactiveSettings(phone);
    if (activeApp === 'home') {
      return phoneDesktopHtml({
        name,
        character,
        currentBlock,
        effectiveState,
        plan,
      });
    }
    if (activeApp === 'schedule') {
      return scheduleAppHtml({
        name,
        currentBlock,
        currentStep,
        effectiveState,
        autoOn,
        proactive,
        canVisitNow,
        resumableSession,
      });
    }
    return recordsAppHtml(activeApp);
  }

  function phoneAppOpeningHtml() {
    if (activeApp === 'home') return activeAppHtml();
    const label = activeApp === 'schedule'
      ? '日历'
      : (PHONE_APPS.find((app) => app.id === activeApp)?.label || '应用');
    return subPageShell(label, '<div class="cphone-app-opening" role="status" aria-live="polite"><span></span>载入中</div>');
  }

  function bindInterestKeywordEvents() {
    if (activeApp !== 'interests' || !selectedId) return;
    const addEntry = async () => {
      const input = container.querySelector('.cphone-interest-kw-input');
      const keyword = String(input?.value || '').trim();
      if (!keyword) return;
      if (!isUsableInterestKeyword(keyword)) {
        showToast('换个更具体的词，太泛的词搜不出东西');
        return;
      }
      await saveInterestEntry(user.id, selectedId, { keyword, source: 'user' });
      await paint();
    };
    container.querySelector('.cphone-interest-kw-add-btn')?.addEventListener('click', addEntry);
    container.querySelector('.cphone-interest-kw-input')?.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); addEntry(); }
    });
    container.querySelectorAll('[data-interest-del]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await deleteInterestEntry(user.id, selectedId, btn.getAttribute('data-interest-del'));
        await paint();
      });
    });
    container.querySelectorAll('[data-interest-channel-set]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-interest-channel-set');
        const value = btn.getAttribute('data-value');
        const entry = interestTable.find((e) => e.id === id);
        if (!entry || entry.channel === value) return;
        await saveInterestEntry(user.id, selectedId, { ...entry, channel: value });
        await paint();
      });
    });
    container.querySelectorAll('[data-interest-volume-set]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-interest-volume-set');
        const value = btn.getAttribute('data-value');
        const entry = interestTable.find((e) => e.id === id);
        if (!entry || entry.volume === value) return;
        await saveInterestEntry(user.id, selectedId, { ...entry, volume: value });
        await paint();
      });
    });
    container.querySelectorAll('[data-interest-surface-set]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-interest-surface-set');
        const value = btn.getAttribute('data-value');
        const entry = interestTable.find((e) => e.id === id);
        if (!entry || entry.surfaceMode === value || !INTEREST_SURFACE_MODES.includes(value)) return;
        await saveInterestEntry(user.id, selectedId, { ...entry, surfaceMode: value });
        await paint();
      });
    });
    container.querySelectorAll('[data-interest-toggle]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-interest-toggle');
        interestExpandedId = interestExpandedId === id ? '' : id;
        await paint();
      });
    });
    container.querySelectorAll('[data-progress-stage]').forEach((input) => {
      input.addEventListener('change', async () => {
        const id = input.getAttribute('data-progress-stage');
        await applyInterestProgressPatch(user.id, selectedId, id, { stage: input.value, allowStageReset: true });
        await paint();
      });
    });
    container.querySelectorAll('[data-interest-content-pref]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-interest-content-pref');
        const entry = interestTable.find((e) => e.id === id);
        if (!entry) return;
        await saveInterestEntry(user.id, selectedId, { ...entry, contentPref: entry.contentPref === 'open' ? 'safe' : 'open' });
        await paint();
      });
    });
    container.querySelectorAll('[data-interest-backstory]').forEach((input) => {
      input.addEventListener('change', async () => {
        const id = input.getAttribute('data-interest-backstory');
        await saveInterestBackstory(user.id, selectedId, id, input.value);
        await paint();
      });
    });
    container.querySelectorAll('[data-interest-backstory-ai]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-interest-backstory-ai');
        if (backstoryBusyId) return;
        const entry = interestTable.find((e) => e.id === id);
        // 已有背景（不管手填还是 AI 写的）时先清掉再让 AI 重写，避免悄悄覆盖用户内容
        if (entry?.backstory) {
          if (!window.confirm('已有背景故事，让 AI 重写并覆盖？')) return;
          await saveInterestBackstory(user.id, selectedId, id, '');
        }
        backstoryBusyId = id;
        await paint();
        try {
          const updated = await growInterestBackstories({
            userId: user.id, characterId: selectedId, character: selectedCharacter(), user, entryIds: [id],
          });
          if (!updated.length) showToast('这次没写出合适的背景，可以再试一次或手填');
        } catch (err) {
          showToast(err?.message || 'AI 补背景失败', 4000);
        } finally {
          backstoryBusyId = '';
          await paint();
        }
      });
    });
    container.querySelector('.cphone-interest-grow')?.addEventListener('click', async () => {
      if (interestGrowBusy) return;
      interestGrowBusy = true;
      await paint();
      try {
        // 有大类词该裂变了就优先裂变出具体子话题，不再无脑一直造新词——
        // 词表本来就该先把已有的深挖兴趣具体化，而不是越堆越多没细化的大词。
        const rootDue = pickRootForSplit(interestTable);
        if (rootDue) {
          const result = await runManualInterestSplit({
            userId: user.id, characterId: selectedId, character: selectedCharacter(), rootEntry: rootDue,
          });
          if (result.subs?.length) showToast(`「${rootDue.keyword}」裂变出了 ${result.subs.length} 个具体子话题`);
          else showToast(splitFailReason(result.reason, rootDue.keyword));
        } else {
          const added = await growInterestTableFromContext({
            userId: user.id,
            characterId: selectedId,
            character: selectedCharacter(),
            user,
          });
          showToast(added.length ? `补充了 ${added.length} 个关键词` : '这次没有补出新词');
        }
      } catch (err) {
        showToast(err?.message || 'AI 补充失败', 4000);
      } finally {
        interestGrowBusy = false;
        await paint();
      }
    });
    container.querySelector('.cphone-interest-reclassify')?.addEventListener('click', async () => {
      if (interestReclassifyBusy) return;
      interestReclassifyBusy = true;
      await paint();
      try {
        const result = await reclassifyInterestChannels({
          userId: user.id, characterId: selectedId, character: selectedCharacter(),
        });
        showToast(result.updated ? `${result.updated} 个词条更新了频道` : '分类结果和现有的一样，没有改动');
      } catch (err) {
        showToast(err?.message || '重新分类失败', 4000);
      } finally {
        interestReclassifyBusy = false;
        await paint();
      }
    });

    container.querySelectorAll('[data-interest-split]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (splitBusyId) return;
        const id = btn.getAttribute('data-interest-split');
        const entry = interestTable.find((e) => e.id === id);
        if (!entry) return;
        splitBusyId = id;
        await paint();
        try {
          const result = await runManualInterestSplit({
            userId: user.id, characterId: selectedId, character: selectedCharacter(), rootEntry: entry,
          });
          if (result.subs?.length) showToast(`裂变出了 ${result.subs.length} 个具体子话题`);
          else showToast(splitFailReason(result.reason, entry.keyword));
        } catch (err) {
          showToast(err?.message || '裂变失败', 4000);
        } finally {
          splitBusyId = '';
          await paint();
        }
      });
    });

    container.querySelector('.cphone-interest-setup-run')?.addEventListener('click', async () => {
      if (interestSetupBusy || !selectedId) return;
      interestSetupBusy = true;
      await paint();
      try {
        const hadWords = interestTable.some((e) => e.status === 'active');
        interestTracking = await saveInterestTrackingSettings(user.id, selectedId, { autoTrackEnabled: true });
        await saveScheduleEventSettings(user.id, selectedId, { eventNewsEnabled: true });
        let addedCount = 0;
        if (!hadWords) {
          const added = await growInterestTableFromContext({
            userId: user.id,
            characterId: selectedId,
            character: selectedCharacter(),
            user,
          }).catch(() => []);
          addedCount = Array.isArray(added) ? added.length : 0;
        }
        showToast(addedCount
          ? `已开启：AI 按人设铺了 ${addedCount} 个兴趣词，自动追踪和日程新资讯都打开了`
          : '已开启自动追踪和日程新资讯');
      } catch (err) {
        showToast(err?.message || '开启失败，稍后再试');
      } finally {
        interestSetupBusy = false;
        await paint();
      }
    });
    container.querySelector('.cphone-interest-setup-dismiss')?.addEventListener('click', async () => {
      if (interestSetupBusy || !selectedId) return;
      interestTracking = await saveInterestTrackingSettings(user.id, selectedId, { setupCardDismissed: true });
      await paint();
    });
    container.querySelector('.cphone-interest-track-input')?.addEventListener('change', async (ev) => {
      interestTracking = await saveInterestTrackingSettings(user.id, selectedId, { autoTrackEnabled: !!ev.target.checked });
      await saveCharacterPhoneAutomationConfig(user.id, selectedId, {
        interestTrack: { autoTrackEnabled: !!ev.target.checked },
      }).catch(() => {});
      showToast(interestTracking.autoTrackEnabled ? '已开启自动追踪' : '已关闭，词表还在，只是不会被后台自动搜了');
    });

    container.querySelector('.cphone-share-post-toggle')?.addEventListener('change', async (ev) => {
      interestTracking = await saveInterestTrackingSettings(user.id, selectedId, { sharePostSearchEnabled: !!ev.target.checked });
      await saveCharacterPhoneAutomationConfig(user.id, selectedId, {
        share: { sharePostSearchEnabled: !!ev.target.checked },
      }).catch(() => {});
      await paint();
    });

    container.querySelectorAll('.cphone-share-impulse-input').forEach((input) => {
      input.addEventListener('change', async () => {
        const trackField = input.getAttribute('data-track-field');
        if (trackField) {
          const value = Number(input.value);
          if (!Number.isFinite(value) || value < 0) { await paint(); return; }
          interestTracking = await saveInterestTrackingSettings(user.id, selectedId, { [trackField]: value });
          await saveCharacterPhoneAutomationConfig(user.id, selectedId, {
            interestTrack: { [trackField]: value },
          }).catch(() => {});
          await paint();
          return;
        }
        const field = input.getAttribute('data-impulse-field');
        const value = Number(input.value);
        if (!(value > 0)) { await paint(); return; }
        shareImpulseSettings = await saveShareImpulseSettings(user.id, selectedId, { [field]: value });
      });
    });

    container.querySelectorAll('[data-share-eagerness]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        interestTracking = await saveInterestTrackingSettings(user.id, selectedId, { shareEagerness: btn.getAttribute('data-share-eagerness') });
        await saveCharacterPhoneAutomationConfig(user.id, selectedId, {
          share: { shareEagerness: btn.getAttribute('data-share-eagerness') },
        }).catch(() => {});
        await paint();
      });
    });

    container.querySelectorAll('[data-social-search-channel]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-social-search-channel');
        if (!id) return;
        const current = normalizeSocialSearchChannels(interestTracking.socialSearchChannels);
        const next = new Set(current);
        if (next.has(id)) {
          if (next.size <= 1) {
            showToast('至少保留一个社媒渠道');
            return;
          }
          next.delete(id);
        } else {
          next.add(id);
        }
        interestTracking = await saveInterestTrackingSettings(user.id, selectedId, {
          socialSearchChannels: [...next],
        });
        await saveCharacterPhoneAutomationConfig(user.id, selectedId, {
          interestTrack: { socialSearchChannels: [...next] },
        }).catch(() => {});
        await paint();
      });
    });

    container.querySelectorAll('[data-manual-channel]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        manualSearchChannel = btn.getAttribute('data-manual-channel');
        await paint();
      });
    });

    container.querySelectorAll('[data-interest-manual]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (manualSearchBusyId) return;
        const id = btn.getAttribute('data-interest-manual');
        const entry = interestTable.find((e) => e.id === id);
        if (!entry) return;
        const allChannelIds = ['web', 'xiaohongshu', 'weibo', 'bilibili'].filter((c) => interestChannelsAvailable[c]);
        const channels = manualSearchChannel === 'all' ? allChannelIds : [manualSearchChannel];
        manualSearchBusyId = id;
        await paint();
        try {
          const result = await runManualInterestSearch({
            userId: user.id, characterId: selectedId, character: selectedCharacter(), entry, channels,
          });
          if (result.card) showToast(`已沉淀一条简报：${result.card.name}`);
          else if (result.materials?.length) showToast(`搜到 ${result.materials.length} 条素材，但没攒出简报（可能素材太薄）`);
          else if (result.reason === 'api_error') showToast(`接口报错：${result.error || '未知错误'}`, 5000);
          else if (result.reason === 'quota_exceeded') showToast('今日搜索额度已用完');
          else showToast('这次没搜到什么，换个词或渠道试试');
        } catch (err) {
          showToast(err?.message || '手动查询失败', 4000);
        } finally {
          manualSearchBusyId = '';
          await paint();
        }
      });
    });

    container.querySelector('.cphone-usage-stats-toggle')?.addEventListener('click', async () => {
      showUsageStats = !showUsageStats;
      if (showUsageStats) {
        const entries = await listSearchCallLog({ characterId: selectedId, dateKey: searchLogDayKey() });
        usageStatsSummary = summarizeSearchCallLog(entries);
      }
      await paint();
    });

    container.querySelector('.cphone-material-pool-toggle')?.addEventListener('click', async () => {
      showMaterialPool = !showMaterialPool;
      if (showMaterialPool) {
        materialPoolPosts = await listVerifiedPosts(user.id, selectedId).catch(() => []);
      }
      await paint();
    });

    container.querySelector('.cphone-interest-tutorial-btn')?.addEventListener('click', () => {
      navigate('tutorial', { section: 'interest' });
    });

    container.querySelector('.cphone-share-post-comments-input')?.addEventListener('change', async (ev) => {
      if (!selectedId) return;
      const includeHotComments = !!ev.target.checked;
      sharePostIncludeComments = includeHotComments;
      interestTracking = await saveInterestTrackingSettings(user.id, selectedId, { includeHotComments });
      await saveCharacterPhoneAutomationConfig(user.id, selectedId, {
        share: { includeHotComments },
      }).catch(() => {});
      showToast(includeHotComments ? '已开启连带热评' : '已关闭连带热评');
    });

    container.querySelector('.cphone-avoid-notes-save')?.addEventListener('click', async () => {
      const input = container.querySelector('.cphone-avoid-notes-input');
      const commentsInput = container.querySelector('.cphone-share-post-comments-input');
      const avoidNotes = String(input?.value || '').trim();
      const includeHotComments = commentsInput ? !!commentsInput.checked : interestTracking.includeHotComments === true;
      sharePostIncludeComments = includeHotComments;
      interestTracking = await saveInterestTrackingSettings(user.id, selectedId, { avoidNotes, includeHotComments });
      await saveCharacterPhoneAutomationConfig(user.id, selectedId, {
        share: { avoidNotes, includeHotComments },
      }).catch(() => {});
      showToast('已保存精搜偏好');
      await paint();
    });

    container.querySelectorAll('[data-share-post-channel]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-share-post-channel');
        if (!id || !interestChannelsAvailable[id]) return;
        const current = normalizeShareSearchChannels(interestTracking.shareSearchChannels);
        const next = new Set(current);
        if (next.has(id)) {
          // 至少保留一个「当前可用」的渠道，避免点没了却还能点精搜
          const availableSelected = [...next].filter((c) => interestChannelsAvailable[c]);
          if (availableSelected.length <= 1 && availableSelected[0] === id) {
            showToast('至少保留一个分享渠道');
            return;
          }
          next.delete(id);
        } else {
          next.add(id);
        }
        interestTracking = await saveInterestTrackingSettings(user.id, selectedId, {
          shareSearchChannels: [...next],
        });
        await saveCharacterPhoneAutomationConfig(user.id, selectedId, {
          share: { shareSearchChannels: [...next] },
        }).catch(() => {});
        await paint();
      });
    });

    async function runSharePostFlow(keyword, channel, { fallbackChannel = '', entry = null } = {}) {
      const includeComments = container.querySelector('.cphone-share-post-comments-input')
        ? !!container.querySelector('.cphone-share-post-comments-input')?.checked
        : interestTracking.includeHotComments === true;
      sharePostKeyword = keyword;
      sharePostIncludeComments = includeComments;
      if (includeComments !== (interestTracking.includeHotComments === true) && selectedId) {
        interestTracking = await saveInterestTrackingSettings(user.id, selectedId, { includeHotComments: includeComments }).catch(() => interestTracking);
      }
      sharePostBusy = true;
      await paint();
      const interestSearch = await loadInterestSearchRuntime();
      const runOnce = (ch) => (ch === 'web'
        ? interestSearch.runWebLinkShareSearch({
          userId: user.id, characterId: selectedId, character: selectedCharacter(), keyword,
          entryChannel: entry?.channel, progress: entry?.progress, kind: entry?.kind,
          subKind: entry?.subKind, topic: entry?.topic,
        })
        : interestSearch.runSharePostSearch({
          userId: user.id, characterId: selectedId, character: selectedCharacter(), keyword,
          entryChannel: entry?.channel, progress: entry?.progress, kind: entry?.kind,
          subKind: entry?.subKind, topic: entry?.topic, channel: ch, includeComments,
        }));
      try {
        let result = await runOnce(channel);
        let usedChannel = channel;
        // 优先试免费网页渠道，没搜到/没选出合适内容时自动兜底走一次社媒渠道（仅当该社媒也在勾选里）
        if (!result.post && fallbackChannel && fallbackChannel !== channel) {
          result = await runOnce(fallbackChannel);
          usedChannel = fallbackChannel;
        }
        if (result.post) {
          const switchedNote = usedChannel !== channel ? '（网页渠道没搜到，换了社媒渠道）' : '';
          const fallbackNote = result.fallbackUsed ? '（AI 精选异常，已用安全候选兜底）' : '';
          showToast(`精搜到一条：${result.post.title}${result.reused ? '（复用了之前攒的素材，省了一次搜索）' : ''}${switchedNote}${fallbackNote}，已存进浏览记录`);
        } else {
          showToast(shareSearchFailReason(result.reason, result), result.reason === 'api-error' ? 5000 : undefined);
        }
      } catch (err) {
        showToast(err?.message || '精搜失败', 4000);
      } finally {
        sharePostBusy = false;
        await paint();
      }
    }

    async function runSharePostFromSelectedChannels(keyword, entry = null) {
      const interestSearch = await loadInterestSearchRuntime();
      const attempt = interestSearch.resolveShareSearchAttempt(interestTracking.shareSearchChannels, {
        webOk: interestChannelsAvailable.web,
        socialOk: interestChannelsAvailable.xiaohongshu,
      });
      if (!attempt.tryWeb && !attempt.socialAllowed.length) {
        showToast('请先在「分享渠道」里至少选一个可用渠道');
        return;
      }
      const fallbackChannel = attempt.socialAllowed.length
        ? interestSearch.pickSocialChannelForKeyword(keyword, entry?.topic, attempt.socialAllowed)
        : '';
      if (attempt.tryWeb) {
        await runSharePostFlow(keyword, 'web', { fallbackChannel, entry });
        return;
      }
      await runSharePostFlow(keyword, fallbackChannel, { entry });
    }

    container.querySelector('.cphone-share-post-run')?.addEventListener('click', async () => {
      if (sharePostBusy) return;
      const input = container.querySelector('.cphone-share-post-input');
      const keyword = String(input?.value || '').trim();
      if (!keyword) { showToast('先填一个关键词'); return; }
      const entry = interestTable.find((item) => item.keyword === keyword) || null;
      await runSharePostFromSelectedChannels(keyword, entry);
    });

    container.querySelector('.cphone-share-post-auto')?.addEventListener('click', async () => {
      if (sharePostBusy) return;
      const { pickAutoShareKeyword } = await loadInterestSearchRuntime();
      const pick = pickAutoShareKeyword(interestTable);
      if (!pick?.keyword) { showToast('没有设置为「会分享」的兴趣，先展开词条调整提起方式'); return; }
      await runSharePostFromSelectedChannels(pick.keyword, pick);
    });

    container.querySelector('.cphone-user-social-input')?.addEventListener('input', (ev) => {
      userSocialWatchProfileDraft = ev.target.value;
    });
    container.querySelector('.cphone-user-social-save')?.addEventListener('click', async () => {
      const input = container.querySelector('.cphone-user-social-input');
      const profileInput = String(input?.value || '').trim();
      if (!profileInput) { showToast('先粘贴你的小红书主页分享链接'); return; }
      const changed = profileInput !== userSocialWatch.profileInput;
      userSocialWatch = await saveUserSocialWatchSettings(user.id, selectedId, {
        profileInput,
        ...(changed ? { enabled: false, initialized: false, seenNoteIds: [], lastCheckedAt: 0, lastError: '' } : {}),
      });
      showToast(changed ? '已保存，去开启开关吧' : '已保存');
      await paint();
    });
    container.querySelector('.cphone-user-social-toggle')?.addEventListener('change', async (ev) => {
      userSocialWatch = await saveUserSocialWatchSettings(user.id, selectedId, { enabled: ev.target.checked });
      await paint();
    });
    container.querySelectorAll('[data-social-disclosure]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        userSocialWatch = await saveUserSocialWatchSettings(user.id, selectedId, { disclosureMode: btn.getAttribute('data-social-disclosure') });
        await paint();
      });
    });
    container.querySelector('.cphone-user-social-check')?.addEventListener('click', async () => {
      if (userSocialWatchBusy) return;
      userSocialWatchBusy = true;
      await paint();
      try {
        const result = await checkUserSocialUpdates({ userId: user.id, characterId: selectedId, manual: true });
        if (!result.ok) {
          const map = {
            'no-profile': '还没填主页链接',
            'social-link-not-configured': '还没配置小红书解析（TikHub），去 API 设置里填一下',
            'fetch-failed': `没看到：${result.error || '请求失败'}`,
          };
          showToast(map[result.reason] || '这次没看到新内容');
        } else if (result.baseline) {
          showToast('已连接，先看了最新一条打个基线，之后只同步新发的');
        } else if (result.added > 0) {
          showToast(`同步到 ${result.added} 条新动态`);
        } else {
          showToast('看过了，暂时没有新动态');
        }
      } catch (err) {
        showToast(err?.message || '查看失败', 4000);
      } finally {
        userSocialWatchBusy = false;
        await paint();
      }
    });
    container.querySelector('.cphone-interest-rotation-test')?.addEventListener('click', async () => {
      if (interestRotationTestBusy) return;
      interestRotationTestBusy = true;
      await paint();
      try {
        const character = selectedCharacter();
        const result = await runDailyInterestRotationForCharacter({ userId: user.id, characterId: selectedId, character });
        const materials = Array.isArray(result?.materials) ? result.materials.length : 0;
        const sharePosts = Array.isArray(result?.sharePosts) ? result.sharePosts.length : 0;
        if (materials || sharePosts || result?.split) {
          showToast(`测试完成：新增素材 ${materials} 条，深读可分享 ${sharePosts} 条${result.split ? '，裂变出新子话题' : ''}`);
        } else {
          showToast('测试完成：这轮没搜到新东西（词条本身可能暂时没有新内容，或渠道额度已用完）');
        }
        interestTable = await listInterestEntries(user.id, selectedId).catch(() => interestTable);
      } catch (err) {
        showToast(err?.message || '测试失败', 4000);
      } finally {
        interestRotationTestBusy = false;
        await paint();
      }
    });
    container.querySelector('.cphone-user-social-posts-toggle')?.addEventListener('click', () => {
      showUserSocialPosts = !showUserSocialPosts;
      paint();
    });
    container.querySelector('.cphone-user-social-reset')?.addEventListener('click', async () => {
      await resetUserSocialWatchProgress(user.id, selectedId);
      userSocialWatch = await loadUserSocialWatchSettings(user.id, selectedId);
      showToast('已重置，下次查看会重新走一遍首次连接');
      await paint();
    });
  }

  function splitFailReason(reason, keyword) {
    const map = {
      'web-search-disabled': '还没配置联网搜索，去 API 设置里开一下',
      'no-subtopics-found': `没搜到「${keyword}」当下具体的子话题，换个时间再试试`,
      'missing-params': '裂变失败',
    };
    return map[reason] || '这次没裂变出新话题';
  }

  function shareSearchFailReason(reason, result) {
    if (reason === 'api-error') return `接口报错：${result?.error || '未知错误'}`;
    if (reason === 'quota-exceeded') return '今日这个渠道的搜索额度已用完';
    const map = {
      'no-results': '这个渠道没搜到相关内容，换个词或渠道试试',
      'nothing-picked': 'AI 判断这批候选都是广告、水贴、过期内容或命中了雷点，没有硬选',
      'no-valid-candidate-id': '列表返回了标题，但缺少可用的帖子 ID，无法继续取正文',
      'picker-invalid-response': 'AI 精选返回格式无法识别，也没有安全候选可兜底',
      'picker-invalid-selection': 'AI 返回的候选编号无效，也没有安全候选可兜底',
      'picker-api-error': `AI 精选接口异常${result?.error ? `：${result.error}` : ''}，也没有安全候选可兜底`,
      'detail-fetch-failed': '正文取失败，可能被限流了',
      'empty-detail': '取到的正文是空的',
      'detail-rejected-low-quality': '取到正文后确认含明确广告或购买引导，已拦截且没有写入素材池',
      'social-link-disabled': '还没配置社媒解析（TikHub）',
      'web-search-disabled': '还没配置网页搜索',
      'feature-disabled': '这个功能还没开启',
    };
    const base = map[reason] || '这次没搜到合适的帖子';
    const count = Number(result?.resultCount);
    if (reason === 'no-results' && Number.isFinite(count)) return `${base}（解析到 ${count} 条）`;
    return base;
  }

  function capturePhoneInnerScrolls() {
    // 设备模式下真正滚动的是子页列表（如通讯录 .cphone-chat-section），不是外层 .cphone-scroll。
    const selectors = [
      '.cphone-chat-section',
      '.cphone-os-content .cphone-subpage-body',
      '.cphone-os-content .cphone-home-screen',
      '.cphone-os-content',
    ];
    return selectors.map((sel) => ({
      sel,
      top: Number(container.querySelector(sel)?.scrollTop || 0) || 0,
    }));
  }

  function restorePhoneInnerScrolls(snapshots = [], keep = false) {
    if (!keep) return;
    const expectedContext = `${activeApp}||${selectedId}`;
    const apply = () => {
      if (!container.isConnected || `${activeApp}||${selectedId}` !== expectedContext) return;
      for (const { sel, top } of snapshots) {
        const el = container.querySelector(sel);
        if (el) el.scrollTop = top;
      }
    };
    // Android WebView 在替换子页后可能于下一次布局把 overflow 容器重置为 0。
    // 先同步恢复避免闪顶，再在两帧内钉住最终位置。
    apply();
    requestAnimationFrame(() => {
      apply();
      requestAnimationFrame(apply);
    });
  }

  function syncChatManageDeleteButton(kind) {
    const interceptBtn = container.querySelector('[data-phone-intercept-delete-selected]');
    if (interceptBtn) {
      const total = chatSelectedIds.size + contactSelectedIds.size;
      interceptBtn.disabled = !total;
      interceptBtn.textContent = `删除(${total})`;
      return;
    }
    const isContact = kind === 'contact';
    const selected = isContact ? contactSelectedIds : chatSelectedIds;
    const btn = container.querySelector(
      isContact ? '[data-phone-contact-delete-selected]' : '[data-phone-chat-delete-selected]',
    );
    if (!btn) return;
    btn.disabled = !selected.size;
    btn.textContent = `删除(${selected.size})`;
  }

  function collectInterceptContactIdsForPeer(contacts = [], peerId = '') {
    const pid = String(peerId || '').trim();
    if (!pid) return [];
    return (contacts || [])
      .filter((contact) => (
        contact?.id
        && (contact.interceptSource || contact.blocked)
        && (contact.id === pid || contact.linkedCharacterId === pid)
      ))
      .map((contact) => contact.id);
  }

  /**
   * 拦截箱删除要会话 + 对应黑名单联系人一起清：
   * 只删会话时，联系人行会立刻以「黑名单联系人」冒回来，看起来像删除失败。
   */
  async function deletePhoneInterceptItems({ chatIds = [], contactIds = [] } = {}) {
    const chatIdSet = new Set([...chatIds].map((id) => String(id || '').trim()).filter(Boolean));
    const contactIdSet = new Set([...contactIds].map((id) => String(id || '').trim()).filter(Boolean));
    if (!selectedId || (!chatIdSet.size && !contactIdSet.size)) {
      return { chatDeleted: 0, contactDeleted: 0, errors: [] };
    }
    const contactsSnapshot = await loadCharacterPhoneContacts(user.id, selectedId).catch(() => phoneContacts);
    const contacts = contactsSnapshot?.contacts || [];
    const chatsSnapshot = [...phoneInterceptRows];
    const errors = [];
    const deletedChatIds = new Set();

    const chatsToDelete = [];
    for (const chat of chatsSnapshot) {
      if (!chat?.id) continue;
      if (chatIdSet.has(chat.id)) {
        chatsToDelete.push(chat);
        continue;
      }
      const peers = (chat.participants || []).filter((id) => id && id !== selectedId && id !== 'user');
      const hitByContact = peers.some((peerId) => contacts.some((contact) => (
        contactIdSet.has(contact.id)
        && (contact.id === peerId || contact.linkedCharacterId === peerId)
      )));
      if (hitByContact) chatsToDelete.push(chat);
    }

    for (const chat of chatsToDelete) {
      try {
        await deleteChatWithData(chat.id, user.id);
        deletedChatIds.add(chat.id);
        for (const peerId of chat.participants || []) {
          if (!peerId || peerId === selectedId || peerId === 'user') continue;
          for (const contactId of collectInterceptContactIdsForPeer(contacts, peerId)) {
            contactIdSet.add(contactId);
          }
        }
      } catch (error) {
        errors.push(String(error?.message || error || '删除会话失败').slice(0, 80));
      }
    }

    // 选中但当前列表里没有对应会话的黑名单联系人，仍要删掉通讯录条目。
    for (const contactId of [...contactIds]) {
      const id = String(contactId || '').trim();
      if (id) contactIdSet.add(id);
    }

    let contactDeleted = 0;
    if (contactIdSet.size) {
      try {
        const result = await deletePhoneContacts(user.id, selectedId, [...contactIdSet]);
        contactDeleted = Number(result?.deleted || 0) || 0;
      } catch (error) {
        errors.push(String(error?.message || error || '删除联系人失败').slice(0, 80));
      }
    }

    return {
      chatDeleted: deletedChatIds.size,
      contactDeleted,
      errors,
    };
  }

  function summarizeInterceptDeleteResult(result = {}) {
    const done = [];
    if (result.chatDeleted) done.push(`${result.chatDeleted} 个会话`);
    if (result.contactDeleted) done.push(`${result.contactDeleted} 位联系人`);
    if (result.errors?.length) {
      showToast(`部分删除失败：${result.errors[0]}`);
      return;
    }
    showToast(done.length ? `已删除 ${done.join('、')}` : '没有可删除的内容');
  }

  async function paint(options = {}) {
    // soft: keep device chrome + wallpaper <img>, only swap OS content.
    // Prevents APK wallpaper re-decode flicker and cuts click latency.
    const soft = options.soft === true;
    const showLoading = options.showLoading === true || (!soft && options.showLoading !== false);
    const prevScrollTop = container.querySelector('.cphone-scroll')?.scrollTop || 0;
    const prevInnerScrolls = capturePhoneInnerScrolls();
    const ctxKey = `${activeApp}||${selectedId}`;
    const keepScroll = lastPaintCtx === ctxKey;
    const scrollEl = container.querySelector('.cphone-scroll');
    if (showLoading && scrollEl) scrollEl.classList.add('is-loading');
    const openingContent = container.querySelector('.cphone-os-content');
    if (soft && selectedId && openingContent && lastPaintCtx && lastPaintCtx !== ctxKey) {
      openingContent.className = `cphone-os-content is-${activeApp} is-opening`;
      openingContent.innerHTML = phoneAppOpeningHtml();
    }
    await loadState({
      soft: soft && !!phone && !!selectedId,
      promotedMomentPosts: options.promotedMomentPosts,
    });
    destroyLiveMap();

    const screen = container.querySelector('.cphone-device-screen');
    const osContent = container.querySelector('.cphone-os-content');
    const canSoftShell = soft
      && selectedId
      && screen
      && osContent
      && container.querySelector('.cphone-stage');

    if (canSoftShell) {
      osContent.className = `cphone-os-content is-${activeApp}`;
      osContent.innerHTML = activeAppHtml();
      const existingHud = screen.querySelector('.cphone-generation-hud');
      if (phoneGeneration.active) {
        if (existingHud) {
          existingHud.outerHTML = generationHudHtml();
        } else {
          const homeBtn = screen.querySelector('.cphone-home-indicator');
          if (homeBtn) homeBtn.insertAdjacentHTML('beforebegin', generationHudHtml());
          else screen.insertAdjacentHTML('beforeend', generationHudHtml());
        }
      } else if (existingHud) {
        existingHud.remove();
      }
      // Replace trailing modals without touching the phone shell.
      const stage = container.querySelector('.cphone-stage');
      const detailRecord = (phone?.browserRecords || []).find((r) => r.id === openRecordId)
        || (phone?.interestRecords || []).find((r) => r.id === openRecordId);
      const previewRecord = photoPreview?.recordId
        ? (phone?.photoRecords || []).find((r) => String(r.id || '') === String(photoPreview.recordId))
          || (chatPhotoRecords || []).find((r) => String(r.id || '') === String(photoPreview.recordId))
        : null;
      [...container.querySelectorAll('.cphone-modal')].forEach((el) => el.remove());
      if (stage) {
        stage.insertAdjacentHTML('afterend', `${browserPageModal(detailRecord)}${photoPreviewModal(photoPreview, previewRecord, {
          generating: photoGenBusy,
          generatingRecordId: photoGenRecordId,
        })}`);
      }
      bind({ soft: true });
    } else {
      container.innerHTML = selectedId
        ? `<main class="cphone-scroll is-device-mode">${mainHtml()}</main>`
        : `
        <header class="navbar">
          <button type="button" class="navbar-btn" data-back aria-label="返回">${icon('back')}</button>
          <h1 class="navbar-title">选择一部手机</h1>
          <span class="navbar-btn scrapbook-nav-spacer" aria-hidden="true"></span>
        </header>
        <main class="cphone-scroll is-picker-mode">${mainHtml()}</main>
      `;
      bind({ soft: false });
    }
    hydrateHomeCustomIconFallbacks(container);
    recoverBrokenPhoneAvatarImages(container);
    const nextScroll = container.querySelector('.cphone-scroll');
    if (nextScroll) {
      nextScroll.classList.remove('is-loading');
      nextScroll.scrollTop = keepScroll ? prevScrollTop : 0;
    }
    restorePhoneInnerScrolls(prevInnerScrolls, keepScroll);
    if (activeApp !== 'home') {
      // Don't block paint on badge writeback.
      markAppRead(activeApp).catch(() => {});
    }
    lastPaintCtx = ctxKey;
    // Persist selected character / app / Chat tab into the route so chat/thread return lands correctly.
    syncCurrentRoute('character-phone', {
      ...(selectedId ? { character: selectedId } : {}),
      ...(selectedId && activeApp && activeApp !== 'home' ? { app: activeApp } : {}),
      ...(selectedId && activeApp === 'chat' && phoneChatSection && phoneChatSection !== 'messages'
        ? { chatTab: phoneChatSection }
        : {}),
      ...(selectedId && activeApp === 'chat' && phoneContactEditId
        ? { contact: phoneContactEditId }
        : {}),
      ...(entryFrom === 'chat' && entryChatId ? { from: 'chat', chatId: entryChatId } : {}),
    });
    initLiveMapIfNeeded();
    if (activeApp === 'photos' || photoPreview) schedulePhoneAlbumImageRecovery(container);
    if (!soft && activeApp === 'home') scheduleHomeHydration();
  }

  async function initLiveMapIfNeeded() {
    const el = container.querySelector('[data-cphone-live-map]');
    if (!el || activeApp !== 'map' || !phone) return;
    const token = liveMapToken;
    const status = container.querySelector('[data-cphone-live-map-status]');
    const source = container.querySelector('[data-cphone-map-source]');
    const sourceLabel = container.querySelector('[data-cphone-map-source-label]');
    const sourceDetail = container.querySelector('[data-cphone-map-source-detail]');
    const setStatus = (text) => {
      if (status) status.textContent = text;
    };
    const setSource = (mode, label, detail) => {
      if (source) source.className = `cphone-map-source is-${mode}`;
      if (sourceLabel) sourceLabel.textContent = label;
      if (sourceDetail) sourceDetail.textContent = detail;
    };
    try {
      const cfg = await loadAmapConfig();
      if (!cfg?.enabled || !cfg.apiKey) {
        setSource('virtual', '模拟地图', '刷新会调用文字模型生成周边与候选路线');
        setStatus('模拟位置 · 无需地图 API');
        return;
      }
      if (cfg.jsMapEnabled === false) {
        setSource('api', '地图 API 已连接', '真实地点搜索可用 · JS 小地图已关闭');
        setStatus('JS 小地图未启用');
        return;
      }
      const items = collectMapCoordinateItems(phone);
      const points = items.map((item) => ({ ...item, point: parseLngLat(item.location) })).filter((item) => item.point);
      if (!points.length) {
        setSource('api', '地图 API 已连接', '刷新可重新搜索真实地点与路线');
        setStatus('暂无坐标 · 可点击刷新');
        return;
      }
      const AMap = await loadAmapJsApi(cfg, ['AMap.Scale', 'AMap.ToolBar']);
      if (token !== liveMapToken || !container.contains(el)) return;
      const route = phone.routeState && typeof phone.routeState === 'object' ? phone.routeState : {};
      const current = phone.currentMapState && typeof phone.currentMapState === 'object' ? phone.currentMapState : {};
      const preferredCenter = parseLngLat(current.location)
        || parseLngLat(route.destinationLocation)
        || parseLngLat(route.originLocation)
        || points[0].point;
      const map = new AMap.Map(el, {
        zoom: points.length > 3 ? 13 : 15,
        center: preferredCenter,
        viewMode: '2D',
        resizeEnable: true,
      });
      liveMapInstance = map;
      if (AMap.Scale) map.addControl(new AMap.Scale());
      if (AMap.ToolBar) map.addControl(new AMap.ToolBar({ position: { right: '8px', top: '8px' } }));
      const overlays = [];
      const liveCharacter = selectedCharacter() || {};
      const markers = points.slice(0, 18).map((item) => {
        if (item.kind === 'current') {
          return new AMap.Marker({
            position: item.point,
            title: item.name,
            anchor: 'bottom-center',
            content: `<span class="cphone-amap-person-pin">${characterAvatarHtml(liveCharacter, { className: 'cphone-amap-person-avatar' })}<i></i></span>`,
            zIndex: 120,
          });
        }
        return new AMap.Marker({
          position: item.point,
          title: item.name,
          label: {
            content: item.label,
            direction: 'top',
          },
        });
      });
      if (markers.length) {
        map.add(markers);
        overlays.push(...markers);
      }
      const routePath = Array.isArray(route.polyline)
        ? route.polyline.map((loc) => parseLngLat(loc)).filter(Boolean)
        : [];
      if (routePath.length >= 2 && AMap.Polyline) {
        const line = new AMap.Polyline({
          path: routePath,
          strokeColor: '#6c8796',
          strokeWeight: 4,
          strokeOpacity: 0.9,
          lineJoin: 'round',
        });
        map.add(line);
        overlays.push(line);
      }
      if (overlays.length > 1) map.setFitView(overlays, false, [18, 18, 18, 18]);
      container.querySelector('.cphone-record-list')?.classList.add('has-live-map');
      container.querySelector('.cphone-map-live')?.classList.add('is-ready');
      setSource('api', '地图 API 已连接', `真实坐标 · ${timeLabel(phone.currentMapState?.updatedAt) || '已载入'}`);
      setStatus('');
    } catch (error) {
      setSource('error', '地图 API 异常', '保留当前地图资料，可稍后重试');
      setStatus(`小地图加载失败：${error?.message || error}`);
    }
  }

  async function ensureWeiboTopicFromBrowserRecord(record = {}) {
    const topic = topicFromBrowserRecord(record);
    if (!topic) return '';
    const ownerUserId = user?.id || 'guest';
    const allPosts = await db.getAllRecords('weiboPosts').catch(() => []);
    const normalizedTopic = topicText(topic);
    const hasPost = (allPosts || []).some((post) => {
      if ((post?.ownerUserId || '') !== ownerUserId) return false;
      const hay = `${post.content || ''}\n${(post.tags || []).join('\n')}`;
      return hay.includes(normalizedTopic);
    });
    if (!hasPost) {
      const character = selectedCharacter() || await getCharacter(selectedId, { userId: user.id }).catch(() => null);
      const charName = character?.customNickname || character?.name || 'TA';
      const author = resolveWeiboRecordAuthor(record, { selectedId, charName });
      const now = await getNowForUser(user.id).catch(() => Date.now());
      const summary = plain(record.summary || record.body || `${author.isSelf ? '随手发了条' : '正在看'} ${normalizedTopic} 相关讨论`, 180);
      await db.put('weiboPosts', {
        id: `weibo_phone_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        ownerUserId,
        authorId: author.authorId,
        authorName: author.authorName,
        avatar: null,
        content: `#${normalizedTopic}# ${summary}`,
        tags: [`#${normalizedTopic}#`],
        images: [],
        timestamp: now,
        reposts: 0,
        comments: 1,
        likes: 0,
        fans: 0,
        metadata: { fromCharacterPhoneRecord: true, weiboAuthorType: author.type },
        commentList: [{
          author: '热搜路人',
          content: plain(record.title || record.query || normalizedTopic, 80),
          likes: 0,
          timestamp: now,
        }],
      });
    }
    return normalizedTopic;
  }

  async function ensureForumThreadFromBrowserRecord(record = {}) {
    const recId = String(record?.id || '').trim();
    if (!recId) return '';
    const threadId = `forum_phone_${recId}`;
    const existing = await db.get('forumThreads', threadId).catch(() => null);
    if (existing?.id) return threadId;
    const character = selectedCharacter() || await getCharacter(selectedId, { userId: user.id }).catch(() => null);
    const charName = character?.customNickname || character?.name || 'TA';
    const isSelf = String(record.forumAuthorType || '').trim().toLowerCase() === 'self';
    const proposedAuthorName = isSelf
      ? charName
      : (String(record.forumAuthorName || '').trim() || '论坛网友');
    const normalizedAuthor = sanitizeGeneratedForumAuthor({
      authorName: proposedAuthorName,
      authorAlias: isSelf ? proposedAuthorName : '',
      authorId: isSelf ? selectedId : '',
      authorRoleId: isSelf ? selectedId : '',
    }, character?.id ? { [character.id]: character } : {}, {
      user,
      userId: user?.id || '',
    });
    const now = await getNowForUser(user.id).catch(() => Date.now());
    const content = plain(record.body || record.summary || record.title || '帖子内容', 1200);
    const thread = {
      id: threadId,
      title: plain(record.title || record.query || '论坛帖', 80),
      content,
      images: [],
      authorName: normalizedAuthor.authorName,
      authorId: normalizedAuthor.authorId,
      authorRoleId: normalizedAuthor.authorRoleId,
      authorAlias: normalizedAuthor.authorAlias,
      authorSource: 'generated',
      userId: user?.id || null,
      sectionId: 'general',
      timestamp: now,
      replies: [],
      metadata: { fromCharacterPhoneRecord: true, forumAuthorType: record.forumAuthorType || '' },
    };
    await db.put('forumThreads', thread).catch(() => {});
    return threadId;
  }

  function bind(options = {}) {
    // soft: OS content was swapped but device chrome (power / home indicator) stayed —
    // rebinding those would stack duplicate navigations on every icon tap.
    const soft = options.soft === true;
    menuCloseController?.abort();
    menuCloseController = new AbortController();
    const closeMenus = (restoreFocus = false) => {
      const openMenus = [...container.querySelectorAll('details.cphone-more-menu[open], details.cphone-app-more[open]')];
      openMenus.forEach((menu) => menu.removeAttribute('open'));
      if (restoreFocus && openMenus[0]) openMenus[0].querySelector('summary')?.focus();
    };
    document.addEventListener('pointerdown', (event) => {
      if (!container.contains(event.target)) return;
      if (event.target.closest('details.cphone-more-menu, details.cphone-app-more')) return;
      closeMenus();
    }, { capture: true, signal: menuCloseController.signal });
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      if (!container.querySelector('details.cphone-more-menu[open], details.cphone-app-more[open]')) return;
      event.preventDefault();
      closeMenus(true);
    }, { signal: menuCloseController.signal });
    const powerOffPhone = async () => {
      if (entryFrom === 'chat' && entryChatId) {
        // 摘掉聊天设定等中间页，避免回聊天后再点返回又掉进设定。
        navigateDismissing('chat/thread', { chatId: entryChatId }, {
          dismissPaths: ['chat/details'],
          matchChatId: entryChatId,
        });
        return;
      }
      selectedId = '';
      phoneContactOperationId += 1;
      unavailableRequestedId = '';
      chooserExpanded = true;
      chooserQuery = '';
      activeApp = 'home';
      openRecordId = '';
      photoPreview = null;
      pendingAvatarImport = null;
      phoneContactEditId = '';
      chatManageMode = false;
      chatSelectedIds.clear();
      contactSelectedIds.clear();
      phone = null;
      plan = null;
      await paint();
    };
    container.querySelectorAll('[data-phone-power-off]').forEach((btn) => {
      if (btn.dataset.phonePowerBound === '1') return;
      btn.dataset.phonePowerBound = '1';
      btn.addEventListener('click', powerOffPhone);
    });
    if (!soft) {
      container.querySelectorAll('[data-back]').forEach((btn) => btn.addEventListener('click', () => back()));
    }
    container.querySelector('[data-phone-generation-cancel]')?.addEventListener('click', async () => {
      phoneGeneration.controller?.abort();
      phoneGeneration = { active: false, scope: '', message: '', controller: null };
      showToast('已取消生成');
      await paint({ soft: true });
    });
    bindInterestKeywordEvents();
    container.querySelectorAll('[data-toggle-chooser]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        chooserExpanded = !chooserExpanded;
        await paint();
      });
    });
    bindCommitSearch({
      input: container.querySelector('.cphone-character-search-input'),
      trigger: container.querySelector('[data-chooser-search-submit]'),
      onCommit: async (value) => {
        chooserQuery = value;
        await paint();
      },
    });
    container.querySelector('.cphone-character-search-clear')?.addEventListener('click', async () => {
      chooserQuery = '';
      await paint();
      container.querySelector('.cphone-character-search-input')?.focus();
    });
    container.querySelectorAll('[data-char]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        selectedId = btn.getAttribute('data-char');
        phoneContactOperationId += 1;
        unavailableRequestedId = '';
        chooserExpanded = false;
        chooserQuery = '';
        activeApp = 'home';
        openRecordId = '';
        photoPreview = null;
        pendingAvatarImport = null;
        phoneContactEditId = '';
        chatManageMode = false;
        chatSelectedIds.clear();
        contactSelectedIds.clear();
        await paint();
      });
    });
    container.querySelectorAll('[data-pin-char]').forEach((btn) => {
      btn.addEventListener('click', async (event) => {
        event.stopPropagation();
        const id = btn.getAttribute('data-pin-char') || '';
        if (!id) return;
        if (pinnedCharacters.has(id)) pinnedCharacters.delete(id);
        else pinnedCharacters.add(id);
        savePinnedCharacters();
        await paint();
      });
    });
    container.querySelector('.cphone-go-space')?.addEventListener('click', () => {
      if (selectedId) navigate('his-space', { character: selectedId });
    });
    container.querySelectorAll('[data-app]').forEach((btn) => {
      btn.addEventListener('pointerdown', () => {
        btn.classList.add('is-pressed');
      });
      btn.addEventListener('pointerup', () => {
        btn.classList.remove('is-pressed');
      });
      btn.addEventListener('pointercancel', () => {
        btn.classList.remove('is-pressed');
      });
      btn.addEventListener('pointerleave', () => {
        btn.classList.remove('is-pressed');
      });
      btn.addEventListener('click', async () => {
        activeApp = btn.getAttribute('data-app') || 'home';
        openRecordId = '';
        photoPreview = null;
        pendingAvatarImport = null;
        await paint({ soft: true });
      });
    });
    container.querySelectorAll('[data-phone-chat-tab]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (chatManageMode) return;
        phoneChatSection = btn.getAttribute('data-phone-chat-tab') || 'messages';
        await paint({ soft: true });
      });
    });
    const chatSearchInput = container.querySelector('[data-phone-chat-search]');
    const applyPhoneChatSearch = () => {
      const query = String(chatSearchInput?.value || '').trim().toLocaleLowerCase();
      phoneChatQuery = query;
      container.querySelectorAll('[data-phone-chat-search-text]').forEach((row) => {
        const text = String(row.getAttribute('data-phone-chat-search-text') || '').toLocaleLowerCase();
        row.hidden = !!query && !text.includes(query);
      });
    };
    chatSearchInput?.addEventListener('input', applyPhoneChatSearch);
    container.querySelector('[data-phone-chat-search-form]')?.addEventListener('submit', (event) => {
      event.preventDefault();
      applyPhoneChatSearch();
    });
    applyPhoneChatSearch();
    container.querySelector('[data-phone-chat-debug-open]')?.addEventListener('click', () => {
      const host = document.getElementById('modal-container');
      if (!host) return;
      const close = () => {
        host.classList.remove('active');
        host.innerHTML = '';
      };
      const debugItems = [
        ['补一轮手机动态', '[data-phone-chat-batch]', phoneChatBusy],
        ['撤销上一轮动态', '[data-phone-chat-undo]', !lastPhoneLifeBatch?.batchId || phoneChatBusy],
        ['重 roll 上一轮动态', '[data-phone-chat-reroll]', !lastPhoneLifeBatch?.batchId || phoneChatBusy],
        ['从人设提取联系人', '[data-phone-contact-action="extract"]', false],
        ['生成 NPC 联系人', '[data-phone-contact-action="generate"]', false],
        ['生成一轮动态', '[data-phone-moments-generate]', phoneMomentsBusy],
        ['生成一轮拦截', '[data-phone-intercept-generate]', phoneInterceptBusy],
        ['聊天设置', '[data-app="settings"]', false],
      ];
      host.classList.add('active');
      host.innerHTML = `
        <div class="modal-overlay cphone-chat-debug-overlay" data-phone-chat-debug-close>
          <section class="modal-sheet cphone-chat-debug-sheet" role="dialog" aria-modal="true" aria-labelledby="cphone-chat-debug-title">
            <header><h3 id="cphone-chat-debug-title">调试与生成</h3><button type="button" data-phone-chat-debug-close aria-label="关闭">${icon('close')}</button></header>
            <div class="cphone-chat-debug-list">
              ${debugItems.map(([label, selector, disabled]) => `<button type="button" data-phone-chat-debug-proxy="${esc(selector)}" ${disabled ? 'disabled' : ''}>${esc(label)}${icon('chevron')}</button>`).join('')}
            </div>
          </section>
        </div>`;
      host.querySelectorAll('[data-phone-chat-debug-close]').forEach((el) => {
        el.addEventListener('click', (event) => {
          if (event.target !== el && el.classList.contains('cphone-chat-debug-overlay')) return;
          close();
        });
      });
      host.querySelectorAll('[data-phone-chat-debug-proxy]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const selector = btn.getAttribute('data-phone-chat-debug-proxy') || '';
          const proxy = selector ? container.querySelector(selector) : null;
          close();
          proxy?.click();
        });
      });
    });
    const runPhoneInterceptGenerate = async () => {
      if (phoneInterceptBusy || !selectedId) return;
      phoneInterceptBusy = true;
      const controller = new AbortController();
      phoneGeneration = {
        active: true,
        scope: '生成拦截箱',
        message: '正在整理人设与拦截背景…',
        controller,
      };
      phoneChatSection = 'intercept';
      await paint({ soft: true });
      try {
        const result = await generatePhoneInterceptBatch({
          user,
          ownerId: selectedId,
          signal: controller.signal,
          onProgress: async (message) => {
            if (!updateGenerationHudMessage(message)) await paint({ soft: true });
          },
        });
        const parts = [
          result.threads ? `${result.threads} 扇窗` : '',
          result.messages ? `${result.messages} 条消息` : '',
          result.contacts ? `联系人 ${result.contacts}` : '',
        ].filter(Boolean);
        showToast(`已生成拦截内容：${parts.join('，')}`);
      } catch (error) {
        if (error?.name !== 'AbortError') {
          void showPhoneGenerationError(error, {
            scope: '角色手机 / 拦截箱',
            title: '拦截箱生成失败',
          });
          showToast(String(error?.message || error || '生成失败').slice(0, 120));
        }
      } finally {
        phoneInterceptBusy = false;
        phoneGeneration = { active: false, scope: '', message: '', controller: null };
        await loadState();
        await paint({ soft: true });
      }
    };
    container.querySelectorAll('[data-phone-intercept-generate]').forEach((btn) => {
      btn.addEventListener('click', runPhoneInterceptGenerate);
    });
    container.querySelector('[data-phone-moments-generate]')?.addEventListener('click', async () => {
      if (phoneMomentsBusy || !selectedId) return;
      phoneMomentsBusy = true;
      let generatedMomentPosts = [];
      const controller = new AbortController();
      phoneGeneration = {
        active: true,
        scope: '补全联系人朋友圈',
        message: '正在整理通讯录关系…',
        controller,
      };
      await paint({ soft: true });
      try {
        const result = await generateCharacterPhoneMoments({
          user,
          ownerId: selectedId,
          count: 4,
          signal: controller.signal,
          onProgress: async (message) => {
            if (!updateGenerationHudMessage(message)) await paint({ soft: true });
          },
        });
        generatedMomentPosts = Array.isArray(result.posts) ? result.posts : [];
        const parts = [
          result.global ? `关联角色 ${result.global}` : '',
          result.local ? `轻量联系人 ${result.local}` : '',
        ].filter(Boolean);
        showToast(`已补 ${result.global + result.local} 条朋友圈${parts.length ? `（${parts.join('，')}）` : ''}`);
      } catch (error) {
        if (error?.name !== 'AbortError') {
          void showPhoneGenerationError(error, {
            scope: '角色手机 / 联系人朋友圈',
            title: '联系人朋友圈生成失败',
          });
          showToast(error?.message || '生成失败');
        }
      } finally {
        phoneMomentsBusy = false;
        phoneGeneration = { active: false, scope: '', message: '', controller: null };
        await paint({ soft: true, promotedMomentPosts: generatedMomentPosts });
      }
    });

    if (phoneChatSection === 'discover' && phoneMoments.length && selectedId) {
      const momentsNameMap = new Map([
        ...characters.map((item) => [item.id, nameOf(item)]),
        ...(phoneContacts.contacts || []).flatMap((item) => {
          const label = item.name || item.nickname || '';
          const rows = [];
          if (item.id) rows.push([item.id, label || item.id]);
          if (item.linkedCharacterId) {
            const linked = characters.find((c) => c.id === item.linkedCharacterId);
            rows.push([item.linkedCharacterId, nameOf(linked, label || item.linkedCharacterId)]);
          }
          return rows;
        }),
      ]);
      const actorList = [
        { id: user.id, name: user.name || '用户', kind: 'user', avatar: user.avatar || '' },
        ...characters.map((item) => ({
          id: item.id,
          name: nameOf(item),
          kind: 'character',
          avatar: item.avatar || item.avatarUrl || '',
        })),
        ...(phoneContacts.contacts || [])
          .filter((item) => isPhoneLocalLightContact(item))
          .map((item) => ({
            id: item.id,
            name: item.name || item.nickname || '联系人',
            kind: 'phone-contact',
            avatar: item.avatar || '',
          })),
      ];
      void import('../components/moments-interactions.js').then(({ bindMomentPostInteractions }) => bindMomentPostInteractions(container.querySelector('.cphone-moments-feed') || container, {
        user,
        actors: actorList,
        nameMap: momentsNameMap,
        phoneOwnerId: selectedId,
        getPost: (postId) => phoneMoments.find((p) => p.id === postId) || null,
        putPost: (post) => putCharacterPhoneMomentPost(user.id, selectedId, post),
        deletePost: (postId) => deleteCharacterPhoneMomentPost(user.id, selectedId, postId),
        onRefresh: async (refreshOptions = {}) => {
          await paint({ promotedMomentPosts: refreshOptions.promotedPosts });
        },
      })).catch(() => {});
    }
    container.querySelector('[data-phone-own-moments]')?.addEventListener('click', () => {
      if (selectedId) navigate('moments/profile', { characterId: selectedId });
    });
    // 手机里的会话直接打开真实 chat/thread（旁观 + 手机主人视角），
    // 推进 / 重 roll / 剧情提示完全复用主聊天页的操作栏。
    const openPhoneChatInThread = (chatId) => {
      if (!chatId || !selectedId) return;
      navigate('chat/thread', { chatId, viewer: selectedId, from: 'phone' });
    };
    const startPhoneContactChat = async (peerRef, trigger = null) => {
      if (!peerRef || !selectedId) return;
      const contact = (phoneContacts.contacts || []).find((item) => (
        item.id === peerRef || phoneContactCanonicalActorId(item) === peerRef
      ));
      const peerId = contact ? phoneContactCanonicalActorId(contact) : peerRef;
      if (!peerId || peerId === selectedId || peerId === 'user') return;
      if (trigger) trigger.disabled = true;
      try {
        const chat = await ensurePhonePeerChat(user.id, selectedId, peerId);
        if (!chat?.id) throw new Error('暂时无法创建聊天');
        openPhoneChatInThread(chat.id);
      } catch (error) {
        showToast(String(error?.message || error || '发起聊天失败').slice(0, 120));
      } finally {
        if (trigger?.isConnected) trigger.disabled = false;
      }
    };
    container.querySelectorAll('[data-phone-intercept-contact-id]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (Date.now() < interceptRowClickSuppressUntil) return;
        const contactId = btn.getAttribute('data-phone-intercept-contact-id') || '';
        if (!contactId || !selectedId) return;
        showToast('这位联系人还没有拦截消息，可点「生成一轮」补入');
      });
      bindLongPress(btn, () => {
        if (chatManageMode) return;
        const contactId = btn.getAttribute('data-phone-intercept-contact-id') || '';
        if (!contactId || !selectedId) return;
        const contact = (phoneContacts.contacts || []).find((item) => item.id === contactId);
        const title = contact?.name || contact?.nickname
          || String(btn.querySelector('.cphone-chat-row-main b')?.textContent || '').replace(/\s+/g, ' ').trim()
          || '黑名单联系人';
        interceptRowClickSuppressUntil = Date.now() + 500;
        openChatRowSheet({
          chatTitle: title,
          actions: [{
            label: '删除拦截联系人',
            variant: 'danger',
            onClick: async () => {
              if (!window.confirm(`删除「${title}」？会从手机通讯录移除，并清掉相关拦截会话。`)) return;
              try {
                const result = await deletePhoneInterceptItems({ contactIds: [contactId] });
                summarizeInterceptDeleteResult(result);
                await loadState();
                await paint({ soft: true });
              } catch (error) {
                showToast(String(error?.message || error || '删除失败').slice(0, 120));
              }
            },
          }],
        });
      });
    });
    container.querySelectorAll('[data-phone-contact-id]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const peerId = btn.getAttribute('data-phone-contact-id') || '';
        if (!peerId || !selectedId) return;
        const phoneRow = (phoneContacts.contacts || []).find((item) => (
          item.id === peerId || item.linkedCharacterId === peerId || item.linkedActorId === peerId
        ));
        const characterId = phoneRow?.linkedCharacterId || peerId;
        if (characters.some((row) => row.id === characterId)) {
          navigate('contacts/edit', { id: characterId, scope: 'identity', identityUserId: user.id });
          return;
        }
        if (phoneRow?.id) {
          phoneContactEditId = phoneRow.id;
          phoneChatSection = 'contacts';
          await paint();
          return;
        }
        showToast('该联系人还不在手机通讯录，可先点「加入」或从设置添加');
      });
    });
    container.querySelectorAll('[data-phone-orphan-adopt]').forEach((btn) => {
      btn.addEventListener('click', async (event) => {
        event.stopPropagation();
        const peerId = btn.getAttribute('data-phone-orphan-adopt') || '';
        if (!peerId || !selectedId) return;
        const rosterPerson = (lightweightNpcRoster || []).find((row) => row.id === peerId) || {};
        const directoryPerson = phoneSocialDirectory.resolve(peerId) || {};
        const storedAlias = phoneChatRows
          .map((chat) => chat?.metadata?.phoneLightNpcAliases?.[peerId])
          .find(Boolean) || {};
        const person = {
          ...directoryPerson,
          ...rosterPerson,
          id: peerId,
          aliases: [
            ...(directoryPerson.aliases || []),
            storedAlias.realName,
            storedAlias.name,
            storedAlias.customNickname,
          ].filter(Boolean),
        };
        const saved = await adoptPhoneSessionOrphanAsContact(user.id, selectedId, person).catch(() => null);
        if (!saved) {
          showToast('加入失败');
          return;
        }
        await reconcilePhoneContactNpcIdentities(user.id, selectedId).catch(() => {});
        await loadState();
        showToast(`已把「${saved.name || '联系人'}」加入轻量通讯录`);
        await paint({ soft: true });
      });
    });
    container.querySelectorAll('[data-phone-orphan-dismiss]').forEach((btn) => {
      btn.addEventListener('click', async (event) => {
        event.stopPropagation();
        const peerId = btn.getAttribute('data-phone-orphan-dismiss') || '';
        if (!peerId || !selectedId) return;
        const label = String(
          (lightweightNpcRoster || []).find((row) => row.id === peerId)?.name || '此人',
        ).trim() || '此人';
        if (!window.confirm(`移除「${label}」？\n\n会删除与 TA 的二人私聊，并从轻量名单里忘掉 TA；之后同名不会自动建回来。不会改你的主通讯录。`)) return;
        try {
          const result = await dismissPhoneSessionOrphanPeer(user.id, selectedId, peerId);
          if (!result?.dismissedNpc && !result?.deletedChats && !result?.updatedGroups) {
            showToast('没有找到可移除的联系人或会话');
            return;
          }
          phoneChatRows = await listCharacterPhoneChats(user.id, selectedId);
          phoneContacts = await loadCharacterPhoneContacts(user.id, selectedId);
          const cleaned = Number(result?.deletedChats || 0);
          const updated = Number(result?.updatedGroups || 0);
          showToast(cleaned
            ? `已移除，清理 ${cleaned} 个会话`
            : (updated ? `已移除，并更新 ${updated} 个群聊` : '已移出列表'));
          await paint({ soft: true });
        } catch (error) {
          showToast(`移除失败：${String(error?.message || error || '请稍后重试').slice(0, 100)}`);
        }
      });
    });
    container.querySelectorAll('[data-phone-light-contact-id]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const contactId = btn.getAttribute('data-phone-light-contact-id') || '';
        if (!contactId || !selectedId) return;
        const contact = (phoneContacts.contacts || []).find((item) => item.id === contactId);
        if (contact?.linkedCharacterId && characters.some((row) => row.id === contact.linkedCharacterId)) {
          navigate('contacts/edit', { id: contact.linkedCharacterId, scope: 'identity', identityUserId: user.id });
          return;
        }
        phoneContactEditId = contactId;
        phoneChatSection = 'contacts';
        await paint();
      });
    });
    container.querySelectorAll('[data-phone-light-group-id]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const groupId = btn.getAttribute('data-phone-light-group-id') || '';
        const group = (phoneContacts.groups || []).find((item) => item.id === groupId);
        if (!group || !selectedId) return;
        const parentChatId = await resolvePhoneMainParentChatId(user.id, selectedId).catch(() => '');
        const participants = resolvePhoneGroupParticipantIds(
          selectedId,
          group,
          phoneContacts.contacts || [],
        );
        const chat = await ensureBackstageChat(
          user.id,
          parentChatId || `phone:${selectedId}`,
          group.name,
          participants,
          {
            ownerId: selectedId,
            phoneOwnerId: selectedId,
            phoneContactGroupId: group.id,
            allowParticipantExpansion: true,
            userInitiated: true,
          },
        ).catch(() => null);
        if (chat?.id) openPhoneChatInThread(chat.id);
      });
    });
    const pickAddressBookContactForPhone = async () => {
      if (!selectedId) return null;
      const relationshipNet = await loadRelationshipNetwork().catch(() => null);
      const directory = createPhoneAddressBookActorDirectory({
        ownerId: selectedId,
        characters,
        relationshipNetwork: relationshipNet,
        contacts: phoneContacts.contacts || [],
      });
      const linked = new Set((phoneContacts.contacts || []).map(phoneContactCanonicalActorId).filter(Boolean));
      const items = directory.candidates
        .filter((actor) => !linked.has(actor.id))
        .map((actor) => ({ id: actor.id, name: actor.name || actor.id }));
      if (!items.length) {
        showToast('通讯录里没有可添加的角色了');
        return null;
      }
      const pickedId = await openParticipantPicker({
        title: '从通讯录添加联系人',
        items,
        searchable: true,
      });
      if (!pickedId) return null;
      const actor = directory.resolve(pickedId);
      if (!actor) return null;
      const input = phoneSocialActorToContactInput(actor);
      const saved = input ? await upsertPhoneContact(user.id, selectedId, input) : null;
      if (!saved) {
        showToast('添加失败，请重试');
        return null;
      }
      showToast(`已添加 ${saved?.nickname || saved?.name || actor.name}`);
      return saved;
    };
    const currentPhoneOwner = async () => (
      characters.find((row) => row.id === selectedId)
      || getCharacter(selectedId, { userId: user.id }).catch(() => null)
    );
    const reviewAndSaveNpcCandidates = async ({ owner, candidates, generatedOnly = false } = {}) => {
      const list = Array.isArray(candidates) ? candidates : [];
      if (!owner || !list.length) return [];
      const ownerId = String(owner.id || '').trim();
      if (!ownerId || selectedId !== ownerId) return [];
      const picked = await openParticipantPicker({
        title: generatedOnly ? '选择要加入的 NPC' : '选择要加入的联系人',
        items: list.map((row) => ({
          id: row.id,
          name: row.name,
          remark: row.remark || '',
          detail: `${row.source === 'generated' ? '新 NPC' : '人设关系'}${row.relationship ? ` · ${row.relationship}` : ''}`,
        })),
        multiple: true,
        preselected: generatedOnly
          ? list.map((row) => row.id)
          : list.filter((row) => row.source !== 'generated').map((row) => row.id),
        confirmLabel: '加入手机',
        editableNames: true,
        editableRemarks: true,
        onNameChange: (id, name) => {
          const candidate = list.find((row) => row.id === id);
          if (candidate) candidate.name = name;
        },
        onRemarkChange: (id, remark) => {
          const candidate = list.find((row) => row.id === id);
          if (candidate) candidate.remark = remark;
        },
      });
      if (!picked?.length) return [];
      if (selectedId !== ownerId) {
        showToast('已切换到其他角色，本次联系人未写入');
        return [];
      }
      const selected = new Set(picked);
      return saveNpcCandidatesToPhone({
        userId: user.id,
        user,
        owner,
        candidates: list.filter((row) => selected.has(row.id)),
      });
    };
    const createQuickPhoneGroup = async () => {
      if (!selectedId) return null;
      const owner = await currentPhoneOwner();
      if (!owner) return null;
      const actors = (phoneSocialDirectory.candidates || [])
        .filter((actor) => actor?.id && actor.id !== selectedId && actor.id !== 'user')
        .map((actor) => ({
          id: actor.id,
          name: actor.contact?.nickname || actor.name || actor.contact?.name || actor.id,
          detail: actor.contact?.category ? categoryLabelOf(actor.contact.category) : '',
        }));
      if (!actors.length) {
        showToast('先添加至少一位联系人');
        return null;
      }
      const draft = await openPhoneQuickGroupModal({
        ownerName: nameOf(owner),
        actors,
      });
      if (!draft?.actorIds?.length) return null;
      const memberIds = [];
      for (const actorId of draft.actorIds) {
        const actor = phoneSocialDirectory.resolve(actorId);
        const contact = actor
          ? await ensurePhoneSocialActorContact(user.id, selectedId, actor)
          : (phoneContacts.contacts || []).find((item) => phoneContactCanonicalActorId(item) === actorId);
        if (contact?.id) memberIds.push(contact.id);
      }
      const uniqueMemberIds = [...new Set(memberIds)];
      if (!uniqueMemberIds.length) {
        showToast('所选成员已不在通讯录');
        return null;
      }
      const pickedNames = draft.actorIds
        .map((id) => actors.find((actor) => actor.id === id)?.name || '')
        .filter(Boolean);
      const fallbackName = [nameOf(owner), ...pickedNames]
        .slice(0, 3)
        .join('、') || '新群聊';
      const group = await upsertPhoneContactGroup(user.id, selectedId, {
        name: draft.name || fallbackName,
        memberIds: uniqueMemberIds,
      });
      if (!group) throw new Error('群聊创建失败');
      phoneContacts = await loadCharacterPhoneContacts(user.id, selectedId).catch(() => phoneContacts);
      const parentChatId = await resolvePhoneMainParentChatId(user.id, selectedId).catch(() => '');
      const participants = resolvePhoneGroupParticipantIds(
        selectedId,
        group,
        phoneContacts.contacts || [],
      );
      const chat = await ensureBackstageChat(
        user.id,
        parentChatId || `phone:${selectedId}`,
        group.name,
        participants,
        {
          ownerId: selectedId,
          phoneOwnerId: selectedId,
          phoneContactGroupId: group.id,
          allowParticipantExpansion: true,
          userInitiated: true,
        },
      );
      showToast(`已创建 ${group.name}`);
      if (chat?.id) openPhoneChatInThread(chat.id);
      return chat;
    };
    container.querySelectorAll('[data-phone-contact-action]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const action = btn.getAttribute('data-phone-contact-action') || '';
        if (action === 'new') {
          const draft = await openPhoneContactCreateModal();
          if (!draft) return;
          const added = draft.mode === 'directory'
            ? await pickAddressBookContactForPhone()
            : await upsertPhoneContact(user.id, selectedId, {
              name: draft.name,
              remark: draft.remark,
              category: draft.category,
              note: draft.relationship,
              personaCapsule: { relationship: draft.relationship },
            });
          if (added) {
            if (draft.mode === 'manual') showToast(`已添加 ${added.nickname || added.name}`);
            phoneChatSection = 'contacts';
            await paint();
          }
          return;
        }
        if (action === 'groups') {
          btn.disabled = true;
          try {
            await createQuickPhoneGroup();
          } catch (err) {
            showToast(String(err?.message || err || '群聊创建失败').slice(0, 120));
          } finally {
            btn.disabled = false;
          }
          return;
        }
        if (action === 'extract') {
          const owner = await currentPhoneOwner();
          if (!owner) return;
          const operationId = ++phoneContactOperationId;
          const ownerId = String(owner.id || '').trim();
          btn.disabled = true;
          try {
            showToast('正在读取角色卡…');
            const candidates = await extractNpcCandidatesFromCharacter(owner, { user });
            if (operationId !== phoneContactOperationId || selectedId !== ownerId) {
              showToast('角色已切换，请在当前角色下重新提取');
              return;
            }
            const saved = await reviewAndSaveNpcCandidates({ owner, candidates });
            if (!saved.length) return;
            showToast(`已加入 ${saved.length} 位关系人`);
            phoneChatSection = 'contacts';
            await paint();
          } catch (err) {
            showToast(String(err?.message || err));
          } finally {
            btn.disabled = false;
          }
          return;
        }
        if (action === 'generate') {
          const config = await openPhoneNpcGenerateModal();
          if (!config) return;
          const owner = await currentPhoneOwner();
          if (!owner) return;
          const operationId = ++phoneContactOperationId;
          const ownerId = String(owner.id || '').trim();
          setButtonLoading(btn, true, { label: `正在生成 ${config.count} 位…` });
          try {
            showToast(`正在结合人设与世界观生成 ${config.count} 位 NPC…`);
            const candidates = await generateNpcCandidatesFromCharacter(owner, {
              user,
              ...config,
            });
            if (operationId !== phoneContactOperationId || selectedId !== ownerId) {
              showToast('角色已切换，请在当前角色下重新生成');
              return;
            }
            const saved = await reviewAndSaveNpcCandidates({
              owner,
              candidates,
              generatedOnly: true,
            });
            if (!saved.length) return;
            showToast(`已加入 ${saved.length} 位临时 NPC`);
            phoneChatSection = 'contacts';
            await paint();
          } catch (err) {
            showToast(String(err?.message || err || '生成失败').slice(0, 120));
          } finally {
            setButtonLoading(btn, false);
          }
        }
      });
    });
    container.querySelectorAll('[data-phone-contact-avatar]').forEach((input) => {
      input.addEventListener('change', async () => {
        const file = input.files?.[0];
        const contactId = input.getAttribute('data-phone-contact-avatar') || '';
        input.value = '';
        if (!file || !contactId || !selectedId) return;
        try {
          const result = await fileToCroppedOptimizedAvatarDataUrl(file);
          if (!result) return;
          const savedContact = await upsertPhoneContact(user.id, selectedId, {
            id: contactId,
            avatar: result.dataUrl,
          });
          const linkedActorId = String(savedContact?.linkedActorId || '').trim();
          if (linkedActorId) {
            await updateLightweightNpcAvatar(linkedActorId, result.dataUrl, { userId: user.id });
            await syncPhoneContactAvatarsAcrossOwners(user.id, linkedActorId, result.dataUrl).catch(() => 0);
          }
          // 已链接主角色：同步角色卡，会话页与手机列表才一致
          const linkedId = String(savedContact?.linkedCharacterId || '').trim();
          if (linkedId) {
            const linked = characters.find((row) => row.id === linkedId)
              || displayCharacters.find((row) => row.id === linkedId)
              || await getCharacter(linkedId, { userId: user.id }).catch(() => null);
            if (linked) {
              const savedChar = await saveCharacterForUser(user.id, {
                ...linked,
                avatar: result.dataUrl,
              });
              await syncPhoneContactAvatarsAcrossOwners(user.id, savedChar.id, result.dataUrl).catch(() => 0);
              const idx = characters.findIndex((c) => c.id === savedChar.id);
              if (idx >= 0) characters[idx] = savedChar;
              const dIdx = displayCharacters.findIndex((c) => c.id === savedChar.id);
              if (dIdx >= 0) displayCharacters[dIdx] = savedChar;
            }
          }
          phoneContacts = await loadCharacterPhoneContacts(user.id, selectedId).catch(() => phoneContacts);
          await paint();
        } catch (_) {
          showToast('头像读取失败');
        }
      });
    });
    container.querySelectorAll('[data-phone-group-avatar]').forEach((input) => {
      input.addEventListener('change', async () => {
        const file = input.files?.[0];
        const groupId = input.getAttribute('data-phone-group-avatar') || '';
        input.value = '';
        if (!file || !groupId || !selectedId) return;
        try {
          const result = await fileToCroppedOptimizedAvatarDataUrl(file);
          if (!result) return;
          await upsertPhoneContactGroup(user.id, selectedId, {
            id: groupId,
            avatar: result.dataUrl,
          });
          await paint();
        } catch (_) {
          showToast('头像读取失败');
        }
      });
    });
    container.querySelectorAll('[data-phone-group-delete]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const groupId = btn.getAttribute('data-phone-group-delete') || '';
        if (!groupId || !selectedId) return;
        const group = (phoneContacts.groups || []).find((item) => item.id === groupId);
        const label = group?.name || '轻量群';
        if (!window.confirm(`删除轻量群「${label}」？\n\n会移除群定义，并删除对应的群聊会话与消息。`)) return;
        try {
          const matchedChat = (phoneChatRows || []).find((chat) => (
            chat?.type === 'group'
            && matchPhoneContactGroupForChat(
              selectedId,
              chat,
              [group].filter(Boolean),
              phoneContacts.contacts || [],
            )?.id === groupId
          )) || (phoneChatRows || []).find((chat) => (
            chat?.type === 'group'
            && String(chat.groupSettings?.name || '').trim() === String(label).trim()
          ));
          if (matchedChat?.id) {
            await deleteChatWithData(matchedChat.id, user.id);
          }
          await deletePhoneContactGroups(user.id, selectedId, [groupId]);
          phoneContacts = await loadCharacterPhoneContacts(user.id, selectedId).catch(() => phoneContacts);
          phoneChatRows = await listCharacterPhoneChats(user.id, selectedId).catch(() => phoneChatRows);
          showToast('已删除轻量群');
          await paint();
        } catch (error) {
          showToast(String(error?.message || error || '删除失败').slice(0, 120));
        }
      });
    });
    container.querySelectorAll('[data-phone-chat-id]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (Date.now() < interceptRowClickSuppressUntil) return;
        if (btn.classList.contains('is-intercept') && btn.getAttribute('data-phone-chat-empty') === '1') {
          showToast('这扇拦截会话还没有消息，可点「生成一轮」补入');
          return;
        }
        openPhoneChatInThread(btn.getAttribute('data-phone-chat-id') || '');
      });
      if (btn.classList.contains('is-intercept')) {
        bindLongPress(btn, () => {
          if (chatManageMode) return;
          const chatId = btn.getAttribute('data-phone-chat-id') || '';
          if (!chatId || !selectedId) return;
          const title = String(btn.querySelector('.cphone-chat-row-main b')?.textContent || '')
            .replace(/\s+/g, ' ')
            .trim() || '拦截会话';
          interceptRowClickSuppressUntil = Date.now() + 500;
          openChatRowSheet({
            chatTitle: title,
            actions: [{
              label: '删除拦截会话',
              variant: 'danger',
              onClick: async () => {
                if (!window.confirm(`删除「${title}」？聊天记录会清掉，相关黑名单联系人也会一并移除。`)) return;
                try {
                  const result = await deletePhoneInterceptItems({ chatIds: [chatId] });
                  summarizeInterceptDeleteResult(result);
                  await loadState();
                  await paint({ soft: true });
                } catch (error) {
                  showToast(String(error?.message || error || '删除失败').slice(0, 120));
                }
              },
            }],
          });
        });
      }
    });
    container.querySelectorAll('[data-phone-contact-chat]').forEach((btn) => {
      btn.addEventListener('click', () => {
        startPhoneContactChat(btn.getAttribute('data-phone-contact-chat') || '', btn);
      });
    });
    // 一次 API 调用生成整机聊天动态：可以自建联系人/群、给多扇窗补往来消息。
    // 单窗精修走会话里的「推进」，不在这里逐窗调用。
    const runPhoneChatBackfill = async () => {
      if (phoneChatBusy || !selectedId) return;
      phoneChatBusy = true;
      const controller = new AbortController();
      phoneGeneration = { active: true, scope: '补一轮手机动态', message: '正在整理人设与通讯录…', controller };
      await paint({ soft: true });
      try {
        const summary = await generatePhoneLifeBatch({
          user,
          ownerId: selectedId,
          signal: controller.signal,
          onProgress: async (message) => {
            if (!updateGenerationHudMessage(message)) await paint({ soft: true });
          },
        });
        const parts = [
          summary.threads ? `${summary.threads} 扇窗 ${summary.messages} 条消息` : '',
          summary.contacts ? `新联系人 ${summary.contacts}` : '',
          summary.groups ? `新群 ${summary.groups}` : '',
        ].filter(Boolean);
        showToast(`已补一轮手机动态：${parts.join('，')}`);
      } catch (error) {
        if (error?.name !== 'AbortError') {
          void showPhoneGenerationError(error, {
            scope: '角色手机 / 补手机动态',
            title: '补手机动态失败',
          });
          showToast(String(error?.message || error || '生成失败').slice(0, 120));
        }
      } finally {
        phoneChatBusy = false;
        phoneGeneration = { active: false, scope: '', message: '', controller: null };
        await loadState();
        await paint({ soft: true });
      }
    };
    const runPhoneChatUndo = async () => {
      if (phoneChatBusy || !selectedId || !lastPhoneLifeBatch?.batchId) return;
      if (!window.confirm('撤销上一轮手机动态？只会删除那一轮生成的消息与新建联系人/群。')) return;
      phoneChatBusy = true;
      phoneGeneration = { active: true, scope: '撤销上一轮动态', message: '正在撤销…', controller: null };
      await paint({ soft: true });
      try {
        const result = await undoLastPhoneLifeBatch(user.id, selectedId);
        showToast(`已撤销：${result.messages} 条消息${result.chats ? `，${result.chats} 个空窗` : ''}`);
      } catch (error) {
        void showPhoneGenerationError(error, {
          scope: '角色手机 / 撤销动态',
          title: '撤销失败',
        });
        showToast(String(error?.message || error || '撤销失败').slice(0, 120));
      } finally {
        phoneChatBusy = false;
        phoneGeneration = { active: false, scope: '', message: '', controller: null };
        await loadState();
        await paint({ soft: true });
      }
    };
    const runPhoneChatReroll = async () => {
      if (phoneChatBusy || !selectedId || !lastPhoneLifeBatch?.batchId) return;
      if (!window.confirm('重 roll 上一轮手机动态？会先撤销再重新生成。')) return;
      phoneChatBusy = true;
      const controller = new AbortController();
      phoneGeneration = { active: true, scope: '重 roll 上一轮动态', message: '正在撤销上一轮…', controller };
      await paint();
      try {
        const summary = await rerollLastPhoneLifeBatch({
          user,
          ownerId: selectedId,
          signal: controller.signal,
          onProgress: async (message) => {
            if (!updateGenerationHudMessage(message)) await paint({ soft: true });
          },
        });
        const parts = [
          summary.threads ? `${summary.threads} 扇窗 ${summary.messages} 条消息` : '',
          summary.contacts ? `新联系人 ${summary.contacts}` : '',
          summary.groups ? `新群 ${summary.groups}` : '',
        ].filter(Boolean);
        showToast(`已重 roll：${parts.join('，')}`);
      } catch (error) {
        if (error?.name !== 'AbortError') {
          void showPhoneGenerationError(error, {
            scope: '角色手机 / 重 roll 动态',
            title: '重 roll 失败',
          });
          showToast(String(error?.message || error || '重 roll 失败').slice(0, 120));
        }
      } finally {
        phoneChatBusy = false;
        phoneGeneration = { active: false, scope: '', message: '', controller: null };
        await loadState();
        await paint();
      }
    };
    container.querySelectorAll('[data-phone-chat-batch]').forEach((btn) => {
      btn.addEventListener('click', runPhoneChatBackfill);
    });
    container.querySelectorAll('[data-phone-chat-undo]').forEach((btn) => {
      btn.addEventListener('click', runPhoneChatUndo);
    });
    container.querySelectorAll('[data-phone-chat-reroll]').forEach((btn) => {
      btn.addEventListener('click', runPhoneChatReroll);
    });
    container.querySelectorAll('[data-phone-chat-manage]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (phoneChatSection !== 'contacts' && phoneChatSection !== 'intercept') {
          phoneChatSection = 'messages';
        }
        chatManageMode = true;
        chatSelectedIds.clear();
        contactSelectedIds.clear();
        await paint();
      });
    });
    container.querySelectorAll('[data-phone-chat-manage-exit]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        chatManageMode = false;
        chatSelectedIds.clear();
        contactSelectedIds.clear();
        await paint();
      });
    });
    container.querySelectorAll('[data-phone-chat-select]').forEach((input) => {
      input.addEventListener('change', () => {
        const id = input.getAttribute('data-phone-chat-select') || '';
        if (!id) return;
        if (input.checked) chatSelectedIds.add(id);
        else chatSelectedIds.delete(id);
        // 只改勾选态与删除按钮，避免整页重绘把通讯录/会话列表滚回顶部
        input.closest('.cphone-chat-row')?.classList.toggle('is-checked', input.checked);
        syncChatManageDeleteButton('chat');
      });
    });
    container.querySelectorAll('[data-phone-contact-select]').forEach((input) => {
      input.addEventListener('change', () => {
        const id = input.getAttribute('data-phone-contact-select') || '';
        if (!id) return;
        if (input.checked) contactSelectedIds.add(id);
        else contactSelectedIds.delete(id);
        input.closest('.cphone-contact-row, .cphone-chat-row')?.classList.toggle('is-checked', input.checked);
        syncChatManageDeleteButton('contact');
      });
    });
    container.querySelector('[data-phone-chat-delete-selected]')?.addEventListener('click', async () => {
      if (!selectedId || !chatSelectedIds.size) return;
      if (!window.confirm(`删除已选的 ${chatSelectedIds.size} 个会话？会一并清掉消息与相关记忆；若是轻量群，群定义也会删除，不会再自动建回来。`)) return;
      phoneChatBusy = true;
      try {
        const contactsSnapshot = await loadCharacterPhoneContacts(user.id, selectedId).catch(() => phoneContacts);
        const groupIdsToDrop = new Set();
        for (const chatId of [...chatSelectedIds]) {
          const chat = phoneChatRows.find((row) => row.id === chatId) || await getChat(chatId).catch(() => null);
          if (chat?.type === 'group') {
            const matched = matchPhoneContactGroupForChat(
              selectedId,
              chat,
              contactsSnapshot?.groups || [],
              contactsSnapshot?.contacts || [],
            );
            if (matched?.id) groupIdsToDrop.add(matched.id);
          }
          await deleteChatWithData(chatId, user.id);
        }
        if (groupIdsToDrop.size) {
          await deletePhoneContactGroups(user.id, selectedId, [...groupIdsToDrop]);
        }
        showToast(`已删除 ${chatSelectedIds.size} 个会话`);
        chatManageMode = false;
        chatSelectedIds.clear();
        await loadState();
        await paint();
      } catch (error) {
        showToast(String(error?.message || error || '删除失败').slice(0, 120));
      } finally {
        phoneChatBusy = false;
      }
    });
    container.querySelector('[data-phone-intercept-delete-selected]')?.addEventListener('click', async () => {
      if (!selectedId || (!chatSelectedIds.size && !contactSelectedIds.size)) return;
      const chatCount = chatSelectedIds.size;
      const contactCount = contactSelectedIds.size;
      const parts = [];
      if (chatCount) parts.push(`${chatCount} 个拦截会话`);
      if (contactCount) parts.push(`${contactCount} 位黑名单联系人`);
      if (!window.confirm(`删除已选的 ${parts.join('、')}？会话消息会清掉；相关黑名单联系人也会一并从手机通讯录移除，避免删完又冒回来。`)) return;
      phoneChatBusy = true;
      try {
        const result = await deletePhoneInterceptItems({
          chatIds: [...chatSelectedIds],
          contactIds: [...contactSelectedIds],
        });
        summarizeInterceptDeleteResult(result);
        chatManageMode = false;
        chatSelectedIds.clear();
        contactSelectedIds.clear();
        await loadState();
        await paint();
      } catch (error) {
        showToast(String(error?.message || error || '删除失败').slice(0, 120));
      } finally {
        phoneChatBusy = false;
      }
    });
    container.querySelector('[data-phone-contact-delete-selected]')?.addEventListener('click', async () => {
      if (!selectedId || !contactSelectedIds.size) return;
      if (!window.confirm(`从手机通讯录删除已选的 ${contactSelectedIds.size} 位联系人？不会删除你主通讯录里的角色；其中的主角色会记为「已移除」，未再添加前不会自动联系。`)) return;
      try {
        const result = await deletePhoneContacts(user.id, selectedId, [...contactSelectedIds]);
        showToast(result.deleted ? `已删除 ${result.deleted} 位联系人` : '没有可删除的联系人');
        chatManageMode = false;
        contactSelectedIds.clear();
        phoneContacts = await loadCharacterPhoneContacts(user.id, selectedId).catch(() => phoneContacts);
        await paint();
      } catch (error) {
        showToast(String(error?.message || error || '删除失败').slice(0, 120));
      }
    });
    const leavePhoneContactEdit = async () => {
      phoneContactEditId = '';
      phoneChatSection = 'contacts';
      await paint();
    };
    container.querySelectorAll('[data-phone-contact-edit-back]').forEach((btn) => {
      btn.addEventListener('click', () => leavePhoneContactEdit());
    });
    container.querySelector('[data-phone-user-contact]')?.addEventListener('click', async () => {
      phoneContactEditId = 'user';
      phoneChatSection = 'contacts';
      await paint({ soft: true });
    });
    container.querySelector('[data-phone-user-remark-form]')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      phoneContacts = await savePhoneUserRemark(
        user.id,
        selectedId,
        String(data.get('remark') || '').trim(),
        'manual',
      );
      showToast('备注已保存');
      await paint({ soft: true });
    });
    container.querySelector('[data-phone-user-remark-generate]')?.addEventListener('click', async (event) => {
      const btn = event.currentTarget;
      const owner = selectedCharacter();
      if (!owner || !selectedId) return;
      setButtonLoading(btn, true, { label: 'TA 正在填写…' });
      try {
        const remark = await generatePhoneUserRemark(owner, { user });
        phoneContacts = await savePhoneUserRemark(user.id, selectedId, remark, 'ai');
        showToast(`TA 给你的备注是「${remark}」`);
        await paint({ soft: true });
      } catch (error) {
        showToast(String(error?.message || error || '备注生成失败').slice(0, 120));
      } finally {
        if (btn.isConnected) setButtonLoading(btn, false);
      }
    });
    container.querySelector('[data-phone-contact-remark-form]')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const contactId = form.getAttribute('data-phone-contact-remark-form') || '';
      const data = new FormData(form);
      const saved = await upsertPhoneContact(user.id, selectedId, {
        id: contactId,
        remark: String(data.get('remark') || '').trim(),
      });
      if (!saved) {
        showToast('备注保存失败');
        return;
      }
      phoneContacts = await loadCharacterPhoneContacts(user.id, selectedId).catch(() => phoneContacts);
      showToast('备注已保存');
      await paint({ soft: true });
    });
    container.querySelectorAll('[data-phone-contact-open-character]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-phone-contact-open-character') || '';
        if (id) navigate('contacts/edit', { id, scope: 'identity', identityUserId: user.id });
      });
    });
    container.querySelectorAll('[data-phone-contact-remove-linked]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const characterId = btn.getAttribute('data-phone-contact-remove-linked') || '';
        if (!characterId || !selectedId) return;
        const label = nameOf(
          characters.find((row) => row.id === characterId) || { name: characterId },
          '这位联系人',
        );
        if (!window.confirm(`从这部手机通讯录移除「${label}」？\n\n不会删除主通讯录角色，也不会拆掉认识关系；未再主动添加前，TA 不会通过手机自动联系对方。`)) return;
        try {
          const result = await removePhoneLinkedCharacters(user.id, selectedId, [characterId]);
          showToast(result.removed ? `已从手机移除 ${label}` : '没有可移除的联系人');
          phoneContactEditId = '';
          phoneChatSection = 'contacts';
          phoneContacts = await loadCharacterPhoneContacts(user.id, selectedId).catch(() => phoneContacts);
          await paint();
        } catch (error) {
          showToast(String(error?.message || error || '移除失败').slice(0, 120));
        }
      });
    });
    container.querySelectorAll('[data-phone-contact-open-chat]').forEach((btn) => {
      btn.addEventListener('click', () => {
        startPhoneContactChat(btn.getAttribute('data-phone-contact-open-chat') || '', btn);
      });
    });
    container.querySelectorAll('[data-phone-contact-edit-avatar]').forEach((input) => {
      input.addEventListener('change', async () => {
        const file = input.files?.[0];
        const contactId = input.getAttribute('data-phone-contact-edit-avatar') || '';
        input.value = '';
        if (!file || !contactId || !selectedId) return;
        try {
          const result = await fileToCroppedOptimizedAvatarDataUrl(file);
          if (!result) return;
          const savedContact = await upsertPhoneContact(user.id, selectedId, {
            id: contactId,
            avatar: result.dataUrl,
          });
          const linkedActorId = String(savedContact?.linkedActorId || '').trim();
          if (linkedActorId) {
            await updateLightweightNpcAvatar(linkedActorId, result.dataUrl, { userId: user.id });
            await syncPhoneContactAvatarsAcrossOwners(user.id, linkedActorId, result.dataUrl).catch(() => 0);
          }
          const linkedId = String(savedContact?.linkedCharacterId || '').trim();
          if (linkedId) {
            const linked = characters.find((row) => row.id === linkedId)
              || displayCharacters.find((row) => row.id === linkedId)
              || await getCharacter(linkedId, { userId: user.id }).catch(() => null);
            if (linked) {
              const savedChar = await saveCharacterForUser(user.id, {
                ...linked,
                avatar: result.dataUrl,
              });
              await syncPhoneContactAvatarsAcrossOwners(user.id, savedChar.id, result.dataUrl).catch(() => 0);
              const idx = characters.findIndex((c) => c.id === savedChar.id);
              if (idx >= 0) characters[idx] = savedChar;
              const dIdx = displayCharacters.findIndex((c) => c.id === savedChar.id);
              if (dIdx >= 0) displayCharacters[dIdx] = savedChar;
            }
          }
          phoneContacts = await loadCharacterPhoneContacts(user.id, selectedId).catch(() => phoneContacts);
          await paint();
        } catch (_) {
          showToast('头像读取失败');
        }
      });
    });
    container.querySelector('[data-phone-contact-edit-form]')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const contactId = form.getAttribute('data-phone-contact-edit-form') || '';
      if (!contactId || !selectedId) return;
      const data = new FormData(form);
      const name = String(data.get('name') || '').trim();
      if (!name) {
        showToast('请填写姓名');
        return;
      }
      const traits = String(data.get('traits') || '')
        .split(/[、,，]/g)
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, 8);
      await upsertPhoneContact(user.id, selectedId, {
        id: contactId,
        name,
        remark: String(data.get('remark') || '').trim(),
        category: String(data.get('category') || 'other').trim() || 'other',
        note: String(data.get('note') || '').trim(),
        personaCapsule: {
          relationship: String(data.get('relationship') || '').trim(),
          summary: String(data.get('summary') || '').trim(),
          traits,
          speechStyle: String(data.get('speechStyle') || '').trim(),
          boundary: String(data.get('boundary') || '').trim(),
        },
        translationProfile: {
          mode: String(data.get('translationMode') || 'off').trim(),
          language: String(data.get('translationLanguage') || '').trim(),
          dialectNote: String(data.get('translationDialectNote') || '').trim(),
        },
      });
      phoneContacts = await loadCharacterPhoneContacts(user.id, selectedId).catch(() => phoneContacts);
      showToast('已保存');
      await paint();
    });
    container.querySelectorAll('[data-phone-contact-promote]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const contactId = btn.getAttribute('data-phone-contact-promote') || '';
        if (!contactId || !selectedId) return;
        const contact = (phoneContacts.contacts || []).find((item) => item.id === contactId);
        const label = contact?.name || contact?.nickname || 'TA';
        if (!window.confirm(`把「${label}」加入你的通讯录？\n\n加入后会成为常驻角色，可继续编辑完整人设。`)) return;
        btn.disabled = true;
        try {
          const result = await promotePhoneContactToCharacter(user.id, selectedId, contactId);
          phoneContacts = await loadCharacterPhoneContacts(user.id, selectedId).catch(() => phoneContacts);
          if (result.character && !characters.some((row) => row.id === result.character.id)) {
            characters.push(result.character);
          }
          phoneContactEditId = '';
          showToast(result.alreadyLinked
            ? `「${result.character.name}」已在通讯录`
            : `已把「${result.character.name}」加入通讯录`);
          navigate('contacts/edit', { id: result.character.id, scope: 'identity', identityUserId: user.id });
        } catch (error) {
          showToast(String(error?.message || error || '加入失败').slice(0, 120));
          btn.disabled = false;
        }
      });
    });
    container.querySelectorAll('[data-phone-chat-auto]').forEach((control) => {
      control.addEventListener('change', async () => {
        const key = control.getAttribute('data-phone-chat-auto');
        if (!key || !selectedId) return;
        const value = control.type === 'checkbox' ? control.checked : Number(control.value);
        phoneChatAuto = await savePhoneChatAutoSettings(user.id, selectedId, { [key]: value })
          .catch(() => phoneChatAuto);
        showToast('手机内会话托管已保存');
      });
    });
    const returnToPhoneHome = async () => {
      if (phoneContactEditId) {
        phoneContactEditId = '';
        phoneChatSection = 'contacts';
        await paint({ soft: true });
        return;
      }
      activeApp = 'home';
      openRecordId = '';
      photoPreview = null;
      pendingAvatarImport = null;
      await paint({ soft: true });
    };
    // soft paint 会替换 .cphone-os-content，因此每次都要给新生成的 App 顶部返回键绑定；
    // 底部 Home 横条属于常驻设备外壳，只在整壳重绘时绑定，避免重复监听。
    container.querySelector('.cphone-os-content .cphone-phone-home')
      ?.addEventListener('click', returnToPhoneHome);
    if (!soft) {
      container.querySelector('.cphone-home-indicator')
        ?.addEventListener('click', returnToPhoneHome);
    }
    container.querySelector('.cphone-reroll-theme-input')?.addEventListener('input', (e) => {
      rerollThemeDraft = e.target.value;
    });
    container.querySelector('.cphone-gen-day')?.addEventListener('click', () => onGenerateDay(true));
    container.querySelector('.cphone-gen-week')?.addEventListener('click', onGenerateWeek);
    container.querySelector('.cphone-clear-schedule')?.addEventListener('click', onClearSchedule);
    container.querySelector('.cphone-change-plan')?.addEventListener('click', onChangePlan);
    container.querySelector('.cphone-gen-records')?.addEventListener('click', onGenerateRecords);
    container.querySelector('.cphone-refresh-map')?.addEventListener('click', onRefreshMap);
    container.querySelector('.cphone-record-select')?.addEventListener('click', async (e) => {
      enterRecordSelect(e.currentTarget.getAttribute('data-record-app') || activeApp);
      await paint({ soft: activeApp === 'photos' });
    });
    container.querySelector('.cphone-record-select-cancel')?.addEventListener('click', async () => {
      exitRecordSelect();
      await paint({ soft: activeApp === 'photos' });
    });
    container.querySelector('.cphone-record-delete')?.addEventListener('click', (e) => {
      onDeleteSelectedRecords(e.currentTarget.getAttribute('data-record-app') || activeApp);
    });
    container.querySelector('.cphone-photo-gen-batch')?.addEventListener('click', () => onGeneratePhotoImages());
    container.querySelector('.cphone-photo-gen-select')?.addEventListener('click', async () => {
      enterPhotoGenSelect();
      await paint({ soft: true });
    });
    container.querySelector('.cphone-photo-gen-cancel')?.addEventListener('click', async () => {
      exitPhotoGenSelect();
      await paint({ soft: true });
    });
    container.querySelector('.cphone-photo-gen-run')?.addEventListener('click', () => {
      if (!photoGenSelectedIds.size) {
        showToast('请先选择相册记录');
        return;
      }
      onGeneratePhotoImages({ recordIds: [...photoGenSelectedIds] });
    });
    if (photoGenSelectApp === 'photos') {
      container.querySelectorAll('[data-photo-id]').forEach((el) => {
        const id = el.getAttribute('data-photo-id');
        if (!id) return;
        el.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (photoGenSelectedIds.has(id)) photoGenSelectedIds.delete(id);
          else photoGenSelectedIds.add(id);
          el.classList.toggle('is-selected', photoGenSelectedIds.has(id));
          updatePhotoGenRunButton();
        }, true);
      });
    }
    if (recordSelectApp) {
      container.querySelectorAll('[data-record-id]').forEach((el) => {
        const id = el.getAttribute('data-record-id');
        if (!id) return;
        el.classList.add('cphone-record-selectable');
        if (recordSelectedIds.has(id)) el.classList.add('is-selected');
        el.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (recordSelectedIds.has(id)) recordSelectedIds.delete(id);
          else recordSelectedIds.add(id);
          el.classList.toggle('is-selected', recordSelectedIds.has(id));
          updateRecordDeleteButton();
        }, true);
      });
    }
    container.querySelectorAll('[data-open-music-app]').forEach((btn) => {
      btn.addEventListener('click', () => navigate('music'));
    });
    container.querySelectorAll('[data-phone-music-search]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const query = btn.getAttribute('data-phone-music-search') || '';
        if (!query.trim()) {
          navigate('music');
          return;
        }
        navigate('music', { query, provider: 'netease', autoSearch: '1' });
      });
    });
    container.querySelectorAll('.cphone-start-activity').forEach((btn) => {
      btn.addEventListener('click', onStartActivity);
    });
    container.querySelectorAll('[data-start-offline]').forEach((el) => {
      el.addEventListener('click', onStartActivity);
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onStartActivity();
        }
      });
    });
    container.querySelectorAll('.cphone-resume-activity').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const chatId = btn.getAttribute('data-resume-chat') || '';
        if (!chatId) return;
        navigate('offline', { chatId });
      });
    });
    container.querySelectorAll('[data-record-detail]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        openRecordId = btn.getAttribute('data-record-detail') || '';
        await paint();
      });
    });
    container.querySelector('[data-close-record]')?.addEventListener('click', async () => {
      openRecordId = '';
      await paint();
    });
    container.querySelectorAll('[data-open-weibo-topic]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        const topic = btn.getAttribute('data-open-weibo-topic') || '';
        const record = (phone?.browserRecords || []).find((r) => r.id === openRecordId) || { query: topic, title: topic };
        const normalized = await ensureWeiboTopicFromBrowserRecord(record);
        openRecordId = '';
        if (normalized) navigate('weibo-topic', { topic: normalized });
      });
    });
    container.querySelectorAll('[data-open-forum-thread]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        const recId = btn.getAttribute('data-open-forum-thread') || openRecordId;
        const record = (phone?.browserRecords || []).find((r) => r.id === recId);
        if (!record) { showToast('找不到这条论坛记录'); return; }
        const threadId = await ensureForumThreadFromBrowserRecord(record);
        openRecordId = '';
        if (threadId) navigate('forum-detail', { threadId });
        else showToast('打开论坛帖失败');
      });
    });
    container.querySelector('[data-photo-load-more]')?.addEventListener('click', async () => {
      photoVisibleLimit += 24;
      await paint({ soft: true });
    });
    container.querySelectorAll(PHONE_ALBUM_IMAGE_SELECTOR).forEach((img) => {
      img.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        suppressPhotoClickUntil = Date.now() + 800;
      });
    });
    container.querySelectorAll('[data-photo-preview]').forEach((el) => {
      let touchStartedAt = 0;
      el.addEventListener('pointerdown', (e) => {
        if (e.pointerType !== 'touch' || !e.target.closest?.('.cphone-photo-thumb')) return;
        touchStartedAt = Date.now();
      });
      el.addEventListener('pointerup', (e) => {
        if (e.pointerType === 'touch' && touchStartedAt && Date.now() - touchStartedAt >= 450) {
          suppressPhotoClickUntil = Date.now() + 800;
        }
        touchStartedAt = 0;
      });
      el.addEventListener('pointercancel', () => {
        touchStartedAt = 0;
      });
      el.addEventListener('click', async (e) => {
        if (Date.now() < suppressPhotoClickUntil) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        if (photoGenSelectApp === 'photos') return;
        if (recordSelectApp) return;
        const recordId = el.getAttribute('data-photo-preview') || '';
        const record = (phone?.photoRecords || []).find((row) => String(row.id || '') === String(recordId));
        if (!record) return;
        e.preventDefault();
        e.stopPropagation();
        const imageUrl = imageUrlFromRecord(record);
        const textImage = resolvePhotoTextImage(record);
        // 文字图走聊天同款加宽可读弹层，避免缩略截断后无法看全文。
        if (!imageUrl && textImage) {
          openChatCardModal({ type: 'textimg', content: textImage });
          return;
        }
        photoPreview = {
          recordId: record.id,
          url: imageUrl,
          textImageCaption: textImage,
          canReroll: photoRecordCanReroll(record),
        };
        await paint({ soft: true });
      });
    });
    container.querySelectorAll('[data-photo-url]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        if (Date.now() < suppressPhotoClickUntil) {
          e.preventDefault();
          return;
        }
        if (photoGenSelectApp === 'photos') return;
        if (btn.closest?.('[data-photo-preview]')) return;
        photoPreview = {
          recordId: btn.getAttribute('data-photo-record-id') || '',
          url: btn.getAttribute('data-photo-url') || '',
          canReroll: false,
        };
        await paint({ soft: true });
      });
    });
    container.querySelectorAll('[data-avatar-preview]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const avatarId = btn.getAttribute('data-avatar-preview') || '';
        const record = (phone?.avatarLibrary || []).find((row) => String(row.id || '') === String(avatarId));
        const url = imageUrlFromRecord(record || {});
        if (!url) return;
        photoPreview = { recordId: record.id, url, canReroll: false };
        await paint({ soft: true });
      });
    });
    container.querySelector('[data-photo-save]')?.addEventListener('click', async () => {
      const btn = container.querySelector('[data-photo-save]');
      if (!btn || btn.disabled) return;
      const previewRecord = photoPreview?.recordId
        ? (phone?.photoRecords || []).find((r) => String(r.id || '') === String(photoPreview.recordId))
          || (phone?.avatarLibrary || []).find((r) => String(r.id || '') === String(photoPreview.recordId))
        : null;
      const url = String(
        photoPreview?.url
        || imageUrlFromRecord(previewRecord || {})
        || container.querySelector('.cphone-photo-card img')?.currentSrc
        || container.querySelector('.cphone-photo-card img')?.src
        || '',
      ).trim();
      if (!url) {
        showToast('没有可保存的图片');
        return;
      }
      const oldText = btn.textContent;
      btn.disabled = true;
      btn.textContent = '保存中…';
      try {
        await saveImageSrc(url, { filename: `marshmallow-phone-photo-${Date.now()}.png` });
        btn.textContent = '已保存';
        showToast('已保存');
      } catch (err) {
        console.warn('[character-phone] photo save failed', err);
        btn.textContent = '保存失败';
        showToast(`保存失败：${err?.message || err}`);
      } finally {
        setTimeout(() => {
          btn.textContent = oldText;
          btn.disabled = false;
        }, 1200);
      }
    });
    container.querySelector('[data-photo-reroll]')?.addEventListener('click', () => {
      const recordId = container.querySelector('[data-photo-reroll]')?.getAttribute('data-photo-reroll') || photoPreview?.recordId || '';
      if (!recordId) return;
      onGeneratePhotoImages({ recordIds: [recordId], forceReroll: true });
    });
    container.querySelector('[data-photo-reroll-cancel]')?.addEventListener('click', () => {
      phoneGeneration.controller?.abort();
      showToast('正在取消重 roll…');
    });
    const closePhotoPreview = async () => {
      photoPreview = null;
      await paint({ soft: true });
    };
    container.querySelectorAll('[data-close-photo]').forEach((btn) => {
      btn.addEventListener('click', closePhotoPreview);
    });
    // 点遮罩空白处也可关掉大图，避免文字图盖住右上角 × 时无路可退。
    container.querySelector('.cphone-photo-modal')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) void closePhotoPreview();
    });
    container.querySelector('[data-avatar-import-file]')?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;
      const descDraft = String(container.querySelector('.cphone-avatar-desc')?.value || '');
      try {
        showToast('正在处理图片…');
        const optimized = await fileToOptimizedAvatarDataUrl(file);
        const imageUrl = String(optimized?.dataUrl || '').trim();
        if (!imageUrl) throw new Error('图片处理失败');
        pendingAvatarImport = {
          name: '用户导入头像',
          imageUrl,
        };
        showToast('图片已选择，补一句描述后加入头像库');
        await paint({ soft: true });
        const ta = container.querySelector('.cphone-avatar-desc');
        if (ta && descDraft) ta.value = descDraft;
      } catch (err) {
        showToast(`读取图片失败：${err?.message || err}`);
      }
    });
    container.querySelector('.cphone-avatar-save')?.addEventListener('click', onSaveAvatarImport);
    container.querySelector('.cphone-avatar-pick')?.addEventListener('click', letCharacterPickAvatar);
    container.querySelectorAll('[data-use-avatar]').forEach((btn) => {
      btn.addEventListener('click', () => setCharacterAvatarFromLibrary(btn.getAttribute('data-use-avatar') || ''));
    });
    container.querySelector('[data-phone-wallpaper]')?.addEventListener('change', async (event) => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file || !phone) return;
      try {
        const wallpaper = await phoneWallpaperDataUrl(file, { title: '裁剪手机壁纸' });
        if (!wallpaper) return;
        phone = await updateCharacterPhoneShellPreferences(
          phone.userId,
          phone.characterId,
          { wallpaper, wallpaperAssetId: '' },
        );
        await paint();
      } catch (error) {
        showToast(String(error?.message || error || '壁纸保存失败'));
      }
    });
    const phoneWallpaperLibrary = container.querySelector('.cphone-wallpaper-library');
    async function refreshPhoneWallpaperLibrary() {
      const grid = phoneWallpaperLibrary?.querySelector('.cphone-wallpaper-library-grid');
      if (!grid) return;
      grid.innerHTML = '<span class="cphone-wallpaper-library-status">读取中…</span>';
      const assets = await listBeautifyAssets('image').catch(() => []);
      const images = assets
        .filter((asset) => /^(?:data:image\/|https:\/\/)/i.test(String(asset?.dataUrl || '')))
        .slice(0, 48);
      const selectedAssetId = String(phone?.shellPreferences?.wallpaperAssetId || '').trim();
      grid.innerHTML = images.length
        ? images.map((asset) => `
          <button type="button" class="cphone-wallpaper-library-item${selectedAssetId === String(asset.id) ? ' is-active' : ''}" data-phone-wallpaper-asset="${esc(asset.id)}" aria-label="使用 ${esc(asset.name || '壁纸')}">
            <img src="${esc(asset.dataUrl)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">
            <span>${esc(asset.name || '壁纸')}</span>
          </button>
        `).join('')
        : '<span class="cphone-wallpaper-library-status">壁纸库暂无图片</span>';
      grid.querySelectorAll('[data-phone-wallpaper-asset]').forEach((button) => {
        button.addEventListener('click', async () => {
          const assetId = String(button.getAttribute('data-phone-wallpaper-asset') || '').trim();
          const asset = images.find((item) => String(item.id) === assetId);
          if (!phone || !asset) {
            showToast('这张壁纸已经失效');
            return;
          }
          phone = await updateCharacterPhoneShellPreferences(
            phone.userId,
            phone.characterId,
            { wallpaper: '', wallpaperAssetId: assetId },
          );
          showToast(`已使用「${asset.name || '壁纸'}」`);
          await paint();
        });
      });
    }
    container.querySelector('[data-phone-wallpaper-library-toggle]')?.addEventListener('click', async () => {
      if (!phoneWallpaperLibrary) return;
      phoneWallpaperLibrary.hidden = !phoneWallpaperLibrary.hidden;
      if (!phoneWallpaperLibrary.hidden) await refreshPhoneWallpaperLibrary();
    });
    container.querySelector('[data-phone-wallpaper-url-save]')?.addEventListener('click', async () => {
      let wallpaper = String(container.querySelector('[data-phone-wallpaper-url]')?.value || '').trim();
      if (wallpaper.startsWith('//')) wallpaper = `https:${wallpaper}`;
      if (/^http:\/\//i.test(wallpaper)) wallpaper = `https://${wallpaper.slice(7)}`;
      if (!/^https:\/\//i.test(wallpaper) || !phone) {
        showToast('请输入可访问的图片 URL（https://…）');
        return;
      }
      phone = await updateCharacterPhoneShellPreferences(
        phone.userId,
        phone.characterId,
        { wallpaper, wallpaperAssetId: '' },
      );
      await paint();
    });
    container.querySelector('[data-phone-wallpaper-remove]')?.addEventListener('click', async () => {
      if (!phone) return;
      phone = await updateCharacterPhoneShellPreferences(
        phone.userId,
        phone.characterId,
        { wallpaper: '', wallpaperAssetId: '' },
      );
      await paint();
    });
    container.querySelector('[data-phone-photos-cover]')?.addEventListener('change', async (event) => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file || !phone) return;
      try {
        const photosCover = await phoneWallpaperDataUrl(file, {
          ...IMAGE_CROP_PRESETS.cover,
          title: '裁剪相册封面',
          compress: { maxSize: 1440, quality: 0.84 },
        });
        if (!photosCover) return;
        phone = await updateCharacterPhoneShellPreferences(
          phone.userId,
          phone.characterId,
          { photosCover },
        );
        await paint();
      } catch (error) {
        showToast(String(error?.message || error || '封面保存失败'));
      }
    });
    container.querySelector('[data-phone-photos-cover-remove]')?.addEventListener('click', async () => {
      if (!phone) return;
      phone = await updateCharacterPhoneShellPreferences(
        phone.userId,
        phone.characterId,
        { photosCover: '' },
      );
      await paint();
    });
    container.querySelectorAll('[data-phone-shell-field]').forEach((control) => {
      control.addEventListener('change', async () => {
        if (!phone) return;
        const key = control.getAttribute('data-phone-shell-field') || '';
        const value = control.type === 'range' ? Number(control.value) : control.value;
        phone = await updateCharacterPhoneShellPreferences(
          phone.userId,
          phone.characterId,
          { [key]: value },
        );
        await paint();
      });
    });
    container.querySelectorAll('[data-phone-shell-list]').forEach((control) => {
      control.addEventListener('change', async () => {
        if (!phone) return;
        const field = control.getAttribute('data-phone-shell-list') || '';
        if (field !== 'widgets' && field !== 'dock') return;
        const values = [...container.querySelectorAll(`[data-phone-shell-list="${field}"]`)]
          .filter((input) => input.checked)
          .map((input) => String(input.value || '').trim())
          .filter(Boolean);
        phone = await updateCharacterPhoneShellPreferences(
          phone.userId,
          phone.characterId,
          { [field]: values },
        );
        await paint();
      });
    });
    container.querySelectorAll('[data-phone-app-icon]').forEach((input) => {
      input.addEventListener('change', async (event) => {
        const appId = input.getAttribute('data-phone-app-icon') || '';
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!appId || !file || !phone) return;
        try {
          const iconUrl = await fileToCroppedCompressedDataUrl(file, {
            ...IMAGE_CROP_PRESETS.icon,
            compress: { maxSize: 240, preserveAlpha: true, quality: 0.84 },
          });
          if (!iconUrl) return;
          phone = await updateCharacterPhoneShellPreferences(
            phone.userId,
            phone.characterId,
            { appIcons: { [appId]: iconUrl } },
          );
          await paint();
        } catch (error) {
          showToast(String(error?.message || error || '图标保存失败'));
        }
      });
    });
    container.querySelector('[data-phone-app-icon-url-save]')?.addEventListener('click', async () => {
      let url = String(container.querySelector('[data-phone-app-icon-url]')?.value || '').trim();
      const appId = String(container.querySelector('[data-phone-app-icon-target]')?.value || '').trim();
      if (url.startsWith('//')) url = `https:${url}`;
      if (/^http:\/\//i.test(url)) url = `https://${url.slice(7)}`;
      if (!phone || !appId || !/^https:\/\//i.test(url)) {
        showToast('请选择图标并输入可访问的图片 URL（https://…）');
        return;
      }
      phone = await updateCharacterPhoneShellPreferences(
        phone.userId,
        phone.characterId,
        { appIcons: { [appId]: url } },
      );
      await paint();
    });
    container.querySelector('[data-phone-appearance-preset-save]')?.addEventListener('click', async () => {
      const name = String(container.querySelector('[data-phone-appearance-preset-name]')?.value || '').trim();
      if (!phone || !name) {
        showToast('先给这个美化预设取个名字');
        return;
      }
      const shell = phone.shellPreferences || {};
      phoneAppearancePresets = await savePhoneAppearancePreset(user.id, {
        name,
        shell: { ...shell, appearancePresets: [] },
      });
      showToast('已保存为跨角色美化预设');
      await paint();
    });
    container.querySelectorAll('[data-phone-appearance-preset-apply]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-phone-appearance-preset-apply') || '';
        const preset = phoneAppearancePresets.find((item) => item.id === id);
        if (!preset || !phone) return;
        phone = await updateCharacterPhoneShellPreferences(
          phone.userId,
          phone.characterId,
          { ...preset.shell, appearancePresets: [] },
          { replace: true },
        );
        showToast(`已套用「${preset.name}」`);
        await paint();
      });
    });
    container.querySelectorAll('[data-phone-appearance-preset-delete]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-phone-appearance-preset-delete') || '';
        phoneAppearancePresets = await deletePhoneAppearancePreset(user.id, id);
        await paint();
      });
    });
    container.querySelectorAll('[data-phone-calendar-date]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        calendarSelectedDate = btn.getAttribute('data-phone-calendar-date') || '';
        await paint();
      });
    });
    container.querySelector('.cphone-autonomy-total')?.addEventListener('change', async (e) => {
      const turnOn = !!e.target.checked;
      // 总开关开了、按日程主动却关着，等于开了个空壳（TA 依然不会来找你）。
      // 开启时把日程主动一起带上；关闭只动总开关，保留用户的细项配置。
      const needScheduleLink = turnOn
        && autonomySettings?.roleDefaults?.scheduleProactive?.enabled !== true;
      autonomySettings = await saveCharacterProactiveEnabled(user.id, selectedId, turnOn);
      if (needScheduleLink) {
        phone = await saveScheduleProactiveSettings(user.id, selectedId, { enabled: true });
        await saveCharacterPhoneAutomationConfig(user.id, selectedId, {
          scheduleProactive: { enabled: true },
        }).catch(() => {});
      }
      const { resyncAllChatSchedules } = await import('../core/background-scheduler.js');
      await resyncAllChatSchedules(user.id).catch(() => {});
      showToast(turnOn
        ? (needScheduleLink ? '主动行为已开启，已一并打开按日程主动' : '主动行为已开启')
        : '主动行为已暂停');
      await paint();
    });
    const saveMuteHours = async (patch = {}) => {
      const current = autonomySettings?.roleDefaults?.muteHours || { enabled: false, start: 23, end: 7 };
      autonomySettings = await saveCharacterAutonomySettings(user.id, selectedId, {
        roleDefaults: {
          muteHours: {
            enabled: patch.enabled != null ? !!patch.enabled : current.enabled === true,
            start: patch.start != null ? Number(patch.start) : current.start,
            end: patch.end != null ? Number(patch.end) : current.end,
          },
        },
      });
      const { resyncAllChatSchedules } = await import('../core/background-scheduler.js');
      await resyncAllChatSchedules(user.id).catch(() => {});
      try {
        const { syncCloudIdleContinueSchedules } = await import('../core/cloud-background-coordinator.js');
        await syncCloudIdleContinueSchedules(user).catch(() => {});
      } catch (_) {}
      return autonomySettings?.roleDefaults?.muteHours;
    };
    container.querySelector('.cphone-mute-hours-toggle')?.addEventListener('change', async (e) => {
      const mute = await saveMuteHours({ enabled: !!e.target.checked });
      showToast(mute?.enabled ? '静音时段已开启' : '静音时段已关闭');
      await paint();
    });
    const bindMuteHourInput = (selector, field) => {
      container.querySelector(selector)?.addEventListener('change', async (e) => {
        const hour = Math.max(0, Math.min(23, Math.trunc(Number(e.target.value))));
        if (!Number.isFinite(Number(e.target.value))) {
          e.target.value = field === 'start' ? '23' : '7';
          return;
        }
        e.target.value = String(hour);
        const mute = await saveMuteHours({ [field]: hour });
        if (mute?.start === mute?.end) {
          showToast('起止相同时静音不生效，请改成不同小时');
        } else {
          showToast('静音时段已保存');
        }
      });
    };
    bindMuteHourInput('.cphone-mute-hours-start', 'start');
    bindMuteHourInput('.cphone-mute-hours-end', 'end');
    container.querySelector('.cphone-real-person-toggle')?.addEventListener('change', async (e) => {
      const enabled = !!e.target.checked;
      const { saveRealPersonExperienceEnabled } = await import('../core/character-autonomy-settings.js');
      autonomySettings = await saveRealPersonExperienceEnabled(user.id, selectedId, enabled);
      const { resyncAllChatSchedules } = await import('../core/background-scheduler.js');
      await resyncAllChatSchedules(user.id).catch(() => {});
      showToast(enabled ? '真人感回复已开启' : '真人感回复已关闭');
      await paint();
    });
    container.querySelector('.cphone-system-auto-reply-toggle')?.addEventListener('change', async (e) => {
      const enabled = !!e.target.checked;
      autonomySettings = await saveCharacterAutonomySettings(user.id, selectedId, {
        roleDefaults: { realPersonMode: { systemAutoReplyEnabled: enabled } },
      });
      showToast(enabled ? '已开启登记留言回复' : '已关闭登记留言回复');
      await paint();
    });
    container.querySelector('.cphone-hard-offline-toggle')?.addEventListener('change', async (e) => {
      const enabled = !!e.target.checked;
      autonomySettings = await saveCharacterAutonomySettings(user.id, selectedId, {
        roleDefaults: { realPersonMode: { allowHardOffline: enabled } },
      });
      showToast(enabled ? '已允许 TA 自行完全下线' : '已关闭自主完全下线');
      await paint();
    });
    container.querySelector('.cphone-autonomy-frequency')?.addEventListener('change', async (e) => {
      autonomySettings = await saveCharacterAutonomySettings(user.id, selectedId, {
        roleDefaults: { realPersonMode: { frequencyPreset: e.target.value } },
      });
      const { resyncAllChatSchedules } = await import('../core/background-scheduler.js');
      await resyncAllChatSchedules(user.id).catch(() => {});
      showToast('回复频率已保存');
      await paint();
    });
    container.querySelector('.cphone-idle-reply-floor-toggle')?.addEventListener('change', async (e) => {
      const enabled = !!e.target.checked;
      autonomySettings = await saveCharacterAutonomySettings(user.id, selectedId, {
        roleDefaults: { realPersonMode: { idleReplyFloorEnabled: enabled } },
      });
      showToast(enabled ? '已开启自定义无输入等待' : '已恢复默认无输入等待');
      await paint();
    });
    container.querySelector('.cphone-idle-reply-floor-seconds-input')?.addEventListener('change', async (e) => {
      const seconds = Math.max(
        REAL_PERSON_IDLE_REPLY_FLOOR_MIN_SECONDS,
        Math.min(REAL_PERSON_IDLE_REPLY_FLOOR_MAX_SECONDS, Math.trunc(Number(e.target.value) || 3)),
      );
      e.target.value = String(seconds);
      autonomySettings = await saveCharacterAutonomySettings(user.id, selectedId, {
        roleDefaults: {
          realPersonMode: {
            idleReplyFloorEnabled: true,
            idleReplyFloorSeconds: seconds,
          },
        },
      });
      showToast(`无输入后最少等待 ${seconds} 秒`);
      await paint();
    });
    container.querySelector('.cphone-autonomy-generate')?.addEventListener('click', () => {
      onGenerateDay(false);
    });
    container.querySelector('.cphone-fixed-fallback-toggle')?.addEventListener('change', async (e) => {
      autonomySettings = await saveCharacterAutonomySettings(user.id, selectedId, {
        roleDefaults: {
          fixedFallback: {
            enabled: !!e.target.checked,
            explicitEnabled: !!e.target.checked,
          },
        },
      });
      const { resyncAllChatSchedules } = await import('../core/background-scheduler.js');
      await resyncAllChatSchedules(user.id).catch(() => {});
      showToast(e.target.checked ? '固定间隔兜底已开启' : '固定间隔兜底已关闭');
      await paint();
    });
    container.querySelector('.cphone-fixed-fallback-interval')?.addEventListener('change', async (e) => {
      const minutes = Math.max(1, Math.min(1440, Number(e.target.value) || 5));
      autonomySettings = await saveCharacterAutonomySettings(user.id, selectedId, {
        roleDefaults: { fixedFallback: { intervalMs: minutes * 60000 } },
      });
      const { resyncAllChatSchedules } = await import('../core/background-scheduler.js');
      await resyncAllChatSchedules(user.id).catch(() => {});
      showToast('兜底间隔已保存');
    });
    container.querySelector('.cphone-auto-toggle')?.addEventListener('change', async (e) => {
      autoSettings = await saveCharacterPhoneAutoSettings(user.id, {
        perCharacter: { [selectedId]: !!e.target.checked },
      });
      autonomySettings = await saveCharacterAutonomySettings(user.id, selectedId, {
        roleDefaults: { scheduleProactive: { autoGenerate: !!e.target.checked } },
      }, { dualWrite: false });
      await saveCharacterPhoneAutomationConfig(user.id, selectedId, {
        dailySchedule: { enabled: !!e.target.checked },
      }).catch(() => {});
      showToast(e.target.checked ? '已开启，后台会每天自动补全日程' : '已关闭');
      if (e.target.checked && !getDailyLifePlanForDate(phone, dateKey)?.blocks?.length) {
        onGenerateDay(false);
      } else {
        await paint();
      }
    });
    container.querySelector('.cphone-proactive-toggle')?.addEventListener('change', async (e) => {
      if (!selectedId) return;
      autonomySettings = await saveCharacterAutonomySettings(user.id, selectedId, {
        roleDefaults: { scheduleProactive: { enabled: !!e.target.checked } },
      });
      phone = await saveScheduleProactiveSettings(user.id, selectedId, { enabled: !!e.target.checked });
      await saveCharacterPhoneAutomationConfig(user.id, selectedId, {
        scheduleProactive: { enabled: !!e.target.checked },
      }).catch(() => {});
      showToast(e.target.checked ? '已开启生活主动消息' : '已关闭');
      await paint();
    });
    container.querySelector('.cphone-proactive-count')?.addEventListener('change', async (e) => {
      if (!selectedId) return;
      const rawLimit = Number(e.target.value);
      const limit = Math.max(
        1,
        Math.round(Number.isFinite(rawLimit) ? rawLimit : DEFAULT_PROACTIVE_DAILY_LIMIT),
      );
      e.target.value = String(limit);
      autonomySettings = await saveCharacterAutonomySettings(user.id, selectedId, {
        roleDefaults: { proactiveDailyLimit: limit },
      });
      proactiveUsage = await getCharacterProactiveUsageStatus(user.id, selectedId, nowTs).catch(() => proactiveUsage);
      showToast(`每日主动上限已设为 ${limit}`);
      await paint();
    });
    container.querySelector('.cphone-proactive-gap')?.addEventListener('change', async (e) => {
      if (!selectedId) return;
      autonomySettings = await saveCharacterAutonomySettings(user.id, selectedId, {
        roleDefaults: { scheduleProactive: { minGapMinutes: Number(e.target.value) || 0 } },
      });
      phone = await saveScheduleProactiveSettings(user.id, selectedId, { minGapMinutes: Number(e.target.value) || 0 });
      await saveCharacterPhoneAutomationConfig(user.id, selectedId, {
        scheduleProactive: { minGapMinutes: Number(e.target.value) || 0 },
      }).catch(() => {});
      showToast('已保存');
      await paint();
    });
    container.querySelector('[data-proactive-stats]')?.addEventListener('click', async () => {
      showProactiveStats = !showProactiveStats;
      await paint();
    });
    container.querySelector('.cphone-event-news-toggle')?.addEventListener('change', async (e) => {
      if (!selectedId) return;
      scheduleEventSettings = await saveScheduleEventSettings(user.id, selectedId, { eventNewsEnabled: !!e.target.checked });
      showToast(e.target.checked ? '已开启，明天起日程会先参考新资讯定事件' : '已关闭，回到兴趣驱动的老写法');
      await paint();
    });
    container.querySelector('.cphone-schedule-lang-toggle')?.addEventListener('change', async (e) => {
      if (!selectedId) return;
      scheduleEventSettings = await saveScheduleEventSettings(user.id, selectedId, {
        scheduleLanguageMode: e.target.checked ? SCHEDULE_LANGUAGE_FOLLOW_CHARACTER : 'chinese',
      });
      showToast(e.target.checked ? '已按角色语言写日程（含自动生成）' : '日程改回默认中文');
      await paint();
    });
    container.querySelector('.cphone-event-search-limit')?.addEventListener('change', async (e) => {
      if (!selectedId) return;
      scheduleEventSettings = await saveScheduleEventSettings(user.id, selectedId, { eventSearchDailyLimit: Number(e.target.value) || 0 });
      await paint();
    });
    container.querySelector('.cphone-translate-schedule')?.addEventListener('click', async () => {
      if (busy || !selectedId || !phone) return;
      const targetDate = String(
        container.querySelector('.cphone-translate-schedule')?.getAttribute('data-schedule-translate-date')
        || calendarSelectedDate
        || dateKey,
      ).trim();
      const character = selectedCharacter() || await getCharacter(selectedId, { userId: user.id }).catch(() => null);
      const languageHint = String(character?.translationProfile?.language || '').trim();
      busy = true;
      scheduleBusyLabel = '正在翻译日程…';
      await paint();
      try {
        const result = await repairDailyLifePlanTranslations({
          userId: user.id,
          characterId: selectedId,
          dateKey: targetDate,
          languageHint,
        });
        phone = result.phone;
        if (targetDate === dateKey) plan = result.plan;
        if (!result.repaired) {
          showToast(result.candidateCount
            ? (result.failureMessage || '没有获得有效中文译文，请重试')
            : '没有需要翻译的内容');
        } else if (result.remainingCount) {
          showToast(`已翻译 ${result.repaired}/${result.candidateCount} 处，其余内容未通过校验`);
        } else {
          showToast(`已补全 ${result.repaired} 处译文`);
        }
      } catch (e) {
        showToast(e?.message || '翻译日程失败');
      } finally {
        busy = false;
        scheduleBusyLabel = '';
        await paint();
      }
    });
    container.querySelectorAll('.cphone-note-toggle').forEach((input) => {
      input.addEventListener('change', async (e) => {
        const li = e.target.closest('[data-note-id]');
        const noteId = li?.getAttribute('data-note-id');
        if (!noteId || !selectedId) return;
        phone = await togglePhoneNoteComplete(user.id, selectedId, noteId, e.target.checked);
        await paint();
      });
    });
    if (activeApp === 'browser') {
      void bindLinkPreviewAnchors(container, 'a.cphone-link-preview').catch(() => {});
    }
    bindNarrationTranslationToggle(container, {
      onRepaired: async (translation, { button, sourceText }) => {
        const type = String(button?.getAttribute('data-phone-translation-type') || '').trim();
        const id = String(button?.getAttribute('data-phone-translation-id') || '').trim();
        const translationKey = String(button?.getAttribute('data-phone-translation-key') || '').trim();
        if (!type || !id || !phone) return;
        if (type === 'note') {
          phone.notes = (phone.notes || []).map((item) => (
            item?.id === id ? { ...item, translation, updatedAt: Date.now() } : item
          ));
        } else if (type === 'call') {
          phone.callRecords = (phone.callRecords || []).map((item) => (
            item?.id === id ? { ...item, translation, updatedAt: Date.now() } : item
          ));
        } else if (type === 'browser') {
          phone.browserRecords = (phone.browserRecords || []).map((item) => (
            item?.id === id ? { ...item, translation } : item
          ));
        } else if (type === 'browser-summary') {
          phone.browserRecords = (phone.browserRecords || []).map((item) => (
            item?.id === id ? { ...item, summaryTranslation: translation } : item
          ));
        } else if (type === 'browser-judgement') {
          phone.browserRecords = (phone.browserRecords || []).map((item) => (
            item?.id === id ? { ...item, aiJudgementTranslation: translation } : item
          ));
        } else if (type === 'photo') {
          phone.photoRecords = (phone.photoRecords || []).map((item) => (
            item?.id === id ? { ...item, translation } : item
          ));
        } else if (type === 'interest-detail') {
          phone.interestRecords = (phone.interestRecords || []).map((item) => (
            item?.id === id ? { ...item, translation } : item
          ));
        } else if (type === 'interest-judgement') {
          phone.interestRecords = (phone.interestRecords || []).map((item) => (
            item?.id === id ? { ...item, aiJudgementTranslation: translation } : item
          ));
        } else if (type === 'map-judgement') {
          phone.mapPins = (phone.mapPins || []).map((item) => (
            item?.id === id ? { ...item, aiJudgementTranslation: translation } : item
          ));
        } else if (type === 'map-next-action') {
          phone.mapPins = (phone.mapPins || []).map((item) => (
            item?.id === id ? { ...item, nextActionTranslation: translation } : item
          ));
        } else if (type === 'schedule-activity' || type === 'schedule-narrative') {
          const field = type === 'schedule-activity' ? 'activityTranslation' : 'narrativeTranslation';
          phone.dailyLifePlans = (phone.dailyLifePlans || []).map((day) => ({
            ...day,
            blocks: (day.blocks || []).map((block) => (
              String(block?.id || '') === id ? { ...block, [field]: translation } : block
            )),
          }));
          if (plan?.blocks) {
            plan = {
              ...plan,
              blocks: plan.blocks.map((block) => (
                String(block?.id || '') === id ? { ...block, [field]: translation } : block
              )),
              };
          }
        } else if (type === 'schedule-display' && translationKey) {
          const patchDisplayTranslation = (block) => {
            if (String(block?.id || '') !== id) return block;
            return {
              ...block,
              displayTranslations: {
                ...(block.displayTranslations || {}),
                [translationKey]: {
                  source: String(sourceText || '').trim(),
                  translation,
                },
              },
            };
          };
          phone.dailyLifePlans = (phone.dailyLifePlans || []).map((day) => ({
            ...day,
            blocks: (day.blocks || []).map(patchDisplayTranslation),
          }));
          if (plan?.blocks) plan = { ...plan, blocks: plan.blocks.map(patchDisplayTranslation) };
        } else if (type === 'schedule-theme' || type === 'schedule-mood') {
          const field = type === 'schedule-theme' ? 'dayThemeTranslation' : 'moodTranslation';
          phone.dailyLifePlans = (phone.dailyLifePlans || []).map((day) => (
            String(day?.dateKey || '') === id ? { ...day, [field]: translation } : day
          ));
          if (plan && String(plan.dateKey || '') === id) {
            plan = { ...plan, [field]: translation };
          }
        } else {
          return;
        }
        phone = await saveCharacterPhone(phone);
      },
      onFailed: ({ message } = {}) => showToast(message || '没有获得有效中文译文，请重试'),
    });
  }

  async function onGenerateDay(force) {
    if (busy || !selectedId) return;
    const character = selectedCharacter() || await getCharacter(selectedId, { userId: user.id }).catch(() => null);
    if (!character) { showToast('角色不存在'); return; }
    // 只有用户主动点日程生成按钮（force=true）时才带上手动主题；
    // 自动补全（切开关触发的 force=false）不应该被上次输入过、忘了清空的旧文字影响。
    const targetDateKey = force ? (calendarSelectedDate || dateKey) : dateKey;
    const targetPlan = getDailyLifePlanForDate(phone, targetDateKey);
    const targetIsToday = targetDateKey === dateKey;
    const targetDateLabel = targetIsToday
      ? '今日'
      : `${Number(targetDateKey.slice(5, 7))}月${Number(targetDateKey.slice(8, 10))}日`;
    const userDirective = force ? rerollThemeDraft.trim() : '';
    const noticeApp = activeApp;
    const notice = await beginLongTaskNotice({
      title: `${targetDateLabel}日程已生成`,
      body: `${character.customNickname || character.name || 'TA'}的${targetDateLabel}日程已经准备好`,
      tag: `phone-schedule-day-${selectedId}-${targetDateKey}`,
      isStillViewing: () => container.isConnected && activeApp === noticeApp,
    });
    busy = true;
    scheduleBusyLabel = targetPlan ? `正在重新生成${targetDateLabel}…` : `正在生成${targetDateLabel}…`;
    await paint();
    const btn = container.querySelector('.cphone-gen-day');
    const resetText = targetPlan
      ? (targetIsToday ? '重新生成今日' : '重新生成这天')
      : (targetIsToday ? '生成今日' : '生成这天');
    const timeoutState = createScheduleGenerationTimeout();
    if (btn) { btn.disabled = true; btn.textContent = '生成中…'; }
    showToast(targetPlan ? `正在重新生成${targetDateLabel}日程…` : `正在生成${targetDateLabel}日程…`, 3500);
    try {
      const result = await withScheduleGenerationTimeout(() => ensureDailyLifePlan({
        userId: user.id,
        characterId: selectedId,
        character,
        user,
        force: force || !targetPlan?.blocks?.length,
        targetDateKey,
        userDirective,
        signal: timeoutState.signal,
      }), timeoutState);
      phone = result.phone;
      plan = getDailyLifePlanForDate(phone, dateKey);
      rerollThemeDraft = '';
      void notice.complete();
      showToast(result.abortedSalvage
        ? '等待超时，已从已收到内容救回部分日程'
        : (result.salvaged
          ? '返回被截断，已救回可用部分（可重新生成补全）'
          : (result.generated ? `${targetDateLabel}骨架已生成` : `已有${targetDateLabel}骨架`)));
      await paint();
    } catch (e) {
      notice.cancel();
      showToast(scheduleGenerationErrorMessage(e, `生成${targetDateLabel}日程失败`), 7000);
      offerScheduleJsonRecovery(e, {
        mode: 'daily',
        onApplied: async (text) => {
          const character = selectedCharacter() || await getCharacter(selectedId, { userId: user.id }).catch(() => null);
          if (!character) throw new Error('角色不存在');
          const result = await tryApplyDailyScheduleFromRaw({
            userId: user.id,
            characterId: selectedId,
            character,
            user,
            dateKey: targetDateKey,
            force: true,
            raw: text,
            userDirective,
          });
          phone = result.phone;
          plan = getDailyLifePlanForDate(phone, dateKey);
          await paint();
          return result;
        },
      });
    } finally {
      timeoutState.clear();
      busy = false;
      scheduleBusyLabel = '';
      if (btn && container.contains(btn)) {
        btn.disabled = false;
        btn.textContent = resetText;
      }
      if (activeApp === 'schedule') await paint();
    }
  }

  async function onGenerateWeek() {
    if (busy || !selectedId) return;
    const character = selectedCharacter() || await getCharacter(selectedId, { userId: user.id }).catch(() => null);
    if (!character) return;
    const noticeApp = activeApp;
    const notice = await beginLongTaskNotice({
      title: '本周日程已生成',
      body: `${character.customNickname || character.name || 'TA'}的本周安排已经准备好`,
      tag: `phone-schedule-week-${selectedId}`,
      isStillViewing: () => container.isConnected && activeApp === noticeApp,
    });
    busy = true;
    scheduleBusyLabel = '正在生成本周…';
    await paint();
    const btn = container.querySelector('.cphone-gen-week');
    const timeoutState = createScheduleGenerationTimeout();
    if (btn) { btn.disabled = true; btn.textContent = '生成中…'; }
    showToast('正在生成本周日程…', 3500);
    try {
      const weekResult = await withScheduleGenerationTimeout(() => ensureWeeklyLifePlans({
        userId: user.id,
        characterId: selectedId,
        character,
        user,
        force: true,
        signal: timeoutState.signal,
      }), timeoutState);
      void notice.complete();
      showToast(weekResult?.salvaged
        ? '返回被截断，已救回可用部分（可重新生成补全）'
        : '本周骨架已生成');
      await paint();
    } catch (e) {
      notice.cancel();
      showToast(scheduleGenerationErrorMessage(e, '生成本周日程失败'), 7000);
      offerScheduleJsonRecovery(e, {
        mode: 'weekly',
        onApplied: async (text) => {
          const character = selectedCharacter() || await getCharacter(selectedId, { userId: user.id }).catch(() => null);
          if (!character) throw new Error('角色不存在');
          const result = await tryApplyWeeklyScheduleFromRaw({
            userId: user.id,
            characterId: selectedId,
            character,
            user,
            startDateKey: dateKey,
            raw: text,
          });
          phone = result.phone;
          plan = getDailyLifePlanForDate(phone, dateKey);
          await paint();
          return result;
        },
      });
    } finally {
      timeoutState.clear();
      busy = false;
      scheduleBusyLabel = '';
      if (btn && container.contains(btn)) {
        btn.disabled = false;
        btn.textContent = '生成本周';
      }
      if (activeApp === 'schedule') await paint();
    }
  }

  async function onClearSchedule() {
    if (busy || !selectedId) return;
    if (!phone?.dailyLifePlans?.length) {
      showToast('没有可清空的日程');
      return;
    }
    if (!window.confirm('清空该角色全部日程？')) return;
    busy = true;
    const btn = container.querySelector('.cphone-clear-schedule');
    if (btn) { btn.disabled = true; btn.textContent = '清空中…'; }
    try {
      phone = await clearCharacterPhoneSchedules(user.id, selectedId);
      plan = null;
      showToast('日程已清空');
      await paint();
    } catch (e) {
      showToast(`失败：${e?.message || e}`);
    } finally {
      busy = false;
    }
  }

  function deleteSelectedRecords(sourcePhone, appId, idSet) {
    const next = { ...sourcePhone };
    const filt = (arr) => (Array.isArray(arr) ? arr.filter((r) => !idSet.has(String(r?.id || ''))) : arr);
    if (appId === 'browser') next.browserRecords = filt(next.browserRecords);
    else if (appId === 'map') {
      next.mapPins = filt(next.mapPins);
      next.mapItineraries = filt(next.mapItineraries);
    } else if (appId === 'photos') next.photoRecords = filt(next.photoRecords);
    else if (appId === 'calls') next.callRecords = filt(next.callRecords);
    else if (appId === 'music') next.musicRecords = filt(next.musicRecords);
    else if (appId === 'interests') next.interestRecords = filt(next.interestRecords);
    else if (appId === 'avatars') next.avatarLibrary = filt(next.avatarLibrary);
    else if (appId === 'memo') next.notes = filt(next.notes);
    return next;
  }

  function enterPhotoGenSelect() {
    photoGenSelectApp = 'photos';
    photoGenSelectedIds.clear();
    recordSelectApp = '';
    recordSelectedIds.clear();
  }

  function exitPhotoGenSelect() {
    photoGenSelectApp = '';
    photoGenSelectedIds.clear();
  }

  function updatePhotoGenRunButton() {
    const btn = container.querySelector('.cphone-photo-gen-run');
    if (!btn) return;
    btn.textContent = `补生图(${photoGenSelectedIds.size})`;
    btn.disabled = photoGenSelectedIds.size === 0;
  }

  async function onGeneratePhotoImages({ recordIds = null, forceReroll = false } = {}) {
    if (!selectedId) return;
    if (photoGenBusy) {
      showToast('上一张图片仍在生成，请稍候或先取消');
      return;
    }
    if (busy || phoneGeneration.active) {
      showToast('还有任务正在处理，请完成或取消后再试');
      return;
    }
    const character = selectedCharacter() || await getCharacter(selectedId, { userId: user.id }).catch(() => null);
    if (!character) return;
    const genEnabled = await isPhoneAlbumImageGenEnabled().catch(() => false);
    const imageOptions = await openPhoneAlbumGenImageModal({
      genEnabled,
      title: forceReroll ? '重 roll 选项' : '相册生图选项',
    });
    if (!imageOptions) return;
    if (!genEnabled) {
      showToast('请先在 API 管理开启聊天生图或朋友圈生图', 5000);
      return;
    }
    const controller = new AbortController();
    busy = true;
    photoGenBusy = true;
    photoGenRecordId = forceReroll ? String(recordIds?.[0] || '') : '';
    phoneGeneration = {
      active: true,
      scope: forceReroll ? '相册重 roll' : '相册补图',
      message: forceReroll ? '正在生成新的图片…' : '正在为选中的记录生成图片…',
      controller,
    };
    await paint({ soft: true });
    try {
      const result = await generatePhonePhotoImagesForPhone({
        userId: user.id,
        characterId: selectedId,
        character,
        user,
        recordIds,
        forceReroll,
        signal: controller.signal,
        imageStyleId: imageOptions.imageStyleId || '',
        allowPersonPhoto: imageOptions.allowPersonPhoto !== false,
        allowTextImage: false,
      });
      phone = result.phone;
      if (forceReroll && photoPreview?.recordId) {
        const next = (phone.photoRecords || []).find((row) => String(row.id || '') === String(photoPreview.recordId));
        if (next) {
          photoPreview = {
            recordId: next.id,
            url: imageUrlFromRecord(next),
            textImageCaption: next.textImageCaption || '',
            canReroll: photoRecordCanReroll(next),
          };
        }
      }
      exitPhotoGenSelect();
      if (result.failed > 0 && result.photoOk === 0) {
        showToast(`${forceReroll ? '重 roll' : '补图'}未成功，请检查生图 API 后重试`, 6000);
      } else if (result.failed > 0) {
        showToast(`完成 ${result.photoOk || 0} 张，${result.failed} 张失败可再点补生图`, 5000);
      } else {
        showToast(forceReroll ? '已重 roll' : `相册补图完成（${result.photoOk || result.count || 0} 张）`);
      }
    } catch (e) {
      if (e?.name !== 'AbortError') {
        showToast(`${forceReroll ? '重 roll' : '补图'}失败：${e?.message || e}`, 6000);
      }
    } finally {
      busy = false;
      photoGenBusy = false;
      photoGenRecordId = '';
      if (phoneGeneration.controller === controller) {
        phoneGeneration = { active: false, scope: '', message: '', controller: null };
      }
      await paint({ soft: true });
    }
  }

  function enterRecordSelect(appId) {
    recordSelectApp = String(appId || '').trim();
    recordSelectedIds.clear();
    exitPhotoGenSelect();
  }

  function exitRecordSelect() {
    recordSelectApp = '';
    recordSelectedIds.clear();
  }

  function updateRecordDeleteButton() {
    const btn = container.querySelector('.cphone-record-delete');
    if (!btn) return;
    btn.textContent = `删除(${recordSelectedIds.size})`;
    btn.disabled = recordSelectedIds.size === 0;
  }

  async function onDeleteSelectedRecords(appId) {
    if (busy || !selectedId || !phone) return;
    if (!recordSelectedIds.size) {
      showToast('请先勾选记录');
      return;
    }
    const idSet = new Set(recordSelectedIds);
    if (!window.confirm(`删除已选的 ${idSet.size} 条记录？`)) return;
    busy = true;
    try {
      phone = await saveCharacterPhone(deleteSelectedRecords(phone, appId, idSet));
      if (appId === 'map') mapPreviewUrl = '';
      exitRecordSelect();
      showToast('已删除');
      await paint({ soft: appId === 'photos' });
    } catch (e) {
      showToast(`删除失败：${e?.message || e}`);
    } finally {
      busy = false;
    }
  }

  async function onSaveAvatarImport() {
    if (busy || !selectedId) return;
    const desc = String(container.querySelector('.cphone-avatar-desc')?.value || '').trim();
    if (!pendingAvatarImport?.imageUrl) {
      showToast('先选择一张图片');
      return;
    }
    busy = true;
    try {
      const now = Date.now();
      const importId = `avatar_user_${now}_${Math.random().toString(36).slice(2, 8)}`;
      // 以当前内存中的库为准再 prepend，避免误覆盖；id 唯一，加载去重也不会互掐。
      const prevLibrary = Array.isArray(phone?.avatarLibrary) ? phone.avatarLibrary : [];
      phone = await saveCharacterPhone({
        ...phone,
        avatarLibrary: [{
          id: importId,
          title: '用户导入头像',
          description: desc,
          imageUrl: pendingAvatarImport.imageUrl,
          source: 'user',
          tags: desc ? ['用户导入'] : [],
          createdAt: now,
        }, ...prevLibrary].slice(0, 60),
      });
      pendingAvatarImport = null;
      showToast('已加入头像库');
      await paint({ soft: true });
    } catch (e) {
      showToast(`导入失败：${e?.message || e}`);
    } finally {
      busy = false;
    }
  }

  async function setCharacterAvatarFromLibrary(avatarId = '') {
    if (busy || !selectedId || !avatarId) return;
    const item = (phone?.avatarLibrary || []).find((row) => String(row.id || '') === String(avatarId));
    const imageUrl = imageUrlFromRecord(item || {});
    if (!item || !imageUrl) {
      showToast('这条头像没有图片');
      return;
    }
    const character = selectedCharacter() || await getCharacter(selectedId, { userId: user.id }).catch(() => null);
    if (!character) return;
    busy = true;
    try {
      const saved = await saveCharacterForUser(user.id, { ...character, avatar: imageUrl });
      const index = characters.findIndex((c) => c.id === saved.id);
      if (index >= 0) characters[index] = saved;
      const dIdx = displayCharacters.findIndex((c) => c.id === saved.id);
      if (dIdx >= 0) displayCharacters[dIdx] = saved;
      // 同步本机通讯录里指向该角色的头像快照，列表不再残留旧图
      await syncPhoneContactAvatarsAcrossOwners(user.id, saved.id, imageUrl).catch(() => 0);
      phoneContacts = await loadCharacterPhoneContacts(user.id, selectedId).catch(() => phoneContacts);
      phone = await saveCharacterPhone({
        ...phone,
        avatarLibrary: (phone.avatarLibrary || []).map((row) => (
          row.id === item.id ? { ...row, selectedAt: Date.now() } : row
        )),
      });
      showToast('头像已更换');
      await paint();
    } catch (e) {
      showToast(`更换失败：${e?.message || e}`);
    } finally {
      busy = false;
    }
  }

  async function letCharacterPickAvatar() {
    const choices = (phone?.avatarLibrary || []).filter((item) => imageUrlFromRecord(item));
    if (!choices.length) {
      showToast('头像库里还没有可用图片');
      return;
    }
    const index = Math.floor(Math.random() * choices.length);
    await setCharacterAvatarFromLibrary(choices[index].id);
  }

  async function onChangePlan() {
    if (busy) {
      showToast(scheduleBusyLabel ? `${scheduleBusyLabel.replace(/…$/, '')}，请稍等` : '正在处理中，请稍等');
      return;
    }
    if (!selectedId) return;
    const character = selectedCharacter() || await getCharacter(selectedId, { userId: user.id }).catch(() => null);
    if (!character) {
      showToast('角色不存在');
      return;
    }
    const picked = plan ? pickCurrentPlanBlock(plan, nowTs, scheduleTimeZone) : null;
    const target = isPlanBlockActiveAt(picked, nowTs, scheduleTimeZone) ? picked : null;
    if (!target) {
      showToast(plan?.blocks?.length
        ? '当前不在任一日程时段内，无法临时改行程'
        : '还没有今日日程，请先生成今日');
      return;
    }
    if (calendarSelectedDate && calendarSelectedDate !== dateKey) {
      showToast('临时改行程只改「今天」的当前时段，日历已切回今天', 4500);
      calendarSelectedDate = dateKey;
    }
    const noticeApp = activeApp;
    const notice = await beginLongTaskNotice({
      title: '行程核对完成',
      body: `${character.customNickname || character.name || 'TA'}的当前安排已核对`,
      tag: `phone-schedule-change-${selectedId}`,
      isStillViewing: () => container.isConnected && activeApp === noticeApp,
    });
    busy = true;
    scheduleBusyLabel = '正在校准行程…';
    await paint();
    const btn = container.querySelector('.cphone-change-plan');
    const timeoutState = createScheduleGenerationTimeout();
    if (btn) { btn.disabled = true; btn.textContent = '校准中…'; }
    showToast('正在根据当前事实核对行程…', 3500);
    try {
      const result = await withScheduleGenerationTimeout(() => changeDailyLifePlanByCharacter({
        userId: user.id,
        characterId: selectedId,
        character,
        user,
        blockId: target.id,
        timestamp: nowTs,
        signal: timeoutState.signal,
      }), timeoutState);
      phone = result.phone;
      plan = result.plan;
      void notice.complete();
      showToast(result.changed
        ? '当前事实与原计划冲突，日程已调整'
        : '没有足够的新事实，保留原计划', 5000);
      await paint();
    } catch (e) {
      notice.cancel();
      showToast(scheduleGenerationErrorMessage(e, '改行程失败'), 7000);
      offerScheduleJsonRecovery(e, {
        mode: 'change',
        onApplied: async (text) => {
          const liveCharacter = selectedCharacter()
            || await getCharacter(selectedId, { userId: user.id }).catch(() => null);
          if (!liveCharacter) throw new Error('角色不存在');
          const result = await tryApplyChangeScheduleFromRaw({
            userId: user.id,
            characterId: selectedId,
            character: liveCharacter,
            user,
            blockId: target.id,
            timestamp: nowTs,
            raw: text,
          });
          phone = result.phone;
          plan = result.plan;
          await paint();
          return result;
        },
      });
    } finally {
      timeoutState.clear();
      busy = false;
      scheduleBusyLabel = '';
      if (btn && container.contains(btn)) {
        btn.disabled = false;
        btn.textContent = '按当前事实校准';
      }
      if (activeApp === 'schedule') await paint();
    }
  }

  function resolveGenerateScope() {
    if (activeApp === 'home') return 'full';
    return PHONE_RECORD_SCOPES[activeApp] ? activeApp : null;
  }

  async function onRefreshMap() {
    if (busy || !selectedId || !phone) return;
    const character = selectedCharacter()
      || await getCharacter(selectedId, { userId: user.id }).catch(() => null);
    if (!character) return;
    busy = true;
    const timeoutState = createScheduleGenerationTimeout();
    phoneGeneration = {
      active: true,
      scope: '刷新地图',
      message: '正在检查地图服务…',
      controller: timeoutState,
    };
    await paint();
    try {
      nowTs = await getNowForUser(user.id).catch(() => Date.now());
      const cfg = await loadAmapConfig().catch(() => null);
      const hasMapApi = !!(cfg?.enabled && cfg?.apiKey);
      if (!hasMapApi) {
        let textModelGenerated = false;
        let textModelError = null;
        phoneGeneration.message = '正在用文字模型生成模拟地点与路线…';
        await paint();
        try {
          const result = await withScheduleGenerationTimeout(() => generateCharacterPhoneRecords({
            userId: user.id,
            characterId: selectedId,
            character,
            user,
            countMode: 'standard',
            scope: 'map',
            signal: timeoutState.signal,
            onProgress: (message) => {
              if (!updateGenerationHudMessage(message)) void paint({ soft: true });
            },
          }), timeoutState);
          phone = result.phone;
          textModelGenerated = true;
        } catch (error) {
          textModelError = error;
        }
        const virtualState = virtualMapStateFromContext({
          phone,
          plan,
          character,
          timestamp: nowTs,
          timeZone: scheduleTimeZone,
        });
        const virtualRoute = routeStateFromCurrentScheduleBlock(plan, nowTs, scheduleTimeZone);
        phone = await saveCharacterPhone({
          ...phone,
          currentMapState: {
            ...virtualState,
            source: textModelGenerated ? 'textModelMapFallback' : 'virtualScheduleMap',
            updatedAt: nowTs,
          },
          ...(virtualRoute ? { routeState: virtualRoute } : {}),
        });
        mapPreviewUrl = '';
        destroyLiveMap();
        if (textModelError) {
          showToast(`文字模拟未完成，已按日程刷新位置：${textModelError?.message || textModelError}`, 7000);
        } else {
          showToast('模拟地图已重新生成');
        }
      } else {
        phoneGeneration.message = '正在通过高德准备真实地点候选…';
        await paint();
        const before = mapRefreshFingerprint(phone);
        const mapBlock = plan ? pickCurrentPlanBlock(plan, nowTs, scheduleTimeZone) : null;
        const grown = await withScheduleGenerationTimeout(() => maybeGrowCharacterPhoneMapForDailyPlan({
          userId: user.id,
          characterId: selectedId,
          character,
          phone,
          contextText: [plan?.dayTheme, mapBlock?.activity, mapBlock?.placeName].filter(Boolean).join(' '),
          reason: 'manual-map-refresh',
          respectAutoToggle: false,
          bypassCooldown: true,
          bypassDailyLimit: true,
          writeCurrentState: false,
          timestamp: nowTs,
        }), timeoutState);
        if (grown) phone = grown;
        const changed = mapRefreshFingerprint(phone) !== before;
        mapPreviewUrl = await buildMapPreviewUrl(phone).catch(() => '');
        showToast(changed
          ? '真实地点候选已更新，角色会在日程中自主选择'
          : '地图 API 已连接，本次没有找到新的地点');
      }
    } catch (error) {
      showToast(`地图刷新失败：${error?.message || error}`, 7000);
      if (error?.name !== 'AbortError') {
        void showPhoneGenerationError(error, {
          scope: '角色手机 / 地图刷新',
          title: '地图刷新失败',
        });
      }
    } finally {
      timeoutState.clear();
      phoneGeneration = { active: false, scope: '', message: '', controller: null };
      busy = false;
      await paint();
    }
  }

  async function onGenerateRecords() {
    if (busy || !selectedId) return;
    const scope = resolveGenerateScope();
    if (!scope) return;
    const scopeLabel = getPhoneRecordScopeLabel(scope);
    const character = selectedCharacter() || await getCharacter(selectedId, { userId: user.id }).catch(() => null);
    if (!character) return;
    const noticeApp = activeApp;
    const notice = await beginLongTaskNotice({
      title: scope === 'full' ? '手机记录已生成' : `${scopeLabel}已生成`,
      body: `${character.customNickname || character.name || 'TA'}的手机内容已经准备好`,
      tag: `phone-records-${selectedId}-${scope}`,
      isStillViewing: () => container.isConnected && activeApp === noticeApp,
    });
    busy = true;
    const btn = container.querySelector('.cphone-gen-records');
    const resetText = btn ? btn.textContent : '补记录';
    const timeoutState = createScheduleGenerationTimeout();
    phoneGeneration = {
      active: true,
      scope: scope === 'full' ? '补全手机记录' : `补全${scopeLabel}`,
      message: '正在整理人设、聊天和生活线索…',
      controller: timeoutState,
    };
    if (btn) { btn.disabled = true; btn.textContent = '生成中…'; }
    await paint();
    try {
      phoneGeneration.message = '正在请求模型并校验记录…';
      await paint();
      const result = await withScheduleGenerationTimeout(() => generateCharacterPhoneRecords({
        userId: user.id,
        characterId: selectedId,
        character,
        user,
        countMode: 'standard',
        scope,
        signal: timeoutState.signal,
        onProgress: (message) => {
          if (!updateGenerationHudMessage(message)) void paint({ soft: true });
        },
      }), timeoutState);
      phone = result.phone;
      phoneGeneration.message = '正在写入手机记录…';
      void notice.complete();
      if (result.mapGrown) {
        showToast(scope === 'full' ? '手机记录已生成，地图也补了一轮' : `${scopeLabel}已生成，地图也补了一轮`);
      } else if (result.mapGrowError && scopeNeedsMapGrowToast(scope)) {
        showToast(`${scopeLabel}已生成，地图补全失败：${result.mapGrowError}`);
      } else {
        showToast(scope === 'full' ? '手机记录已生成' : `${scopeLabel}已生成`);
      }
    } catch (e) {
      notice.cancel();
      showToast(scheduleGenerationErrorMessage(e, scope === 'full' ? '生成手机记录失败' : `生成${scopeLabel}失败`), 7000);
      if (e?.name !== 'AbortError') {
        void showPhoneGenerationError(e, {
          scope: `角色手机 / ${scopeLabel}`,
          title: scope === 'full' ? '手机记录生成失败' : `${scopeLabel}生成失败`,
        });
      }
    } finally {
      timeoutState.clear();
      phoneGeneration = { active: false, scope: '', message: '', controller: null };
      busy = false;
      if (btn && container.contains(btn)) {
        btn.disabled = false;
        btn.textContent = resetText;
      }
      await paint();
    }
  }

  function scopeNeedsMapGrowToast(scope) {
    return scope === 'full' || scope === 'map';
  }

  async function onStartActivity() {
    if (busy || !selectedId) return;

    const resumable = findResumableActivitySession(activitySessions, selectedId, nowTs);
    if (resumable?.activityGroupChatId) {
      navigate('offline', { chatId: resumable.activityGroupChatId });
      return;
    }

    const picked = plan ? pickCurrentPlanBlock(plan, nowTs, scheduleTimeZone) : null;
    const target = isPlanBlockActiveAt(picked, nowTs, scheduleTimeZone) ? picked : null;
    if (!target || !blockIsActiveNow(target, nowTs, scheduleTimeZone)) {
      showToast('还没到这个时段，或请先生成今日日程');
      return;
    }
    // 保险检查：探索卡可能因超时被判定过期而不在 resumable 里，但底下的线下会话其实还没收纳，
    // 这种情况也应该回去继续，而不是新建一份覆盖掉之前的进度。
    const activeCharacter = selectedCharacter()
      || await getCharacter(selectedId, { userId: user.id }).catch(() => null);
    const existingChat = await ensurePrivateChat(user.id, selectedId, activeCharacter?.customNickname || activeCharacter?.name || '').catch(() => null);
    const existingSession = existingChat ? await loadOfflineSession(existingChat.id).catch(() => null) : null;
    if (existingSession) {
      navigate('offline', { chatId: existingChat.id });
      return;
    }
    busy = true;
    const buttons = container.querySelectorAll('.cphone-start-activity');
    buttons.forEach((btn) => {
      btn.disabled = true;
      btn.textContent = '准备中…';
    });
    try {
      const { session, chat } = await createActivitySessionFromCurrentBlock({
        user,
        userId: user.id,
        characterId: selectedId,
      });
      await startOfflineSessionFromActivitySession({ chatId: chat.id, userId: user.id, activitySession: session });
      navigate('offline', { chatId: chat.id, justStarted: '1' });
    } catch (e) {
      showToast(`失败：${e?.message || e}`);
      buttons.forEach((btn) => {
        btn.disabled = false;
        btn.textContent = btn.classList.contains('cphone-start-activity-hero') ? '去找TA · 进入线下 ›' : '去找TA';
      });
    } finally {
      busy = false;
    }
  }


  await paint();

  // 日程是“当前世界时间”的确定性投影，不应依赖真人感或主动消息触发。
  // 停留在角色手机时每分钟重算一次；从后台回来立即校时，避免一直显示进页时的旧步骤。
  const PHONE_TIME_PROJECTION_REFRESH_MS = 60 * 1000;
  let phoneTimeProjectionRefreshing = false;
  let phoneTimeProjectionTimer = 0;
  const stopPhoneTimeProjection = () => {
    if (phoneTimeProjectionTimer) window.clearInterval(phoneTimeProjectionTimer);
    phoneTimeProjectionTimer = 0;
    document.removeEventListener('visibilitychange', onPhoneTimeVisibilityChange);
  };
  const refreshPhoneTimeProjection = async () => {
    if (!container.isConnected) {
      stopPhoneTimeProjection();
      return;
    }
    if (document.hidden || container.hidden || phoneTimeProjectionRefreshing || busy || phoneGeneration.active) return;
    if (activeApp !== 'home' && activeApp !== 'schedule') return;
    phoneTimeProjectionRefreshing = true;
    try {
      await paint({ soft: true, showLoading: false });
    } finally {
      phoneTimeProjectionRefreshing = false;
    }
  };
  function onPhoneTimeVisibilityChange() {
    if (!document.hidden) void refreshPhoneTimeProjection();
  }
  document.addEventListener('visibilitychange', onPhoneTimeVisibilityChange);
  phoneTimeProjectionTimer = window.setInterval(() => {
    void refreshPhoneTimeProjection();
  }, PHONE_TIME_PROJECTION_REFRESH_MS);
}
