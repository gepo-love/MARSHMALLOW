import * as db from './db.js';
import { listUsersInSlot } from './user-slot.js';
import { downloadBlob, isNativeShell, pickWebSaveWritable } from './native-download.js';
import { beginNativeChunkedTextSave } from './native-file-export.js';

const SLOT_ARCHIVE_FORMAT = 'marshmallow-phone-backup';
const SLOT_ARCHIVE_VERSION = 1;
const FLUSH_CHARS = 128 * 1024;

function pad(value) { return String(value).padStart(2, '0'); }

function archiveTimestamp(date = new Date()) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

function safeFilenamePart(value = '') {
  return String(value || '档位').replace(/[\\/:*?"<>|\r\n]+/g, '_').trim().slice(0, 36) || '档位';
}

function rowOwnedByUsers(row = {}, userIds = new Set()) {
  if (!row || typeof row !== 'object') return false;
  if ([row.userId, row.ownerUserId, row.slotUserId].some((value) => userIds.has(String(value || '').trim()))) {
    return true;
  }
  const ownerType = String(row.ownerType || row.authorType || '').trim().toLowerCase();
  const ownerId = String(row.ownerId || row.authorId || '').trim();
  return ownerType === 'user' && userIds.has(ownerId);
}

function settingsRowBelongsToUsers(row = {}, userIds = new Set()) {
  const key = String(row?.key || '');
  if (!key || key === 'currentUserId') return false;
  for (const userId of userIds) {
    if (key === userId || key.includes(userId) || key.includes(encodeURIComponent(userId))) return true;
  }
  return rowOwnedByUsers(row?.value, userIds);
}

function collectChatCharacterIds(chat = {}, target = new Set()) {
  [chat.characterId, chat.character?.id].forEach((value) => {
    const id = String(value || '').trim();
    if (id) target.add(id);
  });
  [chat.participantIds, chat.characterIds, chat.participants, chat.characters].forEach((list) => {
    if (!Array.isArray(list)) return;
    list.forEach((item) => {
      const id = String(typeof item === 'object' ? item?.id : item || '').trim();
      if (id) target.add(id);
    });
  });
  return target;
}

export function slotArchiveIncludesRow(storeName, row, scope = {}) {
  const userIds = scope.userIds instanceof Set ? scope.userIds : new Set(scope.userIds || []);
  const chatIds = scope.chatIds instanceof Set ? scope.chatIds : new Set(scope.chatIds || []);
  const characterIds = scope.characterIds instanceof Set ? scope.characterIds : new Set(scope.characterIds || []);
  if (!row) return false;
  if (storeName === 'memoryVectors' || storeName === 'stickerPacks' || storeName === 'beautifyAssets') return false;
  if (storeName === 'users') return userIds.has(String(row.id || ''));
  if (storeName === 'chats') return chatIds.has(String(row.id || ''));
  if (storeName === 'messages') return chatIds.has(String(row.chatId || ''));
  if (storeName === 'characters') return characterIds.has(String(row.id || ''));
  if (storeName === 'settings') return settingsRowBelongsToUsers(row, userIds);
  if (storeName === 'streamerLedger') return userIds.has(String(row.userId || ''));
  if (chatIds.has(String(row.chatId || ''))) return true;
  return rowOwnedByUsers(row, userIds);
}

function normalizeArchiveRow(storeName, row) {
  if (!row || typeof row !== 'object') return row;
  if (
    storeName === 'messages'
    && row.type === 'image'
    && /^data:image\//i.test(String(row.content || ''))
    && String(row.content || '') === String(row.metadata?.url || '')
  ) return { ...row, metadata: { ...(row.metadata || {}), url: '' } };
  if (storeName === 'musicTracks' || storeName === 'soundAssets') {
    const next = { ...row };
    delete next.audioBlob;
    return next;
  }
  return row;
}

class BrowserJsonWriter {
  constructor(writable = null) {
    this.writable = writable;
    this.parts = [];
    this.buffer = '';
    this.bytes = 0;
    this.encoder = new TextEncoder();
  }

  write(text) { this.buffer += String(text || ''); }
  get shouldDrain() { return this.buffer.length >= FLUSH_CHARS; }

  async drain() {
    if (!this.buffer) return;
    const chunk = this.encoder.encode(this.buffer);
    this.buffer = '';
    this.bytes += chunk.byteLength;
    if (this.writable) await this.writable.write(chunk);
    else this.parts.push(chunk);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  async finish(filename) {
    await this.drain();
    if (this.writable) {
      await this.writable.close();
      return { ok: true, method: 'browser-fs', filename, bytes: this.bytes };
    }
    const blob = new Blob(this.parts, { type: 'application/json' });
    this.parts.length = 0;
    return {
      ok: true,
      method: 'deferred',
      filename,
      bytes: blob.size,
      requiresSaveGesture: true,
      save: () => downloadBlob(blob, filename, { mimeType: 'application/json', directory: 'downloads' }),
    };
  }

  async abort() {
    this.buffer = '';
    this.parts.length = 0;
    await this.writable?.abort?.().catch(() => {});
  }
}

async function buildSlotArchiveScope(userId) {
  const users = await listUsersInSlot(userId);
  if (!users.length) throw new Error('档位不存在');
  const userIds = new Set(users.map((user) => String(user.id || '')).filter(Boolean));
  const chats = [];
  for (const id of userIds) chats.push(...await db.getAllByIndex('chats', 'userId', id).catch(() => []));
  const chatIds = new Set(chats.map((chat) => String(chat?.id || '')).filter(Boolean));
  const characterIds = new Set();
  chats.forEach((chat) => collectChatCharacterIds(chat, characterIds));
  return { users, chats, userIds, chatIds, characterIds };
}

async function appendStore(writer, storeName, scope, options = {}) {
  let count = 0;
  let first = true;
  const append = async (row) => {
    if (!slotArchiveIncludesRow(storeName, row, scope)) return;
    writer.write(`${first ? '' : ','}${JSON.stringify(normalizeArchiveRow(storeName, row))}`);
    first = false;
    count += 1;
    if (writer.shouldDrain) await writer.drain();
    options.onProgress?.({ storeName, count });
  };
  writer.write(`${JSON.stringify(storeName)}:[`);
  if (storeName === 'settings') {
    const keys = await db.getAllKeys('settings');
    for (const key of keys) {
      const raw = String(key || '');
      if (![...scope.userIds].some((id) => raw === id || raw.includes(id) || raw.includes(encodeURIComponent(id)))) continue;
      const row = await db.getRecord('settings', key);
      if (row) await append(row);
    }
  } else if (storeName === 'users') {
    for (const row of scope.users) await append(row);
  } else if (storeName === 'chats') {
    for (const row of scope.chats) await append(row);
  } else {
    await db.forEachStoreRecordBatched(storeName, append, {
      batchSize: storeName === 'messages' ? 4 : 20,
      onBatch: () => new Promise((resolve) => setTimeout(resolve, 0)),
    });
  }
  writer.write(']');
  return count;
}

export async function downloadUserSlotArchive(userId, options = {}) {
  const filename = `marshmallow-slot-${safeFilenamePart(options.slotName)}-${archiveTimestamp()}.json`;
  const native = isNativeShell();
  const webTarget = native ? null : await pickWebSaveWritable(filename, { mimeType: 'application/json' });
  const scope = await buildSlotArchiveScope(userId);
  const slot = scope.users[0];
  const writer = native
    ? await beginNativeChunkedTextSave({ filename, mimeType: 'application/json', directory: 'downloads' })
    : new BrowserJsonWriter(webTarget?.writable || null);
  const counts = {};
  try {
    writer.write('{');
    writer.write(`"format":${JSON.stringify(SLOT_ARCHIVE_FORMAT)},`);
    writer.write(`"version":${SLOT_ARCHIVE_VERSION},"app":"marshmallow-phone",`);
    writer.write(`"exportedAt":${JSON.stringify(new Date().toISOString())},`);
    writer.write(`"slotArchive":${JSON.stringify({
      worldId: String(slot.worldId || slot.slotGroupId || slot.id),
      slotGroupId: String(slot.slotGroupId || slot.id),
      slotName: String(slot.slotName || slot.name || '档位'),
      userIds: [...scope.userIds],
      chatCount: scope.chatIds.size,
      includesChatImages: true,
      omitsDerivedVectors: true,
      requiresResourcePackForGlobalAudio: true,
    })},"stores":{`);
    const stores = Object.keys(db.STORES).filter((name) => !['memoryVectors', 'stickerPacks', 'beautifyAssets'].includes(name));
    for (let index = 0; index < stores.length; index += 1) {
      if (index) writer.write(',');
      counts[stores[index]] = await appendStore(writer, stores[index], scope, options);
      if (writer.shouldDrain) await writer.drain();
    }
    writer.write('}}');
    const saved = await writer.finish(filename);
    return {
      filename, saved, counts,
      worldId: String(slot.worldId || slot.slotGroupId || slot.id),
      slotGroupId: String(slot.slotGroupId || slot.id),
      slotName: String(slot.slotName || slot.name || '档位'),
      userIds: [...scope.userIds],
    };
  } catch (error) {
    await writer.abort?.();
    throw error;
  }
}
