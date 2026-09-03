import * as db from './db.js';
import { getUserDisplayName } from '../models/user.js';
import { getCharacterAiContextName } from '../models/character.js';
import {
  buildJsonFieldTranslationPromptBlock,
  collectTranslationActors,
  repairTranslationEntries,
  sanitizeAiTranslation,
} from './translation-utils.js';
import {
  ensurePeerPrivateChat,
  ensureBackstageChat,
  findPrivateChat,
  getChat,
  listChatsForUser,
  listMessagesForChat,
  migrateLegacyTwoActorBackstageChats,
  saveMessage,
  deleteMessage,
  deleteChatWithData,
  recalcChatPreview,
  saveChat,
} from './chat-store.js';
import { isAnonymousChat, isBackstageChat, isPeerPrivateChat } from './chat-helpers.js';
import { listCharacters, getCharacter } from './character-store.js';
import {
  getLightweightNpc,
  isLightweightNpcDismissed,
  isLightweightNpcId,
} from './lightweight-npc.js';
import { principalKey } from './alias-account-model.js';
import {
  isStrangerInterceptChat,
  isUserAliasBlockedByCharacter,
} from './stranger-thread-model.js';
import { resolveGenerationMaxTokens } from './api.js';
import { chatJsonGeneration } from './chat-json-generation.js';
import { runChatAiTurn } from './chat/ai-round.js';
import {
  beginChatStreamSession,
  endChatStreamSession,
  isChatStreamPendingAnywhere,
} from './chat/chat-stream-session.js';
import { getNowForUser } from './time-mode.js';
import {
  formatClockInTimezone,
  resolveCharacterScheduleTimezone,
} from './chat/chat-timezone.js';
import { buildWorldBookContextBlock } from './world-book-store.js';
import {
  loadCharacterPhoneAutomationConfig,
  saveCharacterPhoneAutomationConfig,
} from './character-phone-automation-store.js';

import {
  loadCharacterPhoneContacts,
  saveCharacterPhoneContacts,
  upsertPhoneContact,
  upsertPhoneContactGroup,
  phoneContactGroupMemberKey,
  resolvePhoneGroupParticipantIds,
  buildPhoneLightContactCharacter,
  phoneContactCoversPeer,
  findPhoneContactByActorName,
  canPhoneAutoContactLinkedPeer,
  characterPhoneContactsSettingsKey,
  isPhoneReservedContactIdentityRef,
  isPhoneUserIdentityRef,
  isPhoneUserImpersonator,
  isPhoneLocalLightContact,
  ensurePhoneSocialActorContact,
  loadPhoneContactAcrossOwnersLookup,
} from './character-phone-contacts.js';
import {
  createPhoneSocialActorDirectory,
  phoneContactCanonicalActorId,
  phoneSocialActorNameKey,
  resolvePhoneSocialActorDisplayName,
  isLikelyGeneratedSocialActorCode,
} from './phone-social-actor-directory.js';
import {
  loadRelationshipNetwork,
  saveRelationshipNetwork,
  pruneActorsFromRelationshipNetwork,
  collectGlobalRelationshipNetworkLines,
  collectCoNetworkMemberIds,
  buildRelationshipContextBlock,
  relationshipActorIdsMatch,
} from './relationship-network.js';
import { loadContactGroupsConfig, resolveCharacterGroupId } from './contact-groups.js';
import {
  canPhoneCharacterIdsKnowEachOther,
  canPhoneCharactersKnowEachOther,
} from './phone-social-eligibility.js';
import { loadAcquaintanceLedger } from './acquaintance-ledger.js';
import { buildIdentitySocialDirective } from './character-social-context.js';
import { getCharacterPromptTagSnippets } from '../data/character-prompt-tags.js';
import { repairMisclassifiedPeerPrivateCharacters } from './lightweight-npc.js';
import { loadCharacterPhone } from './character-phone-store.js';
import { collectCharacterPhoneCurrentContext } from './character-phone-current-context.js';
import { loadChatPrefs } from './chat-block-state.js';
import {
  applyRoundStateEvents,
  rewindCharStateForAiRound,
} from './chat/character-state.js';

async function runTrackedPhoneChatTurn(chatId, externalSignal, runner) {
  const id = String(chatId || '').trim();
  if (!id) throw new Error('缺少会话');
  if (isChatStreamPendingAnywhere(id)) throw new Error('这个会话正在生成，请稍后再试');
  const controller = new AbortController();
  const relayAbort = () => {
    try {
      controller.signal.marshmallowAbortReason = externalSignal?.marshmallowAbortReason || 'external';
      controller.abort();
    } catch (_) {}
  };
  if (externalSignal?.aborted) relayAbort();
  else externalSignal?.addEventListener?.('abort', relayAbort, { once: true });
  beginChatStreamSession(id, {
    abortController: controller,
    title: '正在生成手机会话',
  });
  try {
    return await runner(controller.signal);
  } finally {
    externalSignal?.removeEventListener?.('abort', relayAbort);
    endChatStreamSession(id);
  }
}

const PHONE_LIFE_BATCH_KEY_PREFIX = 'characterPhoneLifeBatch:';
let phoneNpcIdentityRepairQueue = Promise.resolve();

function phoneLifeBatchSettingsKey(userId = '', ownerId = '') {
  return `${PHONE_LIFE_BATCH_KEY_PREFIX}${cleanId(userId)}:${cleanId(ownerId)}`;
}

function makePhoneLifeBatchId() {
  return `phlife_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizePhoneLifeBatchRecord(raw = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const batchId = cleanId(raw.batchId);
  if (!batchId) return null;
  const asIds = (value) => [...new Set((Array.isArray(value) ? value : [])
    .map((id) => cleanId(id))
    .filter(Boolean))];
  return {
    batchId,
    createdAt: Number(raw.createdAt) || Date.now(),
    worldCreatedAt: Number(raw.worldCreatedAt || 0) || 0,
    messageIds: asIds(raw.messageIds),
    touchedChatIds: asIds(raw.touchedChatIds),
    createdChatIds: asIds(raw.createdChatIds),
    createdContactIds: asIds(raw.createdContactIds),
    createdGroupIds: asIds(raw.createdGroupIds),
    stateRoundRefs: (Array.isArray(raw.stateRoundRefs) ? raw.stateRoundRefs : [])
      .map((item) => ({
        chatId: cleanId(item?.chatId),
        aiRoundId: cleanId(item?.aiRoundId),
      }))
      .filter((item) => item.chatId && item.aiRoundId),
    contactTranslationRestores: (Array.isArray(raw.contactTranslationRestores) ? raw.contactTranslationRestores : [])
      .map((item) => ({ id: cleanId(item?.id), translationProfile: item?.translationProfile || {} }))
      .filter((item) => item.id),
  };
}

export async function loadLastPhoneLifeBatch(userId = '', ownerId = '') {
  const key = phoneLifeBatchSettingsKey(userId, ownerId);
  const row = await db.get('settings', key).catch(() => null);
  return normalizePhoneLifeBatchRecord(row?.value || row);
}

async function saveLastPhoneLifeBatch(userId = '', ownerId = '', record = null) {
  const key = phoneLifeBatchSettingsKey(userId, ownerId);
  if (!record) {
    await db.remove(key).catch(() => {});
    return null;
  }
  const normalized = normalizePhoneLifeBatchRecord(record);
  if (!normalized) return null;
  await db.put('settings', { key, value: normalized });
  return normalized;
}

function cleanId(value = '') {
  return String(value || '').trim();
}

const UNIQUE_PHONE_RELATIONSHIP_SLOT_RULES = Object.freeze([
  {
    id: 'mother',
    label: '母亲',
    pattern: /(?:母亲|妈妈|妈咪|老妈|亲妈)/u,
    exactNamePattern: /^(?:母亲|妈妈|妈咪|老妈|亲妈)$/u,
  },
  {
    id: 'father',
    label: '父亲',
    pattern: /(?:父亲|爸爸|爹地|老爸|亲爸)/u,
    exactNamePattern: /^(?:父亲|爸爸|爹地|老爸|亲爸)$/u,
  },
  {
    id: 'spouse',
    label: '配偶',
    pattern: /(?:配偶|妻子|老婆|太太|丈夫|老公)/u,
    exactNamePattern: /^(?:配偶|妻子|老婆|太太|丈夫|老公)$/u,
  },
]);

export function uniquePhoneRelationshipSlots(value = '') {
  const text = String(value || '')
    .replace(/\s+/g, '')
    .replace(/(?:像|如)(?:一位)?(?:母亲|妈妈|父亲|爸爸)(?:一样|般)/gu, '')
    .replace(/不是(?:母亲|妈妈|父亲|爸爸|配偶|妻子|丈夫)/gu, '');
  if (!text) return [];
  return UNIQUE_PHONE_RELATIONSHIP_SLOT_RULES
    .filter((rule) => rule.pattern.test(text))
    .map((rule) => rule.id);
}

export function collectOccupiedPhoneRelationshipSlots({
  owner = null,
  ownerId = '',
  contacts = [],
  characters = [],
  relationshipNetwork = null,
} = {}) {
  const occupied = new Set();
  const add = (...values) => {
    for (const value of values) {
      for (const slot of uniquePhoneRelationshipSlots(value)) occupied.add(slot);
    }
  };
  for (const description of Object.values(
    owner?.relationships && typeof owner.relationships === 'object' ? owner.relationships : {},
  )) add(description);
  for (const contact of Array.isArray(contacts) ? contacts : []) {
    add(contact?.personaCapsule?.relationship, contact?.note);
    const contactName = String(contact?.nickname || contact?.name || '').replace(/\s+/g, '');
    for (const rule of UNIQUE_PHONE_RELATIONSHIP_SLOT_RULES) {
      if (rule.exactNamePattern.test(contactName)) occupied.add(rule.id);
    }
  }
  const oid = cleanId(ownerId || owner?.id);
  for (const character of Array.isArray(characters) ? characters : []) {
    add(character?.relationships?.[oid]);
  }
  for (const circle of relationshipNetwork?.circles || []) {
    for (const edge of circle?.edges || []) {
      if (cleanId(edge?.a) === oid || cleanId(edge?.b) === oid) add(edge?.label);
    }
  }
  return occupied;
}

export function phoneRelationshipSlotLabels(slots = []) {
  const ids = slots instanceof Set ? slots : new Set(Array.isArray(slots) ? slots : []);
  return UNIQUE_PHONE_RELATIONSHIP_SLOT_RULES
    .filter((rule) => ids.has(rule.id))
    .map((rule) => rule.label);
}

export function shouldRejectDuplicatePhoneRelationshipContact(contact = {}, occupiedSlots = new Set()) {
  const occupied = occupiedSlots instanceof Set
    ? occupiedSlots
    : new Set(Array.isArray(occupiedSlots) ? occupiedSlots : []);
  const slots = new Set(uniquePhoneRelationshipSlots([
    contact?.relationship,
    contact?.relation,
    contact?.personaCapsule?.relationship,
    contact?.note,
  ].filter(Boolean).join(' ')));
  const contactName = String(contact?.name || '').replace(/\s+/g, '');
  for (const rule of UNIQUE_PHONE_RELATIONSHIP_SLOT_RULES) {
    if (rule.exactNamePattern.test(contactName)) slots.add(rule.id);
  }
  return [...slots].some((slot) => occupied.has(slot));
}

const phoneChatLocks = new Set();

export function tryLockCharacterPhoneChat(chatId) {
  const id = cleanId(chatId);
  if (!id || phoneChatLocks.has(id)) return false;
  phoneChatLocks.add(id);
  return true;
}

export function unlockCharacterPhoneChat(chatId) {
  phoneChatLocks.delete(cleanId(chatId));
}

export function buildPeerPrivatePhoneIdentityDirective(chat, {
  ownerName = '角色',
  peerNames = [],
} = {}) {
  if (!isPeerPrivateChat(chat) || (chat?.participants || []).includes('user')) return '';
  const pair = [ownerName, ...(Array.isArray(peerNames) ? peerNames : [])]
    .map((name) => String(name || '').trim())
    .filter(Boolean)
    .slice(0, 2)
    .join(' 与 ');
  return [
    `【双人侧窗硬边界】这是${pair || '两名角色'}的一对一私聊，user 不在场、看不到、不会回复。`,
    '只续写当前两人的短消息与当前窗卡片；禁止联系主用户，禁止跨窗外出、群联动、建群、拉人或引用用户主私聊与其它窗口记忆。',
    '可以用不带 to/room 的 chat_bundle 在当前窗口实际转发任一方确实掌握的聊天记录、图片或链接；禁止用带 to/room 的 chat_bundle 转去其它窗口，也不能虚构他人原话。',
    '保持双人私聊口吻，不写「大家」「群里」「@某人」或等待 user 回复的措辞。',
  ].join('\n');
}

/** 手机 UI / 落库显示名：真名优先，不用通讯录备注（备注可能是「爸爸」等称谓）。 */
function characterName(row = {}, fallback = '角色') {
  if (!row || typeof row !== 'object') return String(fallback || '角色').trim() || '角色';
  return resolvePhoneSocialActorDisplayName(row)
    || getCharacterAiContextName(row, fallback)
    || String(fallback);
}

/** 旧手机拦截箱 + 陌生消息/马甲线程（含被拉黑）都算拦截侧。 */
export function isPhoneInterceptChat(chat) {
  if (!chat) return false;
  if (String(chat?.metadata?.phoneChannel || '') === 'intercept') return true;
  return isStrangerInterceptChat(chat);
}

/**
 * 手机侧看到的「用户」前台身份：有马甲快照则用马甲昵称/头像/ID，否则回落本体。
 */
export function resolvePhoneUserPeerIdentity(chat, userId = '', fallbackUser = null) {
  const uid = cleanId(userId) || cleanId(fallbackUser?.id);
  const fallbackName = String(
    fallbackUser?.name
    || fallbackUser?.displayName
    || getUserDisplayName(fallbackUser || {})
    || '用户',
  ).trim() || '用户';
  const fallbackAvatar = String(fallbackUser?.avatar || fallbackUser?.avatarUrl || '').trim();
  if (!chat || !uid) {
    return {
      displayName: fallbackName,
      avatar: fallbackAvatar,
      handle: '',
      isAlias: false,
      blocked: false,
    };
  }
  const accountId = String(
    chat.metadata?.accountIdentityMap?.[principalKey('user', uid)] || '',
  ).trim();
  const snapshot = accountId ? chat.metadata?.accountSnapshots?.[accountId] : null;
  const displayName = String(snapshot?.displayName || '').trim() || fallbackName;
  const handle = String(snapshot?.handle || '').trim();
  return {
    displayName,
    avatar: String(snapshot?.avatar || '').trim() || fallbackAvatar,
    handle,
    isAlias: !!accountId,
    blocked: isUserAliasBlockedByCharacter(chat),
    accountId,
  };
}

export async function listCharacterPhoneChats(userId, characterId, options = {}) {
  const uid = cleanId(userId);
  const cid = cleanId(characterId);
  if (!uid || !cid) return [];
  // 旧版本可能把通讯录主角色的别名误降级成 lightnpc_，导致对方消息落进另一扇假私聊。
  // 手机列表打开时先做一次无歧义迁移，让已经被吞到错误窗口的历史消息也能重新出现。
  await repairMisclassifiedPeerPrivateCharacters(uid).catch(() => {});
  // 手机里手动补了同名联系人后，旧会话可能仍指向关系网 npc_/lightnpc_。
  // 打开列表时把这些无歧义身份收敛到手机联系人，避免同名双行和继续聊错对象。
  await reconcilePhoneContactNpcIdentities(uid, cid).catch(() => {});
  const includeIntercept = options.includeIntercept === true;
  const onlyIntercept = options.onlyIntercept === true;
  const beforeMigration = await listChatsForUser(uid);
  const migration = await migrateLegacyTwoActorBackstageChats(uid, beforeMigration);
  const chats = migration.changed > 0 ? await listChatsForUser(uid) : beforeMigration;
  const [owner, allCharacters, phoneContacts, relationshipNet, contactGroupsConfig, acquaintanceLedger, findPhoneContactAcrossOwners] = await Promise.all([
    getCharacter(cid, { userId: uid }).catch(() => null),
    listCharacters({ includeInternal: true, userId: uid, identityScoped: true }).catch(() => []),
    loadCharacterPhoneContacts(uid, cid).catch(() => ({ contacts: [] })),
    loadRelationshipNetwork(uid).catch(() => null),
    loadContactGroupsConfig().catch(() => ({ groups: [] })),
    loadAcquaintanceLedger().catch(() => ({ entries: [] })),
    loadPhoneContactAcrossOwnersLookup().catch(() => (() => null)),
  ]);
  // 群是用户级共享会话，但 phone-contact:* 属于某一台角色手机。旧群若直接拿
  // 本地联系人 id 当成员，另一名真实角色会在“是否入群”的判断前就被漏掉。
  // 因此必须先把全部历史群收敛到稳定角色 id，再筛当前手机的会话列表。
  for (const chat of chats) {
    if (chat?.type !== 'group') continue;
    await reconcilePhoneGroupParticipantIdentities(chat, {
      userId: uid,
      characters: allCharacters,
      findPhoneContactAcrossOwners,
    }).catch(() => {});
    await repairMisattributedTruncatedPhoneGroupParticipants(chat, {
      characters: allCharacters,
      findPhoneContactAcrossOwners,
    }).catch(() => {});
  }
  const candidates = chats
    .filter((chat) => chat && !isAnonymousChat(chat)
      && Array.isArray(chat.participants) && chat.participants.includes(cid))
    .filter((chat) => {
      const isIntercept = isPhoneInterceptChat(chat);
      if (onlyIntercept) return isIntercept;
      if (!includeIntercept && isIntercept) return false;
      return true;
    });
  if (!candidates.length) return [];
  // 删除事务已提交后，部分旧 WebView 的 userId 索引仍可能短暂吐出旧行。
  // 角色手机紧接着重绘若直接信任索引，就会把刚删除的会话重新画回来，直到重启应用。
  // 用一个批量主键事务核验候选是否仍真实存在；失败时保留原结果，避免数据库瞬断误清列表。
  const liveCandidateRows = await db.getMany('chats', candidates.map((chat) => chat.id)).catch(() => null);
  const liveCandidateIds = Array.isArray(liveCandidateRows)
    ? new Set(liveCandidateRows.filter(Boolean).map((chat) => cleanId(chat.id)).filter(Boolean))
    : null;
  const verifiedCandidates = liveCandidateIds
    ? candidates.filter((chat) => liveCandidateIds.has(cleanId(chat.id)))
    : candidates;
  if (!verifiedCandidates.length) return [];
  const byId = new Map(allCharacters.map((row) => [row.id, row]));
  const authorizedPhoneActorIds = new Set((phoneContacts.contacts || []).flatMap((contact) => [
    cleanId(contact?.id),
    cleanId(contact?.linkedCharacterId),
    cleanId(contact?.linkedActorId),
  ]).filter(Boolean));
  return verifiedCandidates.filter((chat) => (
    (chat.participants || []).every((id) => {
      const key = cleanId(id);
      if (!key || key === cid || key === 'user') return true;
      // 已被联系人归一化清掉的 phone-contact:* 是历史污染孤儿，不再让它占据手机消息列表。
      if (/^phone-contact:/i.test(key) && !authorizedPhoneActorIds.has(key)) {
        // 群成员可能来自另一台角色手机。只放行能在全局通讯录中核验、且已保存
        // 可读姓名的成员；私聊继续执行当前手机授权，避免幽灵会话重新出现。
        const storedAlias = chat.type === 'group'
          ? chat.metadata?.phoneLightNpcAliases?.[key]
          : null;
        if (!storedAlias?.phoneContactId
          || !resolvePhoneSocialActorDisplayName(storedAlias)) return false;
      }
      // 旧微博 npc_<hash> 可能以裸哈希参与者落库；没有真实角色/联系人授权时直接隔离。
      if (!byId.has(key) && !authorizedPhoneActorIds.has(key)
        && isLikelyGeneratedSocialActorCode(key)) return false;
      return !owner || !byId.has(key)
        || canPhoneCharactersKnowEachOther(
          owner,
          byId.get(key),
          relationshipNet,
          contactGroupsConfig,
          acquaintanceLedger,
        );
    })
  )).sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0));
}

/**
 * 清理由旧版身份串位造成的 user 副本与代发消息。
 * 真正的用户在 chat.participants 中固定使用 "user"；无 user 侧窗里的 user 消息均属污染数据。
 */
export async function purgePhoneUserImpersonators({ user, ownerId } = {}) {
  const uid = cleanId(user?.id);
  const cid = cleanId(ownerId);
  if (!uid || !cid) {
    return {
      contacts: 0, chats: 0, messages: 0, relationships: 0,
    };
  }
  const [owner, rawContactRow, state, allCharacters] = await Promise.all([
    getCharacter(cid, { userId: uid }).catch(() => null),
    db.get('settings', characterPhoneContactsSettingsKey(uid, cid)).catch(() => null),
    loadCharacterPhoneContacts(uid, cid).catch(() => null),
    listCharacters({ includeInternal: true, userId: uid, identityScoped: true }).catch(() => []),
  ]);
  const identity = {
    userId: uid,
    userName: getUserDisplayName(user) || user?.name || '',
    ownerId: cid,
    ownerName: getCharacterAiContextName(owner) || owner?.name || '',
  };
  // 必须从原始行取旧副本 id；读取归一化会先隐藏这些联系人，若只看 state，
  // 污染会话与关系网里的旧 id 就无法继续清理。
  const badForumActorIds = new Set((allCharacters || [])
    .filter((character) => character?.forumIdentity?.kind === 'passerby')
    .filter((character) => isPhoneUserImpersonator({
      name: character?.name,
      displayName: character?.forumIdentity?.displayName,
      nickname: character?.customNickname,
      alias: character?.realName,
    }, identity))
    .map((character) => cleanId(character.id))
    .filter(Boolean));
  const badContacts = (rawContactRow?.value?.contacts || []).filter((contact) => (
    isPhoneUserImpersonator(contact, identity)
    || badForumActorIds.has(cleanId(contact?.linkedCharacterId || contact?.linkedActorId))
  ));
  const badIds = new Set([
    ...badContacts.map((contact) => cleanId(contact.id)).filter(Boolean),
    ...badForumActorIds,
  ]);
  const chats = await listChatsForUser(uid).catch(() => []);
  const ownerSideChats = chats.filter((chat) => (
    Array.isArray(chat?.participants)
    && chat.participants.includes(cid)
    && !chat.participants.includes('user')
  ));
  const pollutedChats = ownerSideChats.filter((chat) => (
    chat.participants.some((id) => badIds.has(cleanId(id)))
  ));
  const deletedChatIds = new Set(pollutedChats.map((chat) => cleanId(chat.id)).filter(Boolean));
  for (const chat of pollutedChats) {
    await deleteChatWithData(chat.id, uid).catch(() => {});
  }

  let deletedMessages = 0;
  for (const chat of ownerSideChats) {
    if (deletedChatIds.has(cleanId(chat.id))) continue;
    const messages = await listMessagesForChat(chat.id, 0).catch(() => []);
    const participants = new Set((chat.participants || []).map(cleanId).filter(Boolean));
    let changed = false;
    for (const message of messages) {
      const senderId = cleanId(message?.senderId);
      const aiRoundKind = String(message?.metadata?.aiRoundKind || '').trim();
      const isPhoneAiMessage = aiRoundKind.startsWith('phone-')
        || message?.metadata?.phoneLifeBatch === true
        || message?.metadata?.phoneInterceptBatch === true;
      const invalidPhoneActor = isPhoneAiMessage && senderId && !participants.has(senderId);
      const generatedInterceptOwnerReply = message?.metadata?.phoneInterceptBatch === true
        && senderId === cid;
      if (senderId !== 'user'
        && senderId !== uid
        && !invalidPhoneActor
        && !generatedInterceptOwnerReply) continue;
      await deleteMessage(message.id).catch(() => {});
      deletedMessages += 1;
      changed = true;
    }
    if (changed) await recalcChatPreview(chat.id).catch(() => {});
  }

  if (badIds.size && state) {
    await saveCharacterPhoneContacts(uid, cid, {
      ...state,
      contacts: state.contacts.filter((contact) => (
        !badIds.has(cleanId(contact.id))
        && !badIds.has(cleanId(contact.linkedCharacterId || contact.linkedActorId))
      )),
      groups: (state.groups || []).map((group) => ({
        ...group,
        memberIds: (group.memberIds || []).filter((id) => !badIds.has(cleanId(id))),
        updatedAt: Date.now(),
      })),
      updatedAt: Date.now(),
    });
  }
  const networkPrune = badIds.size
    ? await pruneActorsFromRelationshipNetwork([...badIds]).catch(() => ({ pruned: [] }))
    : { pruned: [] };
  return {
    contacts: badContacts.length,
    chats: pollutedChats.length,
    messages: deletedMessages,
    relationships: networkPrune.pruned?.length || 0,
  };
}

export async function listCharacterPhoneInterceptChats(userId, characterId) {
  return listCharacterPhoneChats(userId, characterId, { onlyIntercept: true });
}

export function resolvePhoneChatTitle(chat, ownerId, characterMap = {}, userName = '用户', options = {}) {
  if (!chat) return '会话';
  if (chat.type === 'group') {
    return String(chat.groupSettings?.name || '').trim() || '群聊';
  }
  const otherId = (chat.participants || []).find((id) => id && id !== ownerId);
  if (otherId === 'user') {
    const peer = resolvePhoneUserPeerIdentity(chat, options.userId, options.user || { name: userName });
    return peer.displayName || userName || '用户';
  }
  const row = characterMap[otherId];
  if (row) return characterName(row, '联系人');
  const storedAlias = chat.metadata?.phoneLightNpcAliases?.[otherId];
  const storedName = resolvePhoneSocialActorDisplayName(storedAlias);
  if (storedName) return storedName;
  // 关系网轻量 NPC / 未入手机通讯录：不要把 lightnpc_… 原始 id 甩到列表标题上
  if (/^(?:npc_|lightnpc_|phone-contact:)/i.test(String(otherId || ''))) {
    return '联系人';
  }
  return String(otherId || '私聊');
}

export async function loadPhoneChatThread(chatId, limit = 120) {
  const chat = await getChat(chatId);
  if (!chat) return { chat: null, messages: [] };
  const messages = await listMessagesForChat(chat.id, limit);
  return { chat, messages };
}

async function loadParticipantContext(chat, userId, ownerId) {
  const [all, phoneContacts] = await Promise.all([
    // 覆盖 AI 自建 NPC：这些参与者不在可选通讯录里，但补记录时同样需要人设。
    listCharacters({ includeInternal: true, userId, identityScoped: true }).catch(() => []),
    loadCharacterPhoneContacts(userId, ownerId).catch(() => ({ contacts: [] })),
  ]);
  const allowed = new Set((chat?.participants || []).filter((id) => id && id !== 'user'));
  const map = {};
  for (const row of all) if (row?.id && allowed.has(row.id)) map[row.id] = row;
  for (const contact of phoneContacts.contacts || []) {
    if (!contact?.id) continue;
    const actorId = phoneContactCanonicalActorId(contact);
    const targetId = allowed.has(actorId) ? actorId : (allowed.has(contact.id) ? contact.id : '');
    if (!targetId || map[targetId]) continue;
    map[targetId] = {
      ...buildPhoneLightContactCharacter(contact, ownerId),
      id: targetId,
    };
  }
  return map;
}

async function isPhoneChatSociallyEligible(chat, ownerId, userId = '') {
  const [owner, allCharacters, relationshipNet, contactGroupsConfig, acquaintanceLedger] = await Promise.all([
    getCharacter(ownerId, { userId }),
    listCharacters({ includeInternal: true, userId, identityScoped: true }).catch(() => []),
    loadRelationshipNetwork(userId).catch(() => null),
    loadContactGroupsConfig().catch(() => ({ groups: [] })),
    loadAcquaintanceLedger().catch(() => ({ entries: [] })),
  ]);
  if (!owner) return false;
  const byId = new Map(allCharacters.map((row) => [row.id, row]));
  return (chat?.participants || []).every((id) => {
    const key = cleanId(id);
    return !key || key === ownerId || key === 'user' || !byId.has(key)
      || canPhoneCharactersKnowEachOther(
        owner,
        byId.get(key),
        relationshipNet,
        contactGroupsConfig,
        acquaintanceLedger,
      );
  });
}

function buildPhoneHistoryDirective(chat, ownerId, ownerName, options = {}) {
  const hasUserInChat = (chat.participants || []).includes('user');
  const ownerOnly = options.ownerOnly === true || hasUserInChat;
  const userName = String(options.userName || '用户').trim() || '用户';
  const peerPrivateBoundary = buildPeerPrivatePhoneIdentityDirective(chat, {
    ownerName,
    peerNames: options.peerNames,
  });
  return [
    '【他的手机·补充过去记录】这是回填到过去时间线的一小段真实聊天，不是此刻刚发的新消息。',
    peerPrivateBoundary,
    `当前手机主人是 ${ownerName}（id=${ownerId}）。历史记录必须符合当时已经发生的关系、知情边界和语气，不要复述最近已经演过的桥段。`,
    ownerOnly
      ? `本轮只允许 ${ownerName} 发言；其他人可以稍后在自己的自动回复轮承接，禁止替对方回复。消息数量与分条服从人物语料和【回复节奏 · 错落】。`
      : `这是无 user 的真实${chat.type === 'group' ? '群聊' : '角色私聊'}；让所有被逐条新刺激真实牵动的人自然参与，不机械轮流，消息数量与分条服从【回复节奏 · 错落】。`,
    '输出必须走棉花糖协议：每条 msg.body 承载一个能独立发送的完整气口；同一个人有多个后起念头时可连发，禁止把旁白或散文塞进 msg。',
    hasUserInChat
      ? `【关于 ${userName}】禁止虚构 ${userName} 做过的事、说过的话、行程或交集；禁止替 ${userName} 回答或扮演 ${userName}。`
      : '【身份隔离】本窗没有用户身份；不得提取用户档案、用户关系或用户主窗内容，不得创建、影射或扮演用户。',
    '优先补一个此前未落库、但与历史自然衔接的小片段；没有新信息时宁可少写。',
  ].join('\n');
}

export async function generatePhoneChatPast({
  user,
  ownerId,
  chatId,
  ownerOnly = false,
  hours = 24,
  signal,
} = {}) {
  const chat = await getChat(chatId);
  const uid = cleanId(user?.id);
  const cid = cleanId(ownerId);
  if (!chat || !uid || !cid || !(chat.participants || []).includes(cid)) {
    throw new Error('手机主人不在该会话中');
  }
  if (!(await isPhoneChatSociallyEligible(chat, cid, uid))) {
    throw new Error('该跨分组手机会话尚未建立关系网或角色关系，不能继续生成');
  }
  if (!tryLockCharacterPhoneChat(chat.id)) throw new Error('这个会话正在生成，请稍后再试');
  try {
    const messages = await listMessagesForChat(chat.id, 160);
    const characters = await loadParticipantContext(chat, uid, cid);
    const now = await getNowForUser(uid).catch(() => Date.now());
    const endTs = now - 2 * 60 * 1000;
    const lastTs = Number(messages[messages.length - 1]?.timestamp || 0);
    const spanMs = Math.max(2, Math.min(168, Number(hours) || 24)) * 60 * 60 * 1000;
    const startTs = lastTs > 0 && lastTs < endTs - 10 * 60 * 1000
      ? lastTs
      : endTs - spanMs;
    const ownerName = characterName(characters[cid], cid);
    const peerNames = (chat.participants || [])
      .filter((id) => id && id !== cid && id !== 'user')
      .map((id) => characterName(characters[id], id));
    const userName = getUserDisplayName(user) || '用户';
    return await runTrackedPhoneChatTurn(chat.id, signal, (trackedSignal) => runChatAiTurn({
      chat,
      chatId: chat.id,
      user,
      userId: uid,
      messages,
      characters,
      manual: true,
      allowBlockedManual: true,
      skipBusyAutoReply: true,
      preferStream: false,
      aiRoundKind: 'phone-history',
      phoneViewerId: cid,
      resolveSenderName: (id) => characterName(characters[id], id),
      gapFillWindow: { startTs, endTs },
      sceneDirective: buildPhoneHistoryDirective(chat, cid, ownerName, {
        ownerOnly,
        userName,
        peerNames,
      }),
      ...(ownerOnly || (chat.participants || []).includes('user') ? { onlySenderId: cid } : {}),
      signal: trackedSignal,
    }));
  } finally {
    unlockCharacterPhoneChat(chat.id);
  }
}

export async function generatePhoneChatBatch({
  user,
  ownerId,
  chatIds = [],
  limit = 3,
  signal,
  onProgress = null,
} = {}) {
  const available = await listCharacterPhoneChats(user?.id, ownerId);
  const wanted = new Set((chatIds || []).map(cleanId).filter(Boolean));
  const picked = available
    .filter((chat) => !(chat.participants || []).includes('user'))
    .filter((chat) => !wanted.size || wanted.has(chat.id))
    .slice(0, Math.max(1, Math.min(4, Number(limit) || 3)));
  const results = [];
  for (const [index, chat] of picked.entries()) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    await onProgress?.(index + 1, picked.length, chat);
    const result = await generatePhoneChatPast({
      user,
      ownerId,
      chatId: chat.id,
      ownerOnly: true,
      hours: 48,
      signal,
    }).catch((error) => ({ ok: false, error }));
    results.push({ chatId: chat.id, result });
  }
  return results;
}

function lifeClip(value = '', max = 200) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function phoneLifeActorKey(value = '') {
  return phoneSocialActorNameKey(lifeClip(value, 80));
}

function resolveCharacterAge(birthDate = '', now = Date.now()) {
  const raw = String(birthDate || '').trim();
  const matched = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!matched) return null;
  const year = Number(matched[1]);
  const month = Number(matched[2]);
  const day = Number(matched[3]);
  const current = new Date(Number(now) || Date.now());
  let age = current.getFullYear() - year;
  if (
    current.getMonth() + 1 < month
    || (current.getMonth() + 1 === month && current.getDate() < day)
  ) age -= 1;
  return age >= 0 && age <= 150 ? age : null;
}

/**
 * 手机生成共用的完整语义角色卡。
 * 只排除头像 data URL、图片锁等非人设/高体积 UI 数据；角色设定字段不截断。
 */
export function buildCompletePhoneCharacterProfile(
  character = {},
  {
    name = '',
    now = Date.now(),
    nameById = new Map(),
    userName = '用户',
    includeUserRelations = true,
  } = {},
) {
  const birthDate = String(character.birthDate || '').trim();
  const age = resolveCharacterAge(birthDate, now);
  const relationships = Object.entries(
    character.relationships && typeof character.relationships === 'object'
      ? character.relationships
      : {},
  ).filter(([id]) => includeUserRelations || id !== 'user').map(([id, description]) => ({
    id,
    name: id === 'user' ? userName : (nameById.get(id) || id),
    description: String(description || '').trim(),
  })).filter((item) => item.id && item.description);
  const promptTagDirectives = getCharacterPromptTagSnippets(character.promptTags || []);

  return {
    id: cleanId(character.id),
    name: String(name || characterName(character, character.id)).trim(),
    aliases: Array.isArray(character.aliases) ? character.aliases.filter(Boolean) : [],
    groupId: String(character.groupId || '').trim(),
    roleTier: String(character.roleTier || '').trim(),
    birthDate,
    ...(age != null ? { age } : {}),
    currentRole: String(character.currentRole || '').trim(),
    currentStatus: String(character.currentStatus || '').trim(),
    personality: String(character.personality || '').trim(),
    speechStyle: String(character.speechStyle || '').trim(),
    promptCorpus: String(character.promptCorpus || '').trim(),
    speechCorpus: String(character.speechCorpus || '').trim(),
    promptTagDirectives,
    commonEmotes: String(character.commonEmotes || '').trim(),
    ...(includeUserRelations
      ? { userRelationStatus: String(character.userRelationStatus || '').trim() }
      : {}),
    relationships,
    lifeProfile: character.lifeProfile && typeof character.lifeProfile === 'object'
      ? { ...character.lifeProfile }
      : {},
    residenceAnchor: character.residenceAnchor && typeof character.residenceAnchor === 'object'
      ? { ...character.residenceAnchor }
      : {},
    locationProfile: character.locationProfile && typeof character.locationProfile === 'object'
      ? { ...character.locationProfile }
      : {},
    notes: String(character.notes || '').trim(),
    profileCard: character.card && typeof character.card === 'object' ? { ...character.card } : {},
    appearance: String(character.appearancePrompt || '').trim(),
    translationProfile: character.translationProfile && typeof character.translationProfile === 'object'
      ? { ...character.translationProfile }
      : {},
    voiceProfile: character.voiceProfile && typeof character.voiceProfile === 'object'
      ? { ...character.voiceProfile }
      : {},
  };
}

/** 补一轮落库前：把塞进一条的长段拆成多条短气泡（对齐棉花糖短气泡习惯）。 */
function expandPhoneLifeBubbleTexts(text = '') {
  const raw = String(text || '').trim();
  if (!raw) return [];
  const lines = raw.split(/\r?\n+/).map((part) => part.trim()).filter(Boolean);
  const parts = [];
  for (const line of lines) {
    if (line.length <= 72) {
      parts.push(line);
      continue;
    }
    // 不用 lookbehind：iOS Safari < 16.4 会在 parseModule 阶段直接失败
    const sentenceChunks = String(line).split(/([。！？!?…]+)/);
    const sentences = [];
    for (let i = 0; i < sentenceChunks.length; i += 2) {
      const chunk = `${sentenceChunks[i] || ''}${sentenceChunks[i + 1] || ''}`.trim();
      if (chunk) sentences.push(chunk);
    }
    if (sentences.length > 1) {
      for (const sentence of sentences) {
        if (sentence.length <= 72) parts.push(sentence);
        else parts.push(lifeClip(sentence, 72));
      }
    } else {
      parts.push(lifeClip(line, 72));
    }
  }
  return parts.slice(0, 8);
}

export function phoneLifeBatchHasSpeakerStates(value = {}) {
  const threads = Array.isArray(value?.threads) ? value.threads : [];
  return threads.every((thread) => {
    const speakers = new Set((Array.isArray(thread?.messages) ? thread.messages : [])
      .map((message) => cleanId(message?.speakerId ?? message?.speaker))
      .filter(Boolean));
    if (!speakers.size) return true;
    const stateSpeakers = new Set((Array.isArray(thread?.states) ? thread.states : [])
      .map((state) => cleanId(state?.speakerId ?? state?.from))
      .filter(Boolean));
    return [...speakers].every((speakerId) => stateSpeakers.has(speakerId));
  });
}

/**
 * 补一轮中的私聊必须真的包含手机主人和对方两侧；群聊至少两人开口。
 * 不能只依赖提示词，否则模型偶发漏一侧时会把单向记录当成完整往来落库。
 */
export function phoneLifeBatchHasCompleteConversations(value = {}, {
  ownerId = '',
  existingChatTypes = new Map(),
} = {}) {
  const oid = cleanId(ownerId);
  const chatTypes = existingChatTypes instanceof Map
    ? existingChatTypes
    : new Map(Object.entries(existingChatTypes || {}));
  return (Array.isArray(value?.threads) ? value.threads : []).every((thread) => {
    const speakers = new Set((Array.isArray(thread?.messages) ? thread.messages : [])
      .map((message) => cleanId(message?.speakerId ?? message?.speaker))
      .filter((id) => id && id !== 'user' && id !== 'system'));
    if (!speakers.size) return true;
    const chatId = cleanId(thread?.chatId);
    const isGroup = !!cleanId(thread?.groupRef) || chatTypes.get(chatId) === 'group';
    if (isGroup) return speakers.size >= 2;
    return !!oid && speakers.has(oid) && [...speakers].some((id) => id !== oid);
  });
}

/** 确认本窗至少存在一名获授权发言者；完整会话人数由外层按私聊/群聊继续校验。 */
export function phoneLifeThreadHasAuthorizedSpeaker(participantIds = [], speakerIds = []) {
  const participants = new Set((Array.isArray(participantIds) ? participantIds : [])
    .map(cleanId)
    .filter((id) => id && id !== 'user' && id !== 'system'));
  return (Array.isArray(speakerIds) ? speakerIds : [])
    .map(cleanId)
    .some((id) => id && participants.has(id));
}

/** 关系网里含手机主人的既有小群，供建群优先复用真角色。 */
function collectPreferredNetworkGroups(relationshipNet, ownerId, nameById, charMap) {
  const oid = cleanId(ownerId);
  if (!oid || !relationshipNet) return [];
  const out = [];
  for (const circle of relationshipNet.circles || []) {
    for (const group of circle.groups || []) {
      const members = (group.memberIds || []).map((id) => cleanId(id)).filter(Boolean);
      if (!members.includes(oid)) continue;
      const others = members.filter((id) => id !== oid && id !== 'user' && charMap.has(id));
      if (others.length < 1) continue;
      out.push({
        name: String(group.name || circle.name || '关系网小群').trim().slice(0, 30),
        memberIds: others.slice(0, 8),
        members: others.slice(0, 8).map((id) => ({
          id,
          name: nameById.get(id) || id,
        })),
      });
      if (out.length >= 6) return out;
    }
  }
  return out;
}

/**
 * 群成员 / speaker 解析：优先关系网与主通讯录真角色 id，避免同名轻量 NPC 顶替本人。
 */
function resolvePhoneLifeActorRef(ref, {
  knownIds,
  nameById,
  actorIndex,
  contactPeerId,
} = {}) {
  const key = String(ref || '').trim();
  if (!key || key === 'user') return '';
  const normalizedKey = phoneLifeActorKey(key);
  const known = knownIds instanceof Set ? knownIds : new Set();
  if (known.has(key)) return key;

  const peer = contactPeerId?.get(key) || contactPeerId?.get(normalizedKey);
  if (peer && known.has(peer)) return peer;

  const nameMatches = [];
  for (const id of known) {
    const name = String(nameById?.get(id) || '').trim();
    if (!name) continue;
    if (phoneLifeActorKey(name) === normalizedKey) nameMatches.push(id);
  }
  if (nameMatches.length === 1) return nameMatches[0];
  if (nameMatches.length > 1) return '';

  const fromActor = actorIndex?.get(key)?.id || actorIndex?.get(normalizedKey)?.id;
  if (fromActor && known.has(fromActor)) return fromActor;
  if (peer) return peer;
  return fromActor || '';
}

/**
 * 「补一轮手机动态」：一次 API 调用生成手机主人整机的聊天动态——
 * 可以新建联系人/群、给已有窗续写、让主人和 NPC 发生简短往来。
 * 单窗精修仍走会话内的「推进」（runChatAiTurn 全量人设链路）。
 */
export async function generatePhoneLifeBatch({
  user,
  ownerId,
  signal = null,
  onProgress = null,
} = {}) {
  const uid = cleanId(user?.id);
  const cid = cleanId(ownerId);
  if (!uid || !cid) throw new Error('缺少手机主人');
  await purgePhoneUserImpersonators({ user, ownerId: cid }).catch(() => {});
  onProgress?.('正在整理手机主人的人设与通讯录…');
  const now = await getNowForUser(uid).catch(() => Date.now());

  const [
    owner,
    ownerPhone,
    allCharacters,
    contactsState,
    phoneChats,
    relationshipNet,
    contactGroupsConfig,
    acquaintanceLedger,
    lastPhoneLifeBatch,
  ] = await Promise.all([
    getCharacter(cid, { userId: uid }),
    loadCharacterPhone(uid, cid).catch(() => null),
    listCharacters({ includeInternal: true, userId: uid, identityScoped: true }).catch(() => []),
    loadCharacterPhoneContacts(uid, cid),
    listCharacterPhoneChats(uid, cid),
    loadRelationshipNetwork(uid).catch(() => null),
    loadContactGroupsConfig().catch(() => ({ groups: [] })),
    loadAcquaintanceLedger().catch(() => ({ entries: [] })),
    loadLastPhoneLifeBatch(uid, cid).catch(() => null),
  ]);
  if (!owner) throw new Error('找不到手机主人角色');
  const ownerTimeZone = await resolveCharacterScheduleTimezone(uid, cid, owner).catch(() => '');
  const currentContext = await collectCharacterPhoneCurrentContext({
    userId: uid,
    characterId: cid,
    character: owner,
    phone: ownerPhone,
    now,
    timeZone: ownerTimeZone,
  });
  const ownerName = characterName(owner, cid);
  const userName = getUserDisplayName(user) || '用户';
  const ownerMainDm = await findPrivateChat(uid, cid).catch(() => null);
  const ownerPrivateContinuity = ownerMainDm?.id
    ? (await listMessagesForChat(ownerMainDm.id, 24).catch(() => []))
      .filter((message) => message && !message.deleted && !message.recalled)
      .slice(-24)
      .map((message) => ({
        minutesAgo: Math.max(0, Number(((now - Number(message.timestamp || now)) / 60000).toFixed(1))),
        speaker: message.senderId === 'user' ? 'user（只读背景）' : ownerName,
        text: lifeClip(message.content, 100),
      }))
      .filter((message) => message.text)
    : [];
  const safeCharacters = allCharacters.filter((row) => (
    row?.id
    && !isPhoneUserIdentityRef(characterName(row, row.id), { userId: uid, userName })
  ));
  const charMap = new Map(safeCharacters.map((row) => [row.id, row]));
  const nameById = new Map(safeCharacters.map((row) => [row.id, characterName(row, row.id)]));
  const socialDirectory = createPhoneSocialActorDirectory({
    ownerId: cid,
    characters: safeCharacters,
    relationshipNetwork: relationshipNet,
    contacts: contactsState.contacts || [],
    removedLinkedCharacterIds: contactsState.removedLinkedCharacterIds || [],
    removedLinkedActorIds: contactsState.removedLinkedActorIds || [],
  });
  const relationshipNpcActors = socialDirectory.candidates
    .filter((actor) => actor.kind === 'relationship-npc')
    .filter((actor) => !isPhoneUserIdentityRef(actor.name || actor.id, { userId: uid, userName }));
  for (const actor of relationshipNpcActors) nameById.set(actor.id, actor.name || actor.id);
  const previousGeneratedAt = Number(
    lastPhoneLifeBatch?.worldCreatedAt || lastPhoneLifeBatch?.createdAt || 0,
  );
  const generationWindowStart = previousGeneratedAt > 0 && previousGeneratedAt < now
    ? previousGeneratedAt
    : now - 48 * 60 * 60 * 1000;
  const generationWindowEnd = Math.max(generationWindowStart + 1, now - 1000);
  const generationWindowMinutes = Math.max(
    0.01,
    (generationWindowEnd - generationWindowStart) / (60 * 1000),
  );
  const ownerGroupId = resolveCharacterGroupId(owner);

  // 联系人候选：已有非 user 窗、开启组内互识的分组、关系网/角色卡/剧情认识、手机轻量联系人里已绑定的角色
  const relatedSet = new Set();
  const addRelated = (id) => {
    const key = cleanId(id);
    if (!key || key === cid || key === 'user' || !charMap.has(key)) return;
    if (!canPhoneAutoContactLinkedPeer(contactsState, key)) return;
    if (!canPhoneCharactersKnowEachOther(
      owner,
      charMap.get(key),
      relationshipNet,
      contactGroupsConfig,
      acquaintanceLedger,
    )) return;
    relatedSet.add(key);
  };
  for (const row of phoneChats) {
    if ((row.participants || []).includes('user')) continue;
    for (const id of row.participants || []) addRelated(id);
  }
  for (const row of safeCharacters) {
    if (ownerGroupId && resolveCharacterGroupId(row) === ownerGroupId) addRelated(row.id);
  }
  for (const id of collectCoNetworkMemberIds(relationshipNet, [cid])) addRelated(id);
  const ownerRel = owner.relationships && typeof owner.relationships === 'object' ? owner.relationships : {};
  for (const id of Object.keys(ownerRel)) addRelated(id);
  for (const item of contactsState.contacts || []) {
    if (item.linkedCharacterId) addRelated(item.linkedCharacterId);
  }
  const relatedCharacterIds = [...relatedSet];
  const relatedActorIds = [...new Set([
    ...relatedCharacterIds,
    ...relationshipNpcActors.map((actor) => actor.id),
  ])];
  let worldBook = '';
  try {
    worldBook = await buildWorldBookContextBlock(user || null, [
      ownerName,
      owner.personality || '',
      relatedActorIds.map((id) => nameById.get(id) || id).join(' '),
    ].join(' '), { characterIds: [cid, ...relatedCharacterIds], worldBookMode: 'full' });
  } catch (_) { worldBook = ''; }

  const relationLines = relationshipNet
    ? collectGlobalRelationshipNetworkLines(relationshipNet, {
      partnerIds: [cid, ...relatedCharacterIds],
      characters: Object.fromEntries(charMap),
      userName,
      maxEdges: 200,
      includeUser: false,
    })
    : [];
  const relationshipContext = buildRelationshipContextBlock(relationshipNet, {
    participantIds: [cid, ...relatedCharacterIds],
    characters: Object.fromEntries(charMap),
    userName,
    acquaintanceLedger,
    contactGroupsConfig,
    maxLines: 80,
  });

  // 补记录绝不碰「和用户」的窗：不出现在候选里，落库时也会再挡一层。
  const chatBriefs = [];
  const eligibleChats = phoneChats.filter((row) => {
    if ((row.participants || []).includes('user')) return false;
    return (row.participants || []).every((id) => {
      const key = cleanId(id);
      return !key || key === cid || !charMap.has(key)
        || canPhoneCharactersKnowEachOther(
          owner,
          charMap.get(key),
          relationshipNet,
          contactGroupsConfig,
          acquaintanceLedger,
        );
    });
  });
  const peerIdsWithChat = new Set();
  for (const row of eligibleChats) {
    for (const id of row.participants || []) {
      if (id && id !== cid && id !== 'user') peerIdsWithChat.add(id);
    }
  }
  // 续写只给少量已有窗作参考；本轮主目标是扩通讯录外 NPC
  for (const row of eligibleChats.slice(0, 8)) {
    const recent = await listMessagesForChat(row.id, 6).catch(() => []);
    chatBriefs.push({
      chatId: row.id,
      type: row.type === 'group' ? 'group' : 'private',
      title: resolvePhoneChatTitle(row, cid, Object.fromEntries(charMap), userName),
      members: (row.participants || []).map((id) => characterName(charMap.get(id), id)),
      recent: recent.filter((m) => m && !m.deleted && !m.recalled)
        .map((m) => `${m.senderName || m.senderId}: ${lifeClip(m.content, 60)}`),
    });
  }

  const contactsWithoutChat = (contactsState.contacts || [])
    .filter((item) => {
      const peer = phoneContactCanonicalActorId(item);
      if (!peer || peer === cid || peerIdsWithChat.has(peer)) return false;
      return !charMap.has(peer)
        || canPhoneCharactersKnowEachOther(
          owner,
          charMap.get(peer),
          relationshipNet,
          contactGroupsConfig,
          acquaintanceLedger,
        );
    })
    .slice(0, 12)
    .map((item) => ({
      id: item.id,
      name: item.name || item.nickname || item.id,
      category: item.category || 'other',
      linkedCharacterId: item.linkedCharacterId || '',
      relationship: lifeClip(item.personaCapsule?.relationship || item.note || '', 80),
      translationProfile: item.translationProfile || {},
    }));

  const preferredNetworkGroups = collectPreferredNetworkGroups(
    relationshipNet,
    cid,
    nameById,
    charMap,
  );
  const occupiedRelationshipSlots = collectOccupiedPhoneRelationshipSlots({
    owner,
    ownerId: cid,
    contacts: contactsState.contacts || [],
    characters: safeCharacters,
    relationshipNetwork: relationshipNet,
  });

  const payload = {
    owner: buildCompletePhoneCharacterProfile(owner, {
      name: ownerName,
      now,
      nameById,
      userName,
      includeUserRelations: false,
    }),
    currentContext,
    ownerPrivateContinuity,
    worldBook,
    relationshipNetwork: relationLines,
    relationshipContext,
    preferredNetworkGroups,
    occupiedUniqueRelationshipSlots: phoneRelationshipSlotLabels(occupiedRelationshipSlots),
    // 主通讯录 / 关系网已有角色：建群或需要熟人时必须用他们的 id，禁止另造同名替身
    knownCharacters: relatedCharacterIds.map((id) => {
      const row = charMap.get(id);
      return buildCompletePhoneCharacterProfile(row, {
        name: characterName(row, id),
        now,
        nameById,
        userName,
        includeUserRelations: false,
      });
    }),
    actorCandidates: socialDirectory.candidates.map((actor) => ({
      actorRef: actor.id,
      name: actor.name || actor.id,
      kind: actor.kind,
      relationship: lifeClip(
        actor.contact?.personaCapsule?.relationship
        || actor.contact?.note
        || actor.npc?.note
        || actor.character?.relationships?.[cid]
        || owner.relationships?.[actor.id]
        || '',
        100,
      ),
    })),
    contacts: (contactsState.contacts || []).filter((item) => {
      const linkedId = cleanId(item.linkedCharacterId);
      return !linkedId || !charMap.has(linkedId)
        || canPhoneCharactersKnowEachOther(
          owner,
          charMap.get(linkedId),
          relationshipNet,
          contactGroupsConfig,
          acquaintanceLedger,
        );
    }).slice(0, 20).map((item) => ({
      id: item.id,
      name: item.name || item.nickname || item.id,
      remark: item.nickname && item.nickname !== item.name ? item.nickname : '',
      category: item.category || 'other',
      linkedCharacterId: item.linkedCharacterId || '',
      relationship: lifeClip(item.personaCapsule?.relationship || item.note || '', 80),
      translationProfile: item.translationProfile || {},
    })),
    contactsWithoutChat,
    groups: (contactsState.groups || []).filter((item) => (item.memberIds || []).every((id) => {
      const linked = (contactsState.contacts || []).find((contact) => contact.id === id)?.linkedCharacterId || id;
      return !charMap.has(linked)
        || canPhoneCharactersKnowEachOther(
          owner,
          charMap.get(linked),
          relationshipNet,
          contactGroupsConfig,
          acquaintanceLedger,
        );
    })).slice(0, 10).map((item) => ({
      id: item.id,
      name: item.name,
      memberIds: item.memberIds || [],
    })),
    existingChats: chatBriefs,
    generationWindow: {
      mode: previousGeneratedAt > 0 ? 'since_last_generation' : 'initial_backfill',
      startTs: generationWindowStart,
      endTs: generationWindowEnd,
      startLabel: formatClockInTimezone(generationWindowStart, ownerTimeZone)
        || new Date(generationWindowStart).toLocaleString('zh-CN'),
      endLabel: formatClockInTimezone(generationWindowEnd, ownerTimeZone)
        || new Date(generationWindowEnd).toLocaleString('zh-CN'),
      ownerTimeZone,
      maxMinutesAgo: Number(generationWindowMinutes.toFixed(2)),
    },
  };
  const identitySocialDirective = buildIdentitySocialDirective(owner, ownerName);

  onProgress?.('正在生成整机聊天动态…');
  const maxTokens = await resolveGenerationMaxTokens();
  const translationActors = collectTranslationActors([
    { id: cid, name: ownerName, translationProfile: owner.translationProfile },
    ...relatedCharacterIds.map((id) => {
      const row = charMap.get(id);
      return { id, name: characterName(row, id), translationProfile: row?.translationProfile };
    }),
    ...(contactsState.contacts || [])
      .filter((item) => isPhoneLocalLightContact(item))
      .map((item) => ({
        id: item.id,
        name: item.name || item.nickname || item.id,
        translationProfile: item.translationProfile,
      })),
  ]);
  const translationPrompt = buildJsonFieldTranslationPromptBlock(translationActors, {
    fields: 'messages[].text',
    exampleField: 'text',
  });
  const existingChatTypes = new Map(chatBriefs.map((item) => [item.chatId, item.type]));
  // Prefer stream like chat: large non-stream completions are easier to cut off on APK relays.
  const { data: parsed } = await chatJsonGeneration({
    scope: 'character-phone-messages',
    messages: [{
      role: 'system',
      content: `你在为一部虚构角色的手机扩展「日常社会面」聊天记录（过去已发生）。以下是背景资料 JSON：
${JSON.stringify(payload)}

【身份隔离·最高优先级】这是不含用户身份的角色社会面生成。不得把 user 创建成联系人、群成员、收件人或 speaker，不得猜测、影射或扮演 user，任何名字都不能取得 user 身份。ownerPrivateContinuity 是唯一提供的主窗内容，只代表 owner 本人的只读记忆；其他联系人默认不知道，只有 owner 在生成消息里实际说出的部分才会成为对方知情。
【当前事实硬规则】currentContext 的 runtime / activeOffline / schedule 优先级高于常住地、关系网、角色卡 currentStatus 和既有侧窗。这里只补过去时间窗内的聊天，不得让消息暗示 owner 此刻已经离开当前地点、另赴外地或取消正在进行的同行，也不得输出任何会改写 owner 当前 status/state 的安排；未来邀约必须明确是未定候选，不能写成已经出发或正在发生。
【全窗口时序连续】existingChats、ownerPrivateContinuity 和本轮所有 threads 属于同一个 owner 的同一条绝对时间线。输出前按 minutesAgo 从旧到新合并检查：owner 不能在重叠时间同时位于互斥地点、做互斥活动，也不能无交通过程瞬移；过去消息必须能自然衔接到 currentContext 的最终当前状态。
【分享门槛】主窗记忆用于避免 owner 失忆，不是转播素材。只有同时具备明确分享动机、对收件人有交流价值、不过度私密且对象关系合适时，owner 才能用自己的话概括 user 相关内容。user 的秘密、脆弱、暧昧/争吵原话不得外传；吃了哪道菜、几点睡、普通行踪等琐事默认不值得分享。过不了门槛就聊 owner 自己的生活、续接旧话题或询问对方近况，不能为了凑 threads 转播 user。
【本轮目标】只补 generationWindow.startTs 到 generationWindow.endTs 之间新发生的手机往来，不得回填到上一轮生成之前。让既有社交自然继续：优先使用 contactsWithoutChat 或 actorCandidates 中尚未开窗的人建立新窗口；其次续写 existingChats 中确有未完线索的窗口；只有这些人不足时，才登记轻量 NPC，供下一轮使用。
若已有窗口在这个增量时间窗内没有自然可续写的内容，不要重复旧话题或硬灌水，应优先增加一扇合理的新窗口。minutesAgo 必须在 0.01～generationWindow.maxMinutesAgo 之间。
禁止为了凑数量重复建联系人、给已有角色造同名替身，或把关系网外的真实角色拉进来。
occupiedUniqueRelationshipSlots 列出已经有人占用的唯一关系槽（母亲、父亲、配偶）；这些槽绝对不能再创建第二个人，即使姓名、备注或称呼不同。
【人设完整性硬规则】owner 与 knownCharacters 已提供完整语义角色卡，所有字段都必须服从；birthDate/age、currentRole/currentStatus、promptCorpus、speechCorpus、promptTagDirectives、lifeProfile、notes、relationships 与世界书不得忽略。年龄与身份冲突时以明确资料为准；没有“当前在校”明确信息，禁止仅因示例或模型惯性把成年人写成学生、同学、室友、社团成员或校园生活。
${identitySocialDirective}

请做这些事：
1. newContacts 可以为空，最多新建 2 个轻量联系人；仅在 contactsWithoutChat 和 knownCharacters 都不足以完成本轮时才新建。新联系人本轮只登记，绝对不能出现在 newGroups、threads、contactRef 或 speakerId，下一轮拿到程序分配的正式 id 后才能参与聊天。姓名用真名/日常称呼（不要用「爸爸」「老板」这类备注称谓当 name），禁止填写 npc_ 开头的内部标识、随机字母数字串、微博/论坛账号 ID。联系人类型必须先服从 owner 的当前身份与生活阶段，不要求机械覆盖每个 category。例如：
   - family：远房亲戚、长辈、亲戚群成员
   - work：仅在 owner 有明确职业、实习或兼职线索时，生成与该身份匹配的同事、上司、客户或合作方
   - friend：同学、室友、邻居、老友、社团成员或兴趣搭子，按身份选择
   - rival：纠缠、骚扰、已拉黑/想拉黑、关系紧张对象
   - other：老师/辅导员、社区熟人、快递员/物业/客服、偶然认识的人等不适合前述分类的关系
   - 若联系人设定、姓名、成长地或说话方式明确表明其日常主要使用非中文，必须写 translationProfile={"mode":"full","language":"具体语言"}；主要说中文写 mode="off"；偶尔夹外语才写 mode="mixed" 和 dialectNote。不要仅凭外文名武断判定。
1.1 检查 contacts 里旧轻量联系人的人设：只有资料明确能判断其主要语言时，才在 contactLanguageUpdates 里按 id 补语言档案；不确定就不要输出更新。后续 messages 必须立即服从该档案。
2. 最多新建 1 个生活化群（newGroups）。
   【建群硬规则 · 优先真角色】
   - 若群里需要家人/同事/朋友/同学等「主要联系人」，必须优先从 knownCharacters 与 preferredNetworkGroups 里挑已有角色，members 写他们的 **id**（不要只写名字，更不要另造一个同名轻量联系人顶替）。
   - preferredNetworkGroups 里已有的小群结构可直接沿用或微调名称，成员 id 保持原样。
   - 禁止为 knownCharacters 里已有的人再 newContacts 一个替身；speakerId 提到这些人时也必须用 knownCharacters.id。
   - 只有关系网/主通讯录确实没有对应真人时，才登记 newContacts；本轮不得把它们填进群。
3. 有既有合格对象时写 2~5 扇窗的往来（threads）；若只能登记 newContacts，threads 可以为空：
   - 优先给 contactsWithoutChat 里尚无会话的人开窗；通讯录为空也可直接从 actorCandidates 选一人，把其 actorRef 写到 thread.actorRef，程序会在首次实际联系时补联系人；不得给本轮 newContacts 开窗。
   - 续写 existingChats：最多 1~2 扇，且仅当 recent 有明显未完结线索；禁止对同一熟人连灌水
   - knownCharacters：不要大面积续写他们的私聊窗；但建群/群聊发言需要他们时必须调用本人 id
4. 每扇窗 3~8 条「短气泡」消息（见下方气泡硬规则）；话题从 owner 当前身份对应的课程/社团/家庭/兴趣/工作/生活事务中动态选择，可含寒暄、待办、小摩擦或骚扰被拒/拉黑语气。没有明确职业线索时不要生成工作琐事。
5. 每扇窗必须同时写 states：该窗 messages 里每个实际发言角色恰好一条，speakerId 与其气泡完全一致。inner 是这段往来结束后没有说出口的真实脑内话，要有角色自己的口吻和与气泡的信息差，不能改写成聊天总结；intent 只写此刻确实存在的打算，没有就留空；status 写消息结束时真实地点与正在做的事；moodShift 通常在 -12～12。inner、intent、status 一律直接写简体中文普通话，不跟随角色翻译设置，也不要输出 innerZh。不得给 user、未发言者或旁白写 state。

【气泡格式 · 对齐棉花糖短气泡，不是长段独白】
- messages 数组里每一项 = 一条独立聊天气泡；text 内禁止换行、禁止写成小作文。
- 单条 text 通常一句口语（约 8~40 字），硬上限约 60 字；一个点一条，换点另起一条。
- 同一个人要连说几句时，输出多条 messages（同一 speakerId），不要把几句话塞进一条 text。
- 私聊必须由双方都发言；群聊至少两名成员发言。任何一方不能整轮沉默。
- 禁止旁白、动作描写、剧本式「（笑）」「【旁白】」；只写说出口的话。
- 禁止一条气泡里用「不过/另外/话说回来」缝多个话题。
${translationPrompt ? `\n${translationPrompt}\n- 有 translation.mode=full / mixed 的角色发言时，messages 项写成 {"speakerId":"...","text":"...","zh":"...","minutesAgo":120}；无外语需求的角色不用加 zh。` : ''}

关系硬规则（比生活化更优先）：
- 必须服从 owner/knownCharacters 的 relationships、relationshipNetwork 与 relationshipContext；这些资料已经排除了用户关系。
- 群聊/私聊里凡出现 knownCharacters 中的人，必须用其真实 id 与人设发言，禁止用新造轻量联系人冒充。
- 若两人是情敌、竞争、暧昧三角里对立的一方，聊天口吻应带张力或客气疏离，绝不能突然改称对方为家属/兄弟/闺蜜。
- speakerId 只能逐字使用 owner / knownCharacters / contacts 中已经给出的 id；禁止使用姓名、昵称、user 或本轮 newContacts。
- actorRef 只能逐字使用 actorCandidates.actorRef；contactRef 只能逐字使用 contactsWithoutChat / contacts 中已经给出的 id；groupRef 只能使用 groups 中已经给出的 id；chatId 只能使用 existingChats 中已有 id。
    - 身份解析与落库姓名只用真名（newContacts.name / contacts.name）；remark 只是手机显示备注，不得当作 speakerId、actorRef 或身份依据。
- minutesAgo 表示这条消息是多少分钟前发的，必须服从 generationWindow.maxMinutesAgo；同一扇窗内按对话先后从大到小递减。

只输出 JSON，结构：
{"newContacts":[{"name":"","remark":"手机主人给对方的可选短备注","category":"work|family|friend|rival|other","relationship":"","personality":"","translationProfile":{"mode":"off|full|mixed","language":"","dialectNote":""}}],
"contactLanguageUpdates":[{"id":"已有轻量联系人id","translationProfile":{"mode":"full|mixed","language":"","dialectNote":""}}],
"newGroups":[{"name":"","members":["优先写 knownCharacters 的 id"]}],
"threads":[{"chatId":"只能填 existingChats 的 id，或省略","actorRef":"可填 actorCandidates.actorRef","contactRef":"可填已有 contacts 的 id","groupRef":"只能填已有 groups 的 id，或省略","messages":[{"speakerId":"只能填已有 actor id","text":"","zh":"外语气泡才需要","minutesAgo":120}],"states":[{"speakerId":"本窗实际发言角色 id","inner":"简体中文心声","intent":"简体中文的此刻真实打算或空字符串","status":"简体中文的地点与正在做的事","moodShift":0}]}]}`,
    }, {
      role: 'user',
      content: '请按上述完整手机主人、世界书、关系网与时间线生成本轮整机聊天 JSON。',
    }],
    temperature: 0.85,
    maxTokens,
    signal,
    preferStream: true,
    onProgress,
    validate: (value) => (
      (
        (Array.isArray(value?.threads) && value.threads.length > 0)
        || (Array.isArray(value?.newContacts) && value.newContacts.length > 0)
      )
      && phoneLifeBatchHasSpeakerStates(value)
      && phoneLifeBatchHasCompleteConversations(value, { ownerId: cid, existingChatTypes })
    ),
    describeValidationError: () => '模型返回的私聊缺少一侧发言，请重新补一轮',
  });
  if (!parsed || (
    (!Array.isArray(parsed.threads) || !parsed.threads.length)
    && (!Array.isArray(parsed.newContacts) || !parsed.newContacts.length)
  )) {
    const error = new Error('整机聊天动态未返回有效 JSON');
    error.reason = 'json-parse-failed';
    throw error;
  }

  onProgress?.('正在落库联系人与聊天记录…');
  const batchId = makePhoneLifeBatchId();
  const summary = {
    contacts: 0,
    groups: 0,
    threads: 0,
    messages: 0,
    batchId,
  };
  const batchIndex = {
    batchId,
    createdAt: Date.now(),
    worldCreatedAt: now,
    messageIds: [],
    touchedChatIds: [],
    createdChatIds: [],
    createdContactIds: [],
    createdGroupIds: [],
    stateRoundRefs: [],
    contactTranslationRestores: [],
  };
  const existingChatIds = new Set(phoneChats.map((row) => cleanId(row.id)).filter(Boolean));
  const isEligibleRealPeerId = (id) => {
    const key = cleanId(id);
    if (!key) return true;
    if (charMap.has(key) && !canPhoneAutoContactLinkedPeer(contactsState, key)) return false;
    return !charMap.has(key)
      || canPhoneCharactersKnowEachOther(
        owner,
        charMap.get(key),
        relationshipNet,
        contactGroupsConfig,
        acquaintanceLedger,
      );
  };

  for (const update of (Array.isArray(parsed.contactLanguageUpdates) ? parsed.contactLanguageUpdates : []).slice(0, 12)) {
    const contactId = cleanId(update?.id);
    if (!contactId || !(contactsState.contacts || []).some((item) => (
      item.id === contactId && isPhoneLocalLightContact(item)
    ))) continue;
    const previous = contactsState.contacts.find((item) => item.id === contactId);
    batchIndex.contactTranslationRestores.push({
      id: contactId,
      translationProfile: previous?.translationProfile || {},
    });
    await upsertPhoneContact(uid, cid, {
      id: contactId,
      translationProfile: update?.translationProfile || update?.translation,
    }).catch(() => null);
  }

  // actor 解析表：id 与名字都能查到；先登记真角色，再登记轻量联系人（同名时真角色优先）
  const knownIds = new Set([cid, ...relatedActorIds]);
  const existingActorRefs = new Set(knownIds);
  const existingContactRefs = new Set();
  const existingGroupRefs = new Set((contactsState.groups || []).map((group) => cleanId(group?.id)).filter(Boolean));
  const actorIndex = new Map();
  const indexActor = (id, name, { prefer = false } = {}) => {
    const sid = String(id || '').trim();
    const sname = String(name || '').trim();
    if (sid) {
      if (prefer || !actorIndex.has(sid)) actorIndex.set(sid, { id: sid, name: sname || sid });
    }
    if (sname) {
      if (prefer || !actorIndex.has(sname)) actorIndex.set(sname, { id: sid, name: sname });
      const nameKey = phoneLifeActorKey(sname);
      if (nameKey && (prefer || !actorIndex.has(nameKey))) {
        actorIndex.set(nameKey, { id: sid, name: sname });
      }
    }
  };
  indexActor(cid, ownerName, { prefer: true });
  for (const id of relatedCharacterIds) {
    indexActor(id, characterName(charMap.get(id), id), { prefer: true });
  }
  for (const actor of relationshipNpcActors) {
    indexActor(actor.id, actor.name || actor.id, { prefer: true });
  }
  for (const item of contactsState.contacts || []) {
    if (item?.id) {
      existingActorRefs.add(cleanId(item.id));
      existingContactRefs.add(cleanId(item.id));
    }
    const canonicalActorId = phoneContactCanonicalActorId(item);
    if (canonicalActorId && canonicalActorId !== item.id) {
      existingActorRefs.add(canonicalActorId);
      existingContactRefs.add(canonicalActorId);
      knownIds.add(canonicalActorId);
    }
    if (canonicalActorId !== item.id) {
      if (!isEligibleRealPeerId(canonicalActorId)) continue;
      indexActor(canonicalActorId, characterName(charMap.get(canonicalActorId), item.name || canonicalActorId), { prefer: true });
      indexActor(item.id, item.name || item.nickname);
      if (item.name) indexActor(canonicalActorId, item.name, { prefer: true });
      if (item.nickname) indexActor(canonicalActorId, item.nickname, { prefer: true });
    } else {
      indexActor(item.id, item.name || item.nickname);
    }
  }

  // 已有可用但尚未开窗的联系人/关系网 actor 时，直接复用他们；
  // 不能在上一位刚开窗后立刻再造两位，导致每次「补一轮」都无限扩通讯录。
  const hasReusableActorWithoutChat = socialDirectory.candidates.some((actor) => (
    actor?.id && !peerIdsWithChat.has(actor.id)
  ));
  const newContactLimit = contactsWithoutChat.length || hasReusableActorWithoutChat ? 0 : 2;
  for (const rawContact of (Array.isArray(parsed.newContacts) ? parsed.newContacts : []).slice(0, newContactLimit)) {
    const name = lifeClip(rawContact?.name, 40);
    if (!name || isLikelyGeneratedSocialActorCode(name)
      || isPhoneUserImpersonator(rawContact, { userId: uid, userName })) continue;
    if (isLightweightNpcDismissed(relationshipNet, { name })) continue;
    if (shouldRejectDuplicatePhoneRelationshipContact(rawContact, occupiedRelationshipSlots)) continue;
    // 禁止用 newContacts 顶替已知真角色
    const existingKnown = resolvePhoneLifeActorRef(name, {
      knownIds,
      nameById,
      actorIndex,
      contactPeerId: new Map(),
    });
    if (existingKnown && knownIds.has(existingKnown)) continue;
    // 已有真角色或轻量联系人都必须复用；不能给同一个名字再铸一个本地 id。
    if (actorIndex.has(name) || actorIndex.has(phoneLifeActorKey(name))) continue;
    const saved = await upsertPhoneContact(uid, cid, {
      name,
      remark: lifeClip(rawContact?.remark, 40),
      category: rawContact?.category || 'other',
      personaCapsule: {
        relationship: lifeClip(rawContact?.relationship, 120),
        summary: lifeClip(rawContact?.personality, 160),
      },
      translationProfile: rawContact?.translationProfile || rawContact?.translation,
    }).catch(() => null);
    if (saved?.id) {
      batchIndex.createdContactIds.push(saved.id);
      summary.contacts += 1;
      const newSlots = new Set(uniquePhoneRelationshipSlots(rawContact?.relationship));
      const newContactName = String(rawContact?.name || '').replace(/\s+/g, '');
      for (const rule of UNIQUE_PHONE_RELATIONSHIP_SLOT_RULES) {
        if (rule.exactNamePattern.test(newContactName)) newSlots.add(rule.id);
      }
      for (const slot of newSlots) {
        occupiedRelationshipSlots.add(slot);
      }
    }
  }

  const groupIndex = new Map();
  const contactPeerId = new Map(); // contact local id / name -> peer id used for real chat
  const freshContacts = await loadCharacterPhoneContacts(uid, cid);
  for (const contact of freshContacts.contacts || []) {
    const peerId = phoneContactCanonicalActorId(contact);
    contactPeerId.set(contact.id, peerId);
    if (contact.name) {
      contactPeerId.set(String(contact.name).trim(), peerId);
      contactPeerId.set(phoneLifeActorKey(contact.name), peerId);
    }
    if (contact.nickname) {
      contactPeerId.set(String(contact.nickname).trim(), peerId);
      contactPeerId.set(phoneLifeActorKey(contact.nickname), peerId);
    }
    // 已链接：名字直接映射到真角色 id
    if (peerId !== contact.id) {
      contactPeerId.set(peerId, peerId);
      if (contact.name) contactPeerId.set(String(contact.name).trim(), peerId);
      if (contact.nickname) contactPeerId.set(String(contact.nickname).trim(), peerId);
    }
  }
  for (const group of freshContacts.groups || []) {
    groupIndex.set(group.id, group);
    groupIndex.set(String(group.name || '').trim(), group);
    const memberKey = phoneContactGroupMemberKey(group, freshContacts.contacts);
    if (memberKey) groupIndex.set(`members:${memberKey}`, group);
  }
  for (const rawGroup of (Array.isArray(parsed.newGroups) ? parsed.newGroups : []).slice(0, 1)) {
    const name = lifeClip(rawGroup?.name, 30);
    if (!name || groupIndex.has(name)) continue;
    // 先解析成真角色 / 联系人 peer，再确保有本地联系人条目（群存储用本地 id）
    const peerIds = [...new Set((Array.isArray(rawGroup?.members) ? rawGroup.members : [])
      .map((ref) => {
        const strictRef = cleanId(ref);
        if (!existingActorRefs.has(strictRef)) return '';
        return resolvePhoneLifeActorRef(strictRef, {
          knownIds,
          nameById,
          actorIndex,
          contactPeerId,
        });
      })
      .filter((id) => id && id !== cid && id !== 'user' && isEligibleRealPeerId(id)))]
      .slice(0, 8);
    if (peerIds.length < 2) continue;
    const localMemberIds = [];
    for (const peerId of peerIds) {
      let localId = '';
      for (const [key, mapped] of contactPeerId.entries()) {
        if (mapped === peerId && freshContacts.contacts?.some((c) => c.id === key)) {
          localId = key;
          break;
        }
      }
      if (!localId) {
        const existing = (freshContacts.contacts || []).find((c) => (
          c.id === peerId || phoneContactCanonicalActorId(c) === peerId
        ));
        if (existing?.id) {
          localId = existing.id;
        } else if (knownIds.has(peerId) && canPhoneAutoContactLinkedPeer(freshContacts, peerId)) {
          const alreadyContactId = (freshContacts.contacts || []).find((c) =>
            phoneContactCanonicalActorId(c) === peerId)?.id;
          const actor = socialDirectory.resolve(peerId);
          const savedContact = actor
            ? await ensurePhoneSocialActorContact(uid, cid, actor).catch(() => null)
            : null;
          if (savedContact?.id) {
            if (!alreadyContactId) batchIndex.createdContactIds.push(savedContact.id);
            localId = savedContact.id;
            contactPeerId.set(savedContact.id, peerId);
            contactPeerId.set(peerId, peerId);
            const nm = nameById.get(peerId);
            if (nm) contactPeerId.set(nm, peerId);
            freshContacts.contacts = [...(freshContacts.contacts || []), savedContact];
            indexActor(peerId, nm || peerId, { prefer: true });
          }
        } else {
          localId = peerId;
        }
      }
      if (localId) localMemberIds.push(localId);
    }
    const uniqueLocals = [...new Set(localMemberIds)].slice(0, 8);
    if (uniqueLocals.length < 2) continue;
    const memberKey = phoneContactGroupMemberKey({ memberIds: uniqueLocals }, freshContacts.contacts);
    const existingGroup = memberKey ? groupIndex.get(`members:${memberKey}`) : null;
    if (existingGroup) {
      // 模型换了群名但成员没变时复用旧群，且让本轮 thread 的新名字仍能解析到它。
      groupIndex.set(name, existingGroup);
      continue;
    }
    const saved = await upsertPhoneContactGroup(uid, cid, { name, memberIds: uniqueLocals }).catch(() => null);
    if (saved?.id) {
      groupIndex.set(saved.id, saved);
      groupIndex.set(name, saved);
      if (memberKey) groupIndex.set(`members:${memberKey}`, saved);
      batchIndex.createdGroupIds.push(saved.id);
      summary.groups += 1;
    }
  }

  for (const [threadIndex, thread] of (Array.isArray(parsed.threads) ? parsed.threads : []).slice(0, 5).entries()) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const bubbles = [];
    for (const m of (Array.isArray(thread?.messages) ? thread.messages : [])) {
      const speakerRef = String(m?.speakerId ?? m?.speaker ?? '').trim();
      if (!existingActorRefs.has(speakerRef)
        || isPhoneUserIdentityRef(speakerRef, { userId: uid, userName })) continue;
      const resolvedId = resolvePhoneLifeActorRef(speakerRef, {
        knownIds,
        nameById,
        actorIndex,
        contactPeerId,
      });
      const actor = (resolvedId && actorIndex.get(resolvedId))
        || actorIndex.get(speakerRef)
        || (resolvedId
          ? { id: resolvedId, name: nameById.get(resolvedId) || resolvedId }
          : null);
      if (!actor || actor.id === 'user') continue;
      // 真角色优先：用关系网/主通讯录 id 与真名落库
      if (knownIds.has(actor.id) || knownIds.has(resolvedId)) {
        const realId = knownIds.has(resolvedId) ? resolvedId : actor.id;
        actor.id = realId;
        actor.name = nameById.get(realId) || actor.name || realId;
      }
      const minutesAgo = Math.max(
        0.01,
        Math.min(generationWindowMinutes, Number(m?.minutesAgo) || Math.min(120, generationWindowMinutes)),
      );
      const rawText = String(m?.text ?? m?.content ?? '').trim();
      const actorTranslationProfile = charMap.get(actor.id)?.translationProfile
        || freshContacts.contacts?.find((item) => (
          item.id === actor.id || item.linkedCharacterId === actor.id
        ))?.translationProfile
        || {};
      const translation = sanitizeAiTranslation(rawText, m?.zh || m?.translation || '', {
        languageHint: actorTranslationProfile.language || actorTranslationProfile.dialectNote || '',
      });
      // Keep foreign bubbles intact when a zh sibling is present (avoid splitting mid-sentence).
      const texts = translation ? [lifeClip(rawText, 80)] : expandPhoneLifeBubbleTexts(rawText);
      for (const text of texts) {
        if (!text) continue;
        bubbles.push({
          actor: { id: actor.id, name: actor.name },
          text: lifeClip(text, 80),
          minutesAgo,
          translation,
        });
      }
    }
    const capped = bubbles.slice(0, 10);
    if (!capped.length) continue;

    // 解析目标窗：已有 chatId > 联系人私聊 > 群
    let targetChat = null;
    const chatId = cleanId(thread?.chatId);
    if (chatId) {
      if (!existingChatIds.has(chatId)) continue;
      const found = await getChat(chatId).catch(() => null);
      if (found && (found.participants || []).includes(cid)) targetChat = found;
    }
    if (!targetChat) {
      const actorRef = String(thread?.actorRef || '').trim();
      if (actorRef) {
        if (!existingActorRefs.has(actorRef)
          || isPhoneUserIdentityRef(actorRef, { userId: uid, userName })) continue;
        const peerId = resolvePhoneLifeActorRef(actorRef, {
          knownIds,
          nameById,
          actorIndex,
          contactPeerId,
        });
        const actor = peerId ? socialDirectory.resolve(peerId) : null;
        if (actor
          && socialDirectory.candidates.some((candidate) => candidate.id === actor.id)
          && actor.id !== cid
          && isEligibleRealPeerId(actor.id)) {
          const alreadyHadContact = (freshContacts.contacts || []).some((contact) => (
            phoneContactCanonicalActorId(contact) === actor.id
          ));
          const savedContact = await ensurePhoneSocialActorContact(uid, cid, actor).catch(() => null);
          if (savedContact?.id && !alreadyHadContact) {
            if (!batchIndex.createdContactIds.includes(savedContact.id)) {
              batchIndex.createdContactIds.push(savedContact.id);
            }
            freshContacts.contacts = [...(freshContacts.contacts || []), savedContact];
            summary.contacts += 1;
          }
          targetChat = await ensurePhonePeerChat(uid, cid, actor.id).catch(() => null);
        }
      }
    }
    if (!targetChat) {
      const contactRef = String(thread?.contactRef || '').trim();
      if (contactRef) {
        if (!existingContactRefs.has(contactRef)
          || isPhoneUserIdentityRef(contactRef, { userId: uid, userName })) continue;
        const peerId = resolvePhoneLifeActorRef(contactRef, {
          knownIds,
          nameById,
          actorIndex,
          contactPeerId,
        })
          || contactPeerId.get(contactRef)
          || actorIndex.get(contactRef)?.id
          || '';
        if (peerId && peerId !== cid && peerId !== 'user' && isEligibleRealPeerId(peerId)) {
          targetChat = await ensurePhonePeerChat(uid, cid, peerId).catch(() => null);
        }
      }
    }
    if (!targetChat) {
      const groupRef = String(thread?.groupRef || '').trim();
      const group = groupRef && existingGroupRefs.has(groupRef) ? groupIndex.get(groupRef) : null;
      if (group?.id) {
        const latestContacts = await loadCharacterPhoneContacts(uid, cid).catch(() => freshContacts);
        const participants = resolvePhoneGroupParticipantIds(
          cid,
          group,
          latestContacts.contacts || freshContacts.contacts || [],
        );
        if (!participants.every((id) => id === cid || id === 'user' || isEligibleRealPeerId(id))) continue;
        targetChat = await ensureBackstageChat(
          uid,
          (await resolvePhoneMainParentChatId(uid, cid)) || `phone:${cid}`,
          group.name,
          participants,
          {
            ownerId: cid,
            phoneOwnerId: cid,
            phoneContactGroupId: group.id,
          },
        ).catch(() => null);
      }
    }
    if (!targetChat?.id) continue;

    // 补记录绝不写入与用户相关的窗
    if ((targetChat.participants || []).includes('user')) continue;
    // 模型或旧联系人不能借由批处理新建/续写无显式关系的跨分组窗口。
    if (!(targetChat.participants || []).every((id) => id === cid || id === 'user' || isEligibleRealPeerId(id))) continue;
    const participantIds = new Set((targetChat.participants || []).filter((id) => id && id !== 'user'));
    const speakerIds = new Set(capped.map((row) => row.actor.id).filter((id) => participantIds.has(id)));
    // 先隔离窗口外身份，再按私聊/群聊人数做最终完整性保护。
    if (!phoneLifeThreadHasAuthorizedSpeaker([...participantIds], [...speakerIds])) continue;
    const privateThread = targetChat.type !== 'group' && participantIds.size === 2;
    if (privateThread && (!speakerIds.has(cid) || speakerIds.size < 2)) continue;
    if (!privateThread && speakerIds.size < 2) continue;
    const rows = capped.filter((row) => participantIds.has(row.actor.id));
    if (!rows.length) continue;
    const stateEvents = [];
    const stateSpeakerIds = new Set();
    for (const rawState of (Array.isArray(thread?.states) ? thread.states : [])) {
      const speakerRef = String(rawState?.speakerId ?? rawState?.from ?? '').trim();
      if (!speakerRef || !existingActorRefs.has(speakerRef)) continue;
      const resolvedId = resolvePhoneLifeActorRef(speakerRef, {
        knownIds,
        nameById,
        actorIndex,
        contactPeerId,
      });
      if (!resolvedId || !speakerIds.has(resolvedId) || stateSpeakerIds.has(resolvedId)) continue;
      stateSpeakerIds.add(resolvedId);
      stateEvents.push({
        t: 'state',
        from: resolvedId,
        inner: rawState?.inner || rawState?.innerVoice || '',
        innerZh: rawState?.innerZh || rawState?.zh || '',
        intent: rawState?.intent || '',
        status: rawState?.status || '',
        moodShift: rawState?.moodShift,
      });
    }
    const repairEntries = rows.map((row, index) => ({
      id: `phone_life_${index}`,
      source: row.text,
      translation: row.translation,
      languageHint: (() => {
        const profile = charMap.get(row.actor.id)?.translationProfile
          || freshContacts.contacts?.find((item) => (
            item.id === row.actor.id || item.linkedCharacterId === row.actor.id
          ))?.translationProfile
          || {};
        return profile.language || profile.dialectNote || '';
      })(),
    }));
    const repaired = await repairTranslationEntries(repairEntries, {
      signal,
      automatic: true,
    }).catch(() => new Map());
    rows.forEach((row, index) => {
      if (!row.translation && repaired.has(`phone_life_${index}`)) {
        row.translation = repaired.get(`phone_life_${index}`);
      }
    });
    const isExistingChat = existingChatIds.has(cleanId(targetChat.id));
    if (isExistingChat) {
      if (!batchIndex.touchedChatIds.includes(targetChat.id)) batchIndex.touchedChatIds.push(targetChat.id);
    } else if (!batchIndex.createdChatIds.includes(targetChat.id)) {
      batchIndex.createdChatIds.push(targetChat.id);
      existingChatIds.add(cleanId(targetChat.id));
    }

    // minutesAgo 从大到小 → 时间戳升序；程序再次钳制到“上次生成后～现在”，
    // 即使模型忽略提示也不能把新消息塞回更早历史。
    rows.sort((a, b) => b.minutesAgo - a.minutesAgo);
    const lowerBound = generationWindowStart + 1;
    const upperBound = generationWindowEnd;
    const availableMs = Math.max(1, upperBound - lowerBound);
    const spacingMs = Math.max(1, Math.min(45 * 1000, Math.floor(availableMs / (rows.length + 1))));
    let cursor = lowerBound - spacingMs;
    const stateRoundId = `${batchId}_${threadIndex}`;
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      const row = rows[rowIndex];
      const remaining = rows.length - rowIndex - 1;
      const desiredTs = now - row.minutesAgo * 60 * 1000;
      const latestAllowed = Math.max(lowerBound, upperBound - remaining * spacingMs);
      cursor = Math.min(
        latestAllowed,
        Math.max(cursor + spacingMs, lowerBound, desiredTs),
      );
      const messageId = `${batchId}_${Math.random().toString(36).slice(2, 8)}`;
      await saveMessage({
        id: messageId,
        chatId: targetChat.id,
        senderId: row.actor.id,
        senderName: row.actor.name,
        content: row.text,
        type: 'text',
        timestamp: cursor,
        metadata: {
          phoneLifeBatch: true,
          phoneLifeBatchId: batchId,
          aiRoundKind: 'phone-life',
          aiRoundId: stateRoundId,
          ...(row.translation ? { translation: row.translation } : {}),
        },
      });
      batchIndex.messageIds.push(messageId);
      summary.messages += 1;
    }
      const chatPrefs = await loadChatPrefs(targetChat.id).catch(() => ({}));
      if (chatPrefs.innerVoiceDisabled !== true && stateEvents.length) {
        const applied = await applyRoundStateEvents(targetChat.id, stateEvents, {
          userId: uid,
          userName,
          aiRoundId: stateRoundId,
        aiRoundCreatedAt: cursor,
        allowScheduleOverride: false,
        resolveSenderName: async (characterId) => (
          nameById.get(characterId)
          || actorIndex.get(characterId)?.name
          || characterId
        ),
      }).catch(() => null);
      if (applied) {
        batchIndex.stateRoundRefs.push({
          chatId: targetChat.id,
          aiRoundId: stateRoundId,
        });
      }
    }
    await recalcChatPreview(targetChat.id).catch(() => {});
    summary.threads += 1;
  }

  if (!summary.messages && !summary.contacts && !summary.groups) {
    const error = new Error('这一轮没有生成出可落库的联系人或聊天消息，请重试');
    error.reason = 'no-results';
    error.rawText = JSON.stringify(parsed || {}).slice(0, 4000);
    throw error;
  }
  await saveLastPhoneLifeBatch(uid, cid, batchIndex);
  return summary;
}

/**
 * 撤销上一轮「补一轮手机动态」：只删带该 batchId 的消息；
 * 本轮新建且已空的窗走 deleteChatWithData；回滚本轮新建的轻量联系人/群。
 */
export async function undoLastPhoneLifeBatch(userId = '', ownerId = '', options = {}) {
  const uid = cleanId(userId);
  const cid = cleanId(ownerId);
  const batch = options.batch || await loadLastPhoneLifeBatch(uid, cid);
  if (!batch?.batchId) throw new Error('没有可撤销的上一轮手机动态');

  const deletedMessageIds = new Set();
  for (const messageId of batch.messageIds || []) {
    await deleteMessage(messageId).catch(() => {});
    deletedMessageIds.add(messageId);
  }
  for (const ref of batch.stateRoundRefs || []) {
    await rewindCharStateForAiRound(ref.chatId, ref.aiRoundId).catch(() => {});
  }

  // 兜底：按 batchId 扫一遍相关窗，避免索引漏记
  const scanChatIds = [...new Set([
    ...(batch.touchedChatIds || []),
    ...(batch.createdChatIds || []),
  ])];
  for (const chatId of scanChatIds) {
    const rows = await listMessagesForChat(chatId, 0).catch(() => []);
    for (const msg of rows) {
      if (msg?.metadata?.phoneLifeBatchId !== batch.batchId) continue;
      if (deletedMessageIds.has(msg.id)) continue;
      await deleteMessage(msg.id).catch(() => {});
      deletedMessageIds.add(msg.id);
    }
  }

  let deletedChats = 0;
  for (const chatId of batch.createdChatIds || []) {
    const rows = await listMessagesForChat(chatId, 0).catch(() => []);
    const leftover = rows.filter((m) => m
      && !m.deleted
      && m.metadata?.phoneLifeBatchId !== batch.batchId);
    if (leftover.length) {
      await recalcChatPreview(chatId).catch(() => {});
      continue;
    }
    await deleteChatWithData(chatId, uid).catch(() => {});
    deletedChats += 1;
  }

  for (const chatId of batch.touchedChatIds || []) {
    await recalcChatPreview(chatId).catch(() => {});
  }

  if ((batch.createdContactIds || []).length || (batch.createdGroupIds || []).length) {
    const state = await loadCharacterPhoneContacts(uid, cid);
    const dropContacts = new Set(batch.createdContactIds || []);
    const dropGroups = new Set(batch.createdGroupIds || []);
    const next = {
      ...state,
      contacts: (state.contacts || []).filter((item) => !dropContacts.has(item.id)),
      groups: (state.groups || [])
        .filter((item) => !dropGroups.has(item.id))
        .map((group) => ({
          ...group,
          memberIds: (group.memberIds || []).filter((id) => !dropContacts.has(id)),
        })),
    };
    await saveCharacterPhoneContacts(uid, cid, next);
  }
  for (const restore of batch.contactTranslationRestores || []) {
    await upsertPhoneContact(uid, cid, {
      id: restore.id,
      translationProfile: restore.translationProfile,
    }).catch(() => {});
  }

  await saveLastPhoneLifeBatch(uid, cid, null);
  return {
    batchId: batch.batchId,
    messages: deletedMessageIds.size,
    chats: deletedChats,
    contacts: (batch.createdContactIds || []).length,
    groups: (batch.createdGroupIds || []).length,
  };
}

/** 撤销上一轮后再生成一轮整机动态。 */
export async function rerollLastPhoneLifeBatch({
  user,
  ownerId,
  signal = null,
  onProgress = null,
} = {}) {
  const uid = cleanId(user?.id);
  const cid = cleanId(ownerId);
  onProgress?.('正在撤销上一轮手机动态…');
  await undoLastPhoneLifeBatch(uid, cid);
  onProgress?.('正在重新生成整机动态…');
  return generatePhoneLifeBatch({ user, ownerId: cid, signal, onProgress });
}

/**
 * 为手机联系人补一小段已经发生的工作/生活往来。
 * 仅用于用户主动补全，绝不接入后台自动回复；最多两条短消息，避免首次建档成本失控。
 */
export async function generatePhoneNpcRound({
  user,
  ownerId,
  chatId,
  contact = null,
  scenario = '',
  signal = null,
  onProgress = null,
} = {}) {
  const chat = await getChat(chatId);
  const uid = cleanId(user?.id);
  const cid = cleanId(ownerId);
  if (!chat || !uid || !cid || !(chat.participants || []).includes(cid)) {
    throw new Error('手机主人不在该会话中');
  }
  if (!tryLockCharacterPhoneChat(chat.id)) throw new Error('这个会话正在生成，请稍后再试');
  try {
    onProgress?.('正在整理联系人关系和已有记录…');
    const messages = await listMessagesForChat(chat.id, 120);
    const characters = await loadParticipantContext(chat, uid, cid);
    const now = await getNowForUser(uid).catch(() => Date.now());
    const capsule = contact?.personaCapsule || {};
    const category = String(contact?.category || '').trim();
    const sceneLabel = String(scenario || ({
      work: '工作上的简短沟通',
      family: '家人间的日常关心',
      friend: '朋友之间的生活闲聊',
      rival: '关系紧张但仍有必要的往来',
    }[category] || '与近期生活有关的自然往来')).trim();
    const ownerName = characterName(characters[cid], cid);
    const contactName = String(contact?.nickname || contact?.name || '').trim() || '联系人';
    onProgress?.('正在生成一段过去的对话…');
    return await runTrackedPhoneChatTurn(chat.id, signal, (trackedSignal) => runChatAiTurn({
      chat,
      chatId: chat.id,
      user,
      userId: uid,
      messages,
      characters,
      phoneViewerId: cid,
      manual: true,
      allowBlockedManual: true,
      skipBusyAutoReply: true,
      preferStream: false,
      aiRoundKind: 'phone-npc-round',
      gapFillWindow: { startTs: now - 72 * 3600000, endTs: now - 5 * 60000 },
      sceneDirective: [
        '【角色手机·联系人往来补全】这是已经发生在过去时间线里的短聊天。',
        buildPeerPrivatePhoneIdentityDirective(chat, {
          ownerName,
          peerNames: [contactName],
        }),
        `手机主人是 ${ownerName}（id=${cid}），联系人是 ${contactName}。`,
        `场景：${sceneLabel}。联系人关系：${capsule.relationship || contact?.note || '按当前关系自然交流'}。`,
        capsule.summary ? `联系人性格：${capsule.summary}` : '',
        capsule.speechStyle ? `联系人说话方式：${capsule.speechStyle}` : '',
        '生成一段贴合人物与场景的真实交流，消息数量与分条服从【回复节奏 · 错落】；不要替用户发言，不要新建群或岔入无关剧情，也不要重复已有记录。',
      ].filter(Boolean).join('\n'),
      signal: trackedSignal,
    }));
  } finally {
    unlockCharacterPhoneChat(chat.id);
  }
}

export async function ensurePhonePeerChat(userId, ownerId, peerId, options = {}) {
  const uid = cleanId(userId);
  const oid = cleanId(ownerId);
  const requestedPeerId = cleanId(peerId);
  const [contactsState, relationshipNet, allCharacters] = await Promise.all([
    loadCharacterPhoneContacts(uid, oid).catch(() => ({
      contacts: [],
      removedLinkedCharacterIds: [],
      removedLinkedActorIds: [],
    })),
    loadRelationshipNetwork(uid).catch(() => null),
    listCharacters({ includeInternal: true, userId: uid, identityScoped: true }).catch(() => []),
  ]);
  const directory = createPhoneSocialActorDirectory({
    ownerId: oid,
    characters: allCharacters,
    relationshipNetwork: relationshipNet,
    contacts: contactsState.contacts || [],
    removedLinkedCharacterIds: contactsState.removedLinkedCharacterIds || [],
    removedLinkedActorIds: contactsState.removedLinkedActorIds || [],
  });
  // 所有入口都可能传手机联系人行 id；建窗前统一收敛到角色 / 关系网 NPC 的稳定 actor id。
  const pid = cleanId(directory.resolve(requestedPeerId)?.id || requestedPeerId);
  if (!canPhoneAutoContactLinkedPeer(contactsState, pid) && options.manual !== true) {
    throw new Error('该角色已从这部手机移除');
  }
  const sociallyEligible = await canPhoneCharacterIdsKnowEachOther(
    oid,
    pid,
    uid,
  ).catch(() => false);
  if (sociallyEligible === false) {
    throw new Error('跨分组角色尚未在关系网建立联系');
  }
  if (sociallyEligible == null) {
    const actor = directory.resolve(pid);
    if (!actor || !directory.candidates.some((candidate) => candidate.id === actor.id)) {
      throw new Error('该身份不在手机主人的社交关系中');
    }
    await ensurePhoneSocialActorContact(uid, oid, actor);
  }
  const mainDm = await findPrivateChat(uid, oid).catch(() => null);
  const chat = await ensurePeerPrivateChat(uid, [oid, pid], {
    focalActorId: oid,
    parentChatId: mainDm?.id || '',
  });
  const phoneChannel = String(options.phoneChannel || '').trim();
  if (chat && phoneChannel === 'intercept') {
    const meta = { ...(chat.metadata || {}) };
    if (meta.phoneChannel !== 'intercept' || meta.phoneOwnerId !== ownerId) {
      meta.phoneChannel = 'intercept';
      meta.phoneOwnerId = cleanId(ownerId);
      chat.metadata = meta;
      await saveChat(chat).catch(() => {});
    }
  }
  return chat;
}

function phoneParticipantKey(ids = []) {
  return [...new Set((Array.isArray(ids) ? ids : [])
    .map((id) => cleanId(id))
    .filter((id) => id && id !== 'user' && id !== 'system'))].sort().join(',');
}

/**
 * 找出「当前手机已有联系人」与「关系网 NPC」中同名、且确实和手机主人有会话的身份。
 * 只收敛 owner 参与会话里的 NPC，避免把别的角色生活圈中碰巧同名的人误合并。
 */
export function collectPhoneNpcIdentityAliases({
  ownerId = '',
  contacts = [],
  relationshipNpcs = [],
  chats = [],
} = {}) {
  const oid = cleanId(ownerId);
  if (!oid) return {};
  const ownerPeers = new Set();
  for (const chat of Array.isArray(chats) ? chats : []) {
    const participants = Array.isArray(chat?.participants) ? chat.participants.map(cleanId) : [];
    if (!participants.includes(oid)) continue;
    participants.forEach((id) => {
      if (id && id !== oid && id !== 'user' && id !== 'system') ownerPeers.add(id);
    });
  }
  const aliases = {};
  // 旧版线下手机动作可能直接拿 contact.id 或 linkedActorId 建窗。联系人转正后
  // linkedCharacterId 是新的 canonical actor；旧的本地 id / 轻量 NPC id 都可依据
  // 这条明确绑定无歧义迁回正式角色，不需要再依赖同名猜测。
  for (const contact of Array.isArray(contacts) ? contacts : []) {
    const canonicalId = cleanId(phoneContactCanonicalActorId(contact));
    if (!canonicalId || canonicalId === oid || canonicalId === 'user') continue;
    const legacyIds = [...new Set([
      cleanId(contact?.id),
      cleanId(contact?.linkedActorId),
      cleanId(contact?.canonicalActorId),
    ].filter(Boolean))];
    for (const oldId of legacyIds) {
      if (oldId === canonicalId || oldId === oid || oldId === 'user') continue;
      if (ownerPeers.has(oldId)) aliases[oldId] = canonicalId;
    }
  }
  const peerNpcsByName = new Map();
  for (const npc of Array.isArray(relationshipNpcs) ? relationshipNpcs : []) {
    const oldId = cleanId(npc?.id);
    const key = phoneLifeActorKey(npc?.name || '');
    if (!oldId || !key || !ownerPeers.has(oldId)) continue;
    if (!peerNpcsByName.has(key)) peerNpcsByName.set(key, []);
    peerNpcsByName.get(key).push(npc);
  }
  for (const npc of Array.isArray(relationshipNpcs) ? relationshipNpcs : []) {
    const oldId = cleanId(npc?.id);
    if (!oldId || !ownerPeers.has(oldId)) continue;
    const key = phoneLifeActorKey(npc?.name || '');
    if (!key || peerNpcsByName.get(key)?.length !== 1) continue;
    const contact = findPhoneContactByActorName(contacts, npc?.name || '');
    // 已经明确链接到同一个关系网 NPC 时，canonical 仍是 linkedActorId；
    // 不能反向把聊天迁到 phone-contact:*，否则列表会同时出现本地 id 与 actor id。
    const canonicalId = cleanId(phoneContactCanonicalActorId(contact));
    if (!canonicalId || canonicalId === oldId || canonicalId === oid) continue;
    if (aliases[oldId]) continue;
    aliases[oldId] = canonicalId;
  }
  return aliases;
}

function replacePhoneNpcIds(values = [], aliases = {}) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((id) => aliases[cleanId(id)] || cleanId(id))
    .filter(Boolean))];
}

function replacePhoneNpcGroupSettings(settings = {}, aliases = {}) {
  const next = { ...(settings || {}) };
  for (const key of ['admins', 'muted']) {
    if (Array.isArray(next[key])) next[key] = replacePhoneNpcIds(next[key], aliases);
  }
  if (next.owner && aliases[cleanId(next.owner)]) next.owner = aliases[cleanId(next.owner)];
  for (const key of ['memberCards', 'titles']) {
    if (!next[key] || typeof next[key] !== 'object') continue;
    const values = {};
    for (const [id, value] of Object.entries(next[key])) {
      values[aliases[cleanId(id)] || id] = value;
    }
    next[key] = values;
  }
  return next;
}

function replacePhoneNpcNetworkIds(net = {}, aliases = {}, contacts = []) {
  const contactById = new Map((contacts || []).map((row) => [cleanId(row?.id), row]));
  const linkedCharacterIds = new Set((contacts || [])
    .map((row) => cleanId(row?.linkedCharacterId))
    .filter(Boolean));
  const npcById = new Map();
  for (const row of net.npcs || []) {
    const id = aliases[cleanId(row?.id)] || cleanId(row?.id);
    // 迁到主角色 id 后只保留圈/边引用，不能再在 npcs[] 里复制一份角色实体。
    if (!id || linkedCharacterIds.has(id)) continue;
    const contact = contactById.get(id);
    const previous = npcById.get(id);
    npcById.set(id, {
      ...(row || {}),
      ...(previous || {}),
      id,
      name: contact?.name || previous?.name || row?.name || '',
      avatar: contact?.avatar || previous?.avatar || row?.avatar || '',
    });
  }
  const circles = (net.circles || []).map((circle) => {
    const edges = [];
    const seenEdges = new Set();
    for (const edge of circle.edges || []) {
      const a = aliases[cleanId(edge?.a)] || cleanId(edge?.a);
      const b = aliases[cleanId(edge?.b)] || cleanId(edge?.b);
      if (!a || !b || a === b) continue;
      const key = `${[a, b].sort().join('\0')}|${String(edge?.label || '').trim()}`;
      if (seenEdges.has(key)) continue;
      seenEdges.add(key);
      edges.push({ ...edge, a, b });
    }
    return {
      ...circle,
      memberIds: replacePhoneNpcIds(circle.memberIds, aliases),
      edges,
      groups: (circle.groups || []).map((group) => ({
        ...group,
        memberIds: replacePhoneNpcIds(group.memberIds, aliases),
      })),
    };
  });
  return { ...net, npcs: [...npcById.values()], circles };
}

/**
 * 将旧关系网 NPC 会话迁到同名手机联系人：
 * participants、消息 senderId、群设置和关系网引用一起迁移；已有目标私聊则合窗。
 */
export async function reconcilePhoneContactNpcIdentities(userId = '', ownerId = '') {
  const uid = cleanId(userId);
  const oid = cleanId(ownerId);
  if (!uid || !oid) return { changed: 0, movedMessages: 0, mergedChats: 0 };
  const task = phoneNpcIdentityRepairQueue.then(async () => {
    const [state, net, chats] = await Promise.all([
      loadCharacterPhoneContacts(uid, oid).catch(() => null),
      loadRelationshipNetwork(uid).catch(() => null),
      listChatsForUser(uid).catch(() => []),
    ]);
    if (!state) return { changed: 0, movedMessages: 0, mergedChats: 0 };
    const aliases = collectPhoneNpcIdentityAliases({
      ownerId: oid,
      contacts: state.contacts || [],
      relationshipNpcs: net?.npcs || [],
      chats,
    });
    const oldIds = Object.keys(aliases);
    if (!oldIds.length) return { changed: 0, movedMessages: 0, mergedChats: 0 };

    let changed = 0;
    let movedMessages = 0;
    let mergedChats = 0;
    const deleted = new Set();
    for (const chat of chats) {
      if (deleted.has(chat.id) || !(chat.participants || []).includes(oid)) continue;
      if (!(chat.participants || []).some((id) => aliases[cleanId(id)])) continue;
      const participants = replacePhoneNpcIds(chat.participants, aliases);
      const metadata = { ...(chat.metadata || {}) };
      if (metadata.focalActorId && aliases[cleanId(metadata.focalActorId)]) {
        metadata.focalActorId = aliases[cleanId(metadata.focalActorId)];
      }
      if (isPeerPrivateChat(chat)) metadata.peerPrivateKey = phoneParticipantKey(participants);
      const nextChat = {
        ...chat,
        participants,
        groupSettings: replacePhoneNpcGroupSettings(chat.groupSettings, aliases),
        metadata,
      };
      const messages = await listMessagesForChat(chat.id, 0).catch(() => []);
      const rewritten = messages.map((message) => {
        const senderId = aliases[cleanId(message?.senderId)] || message?.senderId;
        const metadata = { ...(message?.metadata || {}) };
        let metadataChanged = false;
        for (const key of ['recipientId', 'phoneOwnerId']) {
          const nextId = aliases[cleanId(metadata[key])];
          if (!nextId) continue;
          metadata[key] = nextId;
          metadataChanged = true;
        }
        return senderId === message?.senderId && !metadataChanged
          ? message
          : { ...message, senderId, metadata };
      });
      movedMessages += rewritten.filter((row, index) => row !== messages[index]).length;

      const target = isPeerPrivateChat(chat)
        ? chats.find((candidate) => (
          candidate?.id !== chat.id
          && !deleted.has(candidate?.id)
          && isPeerPrivateChat(candidate)
          && phoneParticipantKey(candidate.participants) === phoneParticipantKey(participants)
        ))
        : null;
      if (target) {
        await db.putMany('messages', rewritten.map((message) => ({ ...message, chatId: target.id })));
        await saveChat({
          ...target,
          lastActivity: Math.max(Number(target.lastActivity || 0), Number(chat.lastActivity || 0)),
          lastMessage: Number(chat.lastActivity || 0) >= Number(target.lastActivity || 0)
            ? (chat.lastMessage || target.lastMessage || '')
            : (target.lastMessage || chat.lastMessage || ''),
        });
        await db.deleteRecord('chats', chat.id);
        await db.remove(`chatPrefs_${chat.id}`).catch(() => {});
        await recalcChatPreview(target.id).catch(() => {});
        deleted.add(chat.id);
        mergedChats += 1;
      } else {
        if (rewritten.some((row, index) => row !== messages[index])) {
          await db.putMany('messages', rewritten);
        }
        await saveChat(nextChat);
      }
      changed += 1;
    }
    if (net) {
      await saveRelationshipNetwork(
        replacePhoneNpcNetworkIds(net, aliases, state.contacts || []),
        uid,
      );
    }
    return { changed, movedMessages, mergedChats, aliases };
  });
  phoneNpcIdentityRepairQueue = task.catch(() => {});
  return task;
}

/**
 * 会话衍生、但未写入手机通讯录的联系人（常见于已取缔的秘密基地两人群 / 关系网轻量 NPC）。
 * 这类人不应挤进主联系人列表假装可编辑。
 */
export function isPhoneSessionOrphanPeer(peerId = '', {
  phoneContacts = [],
  userCharacterIds = [],
  peerName = '',
} = {}) {
  const id = cleanId(peerId);
  if (!id || id === 'user') return false;
  const contacts = Array.isArray(phoneContacts) ? phoneContacts : [];
  // 已入通讯录（精确 id / linked / 同名 / id 被 wrap 进 phone-contact）都不算孤儿。
  if (phoneContactCoversPeer(contacts, id, peerName)) return false;
  const roster = new Set((Array.isArray(userCharacterIds) ? userCharacterIds : []).map(cleanId).filter(Boolean));
  if (roster.has(id)) return false;
  return true;
}

/** 手机主人与某 peer 之间可安全清掉的二人窗：私聊 / peer_private / 旧秘密基地两人群 */
export function listPhoneOwnerPeerPairChats(chats = [], ownerId = '', peerId = '') {
  const owner = cleanId(ownerId);
  const peer = cleanId(peerId);
  if (!owner || !peer) return [];
  return (Array.isArray(chats) ? chats : []).filter((chat) => {
    if (!chat) return false;
    const parts = [...new Set((chat.participants || [])
      .map((id) => cleanId(id))
      .filter((id) => id && id !== 'user'))];
    if (!parts.includes(owner) || !parts.includes(peer)) return false;
    if (chat.type === 'private' || isPeerPrivateChat(chat)) {
      return parts.length === 2;
    }
    // 历史「秘密基地两人群」：无 user、恰两人、仍挂 backstage
    if (chat.type === 'group' && isBackstageChat(chat) && parts.length === 2) return true;
    return false;
  });
}

/**
 * 将历史手机群里的 owner-scoped 联系人 id 收敛到稳定角色 id。
 *
 * 旧消息 senderId 不改写：原 id 会留在 phoneLightNpcAliases，确保历史气泡仍能
 * 显示当时的姓名与头像。只有 id 链接明确，或联系人姓名在主角色中唯一时才迁移，
 * 避免同名角色被错误合并。
 */
export async function reconcilePhoneGroupParticipantIdentities(chat, {
  userId = '',
  characters = null,
  findPhoneContactAcrossOwners = null,
} = {}) {
  if (!chat || chat.type !== 'group') return { chat, replaced: {}, aliases: {} };
  const uid = cleanId(userId || chat.userId);
  const characterRows = Array.isArray(characters)
    ? characters
    : (uid
      ? await listCharacters({ includeInternal: true, userId: uid, identityScoped: true }).catch(() => [])
      : []);
  const findAcrossOwners = typeof findPhoneContactAcrossOwners === 'function'
    ? findPhoneContactAcrossOwners
    : await loadPhoneContactAcrossOwnersLookup().catch(() => (() => null));
  const characterById = new Map(characterRows
    .map((row) => [cleanId(row?.id), row])
    .filter(([id]) => id));
  const characterIdsByName = new Map();
  for (const row of characterRows) {
    const id = cleanId(row?.id);
    if (!id) continue;
    for (const value of [row?.name, row?.realName, row?.customNickname, row?.nickname]) {
      const key = phoneSocialActorNameKey(value);
      if (!key) continue;
      if (!characterIdsByName.has(key)) characterIdsByName.set(key, new Set());
      characterIdsByName.get(key).add(id);
    }
  }
  const uniqueCharacterIdByName = (value = '') => {
    const ids = characterIdsByName.get(phoneSocialActorNameKey(value));
    return ids?.size === 1 ? [...ids][0] : '';
  };

  const previousAliases = (
    chat.metadata?.phoneLightNpcAliases
    && typeof chat.metadata.phoneLightNpcAliases === 'object'
  ) ? chat.metadata.phoneLightNpcAliases : {};
  const compactAliases = { ...previousAliases };
  const replacements = {};

  const legacyMatchIsCorroborated = (match, storedAlias) => {
    if (!match || match.matchKind !== 'legacy-prefix') return !!match;
    if (!storedAlias || typeof storedAlias !== 'object') return false;
    const contact = match.contact || {};
    const exactRefs = [
      [storedAlias.phoneContactId, contact.id],
      [storedAlias.linkedCharacterId, contact.linkedCharacterId],
      [storedAlias.linkedActorId, contact.linkedActorId || contact.canonicalActorId],
    ];
    if (exactRefs.some(([left, right]) => cleanId(left) && cleanId(left) === cleanId(right))) return true;
    const aliasName = phoneSocialActorNameKey(resolvePhoneSocialActorDisplayName(storedAlias));
    const contactName = phoneSocialActorNameKey(resolvePhoneSocialActorDisplayName(contact));
    return !!aliasName && aliasName === contactName;
  };

  for (const rawId of chat.participants || []) {
    const id = cleanId(rawId);
    if (!id || id === 'user' || id === 'system' || characterById.has(id)) continue;
    const storedAlias = previousAliases[id] && typeof previousAliases[id] === 'object'
      ? previousAliases[id]
      : null;
    const across = /^phone-contact:/i.test(id) ? findAcrossOwners(id) : null;
    // 完整 id 可直接信任；旧截断 id 即使只剩一个前缀候选，也必须再由历史别名
    // 的姓名或稳定绑定佐证，避免联系人删除后把残留成员迁到同手机的另一个人。
    const contact = legacyMatchIsCorroborated(across, storedAlias) ? across.contact : null;
    const readableName = resolvePhoneSocialActorDisplayName(
      contact,
      storedAlias,
      across?.displayName,
    );
    const linkedId = cleanId(
      contact?.linkedCharacterId
      || contact?.linkedActorId
      || contact?.canonicalActorId
      || storedAlias?.linkedCharacterId,
    );
    let canonicalId = linkedId && linkedId !== id ? linkedId : '';
    if (!canonicalId && readableName) canonicalId = uniqueCharacterIdByName(readableName);
    if (canonicalId && canonicalId !== id) replacements[id] = canonicalId;

    if (!contact && !storedAlias) continue;
    const canonicalCharacter = characterById.get(canonicalId) || null;
    const displayName = resolvePhoneSocialActorDisplayName(
      canonicalCharacter,
      contact,
      storedAlias,
    );
    compactAliases[id] = {
      id,
      name: displayName,
      realName: displayName,
      customNickname: String(contact?.nickname || storedAlias?.customNickname || '').trim(),
      avatar: String(
        canonicalCharacter?.avatar
        || canonicalCharacter?.avatarUrl
        || contact?.avatar
        || storedAlias?.avatar
        || '',
      ).trim(),
      phoneContactId: cleanId(contact?.id || storedAlias?.phoneContactId),
      linkedCharacterId: characterById.has(canonicalId)
        ? canonicalId
        : cleanId(storedAlias?.linkedCharacterId),
    };
  }

  const nextParticipants = replacePhoneNpcIds(chat.participants, replacements);
  const nextGroupSettings = replacePhoneNpcGroupSettings(chat.groupSettings, replacements);
  const aliasesChanged = JSON.stringify(compactAliases) !== JSON.stringify(previousAliases);
  const participantsChanged = JSON.stringify(nextParticipants) !== JSON.stringify(chat.participants || []);
  const settingsChanged = JSON.stringify(nextGroupSettings) !== JSON.stringify(chat.groupSettings || {});
  if (!aliasesChanged && !participantsChanged && !settingsChanged) {
    return { chat, replaced: {}, aliases: compactAliases };
  }
  chat.participants = nextParticipants;
  chat.groupSettings = nextGroupSettings;
  chat.metadata = {
    ...(chat.metadata || {}),
    phoneLightNpcAliases: compactAliases,
  };
  await saveChat(chat);
  return { chat, replaced: replacements, aliases: compactAliases };
}

/**
 * 修复已经被旧前缀迁移串位的群成员。只接受一组很窄的强证据：
 * - 别名键正好是旧版 60 字 phone-contact id；
 * - 该 id 的历史气泡始终署同一个可读姓名，且唯一对应另一张角色卡；
 * - 当前被替入的角色没有用自己的 id 在群里发过言。
 * 任一条件不足都保持原数据，避免二次猜错。
 */
export async function repairMisattributedTruncatedPhoneGroupParticipants(chat, {
  characters = [],
  findPhoneContactAcrossOwners = null,
} = {}) {
  if (!chat || chat.type !== 'group') return { changed: false, replacements: {} };
  const aliases = (
    chat.metadata?.phoneLightNpcAliases
    && typeof chat.metadata.phoneLightNpcAliases === 'object'
  ) ? chat.metadata.phoneLightNpcAliases : {};
  const suspicious = Object.entries(aliases).filter(([legacyId, alias]) => (
    /^phone-contact:/i.test(legacyId)
    && legacyId.length === 60
    && cleanId(alias?.linkedCharacterId)
    && (chat.participants || []).includes(cleanId(alias.linkedCharacterId))
  ));
  if (!suspicious.length) return { changed: false, replacements: {} };

  const characterRows = Array.isArray(characters) ? characters : [];
  const characterById = new Map(characterRows
    .map((row) => [cleanId(row?.id), row])
    .filter(([id]) => id));
  const characterIdsByName = new Map();
  for (const row of characterRows) {
    const id = cleanId(row?.id);
    if (!id) continue;
    for (const value of [row?.name, row?.realName, row?.customNickname, row?.nickname]) {
      const key = phoneSocialActorNameKey(value);
      if (!key) continue;
      if (!characterIdsByName.has(key)) characterIdsByName.set(key, new Set());
      characterIdsByName.get(key).add(id);
    }
  }
  const messages = await listMessagesForChat(chat.id, 0).catch(() => []);
  const findAcrossOwners = typeof findPhoneContactAcrossOwners === 'function'
    ? findPhoneContactAcrossOwners
    : (() => null);
  const expectedSettingPrefix = chat.userId
    ? `characterPhoneContacts:${encodeURIComponent(cleanId(chat.userId))}:`
    : '';
  const replacements = {};
  const aliasPatches = {};

  for (const [legacyId, alias] of suspicious) {
    const currentId = cleanId(alias?.linkedCharacterId);
    const currentCharacter = characterById.get(currentId);
    if (!currentCharacter) continue;
    const currentContactId = cleanId(alias?.phoneContactId);
    if (!currentContactId || !relationshipActorIdsMatch(currentContactId, legacyId)) continue;

    const historicalNames = messages
      .filter((message) => cleanId(message?.senderId) === legacyId)
      .map((message) => String(message?.senderName || '').trim())
      .filter(Boolean);
    const historicalNameKeys = [...new Set(historicalNames
      .map(phoneSocialActorNameKey)
      .filter(Boolean))];
    if (historicalNameKeys.length !== 1) continue;
    const targetMatches = [...(characterIdsByName.get(historicalNameKeys[0]) || [])]
      .map((id) => ({ id, hit: findAcrossOwners(id) }))
      .filter(({ hit }) => (
        hit?.contact
        && (!expectedSettingPrefix || String(hit.settingKey || '').startsWith(expectedSettingPrefix))
      ));
    if (targetMatches.length !== 1) continue;
    const [{ id: targetId, hit: targetHit }] = targetMatches;
    if (!targetId || targetId === currentId || (chat.participants || []).includes(targetId)) continue;

    const currentNameKeys = new Set([
      currentCharacter.name,
      currentCharacter.realName,
      currentCharacter.customNickname,
      currentCharacter.nickname,
    ].map(phoneSocialActorNameKey).filter(Boolean));
    const currentHasOwnMessages = messages.some((message) => (
      cleanId(message?.senderId) === currentId
      && (!message?.senderName || currentNameKeys.has(phoneSocialActorNameKey(message.senderName)))
    ));
    if (currentHasOwnMessages || replacements[currentId]) continue;

    const targetCharacter = characterById.get(targetId);
    const targetContact = targetHit.contact;
    replacements[currentId] = targetId;
    const displayName = resolvePhoneSocialActorDisplayName(targetCharacter) || historicalNames[0];
    aliasPatches[legacyId] = {
      ...alias,
      name: displayName,
      realName: displayName,
      avatar: String(targetCharacter?.avatar || targetCharacter?.avatarUrl || targetContact?.avatar || '').trim(),
      phoneContactId: cleanId(targetContact?.id || legacyId),
      linkedCharacterId: targetId,
    };
  }

  if (!Object.keys(replacements).length) return { changed: false, replacements: {} };
  chat.participants = replacePhoneNpcIds(chat.participants, replacements);
  chat.groupSettings = replacePhoneNpcGroupSettings(chat.groupSettings, replacements);
  chat.metadata = {
    ...(chat.metadata || {}),
    phoneLightNpcAliases: { ...aliases, ...aliasPatches },
  };
  await saveChat(chat);
  return { changed: true, replacements };
}

/**
 * 手机轻量群：成员里若已有同名 phone-contact，则摘掉历史增生的 lightnpc_，
 * 并把对应手机联系人补回 participants（不改历史气泡 senderId）。
 * aliases：被摘掉的 lightnpcId → 显示用角色卡，供历史气泡查名/头像。
 */
export async function reconcilePhoneGroupDuplicateLightNpcs(chat, {
  userId = '',
  ownerId = '',
  phoneContacts = null,
} = {}) {
  if (!chat || chat.type !== 'group') return { chat, removed: [], aliases: {} };
  const uid = cleanId(userId);
  const oid = cleanId(ownerId);
  const contacts = Array.isArray(phoneContacts)
    ? phoneContacts
    : (uid && oid
      ? ((await loadCharacterPhoneContacts(uid, oid).catch(() => null))?.contacts || [])
      : []);
  if (!contacts.length) return { chat, removed: [], aliases: {} };

  const {
    getLightweightNpc,
    buildLightweightNpcCharacter,
    isUnsafeLightweightNpcName,
  } = await import('./lightweight-npc.js');
  const { buildPhoneLightContactCharacter, resolvePhoneContactAvatar } = await import('./character-phone-contacts.js');
  const removed = [];
  const aliases = {};
  const ensureIds = [];
  const nextParticipants = [];
  const participantActorIds = [...new Set((chat.participants || [])
    .map(cleanId)
    .filter((id) => id && id !== 'user' && id !== 'system'))];


  for (const rawId of chat.participants || []) {
    const id = cleanId(rawId);
    if (!id) continue;
    if (!isLightweightNpcId(id)) {
      nextParticipants.push(id);
      continue;
    }
    const npc = await getLightweightNpc(id, uid).catch(() => null);
    const remainingActorCount = participantActorIds.filter((actorId) => actorId !== id).length;
    if (npc && isUnsafeLightweightNpcName(npc.name) && remainingActorCount >= 2) {
      removed.push(id);
      const fromNpc = buildLightweightNpcCharacter(npc);
      aliases[id] = {
        ...(fromNpc || {}),
        id,
        name: '联系人',
        realName: '联系人',
        customNickname: '',
        avatar: npc.avatar || fromNpc?.avatar || '',
        metadata: {
          ...(fromNpc?.metadata || {}),
          isLightweightNpc: true,
          isCorruptPhoneGroupAlias: true,
        },
      };
      continue;
    }

    const contact = findPhoneContactByActorName(contacts, npc?.name || '');
    if (!contact?.id) {
      nextParticipants.push(id);
      continue;
    }
    removed.push(id);
    ensureIds.push(contact.linkedCharacterId || contact.id);
    const fromContact = buildPhoneLightContactCharacter(contact, oid);
    const fromNpc = buildLightweightNpcCharacter(npc);
    const displayName = String(contact.name || contact.nickname || npc?.name || '').trim() || '联系人';
    aliases[id] = {
      ...(fromNpc || {}),
      ...(fromContact || {}),
      // 历史气泡仍按 lightnpc_* 查表，必须挂在原 id 上
      id,
      name: displayName,
      realName: String(contact.name || npc?.name || displayName).trim(),
      customNickname: String(contact.nickname || '').trim(),
      avatar: resolvePhoneContactAvatar(contact) || npc?.avatar || fromContact?.avatar || fromNpc?.avatar || '',
      metadata: {
        ...(fromContact?.metadata || {}),
        ...(fromNpc?.metadata || {}),
        isLightweightNpc: true,
        isPhoneLightContactAlias: true,
        phoneContactId: contact.id,
        linkedCharacterId: contact.linkedCharacterId || '',
      },
    };
  }
  if (!removed.length) return { chat, removed: [], aliases: {} };

  chat.participants = [...new Set([
    ...nextParticipants,
    ...ensureIds.map(cleanId).filter(Boolean),
  ])];
  // 持久化显示别名：下次进页不再 reconcile 时，历史 lightnpc 气泡仍能查到真名
  const prevAliases = (
    chat.metadata?.phoneLightNpcAliases
    && typeof chat.metadata.phoneLightNpcAliases === 'object'
  ) ? chat.metadata.phoneLightNpcAliases : {};
  const compactAliases = { ...prevAliases };
  for (const [npcId, row] of Object.entries(aliases)) {
    compactAliases[npcId] = {
      id: npcId,
      name: row.name || '',
      realName: row.realName || row.name || '',
      customNickname: row.customNickname || '',
      avatar: row.avatar || '',
      phoneContactId: row.metadata?.phoneContactId || '',
      linkedCharacterId: row.metadata?.linkedCharacterId || '',
    };
  }
  chat.metadata = {
    ...(chat.metadata || {}),
    phoneLightNpcAliases: compactAliases,
  };
  await saveChat(chat);
  return { chat, removed, aliases };
}

/**
 * 已收敛过的手机群：按关系网 lightnpc × 同名通讯录，补齐历史气泡显示别名（不改 participants）。
 */
export async function hydratePhoneGroupLightNpcDisplayAliases(chat, {
  userId = '',
  ownerId = '',
  phoneContacts = null,
} = {}) {
  if (!chat || chat.type !== 'group') return { chat, aliases: {} };
  const uid = cleanId(userId);
  const oid = cleanId(ownerId);
  const contacts = Array.isArray(phoneContacts)
    ? phoneContacts
    : (uid && oid
      ? ((await loadCharacterPhoneContacts(uid, oid).catch(() => null))?.contacts || [])
      : []);
  if (!contacts.length) return { chat, aliases: {} };

  const { listLightweightNpcs } = await import('./lightweight-npc.js');
  const { buildPhoneLightContactCharacter, resolvePhoneContactAvatar } = await import('./character-phone-contacts.js');
  const participantSet = new Set((chat.participants || []).map(cleanId).filter(Boolean));
  const lightRows = await listLightweightNpcs(uid).catch(() => []);
  const aliases = {};
  let changed = false;
  const prevAliases = (
    chat.metadata?.phoneLightNpcAliases
    && typeof chat.metadata.phoneLightNpcAliases === 'object'
  ) ? { ...chat.metadata.phoneLightNpcAliases } : {};

  for (const row of lightRows) {
    const id = cleanId(row?.id);
    if (!id || participantSet.has(id)) continue;
    const contact = findPhoneContactByActorName(contacts, row?.name || row?.realName || '');
    if (!contact?.id) continue;
    const fromContact = buildPhoneLightContactCharacter(contact, oid);
    const displayName = String(contact.name || contact.nickname || row?.name || '').trim() || '联系人';
    aliases[id] = {
      ...(row || {}),
      ...(fromContact || {}),
      id,
      name: displayName,
      realName: String(contact.name || row?.name || displayName).trim(),
      customNickname: String(contact.nickname || '').trim(),
      avatar: resolvePhoneContactAvatar(contact) || row?.avatar || fromContact?.avatar || '',
      metadata: {
        ...(fromContact?.metadata || {}),
        isLightweightNpc: true,
        isPhoneLightContactAlias: true,
        phoneContactId: contact.id,
        linkedCharacterId: contact.linkedCharacterId || '',
      },
    };
    const nextCompact = {
      id,
      name: aliases[id].name,
      realName: aliases[id].realName,
      customNickname: aliases[id].customNickname,
      avatar: aliases[id].avatar,
      phoneContactId: contact.id,
      linkedCharacterId: contact.linkedCharacterId || '',
    };
    const prev = prevAliases[id];
    if (!prev || prev.name !== nextCompact.name || prev.avatar !== nextCompact.avatar || prev.phoneContactId !== nextCompact.phoneContactId) {
      prevAliases[id] = nextCompact;
      changed = true;
    }
  }
  if (changed) {
    chat.metadata = {
      ...(chat.metadata || {}),
      phoneLightNpcAliases: prevAliases,
    };
    await saveChat(chat);
  }
  // 合并已存别名，保证 charMap 完整
  for (const [npcId, compact] of Object.entries(prevAliases)) {
    if (aliases[npcId]) continue;
    const contact = contacts.find((c) => (
      c?.id === compact?.phoneContactId || c?.linkedCharacterId === compact?.linkedCharacterId
    )) || findPhoneContactByActorName(contacts, compact?.name || compact?.realName || '');
    const fromContact = contact ? buildPhoneLightContactCharacter(contact, oid) : null;
    const displayName = String(compact?.name || compact?.realName || contact?.name || '').trim() || '联系人';
    aliases[npcId] = {
      ...(fromContact || {}),
      id: npcId,
      name: displayName,
      realName: String(compact?.realName || contact?.name || displayName).trim(),
      customNickname: String(compact?.customNickname || contact?.nickname || '').trim(),
      avatar: resolvePhoneContactAvatar(contact) || compact?.avatar || fromContact?.avatar || '',
      metadata: {
        ...(fromContact?.metadata || {}),
        isLightweightNpc: true,
        isPhoneLightContactAlias: true,
        phoneContactId: contact?.id || compact?.phoneContactId || '',
      },
    };
  }
  return { chat, aliases };
}

export async function adoptPhoneSessionOrphanAsContact(userId = '', ownerId = '', peer = {}) {
  const peerId = cleanId(peer?.id || peer?.peerId);
  if (!userId || !ownerId || !peerId) return null;
  const [relationshipNet, character, lightweightNpc] = await Promise.all([
    loadRelationshipNetwork(userId).catch(() => null),
    getCharacter(peerId, { userId }).catch(() => null),
    getLightweightNpc(peerId, userId).catch(() => null),
  ]);
  const relationshipNpc = (relationshipNet?.npcs || []).find((row) => cleanId(row?.id) === peerId) || null;
  const name = resolvePhoneSocialActorDisplayName(peer, relationshipNpc, lightweightNpc, character);
  if (!name) return null;
  return upsertPhoneContact(userId, ownerId, {
    id: peerId,
    name,
    avatar: peer?.avatar || peer?.avatarUrl || '',
    category: 'friend',
    linkedCharacterId: character ? peerId : '',
    linkedActorId: !character && (relationshipNpc || isLightweightNpcId(peerId)) ? peerId : '',
    personaCapsule: {
      summary: String(peer?.personality || peer?.notes || relationshipNpc?.note || '').trim().slice(0, 280),
      speechStyle: String(peer?.speechStyle || relationshipNpc?.speechStyle || '').trim().slice(0, 120),
    },
  });
}

export function removePhoneNpcPeerFromGroupChat(chat = null, peerId = '') {
  const peer = cleanId(peerId);
  if (!chat || chat.type !== 'group' || !peer) {
    return { changed: false, deleteChat: false, chat };
  }
  const participants = (chat.participants || []).map(cleanId).filter(Boolean);
  if (!participants.includes(peer)) return { changed: false, deleteChat: false, chat };
  const nextParticipants = participants.filter((id) => id !== peer);
  const remainingActors = nextParticipants.filter((id) => id !== 'user');
  if (remainingActors.length < 2) return { changed: true, deleteChat: true, chat: null };
  const aliases = { ...(chat.metadata?.phoneLightNpcAliases || {}) };
  delete aliases[peer];
  return {
    changed: true,
    deleteChat: false,
    chat: {
      ...chat,
      participants: nextParticipants,
      groupSettings: {
        ...(chat.groupSettings || {}),
        admins: (chat.groupSettings?.admins || []).filter((id) => id !== peer),
        muted: (chat.groupSettings?.muted || []).filter((id) => id !== peer),
        owner: chat.groupSettings?.owner === peer ? null : chat.groupSettings?.owner,
      },
      metadata: {
        ...(chat.metadata || {}),
        phoneLightNpcAliases: aliases,
      },
    },
  };
}

export async function dismissPhoneSessionOrphanPeer(userId = '', ownerId = '', peerId = '') {
  const uid = cleanId(userId);
  const oid = cleanId(ownerId);
  const peer = cleanId(peerId);
  if (!uid || !oid || !peer) return { deletedChats: 0, chatIds: [] };
  const chats = await listCharacterPhoneChats(uid, oid, { includeIntercept: true });
  const targets = listPhoneOwnerPeerPairChats(chats, oid, peer);
  const chatIds = targets.map((chat) => cleanId(chat.id)).filter(Boolean);

  if (isLightweightNpcId(peer)) {
    const { dismissLightweightNpc } = await import('./lightweight-npc.js');
    const dismissedNpc = await dismissLightweightNpc(peer, {
      sourceChatIds: chatIds,
      purgeChats: true,
      global: true,
    });
    return {
      deletedChats: Number(dismissedNpc?.deletedChats || 0),
      updatedGroups: Number(dismissedNpc?.updatedGroups || 0),
      chatIds,
      dismissedNpc: !!dismissedNpc?.ok,
    };
  }

  // 旧关系网 npc_* 不是 lightnpc_*，但同样属于非正式 actor。旧逻辑只删二人窗，
  // 群 participants 与关系网节点仍在，刷新后就会再次冒出且无法打开。
  if (/^npc_/i.test(peer)) {
    const [allChats, state] = await Promise.all([
      listChatsForUser(uid).catch(() => []),
      loadCharacterPhoneContacts(uid, oid).catch(() => null),
    ]);
    let deletedChats = 0;
    let updatedGroups = 0;
    for (const chat of allChats) {
      const participants = (chat?.participants || []).map(cleanId).filter(Boolean);
      if (!participants.includes(oid) || !participants.includes(peer)) continue;
      if (chat.type !== 'group') {
        await deleteChatWithData(chat.id, uid);
        deletedChats += 1;
        continue;
      }
      const cleaned = removePhoneNpcPeerFromGroupChat(chat, peer);
      if (cleaned.deleteChat) {
        await deleteChatWithData(chat.id, uid);
        deletedChats += 1;
        continue;
      }
      if (cleaned.changed && cleaned.chat) {
        await saveChat(cleaned.chat);
        updatedGroups += 1;
      }
    }
    if (state) {
      const droppedContactIds = new Set((state.contacts || [])
        .filter((contact) => phoneContactCanonicalActorId(contact) === peer)
        .map((contact) => contact.id));
      await saveCharacterPhoneContacts(uid, oid, {
        ...state,
        contacts: (state.contacts || []).filter((contact) => !droppedContactIds.has(contact.id)),
        groups: (state.groups || []).map((group) => ({
          ...group,
          memberIds: (group.memberIds || []).filter((id) => (
            id !== peer && !droppedContactIds.has(id)
          )),
        })),
        removedLinkedActorIds: [...new Set([
          ...(state.removedLinkedActorIds || []),
          peer,
        ])].slice(-200),
        updatedAt: Date.now(),
      });
    }
    await pruneActorsFromRelationshipNetwork([peer]);
    return {
      deletedChats,
      updatedGroups,
      chatIds: allChats
        .filter((chat) => (chat?.participants || []).includes(oid) && (chat?.participants || []).includes(peer))
        .map((chat) => cleanId(chat.id))
        .filter(Boolean),
      dismissedNpc: true,
    };
  }

  for (const chat of targets) {
    await deleteChatWithData(chat.id, uid);
  }
  return {
    deletedChats: targets.length,
    updatedGroups: 0,
    chatIds,
    dismissedNpc: false,
  };
}

export async function resolvePhoneMainParentChatId(userId, ownerId) {
  const mainDm = await findPrivateChat(userId, ownerId).catch(() => null);
  return mainDm?.id || '';
}

const SETTINGS_PREFIX = 'characterPhoneChatAuto:';

export async function loadPhoneChatAutoSettings(userId, characterId) {
  const config = await loadCharacterPhoneAutomationConfig(userId, characterId);
  return { ...config.phoneChatAuto };
}

export async function savePhoneChatAutoSettings(userId, characterId, patch = {}) {
  const key = `${SETTINGS_PREFIX}${cleanId(userId)}:${cleanId(characterId)}`;
  const current = await loadPhoneChatAutoSettings(userId, characterId);
  const value = {
    ...current,
    ...patch,
    intervalMinutes: Math.max(15, Math.min(1440, Number(patch.intervalMinutes ?? current.intervalMinutes) || 120)),
    dailyLimit: Math.max(1, Math.min(30, Number(patch.dailyLimit ?? current.dailyLimit) || 6)),
  };
  await Promise.all([
    saveCharacterPhoneAutomationConfig(userId, characterId, { phoneChatAuto: value }),
    db.put('settings', { key, value }),
  ]);
  return value;
}
