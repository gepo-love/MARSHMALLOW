/**
 * 角色手机 · 持久化（settings 键值，按 user + character 隔离）
 *
 * 备忘录 / 手机记录 / 分享草稿等只接受结构化字段写入，
 * 不在此层用正则从自由文本里「抠」内容。
 */

import { get as dbGet, put as dbPut, updateRecord as dbUpdateRecord } from './db.js';
import { getAllRecords } from './db.js';

function timezoneParts(timestamp = Date.now(), timeZone = '') {
  const zone = String(timeZone || '').trim();
  if (!zone) return null;
  const date = new Date(Number(timestamp) || Date.now());
  if (Number.isNaN(date.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date);
    const map = {};
    for (const { type, value } of parts) {
      if (type !== 'literal') map[type] = value;
    }
    const hour = Number(map.hour);
    return {
      year: Number(map.year),
      month: Number(map.month),
      day: Number(map.day),
      hour: hour === 24 ? 0 : hour,
      minute: Number(map.minute),
    };
  } catch (_) {
    return null;
  }
}

function dateKeyInTimezone(timestamp = Date.now(), timeZone = '') {
  const parts = timezoneParts(timestamp, timeZone);
  if (!parts || !parts.year || !parts.month || !parts.day) return '';
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function minutesOfDayInTimezone(timestamp = Date.now(), timeZone = '') {
  const parts = timezoneParts(timestamp, timeZone);
  if (!parts || !Number.isFinite(parts.hour) || !Number.isFinite(parts.minute)) return -1;
  return Math.max(0, Math.min(1439, parts.hour * 60 + parts.minute));
}

async function resolveCharacterScheduleTimezone(...args) {
  const module = await import('./chat/chat-timezone.js');
  return module.resolveCharacterScheduleTimezone(...args);
}

export const PHONE_SCHEMA_VERSION = 2;
export const CHARACTER_PHONE_UPDATED_EVENT = 'marshmallow-character-phone-updated';

function notifyCharacterPhoneUpdated(phone = null) {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function' || !window.CustomEvent) return;
  window.dispatchEvent(new window.CustomEvent(CHARACTER_PHONE_UPDATED_EVENT, {
    detail: {
      userId: String(phone?.userId || '').trim(),
      characterId: String(phone?.characterId || '').trim(),
      updatedAt: Number(phone?.updatedAt || Date.now()) || Date.now(),
    },
  }));
}
const AUTO_SETTINGS_KEY_PREFIX = 'characterPhoneAutoSettings:';
// 备忘录是「角色随手写的当日待办」这种时效性内容，不是永久记录：没勾完也别无限期挂在列表里，
// 不然攒了几天全是没做完的旧条目，看着重复、也没有真的"过期"这回事。到期后即便没做完也自动清掉。
const NOTE_EXPIRE_MS = 5 * 86400000;
// 日程生成需要近几天历史做活动查重；只清理更早的数据，不能每天把昨天的证据一起删掉。
const SCHEDULE_HISTORY_RETENTION_DAYS = 7;
export const SCHEDULE_PROACTIVE_MIN_GAP_OPTIONS = [0, 5, 10, 15, 30, 45, 60, 90, 120];

/**
 * 角色手机聊天使用用户的世界时间写 lastActivity；已读时间不能只用设备实时时钟，
 * 否则世界时间领先时会一直满足 lastActivity > seenAt，桌面红点永远清不掉。
 */
export function resolvePhoneAppSeenAt(latestActivity = 0, readAt = Date.now()) {
  const latest = Math.max(0, Number(latestActivity) || 0);
  const now = Math.max(0, Number(readAt) || 0);
  return Math.max(latest, now);
}

function phoneKey(userId, characterId) {
  const uid = encodeURIComponent(String(userId || '').trim() || 'guest');
  const cid = encodeURIComponent(String(characterId || '').trim() || 'unknown');
  return `characterPhone_${uid}_${cid}`;
}

function phoneAppearancePresetsKey(userId) {
  const uid = encodeURIComponent(String(userId || '').trim() || 'guest');
  return `characterPhoneAppearancePresets_${uid}`;
}

function genId(prefix = 'cp') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function asArray(v) {
  return Array.isArray(v) ? v : [];
}

function normalizePlanRevision(value = 0) {
  return Math.max(0, Math.floor(Number(value || 0) || 0));
}

function normalizeMutationUpdatedAt(value = 0) {
  const timestamp = Number(value || 0);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : 0;
}

const SCHEDULE_MUTATION_META_KEYS = new Set(['updatedAt', 'planRevision']);

function scheduleContentProjection(value) {
  if (Array.isArray(value)) return value.map(scheduleContentProjection);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value)
    .filter((key) => !SCHEDULE_MUTATION_META_KEYS.has(key))
    .sort()
    .map((key) => [key, scheduleContentProjection(value[key])]));
}

function scheduleContentMatches(left, right) {
  if (!left || !right) return false;
  return JSON.stringify(scheduleContentProjection(left)) === JSON.stringify(scheduleContentProjection(right));
}

function scheduleEntityWithMutation(entity, previous, planRevision, wallUpdatedAt) {
  const previousUpdatedAt = normalizeMutationUpdatedAt(previous?.updatedAt);
  if (previousUpdatedAt && scheduleContentMatches(entity, previous)) {
    return {
      ...entity,
      updatedAt: previousUpdatedAt,
      planRevision: normalizePlanRevision(previous?.planRevision),
    };
  }
  return {
    ...entity,
    updatedAt: wallUpdatedAt,
    planRevision,
  };
}

function previousScheduleEntityById(items, id, index) {
  const list = asArray(items);
  const exact = list.find((item) => String(item?.id || '').trim() === String(id || '').trim());
  return exact || list[index] || null;
}

function normalizePhoneAppReadState(raw = {}) {
  if (!raw || typeof raw !== 'object') return {};
  return Object.fromEntries(Object.entries(raw).map(([key, value]) => {
    const row = value && typeof value === 'object' ? value : {};
    return [String(key), {
      count: Math.max(0, Math.floor(Number(row.count || 0) || 0)),
      seenAt: Number(row.seenAt || 0) || 0,
    }];
  }).filter(([key]) => key));
}

function createPhoneAppReadSnapshot(phone = {}) {
  const now = Date.now();
  const countOf = (count) => ({ count: Math.max(0, Math.floor(Number(count || 0) || 0)), seenAt: now });
  return {
    browser: countOf(asArray(phone.browserRecords).length),
    map: countOf(asArray(phone.mapPins).length + asArray(phone.mapItineraries).length),
    photos: countOf(asArray(phone.photoRecords).length),
    calls: countOf(asArray(phone.callRecords).length),
    music: countOf(asArray(phone.musicRecords).length),
    interests: countOf(asArray(phone.interestRecords).length),
    avatars: countOf(asArray(phone.avatarLibrary).length),
    memo: countOf(asArray(phone.notes).filter((n) => !n?.completed).length),
  };
}

function clip(text, max = 240) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

const DEFAULT_PHONE_WIDGETS = ['calendar', 'music', 'photos', 'status'];
const DEFAULT_PHONE_DOCK = ['chat', 'calls', 'browser', 'settings'];
const PHONE_WIDGET_IDS = ['calendar', 'music', 'photos', 'status'];
const PHONE_DOCK_APP_IDS = ['chat', 'browser', 'map', 'photos', 'calls', 'music', 'interests', 'avatars', 'memo', 'settings'];
const PHONE_ICON_APP_IDS = ['schedule', ...PHONE_DOCK_APP_IDS];
const PHONE_WALLPAPER_PRESETS = ['default', 'mist', 'sea', 'window'];

function normalizePhoneImageUrl(value = '') {
  let url = String(value || '').trim();
  if (!url) return '';
  if (url.startsWith('//')) url = `https:${url}`;
  else if (/^http:\/\//i.test(url)) url = `https://${url.slice(7)}`;
  return (/^data:image\/|^https:\/\//i.test(url) && url.length <= 900000) ? url : '';
}

function normalizePhoneAppIcons(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return Object.fromEntries(PHONE_ICON_APP_IDS.map((id) => [id, normalizePhoneImageUrl(source[id])])
    .filter(([, url]) => !!url));
}

function normalizePhoneAppearancePresets(raw = []) {
  const seen = new Set();
  return (Array.isArray(raw) ? raw : []).map((item) => {
    const name = clip(item?.name || '', 32);
    if (!name || seen.has(name)) return null;
    seen.add(name);
    const shell = normalizePhoneShellPreferences({ ...(item?.shell || {}), appearancePresets: [] });
    return {
      id: clip(item?.id || `appearance_${Date.now().toString(36)}_${seen.size}`, 80),
      name,
      shell,
      createdAt: Number(item?.createdAt) || Date.now(),
      updatedAt: Number(item?.updatedAt) || Date.now(),
    };
  }).filter(Boolean);
}

export function normalizePhoneShellPreferences(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const wallpaper = String(source.wallpaper || '').trim();
  // v1 把桌面小组件记成 clock / schedule；迁移时保留用户的选择，而不是静默清空。
  const widgetAliases = { clock: 'status', schedule: 'calendar' };
  const normalizeIds = (value, allowed, defaults, aliases = {}) => {
    if (!Array.isArray(value)) return [...defaults];
    return [...new Set(value.map((id) => aliases[String(id)] || String(id)).filter((id) => allowed.includes(id)))];
  };
  return {
    wallpaper: normalizePhoneImageUrl(wallpaper),
    wallpaperAssetId: clip(source.wallpaperAssetId || '', 160),
    wallpaperPreset: PHONE_WALLPAPER_PRESETS.includes(source.wallpaperPreset) ? source.wallpaperPreset : 'default',
    wallpaperOverlay: Math.max(0, Math.min(0.82, Number(source.wallpaperOverlay ?? 0.28) || 0)),
    iconTone: ['graphite', 'mist', 'sea'].includes(source.iconTone) ? source.iconTone : 'graphite',
    widgets: normalizeIds(source.widgets, PHONE_WIDGET_IDS, DEFAULT_PHONE_WIDGETS, widgetAliases),
    dock: normalizeIds(source.dock, PHONE_DOCK_APP_IDS, DEFAULT_PHONE_DOCK),
    appIcons: normalizePhoneAppIcons(source.appIcons),
    photosCover: normalizePhoneImageUrl(String(source.photosCover || '').trim()),
    appearancePresets: normalizePhoneAppearancePresets(source.appearancePresets),
  };
}

function normalizeFlowStep(item = {}, index = 0) {
  if (!item || typeof item !== 'object') return null;
  const action = clip(item.action || item.activity || item.text || '', 120);
  const placeName = clip(item.placeName || item.place || item.anchor || '', 80);
  const transit = clip(item.transit || item.move || item.route || '', 60);
  const shareCandidate = clip(item.shareCandidate || item.shareText || '', 120);
  if (!action && !placeName && !transit && !shareCandidate) return null;
  const interestProgressRaw = item.interestProgress && typeof item.interestProgress === 'object'
    ? item.interestProgress
    : null;
  const interestProgress = interestProgressRaw
    ? {
      entryId: clip(interestProgressRaw.entryId || '', 80),
      stage: clip(interestProgressRaw.stage || '', 40),
      completedGoal: clip(interestProgressRaw.completedGoal || '', 60),
      newGoal: clip(interestProgressRaw.newGoal || '', 60),
      humanMoment: clip(interestProgressRaw.humanMoment || '', 80),
    }
    : null;
  const usableInterestProgress = interestProgress?.entryId
    && (
      interestProgress.stage
      || interestProgress.completedGoal
      || interestProgress.newGoal
      || interestProgress.humanMoment
    )
    ? interestProgress
    : null;
  return {
    id: String(item.id || `step_${index}`).trim(),
    at: clip(item.at || item.time || item.timeLabel || '', 24),
    offsetMinutes: item.offsetMinutes !== null
      && item.offsetMinutes !== undefined
      && item.offsetMinutes !== ''
      && Number.isFinite(Number(item.offsetMinutes))
      ? Math.max(0, Math.min(600, Math.floor(Number(item.offsetMinutes))))
      : null,
    action,
    placeName,
    transit,
    mood: clip(item.mood || '', 40),
    shareCandidate,
    checkpoint: item.checkpoint === true,
    busy: item.busy === true,
    interestProgress: usableInterestProgress,
    updatedAt: normalizeMutationUpdatedAt(item.updatedAt),
    planRevision: normalizePlanRevision(item.planRevision),
  };
}

function normalizeTriggerWindow(item = {}, index = 0) {
  if (!item || typeof item !== 'object') return null;
  const reason = clip(item.reason || item.title || item.text || '', 100);
  const at = clip(item.at || item.time || '', 24);
  const sourceStepId = clip(item.sourceStepId || item.stepId || '', 40);
  if (!reason && !at && !sourceStepId) return null;
  return {
    id: String(item.id || `trigger_${index}`).trim(),
    at,
    offsetMinutes: item.offsetMinutes !== null
      && item.offsetMinutes !== undefined
      && item.offsetMinutes !== ''
      && Number.isFinite(Number(item.offsetMinutes))
      ? Math.max(0, Math.min(600, Math.floor(Number(item.offsetMinutes))))
      : null,
    sourceStepId,
    reason,
    shareHint: clip(item.shareHint || item.shareCandidate || '', 120),
    used: item.used === true,
    usedAt: Number(item.usedAt || 0) || 0,
    updatedAt: normalizeMutationUpdatedAt(item.updatedAt),
    planRevision: normalizePlanRevision(item.planRevision),
  };
}

function normalizePlanLocation(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const city = clip(src.city || src.cityName || '', 40);
  const placeName = clip(src.placeName || src.place || src.label || '', 80);
  const area = clip(src.area || src.region || '', 80);
  const sourceBlockId = clip(src.sourceBlockId || src.blockId || '', 60);
  if (!city && !placeName && !area && !sourceBlockId) return null;
  return {
    city,
    placeName,
    area,
    sourceBlockId,
  };
}

function locationFromBlock(block = {}) {
  if (!block || typeof block !== 'object') return null;
  const route = block.routeHint && typeof block.routeHint === 'object' ? block.routeHint : {};
  return normalizePlanLocation({
    city: block.city || '',
    placeName: route.destination || block.placeName || block.anchor || '',
    area: block.anchor || '',
    sourceBlockId: block.id || '',
  });
}

/** 结构化备忘录（仅来自 AI JSON 或用户表单，不做文本正则解析） */
export function normalizePhoneNote(item, index = 0, now = Date.now()) {
  if (!item || typeof item !== 'object') return null;
  const text = clip(item.text || item.note || item.body || '', 280);
  if (!text) return null;
  const ts = Number(item.updatedAt || item.createdAt) || now;
  const translation = clip(item.translation || item.zh || '', 280);
  return {
    id: String(item.id || item.noteId || `note_${ts}_${index}`).trim(),
    title: clip(item.title || '', 80),
    text,
    ...(translation && translation !== text ? { translation } : {}),
    tags: asArray(item.tags).map((t) => String(t || '').trim()).filter(Boolean).slice(0, 8),
    completed: item.completed === true,
    source: String(item.source || 'structured').trim(),
    sourceDateKey: String(item.sourceDateKey || '').trim(),
    createdAt: Number(item.createdAt) || ts,
    updatedAt: ts,
  };
}

function isHttpUrl(value = '') {
  return /^https?:\/\//i.test(String(value || '').trim());
}

// 图片 URL 不能走 clip：clip 会折叠空白、加省略号并截到固定字数，会把 base64 data URL 直接截坏。
// 这里整段保留 data:image / http(s) 图片地址，只在超出极限长度时丢弃（截断的 data URL 本就无法显示）。
const MAX_IMAGE_FIELD_CHARS = 12 * 1024 * 1024;
function clipImageUrl(value = '') {
  let s = String(value ?? '').trim();
  if (!s) return '';
  if (s.startsWith('//')) s = `https:${s}`;
  else if (/^http:\/\//i.test(s)) s = `https://${s.slice(7)}`;
  if (!/^(data:image\/|https:\/\/)/i.test(s)) return '';
  return s.length <= MAX_IMAGE_FIELD_CHARS ? s : '';
}

function normalizePhoneLink(raw = {}, index = 0, now = Date.now()) {
  if (!raw || typeof raw !== 'object') return null;
  const title = clip(raw.title || raw.name || '', 100);
  const query = clip(raw.query || raw.keyword || '', 80);
  const url = clip(raw.url || raw.href || '', 500);
  if (!title && !query && !url) return null;
  const linkType = ['real', 'fictional', 'platform_search', 'weibo_hot', 'forum_post'].includes(raw.linkType)
    ? raw.linkType
    : (isHttpUrl(url) ? 'real' : 'fictional');
  const summary = clip(raw.summary || raw.desc || raw.description || '', 220);
  const body = clip(raw.body || raw.content || '', 1200);
  const aiJudgement = clip(raw.aiJudgement || raw.judgement || raw.verdict || raw.takeaway || '', 220);
  const translation = clip(raw.translation || raw.zh || raw.bodyTranslation || '', 1200);
  const summaryTranslation = clip(raw.summaryTranslation || raw.summaryZh || '', 220);
  const aiJudgementTranslation = clip(raw.aiJudgementTranslation || raw.aiJudgementZh || '', 220);
  const bodyTranslation = translation && translation !== body ? translation : '';
  const resolvedSummaryZh = summaryTranslation && summaryTranslation !== summary
    ? summaryTranslation
    : (!bodyTranslation && translation && summary && translation !== summary ? translation : '');
  const resolvedJudgementZh = aiJudgementTranslation && aiJudgementTranslation !== aiJudgement
    ? aiJudgementTranslation
    : (!bodyTranslation && !resolvedSummaryZh && translation && aiJudgement && translation !== aiJudgement ? translation : '');
  return {
    id: String(raw.id || genId('browse')).trim(),
    title: title || query || '网页记录',
    sourceName: clip(raw.sourceName || raw.source || raw.platform || '', 40),
    // producer provenance 与页面展示来源分开保存；主聊天只消费明确可信的浏览来源。
    source: clip(raw.source || '', 40),
    linkType,
    url: isHttpUrl(url) ? url : '',
    query,
    summary,
    body,
    aiJudgement,
    ...(bodyTranslation ? { translation: bodyTranslation } : {}),
    ...(resolvedSummaryZh ? { summaryTranslation: resolvedSummaryZh } : {}),
    ...(resolvedJudgementZh ? { aiJudgementTranslation: resolvedJudgementZh } : {}),
    // 精搜挑出来、还没在聊天里发出去的链接：'pending' 待分享 → 'shared' 已分享；
    // 其它来源（日常生活生成器等）的记录不涉及这套状态，留空。
    shareStatus: ['pending', 'shared'].includes(raw.shareStatus) ? raw.shareStatus : '',
    tags: asArray(raw.tags).map((t) => clip(t, 24)).filter(Boolean).slice(0, 8),
    // 微博热搜/话题：记录这条内容到底是谁发的（不一定是角色本人）
    weiboAuthorName: clip(raw.weiboAuthorName || '', 40),
    weiboAuthorType: clip(raw.weiboAuthorType || '', 24),
    // 站内论坛帖：归属与板块
    forumSection: clip(raw.forumSection || '', 40),
    forumAuthorName: clip(raw.forumAuthorName || '', 40),
    forumAuthorType: clip(raw.forumAuthorType || '', 24),
    visitedAt: Number(raw.visitedAt || raw.createdAt) || now,
    createdAt: Number(raw.createdAt) || now,
    favorite: raw.favorite === true,
  };
}

function normalizePhonePhoto(raw = {}, index = 0, now = Date.now()) {
  if (!raw || typeof raw !== 'object') return null;
  const title = clip(raw.title || raw.caption || '', 80);
  const caption = clip(raw.caption || raw.summary || raw.description || '', 240);
  const imageUrl = clipImageUrl(raw.imageUrl || raw.url || '');
  const textImageCaption = clip(raw.textImageCaption || raw.textImage || raw.text_image || '', 480);
  if (!title && !caption && !imageUrl && !textImageCaption) return null;
  const imageKind = ['photo', 'textimg'].includes(raw.imageKind)
    ? raw.imageKind
    : (imageUrl ? 'photo' : (textImageCaption ? 'textimg' : ''));
  const translation = clip(raw.translation || raw.zh || raw.captionTranslation || '', 240);
  return {
    id: String(raw.id || genId('photo')).trim(),
    title: title || '相册记录',
    caption,
    imageUrl,
    imagePrompt: clip(raw.imagePrompt || raw.prompt || '', 360),
    textImageCaption,
    imageKind,
    wantsImage: raw.wantsImage === true,
    location: clip(raw.location || raw.placeName || '', 80),
    tags: asArray(raw.tags).map((t) => clip(t, 24)).filter(Boolean).slice(0, 8),
    takenAt: Number(raw.takenAt || raw.createdAt) || now,
    createdAt: Number(raw.createdAt) || now,
    imageGeneratedAt: Number(raw.imageGeneratedAt || 0) || 0,
    rerollCount: Math.max(0, Math.floor(Number(raw.rerollCount || 0) || 0)),
    ...(translation && translation !== caption ? { translation } : {}),
  };
}

function normalizePhoneCall(raw = {}, index = 0, now = Date.now()) {
  if (!raw || typeof raw !== 'object') return null;
  const title = clip(raw.title || raw.contactName || raw.name || '', 80);
  const summary = clip(raw.summary || raw.note || raw.content || '', 260);
  if (!title && !summary) return null;
  const translation = clip(raw.translation || raw.zh || '', 260);
  return {
    id: String(raw.id || genId('call')).trim(),
    title: title || '通话记录',
    contactName: clip(raw.contactName || title || '', 80),
    direction: ['incoming', 'outgoing', 'missed'].includes(raw.direction) ? raw.direction : 'outgoing',
    durationText: clip(raw.durationText || raw.duration || '', 24),
    summary,
    ...(translation && translation !== summary ? { translation } : {}),
    occurredAt: Number(raw.occurredAt || raw.createdAt) || now,
    createdAt: Number(raw.createdAt) || now,
  };
}

function normalizePhoneMusic(raw = {}, index = 0, now = Date.now()) {
  if (!raw || typeof raw !== 'object') return null;
  const title = clip(raw.title || raw.trackTitle || raw.name || '', 100);
  if (!title) return null;
  const url = clip(raw.url || raw.href || '', 500);
  return {
    id: String(raw.id || genId('music')).trim(),
    title,
    artist: clip(raw.artist || raw.singer || '', 80),
    album: clip(raw.album || '', 80),
    platform: clip(raw.platform || raw.sourceName || '', 40),
    url: isHttpUrl(url) ? url : '',
    mood: clip(raw.mood || '', 80),
    note: clip(raw.note || raw.summary || '', 220),
    playedAt: Number(raw.playedAt || raw.createdAt) || now,
    createdAt: Number(raw.createdAt) || now,
  };
}

function normalizePhoneInterest(raw = {}, index = 0, now = Date.now()) {
  if (!raw || typeof raw !== 'object') return null;
  const title = clip(raw.title || raw.name || '', 80);
  const detail = clip(raw.detail || raw.summary || raw.reason || '', 260);
  if (!title && !detail) return null;
  const aiJudgement = clip(raw.aiJudgement || raw.judgement || raw.verdict || raw.takeaway || '', 180);
  const translation = clip(raw.translation || raw.zh || raw.detailTranslation || '', 260);
  const aiJudgementTranslation = clip(raw.aiJudgementTranslation || raw.aiJudgementZh || '', 180);
  return {
    id: String(raw.id || genId('interest')).trim(),
    category: clip(raw.category || raw.type || '日常', 40),
    title: title || '兴趣信号',
    detail,
    strength: clip(raw.strength || raw.signal || '', 24),
    aiJudgement,
    ...(translation && translation !== detail ? { translation } : {}),
    ...(aiJudgementTranslation && aiJudgementTranslation !== aiJudgement
      ? { aiJudgementTranslation }
      : {}),
    tags: asArray(raw.tags).map((t) => clip(t, 24)).filter(Boolean).slice(0, 8),
    updatedAt: Number(raw.updatedAt || raw.createdAt) || now,
    createdAt: Number(raw.createdAt) || now,
  };
}

function normalizeAvatarItem(raw = {}, index = 0, now = Date.now()) {
  if (!raw || typeof raw !== 'object') return null;
  const title = clip(raw.title || raw.name || raw.style || '', 80);
  if (!title && !raw.imageUrl && !raw.imagePrompt) return null;
  return {
    id: String(raw.id || genId('avatar')).trim(),
    title: title || '头像备选',
    description: clip(raw.description || raw.summary || '', 220),
    imageUrl: clipImageUrl(raw.imageUrl || raw.url || ''),
    imagePrompt: clip(raw.imagePrompt || raw.prompt || '', 360),
    source: clip(raw.source || '', 40),
    tags: asArray(raw.tags).map((t) => clip(t, 24)).filter(Boolean).slice(0, 8),
    createdAt: Number(raw.createdAt) || now,
  };
}

function normalizePreferences(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const uniq = (list = [], limit = 24) => {
    const seen = new Set();
    const out = [];
    for (const item of asArray(list)) {
      const text = clip(item, 40);
      const key = text.toLowerCase();
      if (!text || seen.has(key)) continue;
      seen.add(key);
      out.push(text);
      if (out.length >= limit) break;
    }
    return out;
  };
  return {
    food: uniq(src.food),
    media: uniq(src.media),
    places: uniq(src.places),
    shopping: uniq(src.shopping),
    study: uniq(src.study),
    dislikes: uniq(src.dislikes),
  };
}

function normalizeInterestTopic(value = '') {
  return clip(value, 180)
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

function interestTopicSimilarity(a = '', b = '') {
  const left = normalizeInterestTopic(a);
  const right = normalizeInterestTopic(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (Math.min(left.length, right.length) >= 4 && (left.includes(right) || right.includes(left))) return 1;
  const grams = (text) => {
    const out = new Set();
    for (let i = 0; i < text.length - 1; i += 1) out.add(text.slice(i, i + 2));
    return out;
  };
  const ga = grams(left);
  const gb = grams(right);
  if (!ga.size || !gb.size) return 0;
  let overlap = 0;
  for (const gram of ga) if (gb.has(gram)) overlap += 1;
  return (2 * overlap) / (ga.size + gb.size);
}

function recordDedupeKey(field, item = {}) {
  const lower = (value = '') => clip(value, 180).toLowerCase();
  if (!item || typeof item !== 'object') return '';
  if (field === 'interestRecords') return normalizeInterestTopic(item.title || item.name || '');
  if (field === 'mapPins') {
    return [
      lower(item.sourcePoiId),
      lower(item.location),
      lower(item.city),
      lower(item.placeName),
      lower(item.address),
    ].filter(Boolean).join('|');
  }
  if (field === 'mapItineraries') {
    return [
      lower(item.title),
      lower(item.city),
      asArray(item.stops).map((stop) => lower(stop?.placeName)).filter(Boolean).join('>'),
    ].filter(Boolean).join('|');
  }
  if (field === 'browserRecords') {
    return [
      lower(item.url),
      lower(item.sourceName),
      lower(item.query || item.title),
    ].filter(Boolean).join('|');
  }
  if (field === 'callRecords') return lower(item.messageId || item.id || `${item.contactName}|${item.occurredAt}`);
  if (field === 'musicRecords') return lower(item.url || `${item.title}|${item.artist}|${item.playedAt || ''}`);
  if (field === 'avatarLibrary') {
    // 绝不能用截断后的 data:image URL 做去重：clip/lower 只取前 180 字，
    // iOS 相册 JPEG 前缀高度相似，会把不同头像误判成同一张并「覆盖」掉旧图。
    const id = String(item.id || '').trim();
    if (id) return `id:${id.toLowerCase()}`;
    const url = String(item.imageUrl || '').trim();
    if (/^data:image\//i.test(url)) {
      return `data:${url.length}:${url.slice(-72)}`.toLowerCase();
    }
    return lower(url || item.imagePrompt || `${item.title}|${item.description}|${item.createdAt || ''}`);
  }
  if (field === 'notes') return lower(`${item.title}|${item.text}`);
  // data URL 同样不能截前缀；有 id 优先，否则对 data: 用长度+尾部指纹。
  {
    const id = String(item.id || '').trim();
    if (id) return lower(id);
    const url = String(item.url || item.imageUrl || '').trim();
    if (/^data:image\//i.test(url)) {
      return `data:${url.length}:${url.slice(-72)}`.toLowerCase();
    }
    return lower(url || item.title || item.placeName || '');
  }
}

function dedupePhoneList(field, list = [], limit = 40) {
  const seen = new Set();
  const out = [];
  for (const item of asArray(list)) {
    const key = recordDedupeKey(field, item);
    if (key && seen.has(key)) continue;
    if (field === 'interestRecords' && out.some((existing) => (
      interestTopicSimilarity(item?.title, existing?.title) >= 0.72
    ))) continue;
    if (key) seen.add(key);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

export function sortPhonePhotoRecordsNewestFirst(records = []) {
  return asArray(records)
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const aTime = Math.max(
        Number(a.item?.imageGeneratedAt || 0),
        Number(a.item?.takenAt || 0),
        Number(a.item?.createdAt || 0),
      );
      const bTime = Math.max(
        Number(b.item?.imageGeneratedAt || 0),
        Number(b.item?.takenAt || 0),
        Number(b.item?.createdAt || 0),
      );
      return bTime - aTime || a.index - b.index;
    })
    .map(({ item }) => item);
}

// 与 memoryFacts/eventMemories 共用统一时间状态语义（见 docs/temporal-memory-plan.md）：
// 地图钉不需要模型再额外输出一个字段——relationStatus 已经是它的第一手信号，
// 这里只是把已有信号翻译成统一语言，供日程生成时判断"这个地点还能不能当新鲜推荐"。
const MAP_PIN_COMPLETED_STATUSES = new Set(['visited', 'revisit', 'avoid']);
const MAP_PIN_PLANNED_STATUSES = new Set(['want_to_go', 'maybe', 'unvisited']);

export function resolveMapPinTemporalState(pin = {}) {
  const status = String(pin?.relationStatus || '').trim();
  if (status === 'candidate') return 'candidate';
  if (MAP_PIN_COMPLETED_STATUSES.has(status)) return 'completed';
  if (MAP_PIN_PLANNED_STATUSES.has(status)) return 'planned';
  return 'planned';
}

function normalizeMapPin(raw = {}, index = 0, now = Date.now()) {
  if (!raw || typeof raw !== 'object') return null;
  const placeName = clip(raw.placeName || raw.name || raw.title || '', 90);
  const location = clip(raw.location || raw.coordinate || '', 48);
  if (!placeName && !location) return null;
  const tags = asArray(raw.tags).map((x) => clip(x, 32)).filter(Boolean).slice(0, 12);
  const legacyAutoCandidate = tags.includes('auto_grow')
    && !(raw.relationStatus || raw.visitStatus || raw.status)
    && !(Number(raw.visitCount || 0) || Number(raw.lastVisitAt || raw.visitedAt || 0));
  const relationStatus = legacyAutoCandidate
    ? 'candidate'
    : clip(raw.relationStatus || raw.visitStatus || raw.status || '', 30);
  const aiJudgement = clip(raw.aiJudgement || raw.judgement || raw.reason || raw.note || '', 180);
  const nextAction = clip(raw.nextAction || raw.action || '', 60);
  const aiJudgementTranslation = clip(
    raw.aiJudgementTranslation || raw.aiJudgementZh || raw.zh || raw.translation || '',
    180,
  );
  const nextActionTranslation = clip(raw.nextActionTranslation || raw.nextActionZh || '', 60);
  return {
    id: String(raw.id || raw.sourcePoiId || raw.poiId || `pin_${now}_${index}`).trim(),
    placeName,
    city: clip(raw.city || '', 40),
    district: clip(raw.district || '', 60),
    address: clip(raw.address || '', 140),
    location,
    sourcePoiId: clip(raw.sourcePoiId || raw.poiId || raw.id || '', 90),
    sourceType: clip(raw.sourceType || raw.type || '', 120),
    bucket: clip(raw.bucket || 'other', 30),
    bucketLabel: clip(raw.bucketLabel || '', 40),
    rating: clip(raw.rating || '', 20),
    cost: clip(raw.cost || '', 20),
    photo: clipImageUrl(raw.photo || raw.imageUrl || ''),
    distance: Number(raw.distance || 0) || null,
    anchorName: clip(raw.anchorName || raw.anchor || '', 90),
    sourceQuery: clip(raw.sourceQuery || raw.query || '', 90),
    affinity: Math.max(0, Math.min(1, Number(raw.affinity ?? 0.5) || 0.5)),
    relationStatus,
    visitVerdict: clip(raw.visitVerdict || raw.verdict || raw.result || '', 50),
    aiJudgement,
    nextAction,
    ...(aiJudgementTranslation && aiJudgementTranslation !== aiJudgement
      ? { aiJudgementTranslation }
      : {}),
    ...(nextActionTranslation && nextActionTranslation !== nextAction
      ? { nextActionTranslation }
      : {}),
    visitCount: Math.max(0, Number(raw.visitCount || 0) || 0),
    lastVisitAt: Number(raw.lastVisitAt || raw.visitedAt || 0) || 0,
    lastVisitDateKey: clip(raw.lastVisitDateKey || '', 10),
    lastVisitScheduleRef: clip(raw.lastVisitScheduleRef || '', 140),
    temporalState: resolveMapPinTemporalState({ relationStatus }),
    visibility: clip(raw.visibility || (legacyAutoCandidate ? 'candidate' : 'private'), 30),
    tags,
    createdAt: Number(raw.createdAt || 0) || now,
    updatedAt: Number(raw.updatedAt || 0) || now,
  };
}

// 日程模型从高德候选里选中地点时，选择本身就是角色作出的生活决策：立即把候选升级为
// “想去”，但绝不能在日程生成时提前算作到访。真正的 visit 由下方的时段执行结算负责。
export function applyMapPinVisitTracking(phone, plan, { timestamp = Date.now() } = {}) {
  const pins = Array.isArray(phone?.mapPins) ? phone.mapPins : [];
  const blocks = Array.isArray(plan?.blocks) ? plan.blocks : [];
  if (!pins.length || !blocks.length) return phone;
  const mentioned = new Set();
  for (const block of blocks) {
    const name = clip(block?.placeName || '', 90).toLowerCase();
    if (name) mentioned.add(name);
  }
  if (!mentioned.size) return phone;
  let changed = false;
  const nextPins = pins.map((pin) => {
    const name = clip(pin?.placeName || '', 90).toLowerCase();
    if (!name || !mentioned.has(name)) return pin;
    changed = true;
    const wasCandidate = pin.relationStatus === 'candidate' || pin.visibility === 'candidate';
    const promotedStatus = wasCandidate ? 'want_to_go' : pin.relationStatus;
    return {
      ...pin,
      relationStatus: promotedStatus,
      temporalState: resolveMapPinTemporalState({ relationStatus: promotedStatus }),
      visibility: wasCandidate ? 'private' : pin.visibility,
      visitVerdict: wasCandidate ? '已选入日程' : pin.visitVerdict,
      nextAction: wasCandidate ? '按日程前往' : pin.nextAction,
      updatedAt: timestamp,
    };
  });
  if (!changed) return phone;
  return { ...phone, mapPins: nextPins };
}

/** 把 AI 选中的高德候选坐标原子写回日程，避免地点决定与地图落点脱节。 */
export function enrichDailyLifePlanWithMapCandidates(phone, plan) {
  const candidates = new Map(asArray(phone?.mapPins)
    .filter((pin) => pin?.relationStatus === 'candidate' || pin?.visibility === 'candidate')
    .map((pin) => [clip(pin?.placeName || '', 90).toLowerCase(), pin]));
  if (!candidates.size || !Array.isArray(plan?.blocks)) return plan;
  let changed = false;
  const blocks = plan.blocks.map((block) => {
    const placeName = clip(block?.placeName || '', 90);
    const pin = candidates.get(placeName.toLowerCase());
    if (!pin) return block;
    changed = true;
    const routeHint = block.routeHint && typeof block.routeHint === 'object' ? block.routeHint : {};
    const waypoints = asArray(routeHint.waypoints).filter((item) => item?.label !== placeName);
    waypoints.push({ label: placeName, kind: 'destination', location: pin.location || null });
    return {
      ...block,
      city: block.city || pin.city || '',
      routeHint: {
        ...routeHint,
        destination: routeHint.destination || placeName,
        waypoints: waypoints.slice(0, 8),
      },
    };
  });
  return changed ? { ...plan, blocks } : plan;
}

/** 已经过完且未取消的角色日程，才会把对应地点结算为真实到访。 */
export function applyElapsedScheduleMapVisits(phone, {
  timestamp = Date.now(),
  timeZone = '',
} = {}) {
  const pins = Array.isArray(phone?.mapPins) ? phone.mapPins : [];
  const plans = Array.isArray(phone?.dailyLifePlans) ? phone.dailyLifePlans : [];
  if (!pins.length) return phone;
  const today = dateKeyFromTimestamp(timestamp, timeZone);
  const nowMinute = minutesOfDayFromTimestamp(timestamp, timeZone);
  const completedByPlace = new Map();
  const plannedPlaces = new Set();
  for (const plan of plans) {
    const dateKey = String(plan?.dateKey || '').trim();
    if (!dateKey) continue;
    for (const block of asArray(plan?.blocks)) {
      if (isRetiredPlanBlock(block)) continue;
      const placeName = clip(block?.placeName || '', 90).toLowerCase();
      if (!placeName) continue;
      plannedPlaces.add(placeName);
      if (dateKey > today) continue;
      const endMinute = parseTimeRangeEndMinutes(block?.timeRange);
      const explicitlyDone = String(block?.status || '') === 'done';
      const elapsed = dateKey < today || (dateKey === today && endMinute >= 0 && endMinute <= nowMinute);
      if (!explicitlyDone && !elapsed) continue;
      completedByPlace.set(placeName, {
        dateKey,
        ref: `${dateKey}:${String(block?.id || block?.timeRange || placeName)}`,
      });
    }
  }
  let changed = false;
  const nextPins = pins.map((pin) => {
    const placeName = clip(pin?.placeName || '', 90).toLowerCase();
    const visit = completedByPlace.get(placeName);
    const legacyAutoVisit = asArray(pin?.tags).includes('auto_grow') && !pin.lastVisitScheduleRef;
    if (!visit) {
      if (!legacyAutoVisit) return pin;
      changed = true;
      const planned = plannedPlaces.has(placeName);
      const relationStatus = planned ? 'want_to_go' : 'candidate';
      return {
        ...pin,
        relationStatus,
        temporalState: planned ? 'planned' : 'candidate',
        visibility: planned ? 'private' : 'candidate',
        visitVerdict: planned ? '已选入日程' : '待角色筛选',
        visitCount: 0,
        lastVisitAt: 0,
        updatedAt: timestamp,
      };
    }
    if (pin.lastVisitScheduleRef === visit.ref) return pin;
    changed = true;
    const previousCount = legacyAutoVisit ? 0 : Math.max(0, Number(pin.visitCount || 0) || 0);
    const relationStatus = previousCount > 0 || pin.relationStatus === 'revisit' ? 'revisit' : 'visited';
    return {
      ...pin,
      relationStatus,
      temporalState: 'completed',
      visibility: 'private',
      visitVerdict: relationStatus === 'revisit' ? '再次到访' : '已经去过',
      visitCount: previousCount + 1,
      lastVisitAt: timestamp,
      lastVisitDateKey: visit.dateKey,
      lastVisitScheduleRef: visit.ref,
      updatedAt: timestamp,
    };
  });
  return changed ? { ...phone, mapPins: nextPins } : phone;
}

function normalizeLifeIntent(raw = {}, index = 0, now = Date.now()) {
  if (!raw || typeof raw !== 'object') return null;
  const query = clip(raw.query || raw.title || raw.note || '', 80);
  const action = clip(raw.action || 'save_note', 40);
  if (!query && !raw.reason && !raw.shareHint) return null;
  return {
    id: String(raw.id || `intent_${now}_${index}`).trim(),
    kind: clip(raw.kind || 'note', 40),
    query,
    action,
    city: clip(raw.city || '', 40),
    anchor: clip(raw.anchor || '', 90),
    target: clip(raw.target || '', 90),
    mode: clip(raw.mode || '', 30),
    reason: clip(raw.reason || raw.note || '', 180),
    shareHint: clip(raw.shareHint || '', 160),
    status: clip(raw.status || '', 30),
    aiJudgement: clip(raw.aiJudgement || raw.judgement || raw.verdict || '', 180),
    visibility: clip(raw.visibility || 'private', 30),
    updatedAt: Number(raw.updatedAt || 0) || now,
  };
}

function normalizeCurrentMapState(raw = {}, now = Date.now()) {
  const src = raw && typeof raw === 'object' ? raw : {};
  if (!(src.area || src.placeName || src.activity || src.city || src.location || src.target)) return {};
  const updatedAt = Number(src.updatedAt || 0) || now;
  return {
    area: clip(src.area || src.currentArea || src.anchor || '', 90),
    placeName: clip(src.placeName || src.place || src.anchorName || '', 90),
    activity: clip(src.activity || src.state || '', 90),
    city: clip(src.city || '', 40),
    location: clip(src.location || src.coordinate || '', 48),
    target: clip(src.target || src.destination || '', 90),
    mode: clip(src.mode || src.routeMode || '', 30),
    confidence: Math.max(0, Math.min(1, Number(src.confidence || 0) || 0)),
    source: clip(src.source || '', 50),
    visibility: clip(src.visibility || 'private', 30),
    tags: asArray(src.tags).map((x) => clip(x, 32)).filter(Boolean).slice(0, 12),
    updatedAt,
    expiresAt: Number(src.expiresAt || 0) || updatedAt + 12 * 60 * 60 * 1000,
  };
}

/** 路线 mode 对用户可见文案；内部标记（如 text_estimate）返回空以过滤。 */
export function formatRouteModeLabel(mode = '') {
  const raw = String(mode || '').trim();
  if (!raw) return '';
  const key = raw.toLowerCase().replace(/-/g, '_');
  const labels = {
    walk: '步行',
    walking: '步行',
    bike: '骑行',
    bicycle: '骑行',
    cycling: '骑行',
    transit: '公交',
    bus: '公交',
    subway: '地铁',
    metro: '地铁',
    drive: '驾车',
    driving: '驾车',
    car: '驾车',
    taxi: '打车',
    indoor: '室内',
    online: '线上',
    unknown: '',
    text_estimate: '',
    estimate: '',
  };
  if (Object.prototype.hasOwnProperty.call(labels, key)) return labels[key];
  // 英文内部枚举（snake/kebab）不直接露出
  if (/^[a-z]+(?:[_-][a-z0-9]+)+$/i.test(raw)) return '';
  return raw;
}

/** 过滤「待高德补坐标」等内部占位 summary。 */
export function sanitizeRouteSummary(summary = '') {
  const text = String(summary || '').trim();
  if (!text) return '';
  if (/待高德|text[_-]?estimate|文本估算路线/i.test(text)) return '';
  return text;
}

/** 拼一条用户可读的路线 meta（mode / 时长 / 距离 / summary），不含起终点。 */
export function formatRouteMetaLine(route = {}) {
  const src = route && typeof route === 'object' ? route : {};
  const summary = sanitizeRouteSummary(src.summary);
  const modeLabel = formatRouteModeLabel(src.mode);
  const durationText = String(src.durationText || '').trim();
  const distanceText = String(src.distanceText || '').trim();
  if (summary) {
    // summary 已含交通方式时不再重复 mode
    if (modeLabel && !summary.includes(modeLabel)) {
      return [modeLabel, summary].filter(Boolean).join(' · ');
    }
    return summary;
  }
  return [modeLabel, durationText, distanceText].filter(Boolean).join(' · ');
}

function normalizeRouteState(raw = {}, now = Date.now()) {
  const src = raw && typeof raw === 'object' ? raw : {};
  if (!(src.origin || src.destination || src.summary || src.mode)) return {};
  const updatedAt = Number(src.updatedAt || src.computedAt || 0) || now;
  return {
    origin: clip(src.origin || src.from || '', 90),
    originLocation: clip(src.originLocation || src.fromLocation || '', 48),
    destination: clip(src.destination || src.to || src.target || '', 90),
    destinationLocation: clip(src.destinationLocation || src.toLocation || '', 48),
    mode: clip(src.mode || src.routeMode || '', 30),
    activity: clip(src.activity || '', 60),
    distance: Number(src.distance || 0) || 0,
    duration: Number(src.duration || 0) || 0,
    summary: clip(src.summary || '', 160),
    polyline: asArray(src.polyline || src.points).map((x) => clip(x, 48)).filter(Boolean).slice(0, 24),
    source: clip(src.source || '', 50),
    updatedAt,
    expiresAt: Number(src.expiresAt || 0) || updatedAt + 2 * 60 * 60 * 1000,
  };
}

function normalizeMapItinerary(raw = {}, index = 0, now = Date.now()) {
  if (!raw || typeof raw !== 'object') return null;
  const title = clip(raw.title || raw.name || '', 100);
  const stops = asArray(raw.stops || raw.items).map((item, idx) => {
    if (!item || typeof item !== 'object') return null;
    const placeName = clip(item.placeName || item.name || item.title || '', 90);
    if (!placeName) return null;
    return {
      order: Number(item.order || idx + 1) || idx + 1,
      placeName,
      address: clip(item.address || '', 140),
      location: clip(item.location || '', 48),
      city: clip(item.city || raw.city || '', 40),
      district: clip(item.district || '', 60),
      bucket: clip(item.bucket || '', 30),
      bucketLabel: clip(item.bucketLabel || '', 40),
      rating: clip(item.rating || '', 20),
      cost: clip(item.cost || '', 20),
      distance: Number(item.distance || 0) || null,
      visitHint: clip(item.visitHint || item.note || '', 140),
    };
  }).filter(Boolean).slice(0, 8);
  if (!title && !stops.length) return null;
  return {
    id: String(raw.id || `itinerary_${now}_${index}`).trim(),
    title: title || '地图行程',
    city: clip(raw.city || stops[0]?.city || '', 40),
    anchorName: clip(raw.anchorName || raw.anchor || '', 90),
    theme: clip(raw.theme || raw.sourceQuery || '', 80),
    summary: clip(raw.summary || '', 220),
    routeSummary: clip(raw.routeSummary || '', 180),
    source: clip(raw.source || 'amap', 40),
    stops,
    createdAt: Number(raw.createdAt || 0) || now,
    updatedAt: Number(raw.updatedAt || 0) || now,
  };
}

export function normalizeDailyLifeBlock(item, index = 0) {
  if (!item || typeof item !== 'object') return null;
  const activity = clip(item.activity || '', 120);
  const narrative = String(item.narrative || item.text || '').trim();
  if (!activity && !narrative) return null;
  const activityTranslation = clip(
    item.activityTranslation || item.activityZh || '',
    160,
  );
  const narrativeTranslation = String(
    item.narrativeTranslation || item.narrativeZh || item.translation || item.zh || '',
  ).trim().slice(0, 800);
  const displayTranslations = Object.fromEntries(
    Object.entries(item.displayTranslations && typeof item.displayTranslations === 'object'
      ? item.displayTranslations
      : {})
      .map(([key, value]) => {
        const row = value && typeof value === 'object' ? value : {};
        const source = String(row.source || '').trim().slice(0, 360);
        const translation = String(row.translation || row.zh || '').trim().slice(0, 600);
        return source && translation ? [String(key || '').trim().slice(0, 100), { source, translation }] : null;
      })
      .filter((entry) => entry?.[0]),
  );
  return {
    id: String(item.id || `block_${index}`).trim(),
    timeRange: clip(item.timeRange || '', 32),
    anchor: clip(item.anchor || '', 60),
    placeName: clip(item.placeName || '', 80),
    city: clip(item.city || '', 40),
    activity: activity || clip(narrative, 60),
    narrative,
    ...(activityTranslation && activityTranslation !== activity ? { activityTranslation } : {}),
    ...(narrativeTranslation && narrativeTranslation !== narrative ? { narrativeTranslation } : {}),
    ...(Object.keys(displayTranslations).length ? { displayTranslations } : {}),
    busy: item.busy === true,
    // 真正在睡觉的那一段（区别于 busy=true 的"在忙但没睡"），由 AI 在生成日程时标注，
    // 用来给"分享冲动"等主动打扰类功能做"避开睡眠时间"的依据，不靠猜测时间段。
    isSleep: item.isSleep === true,
    mood: clip(item.mood || '', 40),
    environment: asArray(item.environment).map((x) => clip(x, 48)).filter(Boolean).slice(0, 6),
    choices: asArray(item.choices).map((x) => clip(x, 48)).filter(Boolean).slice(0, 6),
    shareCandidates: asArray(item.shareCandidates).map((x) => clip(x, 100)).filter(Boolean).slice(0, 4),
    routeHint: item.routeHint && typeof item.routeHint === 'object'
      ? {
        origin: clip(item.routeHint.origin || '', 80),
        destination: clip(item.routeHint.destination || '', 80),
        mode: clip(item.routeHint.mode || '', 32),
        durationText: clip(item.routeHint.durationText || '', 40),
        distanceText: clip(item.routeHint.distanceText || '', 40),
        waypoints: asArray(item.routeHint.waypoints).map((x) => ({
          label: clip(x?.label || x?.name || '', 80),
          kind: clip(x?.kind || '', 32),
          location: x?.location || null,
        })).filter((x) => x.label).slice(0, 8),
      }
      : null,
    flowSteps: asArray(item.flowSteps || item.steps)
      .map((step, i) => normalizeFlowStep(step, i))
      .filter(Boolean)
      .slice(0, 8),
    triggerWindows: asArray(item.triggerWindows || item.shareWindows)
      .map((step, i) => normalizeTriggerWindow(step, i))
      .filter(Boolean)
      .slice(0, 6),
    autoReply: item.autoReply && typeof item.autoReply === 'object'
      ? {
        text: clip(item.autoReply.text || '', 120),
        translation: clip(item.autoReply.translation || item.autoReply.zh || '', 220),
        setAt: Number(item.autoReply.setAt || 0) || 0,
        expireAt: Number(item.autoReply.expireAt || 0) || 0,
        pool: asArray(item.autoReply.pool).map((x) => clip(x, 120)).filter(Boolean).slice(0, 8),
        source: clip(item.autoReply.source || '', 80),
        reason: clip(item.autoReply.reason || '', 120),
      }
      : null,
    status: ['planned', 'active', 'done', 'changed', 'cancelled', 'skipped'].includes(item.status)
      ? item.status
      : 'planned',
    statusLabel: clip(item.statusLabel || '', 80),
    locked: item.locked === true,
    origin: clip(item.origin || 'ai', 24),
    updatedBy: clip(item.updatedBy || item.origin || 'ai', 24),
    supersededBy: clip(item.supersededBy || '', 60),
    supersedes: clip(item.supersedes || '', 60),
    changeReason: clip(item.changeReason || '', 120),
    sourceRefs: asArray(item.sourceRefs).map((x) => String(x || '').trim()).filter(Boolean).slice(0, 8),
    eventContext: item.eventContext && typeof item.eventContext === 'object'
      ? {
        archiveId: clip(item.eventContext.archiveId || '', 80),
        participantIds: asArray(item.eventContext.participantIds)
          .map((x) => String(x || '').trim()).filter(Boolean).slice(0, 12),
        participantNames: asArray(item.eventContext.participantNames)
          .map((x) => clip(x, 60)).filter(Boolean).slice(0, 12),
        summary: String(item.eventContext.summary || '').trim().slice(0, 500),
        memory: String(item.eventContext.memory || '').trim().slice(0, 700),
        quotes: asArray(item.eventContext.quotes).map((quote) => ({
          speaker: clip(quote?.speaker || '', 40),
          line: String(quote?.line || '').trim().slice(0, 180),
        })).filter((quote) => quote.line).slice(0, 3),
        relationshipShifts: asArray(item.eventContext.relationshipShifts)
          .map((x) => String(x || '').trim().slice(0, 180)).filter(Boolean).slice(0, 4),
        hooks: asArray(item.eventContext.hooks)
          .map((x) => String(x || '').trim().slice(0, 180)).filter(Boolean).slice(0, 4),
        items: asArray(item.eventContext.items)
          .map((x) => String(x || '').trim().slice(0, 160)).filter(Boolean).slice(0, 4),
      }
      : null,
    // 生成后查重校验的产物（见 character-daily-life.js flagRepeatedActivityBlocks）：
    // 命中 repeatWarning 类目时记录具体类目名，供下一次生成时作为"确认命中过"的证据带回提示词。
    repeatFlag: clip(item.repeatFlag || '', 20),
    // AI 生成时标的「这个具体事物值得搜一下」（电影名/书名/具体事件），生成后由
    // enrichBlocksWithEventSearch 消费掉去真搜；不是每个 block 都有。
    searchTopic: clip(item.searchTopic || '', 60),
    // searchTopic 定向搜索后压缩出的具体事实/观点一句话，供聊天时引用；由程序生成，不是 AI 直接写的。
    eventNote: clip(item.eventNote || '', 160),
    // `updatedAt` 只保存设备墙钟下的真实写入时间。故事/虚拟时间若需要留痕，
    // 单独放在 `worldUpdatedAt`，禁止再拿日程开始钟点冒充 mutation freshness。
    updatedAt: normalizeMutationUpdatedAt(item.updatedAt),
    worldUpdatedAt: Number(item.worldUpdatedAt || 0) || 0,
    planRevision: normalizePlanRevision(item.planRevision),
  };
}

export function normalizeDailyLifePlan(raw = {}, { characterId, dateKey, now = Date.now() } = {}) {
  const dk = String(raw.dateKey || dateKey || '').trim();
  const blocks = asArray(raw.blocks)
    .map((b, i) => normalizeDailyLifeBlock(b, i))
    .filter(Boolean);
  const firstLocation = blocks.map(locationFromBlock).find(Boolean) || null;
  const lastLocation = blocks.map(locationFromBlock).filter(Boolean).slice(-1)[0] || firstLocation;
  const dayTheme = clip(raw.dayTheme || '', 80);
  const mood = clip(raw.mood || '', 60);
  const dayThemeTranslation = clip(raw.dayThemeTranslation || raw.dayThemeZh || '', 120);
  const moodTranslation = clip(raw.moodTranslation || raw.moodZh || '', 80);
  return {
    id: String(raw.id || `daily_${characterId}_${dk}`).trim(),
    characterId: String(characterId || raw.characterId || '').trim(),
    dateKey: dk,
    dayType: clip(raw.dayType || 'mixed', 24),
    dayTheme,
    mood,
    ...(dayThemeTranslation && dayThemeTranslation !== dayTheme ? { dayThemeTranslation } : {}),
    ...(moodTranslation && moodTranslation !== mood ? { moodTranslation } : {}),
    dayStartLocation: normalizePlanLocation(raw.dayStartLocation) || firstLocation,
    dayEndLocation: normalizePlanLocation(raw.dayEndLocation) || lastLocation,
    openLoops: asArray(raw.openLoops).map((x) => clip(x, 120)).filter(Boolean).slice(0, 6),
    privateThoughts: asArray(raw.privateThoughts).map((x) => clip(x, 120)).filter(Boolean).slice(0, 6),
    blocks,
    source: String(raw.source || 'dailyLifePlanGenerator').trim(),
    generatedAt: Number(raw.generatedAt) || now,
    updatedAt: normalizeMutationUpdatedAt(raw.updatedAt),
    worldUpdatedAt: Number(raw.worldUpdatedAt || 0) || 0,
    planRevision: normalizePlanRevision(raw.planRevision),
  };
}

export function createEmptyCharacterPhone(userId, characterId) {
  return {
    schemaVersion: PHONE_SCHEMA_VERSION,
    phoneRevision: 0,
    userId: String(userId || '').trim(),
    characterId: String(characterId || '').trim(),
    updatedAt: Date.now(),
    dailyLifePlans: [],
    offlineScheduleOverrides: [],
    notes: [],
    browserRecords: [],
    photoRecords: [],
    callRecords: [],
    musicRecords: [],
    interestRecords: [],
    avatarLibrary: [],
    mapPins: [],
    mapItineraries: [],
    lifeIntents: [],
    preferences: normalizePreferences(),
    currentMapState: {},
    routeState: {},
    mapGrowState: {},
    appReadState: {},
    shellPreferences: normalizePhoneShellPreferences({
      widgets: DEFAULT_PHONE_WIDGETS,
      dock: DEFAULT_PHONE_DOCK,
    }),
    scheduleProactiveSettings: normalizeScheduleProactiveSettings(),
  };
}

export async function loadCharacterPhone(userId, characterId) {
  const row = await dbGet(phoneKey(userId, characterId));
  const v = row?.value;
  if (!v || typeof v !== 'object') {
    return createEmptyCharacterPhone(userId, characterId);
  }
  const phone = {
    ...createEmptyCharacterPhone(userId, characterId),
    ...v,
    phoneRevision: Math.max(0, Math.floor(Number(v.phoneRevision || 0) || 0)),
    userId: String(userId || '').trim(),
    characterId: String(characterId || '').trim(),
    dailyLifePlans: asArray(v.dailyLifePlans),
    offlineScheduleOverrides: asArray(v.offlineScheduleOverrides)
      .filter((item) => item && typeof item === 'object' && item.dateKey && item.block)
      .slice(-80),
    notes: asArray(v.notes),
    browserRecords: dedupePhoneList('browserRecords', asArray(v.browserRecords), 80),
    // 相册不再按 80 条静默淘汰；图片已在落库前压缩，容量由用户主动删除与存储配额管理。
    photoRecords: dedupePhoneList(
      'photoRecords',
      sortPhonePhotoRecordsNewestFirst(v.photoRecords),
      Number.POSITIVE_INFINITY,
    ),
    callRecords: dedupePhoneList('callRecords', asArray(v.callRecords), 60),
    musicRecords: dedupePhoneList('musicRecords', asArray(v.musicRecords), 80),
    interestRecords: dedupePhoneList('interestRecords', asArray(v.interestRecords), 80),
    avatarLibrary: dedupePhoneList('avatarLibrary', asArray(v.avatarLibrary), 60),
    mapPins: dedupePhoneList('mapPins', asArray(v.mapPins).map((item, i) => normalizeMapPin(item, i)).filter(Boolean), 120),
    mapItineraries: dedupePhoneList('mapItineraries', asArray(v.mapItineraries).map((item, i) => normalizeMapItinerary(item, i)).filter(Boolean), 40),
    lifeIntents: asArray(v.lifeIntents).map((item, i) => normalizeLifeIntent(item, i)).filter(Boolean),
    preferences: normalizePreferences(v.preferences),
    currentMapState: normalizeCurrentMapState(v.currentMapState),
    routeState: normalizeRouteState(v.routeState),
    mapGrowState: v.mapGrowState && typeof v.mapGrowState === 'object' ? { ...v.mapGrowState } : {},
    appReadState: normalizePhoneAppReadState(v.appReadState),
    shellPreferences: normalizePhoneShellPreferences(v.shellPreferences || {
      widgets: DEFAULT_PHONE_WIDGETS,
      dock: DEFAULT_PHONE_DOCK,
    }),
    scheduleProactiveSettings: normalizeScheduleProactiveSettings(v.scheduleProactiveSettings),
  };
  if (!v.appReadState || typeof v.appReadState !== 'object') {
    phone.appReadState = createPhoneAppReadSnapshot(phone);
  }
  return phone;
}

export async function saveCharacterPhone(phone) {
  if (!phone?.characterId) return phone;
  const key = phoneKey(phone.userId, phone.characterId);
  const incomingRevision = Math.max(0, Math.floor(Number(phone.phoneRevision || 0) || 0));
  const incomingUpdatedAt = Math.max(0, Number(phone.updatedAt || 0) || 0);
  const result = await dbUpdateRecord('settings', key, (row) => {
    const latest = row?.value && typeof row.value === 'object' ? row.value : null;
    const latestRevision = Math.max(0, Math.floor(Number(latest?.phoneRevision || 0) || 0));
    const latestUpdatedAt = Math.max(0, Number(latest?.updatedAt || 0) || 0);
    const staleSnapshot = !!latest && (
      latestRevision > incomingRevision
      || (latestRevision === 0 && incomingRevision === 0 && latestUpdatedAt > incomingUpdatedAt)
    );
    const savedAt = Date.now();
    const next = {
      ...phone,
      // 外观是用户亲手设置的资产。日程、自动回复和手机记录生成可能持有较早快照；
      // 这些后台结果晚到时只允许写自己的业务字段，不能把最新图标和壁纸倒回旧值。
      shellPreferences: normalizePhoneShellPreferences(
        staleSnapshot ? latest.shellPreferences : phone.shellPreferences,
      ),
      // 兜住仍直接改 dailyLifePlans 后调用 save 的旧入口（旅行收尾等）。
      // 已经由 upsert 打过戳的 revision 原样保留；同 revision 但内容变化时，
      // 在持久化边界补一次真实 wall mutation stamp。
      dailyLifePlans: reconcileDailyLifePlansForSave(
        phone,
        asArray(phone.dailyLifePlans),
        asArray(latest?.dailyLifePlans),
        savedAt,
        { staleSnapshot },
      ),
      phoneRevision: Math.max(latestRevision, incomingRevision) + 1,
      updatedAt: savedAt,
    };
    return { key, value: next };
  });
  const saved = result.record?.value || phone;
  notifyCharacterPhoneUpdated(saved);
  return saved;
}

/**
 * 原子更新角色手机外观。上传图标和套用预设不再依赖页面早先读取的整部手机快照，
 * 因而能与后台日程、自动回复和记录生成安全交错。
 */
export async function updateCharacterPhoneShellPreferences(
  userId,
  characterId,
  patch = {},
  options = {},
) {
  const uid = String(userId || '').trim();
  const cid = String(characterId || '').trim();
  if (!cid) return createEmptyCharacterPhone(uid, cid);
  const key = phoneKey(uid, cid);
  await dbUpdateRecord('settings', key, (row) => {
    const current = row?.value && typeof row.value === 'object'
      ? row.value
      : createEmptyCharacterPhone(uid, cid);
    const currentShell = normalizePhoneShellPreferences(current.shellPreferences);
    const sourcePatch = patch && typeof patch === 'object' ? patch : {};
    const replace = options.replace === true;
    const shellSource = replace
      ? sourcePatch
      : {
        ...currentShell,
        ...sourcePatch,
        appIcons: Object.prototype.hasOwnProperty.call(sourcePatch, 'appIcons')
          ? { ...(currentShell.appIcons || {}), ...(sourcePatch.appIcons || {}) }
          : currentShell.appIcons,
      };
    const latestRevision = Math.max(0, Math.floor(Number(current.phoneRevision || 0) || 0));
    return {
      key,
      value: {
        ...current,
        schemaVersion: PHONE_SCHEMA_VERSION,
        userId: uid,
        characterId: cid,
        shellPreferences: normalizePhoneShellPreferences(shellSource),
        phoneRevision: latestRevision + 1,
        updatedAt: Date.now(),
      },
    };
  });
  return loadCharacterPhone(uid, cid);
}

/**
 * 美化预设属于用户资产，跨角色共用；角色当前套用的 shellPreferences 仍独立保存。
 * 旧版本曾把预设塞进各角色记录，首次读取共享库时自动汇总并清空旧字段，
 * 避免用户删掉共享预设后又被遗留数据重新迁回。
 */
export async function loadPhoneAppearancePresets(userId) {
  const key = phoneAppearancePresetsKey(userId);
  const sharedRow = await dbGet(key);
  const sharedSource = Array.isArray(sharedRow?.value)
    ? sharedRow.value
    : sharedRow?.value?.presets;
  const shared = normalizePhoneAppearancePresets(sharedSource);

  const uid = encodeURIComponent(String(userId || '').trim() || 'guest');
  const prefix = `characterPhone_${uid}_`;
  const rows = await getAllRecords('settings');
  const legacyRows = (Array.isArray(rows) ? rows : []).filter((row) => (
    String(row?.key || '').startsWith(prefix)
    && Array.isArray(row?.value?.shellPreferences?.appearancePresets)
    && row.value.shellPreferences.appearancePresets.length > 0
  ));
  const legacy = legacyRows
    .flatMap((row) => row.value.shellPreferences.appearancePresets)
    .sort((a, b) => Number(b?.updatedAt || 0) - Number(a?.updatedAt || 0));
  const merged = normalizePhoneAppearancePresets([...shared, ...legacy]);

  if (legacyRows.length) {
    await Promise.all(legacyRows.map((row) => dbUpdateRecord('settings', row.key, (currentRow) => {
      const current = currentRow?.value && typeof currentRow.value === 'object'
        ? currentRow.value
        : row.value;
      return {
        key: row.key,
        value: {
          ...current,
          shellPreferences: normalizePhoneShellPreferences({
            ...(current.shellPreferences || {}),
            appearancePresets: [],
          }),
          phoneRevision: Math.max(0, Math.floor(Number(current.phoneRevision || 0) || 0)) + 1,
          updatedAt: Date.now(),
        },
      };
    })));
  }
  if (legacyRows.length || JSON.stringify(shared) !== JSON.stringify(merged)) {
    await dbPut({
      key,
      value: {
        version: 1,
        presets: merged,
        updatedAt: Date.now(),
      },
    });
  }
  return merged;
}

export async function savePhoneAppearancePreset(userId, input = {}) {
  const current = await loadPhoneAppearancePresets(userId);
  const name = clip(input?.name || '', 32);
  if (!name) return current;
  const existing = current.find((item) => item.name === name);
  const now = Date.now();
  const preset = normalizePhoneAppearancePresets([{
    ...input,
    id: existing?.id || input?.id || genId('appearance'),
    name,
    shell: { ...(input?.shell || {}), appearancePresets: [] },
    createdAt: Number(existing?.createdAt || input?.createdAt) || now,
    updatedAt: now,
  }])[0];
  const next = normalizePhoneAppearancePresets([
    preset,
    ...current.filter((item) => item.name !== name),
  ]);
  await dbPut({
    key: phoneAppearancePresetsKey(userId),
    value: {
      version: 1,
      presets: next,
      updatedAt: now,
    },
  });
  return next;
}

export async function deletePhoneAppearancePreset(userId, presetId) {
  const current = await loadPhoneAppearancePresets(userId);
  const id = String(presetId || '').trim();
  const next = current.filter((item) => item.id !== id);
  if (next.length !== current.length) {
    await dbPut({
      key: phoneAppearancePresetsKey(userId),
      value: {
        version: 1,
        presets: next,
        updatedAt: Date.now(),
      },
    });
  }
  return next;
}

export function getDailyLifePlanForDate(phone, dateKey) {
  const dk = String(dateKey || '').trim();
  if (!dk) return null;
  const plans = asArray(phone?.dailyLifePlans);
  const basePlan = plans.find((p) => String(p?.dateKey || '') === dk) || null;
  const overrides = asArray(phone?.offlineScheduleOverrides)
    .filter((item) => String(item?.dateKey || '') === dk && item?.block)
    .sort((a, b) => Number(a?.updatedAt || 0) - Number(b?.updatedAt || 0));
  if (!overrides.length) return basePlan;

  let blocks = asArray(basePlan?.blocks);
  for (const item of overrides) {
    const block = normalizeDailyLifeBlock(item.block, blocks.length);
    if (!block) continue;
    const start = parseTimeRangeStartMinutes(block.timeRange);
    const endRaw = parseTimeRangeEndMinutes(block.timeRange);
    if (start >= 0 && endRaw >= 0) {
      const end = endRaw < start ? endRaw + 1440 : endRaw;
      blocks = blocks.filter((candidate) => {
        const candidateStart = parseTimeRangeStartMinutes(candidate?.timeRange);
        const candidateEndRaw = parseTimeRangeEndMinutes(candidate?.timeRange);
        if (candidateStart < 0 || candidateEndRaw < 0) return true;
        const candidateEnd = candidateEndRaw < candidateStart ? candidateEndRaw + 1440 : candidateEndRaw;
        return !(start < candidateEnd && candidateStart < end);
      });
    }
    blocks.push(block);
  }
  blocks.sort((a, b) => {
    const sa = parseTimeRangeStartMinutes(a?.timeRange);
    const sb = parseTimeRangeStartMinutes(b?.timeRange);
    return (sa < 0 ? 9999 : sa) - (sb < 0 ? 9999 : sb);
  });
  const merged = normalizeDailyLifePlan({
    ...(basePlan || {}),
    dateKey: dk,
    blocks,
    source: basePlan?.source || 'offlineScheduleOverride',
    updatedAt: Math.max(
      normalizeMutationUpdatedAt(basePlan?.updatedAt),
      ...overrides.map((item) => normalizeMutationUpdatedAt(item?.updatedAt)),
      ...blocks.map((block) => normalizeMutationUpdatedAt(block?.updatedAt)),
    ),
    planRevision: Math.max(
      normalizePlanRevision(basePlan?.planRevision),
      ...overrides.map((item) => normalizePlanRevision(item?.planRevision)),
      ...blocks.map((block) => normalizePlanRevision(block?.planRevision)),
    ),
  }, { characterId: phone?.characterId, dateKey: dk });
  return {
    ...merged,
    runtimeOnly: !basePlan,
  };
}

export function upsertOfflineScheduleOverride(phone, raw = {}) {
  const dateKey = String(raw.dateKey || '').trim();
  const sourceId = String(raw.sourceId || '').trim();
  const phase = String(raw.phase || 'active').trim();
  const normalizedBlock = normalizeDailyLifeBlock(raw.block, 0);
  const wallUpdatedAt = normalizeMutationUpdatedAt(raw.updatedAt) || Date.now();
  const previousOverride = asArray(phone?.offlineScheduleOverrides).find((item) => (
    String(item?.sourceId || '') === sourceId
    && String(item?.dateKey || '') === dateKey
  )) || null;
  const basePlan = asArray(phone?.dailyLifePlans)
    .find((item) => String(item?.dateKey || '') === dateKey) || null;
  const planRevision = Math.max(
    normalizePlanRevision(basePlan?.planRevision),
    normalizePlanRevision(previousOverride?.planRevision),
    normalizePlanRevision(normalizedBlock?.planRevision),
  ) + 1;
  const block = normalizedBlock
    ? stampDailyLifeBlockMutation(normalizedBlock, previousOverride?.block, planRevision, wallUpdatedAt)
    : null;
  if (!phone || !dateKey || !sourceId || !block) return phone;
  const list = asArray(phone.offlineScheduleOverrides).filter((item) => !(
    String(item?.sourceId || '') === sourceId
    && String(item?.dateKey || '') === dateKey
  ));
  list.push({
    dateKey,
    sourceId,
    phase,
    block,
    updatedAt: wallUpdatedAt,
    planRevision,
  });
  list.sort((a, b) => Number(a?.updatedAt || 0) - Number(b?.updatedAt || 0));
  return { ...phone, offlineScheduleOverrides: list.slice(-80) };
}

export function removeOfflineScheduleOverrides(phone, { sourceId = '', phase = '' } = {}) {
  if (!phone) return phone;
  const sid = String(sourceId || '').trim();
  const phaseName = String(phase || '').trim();
  return {
    ...phone,
    offlineScheduleOverrides: asArray(phone.offlineScheduleOverrides).filter((item) => {
      if (sid && String(item?.sourceId || '') !== sid) return true;
      if (phaseName && String(item?.phase || '') !== phaseName) return true;
      return false;
    }),
  };
}

function isDateKey(value = '') {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '').trim());
}

function resetScheduleRuntimeState(settings = {}) {
  const current = normalizeScheduleProactiveSettings(settings);
  return {
    ...current,
    lastRunDate: '',
    triggeredKeys: [],
    lastTriggeredAt: 0,
    lastStatus: '',
    runningSlotKey: '',
    runningAt: 0,
  };
}

export function pruneExpiredDailyLifePlans(phone, currentDateKey) {
  const dk = String(currentDateKey || '').trim();
  if (!phone || !isDateKey(dk)) return { phone, removed: 0 };
  const cutoffDate = new Date(`${dk}T00:00:00.000Z`);
  cutoffDate.setUTCDate(cutoffDate.getUTCDate() - (SCHEDULE_HISTORY_RETENTION_DAYS - 1));
  const cutoffDateKey = cutoffDate.toISOString().slice(0, 10);
  const plans = asArray(phone.dailyLifePlans);
  const kept = plans.filter((plan) => {
    const planDateKey = String(plan?.dateKey || '').trim();
    return isDateKey(planDateKey) && planDateKey >= cutoffDateKey;
  });
  if (kept.length === plans.length) return { phone, removed: 0 };
  return {
    phone: {
      ...phone,
      dailyLifePlans: kept,
    },
    removed: plans.length - kept.length,
  };
}

export function clearDailyLifePlans(phone) {
  if (!phone) return phone;
  return {
    ...phone,
    dailyLifePlans: [],
    offlineScheduleOverrides: [],
    sessionAutoReply: null,
    busyAutoReplyState: {},
    scheduleProactiveSettings: resetScheduleRuntimeState(phone.scheduleProactiveSettings),
  };
}

export async function clearCharacterPhoneSchedules(userId, characterId) {
  const phone = await loadCharacterPhone(userId, characterId);
  return saveCharacterPhone(clearDailyLifePlans(phone));
}

export async function pruneExpiredCharacterPhoneSchedules(userId, characterId, currentDateKey) {
  const loaded = await loadCharacterPhone(userId, characterId);
  const result = pruneExpiredDailyLifePlans(loaded, currentDateKey);
  if (!result.removed) return { phone: loaded, removed: 0 };
  return {
    phone: await saveCharacterPhone(result.phone),
    removed: result.removed,
  };
}

/** 批量清理用户下所有角色手机的过期日程（dateKey < 今天） */
export async function pruneAllExpiredCharacterPhoneSchedules(userId, currentDateKey) {
  const dk = String(currentDateKey || '').trim();
  if (!userId || !isDateKey(dk)) {
    return { pruned: 0, phonesChanged: 0, phones: 0 };
  }
  const phones = await listCharacterPhonesForUser(userId);
  let pruned = 0;
  let phonesChanged = 0;
  for (const rawPhone of phones) {
    const characterId = String(rawPhone?.characterId || '').trim();
    if (!characterId) continue;
    const result = pruneExpiredDailyLifePlans(rawPhone, dk);
    if (!result.removed) continue;
    pruned += result.removed;
    phonesChanged += 1;
    await saveCharacterPhone(result.phone);
  }
  return { pruned, phonesChanged, phones: phones.length };
}

function stampDailyLifeBlockMutation(block, previousBlock, planRevision, wallUpdatedAt) {
  const flowSteps = asArray(block?.flowSteps).map((step, index) => scheduleEntityWithMutation(
    step,
    previousScheduleEntityById(previousBlock?.flowSteps, step?.id, index),
    planRevision,
    wallUpdatedAt,
  ));
  const triggerWindows = asArray(block?.triggerWindows).map((trigger, index) => scheduleEntityWithMutation(
    trigger,
    previousScheduleEntityById(previousBlock?.triggerWindows, trigger?.id, index),
    planRevision,
    wallUpdatedAt,
  ));
  return scheduleEntityWithMutation({
    ...block,
    flowSteps,
    triggerWindows,
  }, previousBlock, planRevision, wallUpdatedAt);
}

function stampDailyLifePlanMutation(phone, rawPlan, previousPlan, wallUpdatedAt) {
  const generatedAt = Number(rawPlan?.generatedAt || 0) || Date.now();
  const plan = normalizeDailyLifePlan(rawPlan, {
    characterId: phone?.characterId,
    dateKey: rawPlan?.dateKey,
    now: generatedAt,
  });
  const previous = previousPlan
    ? normalizeDailyLifePlan(previousPlan, {
      characterId: phone?.characterId,
      dateKey: previousPlan?.dateKey,
      now: Number(previousPlan?.generatedAt || 0) || generatedAt,
    })
    : null;
  const planRevision = normalizePlanRevision(previous?.planRevision) + 1;
  const blocks = asArray(plan.blocks).map((block, index) => stampDailyLifeBlockMutation(
    block,
    previousScheduleEntityById(previous?.blocks, block?.id, index),
    planRevision,
    wallUpdatedAt,
  ));
  return {
    ...plan,
    blocks,
    updatedAt: wallUpdatedAt,
    planRevision,
  };
}

function reconcileDailyLifePlansForSave(
  phone,
  incomingPlans,
  latestPlans,
  wallUpdatedAt,
  { staleSnapshot = false } = {},
) {
  return asArray(incomingPlans).map((rawPlan) => {
    const previous = asArray(latestPlans)
      .find((item) => String(item?.dateKey || '') === String(rawPlan?.dateKey || '')) || null;
    const incomingRevision = normalizePlanRevision(rawPlan?.planRevision);
    const previousRevision = normalizePlanRevision(previous?.planRevision);
    const incomingUpdatedAt = normalizeMutationUpdatedAt(rawPlan?.updatedAt);
    if (previous && (
      incomingRevision < previousRevision
      || (staleSnapshot && incomingRevision <= previousRevision)
    )) return previous;
    if (
      incomingUpdatedAt
      && incomingRevision > previousRevision
    ) {
      return normalizeDailyLifePlan(rawPlan, {
        characterId: phone?.characterId,
        dateKey: rawPlan?.dateKey,
        now: Number(rawPlan?.generatedAt || 0) || wallUpdatedAt,
      });
    }
    if (previous && scheduleContentMatches(rawPlan, previous)) return previous;
    return stampDailyLifePlanMutation(phone, rawPlan, previous, wallUpdatedAt);
  });
}

export function upsertDailyLifePlan(phone, plan, options = {}) {
  if (!plan?.dateKey) return phone;
  const wallUpdatedAt = normalizeMutationUpdatedAt(options.wallNow || options.updatedAt) || Date.now();
  const previous = asArray(phone?.dailyLifePlans)
    .find((item) => String(item?.dateKey || '') === String(plan.dateKey)) || null;
  const stampedPlan = stampDailyLifePlanMutation(phone, plan, previous, wallUpdatedAt);
  const list = asArray(phone.dailyLifePlans).filter((p) => String(p?.dateKey) !== String(stampedPlan.dateKey));
  list.push(stampedPlan);
  list.sort((a, b) => String(a.dateKey).localeCompare(String(b.dateKey)));
  return { ...phone, dailyLifePlans: list.slice(-14) };
}

/** 合并 AI 结构化 patch（notes 等必须来自 JSON 字段，不做正则抽取） */
export function mergePhoneStructuredPatch(phone, patch = {}, options = {}) {
  const next = { ...phone };
  const dk = String(patch.dateKey || '').trim();
  const now = Number(options.now || patch.worldNow || 0) || Date.now();
  const wallNow = normalizeMutationUpdatedAt(options.wallNow) || Date.now();

  if (Array.isArray(patch.dailyLifePlans)) {
    for (const raw of patch.dailyLifePlans) {
      const plan = normalizeDailyLifePlan(raw, { characterId: phone.characterId, dateKey: raw.dateKey || dk, now });
      if (plan.blocks.length) Object.assign(next, upsertDailyLifePlan(next, plan, { wallNow }));
    }
  } else if (patch.dailyLifePlan) {
    const plan = normalizeDailyLifePlan(patch.dailyLifePlan, { characterId: phone.characterId, dateKey: dk, now });
    if (plan.blocks.length) Object.assign(next, upsertDailyLifePlan(next, plan, { wallNow }));
  }

  const mergeList = (field, normalizer, limit = 40) => {
    const incoming = asArray(patch[field]);
    if (!incoming.length) return;
    const stamped = incoming
      .map((item, i) => normalizer(item, i, now))
      .filter(Boolean)
      .map((item) => ({ ...item, sourceDateKey: item.sourceDateKey || dk }));
    const old = asArray(next[field]).filter((item) => {
      if (!dk) return true;
      return String(item?.sourceDateKey || '') !== dk
        || String(item?.source || '') !== 'dailyLifePlanGenerator';
    });
    const merged = field === 'photoRecords'
      ? sortPhonePhotoRecordsNewestFirst([...stamped, ...old])
      : [...stamped, ...old];
    next[field] = dedupePhoneList(
      field,
      merged,
      field === 'photoRecords' ? Number.POSITIVE_INFINITY : limit,
    );
  };

  mergeList('notes', normalizePhoneNote, 48);
  {
    const cutoff = now - NOTE_EXPIRE_MS;
    next.notes = asArray(next.notes).filter((n) => n?.completed || Number(n?.updatedAt || n?.createdAt || 0) >= cutoff);
  }
  mergeList('browserRecords', (item, i, stamp) => normalizePhoneLink({
    ...(item || {}),
    source: patch.source || item?.source || 'phoneBatchGenerator',
  }, i, stamp), 80);
  mergeList('photoRecords', normalizePhonePhoto, 80);
  mergeList('callRecords', normalizePhoneCall, 60);
  mergeList('musicRecords', normalizePhoneMusic, 80);
  mergeList('interestRecords', normalizePhoneInterest, 80);
  mergeList('avatarLibrary', normalizeAvatarItem, 60);
  mergeList('mapPins', normalizeMapPin, 120);
  mergeList('mapItineraries', normalizeMapItinerary, 40);
  mergeList('lifeIntents', normalizeLifeIntent, 80);

  if (patch.preferences && typeof patch.preferences === 'object') {
    const cur = normalizePreferences(next.preferences);
    const incoming = normalizePreferences(patch.preferences);
    next.preferences = normalizePreferences({
      food: [...incoming.food, ...cur.food],
      media: [...incoming.media, ...cur.media],
      places: [...incoming.places, ...cur.places],
      shopping: [...incoming.shopping, ...cur.shopping],
      study: [...incoming.study, ...cur.study],
      dislikes: [...incoming.dislikes, ...cur.dislikes],
    });
  }
  if (patch.currentMapState && typeof patch.currentMapState === 'object') {
    const state = normalizeCurrentMapState(patch.currentMapState, now);
    if (Object.keys(state).length) next.currentMapState = state;
  }
  if (patch.routeState && typeof patch.routeState === 'object') {
    const state = normalizeRouteState(patch.routeState, now);
    if (Object.keys(state).length) next.routeState = state;
  }
  if (patch.mapGrowState && typeof patch.mapGrowState === 'object') {
    next.mapGrowState = { ...(next.mapGrowState || {}), ...patch.mapGrowState };
  }

  return next;
}

export function compactPhoneRecords(phone) {
  return {
    browserRecords: asArray(phone?.browserRecords),
    photoRecords: asArray(phone?.photoRecords),
    callRecords: asArray(phone?.callRecords),
    musicRecords: asArray(phone?.musicRecords),
    interestRecords: asArray(phone?.interestRecords),
    avatarLibrary: asArray(phone?.avatarLibrary),
    notes: asArray(phone?.notes),
  };
}

export async function togglePhoneNoteComplete(userId, characterId, noteId, completed) {
  const phone = await loadCharacterPhone(userId, characterId);
  phone.notes = asArray(phone.notes).map((n) => (
    n.id === noteId ? { ...n, completed: !!completed, updatedAt: Date.now() } : n
  ));
  return saveCharacterPhone(phone);
}

export async function appendCharacterPhoneCallRecord(userId, characterId, record = {}) {
  if (!userId || !characterId || !record) return null;
  const phone = await loadCharacterPhone(userId, characterId);
  const next = mergePhoneStructuredPatch(phone, {
    callRecords: [record],
  });
  return saveCharacterPhone(next);
}

function characterPhoneAutoSettingsKey(userId = '') {
  return `${AUTO_SETTINGS_KEY_PREFIX}${encodeURIComponent(String(userId || '').trim() || 'guest')}`;
}

export async function loadCharacterPhoneAutoSettings(userId = '') {
  const uid = String(userId || '').trim();
  const key = characterPhoneAutoSettingsKey(uid);
  const row = await dbGet(key);
  const v = row?.value;
  if (v && typeof v === 'object') {
    return {
      globalEnabled: v.globalEnabled === true,
      perCharacter: v.perCharacter && typeof v.perCharacter === 'object' ? { ...v.perCharacter } : {},
    };
  }

  // 旧开关只有 characterId、没有档位归属，不能作为可信迁移来源。角色策略中的
  // autoGenerate 已按档位和角色隔离，可恢复用户最后一次明确保存的自动日程选择；
  // 真人感开关不再参与推断，避免两项功能在迁移时重新粘回去。
  const autonomyPrefix = `characterAutonomySettings:v1:${encodeURIComponent(uid || 'guest')}:`;
  const rows = await getAllRecords('settings').catch(() => []);
  const perCharacter = {};
  for (const setting of Array.isArray(rows) ? rows : []) {
    if (!String(setting?.key || '').startsWith(autonomyPrefix)) continue;
    const autonomy = setting?.value && typeof setting.value === 'object' ? setting.value : {};
    const characterId = String(autonomy.characterId || '').trim();
    if (characterId && autonomy.roleDefaults?.scheduleProactive?.autoGenerate === true) {
      perCharacter[characterId] = true;
    }
  }
  const migrated = { globalEnabled: false, perCharacter };
  await dbPut({ key, value: migrated });
  return migrated;
}

export async function saveCharacterPhoneAutoSettings(userId = '', patch = {}) {
  const uid = String(userId || '').trim();
  const cur = await loadCharacterPhoneAutoSettings(uid);
  const next = {
    globalEnabled: patch.globalEnabled != null ? !!patch.globalEnabled : cur.globalEnabled,
    perCharacter: { ...cur.perCharacter, ...(patch.perCharacter || {}) },
  };
  await dbPut({ key: characterPhoneAutoSettingsKey(uid), value: next });
  return next;
}

export function isDailyLifeAutoEnabled(settings, characterId) {
  if (!settings) return false;
  const cid = String(characterId || '').trim();
  if (Object.prototype.hasOwnProperty.call(settings.perCharacter || {}, cid)) {
    return settings.perCharacter[cid] === true;
  }
  return settings.globalEnabled === true;
}

function normalizeScheduleProactiveSettings(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const busyReplyMode = ['auto', 'soft'].includes(src.busyReplyMode) ? src.busyReplyMode : 'soft';
  const runHistory = asArray(src.runHistory).map((item) => {
    const row = item && typeof item === 'object' ? item : {};
    const at = Number(row.at || row.timestamp || 0) || 0;
    if (!at) return null;
    return {
      at,
      dateKey: clip(row.dateKey || '', 20),
      slotKey: clip(row.slotKey || '', 80),
      blockId: clip(row.blockId || '', 80),
      triggerId: clip(row.triggerId || '', 80),
      status: ['ok', 'failed'].includes(row.status) ? row.status : 'failed',
      reason: clip(row.reason || '', 120),
      messageCount: Math.max(0, Math.min(20, Number(row.messageCount || 0) || 0)),
      generationAttempted: row.generationAttempted === true,
    };
  }).filter(Boolean).slice(0, 80);
  return {
    enabled: src.enabled === true,
    dailyCount: Math.max(0, Math.floor(Number(src.dailyCount ?? 1) || 0)),
    minGapMinutes: Math.max(0, Math.min(240, Math.floor(Number(src.minGapMinutes ?? 20) || 0))),
    busyReplyMode,
    lastRunDate: String(src.lastRunDate || '').trim(),
    triggeredKeys: asArray(src.triggeredKeys).map((x) => String(x || '').trim()).filter(Boolean).slice(0, 160),
    lastTriggeredAt: Number(src.lastTriggeredAt || 0) || 0,
    lastStatus: clip(src.lastStatus || '', 80),
    runningSlotKey: clip(src.runningSlotKey || '', 80),
    runningAt: Number(src.runningAt || 0) || 0,
    runHistory,
  };
}

export function getScheduleProactiveSettings(phone) {
  return normalizeScheduleProactiveSettings(phone?.scheduleProactiveSettings || {});
}

export async function saveScheduleProactiveSettings(userId, characterId, patch = {}) {
  const phone = await loadCharacterPhone(userId, characterId);
  const current = getScheduleProactiveSettings(phone);
  phone.scheduleProactiveSettings = normalizeScheduleProactiveSettings({ ...current, ...(patch || {}) });
  return saveCharacterPhone(phone);
}

export async function listCharacterPhonesForUser(userId) {
  const uid = encodeURIComponent(String(userId || '').trim() || 'guest');
  const prefix = `characterPhone_${uid}_`;
  const rows = await getAllRecords('settings');
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => String(row?.key || '').startsWith(prefix))
    .map((row) => row?.value)
    .filter((value) => value && typeof value === 'object');
}

export function minutesOfDayFromTimestamp(ts = Date.now(), timeZone = '') {
  const tzMinutes = minutesOfDayInTimezone(ts, timeZone);
  if (tzMinutes >= 0) return tzMinutes;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return 0;
  return d.getHours() * 60 + d.getMinutes();
}

export function dateKeyFromTimestamp(ts = Date.now(), timeZone = '') {
  const tzKey = dateKeyInTimezone(ts, timeZone);
  if (tzKey) return tzKey;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function parseClockMinutes(value = '') {
  const m = String(value || '').match(/(\d{1,2})[:：](\d{2})/);
  if (m) return Math.max(0, Math.min(1439, Number(m[1]) * 60 + Number(m[2])));
  return -1;
}

export function parseTimeRangeStartMinutes(range = '') {
  const parsed = parseClockMinutes(range);
  if (parsed >= 0) return parsed;
  if (/凌晨|深夜/.test(range)) return 30;
  if (/早|上午/.test(range)) return 8 * 60;
  if (/中午|午间/.test(range)) return 12 * 60;
  if (/下午/.test(range)) return 15 * 60;
  if (/傍晚|晚饭|晚上|夜间/.test(range)) return 19 * 60;
  return -1;
}

export function parseTimeRangeEndMinutes(range = '') {
  const matches = [...String(range || '').matchAll(/(\d{1,2})[:：](\d{2})/g)];
  if (matches.length >= 2) {
    const last = matches[matches.length - 1];
    return Math.max(0, Math.min(1439, Number(last[1]) * 60 + Number(last[2])));
  }
  const start = parseTimeRangeStartMinutes(range);
  return start >= 0 ? Math.min(1439, start + 90) : -1;
}

/**
 * 把时段内的钟点投影到“时段开始日”的连续分钟轴。
 * 例如 23:00-02:00 里的 01:00 应是 1500，而不是当天的 60。
 */
export function schedulePointMinuteForBlock(block = {}, point = {}) {
  const blockStart = parseTimeRangeStartMinutes(block?.timeRange);
  const blockEnd = parseTimeRangeEndMinutes(block?.timeRange);
  const crossesMidnight = blockStart >= 0 && blockEnd >= 0 && blockEnd < blockStart;
  const clock = parseClockMinutes(point?.at);
  if (clock >= 0) return crossesMidnight && clock < blockStart ? clock + 1440 : clock;
  if (Number.isFinite(Number(point?.offsetMinutes)) && blockStart >= 0) {
    return blockStart + Math.max(0, Number(point.offsetMinutes));
  }
  return -1;
}

/** 当前墙钟在同一条连续分钟轴上的位置。 */
export function scheduleTimelineMinuteAt(block = {}, timestamp = Date.now(), timeZone = '') {
  const blockStart = parseTimeRangeStartMinutes(block?.timeRange);
  const blockEnd = parseTimeRangeEndMinutes(block?.timeRange);
  const minutes = minutesOfDayFromTimestamp(timestamp, timeZone);
  const afterMidnightTail = blockStart >= 0
    && blockEnd >= 0
    && blockEnd < blockStart
    && minutes < blockEnd;
  return afterMidnightTail ? minutes + 1440 : minutes;
}

/** 已被改行程/取消等淘汰的时段，不应再当作「当前」命中。 */
export function isRetiredPlanBlock(block) {
  if (!block || typeof block !== 'object') return true;
  const status = String(block.status || 'planned');
  if (status === 'changed' || status === 'cancelled' || status === 'skipped') return true;
  return !!String(block.supersededBy || '').trim();
}

export function isPlanBlockActiveAt(block, timestamp = Date.now(), timeZone = '') {
  if (!block?.timeRange || isRetiredPlanBlock(block)) return false;
  const start = parseTimeRangeStartMinutes(block.timeRange);
  const end = parseTimeRangeEndMinutes(block.timeRange);
  if (start < 0 || end < 0) return false;
  const minutes = minutesOfDayFromTimestamp(timestamp, timeZone);
  if (end < start) return minutes >= start || minutes < end;
  return minutes >= start && minutes < end;
}

export function pickCurrentPlanBlock(plan, timestamp = Date.now(), timeZone = '') {
  const blocks = asArray(plan?.blocks).filter((block) => !isRetiredPlanBlock(block));
  if (!blocks.length) return null;
  const minutes = minutesOfDayFromTimestamp(timestamp, timeZone);
  const scored = blocks
    .map((block, idx) => ({
      block,
      idx,
      start: parseTimeRangeStartMinutes(block?.timeRange),
      end: parseTimeRangeEndMinutes(block?.timeRange),
    }))
    .filter((item) => item.start >= 0)
    .sort((a, b) => a.start - b.start);
  if (!scored.length) return null;
  const inRange = scored.find((item) => {
    if (item.end < item.start) return minutes >= item.start || minutes < item.end;
    return minutes >= item.start && minutes < item.end;
  });
  if (inRange) return inRange.block;
  // 凌晨位于日历日开头；如果当天最早的块尚未开始，不能把 01:00 之类的空档
  // 回退到 09:00 的白天外出。跨午夜块已在上面的 inRange 分支命中，这里只处理真空档。
  if (minutes < 6 * 60 && scored.every((item) => item.start > minutes)) return null;
  let current = scored[0];
  for (const item of scored) {
    if (item.start <= minutes) current = item;
  }
  return current.block;
}

function shiftDateKey(dateKey, days = 0) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey || '').trim());
  if (!match) return '';
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  date.setUTCDate(date.getUTCDate() + Number(days || 0));
  return date.toISOString().slice(0, 10);
}

function pickAnchoredActivePlanBlock(plan, timestamp, timeZone, mode = 'current') {
  const minutes = minutesOfDayFromTimestamp(timestamp, timeZone);
  const candidates = asArray(plan?.blocks)
    .filter((block) => !isRetiredPlanBlock(block))
    .map((block, index) => ({
      block,
      index,
      start: parseTimeRangeStartMinutes(block?.timeRange),
      end: parseTimeRangeEndMinutes(block?.timeRange),
    }))
    .filter((item) => item.start >= 0 && item.end >= 0)
    .filter((item) => {
      if (item.end < item.start) {
        // 日程块锚定在 plan.dateKey 的开始日：当天只认跨午夜块的前半段，
        // 次日凌晨的后半段必须从前一天计划承接，不能误命中今天晚上尚未开始的同名块。
        return mode === 'previous-tail'
          ? minutes < item.end
          : minutes >= item.start;
      }
      return mode === 'current' && minutes >= item.start && minutes < item.end;
    })
    .sort((a, b) => a.start - b.start || a.index - b.index);
  return candidates[0]?.block || null;
}

/**
 * 解析真正覆盖当前时刻的日程块。跨午夜块属于其开始日；零点后的尾段从昨天计划承接。
 * 当前日若明确安排了一个正在进行的普通时段，优先采用当前日计划，以允许临时改期覆盖昨夜安排。
 */
export function resolveActiveDailyLifePlanBlock(phone, timestamp = Date.now(), timeZone = '') {
  const dateKey = dateKeyFromTimestamp(timestamp, timeZone);
  const plan = getDailyLifePlanForDate(phone, dateKey);
  const currentBlock = pickAnchoredActivePlanBlock(plan, timestamp, timeZone, 'current');
  if (currentBlock) {
    return { dateKey, plan, block: currentBlock, carriedFromPreviousDate: false };
  }

  const previousDateKey = shiftDateKey(dateKey, -1);
  const previousPlan = getDailyLifePlanForDate(phone, previousDateKey);
  const previousBlock = pickAnchoredActivePlanBlock(
    previousPlan,
    timestamp,
    timeZone,
    'previous-tail',
  );
  if (previousBlock) {
    return {
      dateKey: previousDateKey,
      plan: previousPlan,
      block: previousBlock,
      carriedFromPreviousDate: true,
    };
  }
  return { dateKey, plan, block: null, carriedFromPreviousDate: false };
}

/**
 * 判断这个时间点角色是否在真正睡觉——只看覆盖当前时刻的日程骨架里 isSleep=true 的那一段，
 * 不做时间猜测；没有日程数据（还没生成/生成失败）时按凌晨 2~6 点兜底，避免完全没有下限。
 * 主动打扰类功能（分享冲动等）用这个来判断"要不要避开"，不是用来判断能不能聊天。
 * 若聊天启用了时差，按角色当地钟点命中（与顶栏「TA 当地」一致）。
 */
export async function isCharacterAsleepAt(userId, characterId, timestamp = Date.now()) {
  const timeZone = await resolveCharacterScheduleTimezone(userId, characterId).catch(() => '');
  try {
    const phone = await loadCharacterPhone(userId, characterId);
    const { block } = resolveActiveDailyLifePlanBlock(phone, timestamp, timeZone);
    if (block) return block.isSleep === true;
  } catch (_) {
    // 拿不到日程数据时落到下面的兜底
  }
  const minutes = minutesOfDayFromTimestamp(timestamp, timeZone);
  const hour = Math.floor(minutes / 60);
  return hour >= 2 && hour < 6;
}

export function pickCurrentFlowStep(block, timestamp = Date.now(), timeZone = '') {
  const steps = asArray(block?.flowSteps);
  if (!steps.length) return null;
  const minutes = scheduleTimelineMinuteAt(block, timestamp, timeZone);
  const scored = steps.map((step, index) => ({
    step,
    index,
    start: schedulePointMinuteForBlock(block, step),
  })).filter((item) => item.start >= 0).sort((a, b) => a.start - b.start);
  if (!scored.length) return steps[0];
  let current = scored[0];
  for (const item of scored) {
    if (item.start <= minutes) current = item;
  }
  return current.step;
}

export function pickCurrentTriggerWindow(block, timestamp = Date.now(), timeZone = '') {
  const windows = asArray(block?.triggerWindows).filter((item) => item && item.used !== true);
  if (!windows.length) return null;
  const minutes = scheduleTimelineMinuteAt(block, timestamp, timeZone);
  const scored = windows.map((item, index) => ({
    item,
    index,
    start: schedulePointMinuteForBlock(block, item),
  })).filter((item) => item.start >= 0).sort((a, b) => a.start - b.start);
  if (!scored.length) return null;
  let current = null;
  for (const item of scored) {
    if (item.start <= minutes) current = item;
  }
  return current ? current.item : null;
}

export function markTriggerWindowUsed(phone, {
  dateKey,
  blockId,
  triggerId,
  usedAt = Date.now(),
  wallUpdatedAt = Date.now(),
} = {}) {
  const dk = String(dateKey || '').trim();
  const bid = String(blockId || '').trim();
  const tid = String(triggerId || '').trim();
  if (!dk || !bid || !tid) return phone;
  const mutationAt = normalizeMutationUpdatedAt(wallUpdatedAt) || Date.now();
  return {
    ...phone,
    dailyLifePlans: asArray(phone?.dailyLifePlans).map((plan) => {
      if (String(plan?.dateKey || '') !== dk) return plan;
      const targetBlock = asArray(plan.blocks)
        .find((block) => String(block?.id || '') === bid);
      const targetTrigger = asArray(targetBlock?.triggerWindows)
        .find((item) => String(item?.id || '') === tid);
      if (!targetTrigger || targetTrigger.used === true) return plan;
      const planRevision = normalizePlanRevision(plan.planRevision) + 1;
      return {
        ...plan,
        updatedAt: mutationAt,
        planRevision,
        blocks: asArray(plan.blocks).map((block) => {
          if (String(block?.id || '') !== bid) return block;
          return {
            ...block,
            triggerWindows: asArray(block.triggerWindows).map((item) => (
              String(item?.id || '') === tid
                ? {
                  ...item,
                  used: true,
                  // usedAt 跟日程/故事时间走；updatedAt 才是与 presence freshness
                  // 比较的设备墙钟，两个时钟域不能互相代用。
                  usedAt,
                  updatedAt: mutationAt,
                  planRevision,
                }
                : item
            )),
          };
        }),
      };
    }),
  };
}
