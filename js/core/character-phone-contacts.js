/**
 * 角色手机 · 轻量联系人
 *
 * 数据只保存在 settings 中，按 userId + ownerId 隔离；不会创建主通讯录角色。
 * 本模块不发起网络请求，AI seed 构建器也是纯函数。
 */

import * as db from './db.js';
import { normalizeTranslationProfile } from '../models/character.js';
import {
  createPhoneSocialActorDirectory,
  phoneContactCanonicalActorId,
  phoneSocialActorToContactInput,
  resolvePhoneSocialActorDisplayName,
  isLikelyGeneratedSocialActorCode,
} from './phone-social-actor-directory.js';
import { relationshipActorIdsMatch } from './relationship-network.js';

export const CHARACTER_PHONE_CONTACTS_VERSION = 7;
const MAX_REMOVED_LINKED = 200;
export const PHONE_CONTACT_CATEGORIES = Object.freeze([
  'family',
  'work',
  'friend',
  'rival',
  'other',
]);

const SETTINGS_PREFIX = 'characterPhoneContacts:';
const MAX_CONTACTS = 120;
const MAX_GROUPS = 32;
const MAX_GROUP_MEMBERS = 120;
const MAX_SEED_CHARS = 200000;
let idSequence = 0;
const phoneContactPromotionTasks = new Map();

function clean(value = '', max = 120) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max) : text;
}

// 头像 data URL 不能走 clean：会折叠空白并截到固定字数，JPEG/WebP base64 一截就裂图。
// 上传侧已有 fileToCroppedOptimizedAvatarDataUrl 压缩；这里只整段保留合法图片地址。
const MAX_CONTACT_AVATAR_CHARS = 900000;
function normalizeContactAvatarUrl(value = '') {
  const url = String(value ?? '').trim();
  if (!url) return '';
  if (!/^(data:image\/|https?:\/\/)/i.test(url)) return '';
  return url.length <= MAX_CONTACT_AVATAR_CHARS ? url : '';
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function unique(values, limit = Infinity) {
  return [...new Set(values.filter(Boolean))].slice(0, limit);
}

function phoneContactNameKey(value = '') {
  // 写入去重与 actor 解析必须使用同一规则；否则「陆 二」与「陆二」
  // 会在保存时成为两条联系人，却在聊天解析时又被当成同一个人。
  return phoneContactActorNameKey(value);
}

/** 与群聊 actor 解析同一套键：去空白/分隔符后再比，避免「陆 二」对不上「陆二」。 */
export function phoneContactActorNameKey(value = '') {
  return clean(value, 80).toLowerCase().replace(/[\s_\-./]+/g, '');
}

function phoneContactLocalSourceRef(value = '') {
  const raw = clean(value, 240);
  if (!/^phone-contact:/i.test(raw)) return raw;
  const tail = raw.split(':').pop() || '';
  try {
    return decodeURIComponent(tail);
  } catch (_) {
    return tail;
  }
}

/**
 * user 是角色手机里的保留身份，绝不能被 AI 当成轻量 NPC 再创建一份。
 * 同时识别作用域联系人 id 的末段，避免 phone-contact:...:user 绕过检查。
 */
export function isPhoneUserIdentityRef(value = '', options = {}) {
  const raw = clean(value, 240);
  if (!raw) return false;
  const reserved = [
    'user',
    '用户',
    '用户本人',
    '我',
    clean(options.userId, 160),
    clean(options.userName, 80),
    ...asArray(options.userAliases).map((item) => clean(item, 80)),
  ].filter(Boolean);
  const reservedKeys = new Set(reserved.map((item) => phoneContactActorNameKey(item)).filter(Boolean));
  return [raw, phoneContactLocalSourceRef(raw)]
    .map((item) => phoneContactActorNameKey(item))
    .some((key) => key && reservedKeys.has(key));
}

/**
 * 联系人写入侧的保留身份比消息 actor 更严格：
 * 「我 / 你 / 自己」在不同提示词视角下都可能指用户或手机主人，不能被铸成第三人。
 */
export function isPhoneReservedContactIdentityRef(value = '', options = {}) {
  const raw = clean(value, 240);
  if (!raw) return false;
  const reserved = [
    'user',
    '用户',
    '用户本人',
    '我',
    '我本人',
    '你',
    '你本人',
    '本人',
    '自己',
    '自己本人',
    '手机主人',
    '机主',
    clean(options.userId, 160),
    clean(options.userName, 80),
    clean(options.ownerId, 160),
    clean(options.ownerName, 80),
    ...asArray(options.userAliases).map((item) => clean(item, 80)),
    ...asArray(options.ownerAliases).map((item) => clean(item, 80)),
  ].filter(Boolean);
  const reservedKeys = new Set(reserved.map((item) => phoneContactActorNameKey(item)).filter(Boolean));
  return [raw, phoneContactLocalSourceRef(raw)]
    .map((item) => phoneContactActorNameKey(item))
    .some((key) => key && reservedKeys.has(key));
}

export function isPhoneUserImpersonator(contact = {}, options = {}) {
  if (!contact || typeof contact !== 'object') return false;
  return [
    contact.id,
    contact.contactId,
    contact.linkedCharacterId,
    contact.linkedActorId,
    contact.name,
    contact.displayName,
    contact.nickname,
    contact.alias,
  ].some((value) => isPhoneReservedContactIdentityRef(value, options));
}

export function isPhoneLightContactId(id = '') {
  return /^phone-contact:/i.test(String(id || '').trim());
}

/**
 * 按显示名 / 备注在手机通讯录里找联系人（角色自己的小关系网）。
 */
export function findPhoneContactByActorName(contacts = [], name = '') {
  const key = phoneContactActorNameKey(name);
  if (!key) return null;
  const rows = Array.isArray(contacts) ? contacts : [];
  const matches = rows.filter((item) => (
    phoneContactActorNameKey(item?.name) === key
    || phoneContactActorNameKey(item?.nickname) === key
  ));
  const canonicalIds = new Set(matches.map((item) => phoneContactCanonicalActorId(item)).filter(Boolean));
  return canonicalIds.size === 1 ? matches[0] || null : null;
}

/**
 * 会话 peer 是否已被手机通讯录覆盖（精确 id / linked / id 后缀 / 同名）。
 */
export function phoneContactCoversPeer(contacts = [], peerId = '', peerName = '') {
  const id = clean(peerId, 240);
  if (!id) return false;
  const rows = Array.isArray(contacts) ? contacts : [];
  if (rows.some((item) => (
    item?.id === id || item?.linkedCharacterId === id || item?.linkedActorId === id
  ))) return true;
  const encoded = encodeURIComponent(id);
  if (rows.some((item) => {
    const cid = clean(item?.id, 240);
    return cid.endsWith(`:${id}`) || cid.endsWith(`:${encoded}`) || cid.includes(id);
  })) return true;
  const nameKey = phoneContactActorNameKey(peerName);
  if (!nameKey) return false;
  return rows.some((item) => (
    phoneContactActorNameKey(item?.name) === nameKey
    || phoneContactActorNameKey(item?.nickname) === nameKey
  ));
}

function normalizeRemovedLinkedCharacterIds(raw = []) {
  return unique(asArray(raw).map((id) => clean(id, 160)).filter(Boolean), MAX_REMOVED_LINKED);
}

function normalizeRemovedLinkedActorIds(raw = []) {
  return unique(asArray(raw).map((id) => clean(id, 240)).filter(Boolean), MAX_REMOVED_LINKED);
}

/** 主角色是否已被从这部手机通讯录「移除」（黑名单，防自动写回/自动联系） */
export function isPhoneLinkedCharacterRemoved(stateOrIds = null, characterId = '') {
  const cid = clean(characterId, 160);
  if (!cid) return false;
  const ids = Array.isArray(stateOrIds)
    ? stateOrIds
    : (stateOrIds?.removedLinkedCharacterIds || []);
  return normalizeRemovedLinkedCharacterIds(ids).includes(cid);
}

/**
 * 手机侧自动联系闸门：被「移除」的主角色在未主动加回前，不参与自动私聊/整机动态/线下互发。
 * 不改全局「认识」语义；手动「新的联系人 / 发消息」仍可破例。
 */
export function canPhoneAutoContactLinkedPeer(state = null, peerId = '') {
  const id = clean(peerId, 240);
  if (!id) return true;
  return !isPhoneLinkedCharacterRemoved(state, id)
    && !normalizeRemovedLinkedActorIds(state?.removedLinkedActorIds).includes(id);
}

function scopePart(value, fallback) {
  return encodeURIComponent(clean(value, 160) || fallback);
}

export function characterPhoneContactsScope(userId = '', ownerId = '') {
  return `${scopePart(userId, 'guest')}:${scopePart(ownerId, 'unknown')}`;
}

export function characterPhoneContactsSettingsKey(userId = '', ownerId = '') {
  return `${SETTINGS_PREFIX}${characterPhoneContactsScope(userId, ownerId)}`;
}

export function isPhoneContactActorId(id = '') {
  return /^phone-contact:/i.test(String(id || '').trim());
}

/**
 * 纯手机轻量联系人既可能没有 linkedActorId，也可能把自己同一个 phone-contact id
 * 注册成关系网 actor。后一种仍是本地轻量联系人，不能因为“自链接”从列表与生成池消失。
 */
export function isPhoneLocalLightContact(contact = null) {
  const id = clean(contact?.id, 240);
  const linkedCharacterId = clean(contact?.linkedCharacterId, 160);
  const linkedActorId = clean(contact?.linkedActorId || contact?.canonicalActorId, 240);
  return !!id && !linkedCharacterId && (!linkedActorId || linkedActorId === id);
}

function collectPhoneContactsAcrossOwners(settings = []) {
  const rows = [];
  for (const row of settings || []) {
    const key = String(row?.key || '');
    if (!key.startsWith(SETTINGS_PREFIX)) continue;
    const value = row?.value;
    if (!value || typeof value !== 'object') continue;
    const ownerId = clean(value.ownerId || '', 160);
    for (const contact of asArray(value.contacts)) {
      rows.push({ contact, ownerId, settingKey: key });
    }
  }
  return rows;
}

function findPhoneContactInRows(rows = [], actorId = '') {
  const target = clean(actorId, 240);
  if (!target) return null;
  const exactMatches = [];
  const legacyPrefixMatches = [];
  for (const row of rows || []) {
    const contact = row?.contact;
    const contactId = clean(contact?.id, 240);
    const linkedId = clean(contact?.linkedCharacterId, 160);
    const linkedActorId = clean(contact?.linkedActorId || contact?.canonicalActorId, 240);
    const result = {
      contact,
      ownerId: row.ownerId,
      settingKey: row.settingKey,
      displayName: clean(contact?.name || contact?.nickname || contactId, 80),
    };
    if (contactId === target || linkedId === target || linkedActorId === target) {
      exactMatches.push(result);
      continue;
    }
    if (relationshipActorIdsMatch(contactId, target)
      || relationshipActorIdsMatch(linkedActorId, target)) {
      legacyPrefixMatches.push(result);
    }
  }
  // 精确绑定优先；同一主角色可能被多台手机分别保存，任取其一仍是同一身份。
  if (exactMatches.length) return { ...exactMatches[0], matchKind: 'exact' };
  // 旧版曾把 phone-contact:* 截到 60 字。截断点可能还位于 user/owner 公共前缀，
  // 此时会同时命中这部手机的所有联系人；有歧义时宁可不迁移，也不能取第一条串人。
  if (legacyPrefixMatches.length === 1) {
    return { ...legacyPrefixMatches[0], matchKind: 'legacy-prefix' };
  }
  return null;
}

/**
 * 一次读取全部手机通讯录并返回内存查询器。记忆馆需要连续解析多个身份时复用，
 * 避免每个身份都重新 getAll(settings)。
 */
export async function loadPhoneContactAcrossOwnersLookup() {
  // 通讯录只占 settings 的一个前缀。这里曾全表 getAll，连离线长剧情、照片和
  // 其它大记录也会被 WebView 结构化克隆；聊天上下文只为解析一个联系人时，
  // 这会把无关的本地数据量直接叠到发请求前的等待上。
  const settings = await db.getAllByKeyPrefix('settings', SETTINGS_PREFIX);
  const rows = collectPhoneContactsAcrossOwners(settings);
  return (actorId = '') => findPhoneContactInRows(rows, actorId);
}

/**
 * 在全部手机通讯录里按 contact.id / linkedCharacterId / canonical actor 查找轻量联系人。
 * 记忆馆与数据自检用：区分「还在用的手机联系人」和「已删光的幽灵 id」。
 */
export async function findPhoneContactAcrossOwners(actorId = '') {
  const find = await loadPhoneContactAcrossOwnersLookup();
  return find(actorId);
}

function scopedPrefix(kind, userId, ownerId) {
  return `phone-${kind}:${characterPhoneContactsScope(userId, ownerId)}:`;
}

function localId(value = '') {
  return encodeURIComponent(clean(value, 160)
    .replace(/^phone-(?:contact|group):.*?:/i, '') || 'entry');
}

function createLocalId(kind) {
  idSequence = (idSequence + 1) % 1679616;
  return `${kind}_${Date.now().toString(36)}_${idSequence.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 将任意本地 id 绑定到手机主人作用域。已属于当前作用域的 id 会原样返回。
 */
export function makePhoneContactId(userId = '', ownerId = '', sourceId = '') {
  const prefix = scopedPrefix('contact', userId, ownerId);
  const raw = clean(sourceId, 240);
  return raw.startsWith(prefix) ? raw : `${prefix}${localId(raw || createLocalId('contact'))}`;
}

export function makePhoneContactGroupId(userId = '', ownerId = '', sourceId = '') {
  const prefix = scopedPrefix('group', userId, ownerId);
  const raw = clean(sourceId, 240);
  return raw.startsWith(prefix) ? raw : `${prefix}${localId(raw || createLocalId('group'))}`;
}

function normalizeCustomCategories(value) {
  return unique(asArray(value).map((item) => clean(item, 24))
    .filter((item) => item && !PHONE_CONTACT_CATEGORIES.includes(item)), 8);
}

function categoryOf(value, customCategories = []) {
  const category = clean(value, 24).toLowerCase();
  if (PHONE_CONTACT_CATEGORIES.includes(category)) return category;
  const matched = customCategories.find((item) => item.toLowerCase() === category);
  return matched || 'other';
}

export function normalizePhonePersonaCapsule(raw = {}) {
  const source = typeof raw === 'string' ? { summary: raw } : (raw && typeof raw === 'object' ? raw : {});
  const traits = unique(asArray(source.traits || source.keywords)
    .map((item) => clean(item, 32)), 8);
  const summary = clean(source.summary || source.persona || source.description, 280);
  const relationship = clean(source.relationship || source.relation, 120);
  const speechStyle = clean(source.speechStyle || source.voice || source.tone, 120);
  const boundary = clean(source.boundary || source.boundaries || source.caution, 120);
  if (!summary && !relationship && !speechStyle && !boundary && !traits.length) return null;
  return { summary, traits, relationship, speechStyle, boundary };
}

export function normalizePhoneContact(raw = {}, options = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const userId = clean(options.userId ?? raw.userId, 160);
  const ownerId = clean(options.ownerId ?? raw.ownerId, 160);
  // 历史版本曾把内部 id /「联系人」占位符写进 name；读取时优先恢复可读姓名。
  const name = resolvePhoneSocialActorDisplayName(raw);
  const linkedCharacterId = clean(raw.linkedCharacterId, 160);
  const linkedActorId = clean(raw.linkedActorId || raw.canonicalActorId, 240);
  // 旧版社交联动曾把微博 npc_<hash> 的前缀剥掉，再以裸哈希创建空白手机联系人。
  // 仅清理没有任何人工资料、也未链接真实 actor 的这类孤儿，正常英文昵称不受影响。
  const hasContactProfile = !!(
    clean(raw.nickname || raw.alias, 80)
    || clean(raw.phone || raw.phoneNumber, 48)
    || clean(raw.note || raw.notes, 240)
    || normalizePhonePersonaCapsule(raw.personaCapsule || raw.persona || {})
  );
  if (!linkedCharacterId && !linkedActorId && !hasContactProfile
    && isLikelyGeneratedSocialActorCode(name)) return null;
  if (isPhoneUserImpersonator({
    ...raw,
    id: raw.id || raw.contactId,
    linkedCharacterId,
    linkedActorId,
    name,
  }, {
    userId,
    userName: clean(options.userName, 80),
    userAliases: options.userAliases,
    ownerId,
    ownerName: clean(options.ownerName, 80),
    ownerAliases: options.ownerAliases,
  })) {
    return null;
  }
  if (!name && !linkedCharacterId && !linkedActorId) return null;
  const idSource = raw.id || raw.contactId
    || (linkedCharacterId ? `linked_${linkedCharacterId}` : '')
    || (linkedActorId ? `actor_${linkedActorId}` : '')
    || options.idSource;
  const now = Number(options.now) || Date.now();
  return {
    id: makePhoneContactId(userId, ownerId, idSource),
    ownerId,
    name: name || linkedCharacterId,
    nickname: clean(raw.nickname || raw.alias, 80),
    // 新备注只用于这部手机里的显示，不加入 actor aliases / 姓名匹配。
    // nickname 保留旧存档兼容；所有新入口改写 remark，避免备注抢占真实身份。
    remark: clean(raw.remark || raw.remarkName, 80),
    category: categoryOf(raw.category, options.customCategories),
    phone: clean(raw.phone || raw.phoneNumber, 48),
    avatar: normalizeContactAvatarUrl(raw.avatar || raw.avatarUrl),
    note: clean(raw.note || raw.notes, 240),
    personaCapsule: normalizePhonePersonaCapsule(raw.personaCapsule || raw.persona || {}),
    translationProfile: normalizeTranslationProfile(raw.translationProfile || raw.translation),
    linkedCharacterId,
    linkedActorId: linkedActorId && linkedActorId !== linkedCharacterId ? linkedActorId : '',
    blocked: !!raw.blocked,
    blockedAt: Number(raw.blockedAt) || 0,
    blockReason: clean(raw.blockReason, 40),
    interceptSource: !!raw.interceptSource,
    createdAt: Number(raw.createdAt) || now,
    updatedAt: Number(raw.updatedAt) || now,
  };
}

export function normalizePhoneContactGroup(raw = {}, options = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const userId = clean(options.userId ?? raw.userId, 160);
  const ownerId = clean(options.ownerId ?? raw.ownerId, 160);
  const name = clean(raw.name || raw.title, 80);
  if (!name) return null;
  const now = Number(options.now) || Date.now();
  const memberIds = unique(asArray(raw.memberIds || raw.members)
    .map((member) => {
      const value = typeof member === 'object' ? member?.id || member?.contactId : member;
      return value ? makePhoneContactId(userId, ownerId, value) : '';
    }), MAX_GROUP_MEMBERS);
  return {
    id: makePhoneContactGroupId(userId, ownerId, raw.id || raw.groupId || options.idSource),
    ownerId,
    name,
    memberIds,
    avatar: normalizeContactAvatarUrl(raw.avatar || raw.avatarUrl),
    note: clean(raw.note || raw.description, 160),
    createdAt: Number(raw.createdAt) || now,
    updatedAt: Number(raw.updatedAt) || now,
  };
}

export function normalizeCharacterPhoneContacts(raw = {}, options = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const userId = clean(options.userId ?? source.userId, 160);
  const ownerId = clean(options.ownerId ?? source.ownerId, 160);
  const now = Number(options.now) || Date.now();
  const customCategories = normalizeCustomCategories(options.customCategories ?? source.customCategories);
  const contacts = [];
  const contactIdAliases = new Map();
  for (const [index, item] of asArray(source.contacts).slice(0, MAX_CONTACTS).entries()) {
    const contact = normalizePhoneContact(item, {
      userId,
      userName: options.userName,
      userAliases: options.userAliases,
      ownerId,
      ownerName: options.ownerName,
      ownerAliases: options.ownerAliases,
      now,
      customCategories,
      idSource: `contact_${index}`,
    });
    if (!contact) continue;
    const nameKey = phoneContactNameKey(contact.name);
    const duplicateIndex = contacts.findIndex((existing) => (
      existing.id === contact.id
      || (
        contact.linkedCharacterId
        && existing.linkedCharacterId === contact.linkedCharacterId
      )
      || (
        contact.linkedActorId
        && existing.linkedActorId === contact.linkedActorId
      )
      || (
        nameKey
        && phoneContactNameKey(existing.name) === nameKey
        && !contact.linkedCharacterId
        && !contact.linkedActorId
        && !existing.linkedCharacterId
        && !existing.linkedActorId
      )
    ));
    if (duplicateIndex >= 0) {
      const existing = contacts[duplicateIndex];
      const newer = contact.updatedAt >= existing.updatedAt ? contact : existing;
      const older = newer === contact ? existing : contact;
      contacts[duplicateIndex] = {
        ...older,
        ...newer,
        id: existing.id,
        linkedCharacterId: existing.linkedCharacterId || contact.linkedCharacterId,
        linkedActorId: existing.linkedActorId || contact.linkedActorId,
        createdAt: Math.min(existing.createdAt, contact.createdAt),
        updatedAt: Math.max(existing.updatedAt, contact.updatedAt),
      };
      contactIdAliases.set(contact.id, existing.id);
      continue;
    }
    contactIdAliases.set(contact.id, contact.id);
    contacts.push(contact);
  }
  const validContactIds = new Set(contacts.map((item) => item.id));
  const groups = [];
  const seenGroups = new Set();
  const seenMemberSets = new Set();
  for (const [index, item] of asArray(source.groups).slice(0, MAX_GROUPS).entries()) {
    const group = normalizePhoneContactGroup(item, {
      userId,
      ownerId,
      now,
      idSource: `group_${index}`,
    });
    if (!group || seenGroups.has(group.id)) continue;
    seenGroups.add(group.id);
    group.memberIds = unique(group.memberIds
      .map((id) => contactIdAliases.get(id) || id)
      .filter((id) => validContactIds.has(id)), MAX_GROUP_MEMBERS);
    const memberKey = phoneContactGroupMemberKey(group, contacts);
    // 旧存档里可能已经有同成员不同名的群；读取时只保留较早的一组，避免继续参与生成。
    if (memberKey && seenMemberSets.has(memberKey)) continue;
    if (memberKey) seenMemberSets.add(memberKey);
    groups.push(group);
  }
  return {
    version: CHARACTER_PHONE_CONTACTS_VERSION,
    userId,
    ownerId,
    // 用户本人不是手机联系人，单独保存角色给用户的备注，避免生成第二个 user/NPC 身份。
    userRemark: clean(source.userRemark, 80),
    userRemarkSource: ['ai', 'manual'].includes(source.userRemarkSource) ? source.userRemarkSource : '',
    customCategories,
    contacts,
    groups,
    removedLinkedCharacterIds: normalizeRemovedLinkedCharacterIds(source.removedLinkedCharacterIds),
    removedLinkedActorIds: normalizeRemovedLinkedActorIds(source.removedLinkedActorIds),
    updatedAt: Number(source.updatedAt) || now,
  };
}

export async function loadCharacterPhoneContacts(userId = '', ownerId = '') {
  const row = await db.get('settings', characterPhoneContactsSettingsKey(userId, ownerId)).catch(() => null);
  return normalizeCharacterPhoneContacts(row?.value, { userId, ownerId });
}

export async function saveCharacterPhoneContacts(userId = '', ownerId = '', value = {}) {
  const next = normalizeCharacterPhoneContacts({
    ...value,
    userId,
    ownerId,
    updatedAt: Date.now(),
  }, { userId, ownerId });
  await db.put('settings', {
    key: characterPhoneContactsSettingsKey(userId, ownerId),
    value: next,
  });
  return next;
}

function scopedEntrySuffix(kind = 'contact', userId = '', ownerId = '', entryId = '') {
  const raw = clean(entryId, 240);
  const prefix = scopedPrefix(kind, userId, ownerId);
  if (raw.startsWith(prefix)) return raw.slice(prefix.length);
  return localId(raw);
}

/**
 * 复制档位时只复制源身份名下真实存在的角色手机通讯录。
 * 联系人与群组 id 都带 user 作用域，必须换成新档 id；返回的映射
 * 供关系网与认识账本同步改写，避免副本指回源档。
 */
export async function duplicateCharacterPhoneContactBooks(sourceUserId = '', targetUserId = '') {
  const sourceId = clean(sourceUserId, 160);
  const targetId = clean(targetUserId, 160);
  if (!sourceId || !targetId || sourceId === targetId) {
    return { copiedBooks: 0, copiedContacts: 0, actorIdMap: {} };
  }
  const sourcePrefix = `${SETTINGS_PREFIX}${scopePart(sourceId, 'guest')}:`;
  const rows = (await db.getAllRecords('settings'))
    .filter((row) => String(row?.key || '').startsWith(sourcePrefix));
  const actorIdMap = new Map();
  let copiedBooks = 0;
  let copiedContacts = 0;

  for (const row of rows) {
    let ownerId = clean(row?.value?.ownerId, 160);
    if (!ownerId) {
      try {
        ownerId = clean(decodeURIComponent(String(row?.key || '').slice(sourcePrefix.length)), 160);
      } catch (_) {}
    }
    if (!ownerId) continue;
    const source = normalizeCharacterPhoneContacts(row.value, { userId: sourceId, ownerId });
    const contactMap = new Map(source.contacts.map((contact) => {
      const suffix = scopedEntrySuffix('contact', sourceId, ownerId, contact.id);
      return [contact.id, makePhoneContactId(targetId, ownerId, suffix)];
    }));
    contactMap.forEach((nextId, oldId) => actorIdMap.set(oldId, nextId));

    const contacts = source.contacts.map((contact) => ({
      ...contact,
      id: contactMap.get(contact.id) || contact.id,
      linkedActorId: contactMap.get(contact.linkedActorId) || contact.linkedActorId,
    }));
    const groups = source.groups.map((group) => ({
      ...group,
      id: makePhoneContactGroupId(
        targetId,
        ownerId,
        scopedEntrySuffix('group', sourceId, ownerId, group.id),
      ),
      memberIds: (group.memberIds || []).map((memberId) => contactMap.get(memberId) || memberId),
    }));
    const saved = await saveCharacterPhoneContacts(targetId, ownerId, {
      ...source,
      userId: targetId,
      contacts,
      groups,
      removedLinkedActorIds: (source.removedLinkedActorIds || [])
        .map((actorId) => contactMap.get(actorId) || actorId),
    });
    copiedBooks += 1;
    copiedContacts += saved.contacts.length;
  }

  return { copiedBooks, copiedContacts, actorIdMap: Object.fromEntries(actorIdMap) };
}

export async function savePhoneContactCategories(userId = '', ownerId = '', categories = []) {
  const state = await loadCharacterPhoneContacts(userId, ownerId);
  state.customCategories = normalizeCustomCategories(categories);
  return saveCharacterPhoneContacts(userId, ownerId, state);
}

/** 保存角色在自己手机里给用户的备注；只改显示元数据，不创建联系人或 actor。 */
export async function savePhoneUserRemark(userId = '', ownerId = '', remark = '', source = 'manual') {
  const state = await loadCharacterPhoneContacts(userId, ownerId);
  state.userRemark = clean(remark, 80);
  state.userRemarkSource = source === 'ai' ? 'ai' : 'manual';
  return saveCharacterPhoneContacts(userId, ownerId, state);
}

export async function listPhoneContacts(userId = '', ownerId = '', options = {}) {
  const state = await loadCharacterPhoneContacts(userId, ownerId);
  const category = clean(options.category, 24).toLowerCase();
  const groupId = clean(options.groupId, 240);
  const group = groupId ? state.groups.find((item) => item.id === groupId) : null;
  const allowed = group ? new Set(group.memberIds) : null;
  return state.contacts.filter((contact) => (
    (!category || contact.category === category)
    && (!allowed || allowed.has(contact.id))
  ));
}

export async function getPhoneContact(userId = '', ownerId = '', contactId = '') {
  const state = await loadCharacterPhoneContacts(userId, ownerId);
  const id = makePhoneContactId(userId, ownerId, contactId);
  const ref = clean(contactId, 240);
  return state.contacts.find((item) => (
    item.id === id || item.linkedCharacterId === ref || item.linkedActorId === ref
  )) || null;
}

export async function listPhoneContactGroups(userId = '', ownerId = '') {
  return (await loadCharacterPhoneContacts(userId, ownerId)).groups;
}

export async function getPhoneContactGroup(userId = '', ownerId = '', groupId = '') {
  const id = makePhoneContactGroupId(userId, ownerId, groupId);
  return (await loadCharacterPhoneContacts(userId, ownerId)).groups.find((item) => item.id === id) || null;
}

export async function upsertPhoneContact(userId = '', ownerId = '', partial = {}) {
  // 落库是最后一道身份边界：即使提示词或上游解析漏掉，用户本人和手机主人
  // 的真实姓名/别名也不能被写成新的轻量联系人。关键身份读取失败时中止写入。
  const [state, userRow, ownerRow] = await Promise.all([
    loadCharacterPhoneContacts(userId, ownerId),
    db.getRecord('users', clean(userId, 160)),
    db.getRecord('characters', clean(ownerId, 160)),
  ]);
  const identity = {
    userId,
    userName: clean(userRow?.name || userRow?.nickname || userRow?.displayName, 80),
    userAliases: [
      userRow?.name,
      userRow?.nickname,
      userRow?.displayName,
      ...(Array.isArray(userRow?.aliases) ? userRow.aliases : []),
    ],
    ownerId,
    ownerName: clean(ownerRow?.realName || ownerRow?.name || ownerRow?.customNickname, 80),
    ownerAliases: [
      ownerRow?.realName,
      ownerRow?.name,
      ownerRow?.customNickname,
      ...(Array.isArray(ownerRow?.aliases) ? ownerRow.aliases : []),
    ],
  };
  if (isPhoneUserImpersonator(partial, identity)) return null;
  const requestedId = partial?.id || partial?.contactId;
  const linkedId = clean(partial?.linkedCharacterId, 160);
  const linkedActorId = clean(partial?.linkedActorId || partial?.canonicalActorId, 240);
  const requestedName = clean(partial?.name || partial?.displayName || partial?.remarkName, 80);
  const requestedNameKey = phoneContactNameKey(requestedName);
  const scopedId = requestedId ? makePhoneContactId(userId, ownerId, requestedId) : '';
  const uniqueNameMatchId = requestedNameKey
    ? (() => {
      const matches = state.contacts.filter((item) => phoneContactNameKey(item.name) === requestedNameKey);
      return matches.length === 1 ? matches[0].id : '';
    })()
    : '';
  const index = state.contacts.findIndex((item) => (
    (scopedId && item.id === scopedId)
    || (linkedId && item.linkedCharacterId === linkedId)
    || (linkedActorId && item.linkedActorId === linkedActorId)
    || (
      requestedNameKey
      && phoneContactNameKey(item.name) === requestedNameKey
      && item.id === uniqueNameMatchId
      && (!linkedId || !item.linkedCharacterId || item.linkedCharacterId === linkedId)
      && (!linkedActorId || !item.linkedActorId || item.linkedActorId === linkedActorId)
    )
  ));
  const previous = index >= 0 ? state.contacts[index] : null;
  const next = normalizePhoneContact({
    ...previous,
    ...partial,
    id: previous?.id || scopedId || undefined,
    personaCapsule: {
      ...(previous?.personaCapsule || {}),
      ...(partial?.personaCapsule && typeof partial.personaCapsule === 'object' ? partial.personaCapsule : {}),
    },
    createdAt: previous?.createdAt || partial?.createdAt,
    updatedAt: Date.now(),
  }, {
    userId,
    ownerId,
    userName: identity.userName,
    userAliases: identity.userAliases,
    ownerName: identity.ownerName,
    ownerAliases: identity.ownerAliases,
    customCategories: state.customCategories,
  });
  if (!next) return null;
  if (index >= 0) state.contacts[index] = next;
  else state.contacts.unshift(next);
  // 主动加回主角色：从「已移除」黑名单摘掉，恢复可被自动联系
  const restoredLinked = clean(next.linkedCharacterId || linkedId, 160);
  if (restoredLinked && isPhoneLinkedCharacterRemoved(state, restoredLinked)) {
    state.removedLinkedCharacterIds = normalizeRemovedLinkedCharacterIds(
      (state.removedLinkedCharacterIds || []).filter((id) => id !== restoredLinked),
    );
  }
  const restoredActor = clean(next.linkedActorId || linkedActorId, 240);
  if (restoredActor && normalizeRemovedLinkedActorIds(state.removedLinkedActorIds).includes(restoredActor)) {
    state.removedLinkedActorIds = normalizeRemovedLinkedActorIds(
      (state.removedLinkedActorIds || []).filter((id) => id !== restoredActor),
    );
  }
  await saveCharacterPhoneContacts(userId, ownerId, state);
  return next;
}

/**
 * 用户实际发起私聊/建群时才把候选写进手机通讯录。
 * removedLinkedCharacterIds 只约束主角色；关系网 NPC 使用 linkedActorId 保持身份稳定。
 */
export async function ensurePhoneSocialActorContact(userId = '', ownerId = '', actor = {}) {
  const actorId = clean(actor?.canonicalId || actor?.id, 240);
  if (!actorId) return null;
  const state = await loadCharacterPhoneContacts(userId, ownerId);
  const existing = (state.contacts || []).find((item) => (
    phoneContactCanonicalActorId(item) === actorId
  ));
  if (existing) return existing;
  if (!canPhoneAutoContactLinkedPeer(state, actorId)) return null;
  const input = phoneSocialActorToContactInput(actor);
  return input ? upsertPhoneContact(userId, ownerId, input) : null;
}

/**
 * 主角色换头像后，把手机通讯录里指向 TA 的联系人快照一并更新，避免列表仍吃旧图。
 */
export async function syncPhoneContactAvatarsForCharacter(userId = '', ownerId = '', characterId = '', avatarUrl = '') {
  const cid = clean(characterId, 160);
  if (!userId || !ownerId || !cid) return 0;
  const nextAvatar = normalizeContactAvatarUrl(avatarUrl);
  const state = await loadCharacterPhoneContacts(userId, ownerId);
  let changed = 0;
  const contacts = (state.contacts || []).map((contact) => {
    if (contact?.linkedCharacterId !== cid) return contact;
    if ((contact.avatar || '') === nextAvatar) return contact;
    changed += 1;
    return { ...contact, avatar: nextAvatar, updatedAt: Date.now() };
  });
  if (!changed) return 0;
  await saveCharacterPhoneContacts(userId, ownerId, {
    ...state,
    contacts,
    updatedAt: Date.now(),
  });
  return changed;
}

/**
 * 角色卡头像变化后同步该用户所有角色手机中的联系人快照。
 * 部分手机消息链路没有完整角色表，只能读取联系人快照；不做全局同步时会继续显示旧头像。
 */
export async function syncPhoneContactAvatarsAcrossOwners(userId = '', characterId = '', avatarUrl = '') {
  const uid = clean(userId, 160);
  const cid = clean(characterId, 240);
  if (!uid || !cid) return 0;
  const nextAvatar = normalizeContactAvatarUrl(avatarUrl);
  const prefix = `${SETTINGS_PREFIX}${scopePart(uid, 'guest')}:`;
  const rows = await db.getAllRecords('settings').catch(() => []);
  let changed = 0;
  for (const row of (Array.isArray(rows) ? rows : [])) {
    const key = String(row?.key || '');
    if (!key.startsWith(prefix)) continue;
    const result = await db.updateRecord('settings', key, (current) => {
      const value = current?.value;
      if (!value || typeof value !== 'object') return null;
      let rowChanged = 0;
      const contacts = asArray(value.contacts).map((contact) => {
        const linkedCharacterId = clean(contact?.linkedCharacterId, 160);
        const linkedActorId = clean(contact?.linkedActorId || contact?.canonicalActorId, 240);
        if (linkedCharacterId !== cid && linkedActorId !== cid) return contact;
        if (normalizeContactAvatarUrl(contact?.avatar) === nextAvatar) return contact;
        rowChanged += 1;
        return { ...contact, avatar: nextAvatar, updatedAt: Date.now() };
      });
      if (!rowChanged) return null;
      changed += rowChanged;
      return {
        ...current,
        value: {
          ...value,
          contacts,
          updatedAt: Date.now(),
        },
      };
    });
    if (!result?.updated) continue;
  }
  return changed;
}

/**
 * 删除手机联系人时需要同时处理的身份引用。
 * 联系人自己的 id、linkedActorId，以及旧版把 lightnpc 写进 linkedCharacterId /
 * 本地 id 尾段的情况都要覆盖，否则通讯录行删了，关系网身份和记忆仍会反复冒回。
 */
export function collectPhoneContactRemovalRefs(contacts = []) {
  const linkedCharacterIds = new Set();
  const linkedActorIds = new Set();
  const networkActorIds = new Set();
  const lightweightNpcIds = new Set();
  const markActor = (value) => {
    const id = clean(value, 240);
    if (!id) return;
    networkActorIds.add(id);
    if (/^lightnpc_/i.test(id)) lightweightNpcIds.add(id);
  };
  for (const contact of asArray(contacts)) {
    const contactId = clean(contact?.id, 240);
    const linkedCharacterId = clean(contact?.linkedCharacterId, 160);
    const linkedActorId = clean(
      contact?.linkedActorId || contact?.canonicalActorId,
      240,
    );
    if (contactId) networkActorIds.add(contactId);
    if (linkedCharacterId) linkedCharacterIds.add(linkedCharacterId);
    if (linkedActorId) {
      linkedActorIds.add(linkedActorId);
      markActor(linkedActorId);
    }
    if (/^lightnpc_/i.test(linkedCharacterId)) markActor(linkedCharacterId);
    try {
      const local = decodeURIComponent(String(contactId || '').split(':').pop() || '');
      if (/^lightnpc_/i.test(local)) markActor(local);
    } catch (_) { /* 非法旧 id 不影响其它联系人删除 */ }
  }
  return {
    linkedCharacterIds: [...linkedCharacterIds],
    linkedActorIds: [...linkedActorIds],
    networkActorIds: [...networkActorIds],
    lightweightNpcIds: [...lightweightNpcIds],
  };
}

/**
 * 从手机通讯录批量删除联系人（不删主通讯录角色）。
 * contactIds 可传本地联系人 id，或已链接的主角色 id。
 * 若删到已链接主角色，会写入 removedLinkedCharacterIds，避免 seed/整机动态再自动加回。
 */
export async function deletePhoneContacts(userId = '', ownerId = '', contactIds = []) {
  const refs = unique(asArray(contactIds).map((id) => clean(id, 240)), MAX_CONTACTS);
  if (!refs.length) return { deleted: 0, contactIds: [] };
  const state = await loadCharacterPhoneContacts(userId, ownerId);
  const drop = new Set();
  for (const ref of refs) {
    const scoped = makePhoneContactId(userId, ownerId, ref);
    for (const contact of state.contacts) {
      if (contact.id === ref
        || contact.id === scoped
        || contact.linkedCharacterId === ref
        || contact.linkedActorId === ref) {
        drop.add(contact.id);
      }
    }
  }
  if (!drop.size) return { deleted: 0, contactIds: [] };
  const removed = state.contacts.filter((item) => drop.has(item.id));
  const removalRefs = collectPhoneContactRemovalRefs(removed);
  const removedLinked = unique(removalRefs.linkedCharacterIds, MAX_REMOVED_LINKED);
  const removedActors = unique(removalRefs.linkedActorIds, MAX_REMOVED_LINKED);
  const next = {
    ...state,
    contacts: state.contacts.filter((item) => !drop.has(item.id)),
    groups: state.groups.map((group) => ({
      ...group,
      memberIds: (group.memberIds || []).filter((id) => !drop.has(id)),
      updatedAt: Date.now(),
    })),
    removedLinkedCharacterIds: normalizeRemovedLinkedCharacterIds([
      ...(state.removedLinkedCharacterIds || []),
      ...removedLinked,
    ]),
    removedLinkedActorIds: normalizeRemovedLinkedActorIds([
      ...(state.removedLinkedActorIds || []),
      ...removedActors,
    ]),
    updatedAt: Date.now(),
  };
  await saveCharacterPhoneContacts(userId, ownerId, next);

  // 同步清关系网：角色卡提取的联系人会以 phone-contact: id 写进关系网节点，
  // 只删手机通讯录不 prune 的话，「管理成员」勾选列表还会残留。
  // 另：联系人由轻量 NPC 转入时，同步 dismiss，避免同名又被建回。
  try {
    const { dismissLightweightNpc, isLightweightNpcId } = await import('./lightweight-npc.js');
    const { pruneActorsFromRelationshipNetwork } = await import('./relationship-network.js');
    const networkIds = new Set(removalRefs.networkActorIds);
    const candidates = new Set(
      removalRefs.lightweightNpcIds.filter((id) => isLightweightNpcId(id)),
    );
    for (const npcId of candidates) {
      const contact = removed.find((item) => (
        clean(item?.linkedActorId || item?.canonicalActorId, 240) === npcId
        || clean(item?.linkedCharacterId, 160) === npcId
        || String(item?.id || '').includes(npcId)
      ));
        networkIds.delete(npcId); // dismiss 内部会 prune，避免重复写库
        await dismissLightweightNpc(npcId, {
          name: contact?.name || '',
          global: true,
        }).catch(() => null);
    }
    if (networkIds.size) {
      await pruneActorsFromRelationshipNetwork([...networkIds]).catch(() => null);
    }
  } catch (_) { /* 轻量 NPC / 关系网模块不可用时至少已删通讯录条目 */ }

  return {
    deleted: drop.size,
    contactIds: [...drop],
    removedLinkedCharacterIds: removedLinked,
    removedLinkedActorIds: removedActors,
  };
}

/**
 * 从手机通讯录「移除」已链接的主角色（不是删除角色本体）。
 * - 去掉通讯录条目与群成员引用
 * - 记入 removedLinkedCharacterIds，未主动加回前自动联系路径会跳过
 * - 不拆关系网「认识」、不删主通讯录角色、默认不删已有会话
 */
export async function removePhoneLinkedCharacters(userId = '', ownerId = '', characterIds = []) {
  const refs = unique(asArray(characterIds).map((id) => clean(id, 160)).filter(Boolean), MAX_CONTACTS);
  if (!refs.length) return { removed: 0, characterIds: [] };
  const state = await loadCharacterPhoneContacts(userId, ownerId);
  const drop = new Set();
  const linkedHit = new Set();
  for (const ref of refs) {
    for (const contact of state.contacts) {
      if (contact.linkedCharacterId === ref) {
        drop.add(contact.id);
        linkedHit.add(ref);
      }
    }
    // 即使当前列表里已经没有条目，也写入黑名单，挡住后续自动补回
    linkedHit.add(ref);
  }
  const next = {
    ...state,
    contacts: state.contacts.filter((item) => !drop.has(item.id)),
    groups: state.groups.map((group) => ({
      ...group,
      memberIds: (group.memberIds || []).filter((id) => !drop.has(id)),
      updatedAt: Date.now(),
    })),
    removedLinkedCharacterIds: normalizeRemovedLinkedCharacterIds([
      ...(state.removedLinkedCharacterIds || []),
      ...linkedHit,
    ]),
    updatedAt: Date.now(),
  };
  await saveCharacterPhoneContacts(userId, ownerId, next);
  return { removed: linkedHit.size, characterIds: [...linkedHit], contactIds: [...drop] };
}

/**
 * 删除手机轻量群定义（不删主通讯录角色）。
 * 仅移除 phoneContacts.groups 条目；会话需由调用方自行 deleteChatWithData。
 */
export async function deletePhoneContactGroups(userId = '', ownerId = '', groupIds = []) {
  const refs = unique(asArray(groupIds).map((id) => clean(id, 240)), MAX_GROUPS);
  if (!refs.length) return { deleted: 0, groupIds: [] };
  const state = await loadCharacterPhoneContacts(userId, ownerId);
  const drop = new Set();
  for (const ref of refs) {
    const scoped = makePhoneContactGroupId(userId, ownerId, ref);
    for (const group of state.groups) {
      if (group.id === ref || group.id === scoped) drop.add(group.id);
    }
  }
  if (!drop.size) return { deleted: 0, groupIds: [] };
  await saveCharacterPhoneContacts(userId, ownerId, {
    ...state,
    groups: state.groups.filter((item) => !drop.has(item.id)),
    updatedAt: Date.now(),
  });
  return { deleted: drop.size, groupIds: [...drop] };
}

/**
 * 用成员集合（优先）或群名，把幕后群会话对上手机通讯录里的轻量群定义。
 */
export function matchPhoneContactGroupForChat(ownerId = '', chat = null, groups = [], contacts = []) {
  if (!chat || chat.type !== 'group') return null;
  const list = asArray(groups);
  const contactList = asArray(contacts);
  const parts = asArray(chat.participants).map((id) => clean(id, 240)).filter(Boolean);
  if (!parts.length || !list.length) return null;

  const byMembers = list.find((group) => {
    const peers = resolvePhoneGroupParticipantIds(ownerId, group, contactList);
    return peers.length >= 2
      && peers.every((id) => parts.includes(id))
      && parts.includes(clean(ownerId, 160));
  });
  if (byMembers) return byMembers;

  const title = clean(chat.groupSettings?.name || chat.title, 80);
  if (!title) return null;
  return list.find((group) => clean(group?.name, 80) === title) || null;
}

function matchUnambiguousPhoneContactGroupForChat(ownerId = '', chat = null, groups = [], contacts = []) {
  if (!chat || chat.type !== 'group') return null;
  const list = asArray(groups);
  const parts = unique(asArray(chat.participants)
    .map((id) => clean(id, 240))
    .filter((id) => id && id !== 'user'), MAX_GROUP_MEMBERS + 1);
  const memberMatches = list.filter((group) => {
    const peers = resolvePhoneGroupParticipantIds(ownerId, group, contacts);
    return peers.length >= 2
      && peers.length === parts.length
      && peers.every((id) => parts.includes(id))
      && parts.includes(clean(ownerId, 160));
  });
  if (memberMatches.length === 1) return memberMatches[0];
  const title = clean(chat.groupSettings?.name || chat.title, 80);
  const titleMatches = memberMatches
    .filter((group) => title && clean(group?.name, 80) === title);
  return titleMatches.length === 1 ? titleMatches[0] : null;
}

/**
 * 解析真实群聊与角色手机轻量群的稳定绑定。新数据优先使用 metadata 中的 ID；
 * 旧数据只在“群主/成员手机里恰好命中唯一群定义”时自动认领，避免同成员多群串写。
 */
export async function resolvePhoneContactGroupBinding(userId = '', chat = null, options = {}) {
  if (!userId || !chat || chat.type !== 'group') return null;
  const linkedGroupId = clean(chat.metadata?.phoneContactGroupId, 240);
  const linkedOwnerId = clean(chat.metadata?.phoneOwnerId, 160);
  const preferredOwnerId = clean(options.ownerId, 160);
  const ownerCandidates = unique(preferredOwnerId ? [preferredOwnerId] : [
    linkedOwnerId,
    clean(chat.groupSettings?.owner, 160),
    ...asArray(chat.participants).map((id) => clean(id, 160)).filter((id) => id && id !== 'user'),
  ], 12);
  const hits = [];
  for (const ownerId of ownerCandidates) {
    const state = await loadCharacterPhoneContacts(userId, ownerId).catch(() => null);
    if (!state) continue;
    const group = linkedGroupId
      ? asArray(state.groups).find((item) => item?.id === makePhoneContactGroupId(userId, ownerId, linkedGroupId))
      : matchUnambiguousPhoneContactGroupForChat(ownerId, chat, state.groups, state.contacts);
    if (!group?.id) continue;
    hits.push({ ownerId, groupId: group.id, group, state });
    if (linkedGroupId && linkedOwnerId === ownerId) return hits[0];
  }
  const uniqueHits = [...new Map(hits.map((hit) => [`${hit.ownerId}\0${hit.groupId}`, hit])).values()];
  return uniqueHits.length === 1 ? uniqueHits[0] : null;
}

/**
 * 群管事件落地后，把群名、成员和头像同步回角色手机的轻量群定义。
 * 返回 binding 供调用方把旧群补写成稳定 ID 关联。
 */
export async function syncPhoneContactGroupFromChat(userId = '', chat = null, options = {}) {
  const binding = await resolvePhoneContactGroupBinding(userId, chat, options);
  if (!binding) return { synced: false, reason: 'binding-not-found' };
  let state = binding.state;
  const ownerId = binding.ownerId;
  const participantIds = unique(asArray(chat.participants)
    .map((id) => clean(id, 240))
    .filter((id) => id && id !== 'user' && id !== ownerId), MAX_GROUP_MEMBERS);

  for (const actorId of participantIds) {
    const exists = asArray(state.contacts).some((contact) => (
      phoneContactCanonicalActorId(contact) === actorId
    ));
    if (exists) continue;
    const character = await db.getRecord('characters', actorId).catch(() => null);
    if (!character) continue;
    await upsertPhoneContact(userId, ownerId, {
      name: clean(character.realName || character.name || actorId, 80),
      avatar: character.avatar || character.avatarUrl || '',
      linkedCharacterId: actorId,
      category: 'friend',
    }).catch(() => null);
    state = await loadCharacterPhoneContacts(userId, ownerId).catch(() => state);
  }

  const memberIds = participantIds.map((actorId) => (
    asArray(state.contacts).find((contact) => phoneContactCanonicalActorId(contact) === actorId)?.id || ''
  )).filter(Boolean);
  const currentGroup = asArray(state.groups).find((item) => item?.id === binding.groupId) || binding.group;
  const saved = await upsertPhoneContactGroup(userId, ownerId, {
    id: binding.groupId,
    name: clean(chat.groupSettings?.name || currentGroup?.name || '群聊', 80),
    memberIds,
    avatar: chat.groupSettings?.avatar || currentGroup?.avatar || '',
    note: currentGroup?.note || '',
  });
  return saved
    ? { synced: true, ownerId, groupId: saved.id, group: saved }
    : { synced: false, reason: 'group-save-failed' };
}

/**
 * 把手机轻量 NPC 转正为用户主通讯录角色，并写回 linkedCharacterId。
 * 已链接则直接返回现有角色。
 */
async function runPhoneContactPromotion(userId = '', ownerId = '', contactId = '', options = {}) {
  const { getCharacter, saveCharacter } = await import('./character-store.js');
  const { createCharacterProfile } = await import('../models/character.js');
  const { resolveCharacterGroupId } = await import('./contact-groups.js');
  const contact = await getPhoneContact(userId, ownerId, contactId);
  if (!contact) throw new Error('联系人不存在');
  if (contact.linkedCharacterId) {
    const existing = await getCharacter(contact.linkedCharacterId);
    if (existing) {
      return { character: existing, contact, alreadyLinked: true };
    }
  }
  const capsule = contact.personaCapsule || {};
  const owner = ownerId ? await getCharacter(ownerId).catch(() => null) : null;
  const groupId = options.groupId
    || (owner ? resolveCharacterGroupId(owner) : 'default');
  const relationship = clean(
    options.relationship || capsule.relationship || '朋友',
    120,
  );
  const summary = clean(capsule.summary || contact.note, 280);
  const traitsLine = asArray(capsule.traits).map((item) => clean(item, 32)).filter(Boolean).join('、');
  const noteParts = [
    summary,
    traitsLine ? `特质：${traitsLine}` : '',
    clean(capsule.boundary, 120),
    clean(contact.note, 240),
  ].filter(Boolean);
  const notes = [...new Set(noteParts)].join('\n');
  const created = await saveCharacter(createCharacterProfile({
    name: contact.name || contact.nickname || '未命名',
    customNickname: contact.nickname || '',
    avatar: contact.avatar || null,
    notes,
    personality: summary,
    speechStyle: clean(capsule.speechStyle, 120),
    translationProfile: contact.translationProfile,
    roleTier: 'npc',
    groupId,
    relationships: ownerId && relationship ? { [ownerId]: relationship } : {},
  }));
  if (owner && relationship) {
    await saveCharacter({
      ...owner,
      relationships: {
        ...(owner.relationships || {}),
        [created.id]: relationship,
      },
    });
  }
  const nextContact = await upsertPhoneContact(userId, ownerId, {
    id: contact.id,
    name: contact.name || created.name,
    nickname: contact.nickname || '',
    avatar: contact.avatar || created.avatar || '',
    linkedCharacterId: created.id,
    category: contact.category,
    personaCapsule: capsule,
    translationProfile: contact.translationProfile,
  });
  // 转正不是只改通讯录卡片：既有角色手机会话可能仍引用 contact.id / linkedActorId。
  // 先把联系人亲历的旧手机聊天沉淀到正式角色，再收敛会话参与者，保证之后从
  // 用户主号或马甲聊天、以及回到角色手机推进时都指向同一个人。
  try {
    const { syncPhoneContactConversationMemory } = await import('./phone-contact-memory.js');
    await syncPhoneContactConversationMemory({
      userId,
      ownerId,
      ownerName: owner?.realName || owner?.name || '',
      contact: nextContact || contact,
      targetCharacterId: created.id,
    });
  } catch (error) {
    console.warn('[phone-contact] promotion memory sync failed', error);
  }
  try {
    const { reconcilePhoneContactNpcIdentities } = await import('./character-phone-messages.js');
    await reconcilePhoneContactNpcIdentities(userId, ownerId);
  } catch (error) {
    console.warn('[phone-contact] promotion identity reconcile failed', error);
  }
  return { character: created, contact: nextContact, alreadyLinked: false };
}

export async function promotePhoneContactToCharacter(userId = '', ownerId = '', contactId = '', options = {}) {
  const key = [
    clean(userId, 160),
    clean(ownerId, 160),
    makePhoneContactId(userId, ownerId, contactId),
  ].join('\0');
  const pending = phoneContactPromotionTasks.get(key);
  if (pending) return pending;
  const task = runPhoneContactPromotion(userId, ownerId, contactId, options);
  phoneContactPromotionTasks.set(key, task);
  try {
    return await task;
  } finally {
    if (phoneContactPromotionTasks.get(key) === task) {
      phoneContactPromotionTasks.delete(key);
    }
  }
}

/**
 * 联系人列表按 canonical actor 去重；本地 phone-contact id 与 linkedActorId /
 * linkedCharacterId 指向同一人时只能渲染一行。
 */
export function phoneContactDisplayActorId(rowId = '', contacts = []) {
  const id = clean(rowId, 240);
  if (!id) return '';
  const contact = asArray(contacts).find((item) => (
    clean(item?.id, 240) === id
    || clean(item?.linkedCharacterId, 160) === id
    || clean(item?.linkedActorId, 240) === id
  ));
  return contact ? phoneContactCanonicalActorId(contact) : id;
}

/**
 * 用会话参与者 id 找手机联系人。兼容旧版本把较长 phone-contact id 截短后
 * 已经写进聊天 participants 的存档；这种情况下两边只要互为前缀，仍视为同一身份。
 */
export function findPhoneContactByActorId(contacts = [], actorId = '') {
  const id = clean(actorId, 240);
  if (!id) return null;
  const exactMatches = [];
  const legacyPrefixMatches = [];
  for (const item of asArray(contacts)) {
    const contactId = clean(item?.id, 240);
    const linkedCharacterId = clean(item?.linkedCharacterId, 160);
    const linkedActorId = clean(item?.linkedActorId || item?.canonicalActorId, 240);
    if (contactId === id || linkedCharacterId === id || linkedActorId === id) {
      exactMatches.push(item);
      continue;
    }
    if (relationshipActorIdsMatch(contactId, id)
      || relationshipActorIdsMatch(linkedActorId, id)) {
      legacyPrefixMatches.push(item);
    }
  }
  if (exactMatches.length) return exactMatches[0];
  // 旧版 60 字截断可能只剩下 user/owner 公共前缀，同时命中整本通讯录。
  // 只有唯一候选才能用于姓名与头像；有歧义时交给历史别名/发送者姓名继续解析。
  return legacyPrefixMatches.length === 1 ? legacyPrefixMatches[0] : null;
}

/**
 * 手机群去重键：联系人已关联主角色时以主角色 id 比较，其余使用本地联系人 id。
 * 因而同一批成员的排序、备注或群名变化不会制造第二个群。
 */
export function phoneContactGroupMemberKey(group = {}, contacts = []) {
  const byId = new Map(asArray(contacts).map((contact) => [contact?.id, contact]));
  return unique(asArray(group?.memberIds || group?.members).map((ref) => {
    const id = typeof ref === 'object' ? ref?.id || ref?.contactId : ref;
    const contact = byId.get(id);
    return clean(contact ? phoneContactCanonicalActorId(contact) : id, 240);
  }).filter(Boolean)).sort().join(',');
}

export async function upsertPhoneContactGroup(userId = '', ownerId = '', partial = {}) {
  const state = await loadCharacterPhoneContacts(userId, ownerId);
  const requestedId = partial?.id || partial?.groupId;
  const scopedId = requestedId ? makePhoneContactGroupId(userId, ownerId, requestedId) : '';
  const name = clean(partial?.name || partial?.title, 80);
  const memberKey = phoneContactGroupMemberKey(partial, state.contacts);
  const index = state.groups.findIndex((item) => (
    (scopedId && item.id === scopedId)
    || (!requestedId && memberKey && phoneContactGroupMemberKey(item, state.contacts) === memberKey)
    || (!requestedId && !memberKey && name && item.name === name)
  ));
  const previous = index >= 0 ? state.groups[index] : null;
  const next = normalizePhoneContactGroup({
    ...previous,
    ...partial,
    id: previous?.id || scopedId || undefined,
    // 同一成员集合命中的是既有群：保留用户已经确认的群名，模型换个文案不能再裂变或改名。
    name: previous && !scopedId && memberKey ? previous.name : (partial?.name || partial?.title),
    createdAt: previous?.createdAt || partial?.createdAt,
    updatedAt: Date.now(),
  }, { userId, ownerId });
  if (!next) return null;
  const validIds = new Set(state.contacts.map((item) => item.id));
  next.memberIds = next.memberIds.filter((id) => validIds.has(id));
  if (index >= 0) state.groups[index] = next;
  else state.groups.unshift(next);
  await saveCharacterPhoneContacts(userId, ownerId, state);
  return next;
}

function characterRows(characters) {
  if (characters instanceof Map) return [...characters.values()];
  if (Array.isArray(characters)) return characters;
  return characters && typeof characters === 'object' ? Object.values(characters) : [];
}

function characterById(characters, id) {
  if (!id) return null;
  if (characters instanceof Map) return characters.get(id) || null;
  if (Array.isArray(characters)) return characters.find((item) => item?.id === id) || null;
  return characters?.[id] || null;
}

function characterDisplayName(character, fallback = '') {
  // 手机侧显示真名：realName > name；不用通讯录备注 customNickname
  return clean(character?.realName || character?.name || fallback, 80);
}

/**
 * 已链接主角色时以角色卡头像为准；轻量 NPC 才用联系人快照。
 * （添加联系人时会拷贝当时 avatar，若读侧优先快照会换头像不更新。）
 */
export function resolvePhoneContactAvatar(contact = null, characters = null) {
  const linkedId = clean(contact?.linkedCharacterId, 160);
  const linked = linkedId ? characterById(characters, linkedId) : null;
  return normalizeContactAvatarUrl(
    linked?.avatar || linked?.avatarUrl || contact?.avatar || contact?.avatarUrl || '',
  );
}

/**
 * 将消息 actorId 解析为手机联系人、已链接主角色、手机主人或用户的展示信息。
 * 手机 UI 优先真名：轻量联系人用 name（姓名），已链接角色用 realName||name；nickname 仅作备注不进主显示。
 */
export function resolvePhoneActorDisplay(actorId = '', options = {}) {
  const id = clean(actorId, 240);
  const contacts = asArray(options.contacts);
  const ownerId = clean(options.ownerId, 160);
  const contact = contacts.find((item) => (
    item?.id === id || item?.linkedCharacterId === id || item?.linkedActorId === id
  )) || null;
  const linkedCharacter = characterById(options.characters, contact?.linkedCharacterId);
  const directCharacter = characterById(options.characters, id);
  const character = linkedCharacter || directCharacter;
  const isUser = id === 'user' || (!!options.user?.id && id === String(options.user.id));
  const isOwner = !!ownerId && id === ownerId;
  const fallback = clean(options.fallback || id || '未知联系人', 80);
  const trueName = (isUser ? clean(options.userName || options.user?.displayName || options.user?.name || '用户', 80) : '')
    || clean(contact?.name || '', 80)
    || characterDisplayName(character, isOwner ? clean(options.ownerName, 80) : '')
    || clean(contact?.nickname || '', 80)
    || fallback;
  const remark = isUser
    ? clean(options.userRemark, 80)
    : clean(contact?.remark || contact?.remarkName, 80);
  return {
    actorId: id,
    // 公共解析器继续返回真名；需要展示备注的 UI 显式读取 displayName。
    name: trueName,
    displayName: remark || trueName,
    trueName,
    remark,
    avatar: (isUser ? normalizeContactAvatarUrl(options.user?.avatar || options.user?.avatarUrl || '') : '')
      || normalizeContactAvatarUrl(character?.avatar || character?.avatarUrl || '')
      || resolvePhoneContactAvatar(contact, options.characters)
      || '',
    contactId: contact?.id || '',
    linkedCharacterId: contact?.linkedCharacterId || character?.id || '',
    linkedActorId: contact?.linkedActorId || '',
    category: contact?.category || '',
    personaCapsule: contact?.personaCapsule || null,
    isUser,
    isOwner,
    source: contact ? 'phone-contact' : (character ? 'character' : (isUser ? 'user' : 'fallback')),
  };
}

export function resolvePhoneActorDisplayName(actorId = '', options = {}) {
  return resolvePhoneActorDisplay(actorId, options).name;
}

/** 将轻量联系人转成主聊天上下文可识别的角色卡，保持外语档案等手机侧人设一致。 */
export function buildPhoneLightContactCharacter(contact = {}, ownerId = '') {
  const capsule = contact?.personaCapsule || {};
  const displayName = contact.name || contact.nickname || contact.id;
  const nickname = clean(contact.nickname, 80);
  const aliases = unique([
    nickname && nickname !== displayName ? nickname : '',
  ].filter(Boolean), 8);
  return {
    id: contact.id,
    name: displayName,
    customNickname: nickname && nickname !== displayName ? nickname : '',
    realName: contact.name || '',
    phoneRemark: clean(contact.remark || contact.remarkName, 80),
    aliases,
    avatar: normalizeContactAvatarUrl(contact.avatar || contact.avatarUrl || ''),
    personality: [capsule.summary, capsule.relationship, ...(capsule.traits || [])].filter(Boolean).join('；'),
    speechStyle: capsule.speechStyle || '',
    notes: [
      contact.note,
      nickname && nickname !== contact.name ? `备注:${nickname}` : '',
      capsule.boundary,
    ].filter(Boolean).join('；'),
    userRelationStatus: capsule.relationship || '',
    translationProfile: normalizeTranslationProfile(contact.translationProfile),
    metadata: { isPhoneLightContact: true, ownerId },
    _phoneLightContact: true,
  };
}

/**
 * 把手机通讯录编成 actor 解析用的通讯录行。
 * 已链接主角色：用 linkedCharacterId 并带上手机侧姓名别名；纯轻量联系人：用 phone-contact id。
 */
export function buildPhoneContactsAddressBook(contacts = [], ownerId = '') {
  const rows = [];
  const seen = new Set();
  for (const contact of Array.isArray(contacts) ? contacts : []) {
    if (!contact) continue;
    const linkedId = clean(contact.linkedCharacterId, 160);
    const linkedActorId = clean(contact.linkedActorId, 240);
    const canonicalId = linkedId || linkedActorId;
    if (canonicalId) {
      if (seen.has(canonicalId)) continue;
      seen.add(canonicalId);
      const nickname = clean(contact.nickname, 80);
      const name = clean(contact.name, 80) || nickname || linkedId;
      rows.push({
        id: canonicalId,
        name,
        realName: clean(contact.name, 80) || name,
        customNickname: nickname && nickname !== name ? nickname : '',
        phoneRemark: clean(contact.remark || contact.remarkName, 80),
        aliases: unique([nickname && nickname !== name ? nickname : ''].filter(Boolean), 8),
        metadata: {
          fromPhoneContact: true,
          ownerId,
          phoneContactId: contact.id,
          ...(linkedActorId ? { isRelationshipNpc: true } : {}),
        },
      });
      continue;
    }
    if (!contact.id || seen.has(contact.id)) continue;
    seen.add(contact.id);
    const built = buildPhoneLightContactCharacter(contact, ownerId);
    if (built) rows.push(built);
  }
  return rows;
}

export function createPhoneActorDisplayMap(actorIds = [], options = {}) {
  const ids = unique([
    ...asArray(actorIds).map((id) => clean(id, 240)),
    ...asArray(options.contacts).map((item) => item?.id),
    ...characterRows(options.characters).map((item) => item?.id),
  ]);
  return Object.fromEntries(ids.map((id) => [id, resolvePhoneActorDisplay(id, options)]));
}

function parseSeed(seed) {
  if (typeof seed !== 'string') return seed && typeof seed === 'object' ? seed : {};
  if (seed.length > MAX_SEED_CHARS) return {};
  try {
    const parsed = JSON.parse(seed);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

/**
 * 把有界 AI JSON 输出转换为规范化联系人数据。无 I/O、无 API 调用。
 * 按真名把种子联系人绑到关系网/主通讯录已有角色，避免同名轻量替身。
 * 只补 linkedCharacterId；群 memberIds 仍保持本地联系人 id。
 * knownCharacters: [{ id, name }]
 */
export function rematchPhoneContactsToKnownCharacters(state = {}, knownCharacters = []) {
  const known = asArray(knownCharacters)
    .map((row) => ({
      id: clean(row?.id, 160),
      name: clean(row?.name || row?.realName, 80),
    }))
    .filter((row) => row.id && row.name);
  if (!known.length) return state;
  const removedLinked = new Set(normalizeRemovedLinkedCharacterIds(state?.removedLinkedCharacterIds));

  const directory = createPhoneSocialActorDirectory({
    characters: known,
    removedLinkedCharacterIds: [...removedLinked],
  });
  const matchKnownId = (ref = '', name = '') => {
    const key = clean(ref, 160);
    if (key && removedLinked.has(key)) return '';
    if (key && known.some((row) => row.id === key)) return key;
    const nm = clean(name || ref, 80);
    if (!nm) return '';
    const resolved = directory.resolve('', { name: nm });
    if (resolved?.kind === 'character') {
      const id = resolved.id;
      return removedLinked.has(id) ? '' : id;
    }
    return '';
  };

  const contacts = asArray(state.contacts).map((item) => {
    if (!item || typeof item !== 'object') return item;
    const linked = clean(item.linkedCharacterId, 160) || matchKnownId(item.id, item.name || item.nickname);
    if (!linked || removedLinked.has(linked)) {
      if (clean(item.linkedCharacterId, 160) && removedLinked.has(clean(item.linkedCharacterId, 160))) {
        return { ...item, linkedCharacterId: '' };
      }
      return item;
    }
    return {
      ...item,
      linkedCharacterId: linked,
      name: item.name || known.find((row) => row.id === linked)?.name || item.name,
    };
  });

  return {
    ...state,
    contacts,
  };
}

/**
 * 群聊建窗用：本地联系人 id → linkedCharacterId（真角色）优先。
 */
export function resolvePhoneGroupParticipantIds(ownerId = '', group = {}, contacts = []) {
  const oid = clean(ownerId, 160);
  const byId = new Map(asArray(contacts).map((item) => [item.id, item]));
  const members = asArray(group?.memberIds || group?.members)
    .map((member) => {
      const ref = clean(typeof member === 'object'
        ? member?.id || member?.contactId || member?.linkedCharacterId
        : member, 160);
      if (!ref || ref === oid || ref === 'user') return '';
      const contact = byId.get(ref);
      if (contact) return phoneContactCanonicalActorId(contact);
      // 已是真角色 id，或轻量本地 id
      return ref;
    })
    .filter(Boolean);
  return [...new Set([oid, ...members].filter(Boolean))];
}

export function buildCharacterPhoneContactsFromSeed(seed, options = {}) {
  const source = parseSeed(seed);
  const userId = clean(options.userId ?? source.userId, 160);
  const ownerId = clean(options.ownerId ?? source.ownerId, 160);
  const userIdentity = {
    userId,
    userName: clean(options.userName, 80),
    userAliases: options.userAliases,
    ownerId,
    ownerName: clean(options.ownerName, 80),
    ownerAliases: options.ownerAliases,
  };
  const now = Number(options.now) || Date.now();
  const knownCharacters = asArray(options.knownCharacters);
  const removedLinked = new Set(normalizeRemovedLinkedCharacterIds(options.removedLinkedCharacterIds));
  const knownById = new Map(knownCharacters.map((row) => [clean(row?.id, 160), row]).filter(([id]) => id));
  const knownDirectory = createPhoneSocialActorDirectory({
    ownerId,
    characters: knownCharacters,
    removedLinkedCharacterIds: [...removedLinked],
  });
  const resolveKnownId = (ref = '', name = '') => {
    const key = clean(ref, 160);
    if (key && removedLinked.has(key)) return '';
    if (key && knownById.has(key)) return key;
    const nm = clean(name || ref, 80);
    const resolved = knownDirectory.resolve('', { name: nm });
    if (resolved?.kind === 'character') {
      const id = resolved.id;
      return removedLinked.has(id) ? '' : id;
    }
    return '';
  };

  const rawContacts = asArray(source.contacts || source.people).slice(0, MAX_CONTACTS);
  const contacts = [];
  const referenceMap = new Map(); // 任意引用 → 本地联系人 id
  const linkedToLocal = new Map(); // 真角色 id → 本地联系人 id
  const usedKnownIds = new Set();
  for (const [index, item] of rawContacts.entries()) {
    if (!item || typeof item !== 'object') continue;
    const rawReference = clean(item.id || item.contactId, 160);
    const name = clean(item.name || item.displayName || item.remarkName || item.nickname, 80);
    if (isPhoneUserImpersonator({ ...item, id: rawReference, name }, userIdentity)) continue;
    let linkedId = clean(item.linkedCharacterId, 160) || resolveKnownId(rawReference, name);
    if (linkedId && removedLinked.has(linkedId)) linkedId = '';
    if (linkedId && usedKnownIds.has(linkedId)) linkedId = '';
    if (linkedId) usedKnownIds.add(linkedId);
    const knownRow = linkedId ? knownById.get(linkedId) : null;
    const stableSource = linkedId
      ? `linked_${linkedId}`
      : (rawReference || `seed_${index}_${name || 'contact'}`);
    const contact = normalizePhoneContact({
      ...item,
      linkedCharacterId: linkedId || undefined,
      name: name || clean(knownRow?.name, 80) || item.name,
    }, { userId, ownerId, now, idSource: stableSource });
    if (!contact || contacts.some((entry) => entry.id === contact.id)) continue;
    contacts.push(contact);
    for (const key of [rawReference, name, linkedId, contact.id, String(index)]) {
      if (key && !referenceMap.has(key)) referenceMap.set(key, contact.id);
    }
    if (linkedId) linkedToLocal.set(linkedId, contact.id);
  }
  // 关系网里已有、但模型没写进 contacts 的主要联系人：自动补进通讯录，方便建群引用
  for (const row of knownCharacters.slice(0, 12)) {
    const id = clean(row?.id, 160);
    const name = clean(row?.name || row?.realName, 80);
    if (!id || id === ownerId || usedKnownIds.has(id) || removedLinked.has(id)) continue;
    if (contacts.some((entry) => entry.linkedCharacterId === id)) continue;
    const contact = normalizePhoneContact({
      linkedCharacterId: id,
      name: name || id,
      category: clean(row?.category, 40) || 'friend',
      note: clean(row?.note || row?.relationship, 120),
      personaCapsule: {
        relationship: clean(row?.relationship || row?.withOwner, 120),
        summary: clean(row?.persona || row?.personality, 160),
      },
    }, { userId, ownerId, now, idSource: `linked_${id}` });
    if (!contact) continue;
    contacts.push(contact);
    usedKnownIds.add(id);
    referenceMap.set(id, contact.id);
    if (name) referenceMap.set(name, contact.id);
    linkedToLocal.set(id, contact.id);
  }

  const toLocalMemberId = (ref = '', name = '') => {
    const knownId = resolveKnownId(ref, name);
    if (knownId && linkedToLocal.has(knownId)) return linkedToLocal.get(knownId);
    if (referenceMap.has(ref)) return referenceMap.get(ref);
    if (name && referenceMap.has(name)) return referenceMap.get(name);
    return '';
  };

  const groups = asArray(source.groups).slice(0, MAX_GROUPS).map((item, index) => {
    if (!item || typeof item !== 'object') return null;
    const refs = asArray(item.memberIds || item.members).slice(0, MAX_GROUP_MEMBERS);
    const memberIds = [...new Set(refs.map((member) => {
      const ref = clean(typeof member === 'object'
        ? member?.id || member?.contactId || member?.name || member?.linkedCharacterId
        : member, 160);
      const name = typeof member === 'object' ? clean(member?.name, 80) : '';
      return toLocalMemberId(ref, name);
    }).filter(Boolean))].slice(0, MAX_GROUP_MEMBERS);
    return normalizePhoneContactGroup({
      ...item,
      id: item.id || item.groupId || `seed_group_${index}_${clean(item.name, 40)}`,
      memberIds,
    }, { userId, ownerId, now });
  }).filter(Boolean);

  // 关系网小群：若种子没覆盖，优先用真角色成员补 1~2 个群
  const preferredGroups = asArray(options.preferredNetworkGroups).slice(0, 2);
  for (const [index, pref] of preferredGroups.entries()) {
    const name = clean(pref?.name, 40);
    const memberIds = [...new Set(asArray(pref?.memberIds || pref?.members).map((member) => {
      const id = typeof member === 'object' ? clean(member?.id, 160) : clean(member, 160);
      return id && id !== ownerId ? (linkedToLocal.get(id) || '') : '';
    }).filter(Boolean))].slice(0, MAX_GROUP_MEMBERS);
    if (!name || memberIds.length < 1) continue;
    if (groups.some((group) => group.name === name)) continue;
    const group = normalizePhoneContactGroup({
      name,
      memberIds,
      note: '来自关系网',
    }, { userId, ownerId, now, idSource: `net_group_${index}_${name}` });
    if (group) groups.push(group);
  }

  return rematchPhoneContactsToKnownCharacters(normalizeCharacterPhoneContacts({
    userId,
    ownerId,
    userRemark: clean(source.userRemark, 80),
    userRemarkSource: source.userRemark ? 'ai' : '',
    contacts,
    groups,
    removedLinkedCharacterIds: [...removedLinked],
    updatedAt: now,
  }, { userId, ownerId, now }), knownCharacters);
}
