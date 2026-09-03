/**
 * 赴约自动回复（user 侧）：用户正在线下时，其他角色发来消息的自动应对。
 *
 * 三档：off（关闭）/ fixed（user 的固定文案）/ companion（同行角色代答）。
 * 完整小回合在同一次后台执行里完成：
 *   对方主动消息 → user 侧自动回复落进那个聊天 → 对方同轮再回一轮 → 折成线下「手机插曲」beat。
 *
 * 对方只依据回复原文和既有上下文判断，不额外被告知用户没透露的信息；
 * 同行代答时对方也不被直接告知是谁代的，只能从措辞与称呼里察觉。
 */

import { get as dbGet, put as dbPut } from './db.js';
import { createMessage } from '../models/chat.js';
import { createMemory } from '../models/memory.js';
import { getUserDisplayName } from '../models/user.js';
import { getCharacterAiContextName } from '../models/character.js';
import { getCharacter } from './character-store.js';
import {
  getChat,
  listChatsForUser,
  listMessagesForChat,
  saveMessage,
  saveMemory,
  updateChatPreview,
  previewFromMessage,
} from './chat-store.js';
import { getNowForUser } from './time-mode.js';
import { loadOfflineSession, saveOfflineSession } from './offline-session-store.js';
import {
  getActiveOfflineParticipantIds,
  inviteOfflineParticipant,
  joinOfflineParticipant,
} from './offline-session.js';
import { chat as apiChat, resolveGenerationMaxTokens } from './api.js';
import { chatWithEmptyFallback } from './narration-compat.js';
import { buildOfflineInterludeBeat } from './offline-interlude.js';
import {
  OFFLINE_PHONE_FREQUENCIES,
  announceOfflinePhoneCinematic,
  createOfflinePhoneCinematicJob,
  isOfflinePhoneCinematicForeground,
  rollOfflinePhoneCinematic,
} from './offline-phone-cinematic.js';

export const OFFLINE_AUTO_REPLY_MODES = ['off', 'fixed', 'companion'];
export const DEFAULT_OFFLINE_AUTO_REPLY_TEXT = '在外面，晚点回你。';
export const OFFLINE_PHONE_CINEMATIC_TIMEOUT_MS = 60 * 1000;
const storyTakeoverRuns = new Set();

/**
 * 掏手机被注意只允许代回场外角色。
 * 当前窗口若就是同行者本人，让 TA 接过手机后再回复自己会形成角色自言自语。
 */
export function canRunOfflineSideTripTakeover({
  activeParticipantIds = [],
  proxyCharacterId = '',
  targetCharacterId = '',
} = {}) {
  const activeIds = new Set((Array.isArray(activeParticipantIds) ? activeParticipantIds : [])
    .map((id) => String(id || '').trim())
    .filter(Boolean));
  const proxyId = String(proxyCharacterId || '').trim();
  const targetId = String(targetCharacterId || '').trim();
  return !!proxyId && !!targetId && proxyId !== targetId && !activeIds.has(targetId);
}

function settingsKey(userId) {
  return `offlineAutoReply_${String(userId || '').trim()}`;
}

function normalizeSettings(raw = {}) {
  const v = raw && typeof raw === 'object' ? raw : {};
  const mode = OFFLINE_AUTO_REPLY_MODES.includes(String(v.mode || '')) ? String(v.mode) : 'off';
  const normalizeFeature = (value, fallbackEnabled = false) => {
    const source = value && typeof value === 'object' ? value : {};
    const frequency = Object.prototype.hasOwnProperty.call(OFFLINE_PHONE_FREQUENCIES, String(source.frequency || ''))
      ? String(source.frequency)
      : 'medium';
    return { enabled: source.enabled === true || (source.enabled == null && fallbackEnabled), frequency };
  };
  return {
    mode,
    fixedText: String(v.fixedText || '').trim().slice(0, 120),
    proxyCharacterId: String(v.proxyCharacterId || '').trim(),
    incomingTakeover: normalizeFeature(v.incomingTakeover, false),
    sideTripCaught: normalizeFeature(v.sideTripCaught, false),
    phoneMessagesEnabled: v.phoneMessagesEnabled !== false,
  };
}

/** 全局默认档位（进入线下时可被本场覆盖）。 */
export async function loadOfflineAutoReplySettings(userId) {
  const row = await dbGet(settingsKey(userId)).catch(() => null);
  return normalizeSettings(row?.value || {});
}

export async function saveOfflineAutoReplySettings(userId, patch = {}) {
  const prev = await loadOfflineAutoReplySettings(userId);
  const next = normalizeSettings({
    ...prev,
    ...(patch || {}),
    incomingTakeover: { ...prev.incomingTakeover, ...(patch?.incomingTakeover || {}) },
    sideTripCaught: { ...prev.sideTripCaught, ...(patch?.sideTripCaught || {}) },
  });
  await dbPut({ key: settingsKey(userId), value: next });
  return next;
}

/**
 * 新线下会话第一次进入页面时，把用户保存的默认档位固化为本场覆盖。
 * 已经存在本场设置时绝不重铺，避免页面重进后覆盖用户刚保存的选择。
 */
export function applyOfflineAutoReplyDefaults(session, globalSettings = {}) {
  if (!session || typeof session !== 'object') return false;
  if (session.autoReply && typeof session.autoReply === 'object') return false;
  const defaults = normalizeSettings(globalSettings);
  session.autoReply = {
    mode: defaults.mode,
    fixedText: defaults.fixedText,
    proxyCharacterId: defaults.proxyCharacterId,
    incomingTakeover: { ...defaults.incomingTakeover },
    sideTripCaught: { ...defaults.sideTripCaught },
  };
  session.scene = {
    ...(session.scene || {}),
    phoneMessagesEnabled: defaults.phoneMessagesEnabled,
  };
  return true;
}


/** 本场覆盖（session.autoReply）优先，其次全局默认。 */
export function resolveOfflineAutoReplyConfig(session, globalSettings = {}) {
  const override = session?.autoReply && typeof session.autoReply === 'object' ? session.autoReply : null;
  const base = normalizeSettings(globalSettings);
  if (override && OFFLINE_AUTO_REPLY_MODES.includes(String(override.mode || ''))) {
    return {
      mode: String(override.mode),
      fixedText: String(override.fixedText || base.fixedText || '').trim().slice(0, 120),
      proxyCharacterId: String(override.proxyCharacterId || base.proxyCharacterId || '').trim(),
      incomingTakeover: {
        ...base.incomingTakeover,
        ...(override.incomingTakeover || session?.incomingTakeover || {}),
      },
      sideTripCaught: {
        ...base.sideTripCaught,
        ...(override.sideTripCaught || session?.sideTripCaught || {}),
      },
    };
  }
  return base;
}

function genBeatId() {
  return `ob_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function msgLine(msg, senderLabel) {
  const type = String(msg?.type || 'text');
  const body = String(msg?.content || '').replace(/\s+/g, ' ').trim();
  if (type === 'text' && body) return `${senderLabel}：${body.slice(0, 120)}`;
  if (type === 'image') return `${senderLabel}：[发了张图]`;
  if (type === 'sticker') return `${senderLabel}：[表情]`;
  if (type === 'voice') return `${senderLabel}：[语音]`;
  if (body) return `${senderLabel}：${body.slice(0, 120)}`;
  return '';
}

/**
 * 线下期间的手机往来仍属于目标聊天的连续记忆。
 * 这段往来不能依赖聊天自动总结（默认关闭且有条数阈值），所以在回合落库后
 * 直接为发消息的场外角色写一条幂等事件记忆；只写实际消息，不泄露线下现场细节。
 */
export async function syncOfflineChatContinuityMemory({
  user,
  chat,
  senderCharacterId = '',
  incomingMessages = [],
  replyMessage = null,
  counterpartMessages = [],
  timestamp = Date.now(),
} = {}) {
  const userId = String(user?.id || '').trim();
  const characterId = String(senderCharacterId || '').trim();
  const chatId = String(chat?.id || '').trim();
  if (!userId || !characterId || !chatId || !replyMessage?.id) return null;
  const sender = await getCharacter(characterId, { userId }).catch(() => null);
  const senderName = (sender?.customNickname || sender?.name || replyMessage.senderName || 'TA');
  const incomingLines = (Array.isArray(incomingMessages) ? incomingMessages : [])
    .map((message) => msgLine(message, senderName)).filter(Boolean).slice(0, 6);
  const replyLine = msgLine(replyMessage, '用户');
  const counterpartLines = (Array.isArray(counterpartMessages) ? counterpartMessages : [])
    .map((message) => msgLine(message, senderName)).filter(Boolean).slice(0, 4);
  const lines = [...incomingLines, replyLine, ...counterpartLines].filter(Boolean);
  if (!lines.length) return null;
  const id = `mem_offline_chat_${String(replyMessage.id).replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  const memory = createMemory({
    id,
    userId,
    chatId,
    characterId,
    type: 'event',
    category: 'shared',
    content: `用户在线下见面期间仍收到你的消息，并在手机上回复了：\n${lines.join('\n')}`.slice(0, 1800),
    importance: 'normal',
    timestamp: Number(timestamp || Date.now()) || Date.now(),
    source: 'offline_chat_continuity',
  });
  memory.offlineContinuity = true;
  memory.sourceMessageIds = [
    ...(Array.isArray(incomingMessages) ? incomingMessages : []).map((message) => message?.id),
    replyMessage.id,
    ...(Array.isArray(counterpartMessages) ? counterpartMessages : []).map((message) => message?.id),
  ].filter(Boolean).map(String);
  await saveMemory(memory);
  return memory;
}

/** 同行角色代答文案：单 user 消息生成（AGENTS 兼容写法），失败回退固定文案。 */
export async function generateProxyReplyText({ user, session, proxyCharacter, senderName, incomingLines }) {
  const proxyName = getCharacterAiContextName(proxyCharacter) || proxyCharacter?.name || 'TA';
  const userName = getUserDisplayName(user) || '用户';
  const scene = session?.scene || {};
  const prompt = [
    '你在写一段「替人拿手机回消息」的真实小情节。',
    `背景：${userName} 正在和 ${proxyName} 线下见面${scene.place ? `（在${scene.place}）` : ''}${scene.goal ? `，两人正在${scene.goal}` : ''}。${userName} 这会儿不方便看手机，${proxyName} 顺手拿过 ${userName} 的手机，替 TA 回一下刚弹进来的消息。`,
    `来消息的人：${senderName}（这是 ${senderName} 和 ${userName} 的私聊窗口）。`,
    '刚收到的消息：',
    ...incomingLines,
    proxyCharacter?.promptCorpus ? `${proxyName} 的完整角色设定：${String(proxyCharacter.promptCorpus)}` : '',
    proxyCharacter?.personality ? `${proxyName} 的性格：${String(proxyCharacter.personality)}` : '',
    proxyCharacter?.speechStyle ? `${proxyName} 的说话风格：${String(proxyCharacter.speechStyle)}` : '',
    proxyCharacter?.speechCorpus ? `${proxyName} 的完整语料：${String(proxyCharacter.speechCorpus)}` : '',
    proxyCharacter?.userRelationStatus ? `${proxyName} 与用户的关系：${String(proxyCharacter.userRelationStatus)}` : '',
    '任务：以 ${PROXY} 的口吻，用这部手机回一条短消息（不超过 40 字）。'.replace('${PROXY}', proxyName),
    '要求：',
    `- 不表明自己是谁，也不提「自动回复/系统」；但措辞、称呼、语气都按 ${proxyName} 本人的说话习惯来——留一点能被熟人察觉的破绽是自然的。`,
    `- 内容大意是替 ${userName} 挡一下：TA 现在不方便，晚点回。可以带 ${proxyName} 自己的口癖或态度。`,
    '- 只输出这条消息的正文，不要引号，不要解释，不要旁白。',
  ].filter(Boolean).join('\n');
  const raw = await chatWithEmptyFallback(apiChat, [
    { role: 'system', content: prompt },
    { role: 'user', content: '请以同行角色的本人口吻生成这条短回复。' },
  ], {
    temperature: 0.85,
    maxTokens: await resolveGenerationMaxTokens(),
  }).catch(() => '');
  const text = String(raw || '').replace(/^["'「『]+|["'」』]+$/g, '').replace(/\s+/g, ' ').trim();
  if (!text || text.length > 80) return '';
  return text;
}

/** 用户主动掏手机聊天后，同行者注意到并温和接过手机续上一句。 */
export async function generateCaughtReplyText({ user, session, proxyCharacter, senderName, recentLines = [] }) {
  const proxyName = getCharacterAiContextName(proxyCharacter) || proxyCharacter?.name || 'TA';
  const userName = getUserDisplayName(user) || '用户';
  const prompt = [
    '你在写一次真实聊天里的短暂手机接手。',
    `${userName} 正在线下和 ${proxyName} 待在一起，却中途拿手机和 ${senderName} 聊了一会儿。${proxyName} 注意到了，顺手、自然地把手机接过去，在这个聊天窗口替 ${userName} 补发一句。`,
    '最近几条聊天：',
    ...(recentLines || []).slice(-8),
    proxyCharacter?.promptCorpus ? `${proxyName} 的完整角色设定：${String(proxyCharacter.promptCorpus)}` : '',
    proxyCharacter?.personality ? `${proxyName} 的性格：${String(proxyCharacter.personality)}` : '',
    proxyCharacter?.speechStyle ? `${proxyName} 的说话风格：${String(proxyCharacter.speechStyle)}` : '',
    proxyCharacter?.speechCorpus ? `${proxyName} 的完整语料：${String(proxyCharacter.speechCorpus)}` : '',
    proxyCharacter?.userRelationStatus ? `${proxyName} 与用户的关系：${String(proxyCharacter.userRelationStatus)}` : '',
    `只输出 ${proxyName} 借 ${userName} 的手机发出的那条短消息，不超过 40 字。`,
    '不要写旁白、引号、解释或系统提示；不要使用“抢手机”。语气和边界按人物性格来，可以温柔提醒、带点介意、调侃或自然宣示自己在旁边，但不要无缘无故敌对。',
    `不必明说自己是谁，但可以留下让 ${senderName} 察觉这不像 ${userName} 本人口吻的破绽。`,
  ].filter(Boolean).join('\n');
  const raw = await chatWithEmptyFallback(apiChat, [
    { role: 'system', content: prompt },
    { role: 'user', content: '请以同行角色的本人口吻生成借手机发出的这条短消息。' },
  ], {
    temperature: 0.85,
    maxTokens: await resolveGenerationMaxTokens(),
  }).catch(() => '');
  const text = String(raw || '').replace(/^["'「『]+|["'」』]+$/g, '').replace(/\s+/g, ' ').trim();
  return text && text.length <= 80 ? text : '';
}

/**
 * 抢手机演出专用：同一次请求同时生成「同行者代发」和「对方读到后的回复」。
 * 只有完整 JSON 且两侧都有正文时才接受，避免把流式截断的半句话拿去发送。
 */
export function parsePhoneCinematicExchange(raw = '') {
  const text = String(raw || '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    const replyText = String(parsed?.replyText || '').replace(/\s+/g, ' ').trim();
    const counterpartReplies = (Array.isArray(parsed?.counterpartReplies) ? parsed.counterpartReplies : [])
      .map((item) => String(item || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .slice(0, 2);
    if (!replyText || replyText.length > 80 || !counterpartReplies.length) return null;
    if (counterpartReplies.some((item) => item.length > 100)) return null;
    const joinIntent = ['none', 'ask_join', 'coming'].includes(String(parsed?.joinIntent || ''))
      ? String(parsed.joinIntent)
      : 'none';
    const joinMessage = String(parsed?.joinMessage || '').replace(/\s+/g, ' ').trim().slice(0, 100);
    return {
      replyText,
      counterpartReplies,
      joinIntent,
      joinMessage: joinIntent === 'none' ? '' : (joinMessage || counterpartReplies[counterpartReplies.length - 1]),
    };
  } catch {
    return null;
  }
}

export async function generatePhoneCinematicExchange({
  user,
  session,
  proxyCharacter,
  senderCharacter = null,
  senderName,
  recentLines = [],
  channel = 'incomingTakeover',
  storyContext = '',
  signal = null,
} = {}) {
  const proxyName = getCharacterAiContextName(proxyCharacter) || proxyCharacter?.name || 'TA';
  const userName = getUserDisplayName(user) || '用户';
  const scene = session?.scene || {};
  const caught = channel === 'sideTripCaught';
  const storyTakeover = channel === 'storyTakeover';
  const prompt = [
    '你要一次性写完一段手机消息小回合。不要分两次生成。',
    `${userName} 正在线下和 ${proxyName} 待在一起${scene.place ? `（在${scene.place}）` : ''}。`,
    storyTakeover
      ? `${proxyName} 已经在本轮线下剧情里明确接过了 ${userName} 的手机，准备在 ${senderName} 的聊天窗口替 ${userName} 实际回复。`
      : caught
      ? `${userName} 中途拿手机和 ${senderName} 聊了一会儿，${proxyName} 注意到后自然地接过手机，替 ${userName} 补发一句。`
      : `${senderName} 刚给 ${userName} 发来消息，${proxyName} 顺手接过 ${userName} 的手机代回。`,
    storyTakeover && storyContext
      ? `刚刚已经发生的线下剧情：${String(storyContext).replace(/\s+/g, ' ').trim().slice(-500)}`
      : '',
    '最近聊天：',
    ...(recentLines || []).slice(-8),
    proxyCharacter?.promptCorpus ? `${proxyName} 的完整角色设定：${String(proxyCharacter.promptCorpus)}` : '',
    proxyCharacter?.personality ? `${proxyName} 的性格：${String(proxyCharacter.personality)}` : '',
    proxyCharacter?.speechStyle ? `${proxyName} 的说话风格：${String(proxyCharacter.speechStyle)}` : '',
    proxyCharacter?.speechCorpus ? `${proxyName} 的完整语料：${String(proxyCharacter.speechCorpus)}` : '',
    proxyCharacter?.userRelationStatus ? `${proxyName} 与用户的关系：${String(proxyCharacter.userRelationStatus)}` : '',
    senderCharacter?.promptCorpus ? `${senderName} 的完整角色设定：${String(senderCharacter.promptCorpus)}` : '',
    senderCharacter?.personality ? `${senderName} 的性格：${String(senderCharacter.personality)}` : '',
    senderCharacter?.speechStyle ? `${senderName} 的说话风格：${String(senderCharacter.speechStyle)}` : '',
    senderCharacter?.speechCorpus ? `${senderName} 的完整语料：${String(senderCharacter.speechCorpus)}` : '',
    senderCharacter?.userRelationStatus ? `${senderName} 与用户的关系：${String(senderCharacter.userRelationStatus)}` : '',
    `先写 ${proxyName} 借手机发出的短消息，再写 ${senderName} 看到这条消息后的自然回复。`,
    `${proxyName} 不必明说身份，但语气可以留下破绽；${senderName} 只能根据消息原文与既有聊天判断，不能全知。如果察觉口吻不对，要先怀疑、试探或点破，不能凭空准确报出是谁。`,
    `${senderName} 可以不提加入现场；若性格与上下文自然，也可以试探能否一起去（ask_join），或明确说自己想过去/正在过来（coming）。这只是聊天里的意图，不能擅自视为已经到场。`,
    '两侧都必须是完整句子。代发不超过 40 字；对方回复 1—2 条，每条不超过 50 字。',
    '只输出严格 JSON，不要 Markdown、旁白或解释：',
    '{"replyText":"同行者代发的完整消息","counterpartReplies":["对方的第一条完整回复","可选的第二条回复"],"joinIntent":"none|ask_join|coming","joinMessage":"若想加入，摘录一句自然意图；否则空字符串"}',
  ].filter(Boolean).join('\n');
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(signal?.reason || 'phone-cinematic-cancelled');
  if (signal?.aborted) abortFromCaller();
  else signal?.addEventListener?.('abort', abortFromCaller, { once: true });
  const timeout = setTimeout(() => controller.abort('phone-cinematic-timeout'), OFFLINE_PHONE_CINEMATIC_TIMEOUT_MS);
  try {
    const raw = await chatWithEmptyFallback(apiChat, [
      { role: 'system', content: prompt },
      { role: 'user', content: '请按上述两位角色与聊天历史生成本次借手机交换 JSON。' },
    ], {
      temperature: 0.85,
      maxTokens: await resolveGenerationMaxTokens(),
      signal: controller.signal,
    }).catch(() => '');
    return parsePhoneCinematicExchange(raw);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener?.('abort', abortFromCaller);
  }
}

/**
 * 线下 AI 正文已明确演到“现场角色接走用户手机并代回”时，复用既有 Chat 演出。
 * takeovers 只来自隐藏结构化动作块；这里不扫描正文关键词，避免否定句和假动作误触发。
 */
export async function maybeRunOfflineStoryPhoneTakeover({
  user,
  session,
  offlineChat = null,
  beat = null,
  signal = null,
} = {}) {
  if (!user?.id || !session?.id || !beat?.id || session.status !== 'active') {
    return { handled: false, reason: 'missing-context' };
  }
  const committedBeat = (session.beats || []).find((row) => row?.id === beat.id) || beat;
  const takeover = committedBeat?.phoneTakeover;
  if (!takeover || takeover.status !== 'pending') {
    return { handled: false, reason: takeover?.status || 'no-directive' };
  }
  const runKey = `${session.id}:${beat.id}`;
  if (storyTakeoverRuns.has(runKey)) return { handled: false, reason: 'already-running' };
  storyTakeoverRuns.add(runKey);
  const mark = async (patch = {}) => {
    committedBeat.phoneTakeover = { ...takeover, ...committedBeat.phoneTakeover, ...patch };
    await saveOfflineSession(session).catch(() => {});
  };
  try {
    const globalSettings = await loadOfflineAutoReplySettings(user.id);
    const config = resolveOfflineAutoReplyConfig(session, globalSettings);
    if (config.mode !== 'companion' || config.incomingTakeover?.enabled !== true) {
      await mark({ status: 'skipped', reason: 'takeover-disabled', finishedAt: Date.now() });
      return { handled: false, reason: 'takeover-disabled' };
    }
    if (!isOfflinePhoneCinematicForeground(session.chatId)) {
      await mark({ status: 'skipped', reason: 'not-foreground', finishedAt: Date.now() });
      return { handled: false, reason: 'not-foreground' };
    }
    const activeIds = getActiveOfflineParticipantIds(session, offlineChat);
    const proxyId = String(takeover.proxyCharacterId || '').trim();
    const targetId = String(takeover.targetCharacterId || '').trim();
    if (!activeIds.includes(proxyId) || !targetId || activeIds.includes(targetId)) {
      await mark({ status: 'skipped', reason: 'invalid-actors', finishedAt: Date.now() });
      return { handled: false, reason: 'invalid-actors' };
    }
    const configuredProxyId = String(config.proxyCharacterId || '').trim();
    const expectedProxyId = activeIds.includes(configuredProxyId) ? configuredProxyId : (activeIds[0] || '');
    if (!expectedProxyId || proxyId !== expectedProxyId) {
      await mark({ status: 'skipped', reason: 'proxy-mismatch', finishedAt: Date.now() });
      return { handled: false, reason: 'proxy-mismatch' };
    }
    const targetChats = await listChatsForUser(user.id).catch(() => []);
    const targetChat = targetChats.find((row) => row?.type !== 'group'
      && (row.participants || []).includes('user')
      && (row.participants || []).includes(targetId));
    const [proxyCharacter, targetCharacter] = await Promise.all([
      getCharacter(proxyId, { userId: user.id }).catch(() => null),
      getCharacter(targetId, { userId: user.id }).catch(() => null),
    ]);
    if (!targetChat?.id || !proxyCharacter || !targetCharacter) {
      await mark({ status: 'skipped', reason: 'target-chat-unavailable', finishedAt: Date.now() });
      return { handled: false, reason: 'target-chat-unavailable' };
    }
    const recent = (await listMessagesForChat(targetChat.id).catch(() => []))
      .filter((message) => message && !message.deleted && !message.recalled)
      .slice(-8);
    const senderName = targetCharacter.customNickname || targetCharacter.name || '对方';
    const recentLines = recent.map((message) => {
      const who = message.senderId === 'user'
        ? (getUserDisplayName(user) || '用户')
        : (message.senderName || senderName);
      return `${who}：${String(message.content || '').replace(/\s+/g, ' ').slice(0, 120)}`;
    });
    const exchange = await generatePhoneCinematicExchange({
      user,
      session,
      proxyCharacter,
      senderCharacter: targetCharacter,
      senderName,
      recentLines,
      channel: 'storyTakeover',
      storyContext: committedBeat.text,
      signal,
    });
    if (signal?.aborted) {
      await mark({ status: 'skipped', reason: 'cancelled', finishedAt: Date.now() });
      return { handled: false, reason: 'cancelled' };
    }
    if (!exchange) {
      await mark({ status: 'failed', reason: 'exchange-incomplete', finishedAt: Date.now() });
      return { handled: false, reason: 'exchange-incomplete' };
    }
    const proxyName = proxyCharacter.customNickname || proxyCharacter.name || 'TA';
    const joinIntent = activeIds.includes(targetId) ? 'none' : exchange.joinIntent;
    const job = await createOfflinePhoneCinematicJob({
      channel: 'storyTakeover',
      userId: user.id,
      offlineChatId: session.chatId,
      targetChatId: targetChat.id,
      senderCharacterId: targetId,
      senderName,
      proxyCharacterId: proxyId,
      proxyName,
      replyText: exchange.replyText,
      counterpartReplies: exchange.counterpartReplies,
      joinIntent,
      joinMessage: joinIntent === 'none' ? '' : exchange.joinMessage,
      // recentLines 只给生成器理解原聊天语境；时间线只记录这次新代发与新回复，
      // 不能把历史八条消息再次折成“刚发生”的手机插曲。
      incomingCount: 0,
      incomingMessageIds: [],
      incomingLines: [],
      sourceBeatId: beat.id,
    });
    if (joinIntent !== 'none') {
      await inviteOfflineParticipant({
        session,
        chat: offlineChat,
        characterId: targetId,
        source: 'phone_join_intent',
        text: `${senderName}在消息里提到想来现场，等你决定。`,
      });
    }
    await mark({ status: 'queued', jobId: job.id, queuedAt: Date.now() });
    announceOfflinePhoneCinematic(job);
    return { handled: true, jobId: job.id };
  } catch (error) {
    await mark({
      status: 'failed',
      reason: String(error?.message || error || 'unknown').slice(0, 160),
      finishedAt: Date.now(),
    });
    return { handled: false, reason: 'failed', error };
  } finally {
    storyTakeoverRuns.delete(runKey);
  }
}

/** 对方同轮反应的场景指令：只给可感知线索，不做全知注入。 */
export function counterpartDirective({ mode, userName, proxyHinted }) {
  const common = [
    '[后台小回合 · 对方读到回复后的反应]',
    `你刚给 ${userName} 发了消息，紧接着收到了上面那条回复。请自然接着回一轮。`,
    '你只能依据这条回复的原文和你们既有的聊天上下文判断发生了什么，不要引用任何对方没说出口的信息。',
  ];
  if (mode === 'companion' && proxyHinted) {
    common.push(
      '注意：这条回复读起来可能不太像 TA 本人的口吻。如果你察觉到不对劲，走一个自然的反应过程——先觉得哪里怪，再怀疑是不是别人替 TA 回的，可以试探、追问或点破；但你并不确定真相，禁止全知式秒懂或直接报出对方是谁，除非破绽实在太明显。',
    );
  } else {
    common.push(
      '这条回复看起来像是一条匆忙的简短回执。你可以按自己的性格接受、调侃、追问或表达情绪；如果对方透露了在做什么，才可以顺着问。',
    );
  }
  common.push('照常输出棉花糖协议消息，按人物与【回复节奏 · 错落】自然组织，不另设缩短要求。');
  return common.join('\n');
}

/**
 * 主入口：某角色刚给用户发了主动消息，而用户正在别处线下。
 * 依设置补一条 user 侧自动回复 + 对方同轮反应，并折成线下「手机插曲」。
 */
export async function maybeRunOfflineAutoReply({
  user,
  chat,
  characterId,
  incomingMessages = [],
  activeOffline = null,
} = {}) {
  if (!user?.id || !chat?.id || !characterId) return { handled: false, reason: 'missing-args' };
  const offline = activeOffline;
  if (!offline?.session || offline.session.status !== 'active') return { handled: false, reason: 'no-active-offline' };
  // 约会对象本人的消息不该走到这里（日程主动已被暂停），保险起见再挡一次
  const offlineParticipants = getActiveOfflineParticipantIds(offline.session, offline.chat);
  if (offlineParticipants.includes(String(characterId))) return { handled: false, reason: 'sender-in-offline' };

  const globalSettings = await loadOfflineAutoReplySettings(user.id);
  const config = resolveOfflineAutoReplyConfig(offline.session, globalSettings);
  if (config.mode === 'off') return { handled: false, reason: 'mode-off' };

  const sender = await getCharacter(characterId, { userId: user.id }).catch(() => null);
  const senderName = (sender && (sender.customNickname || sender.name)) || 'TA';
  const userName = getUserDisplayName(user) || '你';
  const incomingLines = (Array.isArray(incomingMessages) ? incomingMessages : [])
    .map((m) => msgLine(m, senderName)).filter(Boolean).slice(0, 6);

  // ---- user 侧自动回复 ----
  let replyText = '';
  let proxyCharacter = null;
  let mode = config.mode;
  if (mode === 'companion') {
    const configuredProxyId = String(config.proxyCharacterId || '');
    const proxyId = offlineParticipants.includes(configuredProxyId) ? configuredProxyId : (offlineParticipants[0] || '');
    proxyCharacter = proxyId
      ? await getCharacter(proxyId, { userId: user.id }).catch(() => null)
      : null;
    if (proxyCharacter) {
      const proxyName = (proxyCharacter.customNickname || proxyCharacter.name) || 'TA';
      const takeover = config.incomingTakeover || {};
      if (takeover.enabled && isOfflinePhoneCinematicForeground(offline.session.chatId)) {
        const roll = await rollOfflinePhoneCinematic({
          userId: user.id,
          offlineChatId: offline.session.chatId,
          channel: 'incomingTakeover',
          frequency: takeover.frequency,
        });
        if (roll.hit) {
          const exchange = await generatePhoneCinematicExchange({
            user,
            session: offline.session,
            proxyCharacter,
            senderCharacter: sender,
            senderName,
            recentLines: incomingLines,
            channel: 'incomingTakeover',
          });
          if (!exchange) return { handled: false, reason: 'cinematic-generation-incomplete' };
          const job = await createOfflinePhoneCinematicJob({
            channel: 'incomingTakeover',
            userId: user.id,
            offlineChatId: offline.session.chatId,
            targetChatId: chat.id,
            senderCharacterId: characterId,
            senderName,
            proxyCharacterId: proxyCharacter.id,
            proxyName,
            replyText: exchange.replyText,
            counterpartReplies: exchange.counterpartReplies,
            joinIntent: exchange.joinIntent,
            joinMessage: exchange.joinMessage,
            incomingCount: incomingLines.length,
            incomingMessageIds: (incomingMessages || []).map((m) => m?.id).filter(Boolean),
            incomingLines,
          });
          if (exchange.joinIntent !== 'none') {
            await inviteOfflineParticipant({
              session: offline.session,
              chat: offline.chat,
              characterId,
              source: 'phone_join_intent',
              text: `${senderName}在消息里提到想来现场，等你决定。`,
            });
          }
          announceOfflinePhoneCinematic(job);
          return { handled: true, mode, cinematic: true, jobId: job.id };
        }
      }
      replyText = await generateProxyReplyText({
        user,
        session: offline.session,
        proxyCharacter,
        senderName,
        incomingLines,
      });
    }
    if (!replyText) {
      // 代答生成失败：降级为固定文案，不让整个回合卡死
      mode = 'fixed';
      proxyCharacter = null;
    }
  }
  if (mode === 'fixed') {
    replyText = config.fixedText || DEFAULT_OFFLINE_AUTO_REPLY_TEXT;
  }
  if (!replyText) return { handled: false, reason: 'empty-reply' };

  const proxyName = proxyCharacter ? ((proxyCharacter.customNickname || proxyCharacter.name) || 'TA') : '';

  const worldNow = await getNowForUser(user.id).catch(() => Date.now());
  const lastIncomingTs = (Array.isArray(incomingMessages) ? incomingMessages : [])
    .reduce((mx, m) => Math.max(mx, Number(m?.timestamp || 0)), 0);
  const replyTs = Math.max(worldNow, lastIncomingTs + 1200);
  const replyMsg = createMessage({
    chatId: chat.id,
    senderId: 'user',
    senderName: userName,
    type: 'text',
    content: replyText,
    timestamp: replyTs,
    metadata: {
      offlineAutoReply: true,
      autoReplyMode: mode,
      ...(proxyCharacter ? {
        proxyCharacterId: proxyCharacter.id || '',
        proxyCharacterName: proxyName,
        autoReplyLabel: `由${proxyName}代回`,
      } : { autoReplyLabel: '赴约自动回复' }),
      offlineSessionChatId: offline.session.chatId || '',
    },
  });
  await saveMessage(replyMsg);
  await updateChatPreview(chat.id, previewFromMessage(replyMsg), replyMsg.timestamp).catch(() => {});

  // ---- 对方同轮反应 ----
  let counterpart = null;
  try {
    const { runHeadlessChatReply } = await import('./chat/headless-reply.js');
    counterpart = await runHeadlessChatReply(chat, user, {
      allowInactive: true,
      skipBusyAutoReply: true,
      sceneDirective: counterpartDirective({
        mode,
        userName,
        proxyHinted: !!proxyCharacter,
      }),
    });
  } catch (err) {
    console.warn('[offline-auto-reply] counterpart round failed', err);
  }
  if (counterpart?.ok) {
    const { bumpPersistedMessagesUnread } = await import('./native-notifications.js');
    await bumpPersistedMessagesUnread(chat.id, counterpart.messages).catch(() => {});
  }

  await syncOfflineChatContinuityMemory({
    user,
    chat,
    senderCharacterId: characterId,
    incomingMessages,
    replyMessage: replyMsg,
    counterpartMessages: counterpart?.messages || [],
    timestamp: worldNow,
  }).catch((err) => console.warn('[offline-auto-reply] continuity memory failed', err));

  // ---- 折成线下「手机插曲」beat（会话可能已被收纳，重新加载） ----
  try {
    const liveSession = await loadOfflineSession(offline.session.chatId).catch(() => null);
    if (liveSession && liveSession.status === 'active') {
      const lines = [...incomingLines];
      lines.push(msgLine(replyMsg, proxyCharacter ? `${proxyName}（拿着你的手机代回）` : '你的自动回复'));
      for (const m of (counterpart?.messages || []).slice(0, 4)) {
        const line = msgLine(m, senderName);
        if (line) lines.push(line);
      }
      const counterpartMessages = counterpart?.messages || [];
      liveSession.beats.push(buildOfflineInterludeBeat({
        id: genBeatId(),
        kind: 'proactive_takeover',
        chatId: chat.id,
        chatLabel: senderName,
        incomingCount: incomingLines.length,
        outgoingCount: 1,
        counterpartCount: counterpartMessages.length,
        mode,
        proxyCharacterId: proxyCharacter?.id || '',
        proxyName,
        messageIds: [
          ...(incomingMessages || []).map((m) => m?.id),
          replyMsg.id,
          ...counterpartMessages.map((m) => m?.id),
        ],
        title: `${senderName}发来 ${incomingLines.length || 1} 条消息`,
        detail: proxyCharacter
          ? `${proxyName}已代回${counterpartMessages.length ? ` · 对方又回复 ${counterpartMessages.length} 条` : ''}`
          : `已自动回复${counterpartMessages.length ? ` · 对方又回复 ${counterpartMessages.length} 条` : ''}`,
        text: `手机在这期间响了——「${senderName}」发来消息：\n${lines.join('\n')}`,
        ts: worldNow,
      }));
      await saveOfflineSession(liveSession);
    }
  } catch (err) {
    console.warn('[offline-auto-reply] fold interlude failed', err);
  }

  return {
    handled: true,
    mode,
    replyMessage: replyMsg,
    counterpartOk: !!counterpart?.ok,
  };
}

async function appendOfflineInterludeBeat(offlineChatId, text, ts) {
  const liveSession = await loadOfflineSession(offlineChatId).catch(() => null);
  if (!liveSession || liveSession.status !== 'active') return false;
  liveSession.beats.push({ id: genBeatId(), role: 'interlude', text, ts });
  await saveOfflineSession(liveSession);
  return true;
}

/** 生成一条 user 口吻的婉拒（不透露具体和谁在一起），失败回退固定文案。 */
async function generateInviteDeclineText({ user, senderName, inviteNote }) {
  const userName = getUserDisplayName(user) || '我';
  const prompt = [
    '写一条婉拒线下邀约的聊天消息。',
    `背景：${senderName} 刚约 ${userName} 线下见面${inviteNote ? `（邀约原话：${inviteNote.slice(0, 80)}）` : ''}，但 ${userName} 此刻正在外面有安排，去不了。`,
    `任务：以 ${userName} 的第一人称口吻回一条婉拒消息（不超过 40 字）。`,
    '要求：语气自然、带歉意但不卑微，可以提议改天；不透露此刻具体在哪、和谁在一起；只输出消息正文，不要引号和解释。',
  ].join('\n');
  const raw = await chatWithEmptyFallback(apiChat, [
    { role: 'system', content: prompt },
    { role: 'user', content: '请生成这条自然的婉拒消息。' },
  ], {
    temperature: 0.8,
    maxTokens: await resolveGenerationMaxTokens(),
  }).catch(() => '');
  const text = String(raw || '').replace(/^["'「『]+|["'」』]+$/g, '').replace(/\s+/g, ' ').trim();
  if (!text || text.length > 60) return '这次不巧，我在外面有安排，改天一定。';
  return text;
}

/**
 * 邀约撞车 · 婉拒：user 正在别处线下时收到别的角色邀约。
 * 生成一条合宜的婉拒落进那个聊天，卡片置为已婉拒，对方同轮自然反应（经普通记忆链路记住这次拒绝）。
 */
export async function declineInviteDueToOffline({ user, chat, inviteMessage, activeOffline }) {
  if (!user?.id || !chat?.id || !inviteMessage) throw new Error('缺少婉拒所需的上下文');
  const senderId = String(inviteMessage.metadata?.initiatorId || inviteMessage.senderId || '').trim();
  const sender = senderId
    ? await getCharacter(senderId, { userId: user.id }).catch(() => null)
    : null;
  const senderName = (sender && (sender.customNickname || sender.name)) || inviteMessage.senderName || 'TA';
  const declineText = await generateInviteDeclineText({
    user,
    senderName,
    inviteNote: String(inviteMessage.metadata?.note || inviteMessage.content || '').trim(),
  });

  const worldNow = await getNowForUser(user.id).catch(() => Date.now());
  const replyMsg = createMessage({
    chatId: chat.id,
    senderId: 'user',
    senderName: getUserDisplayName(user) || '我',
    type: 'text',
    content: declineText,
    timestamp: worldNow,
    metadata: { offlineInviteDecline: true, inviteMessageId: String(inviteMessage.id || '') },
  });
  await saveMessage(replyMsg);
  await updateChatPreview(chat.id, previewFromMessage(replyMsg), replyMsg.timestamp).catch(() => {});

  inviteMessage.metadata = {
    ...(inviteMessage.metadata || {}),
    status: 'declined',
    declineReason: declineText.slice(0, 60),
  };
  await saveMessage(inviteMessage);

  let counterpart = null;
  try {
    const { runHeadlessChatReply } = await import('./chat/headless-reply.js');
    counterpart = await runHeadlessChatReply(chat, user, {
      allowInactive: true,
      skipBusyAutoReply: true,
      sceneDirective: [
        '[后台小回合 · 邀约被婉拒后的反应]',
        '你刚发出的线下邀约被对方婉拒了（见上一条消息）。请自然接一轮：可以体面地表示理解、约改天，或按你的性格流露一点情绪。',
        '把这次拒绝的语境记在心里，近期不要再重复发起同样的邀约，也不要追问对方到底在忙什么。',
        '照常输出棉花糖协议消息，按人物与【回复节奏 · 错落】自然组织，不另设缩短要求。',
      ].join('\n'),
    });
  } catch (err) {
    console.warn('[offline-auto-reply] decline counterpart failed', err);
  }
  if (counterpart?.ok) {
    const { bumpPersistedMessagesUnread } = await import('./native-notifications.js');
    await bumpPersistedMessagesUnread(chat.id, counterpart.messages).catch(() => {});
  }

  if (activeOffline?.session?.chatId) {
    await appendOfflineInterludeBeat(
      activeOffline.session.chatId,
      `手机响了一下——「${senderName}」约你线下，你在现场婉拒了：\n你：${declineText}`,
      worldNow,
    ).catch(() => {});
  }
  return { ok: true, declineText };
}

/**
 * 邀约撞车 · 并入：把发出邀约的角色引进当前进行中的线下（多人线下）。
 * 更新线下 chat 的参与者，卡片置为 merged，并给线下时间线一条插曲让后续推进知道 TA 要来汇合。
 */
export async function mergeInviteIntoOffline({ user, inviteMessage, activeOffline }) {
  if (!user?.id || !inviteMessage || !activeOffline?.session?.chatId) throw new Error('缺少并入所需的上下文');
  const senderId = String(inviteMessage.metadata?.initiatorId || inviteMessage.senderId || '').trim();
  if (!senderId) throw new Error('找不到发出邀约的角色');
  const sender = await getCharacter(senderId, { userId: user.id }).catch(() => null);
  const senderName = (sender && (sender.customNickname || sender.name)) || inviteMessage.senderName || 'TA';
  const offlineChatId = activeOffline.session.chatId;

  const offlineChat = await getChat(offlineChatId).catch(() => null);

  inviteMessage.metadata = {
    ...(inviteMessage.metadata || {}),
    status: 'merged',
    mergedOfflineChatId: offlineChatId,
  };
  await saveMessage(inviteMessage);

  const liveSession = await loadOfflineSession(offlineChatId);
  await joinOfflineParticipant({
    session: liveSession,
    chat: offlineChat,
    characterId: senderId,
    source: 'invite_collision_merge',
    text: `「${senderName}」本来在线上约你去别处，你把 TA 叫来现场汇合了。`,
  });

  return { ok: true, senderId, senderName, offlineChatId };
}
