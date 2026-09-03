import * as db from './db.js';
import { ensureDefaultUser } from './user-slot.js';
import { getChat, listMessagesForChat } from './chat-store.js';
import { listCharacters } from './character-store.js';
import {
  listCharacterPhoneChats,
  loadPhoneChatAutoSettings,
  tryLockCharacterPhoneChat,
  unlockCharacterPhoneChat,
  buildPeerPrivatePhoneIdentityDirective,
} from './character-phone-messages.js';
import {
  loadCharacterPhone,
  getDailyLifePlanForDate,
  dateKeyFromTimestamp,
  pickCurrentPlanBlock,
} from './character-phone-store.js';
import { runHeadlessChatReply } from './chat/headless-reply.js';
import { isChatStreaming } from './chat/chat-stream-session.js';
import { getNowForUser } from './time-mode.js';
import {
  loadCharacterPhoneAutomationRuntime,
  saveCharacterPhoneAutomationRuntime,
} from './character-phone-automation-store.js';
import {
  loadCharacterPhoneContacts,
  buildPhoneLightContactCharacter,
  canPhoneAutoContactLinkedPeer,
} from './character-phone-contacts.js';
import {
  loadRelationshipNetwork,
  collectGlobalRelationshipNetworkLines,
} from './relationship-network.js';
import { loadContactGroupsConfig } from './contact-groups.js';
import { canPhoneCharactersKnowEachOther } from './phone-social-eligibility.js';
import { loadAcquaintanceLedger } from './acquaintance-ledger.js';
import { getUserDisplayName } from '../models/user.js';
import { isCharacterAutonomyMutedNow } from './character-autonomy-settings.js';
import { isCharacterBusyInOfflineSession } from './character-phone-proactive.js';

export const CHARACTER_PHONE_CHAT_CHECK_MS = 5 * 60 * 1000;

const characterLocks = new Set();
const chatLocks = new Set();

function stateKey(userId, characterId) {
  return `characterPhoneChatAutoState:${userId}:${characterId}`;
}

function todayKey(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function loadRunState(userId, characterId, now) {
  const runtime = await loadCharacterPhoneAutomationRuntime(userId, characterId);
  const value = runtime.phoneChatAuto || {};
  const day = todayKey(now);
  return value.day === day ? { day, count: Number(value.count || 0), lastRunAt: Number(value.lastRunAt || 0) }
    : { day, count: 0, lastRunAt: 0 };
}

async function saveRunState(userId, characterId, value) {
  await Promise.all([
    saveCharacterPhoneAutomationRuntime(userId, characterId, { phoneChatAuto: value }),
    db.put('settings', { key: stateKey(userId, characterId), value }),
  ]);
}

function chatAllowed(chat, settings) {
  const participants = chat?.participants || [];
  // 「手机内会话托管」只负责 TA 与其他联系人之间的手机会话。
  // 用户所在的主私聊/群聊分别由真人感回复与群聊自己的后台开关负责；
  // 若在这里继续扫描，会把旧用户消息误当成“尚未回复”，从而绕过主动总开关与静音。
  if (participants.includes('user')) return false;
  if (chat?.type === 'group') return settings.allowGroups !== false;
  return settings.allowPeers !== false;
}

export function isPhoneChatUnanswered(messages = [], characterId = '') {
  const visible = messages.filter((m) => m && !m.deleted && !m.recalled && m.senderId !== 'system');
  const last = visible[visible.length - 1];
  if (!last || last.senderId === characterId) return false;
  const lastRoundId = String(last.metadata?.aiRoundId || '').trim();
  const alreadySpokeInLastRound = !!lastRoundId && visible.some((message) => (
    String(message?.metadata?.aiRoundId || '').trim() === lastRoundId
    && String(message?.senderId || '') === String(characterId)
  ));
  const chainedPhoneAutoReply = last.metadata?.aiGenerated === true
    && String(last.metadata?.aiRoundKind || '') === 'phone-auto-reply';
  // 一次跨窗生成里双方已经来回过，就视为完整交流；手机托管自己的回复也不能再
  // 触发另一名角色下一轮托管，否则两台“手机”会每五分钟互相接力，自行聊个没完。
  return !alreadySpokeInLastRound && !chainedPhoneAutoReply;
}

function scoreCandidate(chat, messages, characterId, characterName, now, settings = {}) {
  const visible = messages.filter((m) => m && !m.deleted && !m.recalled && m.senderId !== 'system');
  const last = visible[visible.length - 1];
  if (!last) return { score: settings.allowProactive === true ? 2 : 0, last: null, unanswered: false };
  const ageHours = Math.max(0, now - Number(last.timestamp || 0)) / 3600000;
  const unanswered = isPhoneChatUnanswered(visible, characterId);
  // 自动轮优先顺序：用户明确发来 > 私聊对象发来 > 群里的新消息。
  // 没有新消息时不启动一段单人独角戏，只有用户显式允许主动发起才保留极低权重。
  let score = 0;
  if (unanswered) {
    score = (chat?.participants || []).includes('user') ? 110 : (chat?.type === 'group' ? 68 : 88);
  } else if (settings.allowProactive === true && ageHours > 24) {
    score = 4;
  }
  if (unanswered && ageHours < 12) score += 25;
  if (String(last.content || '').includes(characterName)) score += 18;
  if (/[?？!！]/.test(String(last.content || ''))) score += 8;
  if (ageHours > 48) score -= 25;
  if (!unanswered && ageHours > 24) score += 5;
  return { score, last, unanswered };
}

async function isBusyFromSchedule(userId, characterId, now) {
  const phone = await loadCharacterPhone(userId, characterId).catch(() => null);
  const plan = phone ? getDailyLifePlanForDate(phone, dateKeyFromTimestamp(now)) : null;
  const block = plan ? pickCurrentPlanBlock(plan, now) : null;
  const text = `${block?.activity || ''} ${block?.title || ''}`;
  return /睡|工作|上课|开会|考试|驾驶|洗澡|手术|演出/.test(text);
}

async function runCharacterWindow({
  user, character, chat, messages, now, unanswered, reason = '',
}) {
  const [all, phoneContacts, relationshipNet, contactGroupsConfig, acquaintanceLedger] = await Promise.all([
    listCharacters({ includeInternal: true, userId: user.id, identityScoped: true }).catch(() => []),
    loadCharacterPhoneContacts(user.id, character.id).catch(() => ({ contacts: [] })),
    loadRelationshipNetwork(user.id).catch(() => null),
    loadContactGroupsConfig().catch(() => ({ groups: [] })),
    loadAcquaintanceLedger().catch(() => ({ entries: [] })),
  ]);
  const rawParticipantIds = (chat.participants || []).filter((id) => id && id !== 'user');
  const removedPeer = rawParticipantIds.find((id) => id !== character.id
    && all.some((row) => row.id === id)
    && !canPhoneAutoContactLinkedPeer(phoneContacts, id));
  if (removedPeer) return { ok: false, reason: 'phone-contact-removed' };
  const ineligiblePeer = rawParticipantIds.find((id) => id !== character.id
    && all.some((row) => row.id === id)
    && !canPhoneCharactersKnowEachOther(
      character,
      all.find((row) => row.id === id),
      relationshipNet,
      contactGroupsConfig,
      acquaintanceLedger,
    ));
  if (ineligiblePeer) return { ok: false, reason: 'cross-group-phone-chat' };
  const participantIds = new Set(rawParticipantIds);
  const characters = Object.fromEntries(all.filter((row) => participantIds.has(row.id)).map((row) => [row.id, row]));
  for (const contact of phoneContacts.contacts || []) {
    if (!participantIds.has(contact.id) || characters[contact.id]) continue;
    characters[contact.id] = buildPhoneLightContactCharacter(contact, character.id);
  }
  const name = String(character.customNickname || character.name || character.id);
  const hasUserInChat = (chat.participants || []).includes('user');
  const peerIds = (chat.participants || []).filter((id) => id && id !== 'user' && id !== character.id);
  const peerNames = peerIds.map((id) => String(characters[id]?.customNickname || characters[id]?.name || id));
  const relationLines = [];
  const ownerWithUser = String(character.userRelationStatus || '').trim();
  if (hasUserInChat && ownerWithUser) relationLines.push(`${name} 与用户：${ownerWithUser}`);
  for (const peerId of peerIds.slice(0, 3)) {
    const peer = characters[peerId];
    if (!peer) continue;
    const peerName = String(peer.customNickname || peer.name || peerId);
    const peerWithUser = String(peer.userRelationStatus || '').trim();
    if (hasUserInChat && peerWithUser) relationLines.push(`${peerName} 与用户：${peerWithUser}`);
    const ownerToPeer = peerId && character.relationships && typeof character.relationships === 'object'
      ? String(character.relationships[peerId] || '').trim()
      : '';
    const peerToOwner = peer.relationships && typeof peer.relationships === 'object'
      ? String(peer.relationships[character.id] || '').trim()
      : '';
    if (ownerToPeer) relationLines.push(`${name} 对 ${peerName}：${ownerToPeer}`);
    if (peerToOwner) relationLines.push(`${peerName} 对 ${name}：${peerToOwner}`);
  }
  if (relationshipNet) {
    const netLines = collectGlobalRelationshipNetworkLines(relationshipNet, {
      partnerIds: [character.id, ...peerIds],
      characters: { ...characters, [character.id]: character },
      userName: getUserDisplayName(user) || '用户',
      maxEdges: 6,
      includeUser: hasUserInChat,
    });
    relationLines.push(...netLines.slice(0, 4));
  }
  const directive = [
    '【角色 Chat 自动回复轮】这是独立于日程主动消息的一次手机回复。',
    buildPeerPrivatePhoneIdentityDirective(chat, {
      ownerName: name,
      peerNames,
    }),
    hasUserInChat
      ? ''
      : `注意：这扇窗是 ${name} 和 ${peerNames.join('、') || '其他角色'} 之间的${chat.type === 'group' ? '群聊' : '私聊'}，用户不在本会话里，看不到也不会回复这里的消息；禁止把对方当成用户，禁止出现向用户搭话的口吻。`,
    relationLines.length
      ? `关系约束（必须服从）：${relationLines.slice(0, 6).join('；')}。若彼此是情敌/竞争关系，口吻应有张力或客气疏离，绝不能突然改称家属/兄弟/闺蜜。`
      : '',
    `本轮唯一允许发言的人是 ${name}（id=${character.id}）；绝对不要替 user 或其他角色回复。消息数量与分条服从人物语料和【回复节奏 · 错落】，本调度器不另设低条数默认值。`,
    unanswered
      ? '优先承接窗口里对 TA 尚未回复的最后一条消息，结合当前关系和知情边界自然回应。'
      : '当前没有明确未回复消息；确实想说话、有新信息或有自然话题时才主动发起。开口可以只是轻闲聊，不强制高信息量或推进剧情；也不要用空占位冒充主动性。',
    '禁止新建群、拉人或换窗；不要复述最近已经说过的内容。',
  ].filter(Boolean).join('\n');
  // 角色正和用户线下见面时，手机内会话仍可承接联系人刚发来的消息，
  // 但不能再主动找其他联系人开话题。放在请求边界复核，避免候选扫描后才进入线下。
  if (!unanswered && await isCharacterBusyInOfflineSession(user.id, character.id).catch(() => false)) {
    return { ok: false, skipped: true, reason: 'active-offline-session' };
  }
  return runHeadlessChatReply(chat, user, {
    allowInactive: true,
    phoneViewerId: character.id,
    sceneDirective: directive,
    aiRoundKind: 'phone-auto-reply',
    // 防回滚按真实请求先后排序；now 是故事钟，可能被暂停、回拨或跨日补聊。
    aiRoundCreatedAt: Date.now(),
    skipBusyAutoReply: true,
    reason: /^catch-up:/i.test(String(reason || ''))
      ? `${String(reason)}:phone-auto-reply`
      : 'phone-auto-reply',
    ...(unanswered ? {} : {
      proactiveChannel: 'phone-chat-proactive',
      proactiveIdempotencyKey: `${character.id}:${chat.id}:${Number(messages[messages.length - 1]?.timestamp || 0)}`,
    }),
    onlySenderId: character.id,
  });
}

async function listEnabledCharacterIds(userId) {
  const rows = await db.getAllRecords('settings').catch(() => []);
  const legacyPrefix = `characterPhoneChatAuto:${userId}:`;
  const configPrefix = `characterPhoneAutomationConfig:${encodeURIComponent(String(userId || '').trim() || 'guest')}:`;
  const legacyIds = (rows || [])
    .filter((row) => String(row?.key || '').startsWith(legacyPrefix) && row?.value?.enabled === true)
    .map((row) => String(row.key).slice(legacyPrefix.length));
  const configIds = (rows || [])
    .filter((row) => String(row?.key || '').startsWith(configPrefix) && row?.value?.phoneChatAuto?.enabled === true)
    .map((row) => String(row?.value?.characterId || '').trim())
    .filter(Boolean);
  return [...new Set([...legacyIds, ...configIds])].filter(Boolean);
}

export async function runCharacterPhoneChatSchedulerCheck({ user: suppliedUser = null, reason = 'timer' } = {}) {
  const user = suppliedUser || await ensureDefaultUser();
  const now = await getNowForUser(user.id).catch(() => Date.now());
  const enabledIds = await listEnabledCharacterIds(user.id);
  if (!enabledIds.length) return { ok: true, reason: 'nothing-enabled', processed: 0 };
  const all = await listCharacters({
    excludeAnonNpc: true,
    userId: user.id,
    identityScoped: true,
  }).catch(() => []);
  const byId = new Map(all.map((row) => [row.id, row]));

  for (const characterId of enabledIds) {
    if (characterLocks.has(characterId)) continue;
    const character = byId.get(characterId);
    if (!character) continue;
    const settings = await loadPhoneChatAutoSettings(user.id, characterId);
    const state = await loadRunState(user.id, characterId, now);
    if (state.count >= settings.dailyLimit) continue;
    if (now - state.lastRunAt < settings.intervalMinutes * 60000) continue;
    const muted = await isCharacterAutonomyMutedNow(user.id, characterId, now);
    const chats = (await listCharacterPhoneChats(user.id, characterId)).filter((chat) => chatAllowed(chat, settings));
    const scored = [];
    for (const chat of chats.slice(0, 24)) {
      if (chatLocks.has(chat.id) || isChatStreaming(chat.id)) continue;
      const messages = await listMessagesForChat(chat.id, 40);
      if (messages.some((message) => message?.metadata?.aiPlaceholder)) continue;
      const score = scoreCandidate(
        chat,
        messages,
        characterId,
        String(character.customNickname || character.name || ''),
        now,
        settings,
      );
      // 静音时段只拦「主动开话题」；有人对 TA 说话时的回复仍放行。
      if (muted && !score.unanswered) continue;
      if (score.score > 0) scored.push({ chat, messages, ...score });
    }
    scored.sort((a, b) => b.score - a.score || (b.chat.lastActivity || 0) - (a.chat.lastActivity || 0));
    const target = scored[0];
    if (!target) continue;
    // 线下进行中先在候选阶段短路，避免为一条注定不会发送的主动开场加载完整上下文。
    // 联系人已经发来消息时仍允许 TA 正常回复，不把手机托管整体冻结。
    if (!target.unanswered
      && await isCharacterBusyInOfflineSession(user.id, characterId).catch(() => false)) continue;
    const busy = await isBusyFromSchedule(user.id, characterId, now);
    const age = now - Number(target.last?.timestamp || 0);
    if (busy && (!target.unanswered || age < 6 * 3600000)) continue;

    characterLocks.add(characterId);
    chatLocks.add(target.chat.id);
    if (!tryLockCharacterPhoneChat(target.chat.id)) {
      chatLocks.delete(target.chat.id);
      characterLocks.delete(characterId);
      continue;
    }
    try {
      const freshChat = await getChat(target.chat.id);
      if (!freshChat) continue;
      const latestSettings = await loadPhoneChatAutoSettings(user.id, characterId);
      if (latestSettings.enabled !== true) continue;
      if (!chatAllowed(freshChat, latestSettings)) continue;
      // 候选打分到真正拿到锁之间，用户可能删消息、手动回复或由其它通道生成了一轮。
      // 必须用最新消息重新确认，不能拿扫描阶段的旧快照继续生成。
      const freshMessages = await listMessagesForChat(freshChat.id, 40);
      const freshTarget = scoreCandidate(
        freshChat,
        freshMessages,
        characterId,
        String(character.customNickname || character.name || ''),
        now,
        latestSettings,
      );
      if (freshTarget.score <= 0) continue;
      if (!freshTarget.unanswered && latestSettings.allowProactive !== true) continue;
      const result = await runCharacterWindow({
        user,
        character,
        chat: freshChat,
        messages: freshMessages,
        now,
        unanswered: freshTarget.unanswered,
        reason,
      });
      await saveRunState(user.id, characterId, {
        day: state.day,
        count: state.count + (result?.ok === false ? 0 : 1),
        lastRunAt: now,
        lastChatId: target.chat.id,
        reason,
      });
      return { ok: true, processed: result?.ok === false ? 0 : 1, characterId, chatId: target.chat.id };
    } finally {
      unlockCharacterPhoneChat(target.chat.id);
      chatLocks.delete(target.chat.id);
      characterLocks.delete(characterId);
    }
  }
  return { ok: true, reason: 'nothing-due', processed: 0 };
}
