/**
 * 数据自检 · 跨档位清理残留数据
 *
 * 角色（characters）是全局共享的，聊天/记忆等按档位（userId）隔离。
 * 删除一个角色时如果只删 characters 表这一行，会在当前及其它档位里留下：
 *  - 参与者里含该角色的私聊（僵尸会话，标题会退化成角色 id 字符串）
 *  - 群聊 participants/管理员/禁言名单里残留的该角色 id
 *  - 记忆馆里该角色名下的记忆/事实/收藏（「幽灵角色」）
 * 另外删除档位（user slot）会级联清该档 momentsPosts；聊天/记忆等仍可能残留，
 * 由本模块统一提供：删角色时的级联清理 + 设置页手动自检扫描/修复。
 *
 * 轻量 NPC（lightnpc_* / 关系网 npc_*）与手机联系人（phone-contact:）不在
 * characters 表，但仍是合法身份；自检不得把它们当成幽灵角色清掉。
 * 例外：关系网里仍挂着的 phone-contact:，若所有手机通讯录都已没有这条，
 * 属于删除手机联系人时漏 prune 的孤儿节点，自检应扫到并可清理。
 */
import * as db from './db.js';
import { listUsers } from './user-slot.js';
import { deleteChatWithData, saveChat } from './chat-store.js';
import { isAnonymousChat } from './chat-helpers.js';
import {
  deleteGhostCharacterScope,
  isGuidanceChatMemoryScopeId,
} from './memory/memory-scope.js';
import { isUnauthorizedCrossGroupCharacterPair } from './phone-social-eligibility.js';
import { relationshipActorIdsMatch } from './relationship-network.js';
import { clearEnsembleCharacterData } from './ensemble-mode.js';

const CHARACTER_SETTING_PREFIXES = [
  'characterPhone_',
  'characterPhoneAutomationConfig:',
  'characterPhoneAutomationRuntime:',
  'characterPhoneChatAuto:',
  'characterPhoneChatAutoState:',
  'characterPhoneMoments:',
  'characterPhoneContacts:',
  'characterPhoneLifeBatch:',
  'characterPhoneInterceptBatch:',
  'characterPhoneProactiveLock_',
  'characterInterestTable_',
  'characterInterestTracking_',
  'characterVerifiedPosts_',
  'characterBlockState_',
  'shareImpulse_',
  'shareImpulseSettings_',
  'shareImpulseProactive_',
  'characterInterest',
  'userSocialWatch',
  'characterAutonomySettings:',
  'lifeGlimpseSettings:v',
];

const HYGIENE_SETTING_EXACT_KEYS = new Set([
  'relationshipNetwork',
  'acquaintanceLedger',
  'narrationArchive',
  'characterPhoneAutoSettings',
]);

const HYGIENE_SETTING_PREFIXES = [
  ...CHARACTER_SETTING_PREFIXES,
  'offlineDateArchives_',
  'userMemos_',
  'radioPlans_',
  'activitySessions_',
  'companionSessions_',
  'travelCharTrips_',
  'travelCharNotifications_',
  'companionSettings_',
  'periodTracker_',
];

export function isDataHygieneSettingKey(key = '') {
  const normalized = String(key || '');
  return HYGIENE_SETTING_EXACT_KEYS.has(normalized)
    || HYGIENE_SETTING_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

async function loadDataHygieneSettings() {
  // settings 里可能有数百 MB 的语音、图片和角色手机素材。自检只先读主键，
  // 再批量取与角色引用有关的少量记录，避免进入页面就结构化克隆整张资源表。
  const keys = (await db.getAllKeys('settings'))
    .map((key) => String(key || ''))
    .filter(isDataHygieneSettingKey);
  return db.getMany('settings', keys);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function localMusicAssetFingerprint(track) {
  if (String(track?.source || '') !== 'local') return '';
  const blob = track?.audioBlob;
  if (typeof Blob === 'undefined' || !(blob instanceof Blob) || !blob.size) return '';
  const md5 = String(track?.songMd5 || '').trim().toLowerCase();
  if (md5) return `md5:${md5}`;
  const fileName = String(track?.fileName || '').trim().toLowerCase();
  const fileModified = Number(track?.fileModified || 0) || 0;
  // 没有修改时间的旧记录不能仅凭同名同大小自动判重，避免误删用户后来替换的同名文件。
  if (!fileName || !fileModified) return '';
  return `file:${fileName}\0${blob.size}\0${fileModified}`;
}

/**
 * 找出旧版本重复写入的本地音频副本。每组只保留一条：
 * 优先保留仍被歌单/动态引用的记录，其次保留更新较新的记录。
 */
export function collectDuplicateLocalMusicTracks(tracks = [], playlists = [], posts = []) {
  const referenceCounts = new Map();
  const addReference = (trackId) => {
    const id = String(trackId || '').trim();
    if (id) referenceCounts.set(id, (referenceCounts.get(id) || 0) + 1);
  };
  for (const playlist of asArray(playlists)) asArray(playlist?.trackIds).forEach(addReference);
  for (const post of asArray(posts)) addReference(post?.trackId);

  const groups = new Map();
  for (const track of asArray(tracks)) {
    const id = String(track?.id || '').trim();
    const fingerprint = localMusicAssetFingerprint(track);
    if (!id || !fingerprint) continue;
    if (!groups.has(fingerprint)) groups.set(fingerprint, []);
    groups.get(fingerprint).push(track);
  }

  const duplicates = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const ranked = [...group].sort((a, b) => (
      (referenceCounts.get(String(b?.id || '')) || 0) - (referenceCounts.get(String(a?.id || '')) || 0)
      || (Number(b?.updatedAt || 0) - Number(a?.updatedAt || 0))
      || String(a?.id || '').localeCompare(String(b?.id || ''))
    ));
    const canonicalId = String(ranked[0]?.id || '');
    for (const track of ranked.slice(1)) {
      duplicates.push({
        id: String(track?.id || ''),
        canonicalId,
        title: String(track?.title || track?.fileName || '本地音乐'),
        bytes: Number(track?.audioBlob?.size || 0) || 0,
      });
    }
  }
  return duplicates;
}

/** 歌单或音乐动态仍引用已不存在歌曲时，清理悬空引用，不触碰正常歌曲。 */
export function collectDanglingMusicReferences(tracks = [], playlists = [], posts = []) {
  const liveTrackIds = new Set(
    asArray(tracks).map((track) => String(track?.id || '').trim()).filter(Boolean),
  );
  const playlistRefs = asArray(playlists).map((playlist) => ({
    id: String(playlist?.id || '').trim(),
    trackIds: [...new Set(asArray(playlist?.trackIds)
      .map((id) => String(id || '').trim())
      .filter((id) => id && !liveTrackIds.has(id)))],
  })).filter((item) => item.id && item.trackIds.length);
  const musicPosts = asArray(posts).filter((post) => {
    const trackId = String(post?.trackId || '').trim();
    return post?.id && trackId && !liveTrackIds.has(trackId);
  });
  return { playlistRefs, musicPosts };
}

function recordTouchesCharacter(row, characterId) {
  if (!row || typeof row !== 'object') return false;
  const id = String(characterId || '');
  const scalarKeys = ['characterId', 'ownerCharacterId', 'sourceCharacterId', 'reminderCharacterId'];
  if (scalarKeys.some((key) => String(row[key] || '') === id)) return true;
  const arrayKeys = ['participantIds', 'characterIds', 'participants', 'companions', 'reminderTargets'];
  return arrayKeys.some((key) => asArray(row[key]).some((item) => (
    String(item?.characterId || item?.id || item || '') === id
  )));
}

function removeCharacterFromAutoSettings(value, characterId) {
  if (!value || typeof value !== 'object') return value;
  const perCharacter = value.perCharacter && typeof value.perCharacter === 'object'
    ? { ...value.perCharacter }
    : {};
  if (!Object.prototype.hasOwnProperty.call(perCharacter, characterId)) return value;
  delete perCharacter[characterId];
  return { ...value, perCharacter };
}

function settingKeyReferencesCharacter(key, characterId) {
  const rawKey = String(key || '');
  const id = String(characterId || '');
  const encodedId = encodeURIComponent(id);
  if (!id) return false;
  if (rawKey.startsWith('characterPhone_')
    || rawKey.startsWith('shareImpulse_')
    || rawKey.startsWith('shareImpulseSettings_')
    || rawKey.startsWith('shareImpulseProactive_')
    || rawKey.startsWith('characterInterestTable_')
    || rawKey.startsWith('characterInterestTracking_')
    || rawKey.startsWith('characterVerifiedPosts_')
    || rawKey.startsWith('characterBlockState_')) {
    return rawKey.endsWith(`_${encodedId}`);
  }
  if (rawKey.startsWith('characterPhoneProactiveLock_')) {
    return rawKey.includes(`_${encodedId}_`);
  }
  if ([
    'characterPhoneAutomationConfig:',
    'characterPhoneAutomationRuntime:',
    'characterPhoneChatAuto:',
    'characterPhoneChatAutoState:',
    'characterPhoneMoments:',
    'characterPhoneContacts:',
    'characterPhoneLifeBatch:',
    'characterPhoneInterceptBatch:',
    'characterAutonomySettings:',
    'lifeGlimpseSettings:v',
  ].some((prefix) => rawKey.startsWith(prefix))) {
    const tokens = rawKey.split(':');
    return tokens.some((token, index) => {
      if (index === 0) return false;
      try {
        return decodeURIComponent(token) === id;
      } catch (_) {
        return token === id;
      }
    });
  }
  return false;
}

function pruneAggregateSetting(row, characterId, chatIds) {
  const key = String(row?.key || '');
  const value = row?.value;
  if (key === 'narrationArchive' && Array.isArray(value)) {
    return value.filter((item) => !recordTouchesCharacter(item, characterId)
      && !chatIds.has(String(item?.chatId || '')));
  }
  if (key.startsWith('offlineDateArchives_') && Array.isArray(value)) {
    return value.filter((item) => !recordTouchesCharacter(item, characterId)
      && !chatIds.has(String(item?.chatId || '')));
  }
  if (key.startsWith('activitySessions_') && value && typeof value === 'object') {
    return {
      ...value,
      sessions: asArray(value.sessions).filter((item) => !recordTouchesCharacter(item, characterId)
        && !chatIds.has(String(item?.chatId || ''))),
    };
  }
  if (key.startsWith('companionSessions_') && value && typeof value === 'object') {
    return {
      ...value,
      sessions: asArray(value.sessions).filter((item) => !recordTouchesCharacter(item, characterId)
        && !chatIds.has(String(item?.linkedChatId || ''))),
    };
  }
  if (key.startsWith('travelCharTrips_') && value && typeof value === 'object') {
    const source = Array.isArray(value) ? value : asArray(value.trips);
    const trips = source.filter((item) => !recordTouchesCharacter(item, characterId));
    return Array.isArray(value) ? trips : { ...value, trips };
  }
  if (key.startsWith('travelCharNotifications_') && value && typeof value === 'object') {
    const source = Array.isArray(value) ? value : asArray(value.notifications);
    const notifications = source.filter((item) => !recordTouchesCharacter(item, characterId));
    return Array.isArray(value) ? notifications : { ...value, notifications };
  }
  if (key.startsWith('companionSettings_') && value?.dockCharacterId === characterId) {
    return { ...value, dockCharacterId: '', dockVisible: false };
  }
  if (key.startsWith('periodTracker_') && value && typeof value === 'object') {
    const sourceTargets = Array.isArray(value.reminderTargets)
      ? value.reminderTargets
      : (value.reminderCharacterId ? [{
        characterId: value.reminderCharacterId,
        chatId: value.reminderChatId || '',
      }] : []);
    const reminderTargets = sourceTargets.filter((item) => String(item?.characterId || '') !== characterId);
    const first = reminderTargets[0] || null;
    return {
      ...value,
      remindAi: reminderTargets.length ? value.remindAi : false,
      reminderTargets,
      reminderCharacterId: first?.characterId || '',
      reminderChatId: first?.chatId || '',
      active: value.active?.characterId === characterId ? null : value.active,
      pending: value.pending?.characterId === characterId ? null : value.pending,
    };
  }
  if (key === 'characterPhoneAutoSettings') {
    return removeCharacterFromAutoSettings(value, characterId);
  }
  if (key.startsWith('chatPendingActions:') && value && typeof value === 'object') {
    return {
      ...value,
      actions: asArray(value.actions).filter((action) => (
        String(action?.characterId || '') !== characterId
        && !chatIds.has(String(action?.chatId || ''))
      )),
      updatedAt: Date.now(),
    };
  }
  if (key.startsWith('characterPhoneContacts:') && value && typeof value === 'object') {
    const removedIds = new Set(
      asArray(value.contacts)
        .filter((item) => (
          String(item?.linkedCharacterId || '') === characterId
          || String(item?.linkedActorId || item?.canonicalActorId || '') === characterId
        ))
        .map((item) => String(item?.id || ''))
        .filter(Boolean),
    );
    if (!removedIds.size) return value;
    const removedLinked = [
      ...asArray(value.removedLinkedCharacterIds).map((id) => String(id || '').trim()).filter(Boolean),
      characterId,
    ];
    return {
      ...value,
      contacts: asArray(value.contacts).filter((item) => !removedIds.has(String(item?.id || ''))),
      groups: asArray(value.groups).map((group) => ({
        ...group,
        memberIds: asArray(group?.memberIds).filter((id) => !removedIds.has(String(id || ''))),
      })),
      removedLinkedCharacterIds: [...new Set(removedLinked)].slice(0, 200),
    };
  }
  if (key === 'contactFavorites' && Array.isArray(value?.ids)) {
    return { ...value, ids: value.ids.filter((id) => String(id || '') !== characterId) };
  }
  if ((key.startsWith('userMemos_') || key.startsWith('radioPlans_')) && Array.isArray(value)) {
    return value.filter((item) => String(item?.characterId || '') !== characterId);
  }
  if (key === 'interestRotationState' && value?.lastAt && typeof value.lastAt === 'object') {
    if (!Object.prototype.hasOwnProperty.call(value.lastAt, characterId)) return value;
    const lastAt = { ...value.lastAt };
    delete lastAt[characterId];
    return { ...value, lastAt };
  }
  if (key === 'relationshipNetwork' && value && typeof value === 'object') {
    const circles = asArray(value.circles).map((circle) => ({
      ...circle,
      memberIds: asArray(circle?.memberIds).filter((id) => String(id || '') !== characterId),
      edges: asArray(circle?.edges).filter((edge) => (
        String(edge?.a || '') !== characterId && String(edge?.b || '') !== characterId
      )),
      groups: asArray(circle?.groups).map((group) => ({
        ...group,
        memberIds: asArray(group?.memberIds).filter((id) => String(id || '') !== characterId),
      })),
    }));
    return { ...value, circles };
  }
  return value;
}

function characterIdsFromSetting(row) {
  const key = String(row?.key || '');
  const value = row?.value;
  const ids = new Set();
  const colonCharacterPrefixes = [
    'characterPhoneAutomationConfig:',
    'characterPhoneAutomationRuntime:',
    'characterPhoneChatAuto:',
    'characterPhoneChatAutoState:',
    'characterPhoneMoments:',
    'characterPhoneContacts:',
    'characterPhoneLifeBatch:',
    'characterPhoneInterceptBatch:',
    'characterAutonomySettings:',
    'lifeGlimpseSettings:v',
  ];
  const addRecord = (item) => {
    if (!item || typeof item !== 'object') return;
    for (const field of ['characterId', 'ownerCharacterId', 'sourceCharacterId', 'reminderCharacterId']) {
      const id = String(item[field] || '').trim();
      if (id) ids.add(id);
    }
    for (const field of ['participantIds', 'characterIds', 'participants', 'companions', 'reminderTargets']) {
      for (const member of asArray(item[field])) {
        const id = String(member?.characterId || member?.id || member || '').trim();
        if (id && id !== 'user') ids.add(id);
      }
    }
  };
  if (key === 'narrationArchive' || key.startsWith('offlineDateArchives_')
    || key.startsWith('userMemos_') || key.startsWith('radioPlans_')) {
    asArray(value).forEach(addRecord);
  } else if (key.startsWith('activitySessions_') || key.startsWith('companionSessions_')) {
    asArray(value?.sessions).forEach(addRecord);
  } else if (key.startsWith('travelCharTrips_')) {
    asArray(value?.trips || value).forEach(addRecord);
  } else if (key.startsWith('travelCharNotifications_')) {
    asArray(value?.notifications || value).forEach(addRecord);
  } else if (key.startsWith('companionSettings_') || key.startsWith('periodTracker_')
    || CHARACTER_SETTING_PREFIXES.some((prefix) => key.startsWith(prefix))) {
    addRecord(value);
  } else if (key === 'characterPhoneAutoSettings') {
    Object.keys(value?.perCharacter || {}).forEach((id) => ids.add(id));
  }
  if (colonCharacterPrefixes.some((prefix) => key.startsWith(prefix))) {
    const token = key.split(':').pop() || '';
    try {
      ids.add(decodeURIComponent(token));
    } catch (_) {
      ids.add(token);
    }
  }
  return ids;
}

async function deleteCharacterAuxiliaryData(characterId, chatIds = new Set()) {
  // 最底层再设一道保险：该函数只允许处理已经不存在的主角色。
  // 档位或仍在 characters 表里的身份无论上游报告写了什么都不得级联删除。
  const [liveUser, liveCharacter] = await Promise.all([
    db.getRecord('users', characterId),
    db.getRecord('characters', characterId),
  ]);
  if (liveUser || liveCharacter) return;
  const settings = await db.getAllRecords('settings');
  const removedPhoneContactIds = new Set();
  const rememberRemovedPhoneActor = (contact) => {
    const contactId = String(contact?.id || '').trim();
    const linkedActorId = String(contact?.linkedActorId || contact?.canonicalActorId || '').trim();
    if (isPhoneContactActorId(contactId)) removedPhoneContactIds.add(contactId);
    // 只清这个手机私有的 phone-contact 身份。关系网 NPC 可能被其它角色、聊天或
    // 档位共享；是否已成孤儿交给全局自检按锚点判断，不能在删一个主人时跨档清掉。
    if (isPhoneContactActorId(linkedActorId)) {
      removedPhoneContactIds.add(linkedActorId);
    }
  };
  for (const row of settings || []) {
    const key = String(row?.key || '');
    const directCharacterSetting = CHARACTER_SETTING_PREFIXES.some((prefix) => key.startsWith(prefix))
      && (String(row?.value?.characterId || '') === characterId
        || settingKeyReferencesCharacter(key, characterId));
    const chatScopedSetting = [...chatIds].some((chatId) => (
      key === `offlineSession_${chatId}`
      || key === `offlineSessionMirror_${chatId}`
      || key === `chatPrefs_${chatId}`
    ));
    if (directCharacterSetting || chatScopedSetting) {
      // 删角色自己的手机通讯录时，顺手记下里面的 phone-contact id，后面清记忆馆。
      if (key.startsWith('characterPhoneContacts:')) {
        for (const contact of asArray(row?.value?.contacts)) {
          rememberRemovedPhoneActor(contact);
        }
      }
      await db.deleteRecord('settings', key);
      continue;
    }
    if (key.startsWith('characterPhoneContacts:') && row?.value && typeof row.value === 'object') {
      for (const contact of asArray(row.value.contacts)) {
        if (String(contact?.linkedCharacterId || '') !== characterId
          && String(contact?.linkedActorId || contact?.canonicalActorId || '') !== characterId) continue;
        rememberRemovedPhoneActor(contact);
      }
    }
    const nextValue = pruneAggregateSetting(row, characterId, chatIds);
    if (nextValue !== row?.value) {
      await db.putRecord('settings', { ...row, value: nextValue });
    }
  }

  if (removedPhoneContactIds.size) {
    const users = await listUsers().catch(() => []);
    for (const user of users) {
      for (const contactId of removedPhoneContactIds) {
        await deleteGhostCharacterScope(user.id, contactId).catch(() => null);
      }
    }
    const { pruneActorsFromRelationshipNetwork } = await import('./relationship-network.js');
    await pruneActorsFromRelationshipNetwork([...removedPhoneContactIds]).catch(() => null);
  }

  const directStores = ['auStories', 'momentsPosts', 'weiboPosts', 'musicPosts', 'streamerChannels'];
  for (const storeName of directStores) {
    const rows = await db.getAllRecords(storeName);
    const ids = (rows || [])
      .filter((row) => recordTouchesCharacter(row, characterId)
        || String(row?.authorId || '') === characterId
        || String(row?.ownerId || '') === characterId)
      .map((row) => row?.id)
      .filter(Boolean);
    if (ids.length) await db.deleteMany(storeName, ids);
  }

  const characters = await db.getAllRecords('characters');
  for (const character of characters || []) {
    if (!character?.id || !character.relationships
      || !Object.prototype.hasOwnProperty.call(character.relationships, characterId)) continue;
    const relationships = { ...character.relationships };
    delete relationships[characterId];
    await db.putRecord('characters', { ...character, relationships });
  }

  const worldBooks = await db.getAllRecords('worldBooks');
  for (const book of worldBooks || []) {
    if (!book?.id || !asArray(book.characterIds).includes(characterId)) continue;
    await db.putRecord('worldBooks', {
      ...book,
      characterIds: book.characterIds.filter((id) => id !== characterId),
    });
  }

  if (typeof localStorage !== 'undefined') {
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index);
      if (!key?.startsWith('characterPhonePinned:')) continue;
      try {
        const raw = JSON.parse(localStorage.getItem(key) || '[]');
        if (!Array.isArray(raw) || !raw.includes(characterId)) continue;
        localStorage.setItem(key, JSON.stringify(raw.filter((id) => id !== characterId)));
      } catch (_) {
        // 非法旧值不在删角色流程里擅自覆盖。
      }
    }
  }
}

function chatPartnerCharacterIds(chat) {
  return (chat?.participants || []).filter((p) => p && p !== 'user');
}

export function collectHeadlessResolvableActorIds(characters = [], relationshipNetwork = {}) {
  const ids = new Set(
    asArray(characters)
      .map((row) => String(row?.id || '').trim())
      .filter(Boolean),
  );
  for (const npc of asArray(relationshipNetwork?.npcs)) {
    const id = String(npc?.id || '').trim();
    const name = String(npc?.name || '').trim();
    // headless-reply 当前只会把 lightnpc_ 从关系网解析成可发言身份。
    if (/^lightnpc_/i.test(id) && name) ids.add(id);
  }
  return ids;
}

export function collectUnresolvableAutoChats(chats = [], resolvableActorIds = new Set()) {
  return asArray(chats).filter((chat) => {
    if (!chat?.id || chat.autoActive !== true || isAnonymousChat(chat)) return false;
    const actorIds = chatPartnerCharacterIds(chat);
    return !actorIds.length || actorIds.some((id) => !resolvableActorIds.has(String(id || '').trim()));
  });
}

function isPhoneContactActorId(id = '') {
  return /^phone-contact:/i.test(String(id || '').trim());
}

function isRelationshipNpcActorId(id = '') {
  return /^(?:lightnpc_|npc_)/i.test(String(id || '').trim());
}

/** 收集所有手机通讯录里仍在用的 phone-contact / canonical actor。 */
export function collectLivePhoneContactIds(settings = []) {
  const ids = new Set();
  for (const row of settings || []) {
    const key = String(row?.key || '');
    const value = row?.value;
    if (!key.startsWith('characterPhoneContacts:') || !value || typeof value !== 'object') continue;
    for (const contact of Array.isArray(value.contacts) ? value.contacts : []) {
      const contactId = String(contact?.id || '').trim();
      const linkedActorId = String(contact?.linkedActorId || contact?.canonicalActorId || '').trim();
      if (contactId) ids.add(contactId);
      // linkedCharacterId 必须由 characters 表本身证明仍存活；不能让旧手机联系人
      // 把已删除主角色重新加入合法身份白名单。
      if (linkedActorId) ids.add(linkedActorId);
    }
  }
  return ids;
}

/**
 * 关系网里挂着、但所有手机通讯录都已没有的 phone-contact: 身份。
 * 这些是「删手机联系人漏清关系网」留下的可选残留。
 */
export function phoneContactStillLive(actorId, livePhoneContactIds) {
  const target = String(actorId || '').trim();
  if (!target) return false;
  if (livePhoneContactIds.has(target)) return true;
  // 旧版本可能在关系网或通讯录任一侧截断过长 id，统一复用关系网的双向兼容规则。
  for (const liveId of livePhoneContactIds) {
    if (!isPhoneContactActorId(liveId)) continue;
    if (relationshipActorIdsMatch(liveId, target)) return true;
  }
  return false;
}

/** 记忆/事实/收藏里引用、但手机通讯录已不存在的 phone-contact: */
function collectOrphanPhoneContactActorsFromMemory(rowsByUser = [], livePhoneContactIds = new Set()) {
  const orphans = new Set();
  const mark = (id) => {
    const actorId = String(id || '').trim();
    if (!isPhoneContactActorId(actorId)) return;
    if (phoneContactStillLive(actorId, livePhoneContactIds)) return;
    orphans.add(actorId);
  };
  for (const pack of rowsByUser) {
    for (const m of asArray(pack?.memories)) mark(m?.characterId);
    for (const c of asArray(pack?.collectibles)) mark(c?.characterId);
    for (const f of asArray(pack?.facts)) {
      mark(f?.subjectId);
      mark(f?.objectId);
      Object.keys(f?.knownBy && typeof f.knownBy === 'object' ? f.knownBy : {}).forEach(mark);
    }
    for (const event of asArray(pack?.events)) {
      Object.keys(event?.knownBy && typeof event.knownBy === 'object' ? event.knownBy : {}).forEach(mark);
    }
    for (const vector of asArray(pack?.vectors)) {
      mark(vector?.characterId);
      asArray(vector?.witnesses).forEach(mark);
    }
  }
  return [...orphans];
}

export function collectOrphanPhoneContactActorsFromNetwork(net = {}, livePhoneContactIds = new Set()) {
  const orphans = new Set();
  const mark = (id) => {
    const actorId = String(id || '').trim();
    if (!isPhoneContactActorId(actorId)) return;
    if (phoneContactStillLive(actorId, livePhoneContactIds)) return;
    orphans.add(actorId);
  };
  for (const npc of Array.isArray(net?.npcs) ? net.npcs : []) mark(npc?.id);
  for (const circle of Array.isArray(net?.circles) ? net.circles : []) {
    for (const memberId of Array.isArray(circle?.memberIds) ? circle.memberIds : []) mark(memberId);
    for (const edge of Array.isArray(circle?.edges) ? circle.edges : []) {
      mark(edge?.a);
      mark(edge?.b);
    }
    for (const group of Array.isArray(circle?.groups) ? circle.groups : []) {
      for (const memberId of Array.isArray(group?.memberIds) ? group.memberIds : []) mark(memberId);
    }
  }
  return [...orphans];
}

function relationshipNpcNameLooksBroken(value = '') {
  const name = String(value || '').trim();
  if (!name) return true;
  return /[\u0000-\u001f\u007f\ufffd]/u.test(name)
    || /^(?:lightnpc_|npc_|phone-contact:)/i.test(name);
}

/**
 * 关系网 NPC 不能仅凭“自己仍在 net.npcs”就证明合法。
 * 至少要被现存角色/用户所在子网、现存聊天、手机联系人或仍存在的来源聊天锚定；
 * 否则删除角色后遗留的整圈 NPC 会永久躲过数据自检。
 */
export function collectOrphanRelationshipNpcActors(net = {}, {
  livePhoneContactIds = new Set(),
  liveCharacterIds = new Set(),
  liveChatIds = new Set(),
  liveChatActorIds = new Set(),
} = {}) {
  const npcs = asArray(net?.npcs);
  const npcIds = new Set(npcs.map((row) => String(row?.id || '').trim()).filter(Boolean));
  const anchoredNpcIds = new Set();
  const externalAnchors = new Set(['user', ...liveCharacterIds, ...livePhoneContactIds]);
  const networkReferencedIds = new Set();

  for (const id of livePhoneContactIds) {
    if (npcIds.has(id)) anchoredNpcIds.add(id);
  }
  for (const id of liveChatActorIds) {
    if (npcIds.has(id)) anchoredNpcIds.add(id);
  }
  for (const circle of asArray(net?.circles)) {
    const ids = new Set([
      ...asArray(circle?.memberIds),
      ...asArray(circle?.edges).flatMap((edge) => [edge?.a, edge?.b]),
      ...asArray(circle?.groups).flatMap((group) => asArray(group?.memberIds)),
    ].map((id) => String(id || '').trim()).filter(Boolean));
    for (const id of ids) networkReferencedIds.add(id);
    const hasExternalAnchor = [...ids].some((id) => externalAnchors.has(id));
    if (!hasExternalAnchor) continue;
    for (const id of ids) {
      if (npcIds.has(id)) anchoredNpcIds.add(id);
    }
  }
  for (const npc of npcs) {
    const id = String(npc?.id || '').trim();
    if (!id) continue;
    if (asArray(npc?.sourceChatIds).some((chatId) => liveChatIds.has(String(chatId || '').trim()))) {
      anchoredNpcIds.add(id);
    }
  }

  const orphans = new Set(
    npcs
      .filter((npc) => {
        const id = String(npc?.id || '').trim();
        if (!id) return false;
        if (isPhoneContactActorId(id) && !phoneContactStillLive(id, livePhoneContactIds)) return true;
        // 名称损坏不等于身份已死；只要仍被聊天、通讯录、来源聊天或有效子网锚定，
        // 自动清理就必须保留。名称修复应走单独的非破坏性流程。
        if (anchoredNpcIds.has(id)) return false;
        if (relationshipNpcNameLooksBroken(npc?.name)) return true;
        return true;
      })
      .map((npc) => String(npc?.id || '').trim())
      .filter(Boolean),
  );

  // 旧版 normalize 可能丢掉无 name 的 npc 行，却把 memberIds/edges/groups 引用留下。
  // 这些 ID 在关系网页无法解析、也不会出现在成员勾选框中，必须直接作为悬空引用清理。
  for (const id of networkReferencedIds) {
    if (id === 'user' || liveCharacterIds.has(id) || npcIds.has(id)) continue;
    if (phoneContactStillLive(id, livePhoneContactIds)) continue;
    orphans.add(id);
  }
  return [...orphans];
}

/** 仍在库里的合法身份：主角色 + 关系网 NPC + 手机轻量联系人。 */
export async function loadKnownActorIdSet(snapshot = {}) {
  // 身份表属于自检的安全边界：读取失败必须让扫描失败，绝不能把“没读到”
  // 当成“角色已删除”，否则一次暂时性的 IndexedDB 异常就会制造全量幽灵数据。
  const [characters, users, settings, chats] = await Promise.all([
    Array.isArray(snapshot.characters) ? snapshot.characters : db.getAllRecords('characters'),
    Array.isArray(snapshot.users) ? snapshot.users : listUsers(),
    Array.isArray(snapshot.settings) ? snapshot.settings : loadDataHygieneSettings(),
    Array.isArray(snapshot.chats) ? snapshot.chats : db.getAllRecords('chats'),
  ]);
  const ids = new Set(
    (characters || [])
      .map((row) => String(row?.id ?? '').trim())
      .filter(Boolean),
  );
  for (const user of users || []) {
    const userId = String(user?.id || '').trim();
    if (userId) ids.add(userId);
  }
  const liveCharacterIds = new Set(ids);
  const livePhoneIds = collectLivePhoneContactIds(settings);
  for (const id of livePhoneIds) ids.add(id);
  const liveChatIds = new Set((chats || []).map((chat) => String(chat?.id || '').trim()).filter(Boolean));
  const liveChatActorIds = new Set(
    (chats || []).flatMap((chat) => asArray(chat?.participants))
      .map((id) => String(id || '').trim())
      .filter(Boolean),
  );
  for (const id of liveChatActorIds) {
    // 轻量身份本来就不一定有 characters 行；一条仍存在的聊天本身就是强锚点。
    if (isRelationshipNpcActorId(id) || isPhoneContactActorId(id)) ids.add(id);
  }
  for (const row of settings || []) {
    const key = String(row?.key || '');
    const value = row?.value;
    if (key !== 'relationshipNetwork' || !value || typeof value !== 'object') continue;
    const orphanNpcs = new Set(collectOrphanRelationshipNpcActors(value, {
      livePhoneContactIds: livePhoneIds,
      liveCharacterIds,
      liveChatIds,
      liveChatActorIds,
    }));
    for (const npc of Array.isArray(value.npcs) ? value.npcs : []) {
      const id = String(npc?.id || '').trim();
      // 关系网 NPC 必须有外部锚点；孤儿节点不能再给自己作合法性证明。
      if (id && !orphanNpcs.has(id)) ids.add(id);
    }
  }
  return ids;
}

export function isKnownActorId(id, knownActorIds) {
  const cid = String(id || '').trim();
  if (!cid || cid === 'user') return true;
  return knownActorIds.has(cid);
}

async function purgeCharacterIdsFromGroupChat(chat, ghostIds = []) {
  const ghostSet = new Set(ghostIds);
  const gs = chat.groupSettings || {};
  const nextChat = {
    ...chat,
    participants: (chat.participants || []).filter((id) => !ghostSet.has(id)),
    groupSettings: {
      ...gs,
      admins: Array.isArray(gs.admins) ? gs.admins.filter((id) => !ghostSet.has(id)) : gs.admins,
      muted: Array.isArray(gs.muted) ? gs.muted.filter((id) => !ghostSet.has(id)) : gs.muted,
      owner: gs.owner && ghostSet.has(gs.owner) ? null : gs.owner,
    },
  };
  await saveChat(nextChat);
}

/**
 * 删除一个角色时的完整级联清理：跨所有档位找到引用该角色的私聊/群聊/记忆并处理，
 * 最后才删 characters 表本身那一行。
 * - 私聊：角色是唯一伙伴，直接连同消息/记忆一起删掉整条会话。
 * - 群聊：只把这个角色从参与者/管理员/禁言名单里摘掉，保留群聊记录本身。
 */
export async function deleteCharacterCascade(characterId) {
  const id = String(characterId || '').trim();
  if (!id) return { deletedChats: 0, updatedGroups: 0, memoryScopesCleaned: 0 };

  const chats = await db.getAllRecords('chats');
  const affectedChatIds = new Set(
    (chats || [])
      .filter((chat) => chatPartnerCharacterIds(chat).includes(id))
      .map((chat) => String(chat.id || ''))
      .filter(Boolean),
  );

  // 先移除角色卡，所有后台入口下一次核验时都会立即停止；清理放在后面可避免
  // 日程主动消息/旧聊天定时器在级联过程较长时又创建一轮消息。
  await db.deleteRecord('characters', id);
  const { unscheduleChat } = await import('./background-scheduler.js');
  for (const chatId of affectedChatIds) unscheduleChat(chatId);

  let deletedChats = 0;
  let updatedGroups = 0;
  for (const chat of chats || []) {
    if (!chat || !chatPartnerCharacterIds(chat).includes(id)) continue;
    if (chat.type === 'group') {
      await purgeCharacterIdsFromGroupChat(chat, [id]);
      updatedGroups += 1;
    } else {
      await deleteChatWithData(chat.id, chat.userId);
      deletedChats += 1;
    }
  }

  const users = await listUsers();
  let memoryScopesCleaned = 0;
  let ensembleScopesCleaned = 0;
  for (const user of users) {
    const { deleted } = await deleteGhostCharacterScope(user.id, id);
    if (deleted) memoryScopesCleaned += 1;
    const ensembleResult = await clearEnsembleCharacterData(user.id, id, [...affectedChatIds]);
    if (ensembleResult && (
      ensembleResult.nodesRemoved
      || ensembleResult.threadsRemoved
      || ensembleResult.resourcesRemoved
      || ensembleResult.situationsRemoved
      || ensembleResult.identityStatesRemoved
    )) ensembleScopesCleaned += 1;
  }

  await deleteCharacterAuxiliaryData(id, affectedChatIds);
  return { deletedChats, updatedGroups, memoryScopesCleaned, ensembleScopesCleaned };
}

/**
 * 扫描当前站点里的残留/孤儿数据，不做任何修改，只汇报。
 */
export async function scanDataHygiene() {
  const [
    chats,
    users,
    settings,
    characters,
    musicTracks,
    musicPlaylists,
    musicPosts,
  ] = await Promise.all([
    db.getAllRecords('chats'),
    listUsers(),
    loadDataHygieneSettings(),
    db.getAllRecords('characters'),
    db.getAllRecords('musicTracks'),
    db.getAllRecords('musicPlaylists'),
    db.getAllRecords('musicPosts'),
  ]);
  const knownActorIds = await loadKnownActorIdSet({ chats, users, settings, characters });
  const userIdSet = new Set(users.map((u) => u.id));
  const characterById = new Map((characters || []).map((row) => [String(row?.id || ''), row]));
  const networkRow = (settings || []).find((row) => String(row?.key || '') === 'relationshipNetwork');
  const relationshipNetwork = networkRow?.value || {};
  const headlessResolvableActorIds = collectHeadlessResolvableActorIds(characters, relationshipNetwork);

  const orphanPrivateChats = [];
  const groupGhostParticipants = [];
  const orphanSlotChats = [];
  const orphanSlotMoments = [];
  const ghostCharacterDataMap = new Map();

  for (const chat of chats || []) {
    if (!chat) continue;
    if (chat.userId && !userIdSet.has(chat.userId)) {
      orphanSlotChats.push(chat);
      continue;
    }
    const ids = chatPartnerCharacterIds(chat);
    if (chat.type === 'group') {
      const ghostIds = ids.filter((cid) => !isKnownActorId(cid, knownActorIds));
      if (ghostIds.length) groupGhostParticipants.push({ chat, ghostIds });
      continue;
    }
    const partnerId = ids[0];
    if (partnerId && !isKnownActorId(partnerId, knownActorIds)) orphanPrivateChats.push(chat);
  }
  const alreadyBrokenChatIds = new Set([
    ...orphanPrivateChats.map((chat) => String(chat?.id || '')),
    ...groupGhostParticipants.map((item) => String(item?.chat?.id || '')),
  ].filter(Boolean));
  const unresolvableAutoChats = collectUnresolvableAutoChats(chats, headlessResolvableActorIds)
    .filter((chat) => !alreadyBrokenChatIds.has(String(chat?.id || '')));

  const momentsPosts = await db.getAllRecords('momentsPosts');
  for (const post of momentsPosts || []) {
    if (!post?.id) continue;
    const uid = String(post.userId || post.ownerUserId || '').trim();
    if (!uid || uid === 'guest') continue;
    if (!userIdSet.has(uid)) orphanSlotMoments.push(post);
  }

  const ghostMemoryScopes = [];
  const memoryPacks = [];
  for (const user of users) {
    const [memories, facts, collectibles, events] = await Promise.all([
      db.getAllByIndex('memories', 'userId', user.id),
      db.getAllByIndex('memoryFacts', 'userId', user.id),
      db.getAllByIndex('collectibles', 'userId', user.id),
      db.getAllByIndex('eventMemories', 'userId', user.id),
    ]);
    memoryPacks.push({ userId: user.id, memories, facts, collectibles, events });
    const ids = new Set();
    for (const m of memories || []) {
      const cid = String(m?.characterId || '').trim();
      if (cid && !isGuidanceChatMemoryScopeId(cid)) ids.add(cid);
    }
    for (const f of facts || []) {
      const sid = String(f?.subjectId || '').trim();
      const oid = String(f?.objectId || '').trim();
      if (sid) ids.add(sid);
      if (oid) ids.add(oid);
      Object.keys(f?.knownBy && typeof f.knownBy === 'object' ? f.knownBy : {})
        .forEach((knownId) => { if (knownId) ids.add(knownId); });
    }
    for (const c of collectibles || []) { const cid = String(c?.characterId || '').trim(); if (cid) ids.add(cid); }
    for (const event of events || []) {
      Object.keys(event?.knownBy && typeof event.knownBy === 'object' ? event.knownBy : {})
        .forEach((knownId) => { const cid = String(knownId || '').trim(); if (cid) ids.add(cid); });
    }
    for (const cid of ids) {
      if (isKnownActorId(cid, knownActorIds)) continue;
      ghostMemoryScopes.push({ userId: user.id, characterId: cid });
    }
  }

  // 手机联系人 id 若仍挂在记忆里、但所有手机通讯录都已没有：单独扫出，避免被
  // 「phone-contact 一律合法」的旧认知挡住清理（记忆馆也会显示成疑似脏数据）。
  const livePhoneIdsEarly = collectLivePhoneContactIds(settings);
  const orphanPhoneMemoryIds = collectOrphanPhoneContactActorsFromMemory(
    memoryPacks,
    livePhoneIdsEarly,
  );
  const ghostMemoryKeys = new Set(
    ghostMemoryScopes.map((row) => `${row.userId}\0${row.characterId}`),
  );
  for (const user of users) {
    for (const actorId of orphanPhoneMemoryIds) {
      const key = `${user.id}\0${actorId}`;
      if (ghostMemoryKeys.has(key)) continue;
      // 只在该档位确实有引用时才记一条，避免无意义清理。
      const pack = memoryPacks.find((row) => row.userId === user.id);
      const touches = asArray(pack?.memories).some((m) => String(m?.characterId || '').trim() === actorId)
        || asArray(pack?.collectibles).some((c) => String(c?.characterId || '').trim() === actorId)
        || asArray(pack?.facts).some((f) => (
          String(f?.subjectId || '').trim() === actorId
          || String(f?.objectId || '').trim() === actorId
          || Object.keys(f?.knownBy || {}).some((id) => String(id || '').trim() === actorId)
        ))
        || asArray(pack?.events).some((event) => Object.keys(event?.knownBy || {})
          .some((id) => String(id || '').trim() === actorId));
      if (!touches) continue;
      ghostMemoryKeys.add(key);
      ghostMemoryScopes.push({ userId: user.id, characterId: actorId, kind: 'orphan-phone-contact' });
    }
  }

  for (const row of settings || []) {
    for (const characterId of characterIdsFromSetting(row)) {
      if (!characterId || isKnownActorId(characterId, knownActorIds)) continue;
      if (!ghostCharacterDataMap.has(characterId)) ghostCharacterDataMap.set(characterId, []);
      ghostCharacterDataMap.get(characterId).push(String(row?.key || ''));
    }
  }
  const ghostCharacterData = [...ghostCharacterDataMap.entries()]
    .map(([characterId, keys]) => ({ characterId, keys }));

  const livePhoneIds = collectLivePhoneContactIds(settings);
  const liveChatIds = new Set((chats || []).map((chat) => String(chat?.id || '').trim()).filter(Boolean));
  const liveChatActorIds = new Set(
    (chats || []).flatMap((chat) => asArray(chat?.participants))
      .map((id) => String(id || '').trim())
      .filter(Boolean),
  );
  const orphanRelationshipActors = collectOrphanRelationshipNpcActors(relationshipNetwork, {
    livePhoneContactIds: livePhoneIds,
    liveCharacterIds: new Set(characterById.keys()),
    liveChatIds,
    liveChatActorIds,
  }).map((actorId) => ({ actorId }));

  const unauthorizedCrossGroupChats = (chats || []).filter((chat) => {
    if (!chat || isAnonymousChat(chat)) return false;
    const ids = chatPartnerCharacterIds(chat);
    if (chat.type === 'group') {
      // 用户手动创建的普通群可以作为明确介绍；这里只清理 AI 自动生成的越界幕后群。
      const isAiCreatedGroup = String(chat?.metadata?.channel || '') === 'backstage'
        || String(chat?.metadata?.groupOrigin || '') === 'send-op';
      if (!isAiCreatedGroup || ids.length < 2) return false;
      for (let i = 0; i < ids.length; i += 1) {
        for (let j = i + 1; j < ids.length; j += 1) {
          if (isUnauthorizedCrossGroupCharacterPair(
            characterById.get(ids[i]),
            characterById.get(ids[j]),
            relationshipNetwork,
          )) return true;
        }
      }
      return false;
    }
    if (ids.length !== 2) return false;
    return isUnauthorizedCrossGroupCharacterPair(
      characterById.get(ids[0]),
      characterById.get(ids[1]),
      relationshipNetwork,
    );
  });
  const ledgerRow = (settings || []).find((row) => String(row?.key || '') === 'acquaintanceLedger');
  const unauthorizedCrossGroupLedgerEntries = asArray(ledgerRow?.value?.entries).filter((entry) => (
    isUnauthorizedCrossGroupCharacterPair(
      characterById.get(String(entry?.a || '')),
      characterById.get(String(entry?.b || '')),
      relationshipNetwork,
    )
  ));
  const unauthorizedCrossGroupPhoneContacts = [];
  for (const row of settings || []) {
    if (!String(row?.key || '').startsWith('characterPhoneContacts:')) continue;
    const owner = characterById.get(String(row?.value?.ownerId || ''));
    if (!owner) continue;
    for (const contact of asArray(row?.value?.contacts)) {
      const linked = characterById.get(String(contact?.linkedCharacterId || ''));
      if (!linked || !isUnauthorizedCrossGroupCharacterPair(owner, linked, relationshipNetwork)) continue;
      unauthorizedCrossGroupPhoneContacts.push({
        settingKey: row.key,
        ownerId: owner.id,
        contactId: String(contact.id || ''),
        linkedCharacterId: linked.id,
      });
    }
  }

  const duplicateLocalMusicTracks = collectDuplicateLocalMusicTracks(
    musicTracks,
    musicPlaylists,
    musicPosts,
  );
  const danglingMusic = collectDanglingMusicReferences(
    musicTracks,
    musicPlaylists,
    musicPosts,
  );
  const danglingMusicPlaylistRefs = danglingMusic.playlistRefs;
  const danglingMusicPosts = danglingMusic.musicPosts;
  const danglingMusicPlaylistRefCount = danglingMusicPlaylistRefs
    .reduce((sum, item) => sum + item.trackIds.length, 0);

  const total = orphanPrivateChats.length + groupGhostParticipants.length
    + orphanSlotChats.length + orphanSlotMoments.length + ghostMemoryScopes.length + ghostCharacterData.length
    + orphanRelationshipActors.length + unresolvableAutoChats.length + unauthorizedCrossGroupChats.length
    + unauthorizedCrossGroupLedgerEntries.length + unauthorizedCrossGroupPhoneContacts.length
    + duplicateLocalMusicTracks.length + danglingMusicPlaylistRefCount + danglingMusicPosts.length;
  return {
    orphanPrivateChats,
    groupGhostParticipants,
    orphanSlotChats,
    orphanSlotMoments,
    ghostMemoryScopes,
    ghostCharacterData,
    orphanRelationshipActors,
    unresolvableAutoChats,
    unauthorizedCrossGroupChats,
    unauthorizedCrossGroupLedgerEntries,
    unauthorizedCrossGroupPhoneContacts,
    duplicateLocalMusicTracks,
    danglingMusicPlaylistRefs,
    danglingMusicPosts,
    total,
  };
}

/**
 * 只有能证明属于「已删除角色」的残留，才允许进入角色级辅助数据清理。
 * 幽灵记忆可能只是模型误写的人名/旧 ID，只应清对应记忆，不能据此删除整部角色手机。
 * 同时用执行清理时重新读取的角色表兜底，避免用户确认前的旧扫描结果误删已恢复的角色。
 */
export function collectConfirmedAuxiliaryGhostIds(report, liveCharacterIds = new Set()) {
  const candidates = new Set([
    ...(report?.ghostCharacterData || []).map((item) => item?.characterId),
    ...(report?.orphanPrivateChats || []).flatMap((chat) => chatPartnerCharacterIds(chat)),
    ...(report?.groupGhostParticipants || []).flatMap((item) => item?.ghostIds || []),
  ].map((id) => String(id || '').trim()).filter(Boolean));
  return [...candidates].filter((id) => !liveCharacterIds.has(id));
}

/** 执行清理前再次排除仍然合法的角色、档位和轻量身份，避免旧扫描结果误伤。 */
export function collectConfirmedGhostMemoryScopes(report, knownActorIds = new Set()) {
  return (report?.ghostMemoryScopes || []).filter(({ characterId }) => {
    const id = String(characterId || '').trim();
    return id && !isGuidanceChatMemoryScopeId(id) && !knownActorIds.has(id);
  });
}

function rowIdSet(rows = [], field = 'id') {
  return new Set(asArray(rows).map((row) => String(row?.[field] || '').trim()).filter(Boolean));
}

/**
 * 用户确认的是页面上那次扫描结果；执行时只保留“旧报告中存在、重新扫描后仍存在”的交集。
 * 这样既不会误清确认框停留期间已恢复的数据，也不会顺手清掉用户尚未看过的新问题。
 */
export function intersectDataHygieneReports(report = {}, current = {}) {
  const keepRows = (key, field = 'id') => {
    const liveIds = rowIdSet(current[key], field);
    return asArray(report[key]).filter((row) => liveIds.has(String(row?.[field] || '').trim()));
  };
  const currentGroupGhosts = new Map(asArray(current.groupGhostParticipants).map((item) => [
    String(item?.chat?.id || '').trim(),
    new Set(asArray(item?.ghostIds).map((id) => String(id || '').trim()).filter(Boolean)),
  ]));
  const groupGhostParticipants = asArray(report.groupGhostParticipants)
    .map((item) => {
      const liveGhosts = currentGroupGhosts.get(String(item?.chat?.id || '').trim());
      if (!liveGhosts) return null;
      const ghostIds = asArray(item?.ghostIds)
        .filter((id) => liveGhosts.has(String(id || '').trim()));
      return ghostIds.length ? { ...item, ghostIds } : null;
    })
    .filter(Boolean);
  const currentMemoryKeys = new Set(asArray(current.ghostMemoryScopes).map((item) => (
    `${String(item?.userId || '').trim()}\0${String(item?.characterId || '').trim()}`
  )));
  const ghostMemoryScopes = asArray(report.ghostMemoryScopes).filter((item) => (
    currentMemoryKeys.has(
      `${String(item?.userId || '').trim()}\0${String(item?.characterId || '').trim()}`,
    )
  ));
  const currentLedgerKeys = new Set(asArray(current.unauthorizedCrossGroupLedgerEntries)
    .map((entry) => [String(entry?.a || ''), String(entry?.b || '')].sort().join('\0')));
  const unauthorizedCrossGroupLedgerEntries = asArray(report.unauthorizedCrossGroupLedgerEntries)
    .filter((entry) => currentLedgerKeys.has(
      [String(entry?.a || ''), String(entry?.b || '')].sort().join('\0'),
    ));
  const currentPhoneKeys = new Set(asArray(current.unauthorizedCrossGroupPhoneContacts)
    .map((item) => `${String(item?.settingKey || '')}\0${String(item?.contactId || '')}`));
  const unauthorizedCrossGroupPhoneContacts = asArray(report.unauthorizedCrossGroupPhoneContacts)
    .filter((item) => currentPhoneKeys.has(
      `${String(item?.settingKey || '')}\0${String(item?.contactId || '')}`,
    ));
  const currentDuplicateMusicKeys = new Set(asArray(current.duplicateLocalMusicTracks)
    .map((item) => `${String(item?.id || '')}\0${String(item?.canonicalId || '')}`));
  const duplicateLocalMusicTracks = asArray(report.duplicateLocalMusicTracks)
    .filter((item) => currentDuplicateMusicKeys.has(
      `${String(item?.id || '')}\0${String(item?.canonicalId || '')}`,
    ));
  const currentPlaylistRefs = new Map(asArray(current.danglingMusicPlaylistRefs).map((item) => [
    String(item?.id || '').trim(),
    new Set(asArray(item?.trackIds).map((id) => String(id || '').trim()).filter(Boolean)),
  ]));
  const danglingMusicPlaylistRefs = asArray(report.danglingMusicPlaylistRefs)
    .map((item) => {
      const liveRefs = currentPlaylistRefs.get(String(item?.id || '').trim());
      if (!liveRefs) return null;
      const trackIds = asArray(item?.trackIds)
        .map((id) => String(id || '').trim())
        .filter((id) => liveRefs.has(id));
      return trackIds.length ? { ...item, trackIds } : null;
    })
    .filter(Boolean);
  return {
    ...report,
    orphanPrivateChats: keepRows('orphanPrivateChats'),
    groupGhostParticipants,
    orphanSlotChats: keepRows('orphanSlotChats'),
    orphanSlotMoments: keepRows('orphanSlotMoments'),
    ghostMemoryScopes,
    ghostCharacterData: keepRows('ghostCharacterData', 'characterId'),
    orphanRelationshipActors: keepRows('orphanRelationshipActors', 'actorId'),
    unresolvableAutoChats: keepRows('unresolvableAutoChats'),
    unauthorizedCrossGroupChats: keepRows('unauthorizedCrossGroupChats'),
    unauthorizedCrossGroupLedgerEntries,
    unauthorizedCrossGroupPhoneContacts,
    duplicateLocalMusicTracks,
    danglingMusicPlaylistRefs,
    danglingMusicPosts: keepRows('danglingMusicPosts'),
  };
}

/** 按 scanDataHygiene 的报告执行修复，返回修复条数 */
export async function fixDataHygiene(report) {
  let fixed = 0;
  report = intersectDataHygieneReports(report, await scanDataHygiene());
  // 用户可能让结果页停留很久才确认，也可能刚经历数据库连接恢复。所有破坏性操作
  // 开始前重新读取身份边界；读取失败会直接中止，不再把空结果解释成“全部已删除”。
  const [knownActorIds, liveUsers] = await Promise.all([
    loadKnownActorIdSet(),
    listUsers(),
  ]);
  const liveUserIds = new Set(
    (liveUsers || []).map((user) => String(user?.id || '').trim()).filter(Boolean),
  );
  const { unscheduleChat } = await import('./background-scheduler.js');
  for (const chat of report?.orphanPrivateChats || []) {
    const partnerIds = chatPartnerCharacterIds(chat);
    if (!partnerIds.length || partnerIds.some((id) => isKnownActorId(id, knownActorIds))) continue;
    unscheduleChat(chat.id);
    await deleteChatWithData(chat.id, chat.userId);
    fixed += 1;
  }
  for (const chat of report?.orphanSlotChats || []) {
    if (liveUserIds.has(String(chat?.userId || '').trim())) continue;
    unscheduleChat(chat.id);
    await deleteChatWithData(chat.id, chat.userId);
    fixed += 1;
  }
  for (const post of report?.orphanSlotMoments || []) {
    if (!post?.id) continue;
    const userId = String(post.userId || post.ownerUserId || '').trim();
    if (!userId || liveUserIds.has(userId)) continue;
    await db.deleteRecord('momentsPosts', post.id).catch(() => {});
    fixed += 1;
  }
  for (const { chat, ghostIds } of report?.groupGhostParticipants || []) {
    const confirmedGhostIds = asArray(ghostIds)
      .filter((id) => !isKnownActorId(id, knownActorIds));
    if (!confirmedGhostIds.length) continue;
    const currentChat = await db.getRecord('chats', chat?.id);
    if (!currentChat) continue;
    await purgeCharacterIdsFromGroupChat(currentChat, confirmedGhostIds);
    fixed += 1;
  }
  for (const chat of report?.unresolvableAutoChats || []) {
    const currentChat = await db.getRecord('chats', chat?.id);
    if (!currentChat?.autoActive) continue;
    unscheduleChat(currentChat.id);
    await saveChat({ ...currentChat, autoActive: false });
    fixed += 1;
  }
  for (const { userId, characterId } of collectConfirmedGhostMemoryScopes(report, knownActorIds)) {
    await deleteGhostCharacterScope(userId, characterId);
    fixed += 1;
  }
  // 清理动作可能在扫描后很久才确认；此处必须重新读取角色表，读取失败则中止，
  // 不能把“无法确认角色存在”当作“角色已删除”继续做不可逆清理。
  const liveCharacters = await db.getAllRecords('characters');
  const liveCharacterIds = new Set(
    (liveCharacters || []).map((row) => String(row?.id || '').trim()).filter(Boolean),
  );
  const protectedActorIds = new Set([...knownActorIds, ...liveCharacterIds, ...liveUserIds]);
  const auxiliaryGhostIds = collectConfirmedAuxiliaryGhostIds(report, protectedActorIds);
  for (const characterId of auxiliaryGhostIds) {
    const chatIds = new Set(
      [...(report?.orphanPrivateChats || []), ...(report?.orphanSlotChats || [])]
        .filter((chat) => chatPartnerCharacterIds(chat).includes(characterId))
        .map((chat) => String(chat?.id || ''))
        .filter(Boolean),
    );
    await deleteCharacterAuxiliaryData(characterId, chatIds);
  }
  const orphanNetworkIds = (report?.orphanRelationshipActors || [])
    .map((item) => String(item?.actorId || '').trim())
    .filter(Boolean);
  if (orphanNetworkIds.length) {
    const { pruneActorsFromRelationshipNetwork } = await import('./relationship-network.js');
    const pruned = await pruneActorsFromRelationshipNetwork(orphanNetworkIds).catch(() => null);
    fixed += Number(pruned?.pruned?.length || 0);
  }
  for (const chat of report?.unauthorizedCrossGroupChats || []) {
    unscheduleChat(chat.id);
    await deleteChatWithData(chat.id, chat.userId);
    fixed += 1;
  }
  const unauthorizedLedgerKeys = new Set(
    (report?.unauthorizedCrossGroupLedgerEntries || [])
      .map((entry) => [String(entry?.a || ''), String(entry?.b || '')].sort().join('\0')),
  );
  if (unauthorizedLedgerKeys.size) {
    const { loadAcquaintanceLedger, saveAcquaintanceLedger, acquaintancePairKey } = await import('./acquaintance-ledger.js');
    const ledger = await loadAcquaintanceLedger();
    const before = asArray(ledger.entries).length;
    ledger.entries = asArray(ledger.entries).filter((entry) => (
      !unauthorizedLedgerKeys.has(acquaintancePairKey(entry?.a, entry?.b))
    ));
    await saveAcquaintanceLedger(ledger);
    fixed += before - ledger.entries.length;
  }
  const crossPhoneBySetting = new Map();
  for (const item of report?.unauthorizedCrossGroupPhoneContacts || []) {
    if (!item?.settingKey || !item?.contactId) continue;
    if (!crossPhoneBySetting.has(item.settingKey)) crossPhoneBySetting.set(item.settingKey, []);
    crossPhoneBySetting.get(item.settingKey).push(item);
  }
  for (const [settingKey, items] of crossPhoneBySetting) {
    const row = await db.getRecord('settings', settingKey);
    if (!row?.value) continue;
    const dropContactIds = new Set(items.map((item) => item.contactId));
    const removedLinkedIds = new Set([
      ...asArray(row.value.removedLinkedCharacterIds),
      ...items.map((item) => item.linkedCharacterId),
    ].filter(Boolean));
    await db.putRecord('settings', {
      ...row,
      value: {
        ...row.value,
        contacts: asArray(row.value.contacts).filter((contact) => (
          !dropContactIds.has(String(contact?.id || ''))
        )),
        groups: asArray(row.value.groups).map((group) => ({
          ...group,
          memberIds: asArray(group?.memberIds).filter((id) => !dropContactIds.has(String(id || ''))),
        })),
        removedLinkedCharacterIds: [...removedLinkedIds].slice(0, 200),
        updatedAt: Date.now(),
      },
    });
    fixed += dropContactIds.size;
  }
  if (report?.duplicateLocalMusicTracks?.length) {
    const { consolidateLocalTrackDuplicates } = await import('./music-library.js');
    const duplicatesByCanonical = new Map();
    for (const item of report.duplicateLocalMusicTracks) {
      const canonicalId = String(item?.canonicalId || '').trim();
      const duplicateId = String(item?.id || '').trim();
      if (!canonicalId || !duplicateId || canonicalId === duplicateId) continue;
      if (!duplicatesByCanonical.has(canonicalId)) duplicatesByCanonical.set(canonicalId, []);
      duplicatesByCanonical.get(canonicalId).push(duplicateId);
    }
    for (const [canonicalId, duplicateIds] of duplicatesByCanonical) {
      fixed += await consolidateLocalTrackDuplicates(canonicalId, duplicateIds);
    }
  }
  for (const item of report?.danglingMusicPlaylistRefs || []) {
    const playlist = await db.getRecord('musicPlaylists', item?.id);
    if (!playlist) continue;
    const requested = new Set(asArray(item?.trackIds).map((id) => String(id || '').trim()).filter(Boolean));
    const removable = new Set();
    for (const trackId of requested) {
      const track = await db.getRecord('musicTracks', trackId);
      if (!track) removable.add(trackId);
    }
    if (!removable.size) continue;
    const before = asArray(playlist.trackIds);
    const trackIds = before.filter((id) => !removable.has(String(id || '').trim()));
    const removed = before.length - trackIds.length;
    if (!removed) continue;
    await db.putRecord('musicPlaylists', { ...playlist, trackIds, updatedAt: Date.now() });
    fixed += removed;
  }
  for (const post of report?.danglingMusicPosts || []) {
    const currentPost = await db.getRecord('musicPosts', post?.id);
    if (!currentPost) continue;
    const trackId = String(currentPost?.trackId || '').trim();
    if (!trackId || await db.getRecord('musicTracks', trackId)) continue;
    await db.deleteRecord('musicPosts', currentPost.id);
    fixed += 1;
  }
  return { fixed };
}
