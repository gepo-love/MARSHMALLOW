import { get, put } from './db.js';
import { normalizeMailboxType } from './mailbox-presets.js';

const MAILBOX_VERSION = 1;
const MAILBOX_CAP = 600;
export const MAILBOX_CHANGED_EVENT = 'mailbox-changed';

function clean(value = '', max = 0) {
  const text = String(value ?? '').trim();
  return max > 0 ? text.slice(0, max) : text;
}

function mailboxKey(userId = '') {
  return `mailbox_${clean(userId, 180)}`;
}

export function defaultMailboxAddress(userId = '') {
  void userId;
  return 'me@cottonmail.com';
}

function normalizeParty(value = {}, fallback = {}) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    name: clean(source.name || fallback.name, 80),
    address: clean(source.address || fallback.address, 160).toLowerCase(),
    actorId: clean(source.actorId || fallback.actorId, 180),
  };
}

function normalizeMail(value = {}, userId = '', now = Date.now()) {
  const timestamp = Math.max(1, Number(value.timestamp || value.createdAt || now) || now);
  const direction = value.direction === 'outbound' ? 'outbound' : 'inbound';
  const id = clean(value.id, 180) || `mail_${timestamp}_${Math.random().toString(36).slice(2, 9)}`;
  const accountAddress = defaultMailboxAddress(userId);
  const from = normalizeParty(value.from, direction === 'outbound' ? { name: '我', address: accountAddress } : {});
  const to = (Array.isArray(value.to) ? value.to : [value.to])
    .filter(Boolean)
    .map((party) => normalizeParty(party, direction === 'inbound' ? { name: '我', address: accountAddress } : {}))
    .filter((party) => party.address || party.actorId || party.name)
    .slice(0, 12);
  return {
    id,
    userId: clean(userId || value.userId, 180),
    threadId: clean(value.threadId, 180) || id,
    direction,
    from,
    to,
    subject: clean(value.subject, 180) || '（无主题）',
    body: clean(value.body, 12000),
    bodyTranslation: clean(value.bodyTranslation, 12000),
    mailType: normalizeMailboxType(
      value.mailType || (direction === 'outbound' ? 'auto' : 'personal'),
      { allowAuto: direction === 'outbound' },
    ),
    preview: clean(value.preview || value.body, 240).replace(/\s+/g, ' '),
    timestamp,
    readAt: direction === 'outbound' ? timestamp : Math.max(0, Number(value.readAt || 0) || 0),
    starred: value.starred === true,
    archived: value.archived === true,
    deleted: value.deleted === true,
    source: clean(value.source, 60),
    sourceChatId: clean(value.sourceChatId, 180),
    characterId: clean(value.characterId || from.actorId, 180),
    inReplyTo: clean(value.inReplyTo, 180),
    replyStatus: direction === 'outbound' && ['pending', 'answered', 'failed'].includes(value.replyStatus)
      ? value.replyStatus
      : '',
    replyError: direction === 'outbound' ? clean(value.replyError, 300) : '',
    repliedAt: direction === 'outbound' ? Math.max(0, Number(value.repliedAt || 0) || 0) : 0,
    createdAt: Math.max(1, Number(value.createdAt || timestamp) || timestamp),
    updatedAt: Math.max(timestamp, Number(value.updatedAt || timestamp) || timestamp),
  };
}

function normalizeMailbox(value = {}, userId = '') {
  const source = value && typeof value === 'object' ? value : {};
  const seen = new Set();
  const messages = (Array.isArray(source.messages) ? source.messages : [])
    .map((row) => normalizeMail(row, userId))
    .sort((a, b) => b.timestamp - a.timestamp)
    .filter((row) => {
      if (seen.has(row.id)) return false;
      seen.add(row.id);
      return true;
    })
    .slice(0, MAILBOX_CAP);
  return {
    version: MAILBOX_VERSION,
    userId: clean(userId, 180),
    accountAddress: clean(source.accountAddress, 160).toLowerCase() || defaultMailboxAddress(userId),
    messages,
    updatedAt: Math.max(0, Number(source.updatedAt || 0) || 0),
  };
}

function emitMailboxChanged(userId, detail = {}) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent?.(new CustomEvent(MAILBOX_CHANGED_EVENT, {
    detail: { userId: clean(userId, 180), ...detail, at: Date.now() },
  }));
}

export async function loadMailbox(userId = '') {
  const uid = clean(userId, 180);
  if (!uid) return normalizeMailbox({}, '');
  const row = await get(mailboxKey(uid)).catch(() => null);
  return normalizeMailbox(row?.value, uid);
}

async function saveMailbox(userId, mailbox, detail = {}) {
  const uid = clean(userId, 180);
  const next = normalizeMailbox({ ...mailbox, updatedAt: Date.now() }, uid);
  await put({ key: mailboxKey(uid), value: next });
  emitMailboxChanged(uid, detail);
  return next;
}

export async function listMailboxMessages(userId, options = {}) {
  const mailbox = await loadMailbox(userId);
  return mailbox.messages.filter((row) => {
    if (options.includeDeleted !== true && row.deleted) return false;
    if (options.archived === true && !row.archived) return false;
    if (options.archived !== true && options.includeArchived !== true && row.archived) return false;
    if (options.unreadOnly === true && (row.direction !== 'inbound' || row.readAt > 0)) return false;
    if (options.starredOnly === true && !row.starred) return false;
    return true;
  });
}

export async function getMailboxMessage(userId, mailId) {
  const id = clean(mailId, 180);
  if (!id) return null;
  const mailbox = await loadMailbox(userId);
  return mailbox.messages.find((row) => row.id === id) || null;
}

export async function createMailboxMessage(userId, input = {}) {
  const uid = clean(userId, 180);
  if (!uid) throw new Error('缺少邮箱所属身份');
  const mailbox = await loadMailbox(uid);
  const message = normalizeMail(input, uid);
  const existing = mailbox.messages.find((row) => row.id === message.id);
  if (existing) return existing;
  const existingThread = mailbox.messages.filter((row) => row.threadId === message.threadId);
  if (existingThread.length && !message.archived) {
    mailbox.messages = mailbox.messages.map((row) => (
      row.threadId === message.threadId && row.archived
        ? normalizeMail({ ...row, archived: false, updatedAt: Date.now() }, uid)
        : row
    ));
  }
  mailbox.messages.unshift(message);
  await saveMailbox(uid, mailbox, { action: 'created', mailId: message.id });
  return message;
}

export async function patchMailboxMessage(userId, mailId, patch = {}) {
  const uid = clean(userId, 180);
  const id = clean(mailId, 180);
  const mailbox = await loadMailbox(uid);
  const index = mailbox.messages.findIndex((row) => row.id === id);
  if (index < 0) return null;
  const current = mailbox.messages[index];
  mailbox.messages[index] = normalizeMail({
    ...current,
    ...patch,
    id: current.id,
    userId: uid,
    updatedAt: Date.now(),
  }, uid);
  await saveMailbox(uid, mailbox, { action: 'updated', mailId: id });
  return mailbox.messages[index];
}

export async function editMailboxMessage(userId, mailId, patch = {}) {
  const current = await getMailboxMessage(userId, mailId);
  if (!current || current.deleted) return null;
  const body = Object.prototype.hasOwnProperty.call(patch, 'body')
    ? clean(patch.body, 12000)
    : current.body;
  const bodyChanged = body !== current.body;
  return patchMailboxMessage(userId, mailId, {
    subject: Object.prototype.hasOwnProperty.call(patch, 'subject')
      ? (clean(patch.subject, 180) || '（无主题）')
      : current.subject,
    body,
    preview: body.slice(0, 240).replace(/\s+/g, ' '),
    bodyTranslation: Object.prototype.hasOwnProperty.call(patch, 'bodyTranslation')
      ? clean(patch.bodyTranslation, 12000)
      : (bodyChanged ? '' : current.bodyTranslation),
    mailType: Object.prototype.hasOwnProperty.call(patch, 'mailType')
      ? patch.mailType
      : current.mailType,
  });
}

export async function deleteMailboxMessage(userId, mailId) {
  const current = await getMailboxMessage(userId, mailId);
  if (!current || current.deleted) return current;
  return patchMailboxMessage(userId, mailId, { deleted: true });
}

export async function deleteMailboxThread(userId, threadId) {
  return patchMailboxThread(userId, threadId, { deleted: true });
}

export async function markMailboxMessageRead(userId, mailId) {
  return patchMailboxMessage(userId, mailId, { readAt: Date.now() });
}

export async function patchMailboxThread(userId, threadId, patch = {}) {
  const uid = clean(userId, 180);
  const id = clean(threadId, 180);
  if (!uid || !id) return [];
  const mailbox = await loadMailbox(uid);
  let changed = false;
  mailbox.messages = mailbox.messages.map((row) => {
    if (row.threadId !== id) return row;
    changed = true;
    return normalizeMail({
      ...row,
      ...patch,
      id: row.id,
      threadId: row.threadId,
      userId: uid,
      updatedAt: Date.now(),
    }, uid);
  });
  if (!changed) return [];
  const saved = await saveMailbox(uid, mailbox, { action: 'thread-updated', threadId: id });
  return saved.messages.filter((row) => row.threadId === id).sort((a, b) => a.timestamp - b.timestamp);
}

export async function markMailboxThreadRead(userId, threadId) {
  const uid = clean(userId, 180);
  const id = clean(threadId, 180);
  if (!uid || !id) return [];
  const mailbox = await loadMailbox(uid);
  let changed = false;
  mailbox.messages = mailbox.messages.map((row) => {
    if (row.threadId !== id || row.direction !== 'inbound' || row.readAt > 0) return row;
    changed = true;
    return normalizeMail({ ...row, readAt: Date.now(), updatedAt: Date.now() }, uid);
  });
  if (!changed) return mailbox.messages.filter((row) => row.threadId === id).sort((a, b) => a.timestamp - b.timestamp);
  const saved = await saveMailbox(uid, mailbox, { action: 'thread-read', threadId: id });
  return saved.messages.filter((row) => row.threadId === id).sort((a, b) => a.timestamp - b.timestamp);
}

export async function countUnreadMailboxMessages(userId) {
  return (await listMailboxMessages(userId, { unreadOnly: true, includeArchived: true })).length;
}

export async function listMailboxThread(userId, threadId) {
  const id = clean(threadId, 180);
  const mailbox = await loadMailbox(userId);
  return mailbox.messages
    .filter((row) => !row.deleted && row.threadId === id)
    .sort((a, b) => a.timestamp - b.timestamp);
}
