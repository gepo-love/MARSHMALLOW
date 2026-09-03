import * as db from './db.js';
import {
  getChat,
  listMessagesForChat,
  recalcChatPreview,
} from './chat-store.js';
import { downloadJson } from './native-download.js';

export const CHAT_RECORD_EXPORT_KIND = 'marshmallow-chat-records';
export const CHAT_RECORD_EXPORT_VERSION = 1;

function clean(value, max = 240) {
  return String(value ?? '').trim().slice(0, max);
}

function safeJsonValue(value, fallback = null) {
  try {
    return JSON.parse(JSON.stringify(value ?? fallback));
  } catch (_) {
    return fallback;
  }
}

function stableHash(value = '') {
  let hash = 2166136261;
  const text = String(value || '');
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function exportMessage(message = {}) {
  return {
    id: clean(message.id, 180),
    senderId: clean(message.senderId, 180) || 'user',
    senderName: clean(message.senderName, 240),
    type: clean(message.type, 80) || 'text',
    content: String(message.content ?? ''),
    timestamp: Number(message.timestamp) || Date.now(),
    replyPreview: safeJsonValue(message.replyPreview),
    metadata: safeJsonValue(message.metadata, {}),
    recalled: message.recalled === true,
  };
}

export function chatRecordMessageFingerprint(message = {}) {
  return stableHash(JSON.stringify([
    clean(message.senderId, 180),
    clean(message.senderName, 240),
    clean(message.type, 80) || 'text',
    String(message.content ?? ''),
    Number(message.timestamp) || 0,
    safeJsonValue(message.replyPreview),
  ]));
}

export function buildChatRecordPayload(chat, messages = [], options = {}) {
  if (!chat?.id) throw new Error('找不到要导出的聊天窗口');
  const rows = (Array.isArray(messages) ? messages : [])
    .filter((message) => message && !message.deleted)
    .map(exportMessage);
  return {
    kind: CHAT_RECORD_EXPORT_KIND,
    version: CHAT_RECORD_EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    conversation: {
      type: chat.type === 'group' ? 'group' : 'private',
      name: clean(options.name || chat.groupSettings?.name || chat.metadata?.partnerName || '聊天记录', 120),
      sourceChatId: clean(chat.id, 180),
      participants: (Array.isArray(chat.participants) ? chat.participants : [])
        .map((id) => clean(id, 180)).filter(Boolean),
    },
    messages: rows,
  };
}

export function parseChatRecordJson(text) {
  let payload;
  try {
    payload = typeof text === 'string' ? JSON.parse(text) : text;
  } catch (_) {
    throw new Error('无法读取 JSON 文件');
  }
  if (!payload || payload.kind !== CHAT_RECORD_EXPORT_KIND) {
    throw new Error('这不是聊天记录 JSON');
  }
  if (Number(payload.version) !== CHAT_RECORD_EXPORT_VERSION) {
    throw new Error(`暂不支持此聊天记录版本：${payload.version ?? '未知'}`);
  }
  if (!Array.isArray(payload.messages)) throw new Error('聊天记录中没有消息列表');
  const messages = payload.messages.map((message, index) => {
    if (!message || typeof message !== 'object') throw new Error(`第 ${index + 1} 条消息格式不正确`);
    const timestamp = Number(message.timestamp);
    if (!Number.isFinite(timestamp) || timestamp <= 0) throw new Error(`第 ${index + 1} 条消息时间无效`);
    return exportMessage(message);
  });
  return {
    kind: CHAT_RECORD_EXPORT_KIND,
    version: CHAT_RECORD_EXPORT_VERSION,
    exportedAt: clean(payload.exportedAt, 80),
    conversation: {
      type: payload.conversation?.type === 'group' ? 'group' : 'private',
      name: clean(payload.conversation?.name, 120) || '聊天记录',
      sourceChatId: clean(payload.conversation?.sourceChatId, 180),
      participants: (Array.isArray(payload.conversation?.participants) ? payload.conversation.participants : [])
        .map((id) => clean(id, 180)).filter(Boolean),
    },
    messages,
  };
}

function importedMessageId(chatId, sourceId, fingerprint, occupiedIds) {
  const base = `msg_import_${stableHash(chatId)}_${stableHash(sourceId || fingerprint)}_${fingerprint}`;
  let id = base;
  let suffix = 2;
  while (occupiedIds.has(id)) {
    id = `${base}_${suffix}`;
    suffix += 1;
  }
  occupiedIds.add(id);
  return id;
}

function sourceMessageKey(sourceChatId, sourceMessageId) {
  const chat = clean(sourceChatId, 180);
  const message = clean(sourceMessageId, 180);
  return chat && message ? `${chat}\n${message}` : '';
}

export async function importChatRecordsIntoChat(chatId, parsed) {
  const targetId = clean(chatId, 180);
  const chat = await getChat(targetId);
  if (!chat) throw new Error('当前聊天窗口不存在');
  const payload = parseChatRecordJson(parsed);
  const existing = await listMessagesForChat(targetId, 0);
  const occupiedIds = new Set(existing.map((message) => clean(message.id, 180)).filter(Boolean));
  const knownSourceKeys = new Set(existing.map((message) => sourceMessageKey(
    message.metadata?.chatRecordSourceChatId,
    message.metadata?.chatRecordSourceMessageId,
  )).filter(Boolean));
  const knownLegacyFingerprints = new Set(existing
    .filter((message) => message.metadata?.chatRecordImportFingerprint
      && !sourceMessageKey(message.metadata?.chatRecordSourceChatId, message.metadata?.chatRecordSourceMessageId))
    .map((message) => clean(message.metadata?.chatRecordImportFingerprint, 80))
    .filter(Boolean));
  const importedAt = Date.now();
  const rows = [];
  let skipped = 0;
  for (const source of payload.messages) {
    const fingerprint = chatRecordMessageFingerprint(source);
    const sourceKey = sourceMessageKey(payload.conversation.sourceChatId, source.id);
    if ((sourceKey && knownSourceKeys.has(sourceKey))
      || (!sourceKey && knownLegacyFingerprints.has(fingerprint))) {
      skipped += 1;
      continue;
    }
    if (sourceKey) knownSourceKeys.add(sourceKey);
    else knownLegacyFingerprints.add(fingerprint);
    const metadata = safeJsonValue(source.metadata, {}) || {};
    rows.push({
      ...exportMessage(source),
      id: importedMessageId(targetId, source.id, fingerprint, occupiedIds),
      chatId: targetId,
      deleted: false,
      metadata: {
        ...metadata,
        chatRecordImportFingerprint: fingerprint,
        chatRecordImportedAt: importedAt,
        chatRecordSourceChatId: payload.conversation.sourceChatId,
        chatRecordSourceMessageId: clean(source.id, 180),
      },
    });
  }
  if (rows.length) {
    await db.putMany('messages', rows, { batchSize: 200 });
    await recalcChatPreview(targetId);
  }
  return { imported: rows.length, skipped, total: payload.messages.length };
}

function safeFilenamePart(value = '') {
  return clean(value, 50).replace(/[\\/:*?"<>|\r\n]+/g, '_') || '聊天记录';
}

export async function exportChatRecords(chatId, options = {}) {
  const chat = await getChat(chatId);
  if (!chat) throw new Error('当前聊天窗口不存在');
  const messages = await listMessagesForChat(chat.id, 0);
  const payload = buildChatRecordPayload(chat, messages, options);
  const day = new Date().toISOString().slice(0, 10);
  const filename = `棉花糖机-${safeFilenamePart(payload.conversation.name)}-聊天记录-${day}.json`;
  const result = await downloadJson(payload, filename);
  return { ...result, count: payload.messages.length, filename };
}
