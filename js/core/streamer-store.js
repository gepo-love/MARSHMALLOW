import * as db from './db.js';
import { getStreamerPopularityTierById, getStreamerCategoryById, getStreamerImageSyncTierById, getStreamerIdleIntervalTierById } from '../data/streamer-presets.js';
import { getNowForUser } from './time-mode.js';
import { removeStreamerLineVoice } from './voice-tools.js';

const CHANNEL_STORE = 'streamerChannels';
const FAN_STORE = 'streamerFanState';
const LEDGER_STORE = 'streamerLedger';
const RECORDING_STORE = 'streamerRecordings';

const MAX_DANMAKU_BUFFER = 60;
const MAX_LINE_BUFFER = 30;
const MAX_RECORDINGS_PER_CHANNEL = 12;

function clean(value = '') {
  return String(value ?? '').trim();
}

function genId(prefix = 'sc') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** @typedef {{handle:string, avatar:string, avatarCover:string, popularityTier:string, category:string, categoryLabel:string, streamReason:string, worldSetting:string, personality:string, speechStyle:string, signature:string, voiceEnabled:boolean, voiceId:string, imageSyncTier:string, aliasFromCharacter:boolean, idleAutoPlay:boolean, imageGenForceOn:boolean, imageGenMode:string, imageStyleId:string, imageLockEnabled:boolean}} StreamerPersona */

const IMAGE_GEN_MODE_CHOICES = new Set(['', 'novelai', 'realistic', 'smart']);

export function normalizeStreamerPersona(raw = {}) {
  const category = clean(raw.category) || 'chat';
  const categoryLabel = clean(raw.categoryLabel) || getStreamerCategoryById(category).label;
  const popularityTier = clean(raw.popularityTier) || 'small';
  const imageSyncTier = getStreamerImageSyncTierById(raw.imageSyncTier).id;
  const imageGenMode = IMAGE_GEN_MODE_CHOICES.has(clean(raw.imageGenMode)) ? clean(raw.imageGenMode) : '';
  const idleIntervalId = getStreamerIdleIntervalTierById(raw.idleIntervalId)?.id || '';
  return {
    handle: clean(raw.handle).slice(0, 24) || '匿名主播',
    // avatar：马甲头像（聊天/头像位单独用），不填时各处回退到 avatarCover
    avatar: clean(raw.avatar),
    avatarCover: clean(raw.avatarCover),
    popularityTier,
    category,
    categoryLabel,
    streamReason: clean(raw.streamReason).slice(0, 200),
    worldSetting: clean(raw.worldSetting).slice(0, 400),
    personality: clean(raw.personality).slice(0, 200),
    speechStyle: clean(raw.speechStyle).slice(0, 160),
    signature: clean(raw.signature).slice(0, 120),
    voiceEnabled: raw.voiceEnabled === true,
    voiceId: clean(raw.voiceId).slice(0, 80),
    imageSyncTier,
    aliasFromCharacter: raw.aliasFromCharacter === true,
    idleAutoPlay: raw.idleAutoPlay === true,
    // 挂机自动推进间隔：空字符串 = 跟随人气档位默认值
    idleIntervalId,
    imageGenForceOn: raw.imageGenForceOn === true,
    imageGenMode,
    // 直播间局内画风（image-style-presets.js 预设 id；空 = 跟随角色/全局），有效性在使用处校验
    imageStyleId: clean(raw.imageStyleId).slice(0, 40),
    // 无通讯录角色可依托的 AI 现捏人格：首次生图成功后落一个固定 seed，让后续换画面尽量保持同一个人/同一种风格
    imageLockSeed: Number.isFinite(Number(raw.imageLockSeed)) && Number(raw.imageLockSeed) > 0 ? Math.floor(Number(raw.imageLockSeed)) : 0,
    // 随机主播默认锁脸；用户可以显式关闭，关闭后每轮画面不再复用 seed/头像参考。
    imageLockEnabled: raw.imageLockEnabled !== false,
  };
}

export function normalizeStreamerChannel(raw = {}) {
  const now = Date.now();
  return {
    id: clean(raw.id) || genId('streamer'),
    userId: clean(raw.userId),
    sourceType: raw.sourceType === 'character' ? 'character' : 'generated',
    characterId: raw.sourceType === 'character' ? clean(raw.characterId) : '',
    persona: normalizeStreamerPersona(raw.persona || {}),
    memoryMode: 'room_only',
    ephemeral: raw.ephemeral === true,
    status: raw.status === 'ended' ? 'ended' : 'live',
    currentSceneImage: clean(raw.currentSceneImage),
    recentDanmaku: Array.isArray(raw.recentDanmaku) ? raw.recentDanmaku.slice(0, MAX_DANMAKU_BUFFER) : [],
    streamerLines: Array.isArray(raw.streamerLines) ? raw.streamerLines.slice(0, MAX_LINE_BUFFER) : [],
    viewerCount: Number.isFinite(Number(raw.viewerCount)) ? Math.max(1, Number(raw.viewerCount)) : null,
    createdAt: Number(raw.createdAt) || now,
    updatedAt: Number(raw.updatedAt) || now,
    lastVisitAt: Number(raw.lastVisitAt) || 0,
    sessionStartedAt: Number(raw.sessionStartedAt) || Number(raw.createdAt) || now,
    personaActorId: clean(raw.personaActorId),
  };
}

/** @typedef {{id:string, channelId:string, userId:string, handle:string, categoryLabel:string, coverImage:string, startedAt:number, endedAt:number, streamerLines:Array, recentDanmaku:Array, sourceType:string, characterId:string, voiceEnabled:boolean, voiceId:string}} StreamerRecording */

export function normalizeStreamerRecording(raw = {}) {
  const now = Date.now();
  return {
    id: clean(raw.id) || genId('rec'),
    channelId: clean(raw.channelId),
    userId: clean(raw.userId),
    handle: clean(raw.handle).slice(0, 24) || '匿名主播',
    categoryLabel: clean(raw.categoryLabel).slice(0, 40),
    coverImage: clean(raw.coverImage),
    startedAt: Number(raw.startedAt) || now,
    endedAt: Number(raw.endedAt) || now,
    streamerLines: Array.isArray(raw.streamerLines) ? raw.streamerLines.slice(0, MAX_LINE_BUFFER) : [],
    recentDanmaku: Array.isArray(raw.recentDanmaku) ? raw.recentDanmaku.slice(0, MAX_DANMAKU_BUFFER) : [],
    sourceType: raw.sourceType === 'character' ? 'character' : 'generated',
    characterId: clean(raw.characterId),
    voiceEnabled: raw.voiceEnabled === true,
    voiceId: clean(raw.voiceId).slice(0, 80),
  };
}

export async function createStreamerChannel(userId, payload = {}) {
  const channel = normalizeStreamerChannel({ ...payload, userId: clean(userId) });
  await db.putRecord(CHANNEL_STORE, channel);
  return channel;
}

export async function getStreamerChannel(id) {
  if (!clean(id)) return null;
  const row = await db.getRecord(CHANNEL_STORE, id);
  return row ? normalizeStreamerChannel(row) : null;
}

export async function saveStreamerChannel(channel) {
  const next = normalizeStreamerChannel({ ...channel, updatedAt: Date.now() });
  await db.putRecord(CHANNEL_STORE, next);
  return next;
}

export async function deleteStreamerChannel(id) {
  const channelId = clean(id);
  if (!channelId) return { deleted: false };
  const existing = await getStreamerChannel(id).catch(() => null);
  if (!existing) return { deleted: false };
  if (existing?.streamerLines?.length) await cleanupStreamerLineVoices(id, existing.streamerLines);
  const { deleteChatWithData, listChatsForUser } = await import('./chat-store.js');
  const chats = await listChatsForUser(existing.userId).catch(() => []);
  let deletedChats = 0;
  for (const chat of chats) {
    if (clean(chat?.metadata?.streamerChannelId) !== channelId) continue;
    await deleteChatWithData(chat.id, existing.userId);
    deletedChats += 1;
  }
  await db.deleteRecord(CHANNEL_STORE, channelId);
  const states = await listFanStatesForUser(null, id).catch(() => []);
  for (const s of states) await db.deleteRecord(FAN_STORE, s.id).catch(() => {});
  const recordings = await listStreamerRecordings(id).catch(() => []);
  for (const r of recordings) await db.deleteRecord(RECORDING_STORE, r.id).catch(() => {});
  if (existing.sourceType === 'generated' && existing.personaActorId) {
    const remaining = await db.getAllRecords(CHANNEL_STORE).catch(() => []);
    const actorStillUsed = remaining.some((row) => clean(row?.personaActorId) === existing.personaActorId);
    if (!actorStillUsed) {
      const { deleteCharacterCascade } = await import('./data-hygiene.js');
      await deleteCharacterCascade(existing.personaActorId);
    }
  }
  return { deleted: true, deletedChats, deletedRecordings: recordings.length };
}

export async function listStreamerChannelsForUser(userId) {
  const uid = clean(userId);
  const rows = await db.getAllByIndex(CHANNEL_STORE, 'userId', uid).catch(async () => {
    const all = await db.getAllRecords(CHANNEL_STORE);
    return all.filter((r) => clean(r.userId) === uid);
  });
  return rows.map(normalizeStreamerChannel).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

/** 首页信息流采样：char 频道优先，混入少量 generated 频道 */
export function sampleStreamerFeed(channels = [], limit = 24) {
  const list = Array.isArray(channels) ? channels : [];
  const charChannels = list.filter((c) => c.sourceType === 'character');
  const genChannels = list.filter((c) => c.sourceType === 'generated');
  const ordered = [];
  let ci = 0;
  let gi = 0;
  while (ordered.length < limit && (ci < charChannels.length || gi < genChannels.length)) {
    if (ci < charChannels.length) {
      ordered.push(charChannels[ci]);
      ci += 1;
    }
    if (ordered.length >= limit) break;
    if (gi < genChannels.length && (ordered.length % 3 === 2 || ci >= charChannels.length)) {
      ordered.push(genChannels[gi]);
      gi += 1;
    }
  }
  return ordered.slice(0, limit);
}

export async function appendStreamerRoomBatch(channelId, {
  streamerLine = '',
  translation = '',
  speechPlan = null,
  danmaku = [],
} = {}) {
  const channel = await getStreamerChannel(channelId);
  if (!channel) throw new Error('直播间不存在');
  const now = await getNowForUser(channel.userId).catch(() => Date.now());
  const lines = Array.isArray(danmaku) ? danmaku : [];
  channel.recentDanmaku = [
    ...lines.map((row, idx) => {
      const text = clean(row.text).slice(0, 60);
      const zh = clean(row.translation || row.zh).slice(0, 120);
      return {
        id: genId('dm'),
        from: clean(row.from) || '路人',
        text,
        ...(zh && zh !== text ? { translation: zh } : {}),
        ts: now + idx,
      };
    }).filter((row) => row.text),
    ...channel.recentDanmaku,
  ].slice(0, MAX_DANMAKU_BUFFER);
  const lineText = clean(streamerLine);
  const lineZh = clean(translation).slice(0, 200);
  if (lineText) {
    const nextLines = [
      {
        id: genId('sl'),
        text: lineText.slice(0, 200),
        ...(lineZh && lineZh !== lineText ? { translation: lineZh } : {}),
        ...(speechPlan && typeof speechPlan === 'object' ? { speechPlan } : {}),
        ts: now,
      },
      ...channel.streamerLines,
    ];
    const dropped = nextLines.slice(MAX_LINE_BUFFER);
    channel.streamerLines = nextLines.slice(0, MAX_LINE_BUFFER);
    // 台词滚出本地缓冲区后，专属语音缓存也一起清掉，避免无限堆积
    if (dropped.length) {
      Promise.all(dropped.map((row) => removeStreamerLineVoice(channel.id, row.id))).catch(() => {});
    }
  }
  channel.updatedAt = now;
  return saveStreamerChannel(channel);
}

/** 清掉本地缓冲区里这一批台词各自的专属语音缓存（下播清空缓冲区/删除频道时用） */
async function cleanupStreamerLineVoices(channelId, lines = []) {
  await Promise.all((lines || []).map((row) => removeStreamerLineVoice(channelId, row.id))).catch(() => {});
}

/** 下播：把这一场的台词/弹幕存成一条「录屏」归档到主播空间，直播间缓冲区清空，状态转为已下播 */
export async function endStreamerSession(channelId) {
  const channel = await getStreamerChannel(channelId);
  if (!channel) throw new Error('直播间不存在');
  if (channel.streamerLines.length || channel.recentDanmaku.length) {
    const recording = normalizeStreamerRecording({
      channelId: channel.id,
      userId: channel.userId,
      handle: channel.persona?.handle,
      categoryLabel: channel.persona?.categoryLabel,
      coverImage: channel.currentSceneImage || channel.persona?.avatarCover,
      startedAt: channel.sessionStartedAt,
      endedAt: await getNowForUser(channel.userId).catch(() => Date.now()),
      streamerLines: channel.streamerLines,
      recentDanmaku: channel.recentDanmaku,
      sourceType: channel.sourceType,
      characterId: channel.characterId,
      voiceEnabled: channel.persona?.voiceEnabled,
      voiceId: channel.persona?.voiceId,
    });
    await db.putRecord(RECORDING_STORE, recording);
    const rows = await listStreamerRecordings(channel.id);
    const overflow = rows.slice(MAX_RECORDINGS_PER_CHANNEL);
    for (const row of overflow) await db.deleteRecord(RECORDING_STORE, row.id).catch(() => {});
  }
  await cleanupStreamerLineVoices(channel.id, channel.streamerLines);
  channel.status = 'ended';
  channel.streamerLines = [];
  channel.recentDanmaku = [];
  return saveStreamerChannel(channel);
}

/** （重新）开播：清空缓冲区、重记这一场的开始时间，转为直播中 */
export async function startStreamerSession(channelId) {
  const channel = await getStreamerChannel(channelId);
  if (!channel) throw new Error('直播间不存在');
  channel.status = 'live';
  channel.streamerLines = [];
  channel.recentDanmaku = [];
  channel.sessionStartedAt = await getNowForUser(channel.userId).catch(() => Date.now());
  return saveStreamerChannel(channel);
}

export async function listStreamerRecordings(channelId) {
  const cid = clean(channelId);
  if (!cid) return [];
  const rows = await db.getAllByIndex(RECORDING_STORE, 'channelId', cid).catch(async () => {
    const all = await db.getAllRecords(RECORDING_STORE);
    return all.filter((r) => clean(r.channelId) === cid);
  });
  return rows.map(normalizeStreamerRecording).sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0));
}

export async function getStreamerRecording(id) {
  if (!clean(id)) return null;
  const row = await db.getRecord(RECORDING_STORE, id);
  return row ? normalizeStreamerRecording(row) : null;
}

export async function updateStreamerSceneImage(channelId, url = '') {
  const channel = await getStreamerChannel(channelId);
  if (!channel) throw new Error('直播间不存在');
  channel.currentSceneImage = clean(url);
  return saveStreamerChannel(channel);
}

export async function appendStreamerUserMessage(channelId, text = '') {
  const channel = await getStreamerChannel(channelId);
  if (!channel) throw new Error('直播间不存在');
  const now = await getNowForUser(channel.userId).catch(() => Date.now());
  channel.recentDanmaku = [
    { id: genId('dm'), from: '我', fromUser: true, text: clean(text).slice(0, 60), ts: now },
    ...channel.recentDanmaku,
  ].slice(0, MAX_DANMAKU_BUFFER);
  channel.updatedAt = now;
  return saveStreamerChannel(channel);
}

function normalizeFanState(raw = {}) {
  return {
    id: clean(raw.id) || genId('fan'),
    userId: clean(raw.userId),
    channelId: clean(raw.channelId),
    giftPointsSpent: Number(raw.giftPointsSpent) || 0,
    fanLevel: Number(raw.fanLevel) || 0,
    isTopFan: raw.isTopFan === true,
    unlockedPrivateChat: raw.unlockedPrivateChat === true,
    lastVisitAt: Number(raw.lastVisitAt) || Date.now(),
  };
}

export async function getFanState(userId, channelId) {
  const uid = clean(userId);
  const cid = clean(channelId);
  const all = await db.getAllRecords(FAN_STORE);
  const row = all.find((r) => clean(r.userId) === uid && clean(r.channelId) === cid);
  return row ? normalizeFanState(row) : null;
}

export async function touchFanState(userId, channelId) {
  const existing = await getFanState(userId, channelId);
  const next = normalizeFanState(existing || { userId, channelId });
  next.lastVisitAt = Date.now();
  await db.putRecord(FAN_STORE, next);
  return next;
}

export async function listFanStatesForUser(userId, channelId = null) {
  const all = await db.getAllRecords(FAN_STORE);
  return all
    .filter((r) => (userId == null || clean(r.userId) === clean(userId)) && (channelId == null || clean(r.channelId) === clean(channelId)))
    .map(normalizeFanState);
}

export { getStreamerPopularityTierById, getStreamerCategoryById, getStreamerImageSyncTierById, getStreamerIdleIntervalTierById };
