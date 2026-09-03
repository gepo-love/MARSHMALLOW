import { createChat, createMessage } from '../models/chat.js';
import { saveChat, saveMessage, listChatsForUser } from './chat-store.js';
import { getNowForUser } from './time-mode.js';
import { ensureUniqueAnonymousIdentityMap, getAnonymousIdentityMap } from './anonymous-chat.js';
import { generateAnonymousIdentityForActorSimple, rollMatchedActor } from './anonymous-match.js';
import {
  findAnonymousCharacterCandidateById,
  loadAnonymousCharacterCandidates,
} from './anonymous-character-pool.js';
import { getRecord } from './db.js';
import { buildUserAnonymousIdentitySeed, loadUserReservedAnonymousAvatars, loadUserReservedAnonymousHandles } from './anonymous-space.js';

function clean(value = '') {
  return String(value ?? '').trim();
}

export function isCyberConfessionChat(chat) {
  const meta = chat?.metadata || {};
  return String(meta.sourceAnonymousType || '') === 'cyber_confession'
    || String(meta.anonymousRoomKind || '').includes('confession');
}

export function getActiveConfessionCaseId(chat) {
  return clean(chat?.metadata?.activeConfessionCase?.id);
}

export function getConfessionMemoryIsolation(chat) {
  return clean(chat?.metadata?.confessionMemoryIsolation) === 'hard' ? 'hard' : 'soft';
}

export function shouldHardIsolateConfessionMemory(chat) {
  return isCyberConfessionChat(chat) && getConfessionMemoryIsolation(chat) !== 'soft';
}

export function filterMessagesForActiveConfessionCase(chat, messages = []) {
  if (!shouldHardIsolateConfessionMemory(chat)) return messages;
  const caseId = getActiveConfessionCaseId(chat);
  if (!caseId) return [];
  const startedAt = Number(chat?.metadata?.activeConfessionCase?.startedAt || 0) || 0;
  return (Array.isArray(messages) ? messages : []).filter((msg) => {
    const msgCaseId = clean(msg?.metadata?.confessionCaseId);
    if (msgCaseId) return msgCaseId === caseId;
    return startedAt && Number(msg?.timestamp || 0) >= startedAt;
  });
}

function roomKeyFor(mode, nunActorId = '') {
  if (mode === 'observer_nun') return `confession:observer:${clean(nunActorId)}`;
  if (mode === 'sister') return 'confession:sister';
  return 'confession:seeker';
}

function confessionRoomName(roleMode) {
  if (roleMode === 'observer_nun') return 'Cyber Confession - Observe';
  if (roleMode === 'sister') return 'Cyber Confession - My Shift';
  return 'Cyber Confession';
}

function rotatingActorIdForMode(roleMode, nunId = '', guestId = '') {
  return clean(roleMode === 'seeker' ? nunId : guestId);
}

function buildConfessionEnterNotice(roleMode, name) {
  const clamped = clean(name);
  if (roleMode === 'seeker') {
    return clamped ? clamped + ' entered the confession room' : 'Confession room opened';
  }
  const room = roleMode === 'sister' ? 'shift room' : 'confession room';
  return clamped ? clamped + ' entered ' + room : room + ' opened';
}

function buildConfessionLeaveNotice(roleMode, name) {
  const clamped = clean(name);
  if (!clamped) return '';
  if (roleMode === 'seeker') return clamped + ' left the confession room';
  const room = roleMode === 'sister' ? 'shift room' : 'confession room';
  return clamped + ' left ' + room;
}

async function resolveConfessionActor(actorId) {
  const id = clean(actorId);
  if (!id || id === 'user') return null;
  const existing = await getRecord('characters', id);
  if (existing) return existing;
  const candidate = await findAnonymousCharacterCandidateById(id);
  if (!candidate) return null;
  const { anonymousMeta, ...runtimeOnly } = candidate;
  return runtimeOnly;
}

async function findExistingConfessionRoom(userId, key) {
  const chats = await listChatsForUser(userId);
  return chats.find((c) => c?.metadata?.sourceAnonymousType === 'cyber_confession'
    && clean(c?.metadata?.confessionRoomKey) === key) || null;
}

async function buildUserConfessionIdentity(userId, userRow, mode) {
  const fallbackName = mode === 'sister' ? 'Night Sister' : 'Anonymous Confessor';
  const seed = await buildUserAnonymousIdentitySeed(String(userId || userRow?.id || '').trim(), { userRow });
  return {
    currentId: seed.currentId || fallbackName,
    signature: seed.signature || (mode === 'sister' ? 'On duty in the confession room' : 'Entering with a small secret'),
    avatar: seed.avatar || '',
  };
}

async function rollConfessionActors(roleMode, nunActorId = '', excludeIds = [], userId = '') {
  let nunId = '';
  let guestId = '';
  const exclude = [...new Set(['user', ...(excludeIds || [])].map(clean).filter(Boolean))];
  const candidatePool = await loadAnonymousCharacterCandidates({ userId });
  if (roleMode === 'seeker') {
    nunId = await rollMatchedActor({ excludeIds: exclude, purposeId: 'sad', candidatePool });
    if (!nunId) nunId = await rollMatchedActor({ excludeIds: ['user'], purposeId: 'sad', candidatePool });
    if (!nunId) throw new Error('No available confession actor');
    await resolveConfessionActor(nunId);
  } else if (roleMode === 'sister') {
    guestId = await rollMatchedActor({ excludeIds: exclude, purposeId: 'vent', candidatePool });
    if (!guestId) guestId = await rollMatchedActor({ excludeIds: ['user'], purposeId: 'vent', candidatePool });
    if (!guestId) throw new Error('No available confession guest');
    await resolveConfessionActor(guestId);
  } else {
    nunId = clean(nunActorId);
    if (!nunId) throw new Error('Please choose a confession actor');
    if (!candidatePool.some((candidate) => clean(candidate?.id) === nunId)) {
      throw new Error('所选角色不属于当前面具');
    }
    await resolveConfessionActor(nunId);
    guestId = await rollMatchedActor({ excludeIds: [...exclude, nunId], purposeId: 'vent', candidatePool });
    if (!guestId) guestId = await rollMatchedActor({ excludeIds: ['user', nunId], purposeId: 'vent', candidatePool });
    if (!guestId) throw new Error('No available confession guest');
    await resolveConfessionActor(guestId);
  }
  return { nunId, guestId };
}

async function buildConfessionIdentities({
  uid,
  userRow,
  roleMode,
  participants,
  nunId,
  guestId,
  nonce,
  previous = {},
} = {}) {
  const draft = { ...(previous && typeof previous === 'object' ? previous : {}) };
  if (participants.includes('user') && !draft.user) {
    draft.user = await buildUserConfessionIdentity(uid, userRow, roleMode);
  }
  for (const actorId of participants.filter((id) => id && id !== 'user')) {
    if (draft[actorId]?.currentId && actorId === nunId && roleMode === 'observer_nun') continue;
    const char = await findAnonymousCharacterCandidateById(actorId);
    draft[actorId] = generateAnonymousIdentityForActorSimple(actorId, 'confession', `${nonce}|${actorId}`, char);
    if (actorId === nunId) draft[actorId].signature = `${draft[actorId].currentId}, anonymous listener`;
    if (actorId === guestId) draft[actorId].signature = `${draft[actorId].currentId}, confession guest`;
  }
  const reservedHandles = await loadUserReservedAnonymousHandles(userRow);
  const reservedAvatars = await loadUserReservedAnonymousAvatars(userRow);
  return {
    ...draft,
    ...ensureUniqueAnonymousIdentityMap(draft, participants, {
      reservedHandles,
      reservedAvatars,
    }),
  };
}

function currentConfessionActorIds(chat = {}) {
  const active = chat?.metadata?.activeConfessionCase || {};
  return [
    active.nunActorId,
    active.guestActorId,
    ...(Array.isArray(chat?.participants) ? chat.participants : []),
  ].map(clean).filter((id) => id && id !== 'user');
}

function setConfessionParticipants(chat, roleMode, identities, nunId = '', guestId = '', previousIdentities = {}) {
  const isGroup = roleMode === 'observer_nun';
  const participants = isGroup ? [nunId, guestId] : ['user', roleMode === 'seeker' ? nunId : guestId];
  chat.type = isGroup ? 'group' : 'private';
  chat.participants = participants.filter(Boolean);
  // Preserve previous anonymous identity entries so old messages keep resolving after actor rotation.
  const mergedIdentities = {
    ...(previousIdentities && typeof previousIdentities === 'object' ? previousIdentities : {}),
    ...identities,
  };
  chat.groupSettings = {
    ...(chat.groupSettings || {}),
    name: confessionRoomName(roleMode),
    isObserverMode: isGroup,
    anonymousRoomConfig: {
      ...(chat.groupSettings?.anonymousRoomConfig || {}),
      topic: '赛博告解',
      vibe: 'confession',
      onlineOnly: true,
      allowAnonymousPrivate: false,
    },
    anonymousIdentities: mergedIdentities,
  };
  if (isGroup) {
    chat.anonymousPrivateConfig = null;
  } else {
    chat.anonymousPrivateConfig = {
      ...(chat.anonymousPrivateConfig || {}),
      selfActorId: 'user',
      counterpartActorId: roleMode === 'seeker' ? nunId : guestId,
      identities: mergedIdentities,
    };
  }
  return participants;
}

async function startConfessionCaseOnChat(chat, {
  userId,
  userRow = null,
  roleMode = 'seeker',
  nunActorId = '',
  memoryIsolation = 'soft',
  excludeIds = [],
} = {}) {
  const uid = clean(userId || chat?.userId);
  const ts = await getNowForUser(uid);
  const nonce = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const caseId = `confcase_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const previousIdentities = getAnonymousIdentityMap(chat);
  const prevCase = chat?.metadata?.activeConfessionCase || {};
  const prevRotatingId = rotatingActorIdForMode(roleMode, prevCase.nunActorId, prevCase.guestActorId);
  const prevRotatingName = clean(previousIdentities?.[prevRotatingId]?.currentId);
  const { nunId, guestId } = await rollConfessionActors(roleMode, nunActorId, excludeIds, uid);
  const participants = roleMode === 'observer_nun' ? [nunId, guestId] : ['user', roleMode === 'seeker' ? nunId : guestId];
  const identities = await buildConfessionIdentities({
    uid,
    userRow,
    roleMode,
    participants,
    nunId,
    guestId,
    nonce,
    previous: previousIdentities,
  });
  setConfessionParticipants(chat, roleMode, identities, nunId, guestId, previousIdentities);
  chat.metadata = {
    ...(chat.metadata || {}),
    channel: 'anonymous',
    anonymousMode: true,
    anonymousRoomKind: 'confession',
    memoryMode: chat.metadata?.memoryMode || 'inherit_full',
    sourceAnonymousType: 'cyber_confession',
    confessionMemoryIsolation: memoryIsolation === 'hard' ? 'hard' : 'soft',
    activeConfessionCase: {
      id: caseId,
      startedAt: ts,
      roleMode,
      nunActorId: nunId,
      guestActorId: guestId,
    },
    plotDirective: '',
  };
  chat.metadata.anonymousRoomId = chat.id;
  chat.lastActivity = ts;

  const newRotatingId = rotatingActorIdForMode(roleMode, nunId, guestId);
  const newRotatingName = clean(identities[newRotatingId]?.currentId) || newRotatingId;
  const leaveNotice = buildConfessionLeaveNotice(roleMode, prevRotatingName);
  const enterNotice = buildConfessionEnterNotice(roleMode, newRotatingName);
  chat.lastMessage = enterNotice;
  await saveChat(chat);
  if (leaveNotice) {
    await saveMessage(createMessage({
      chatId: chat.id,
      senderId: 'system',
      senderName: '系统',
      type: 'system',
      content: leaveNotice,
      timestamp: ts,
      metadata: { anonymousSeed: true, roomLeaveNotice: true },
    }));
  }
  await saveMessage(createMessage({
    chatId: chat.id,
    senderId: 'system',
    senderName: '系统',
    type: 'system',
    content: enterNotice,
    timestamp: ts + 1,
    metadata: { confessionCaseId: caseId, anonymousSeed: true, roomJoinNotice: true },
  }));
  return chat;
}

export async function openOrCreateConfessionRoom({
  userId,
  userRow = null,
  mode = 'seeker',
  nunActorId = '',
  memoryIsolation = 'soft',
  startNewCase = false,
} = {}) {
  const uid = clean(userId);
  if (!uid) throw new Error('Not signed in');
  const roleMode = mode === 'observer_nun' ? 'observer_nun' : mode === 'sister' ? 'sister' : 'seeker';
  const key = roomKeyFor(roleMode, nunActorId);
  const existing = await findExistingConfessionRoom(uid, key);
  if (existing) {
    const desiredName = confessionRoomName(roleMode);
    let touched = false;
    if (clean(existing?.groupSettings?.name) !== desiredName) {
      existing.groupSettings = { ...(existing.groupSettings || {}), name: desiredName };
      touched = true;
    }
    if (clean(existing?.metadata?.plotDirective)) {
      existing.metadata = { ...(existing.metadata || {}), plotDirective: '' };
      touched = true;
    }
    if (!startNewCase) {
      if (touched) await saveChat(existing);
      return existing;
    }
    if (touched) await saveChat(existing);
    return startConfessionCaseOnChat(existing, {
      userId: uid,
      userRow,
      roleMode,
      nunActorId,
      memoryIsolation,
      excludeIds: currentConfessionActorIds(existing),
    });
  }

  let chat = null;
  const ts = await getNowForUser(uid);
  const nonce = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const caseId = `confcase_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  const { nunId, guestId } = await rollConfessionActors(roleMode, nunActorId, [], uid);

  const participants = roleMode === 'observer_nun' ? [nunId, guestId] : ['user', roleMode === 'seeker' ? nunId : guestId];
  const identities = await buildConfessionIdentities({
    uid,
    userRow,
    roleMode,
    participants,
    nunId,
    guestId,
    nonce,
  });
  const isGroup = roleMode === 'observer_nun';

  {
    chat = createChat({
      type: isGroup ? 'group' : 'private',
      userId: uid,
      participants,
      groupSettings: {
        name: confessionRoomName(roleMode),
        isObserverMode: roleMode === 'observer_nun',
        anonymousRoomConfig: {
          topic: '赛博告解',
          vibe: 'confession',
          onlineOnly: true,
          allowAnonymousPrivate: false,
        },
        anonymousIdentities: identities,
      },
      metadata: {
        channel: 'anonymous',
        anonymousMode: true,
        anonymousRoomKind: 'confession',
        memoryMode: 'inherit_full',
        sourceAnonymousType: 'cyber_confession',
        confessionRoomKey: key,
        confessionMemoryIsolation: memoryIsolation === 'hard' ? 'hard' : 'soft',
      },
      lastActivity: ts,
    });
    if (isGroup) {
      chat.anonymousPrivateConfig = null;
    } else {
      chat.anonymousPrivateConfig = {
        selfActorId: 'user',
        counterpartActorId: roleMode === 'seeker' ? nunId : guestId,
        identities,
      };
    }
  }

  chat.metadata = {
    ...(chat.metadata || {}),
    activeConfessionCase: {
      id: caseId,
      startedAt: ts,
      roleMode,
      nunActorId: nunId,
      guestActorId: guestId,
    },
  };
  chat.metadata.anonymousRoomId = chat.id;
  const rotatingId = rotatingActorIdForMode(roleMode, nunId, guestId);
  const opener = buildConfessionEnterNotice(roleMode, clean(identities[rotatingId]?.currentId) || rotatingId);
  chat.lastMessage = opener;
  await saveChat(chat);

  const msg = createMessage({
    chatId: chat.id,
    senderId: 'system',
    senderName: '系统',
    type: 'system',
    content: opener,
    timestamp: ts,
    metadata: { confessionCaseId: caseId, anonymousSeed: true, roomJoinNotice: true },
  });
  await saveMessage(msg);
  return chat;
}

/** 告解客人的内核：拧巴的树洞倾诉。sister（用户值班）与 observer（旁观）两个模式共用。 */
function buildConfessionGuestCoreLines() {
  return [
    '- 【客人的状态是拧巴的】TA 是自己憋不住才点进来的，但真到了要开口又不知道从何说起：可以先扯两句无关的、试探这里安不安全、说半句又收回去、自嘲「说出来挺没意思的」；这份「想说又说不出口」本身就是告解室的戏，不要一进来就把心事完整倒干净。',
    '- 【这里是树洞】客人吐露的多半是平时没处说、说了怕被评判的东西，往往带点负面或见不得光：可以是关于外面那个放不下的人的——嫉妒某个走得近的人、藏不住的占有欲、不敢见光的阴湿暗恋、怕给对方添麻烦所以一直没说出口的心思；也可以是生活里别的事、别的关系——跟家里的疙瘩、职场憋屈、对朋友说不出口的愧疚。',
    '- 【不必上纲上线】心事可大可小：不是每次都要掏最重的那件，鸡毛蒜皮的别扭、一件干完之后有点后悔又有点爽的恶作剧、纯粹想找人炫耀一下的小坏事，都可以是本次告解的内容。按角色背景与当下心境定这次带什么进来。',
    '- 【绝不把修女当成外面那个人】值班倾听者只是一个素不相识的匿名马甲。客人正因为对面是陌生人才敢开口——如果 TA 心事关于外面的 user，更要注意：TA 完全不知道、也不会怀疑眼前这位修女就是那个人本人；提到那个人时只用模糊指代（「那个人」「TA」「某个很重要的人」），语气是对第三方倾诉，绝不是对本人告白或对质。',
    '- 【关于外面那个人的信息绝对禁止虚构】凡是涉及外面的 user 的内容——发生过什么、说过什么话、两人现在什么关系、最近有什么事——只能取自已发生的聊天记录、记忆摘要和人物设定，一个字都不能瞎编。没有对应素材就只谈角色自己单方面的感受和心思（TA 的嫉妒、不安、没说出口的话），不要为了让告解有戏而捏造从未发生的互动、约定、争吵或第三者情节。',
  ];
}

export function buildAnonymousConfessionContextPrompt(chat = {}) {
  if (!isCyberConfessionChat(chat)) return '';
  const roleMode = clean(chat?.metadata?.activeConfessionCase?.roleMode) || 'seeker';
  const isHard = getConfessionMemoryIsolation(chat) === 'hard';
  const lines = [
    '【赛博告解室】',
    '- 这是匿名线上告解室：一边是进来倒心事的匿名告解者，一边是值班倾听的匿名修女/听者。所有人只以本房匿名 ID 出现。',
    '- 【开局是彻底的陌生人】双方此前从未说过话，对彼此一无所知。开场必须有真实的陌生感和试探期：语气克制、留有距离；禁止一上来就热络寒暄、叫昵称、自来熟或表现出「早就熟识」的亲近。信任只能靠本次对话一句一句攒出来。',
    '- 告解室的节奏是慢的：短句、停顿、欲言又止都正常；不要急着把话题推向亲密或情感拉扯，更不要一开场就暧昧。',
    '- 禁止暴露真实姓名、住址、联系方式或任何可定位信息。',
    '- 不能默认匿名 user 就是外面的 user，除非当前匿名对话内多轮明确铺垫确立。',
    '- 前台只用本房匿名 ID；角色私下背景只用来定口吻和动机，不能当作身份证据说出来。',
  ];
  if (roleMode === 'sister') {
    lines.push('- 本局 AI 扮演进来告解的匿名客人，值班倾听的修女是用户。');
    lines.push(...buildConfessionGuestCoreLines());
  } else if (roleMode === 'observer_nun') {
    lines.push('- 本局是用户旁观：一位匿名倾听者与一位匿名客人对谈，两人互为陌生人。对话保持克制、迂回、有间隙，不要写成熟人夜谈；倾听者接得住但不咨询腔、不急着开解。');
    lines.push(...buildConfessionGuestCoreLines());
  } else {
    lines.push('- 本局 AI 扮演匿名倾听者：把用户当成素不相识的匿名来访者。来倾诉的人多半是拧巴的——想说又不知道从何说起，可能先绕圈子、说半句收回去；倾听者要给足空隙，先接住、后展开，可以轻轻递一个开口的台阶（「不着急，想到哪说到哪」），不评判、不咨询腔、不急着安慰到位，也不逼问细节。');
    lines.push('- 【倾听者若提及自己的生活】同样只能取自角色自身的人设、记忆和已发生的聊天记录；涉及外面的 user 的一切信息绝对禁止虚构，没有素材就不提。');
  }
  if (isHard) lines.push('- 硬隔离：只使用本次告解案的对话内容，不携带外部关系记忆。');
  else lines.push('- 软继承：角色自身的心境可以影响告解的底色（TA 最近真实的心事就是最好的素材），但身份保持匿名、互不合并。');
  return lines.join('\n');
}
