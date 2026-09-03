import * as db from './db.js';
import {
  findPrivateChat,
  listChatsForUser,
  listMessagesForChat,
  recalcChatPreview,
  saveChat,
  saveMessages,
} from './chat-store.js';
import { loadCharacterPhone, saveCharacterPhone } from './character-phone-store.js';
import {
  getOfflineDateArchive,
  listOfflineDateArchives,
  restoreOfflineDateArchive,
} from './offline-date-archive.js';
import {
  getVoiceCachedAudio,
  deleteVoiceCachedAudio,
  restoreVoiceCachedAudio,
} from './voice-tools.js';
import { createTextZipBlob } from './zip-store-stream.js';
import { downloadBlob, describeDownloadResult } from './native-download.js';
import { readJsonEntriesFromZip } from './regex-zip-import.js';
import { saveCharacter } from './character-store.js';
import { isActiveWeiboPost } from './weibo/weibo-post-store.js';

export const CHARACTER_TIME_CAPSULE_FORMAT = 'marshmallow-character-time-capsule';
export const CHARACTER_TIME_CAPSULE_VERSION = 1;

const encoder = new TextEncoder();
const DATA_URL_RE = /^data:([^;,]+)?(?:;[^,]*)?,/i;
const OMITTED_MEDIA_RE = /^\[(?:图片|音频|视频|媒体).*轻量档案省略\]$/;
const MAX_IMPORT_FILE_BYTES = 512 * 1024 * 1024;

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeName(value = 'character') {
  return String(value || 'character')
    .trim()
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/\s+/g, '-')
    .slice(0, 48) || 'character';
}

function timestampForFile(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

export function characterTimeCapsuleFilename(characterName = '', mode = 'light', date = new Date()) {
  const suffix = mode === 'complete' ? '完整' : '轻量';
  return `棉花糖机-${safeName(characterName)}-时光档案-${suffix}-${timestampForFile(date)}.zip`;
}

function dataUrlBytes(value = '') {
  const text = String(value || '');
  const comma = text.indexOf(',');
  if (comma < 0) return encoder.encode(text).length;
  const header = text.slice(0, comma);
  const body = text.slice(comma + 1);
  if (/;base64/i.test(header)) {
    const padding = body.endsWith('==') ? 2 : (body.endsWith('=') ? 1 : 0);
    return Math.max(0, Math.floor(body.length * 3 / 4) - padding);
  }
  try {
    return encoder.encode(decodeURIComponent(body)).length;
  } catch (_) {
    return encoder.encode(body).length;
  }
}

function mediaKind(value = '') {
  const match = String(value || '').match(DATA_URL_RE);
  const mime = String(match?.[1] || '').toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  return match ? 'otherMedia' : '';
}

function createUsage() {
  return {
    textBytes: 0,
    imageBytes: 0,
    audioBytes: 0,
    videoBytes: 0,
    otherBytes: 0,
    imageCount: 0,
    audioCount: 0,
    videoCount: 0,
  };
}

function addValueUsage(value, usage, seen = new WeakSet()) {
  if (value == null) return;
  if (typeof value === 'string') {
    const kind = mediaKind(value);
    if (kind) {
      const bytes = dataUrlBytes(value);
      if (kind === 'image') {
        usage.imageBytes += bytes;
        usage.imageCount += 1;
      } else if (kind === 'audio') {
        usage.audioBytes += bytes;
        usage.audioCount += 1;
      } else if (kind === 'video') {
        usage.videoBytes += bytes;
        usage.videoCount += 1;
      } else {
        usage.otherBytes += bytes;
      }
      return;
    }
    usage.textBytes += encoder.encode(value).length;
    return;
  }
  if (value instanceof Blob) {
    const type = String(value.type || '').toLowerCase();
    if (type.startsWith('image/')) {
      usage.imageBytes += value.size;
      usage.imageCount += 1;
    } else if (type.startsWith('audio/')) {
      usage.audioBytes += value.size;
      usage.audioCount += 1;
    } else if (type.startsWith('video/')) {
      usage.videoBytes += value.size;
      usage.videoCount += 1;
    } else {
      usage.otherBytes += value.size;
    }
    return;
  }
  if (typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item) => addValueUsage(item, usage, seen));
    return;
  }
  Object.entries(value).forEach(([key, item]) => {
    usage.textBytes += encoder.encode(key).length;
    addValueUsage(item, usage, seen);
  });
}

function collectCacheKeys(value, out = new Set(), seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return out;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item) => collectCacheKeys(item, out, seen));
    return out;
  }
  Object.entries(value).forEach(([key, item]) => {
    if (/cacheKey$/i.test(key) && typeof item === 'string' && item.trim()) out.add(item.trim());
    else collectCacheKeys(item, out, seen);
  });
  return out;
}

function rowMentionsCharacter(row, characterId, relatedChatIds) {
  if (!row || typeof row !== 'object') return false;
  const cid = String(characterId || '');
  if (String(row.characterId || '') === cid || String(row.subjectId || '') === cid) return true;
  if (relatedChatIds.has(String(row.chatId || ''))) return true;
  const idLists = [row.characterIds, row.participantIds, row.knownBy, row.involvedCharacters];
  if (idLists.some((list) => safeArray(list).map(String).includes(cid))) return true;
  return safeArray(row.involvedChats).some((chatId) => relatedChatIds.has(String(chatId || '')));
}

async function collectMemoryData(userId, characterId, relatedChatIds) {
  const [memories, facts, events, shared] = await Promise.all([
    db.getAllByIndex('memories', 'userId', userId).catch(() => []),
    db.getAllByIndex('memoryFacts', 'userId', userId).catch(() => []),
    db.getAllByIndex('eventMemories', 'userId', userId).catch(() => []),
    db.getAllByIndex('sharedEventKnowledge', 'userId', userId).catch(() => []),
  ]);
  return {
    memories: safeArray(memories).filter((row) => rowMentionsCharacter(row, characterId, relatedChatIds)),
    memoryFacts: safeArray(facts).filter((row) => rowMentionsCharacter(row, characterId, relatedChatIds)),
    eventMemories: safeArray(events).filter((row) => rowMentionsCharacter(row, characterId, relatedChatIds)),
    sharedEventKnowledge: safeArray(shared).filter((row) => rowMentionsCharacter(row, characterId, relatedChatIds)),
  };
}

async function collectSocialData(userId, characterId) {
  const [moments, weibo, forum] = await Promise.all([
    db.getAllByIndex('momentsPosts', 'userId', userId).catch(() => []),
    db.getAllByIndex('weiboPosts', 'authorId', characterId).catch(() => []),
    db.getAllByIndex('forumThreads', 'userId', userId).catch(() => []),
  ]);
  const cid = String(characterId || '');
  return {
    momentsPosts: safeArray(moments).filter((row) => (
      String(row?.authorId || '') === cid
      || String(row?.targetCharacterId || '') === cid
      || safeArray(row?.characterIds).map(String).includes(cid)
    )),
    weiboPosts: safeArray(weibo).filter(isActiveWeiboPost),
    forumThreads: safeArray(forum).filter((row) => JSON.stringify(row).includes(cid)),
  };
}

async function collectCharacterData(userId, characterId) {
  const character = await db.getRecord('characters', characterId);
  if (!character) throw new Error('找不到该角色');
  const allChats = await listChatsForUser(userId);
  const chats = safeArray(allChats).filter((chat) => safeArray(chat?.participants).map(String).includes(String(characterId)));
  const messagesByChat = {};
  for (const chat of chats) {
    messagesByChat[chat.id] = await listMessagesForChat(chat.id, 0);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  const relatedChatIds = new Set(chats.map((chat) => String(chat.id || '')).filter(Boolean));
  const [memory, phone, offlineRaw, social, collectibles, auStories] = await Promise.all([
    collectMemoryData(userId, characterId, relatedChatIds),
    loadCharacterPhone(userId, characterId).catch(() => null),
    listOfflineDateArchives(userId, { characterId }).catch(() => []),
    collectSocialData(userId, characterId),
    db.getAllByIndex('collectibles', 'characterId', characterId).catch(() => []),
    db.getAllByIndex('auStories', 'characterId', characterId).catch(() => []),
  ]);
  const offlineArchives = [];
  for (const archive of offlineRaw) {
    offlineArchives.push(await getOfflineDateArchive(userId, archive.id).catch(() => archive));
  }
  return {
    character,
    chats,
    messagesByChat,
    memory,
    phone,
    offlineArchives,
    social,
    collectibles: safeArray(collectibles).filter((row) => !row?.userId || String(row.userId) === String(userId)),
    auStories: safeArray(auStories).filter((row) => !row?.userId || String(row.userId) === String(userId)),
  };
}

async function loadReferencedVoiceCache(messagesByChat) {
  const keys = new Set();
  Object.values(messagesByChat).forEach((messages) => safeArray(messages).forEach((message) => collectCacheKeys(message, keys)));
  const entries = [];
  for (const key of keys) {
    const payload = await getVoiceCachedAudio(key).catch(() => null);
    if (payload) entries.push({ key, payload });
  }
  return { keys: [...keys], entries };
}

export async function inspectCharacterTimeCapsule({ userId = '', characterId = '' } = {}) {
  const uid = String(userId || '').trim();
  const cid = String(characterId || '').trim();
  if (!uid || !cid) throw new Error('缺少角色档案范围');
  const data = await collectCharacterData(uid, cid);
  const usage = createUsage();
  addValueUsage(data, usage);
  const voice = await loadReferencedVoiceCache(data.messagesByChat);
  const cachedAudioBytes = voice.entries.reduce((sum, entry) => (
    sum + Number(entry?.payload?.audioBlob?.size || entry?.payload?.bytes || 0)
  ), 0);
  const messageCount = Object.values(data.messagesByChat).reduce((sum, rows) => sum + safeArray(rows).length, 0);
  return {
    data,
    voice,
    usage: {
      ...usage,
      cachedAudioBytes,
      totalBytes: usage.textBytes + usage.imageBytes + usage.audioBytes + usage.videoBytes + usage.otherBytes + cachedAudioBytes,
    },
    counts: {
      chats: data.chats.length,
      messages: messageCount,
      memories: Object.values(data.memory).reduce((sum, rows) => sum + safeArray(rows).length, 0),
      offlineArchives: data.offlineArchives.length,
      voiceCaches: voice.entries.length,
    },
  };
}

function stripHeavyMedia(value, seen = new WeakMap()) {
  if (value == null) return value;
  if (typeof value === 'string') {
    const kind = mediaKind(value);
    return kind ? `[${kind === 'image' ? '图片' : kind === 'audio' ? '音频' : kind === 'video' ? '视频' : '媒体'}已从轻量档案省略]` : value;
  }
  if (value instanceof Blob) return `[${value.type || '媒体'} Blob 已从轻量档案省略]`;
  if (typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);
  const out = Array.isArray(value) ? [] : {};
  seen.set(value, out);
  if (Array.isArray(value)) value.forEach((item) => out.push(stripHeavyMedia(item, seen)));
  else Object.entries(value).forEach(([key, item]) => { out[key] = stripHeavyMedia(item, seen); });
  return out;
}

function jsonEntry(name, value) {
  return { name, text: JSON.stringify(value, null, 2) };
}

export async function exportCharacterTimeCapsule({
  userId = '',
  characterId = '',
  mode = 'light',
  inspected = null,
  filename = '',
  webSaveTarget = null,
} = {}) {
  const complete = mode === 'complete';
  const snapshot = inspected || await inspectCharacterTimeCapsule({ userId, characterId });
  const source = complete ? snapshot.data : stripHeavyMedia(snapshot.data);
  const exportedAt = new Date().toISOString();
  const manifest = {
    format: CHARACTER_TIME_CAPSULE_FORMAT,
    version: CHARACTER_TIME_CAPSULE_VERSION,
    mode: complete ? 'complete' : 'light',
    exportedAt,
    userId: String(userId || ''),
    characterId: String(characterId || ''),
    characterName: String(snapshot.data.character?.name || snapshot.data.character?.customNickname || ''),
    counts: snapshot.counts,
    usage: snapshot.usage,
    preserves: ['message-id', 'timestamp', 'reply-references', 'chat-boundaries'],
    mediaIncluded: complete,
  };
  const entries = [
    { name: 'README.txt', text: '棉花糖机角色时光档案\n\n轻量档案保留文字、时间、消息 ID 与引用关系；完整档案同时保留记录中已有的媒体与可用语音缓存。请勿手动改名或拆散文件后再导入。' },
    jsonEntry('manifest.json', manifest),
    jsonEntry('character.json', source.character),
    jsonEntry('chats.json', source.chats),
    jsonEntry('memory.json', source.memory),
    jsonEntry('character-phone.json', source.phone),
    jsonEntry('offline-archives.json', source.offlineArchives),
    jsonEntry('social.json', source.social),
    jsonEntry('collectibles.json', source.collectibles),
    jsonEntry('au-stories.json', source.auStories),
  ];
  for (const [index, chat] of source.chats.entries()) {
    const rows = source.messagesByChat[chat.id] || [];
    entries.push(jsonEntry(`messages/${String(index + 1).padStart(3, '0')}-${safeName(chat.id)}.json`, rows));
  }
  if (complete) entries.push(jsonEntry('voice-cache.json', snapshot.voice.entries));
  const packed = await createTextZipBlob(entries, { compress: true });
  const blob = packed.blob;
  const resolvedFilename = filename || characterTimeCapsuleFilename(manifest.characterName, manifest.mode);
  const saved = await downloadBlob(blob, resolvedFilename, {
    mimeType: 'application/zip',
    directory: 'downloads',
    preferShare: true,
    webSaveTarget,
  });
  return {
    filename: resolvedFilename,
    blobBytes: blob.size,
    compressed: packed.compressed,
    saved,
    message: describeDownloadResult(saved),
  };
}

function parseJsonEntry(entries, name, fallback) {
  const entry = safeArray(entries).find((item) => {
    const path = String(item?.path || item?.name || '').replace(/^\.\//, '').toLowerCase();
    return path === name.toLowerCase();
  });
  if (!entry) return fallback;
  try {
    return JSON.parse(String(entry.text || ''));
  } catch (_) {
    throw new Error(`档案中的 ${name} 不是有效 JSON`);
  }
}

const CAPSULE_KNOWN_JSON = new Set([
  'manifest.json',
  'character.json',
  'chats.json',
  'memory.json',
  'character-phone.json',
  'offline-archives.json',
  'social.json',
  'collectibles.json',
  'au-stories.json',
  'voice-cache.json',
]);

export function parseCharacterTimeCapsuleEntries(entries = []) {
  const manifest = parseJsonEntry(entries, 'manifest.json', null);
  if (!manifest || manifest.format !== CHARACTER_TIME_CAPSULE_FORMAT) {
    throw new Error('这不是棉花糖机角色时光档案');
  }
  const version = Number(manifest.version || 0);
  if (!Number.isSafeInteger(version) || version < 1 || version > CHARACTER_TIME_CAPSULE_VERSION) {
    throw new Error(`暂不支持此档案版本（v${manifest.version || '?'}）`);
  }
  const character = parseJsonEntry(entries, 'character.json', null);
  const chats = parseJsonEntry(entries, 'chats.json', []);
  const memory = parseJsonEntry(entries, 'memory.json', {});
  const phone = parseJsonEntry(entries, 'character-phone.json', null);
  const offlineArchives = parseJsonEntry(entries, 'offline-archives.json', []);
  const social = parseJsonEntry(entries, 'social.json', {});
  const collectibles = parseJsonEntry(entries, 'collectibles.json', []);
  const auStories = parseJsonEntry(entries, 'au-stories.json', []);
  const voiceEntries = parseJsonEntry(entries, 'voice-cache.json', []);
  if (!character?.id || !Array.isArray(chats)) throw new Error('角色卡或聊天清单不完整');

  const chatIds = new Set(chats.map((chat) => String(chat?.id || '')).filter(Boolean));
  if (chatIds.size !== chats.length) throw new Error('聊天清单存在空 ID 或重复 ID');
  const messagesByChat = Object.fromEntries([...chatIds].map((chatId) => [chatId, []]));
  const messageIds = new Set();
  for (const entry of safeArray(entries)) {
    const path = String(entry?.path || entry?.name || '').replace(/^\.\//, '').toLowerCase();
    if (CAPSULE_KNOWN_JSON.has(path)) continue;
    let rows;
    try {
      rows = JSON.parse(String(entry?.text || ''));
    } catch (_) {
      continue;
    }
    if (!Array.isArray(rows) || !rows.length || !rows.every((row) => row?.id && row?.chatId)) continue;
    for (const row of rows) {
      const chatId = String(row.chatId || '');
      const messageId = String(row.id || '');
      if (!chatIds.has(chatId)) throw new Error('消息引用了档案外的聊天窗口');
      if (messageIds.has(messageId)) throw new Error('档案中存在重复消息 ID');
      messageIds.add(messageId);
      messagesByChat[chatId].push(row);
    }
  }
  const expectedChats = Number(manifest.counts?.chats);
  const expectedMessages = Number(manifest.counts?.messages);
  if (Number.isFinite(expectedChats) && expectedChats !== chats.length) throw new Error('聊天数量校验失败');
  if (Number.isFinite(expectedMessages) && expectedMessages !== messageIds.size) throw new Error('消息数量校验失败');
  if (String(manifest.characterId || '') && String(manifest.characterId) !== String(character.id)) {
    throw new Error('角色 ID 与档案清单不一致');
  }
  const normalizedMemory = memory && typeof memory === 'object' ? memory : {};
  const memoryCount = Object.values(normalizedMemory).reduce((sum, rows) => sum + safeArray(rows).length, 0);
  return {
    manifest,
    data: {
      character,
      chats,
      messagesByChat,
      memory: normalizedMemory,
      phone,
      offlineArchives: safeArray(offlineArchives),
      social: social && typeof social === 'object' ? social : {},
      collectibles: safeArray(collectibles),
      auStories: safeArray(auStories),
    },
    voice: { entries: safeArray(voiceEntries) },
    counts: {
      chats: chats.length,
      messages: messageIds.size,
      memories: memoryCount,
      offlineArchives: safeArray(offlineArchives).length,
      voiceCaches: safeArray(voiceEntries).length,
    },
  };
}

export async function parseCharacterTimeCapsuleFile(file) {
  const size = Math.max(0, Number(file?.size || 0) || 0);
  if (!file || !/\.zip$/i.test(String(file.name || ''))) throw new Error('请选择角色时光档案 ZIP');
  if (size > MAX_IMPORT_FILE_BYTES) throw new Error('单个角色档案暂不能超过 512 MB');
  let entries;
  try {
    entries = await readJsonEntriesFromZip(file);
  } catch (error) {
    const message = String(error?.message || '');
    throw new Error(message.replace('正则文件', '角色档案').replace('正则 JSON', '角色档案 JSON'));
  }
  return parseCharacterTimeCapsuleEntries(entries);
}

function createImportId(prefix = 'capsule') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

async function uniqueStoreId(storeName, prefix) {
  for (let i = 0; i < 20; i += 1) {
    const id = createImportId(prefix);
    if (!(await db.getRecord(storeName, id).catch(() => null))) return id;
  }
  throw new Error('无法生成不冲突的恢复 ID');
}

function mappedKey(key, maps) {
  const text = String(key || '');
  if (text === maps.sourceCharacterId) return maps.targetCharacterId;
  for (const map of [maps.chatIds, maps.messageIds, maps.offlineIds, maps.rowIds]) {
    if (map?.has(text)) return map.get(text);
  }
  return text;
}

function deepRemap(value, maps, parentKey = '', seen = new WeakMap()) {
  if (value == null) return value;
  if (typeof value === 'string') {
    const key = String(parentKey || '');
    if (/^(?:userId|ownerUserId|slotUserId)$/i.test(key)) return maps.userId;
    return mappedKey(value, maps);
  }
  if (typeof value !== 'object' || value instanceof Blob) return value;
  if (seen.has(value)) return seen.get(value);
  const out = Array.isArray(value) ? [] : {};
  seen.set(value, out);
  if (Array.isArray(value)) {
    value.forEach((item) => out.push(deepRemap(item, maps, parentKey, seen)));
  } else {
    Object.entries(value).forEach(([key, item]) => {
      out[mappedKey(key, maps)] = deepRemap(item, maps, key, seen);
    });
  }
  return out;
}

function cleanOmittedProfileMedia(value, parentKey = '', seen = new WeakMap()) {
  if (value == null) return value;
  if (typeof value === 'string') {
    if (OMITTED_MEDIA_RE.test(value) && /avatar|image|photo|wallpaper|cover|url/i.test(parentKey)) return '';
    return value;
  }
  if (typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);
  const out = Array.isArray(value) ? [] : {};
  seen.set(value, out);
  if (Array.isArray(value)) value.forEach((item) => out.push(cleanOmittedProfileMedia(item, parentKey, seen)));
  else Object.entries(value).forEach(([key, item]) => { out[key] = cleanOmittedProfileMedia(item, key, seen); });
  return out;
}

function mergePhoneArrays(existing, imported) {
  const out = { ...imported, ...existing };
  const keys = new Set([
    ...Object.keys(existing || {}).filter((key) => Array.isArray(existing[key])),
    ...Object.keys(imported || {}).filter((key) => Array.isArray(imported[key])),
  ]);
  for (const key of keys) {
    const seen = new Set();
    out[key] = [...safeArray(existing?.[key]), ...safeArray(imported?.[key])].filter((row) => {
      const identity = String(row?.id || row?.key || JSON.stringify(row));
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    });
  }
  return out;
}

function sameMessage(existing, candidate) {
  return !!existing && !!candidate
    && String(existing.chatId || '') === String(candidate.chatId || '')
    && String(existing.senderId || '') === String(candidate.senderId || '')
    && String(existing.type || '') === String(candidate.type || '')
    && String(existing.content || '') === String(candidate.content || '')
    && Number(existing.timestamp || 0) === Number(candidate.timestamp || 0);
}

function normalizeImportedMessage(message, archiveMode) {
  const row = { ...message, metadata: { ...(message?.metadata || {}) } };
  if (archiveMode === 'light' && OMITTED_MEDIA_RE.test(String(row.content || ''))
    && (row.type === 'image' || row.type === 'sticker')) {
    row.metadata.archiveOriginalType = row.type;
    row.metadata.archiveMediaOmitted = true;
    row.type = 'text';
    row.content = row.metadata.archiveOriginalType === 'sticker'
      ? '[轻量档案未包含该表情图片]'
      : '[轻量档案未包含该图片]';
  }
  return row;
}

async function restoreStoreRows(storeName, rows, maps, options = {}) {
  const source = safeArray(rows).filter((row) => row?.id);
  if (!source.length) return { saved: 0, skipped: 0 };
  const localIds = new Map();
  const skipIds = new Set();
  let skipped = 0;
  for (const row of source) {
    const oldId = String(row.id);
    const existing = await db.getRecord(storeName, oldId).catch(() => null);
    if (options.copy || existing) {
      if (!options.copy && existing && JSON.stringify(existing) === JSON.stringify(deepRemap(row, maps))) {
        localIds.set(oldId, oldId);
        skipIds.add(oldId);
        skipped += 1;
      } else {
        localIds.set(oldId, await uniqueStoreId(storeName, `capsule_${storeName}`));
      }
    } else {
      localIds.set(oldId, oldId);
    }
  }
  const scopedMaps = { ...maps, rowIds: localIds };
  const restored = source
    .filter((row) => !skipIds.has(String(row.id)))
    .map((row) => {
      const next = deepRemap(row, scopedMaps);
      next.id = localIds.get(String(row.id));
      if (options.forceUserId) next.userId = maps.userId;
      return cleanOmittedProfileMedia(next);
    });
  if (restored.length) await db.putMany(storeName, restored, { batchSize: 100 });
  return { saved: restored.length, skipped };
}

export async function restoreCharacterTimeCapsule({
  parsed,
  userId = '',
  targetCharacterId = '',
  restoreMode = 'merge',
} = {}) {
  if (!parsed?.manifest || parsed.manifest.format !== CHARACTER_TIME_CAPSULE_FORMAT) throw new Error('档案尚未通过校验');
  const uid = String(userId || '').trim();
  const sourceUserId = String(parsed.manifest.userId || '').trim();
  // 线下档案是档位级经历，不是角色卡自身资料。角色档案可以跨档恢复聊天与角色资料，
  // 但不能把来源档位的线下记录静默改写成当前档位的经历。只有同一 userId 的原位
  // 恢复才允许写回；旧档案缺少来源 userId 时也按跨档处理，宁可少恢复也不串档。
  const canRestoreOfflineArchives = !!sourceUserId && sourceUserId === uid;
  const sourceCharacterId = String(parsed.data?.character?.id || '').trim();
  const copy = restoreMode === 'copy';
  let characterId = String(targetCharacterId || '').trim();
  if (!uid || (!copy && !characterId)) throw new Error('缺少恢复目标');
  if (copy) {
    characterId = await uniqueStoreId('characters', 'char_capsule');
    const sourceProfile = cleanOmittedProfileMedia(parsed.data.character);
    await saveCharacter({
      ...sourceProfile,
      id: characterId,
      name: `${String(sourceProfile.name || sourceProfile.customNickname || '角色').trim()}（档案副本）`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  } else if (!(await db.getRecord('characters', characterId).catch(() => null))) {
    throw new Error('当前角色不存在，无法合并');
  }

  const maps = {
    userId: uid,
    sourceCharacterId,
    targetCharacterId: characterId,
    chatIds: new Map(),
    messageIds: new Map(),
    offlineIds: new Map(),
    rowIds: null,
  };
  const existingPrivate = copy ? null : await findPrivateChat(uid, characterId).catch(() => null);
  const createdChatIds = [];
  for (const chat of safeArray(parsed.data.chats)) {
    const oldChatId = String(chat.id || '');
    const participants = safeArray(chat.participants).map(String);
    const isMainPrivate = chat.type !== 'group' && participants.includes('user') && participants.includes(sourceCharacterId);
    let mappedId = '';
    if (!copy && isMainPrivate && existingPrivate?.id) mappedId = existingPrivate.id;
    if (!mappedId && !copy) {
      const same = await db.getRecord('chats', oldChatId).catch(() => null);
      if (same && String(same.userId || '') === uid
        && safeArray(same.participants).map(String).includes(characterId)) {
        mappedId = oldChatId;
      }
    }
    if (!mappedId) mappedId = await uniqueStoreId('chats', 'chat_capsule');
    maps.chatIds.set(oldChatId, mappedId);
    const existing = await db.getRecord('chats', mappedId).catch(() => null);
    if (!existing) {
      const nextChat = cleanOmittedProfileMedia(deepRemap(chat, maps));
      await saveChat({
        ...nextChat,
        id: mappedId,
        userId: uid,
        participants: safeArray(nextChat.participants),
        unread: 0,
      });
      createdChatIds.push(mappedId);
    }
  }

  const existingOffline = await listOfflineDateArchives(uid, {}).catch(() => []);
  const existingOfflineById = new Map(existingOffline.map((row) => [String(row?.id || ''), row]));
  for (const archive of safeArray(parsed.data.offlineArchives)) {
    const oldId = String(archive?.id || '');
    if (!oldId) continue;
    const collision = existingOfflineById.has(oldId);
    maps.offlineIds.set(oldId, copy || collision ? createImportId('oda_capsule') : oldId);
  }

  const importedMessages = Object.values(parsed.data.messagesByChat || {}).flat().filter((row) => row?.id);
  const existingMessages = await db.getMany('messages', importedMessages.map((row) => row.id));
  const skipMessageIds = new Set();
  for (let index = 0; index < importedMessages.length; index += 1) {
    const message = importedMessages[index];
    const oldId = String(message.id);
    const base = deepRemap(message, maps);
    const existing = existingMessages[index];
    if (!copy && sameMessage(existing, base)) {
      maps.messageIds.set(oldId, oldId);
      skipMessageIds.add(oldId);
    } else if (copy || existing) {
      maps.messageIds.set(oldId, await uniqueStoreId('messages', 'msg_capsule'));
    } else {
      maps.messageIds.set(oldId, oldId);
    }
  }
  const messagesByTargetChat = new Map();
  for (const message of importedMessages) {
    if (skipMessageIds.has(String(message.id))) continue;
    const next = normalizeImportedMessage(deepRemap(message, maps), parsed.manifest.mode);
    next.id = maps.messageIds.get(String(message.id));
    next.chatId = maps.chatIds.get(String(message.chatId || '')) || next.chatId;
    if (!messagesByTargetChat.has(next.chatId)) messagesByTargetChat.set(next.chatId, []);
    messagesByTargetChat.get(next.chatId).push(next);
  }
  let messagesSaved = 0;
  for (const [chatId, rows] of messagesByTargetChat) {
    messagesSaved += await saveMessages(rows);
    await recalcChatPreview(chatId);
  }

  const mappedPhone = parsed.data.phone
    ? cleanOmittedProfileMedia(deepRemap(parsed.data.phone, maps))
    : null;
  if (mappedPhone) {
    const existingPhone = await loadCharacterPhone(uid, characterId).catch(() => null);
    const phone = copy ? mappedPhone : mergePhoneArrays(existingPhone || {}, mappedPhone);
    await saveCharacterPhone({ ...phone, userId: uid, characterId });
  }

  let offlineSaved = 0;
  const incomingOfflineArchives = safeArray(parsed.data.offlineArchives);
  for (const archive of canRestoreOfflineArchives ? incomingOfflineArchives : []) {
    const oldId = String(archive?.id || '');
    if (!oldId) continue;
    if (!copy && existingOfflineById.has(oldId)) continue;
    const next = cleanOmittedProfileMedia(deepRemap(archive, maps));
    next.id = maps.offlineIds.get(oldId) || oldId;
    await restoreOfflineDateArchive(uid, next);
    offlineSaved += 1;
  }
  // 这里只统计因档位隔离被跳过的数量；同档位里已存在的同 ID 档案属于正常去重，
  // 不能在 UI 上误报成“来自其他档位”。
  const offlineSkipped = canRestoreOfflineArchives ? 0 : incomingOfflineArchives.length;

  const restoredKinds = {};
  const memoryStores = {
    memories: 'memories',
    memoryFacts: 'memoryFacts',
    eventMemories: 'eventMemories',
    sharedEventKnowledge: 'sharedEventKnowledge',
  };
  for (const [key, storeName] of Object.entries(memoryStores)) {
    restoredKinds[key] = await restoreStoreRows(storeName, parsed.data.memory?.[key], maps, {
      copy,
      forceUserId: true,
    });
  }
  const socialStores = {
    momentsPosts: 'momentsPosts',
    weiboPosts: 'weiboPosts',
    forumThreads: 'forumThreads',
  };
  for (const [key, storeName] of Object.entries(socialStores)) {
    restoredKinds[key] = await restoreStoreRows(storeName, parsed.data.social?.[key], maps, {
      copy,
      forceUserId: key !== 'weiboPosts',
    });
  }
  restoredKinds.collectibles = await restoreStoreRows('collectibles', parsed.data.collectibles, maps, { copy, forceUserId: true });
  restoredKinds.auStories = await restoreStoreRows('auStories', parsed.data.auStories, maps, { copy, forceUserId: true });

  let voiceCaches = 0;
  for (const entry of safeArray(parsed.voice?.entries)) {
    if (await restoreVoiceCachedAudio(entry?.key, entry?.payload).catch(() => false)) voiceCaches += 1;
  }
  const recordsSaved = Object.values(restoredKinds).reduce((sum, result) => sum + Number(result?.saved || 0), 0);
  return {
    characterId,
    copied: copy,
    createdChatIds,
    messagesSaved,
    offlineSaved,
    offlineSkipped,
    offlineScopeMatched: canRestoreOfflineArchives,
    recordsSaved,
    voiceCaches,
  };
}

export async function clearCharacterVoiceCache(inspected) {
  const keys = safeArray(inspected?.voice?.entries).map((entry) => String(entry?.key || '').trim()).filter(Boolean);
  let deleted = 0;
  // deleteVoiceCachedAudio 会维护共享索引，串行执行可避免并发覆盖索引更新。
  for (const key of keys) {
    if (await deleteVoiceCachedAudio(key).catch(() => false)) deleted += 1;
  }
  return { deleted };
}
