import * as db from './db.js';
import { chatForTask } from './api.js';
import { buildTimeAndHolidayPromptBlock, getNowForUser } from './time-mode.js';
import { createMemory } from '../models/memory.js';
import { saveMemory } from './chat-store.js';
import { persistEventMemoriesFromRaw, stripMemoryBlocks } from './memory/event-memory.js';
import { stripMemoryFactBlocks, persistMemoryFactsFromRaw } from './memory/memory-facts.js';
import { isAnonymousChat, isPeerPrivateChat } from './chat-helpers.js';
import {
  buildAnonymousPrivateContextPrompt,
  getAnonymousDisplayProfile,
  getAnonymousMemoryMode,
  replaceTextWithAnonymousIds,
} from './anonymous-chat.js';
import { filterNonGuidanceMessages } from './guidance-memory.js';
import { recordAcquaintance } from './acquaintance-ledger.js';
import { principalKey } from './alias-account-model.js';
import { isStrangerInterceptChat } from './stranger-thread-model.js';
import { loadCharacterProgressResetState } from './character-progress-reset-state.js';
import { loadChatMemoryResetToken } from './memory/chat-memory-reset-state.js';
import { formatChatMentionContext } from './chat/mentions.js';

const SUMMARY_IN_FLIGHT = new Set();
const SUMMARY_IDLE_WAITERS = new Map();
const MANUAL_SUMMARY_WAIT_TIMEOUT_MS = 120000;
const SUMMARY_STORAGE_LEASE_MS = 15 * 60 * 1000;
const SUMMARY_MESSAGE_TEXT_CHAR_LIMIT = 800;
const SUMMARY_TEXT_BLOCK_CHAR_LIMIT = 60000;
const SUMMARY_SUPPRESSION_VERSION = 2;
const SUMMARY_LEASE_OWNER = globalThis.crypto?.randomUUID?.()
  || `summary-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

function resolveSummaryActorLabel(chat, actorId = '', resolvedName = '', fallbackName = '') {
  const id = String(actorId || '').trim();
  const groupCard = chat?.type === 'group' && !isAnonymousChat(chat)
    ? String(chat.groupSettings?.memberCards?.[id] || '').trim()
    : '';
  if (chat?.type === 'group' && !isAnonymousChat(chat)) {
    return groupCard
      || String(resolvedName || '').trim()
      || String(fallbackName || '').trim()
      || id;
  }
  return String(fallbackName || '').trim()
    || String(resolvedName || '').trim()
    || id;
}

function compactMessageWithMentionContext(message, chat, currentUserName = '用户') {
  const body = compactMessageContentForSummary(message);
  const mentionContext = formatChatMentionContext(message, {
    memberCards: chat?.type === 'group' ? (chat.groupSettings?.memberCards || {}) : {},
    currentUserName,
  });
  return mentionContext ? `${body}\n${mentionContext}` : body;
}

function summaryTaskKey(userId = '', chatId = '') {
  return `${String(userId || '').trim()}:${String(chatId || '').trim()}`;
}

async function loadSummaryResetTokens(chat, userId) {
  const actorIds = [...new Set((Array.isArray(chat?.participants) ? chat.participants : [])
    .map((id) => String(id || '').trim())
    .filter((id) => id && id !== 'user'))];
  const entries = await Promise.all(actorIds.map(async (characterId) => {
    const state = await loadCharacterProgressResetState(userId, characterId).catch(() => null);
    return [characterId, String(state?.token || '')];
  }));
  entries.push(['__chat_memory__', await loadChatMemoryResetToken(chat?.id).catch(() => '')]);
  return Object.fromEntries(entries);
}

export function didSummaryResetTokensChange(before = {}, after = {}) {
  const actorIds = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  for (const actorId of actorIds) {
    if (String(before?.[actorId] || '') !== String(after?.[actorId] || '')) return true;
  }
  return false;
}

/**
 * 摘要请求返回时再次核对原消息。重 roll 不会改“清空记忆”代次，否则失败恢复会被
 * 当成跨实例写入拒绝；因此还必须直接确认这批原文仍在当前会话里。
 */
export async function areSummarySourceMessagesCurrent(chatId = '', messageIds = []) {
  const cid = String(chatId || '').trim();
  const ids = [...new Set((Array.isArray(messageIds) ? messageIds : [messageIds])
    .map((id) => String(id || '').trim())
    .filter(Boolean))];
  if (!cid || !ids.length) return false;
  const rows = await db.getMany('messages', ids).catch(() => []);
  const byId = new Map((Array.isArray(rows) ? rows : [])
    .filter(Boolean)
    .map((message) => [String(message.id || ''), message]));
  return ids.every((id) => {
    const message = byId.get(id);
    return message
      && String(message.chatId || '') === cid
      && !message.deleted
      && !message.recalled;
  });
}

function summaryBrowserLockName(userId = '', chatId = '') {
  return `marshmallow:chat-summary:${summaryTaskKey(userId, chatId)}`;
}

function summaryStorageLeaseKey(summaryKey = '') {
  return `marshmallow:chat-summary-lease:${String(summaryKey || '')}`;
}

// Android WebView / 部分 PWA 没有 navigator.locks；同源 localStorage 短租约在这些
// 多实例场景下补上页面内 Set 覆盖不到的互斥。写后读回 owner，避免两个页面同时抢锁。
function claimSummaryStorageLease(summaryKey = '') {
  const key = summaryStorageLeaseKey(summaryKey);
  const storage = globalThis.localStorage;
  if (!key || !storage) return { key: '', owner: '', acquired: true };
  try {
    const now = Date.now();
    const previous = JSON.parse(storage.getItem(key) || 'null') || {};
    if (previous.owner !== SUMMARY_LEASE_OWNER && Number(previous.expiresAt || 0) > now) {
      return { key, owner: '', acquired: false };
    }
    const lease = { owner: SUMMARY_LEASE_OWNER, expiresAt: now + SUMMARY_STORAGE_LEASE_MS };
    storage.setItem(key, JSON.stringify(lease));
    const verified = JSON.parse(storage.getItem(key) || 'null') || {};
    return {
      key,
      owner: SUMMARY_LEASE_OWNER,
      acquired: verified.owner === SUMMARY_LEASE_OWNER && Number(verified.expiresAt || 0) === lease.expiresAt,
    };
  } catch (_) {
    // 隐私模式禁用 localStorage 时仍由 Web Locks / 单页 Set 继续保护。
    return { key: '', owner: '', acquired: true };
  }
}

function releaseSummaryStorageLease(lease = null) {
  if (!lease?.key || !lease?.owner) return;
  try {
    const current = JSON.parse(globalThis.localStorage?.getItem(lease.key) || 'null') || {};
    if (current.owner === lease.owner) globalThis.localStorage?.removeItem(lease.key);
  } catch (_) {}
}

export function isChatSummaryInFlight({ chatId = '', userId = '' } = {}) {
  return SUMMARY_IN_FLIGHT.has(summaryTaskKey(userId, chatId));
}

function waitForSummaryIdle(summaryKey, timeoutMs = MANUAL_SUMMARY_WAIT_TIMEOUT_MS) {
  if (!SUMMARY_IN_FLIGHT.has(summaryKey)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const waiters = SUMMARY_IDLE_WAITERS.get(summaryKey) || new Set();
    let finished = false;
    const finish = (idle) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      waiters.delete(onIdle);
      if (!waiters.size) SUMMARY_IDLE_WAITERS.delete(summaryKey);
      resolve(idle);
    };
    const onIdle = () => finish(true);
    const timer = setTimeout(() => finish(false), Math.max(1000, Number(timeoutMs) || MANUAL_SUMMARY_WAIT_TIMEOUT_MS));
    waiters.add(onIdle);
    SUMMARY_IDLE_WAITERS.set(summaryKey, waiters);
  });
}

function releaseSummaryTask(summaryKey) {
  SUMMARY_IN_FLIGHT.delete(summaryKey);
  const waiters = SUMMARY_IDLE_WAITERS.get(summaryKey);
  SUMMARY_IDLE_WAITERS.delete(summaryKey);
  if (!waiters) return;
  for (const notify of waiters) notify();
}

export function resolveSummaryCursorTimestamp(worldNow, deltaEndTs) {
  const world = Math.max(0, Number(worldNow) || 0);
  const deltaEnd = Math.max(0, Number(deltaEndTs) || 0);
  return Math.max(world, deltaEnd + 1);
}

export function resolveSummaryRangeTimestamps(messages = [], fallbackTs = 0) {
  const rows = Array.isArray(messages) ? messages : [];
  const fallback = Math.max(0, Number(fallbackTs) || 0);
  const first = Math.max(0, Number(rows[0]?.timestamp) || 0);
  const last = Math.max(0, Number(rows[rows.length - 1]?.timestamp) || 0);
  return {
    fromTs: first || last || fallback,
    toTs: last || first || fallback,
  };
}

export function resolveChatSummarySettings(chat, prefs = {}) {
  const raw = prefs && typeof prefs === 'object' ? prefs : {};
  const phoneSideDefault = isPeerPrivateChat(chat)
    && String(chat?.metadata?.phoneChannel || '') !== 'intercept';
  return {
    ...raw,
    autoSummary: typeof raw.autoSummary === 'boolean' ? raw.autoSummary : phoneSideDefault,
    autoSummaryFreq: Math.min(
      2000,
      Math.max(10, Number(raw.autoSummaryFreq) || 100),
    ),
  };
}

export function resolveSummaryCoverage(sortedMessages = [], memories = [], userId = '') {
  const messageIds = new Set(sortedMessages.map((message) => String(message?.id || '')).filter(Boolean));
  const coveredIds = new Set();
  let legacyCoveredUntil = 0;
  const summaries = (Array.isArray(memories) ? memories : []).filter((memory) => (
    memory?.type === 'summary'
    && !memory.characterId
    && (!memory.userId || memory.userId === userId)
    // 旧版删除保护可能因两个宽泛主题词误杀整段摘要。让旧占位卡失去覆盖效力，
    // 下一次总结可以原位重试；新版严格判定产生的占位卡仍防止重复付费请求。
    && (!memory.summarySuppressed
      || Number(memory.summarySuppressionVersion || 0) >= SUMMARY_SUPPRESSION_VERSION)
  ));

  for (const summary of summaries) {
    if (Array.isArray(summary.summaryMessageIds)) {
      summary.summaryMessageIds.forEach((id) => {
        const normalized = String(id || '');
        if (messageIds.has(normalized)) coveredIds.add(normalized);
      });
      continue;
    }
    legacyCoveredUntil = Math.max(legacyCoveredUntil, Number(summary.timestamp || 0));
  }

  if (legacyCoveredUntil) {
    sortedMessages.forEach((message) => {
      if (Number(message?.timestamp || 0) <= legacyCoveredUntil) {
        const id = String(message?.id || '');
        if (id) coveredIds.add(id);
      }
    });
  }

  const firstUncoveredIndex = sortedMessages.findIndex((message) => !coveredIds.has(String(message?.id || '')));
  return {
    coveredIds,
    coveredCount: coveredIds.size,
    totalCount: sortedMessages.length,
    uncoveredCount: Math.max(0, sortedMessages.length - coveredIds.size),
    firstUncoveredIndex: firstUncoveredIndex < 0 ? 0 : firstUncoveredIndex + 1,
  };
}

async function loadSummaryRows(chatId, userId) {
  const [allMessages, allMems] = await Promise.all([
    db.getAllByIndex('messages', 'chatId', chatId),
    db.getAllByIndex('memories', 'chatId', chatId),
  ]);
  const sorted = filterNonGuidanceMessages([...allMessages]
    .filter((message) => !message.deleted && !message.recalled))
    .sort((left, right) => (left.timestamp || 0) - (right.timestamp || 0));
  return {
    sorted,
    allMems,
    coverage: resolveSummaryCoverage(sorted, allMems, userId),
  };
}

export async function getChatSummaryStatus({ chatId, userId } = {}) {
  if (!chatId || !userId) {
    return { coveredCount: 0, totalCount: 0, uncoveredCount: 0, firstUncoveredIndex: 0, memoryCount: 0 };
  }
  // 设定页只需要摘要覆盖范围，不需要消息正文。getAll() 会把整段聊天
  // （包括图片等大字段）一次性克隆到 JS 堆；用会话索引逐条投影为轻量记录。
  const [messageRows, allMems] = await Promise.all([
    db.getAllByIndexRange(
      'messages',
      'chatId',
      chatId,
      chatId,
      {
        mapRecord: (message) => ({
          id: message?.id,
          timestamp: message?.timestamp,
          senderId: message?.senderId,
          deleted: message?.deleted === true,
          recalled: message?.recalled === true,
          metadata: {
            guidanceMode: message?.metadata?.guidanceMode === true,
            guidanceReply: message?.metadata?.guidanceReply === true,
            aiRoundKind: message?.metadata?.aiRoundKind,
          },
        }),
      },
    ),
    db.getAllByIndex('memories', 'chatId', chatId),
  ]);
  const sorted = filterNonGuidanceMessages((messageRows || []).filter((message) => (
    !message.deleted && !message.recalled
  ))).sort((left, right) => Number(left?.timestamp || 0) - Number(right?.timestamp || 0));
  const coverage = resolveSummaryCoverage(sorted, allMems, userId);
  return {
    coveredCount: coverage.coveredCount,
    totalCount: coverage.totalCount,
    uncoveredCount: coverage.uncoveredCount,
    firstUncoveredIndex: coverage.firstUncoveredIndex,
    memoryCount: (allMems || []).filter((memory) => (
      memory && (!memory.userId || memory.userId === userId)
    )).length,
  };
}

function clampSummaryText(value = '', limit = SUMMARY_MESSAGE_TEXT_CHAR_LIMIT) {
  const raw = String(value || '')
    .replace(/data:[^;\s]+;base64,[A-Za-z0-9+/=]+/g, '[媒体数据已省略]')
    .replace(/blob:[^\s]+/g, '[临时媒体链接已省略]')
    .replace(/https?:\/\/[^\s]{500,}/gi, '[超长链接已省略]')
    .trim();
  if (raw.length <= limit) return raw;
  return `${raw.slice(0, limit)}…[已截断]`;
}

function buildSummaryAttributionRuleBlock() {
  return [
    '【发言者与人称方向·零容错】',
    '- 每条记录都以 [发言者:显示名 · 角色ID:稳定ID] 开头；行内“我/我的/给你/提醒你”只属于该行发言者，“你/你的/给我/提醒我”指向当时对话对象。',
    '- 摘要、事件记忆和结构化事实必须改写为带姓名的第三人称，不能脱离发言者标签照抄“我/你”。',
    '- 给、借、还、欠、转账、领取、提醒、答应等有方向的动作必须分别写清动作发起者与接收者；证据不足就不写，严禁把谁给谁、谁欠谁、谁提醒谁写反。',
    '- 角色对用户动机、感受、责任或真实意图的判断若没有用户本人明确确认，只能写成“角色认为/怀疑/误会/感到”，不得压缩成用户的客观事实或 relationship_impression 里的定论。',
    '- 增量里若用户明确纠正“不是我说的/做的”“你记错了”或否认某种内心归因，摘要必须保留这次纠正并降低旧判断的确定性；不得为了维持旧摘要，把纠正改写成用户逃避、嘴硬或拒不承认。',
  ].join('\n');
}

function buildEphemeralLanguageMemoryRuleBlock() {
  return [
    '【一次性称呼与冷梗·禁止固化】',
    '- 某个昵称、关系标签、动物化意象、职业称谓、比喻或玩笑在聊天里出现过，不等于已经形成稳定称呼或共享梗。尤其是角色自己临时创造、对方没有明确接住的词，只视为当轮措辞。',
    '- 只有对方明确要求这样称呼、之后主动复用，或双方多轮持续正面接梗，才可概括为稳定称呼/共享梗。沉默、换题、冷淡回应、否认、不喜欢，以及引用原词进行反问或吐槽，都不是接纳。',
    '- 未达到上述证据时，不写进【全局】、角色摘要、事件 highlight/tags、事件记忆或结构化事实；不得把一次性措辞写成 relationship_impression、topic_affinity、group_meme 或 evergreen。',
  ].join('\n');
}

function buildCharacterEvolutionExtractionRuleBlock({ roleLine = '', userName = '用户' } = {}) {
  return [
    '【角色演化信号 · 只记录可成长基线】',
    `- character_evolution_signal 的 subject 必须是本次会话中的角色，不能是 ${userName}；角色范围：${roleLine || '以上会话角色'}。它记录的是角色后来形成的软变化，不是替用户画像。`,
    '- 只考虑可成长部分：长期表达与披露方式、主动分享习惯、信任与依赖方式、冲突修复、边界协商、面对关系时反复采用的新选择。身份、能力、身体条件、世界观硬设定、核心价值和明确禁忌绝不写成演化信号。',
    '- 单轮情绪、一次顺从或迎合、用户希望角色变成怎样、角色卡本来就写明的特质、没有行为后果的自我宣言，都不是成长证据。必须能指出本增量里实际发生的选择、改口、行动或关系后果。',
    '- 渐进变化：只有本增量再次提供同方向的新证据时才输出，tags 必须含 evolution_gradual；跨摘要沿用同一个具体 canonicalKey。即使已有账本，本轮确有独立新证据也要重写同一键，让系统累计证据；只是复述旧事则不要输出。',
    '- 关键转折：只有本增量本身明确呈现“旧做法 → 触发事件 → 新选择”，且已经造成可继承的关系或行动后果时，tags 才可含 evolution_turning_point，confidence 不低于 0.88。争吵、告白或情绪很强本身不等于转折。',
    '- content 写变化后的当前软基线，必须带角色主语，不写事件摘要或心理诊断；evidence 写本增量中最短的行为依据。canonicalKey 格式为“角色|character_evolution_signal|具体变化领域”。',
    '- 若本增量明确推翻已有演化信号，沿用原 canonicalKey、写当前修正后的 content；若证明该变化已经失效且没有新方向，temporalState 写 completed。其余候选写 evergreen。',
  ].join('\n');
}

function buildExistingFactLedgerBlock(rows = [], chatId = '') {
  const id = String(chatId || '').trim();
  const facts = (Array.isArray(rows) ? rows : [])
    .filter((row) => (
      !row?.vectorSupersededBy
      && (String(row?.chatId || '').trim() === id || String(row?.sourceChatId || '').trim() === id)
    ))
    .sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0))
    .slice(0, 40);
  if (!facts.length) return '';
  return [
    '【已有结构化事实账本（仅用于查重）】',
    ...facts.map((fact) => {
      const key = String(fact.canonicalKey || '').trim() || '无稳定键';
      return `- ${key} | ${String(fact.factType || '').trim()} | ${String(fact.content || '').replace(/\s+/g, ' ').trim()}`;
    }),
    '本次结构化表格只写增量聊天中新确认、明确改变或推翻的事实。账本里已有且本轮只是复述/沿用的条目不要再输出；确有更新时沿用原 canonicalKey。character_evolution_signal 是唯一的累计例外：本增量出现独立新行为证据时，即使方向未变也须沿用同一键再次输出。',
  ].join('\n');
}

function compactMessageContentForSummary(message = {}) {
  const type = String(message?.type || 'text').trim();
  const meta = message?.metadata && typeof message.metadata === 'object' ? message.metadata : {};
  const content = String(message?.content || '');
  const metaText = (...keys) => keys
    .map((key) => clampSummaryText(meta[key] || message[key] || '', 180))
    .find(Boolean) || '';

  if (type === 'image') {
    const caption = metaText('caption', 'reason', 'alt');
    const prompt = metaText('prompt', 'imagePrompt');
    return ['[图片消息]', caption ? `说明:${caption}` : '', prompt ? `生成提示:${prompt}` : ''].filter(Boolean).join(' ');
  }
  if (type === 'sticker') {
    return `[表情] ${clampSummaryText(content || metaText('name', 'inlineText'), 160)}`.trim();
  }
  if (type === 'voice') {
    const seconds = Number(message?.seconds || meta.seconds || 0);
    const suffix = seconds ? `（${seconds}秒）` : '';
    return `[语音${suffix}] ${clampSummaryText(content || metaText('text', 'transcript'), 500)}`.trim();
  }
  if (type === 'music') {
    const title = metaText('title', 'musicTitle', 'name');
    const artist = metaText('artist', 'singer');
    const lyrics = metaText('lyrics', 'lyricsText', 'lyricsPreview');
    return [`[音乐分享]`, title, artist ? `- ${artist}` : '', lyrics ? `歌词:${lyrics}` : ''].filter(Boolean).join(' ');
  }
  if (type === 'link') {
    const platformLabel = metaText('platformLabel', 'source');
    const title = metaText('title', 'siteName');
    const summary = metaText('summary', 'desc', 'description');
    const keywords = Array.isArray(meta.keywords) ? meta.keywords.filter(Boolean).slice(0, 5).join('/') : '';
    return [
      `[链接分享${platformLabel ? `·${platformLabel}` : ''}]`,
      title,
      summary,
      keywords ? `关键词:${keywords}` : '',
    ].filter(Boolean).join(' ');
  }
  if (type === 'location') {
    const title = metaText('title', 'name', 'address');
    return `[位置分享] ${title || clampSummaryText(content, 240)}`.trim();
  }
  return clampSummaryText(content);
}

function buildCappedSummaryTextBlock(rows = [], limit = SUMMARY_TEXT_BLOCK_CHAR_LIMIT) {
  const out = [];
  let total = 0;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = String(rows[i] || '');
    const cost = row.length + 1;
    if (out.length && total + cost > limit) break;
    out.push(row);
    total += cost;
    if (total >= limit) break;
  }
  const omitted = Math.max(0, rows.length - out.length);
  const ordered = out.reverse();
  if (omitted) ordered.unshift(`[系统提示: 前面 ${omitted} 条较早记录因总结输入上限已省略，本轮优先整理最近记录。]`);
  return ordered.join('\n');
}

function stableMemoryRangeHash(value = '') {
  let hash = 2166136261;
  const text = String(value || '');
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function hasStoredChatSummaryRange(memories = [], {
  chatId = '',
  userId = '',
  rangeText = '',
  summaryRangeKey = '',
} = {}) {
  const stableId = summaryRangeKey
    ? `mem_summary_${chatId}_${summaryRangeKey}_global`
    : '';
  const rangePrefix = rangeText ? `【区间】${rangeText}\n` : '';
  return (Array.isArray(memories) ? memories : []).some((memory) => (
    memory?.type === 'summary'
    && (!memory.userId || memory.userId === userId)
    && !memory.characterId
    && (!memory.summarySuppressed
      || Number(memory.summarySuppressionVersion || 0) >= SUMMARY_SUPPRESSION_VERSION)
    && (
      (stableId && String(memory.id || '') === stableId)
      || (rangePrefix && String(memory.content || '').startsWith(rangePrefix))
    )
  ));
}

export function hasStoredChatSummaryOverlap(memories = [], {
  chatId = '',
  userId = '',
  messageIds = [],
} = {}) {
  const requestedIds = new Set((Array.isArray(messageIds) ? messageIds : [])
    .map((id) => String(id || '').trim())
    .filter(Boolean));
  if (!requestedIds.size) return false;
  return (Array.isArray(memories) ? memories : []).some((memory) => (
    memory?.type === 'summary'
    && String(memory?.chatId || '') === String(chatId || '')
    && (!memory.userId || memory.userId === userId)
    && !memory.characterId
    && (!memory.summarySuppressed
      || Number(memory.summarySuppressionVersion || 0) >= SUMMARY_SUPPRESSION_VERSION)
    && Array.isArray(memory.summaryMessageIds)
    && memory.summaryMessageIds.some((id) => requestedIds.has(String(id || '').trim()))
  ));
}

export function legacySuppressedSummaryIdsCoveredBy(memories = [], messageIds = []) {
  const coveredIds = new Set((Array.isArray(messageIds) ? messageIds : [])
    .map((id) => String(id || '').trim())
    .filter(Boolean));
  if (!coveredIds.size) return [];
  return (Array.isArray(memories) ? memories : [])
    .filter((memory) => (
      memory?.type === 'summary'
      && !memory.characterId
      && memory.summarySuppressed
      && Number(memory.summarySuppressionVersion || 0) < SUMMARY_SUPPRESSION_VERSION
      && Array.isArray(memory.summaryMessageIds)
      && memory.summaryMessageIds.length > 0
      && memory.summaryMessageIds.every((id) => coveredIds.has(String(id || '').trim()))
    ))
    .map((memory) => String(memory.id || '').trim())
    .filter(Boolean);
}

export function buildSuppressedChatSummaryCoverageMemory(globalSummaryMemory = {}, rangeText = '') {
  return {
    ...globalSummaryMemory,
    content: `【区间】${String(rangeText || '').trim()}\n本区间已处理；与已删除记忆重合的内容未重新保存。`,
    source: String(globalSummaryMemory.source || '').includes('manual')
      ? 'api-summary-manual-suppressed'
      : 'api-summary-auto-suppressed',
    hotSummary: false,
    vectorArchived: true,
    summarySuppressed: true,
    summarySuppressionVersion: SUMMARY_SUPPRESSION_VERSION,
  };
}

export function parseSharedMemoryExtraction(rawText = '') {
  const raw = String(rawText || '').trim();
  if (!raw) return '';
  const unfenced = raw
    .replace(/^```[^\n]*\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  const normalizedJson = unfenced
    .replace(/[｛｝]/g, (char) => (char === '｛' ? '{' : '}'))
    .replace(/[［］]/g, (char) => (char === '［' ? '[' : ']'))
    .replace(/[“”]/g, '"')
    .replace(/，\s*([}\]])/g, '$1')
    .replace(/,\s*([}\]])/g, '$1');
  const candidates = [...new Set([unfenced, normalizedJson])];
  const objectMatch = unfenced.match(/\{[\s\S]*\}/);
  if (objectMatch && objectMatch[0] !== unfenced) candidates.push(objectMatch[0]);
  const arrayMatch = unfenced.match(/\[[\s\S]*\]/);
  if (arrayMatch && arrayMatch[0] !== unfenced) candidates.push(arrayMatch[0]);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      const first = Array.isArray(parsed) ? parsed[0] : parsed;
      const content = typeof first === 'string'
        ? first
        : String(
          first?.content
          || first?.summary
          || first?.memory
          || first?.sharedMemory
          || first?.['共同回忆']
          || first?.['共同回忆正文']
          || first?.['正文']
          || '',
        ).trim();
      if (content) return content.slice(0, 1200);
    } catch (_) {}
  }

  const looseFieldMatch = unfenced.match(
    /(?:content|summary|memory|sharedMemory|共同回忆正文|共同回忆|正文)["'“”]?\s*[:：]\s*["'“”]([\s\S]*?)["'“”]\s*[,，}]?\s*$/i,
  );
  if (looseFieldMatch?.[1]?.trim()) return looseFieldMatch[1].trim().slice(0, 1200);

  // 部分 OpenAI 兼容中转会忽略“只输出 JSON”，直接返回可用的共同回忆正文。
  // 手动补记本身就是显式用户操作，这里接受纯文本，避免把有效结果误判为格式错误。
  if (/^[{\[]/.test(unfenced) || /(?:只输出|输出格式|不要\s*Markdown|聊天记录：)/i.test(unfenced)) {
    return '';
  }
  const plain = unfenced
    .replace(/^(?:【?共同回忆】?|共同回忆正文|提取结果|content|summary)\s*[:：]\s*/i, '')
    .replace(/^["'“”]+|["'“”]+$/g, '')
    .trim();
  if (!plain || /^(?:抱歉|无法|我不能|未找到|没有足够)/.test(plain)) return '';
  return plain.slice(0, 1200);
}

/** 极弱模型/中转偶发照抄输出格式说明当正文，这些占位选项串是模板专属，真实生成内容不会原样保留 */
const TEMPLATE_ECHO_MARKERS = [
  '主动/被动/热情/敷衍/欲言又止',
  '状态：待执行/已完成',
  '（分析：可能意味着…）',
  '已解决/未解决/悬而未决',
  '角色名A,角色名B',
  '角色名A→角色名B',
  '知情者：… | 不知情：…',
];

function looksLikeTemplateEcho(text = '') {
  const raw = String(text || '');
  if (!raw) return false;
  return TEMPLATE_ECHO_MARKERS.some((marker) => raw.includes(marker));
}

function formatTs(ts) {
  const d = new Date(ts || Date.now());
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function parseRoleBlocks(text = '') {
  const raw = String(text || '');
  const globalMatch = raw.match(/【全局】([\s\S]*?)(?=【角色:|$)/);
  const global = (globalMatch?.[1] || '').trim();
  const roleRe = /【角色:([^\]]+)】([\s\S]*?)(?=【角色:|$)/g;
  const roles = [];
  let m;
  while ((m = roleRe.exec(raw))) {
    const roleId = String(m[1] || '').trim();
    const body = String(m[2] || '').trim();
    if (!roleId || !body) continue;
    roles.push({ roleId, body });
  }
  return { global, roles };
}

function parseRelationshipChanges(text = '', allowedIds = []) {
  const match = String(text || '').match(/【关系变化】\s*([\s\S]*?)\s*【\/关系变化】/);
  if (!match) return [];
  let rows = [];
  try {
    rows = JSON.parse(match[1]);
  } catch (_) {
    return [];
  }
  const allowed = new Set((allowedIds || []).filter(Boolean));
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    a: String(row?.a || '').trim(),
    b: String(row?.b || '').trim(),
    label: String(row?.label || '').trim().slice(0, 40),
  })).filter((row) => (
    row.a
    && row.b
    && row.a !== row.b
    && allowed.has(row.a)
    && allowed.has(row.b)
  )).slice(0, 6);
}

function stripRelationshipChangesBlock(text = '') {
  return String(text || '').replace(/【关系变化】[\s\S]*?【\/关系变化】/g, '').trim();
}

function parseMentionRoleBlocksFromGlobal(globalText = '', roleIds = [], resolveName = (id) => id) {
  const text = String(globalText || '').trim();
  if (!text || !roleIds.length) return [];
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*-\s*/, '').trim())
    .filter(Boolean);
  const map = new Map(roleIds.map((id) => [id, []]));
  for (const line of lines) {
    for (const rid of roleIds) {
      const name = String(resolveName(rid) || rid).trim();
      if (!name) continue;
      if (line.includes(name)) {
        map.get(rid).push(line);
      }
    }
  }
  return [...map.entries()]
    .map(([roleId, rows]) => ({ roleId, body: rows.join('\n') }))
    .filter((x) => x.body);
}

function buildAnonymousSummaryProtocol(chat, options = {}) {
  if (!isAnonymousChat(chat)) return '';
  const { currentUserName = '匿名网友', userRow = null } = options || {};
  const participants = (chat?.participants || []).filter(Boolean);
  const memberLines = participants.map((actorId) => {
    const profile = getAnonymousDisplayProfile(chat, actorId, { currentUserName, userRow });
    return `- ${profile?.anonymousId || actorId}`;
  });
  const base = buildAnonymousPrivateContextPrompt(chat, {
    userAnonymousId: getAnonymousDisplayProfile(chat, 'user', { currentUserName, userRow })?.anonymousId,
  });
  return [
    base,
    '[匿名总结要求]',
    '- 本次总结与事件记忆只允许使用本房匿名ID叙述。',
    '- 禁止输出真实姓名、住址、联系方式等可识别信息。',
    '- knownBy 在匿名房里优先使用匿名ID。',
    memberLines.length ? `在场成员：\n${memberLines.join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
}

function getStrangerSummaryDisplayName(chat, actorId, userId, fallback = '') {
  if (!isStrangerInterceptChat(chat)) return String(fallback || actorId || '').trim();
  const key = actorId === 'user'
    ? principalKey('user', userId)
    : principalKey('character', actorId);
  const accountId = String(chat?.metadata?.accountIdentityMap?.[key] || '').trim();
  return String(chat?.metadata?.accountSnapshots?.[accountId]?.displayName || fallback || '陌生账号').trim();
}

function mergeSummaryCompletionMeta(previous = {}, next = {}) {
  const previousKinds = Array.isArray(previous.responsePartKinds) ? previous.responsePartKinds : [];
  const nextKinds = Array.isArray(next.responsePartKinds) ? next.responsePartKinds : [];
  const previousReasoning = String(previous.reasoningText || '');
  const nextReasoning = String(next.reasoningText || '');
  const reasoningText = !nextReasoning
    ? previousReasoning
    : (!previousReasoning || nextReasoning.startsWith(previousReasoning)
      ? nextReasoning
      : (previousReasoning.endsWith(nextReasoning) ? previousReasoning : `${previousReasoning}${nextReasoning}`));
  return {
    ...previous,
    ...next,
    rawFinishReason: next.rawFinishReason || previous.rawFinishReason || '',
    promptBlockReason: next.promptBlockReason || previous.promptBlockReason || '',
    finishMessage: next.finishMessage || previous.finishMessage || '',
    safetyRatings: next.safetyRatings?.length ? next.safetyRatings : (previous.safetyRatings || []),
    responsePartKinds: [...new Set([...previousKinds, ...nextKinds])],
    reasoningText,
  };
}

async function requestSummaryTask(messages, options = {}, task = 'chatSummary') {
  let completionMeta = {};
  let requestStat = {};
  const text = await chatForTask(messages, {
    ...options,
    onCompletionMeta: (next) => {
      completionMeta = mergeSummaryCompletionMeta(completionMeta, next || {});
      options.onCompletionMeta?.(next);
    },
    onRequestStat: (next) => {
      requestStat = { ...(next || {}) };
      options.onRequestStat?.(next);
    },
  }, task);
  return { text: String(text || ''), completionMeta, requestStat };
}

function compactSummaryDiagnostic(value = '', limit = 120) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function summaryApiTargetLabel(result = {}) {
  const section = result.apiSection === 'tool'
    ? '工具模型'
    : result.apiSection === 'main' ? '聊天模型' : '';
  return [section, result.model].filter(Boolean).join(' · ');
}

export function buildEmptyChatSummaryFailure({ completionMeta = {}, requestStat = {} } = {}) {
  const rawFinishReason = String(
    completionMeta.rawFinishReason || completionMeta.finishReason || '',
  ).trim();
  const normalizedFinish = rawFinishReason.toUpperCase();
  const promptBlockReason = String(completionMeta.promptBlockReason || '').trim();
  const finishMessage = compactSummaryDiagnostic(completionMeta.finishMessage || '');
  const partKinds = Array.isArray(completionMeta.responsePartKinds)
    ? completionMeta.responsePartKinds
    : [];
  const hasText = partKinds.includes('text');
  let emptyDetail = '';
  if (promptBlockReason) {
    emptyDetail = `Gemini 拒绝了总结提示词（${promptBlockReason}）`;
  } else if (normalizedFinish === 'MAX_TOKENS' || completionMeta.finishReason === 'length') {
    emptyDetail = 'Gemini 在输出正文前达到 Token 上限；请降低 thinking 或提高 Max Tokens';
  } else if (['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION', 'LANGUAGE'].includes(normalizedFinish)) {
    emptyDetail = `Gemini 拦截了本次总结（${normalizedFinish}）`;
  } else if (requestStat.errorKind === 'reasoning_only' || (partKinds.includes('thought') && !hasText)) {
    emptyDetail = 'Gemini 只返回了思考内容，没有生成总结正文';
  } else if (partKinds.includes('inline-data') && !hasText) {
    emptyDetail = '所选模型返回了图片而非文本；请改用 Gemini 文本模型';
  } else {
    emptyDetail = `模型返回成功，但没有可用的文本正文${normalizedFinish ? `（${normalizedFinish}）` : ''}`;
  }
  if (finishMessage) emptyDetail += `：${finishMessage}`;
  return {
    ok: false,
    reason: 'empty-api',
    emptyDetail,
    apiSection: String(requestStat?.audit?.apiSection || '').trim(),
    model: String(requestStat?.model || completionMeta.requestModel || completionMeta.model || '').trim(),
    finishReason: rawFinishReason,
    promptBlockReason,
    responsePartKinds: partKinds,
    upstreamMeta: completionMeta,
    reasoningText: String(completionMeta.reasoningText || ''),
  };
}

/**
 * 自动/手动聊天记忆总结：写入分层 memories + 事件记忆 + 结构化事实
 */
export function describeChatSummaryFailure(result = {}) {
  const target = summaryApiTargetLabel(result);
  const targetSuffix = target ? `（${target}）` : '';
  const reasonMsgMap = {
    'summary-in-flight': '当前摘要任务仍在进行，请稍后再试',
    'no-messages': '当前会话没有可总结消息',
    'no-delta': '自上次总结后暂无新增消息',
    'not-enough-delta': `增量不足（${result.deltaCount || 0}/${result.freq || 0}）`,
    'already-summarized': '这段区间已经总结过了',
    'invalid-range': '请选择正确的消息范围',
    'missing-chat-or-user': '当前会话信息不完整，请重新进入后再试',
    'empty-api': `总结失败：${result.emptyDetail || '模型未返回内容'}${targetSuffix}`,
    'template-echo-output': '总结失败：模型输出异常（照抄了格式说明），请换一个总结模型再试',
    error: `总结失败：${result.message || '未知错误'}`,
  };
  return reasonMsgMap[result.reason] || '暂时无法开始总结，请稍后再试';
}

export async function maybeSummarizeChatMemory({
  chat,
  userId,
  currentUserName = '用户',
  resolveName = (id) => id,
  force = false,
  messageRange = null,
  _browserLockHeld = false,
}) {
  if (!chat?.id || !userId) return { ok: false, reason: 'missing-chat-or-user' };
  const browserLocks = globalThis.navigator?.locks;
  if (!_browserLockHeld && browserLocks?.request) {
    return browserLocks.request(
      summaryBrowserLockName(userId, chat.id),
      { mode: 'exclusive' },
      () => maybeSummarizeChatMemory({
        chat,
        userId,
        currentUserName,
        resolveName,
        force,
        messageRange,
        _browserLockHeld: true,
      }),
    );
  }
  const summaryKey = summaryTaskKey(userId, chat.id);
  if (SUMMARY_IN_FLIGHT.has(summaryKey)) {
    if (!force) return { ok: false, reason: 'summary-in-flight' };
    // 自动摘要常在 AI 回合落库后异步运行。用户此时点手动总结时不要误报
    // “无消息”，而是等当前任务释放同一会话锁后继续执行所选范围。
    const idle = await waitForSummaryIdle(summaryKey);
    if (!idle) return { ok: false, reason: 'summary-in-flight' };
    return maybeSummarizeChatMemory({
      chat, userId, currentUserName, resolveName, force, messageRange,
    });
  }
  const storageLease = claimSummaryStorageLease(summaryKey);
  if (!storageLease.acquired) return { ok: false, reason: 'summary-in-flight' };
  SUMMARY_IN_FLIGHT.add(summaryKey);
  try {
    // 角色清除可能与正在进行的摘要请求并发。先记住重置代次，写库前再次核验；
    // 这样旧请求即使稍后返回，也不能把刚清掉的摘要、事实和事件重新写回来。
    const resetTokensAtStart = await loadSummaryResetTokens(chat, userId);
    const prefRow = await db.get(`chatPrefs_${chat.id}`);
    const prefs = resolveChatSummarySettings(chat, prefRow?.value || {});
    if (!force && !prefs.autoSummary) return { ok: false, reason: 'auto-summary-off' };

    const { sorted, allMems, coverage } = await loadSummaryRows(chat.id, userId);
    if (!sorted.length) return { ok: false, reason: 'no-messages' };

    const hasManualRange = force && messageRange && typeof messageRange === 'object';
    const requestedFrom = Math.trunc(Number(messageRange?.from));
    const requestedTo = Math.trunc(Number(messageRange?.to));
    if (hasManualRange && (!Number.isFinite(requestedFrom) || !Number.isFinite(requestedTo))) {
      return { ok: false, reason: 'invalid-range' };
    }
    const rangeFrom = hasManualRange ? Math.max(1, Math.min(sorted.length, requestedFrom)) : 0;
    const rangeTo = hasManualRange ? Math.max(1, Math.min(sorted.length, requestedTo)) : 0;
    if (hasManualRange && rangeFrom > rangeTo) {
      return { ok: false, reason: 'invalid-range' };
    }
    const delta = hasManualRange
      ? sorted.slice(rangeFrom - 1, rangeTo)
        .filter((message) => !coverage.coveredIds.has(String(message?.id || '')))
      : sorted.filter((message) => !coverage.coveredIds.has(String(message?.id || '')));
    const freq = Math.max(10, Number(prefs.autoSummaryFreq) || 100);
    if (!force && delta.length < freq) {
      return { ok: false, reason: 'not-enough-delta', deltaCount: delta.length, freq };
    }
    if (!delta.length) return { ok: false, reason: 'no-delta' };
    const deltaMessageIds = delta.map((message) => String(message?.id || '')).filter(Boolean);
    if (!force && hasStoredChatSummaryOverlap(allMems, {
      chatId: chat.id,
      userId,
      messageIds: deltaMessageIds,
    })) {
      return { ok: false, reason: 'already-summarized', deltaCount: delta.length };
    }
    const summaryRangeKey = stableMemoryRangeHash([
      chat.id,
      ...delta.map((message) => String(message?.id || message?.timestamp || '')),
    ].join('|'));
    if (!force && hasStoredChatSummaryRange(allMems, {
      chatId: chat.id,
      userId,
      summaryRangeKey,
    })) {
      return { ok: false, reason: 'already-summarized', deltaCount: delta.length };
    }

    const isGroup = chat.type === 'group';
    const isolatedAlias = isStrangerInterceptChat(chat);
    const summaryCurrentUserName = isolatedAlias
      ? getStrangerSummaryDisplayName(chat, 'user', userId, '陌生账号')
      : currentUserName;
    const userInChat = Array.isArray(chat.participants) && chat.participants.includes('user');
    const sessionTag = isGroup
      ? `群聊「${String(chat.groupSettings?.name || '').trim() || '未命名'}」${userInChat ? '·用户在场' : '·无用户账号在场'}${chat.groupSettings?.isObserverMode ? '·旁观模式' : ''}`
      : `私聊${userInChat ? '·用户在场' : '·无用户账号在场'}`;
    const roleIds = (chat.participants || []).filter((id) => id && id !== 'user');
    const peerPrivateNoUser = !isGroup && !userInChat && roleIds.length >= 2;
    const currentUserRow = userId ? await db.getRecord('users', userId) : null;
    const anonymousCurrentUserName = isAnonymousChat(chat) ? '匿名网友' : currentUserName;
    const anonymousOptions = {
      currentUserName: anonymousCurrentUserName,
      userRow: currentUserRow,
    };
    const formatSummaryText = (value = '') => (
      isAnonymousChat(chat)
        ? replaceTextWithAnonymousIds(String(value || ''), chat, anonymousOptions)
        : String(value || '')
    );
    const roleDisplayEntries = await Promise.all(roleIds.map(async (id) => {
      const resolvedName = await Promise.resolve(resolveName(id));
      const display = isAnonymousChat(chat)
        ? (getAnonymousDisplayProfile(chat, id, anonymousOptions)?.anonymousId || resolvedName)
        : (isolatedAlias
          ? getStrangerSummaryDisplayName(chat, id, userId, resolvedName)
          : resolveSummaryActorLabel(chat, id, resolvedName));
      return `${id}:${display}`;
    }));
    const roleLine = roleDisplayEntries.join('，');
    const relationshipExtractionPrompt = !isAnonymousChat(chat) && roleIds.length >= 2
      ? `\n【关系变化】\n输出 0～4 条本轮有明确证据的角色间关系变化，严格用 JSON 数组：\n[{"a":"角色ID","b":"角色ID","label":"当前关系概括"}]\na/b 只能取这些角色ID：${roleLine}。只有真正互动过且关系有推进时才写；仅仅同处一群、被提到或没有变化时输出 []。\n【/关系变化】`
      : '';
    const textRows = await Promise.all(delta.map(async (m) => {
      const resolvedName = m.senderId && m.senderId !== 'user'
        ? await Promise.resolve(resolveName(m.senderId))
        : '';
      const sender = m.senderId === 'user'
        ? (isAnonymousChat(chat)
          ? (getAnonymousDisplayProfile(chat, 'user', anonymousOptions)?.anonymousId || anonymousCurrentUserName)
          : (isolatedAlias
            ? getStrangerSummaryDisplayName(chat, 'user', userId, '陌生账号')
            : currentUserName))
        : (isAnonymousChat(chat)
          ? (getAnonymousDisplayProfile(chat, m.senderId, anonymousOptions)?.anonymousId || m.senderName || resolvedName)
          : (isolatedAlias
            ? getStrangerSummaryDisplayName(chat, m.senderId, userId, m.senderName || resolvedName)
            : resolveSummaryActorLabel(chat, m.senderId, resolvedName, m.senderName)));
      const sid = m.senderId === 'user' ? 'user' : (m.senderId || 'unknown');
      return `[发言者:${sender} · 角色ID:${sid}] ${formatSummaryText(compactMessageWithMentionContext(m, chat, summaryCurrentUserName))}`;
    }));
    const textBlock = buildCappedSummaryTextBlock(textRows);
    const extraGroup = String(prefs.customGroupSummaryPrompt || '').trim()
      ? `\n【用户附加要求 · 仅群聊】\n${String(prefs.customGroupSummaryPrompt).trim()}`
      : '';
    const extraPrivate = String(prefs.customSummaryPrompt || '').trim()
      ? `\n【用户附加要求 · 仅私聊】\n${String(prefs.customSummaryPrompt).trim()}`
      : '';
    const worldNow = await getNowForUser(userId);
    const {
      fromTs: deltaStartTs,
      toTs: deltaEndTs,
    } = resolveSummaryRangeTimestamps(delta, worldNow);
    const rangeText = `${formatTs(deltaStartTs)} ~ ${formatTs(deltaEndTs)}`;
    const memoryEventTs = deltaEndTs || worldNow;
    const summaryCursorTs = resolveSummaryCursorTimestamp(worldNow, deltaEndTs);
    if (!force && hasStoredChatSummaryRange(allMems, {
      chatId: chat.id,
      userId,
      rangeText,
      summaryRangeKey,
    })) {
      return { ok: false, reason: 'already-summarized', deltaCount: delta.length, rangeText };
    }
    const anonymousPrompt = isAnonymousChat(chat)
      ? [
        buildAnonymousSummaryProtocol(chat, anonymousOptions),
        ...(isGroup
          ? ['【全局标签里的称呼·匿名群】\n【全局】各行凡要写人物称呼处，一律使用本房匿名ID（与上文「在场成员」一致），勿写角色真名。']
          : []),
      ].filter(Boolean).join('\n\n')
      : '';
    const aliasIsolationPrompt = isolatedAlias
      ? [
        '【马甲线程隔离摘要】',
        '- 这份摘要只属于当前陌生账号线程，所有人物只用上文前台账号名叙述，禁止写真名、本体名或把账号与本体合并。',
        '- 未揭示阶段主会话最多读取这份概括，禁止保留逐字原话、金句或可反查身份的独特措辞；一律转述事件、态度、边界和未完成事项。',
        '- 不生成跨会话事件记忆或结构化事实；身份明确揭示后才由线程门禁显式共享原消息。',
      ].join('\n')
      : '';
    const existingFactRows = isolatedAlias || isAnonymousChat(chat)
      ? []
      : await db.getAllByIndex('memoryFacts', 'userId', userId).catch(() => []);
    const existingFactLedgerBlock = buildExistingFactLedgerBlock(existingFactRows, chat.id);
    const timeBlock = await buildTimeAndHolidayPromptBlock(userId);
    const vt = [
      timeBlock,
      buildSummaryAttributionRuleBlock(),
      buildEphemeralLanguageMemoryRuleBlock(),
      buildCharacterEvolutionExtractionRuleBlock({ roleLine, userName: summaryCurrentUserName }),
    ].filter(Boolean).join('\n\n') + '\n\n';
    const systemPrompt = peerPrivateNoUser
      ? `${vt}
你要为两位角色之间的私聊生成续聊摘要。这个窗口没有真实用户参与，禁止把任何一方写成“用户”，也禁止引入用户主窗或其它窗口的信息。

输出格式严格如下：
【全局】
控制在 8～15 行以内，每行一条、用标签开头：
[话题] 谁向谁提到什么 | 双方态度：…
[私密] 角色A告诉角色B：…
[约定] 谁与谁约定什么 | 状态：待执行/已完成
[转折] 提到…时，角色A从…变为…
[关系] 角色A→角色B：从…变为…（原因：…）
[状态] 角色A：… | 角色B：…

【角色:角色ID】
可选：分别为 1～2 位关键角色补 1～3 条自己的态度、边界或未完成事项；角色ID只能取：${roleLine}。

【事件记忆】
输出 0～2 条真正值得在这两位角色之间长期保留的事件，严格用 JSON 数组。knownBy 只写实际知情的角色，键优先用角色名；involvedChats 只能写当前窗口：
【记忆:事件摘要】
[
  {
    "summary": "一句话概括发生了什么（<=80字）",
    "timestamp": ${deltaEndTs},
    "knownBy": { "角色名A": "involved", "角色名B": "involved" },
    "involvedChats": ["${chat.id}"],
    "relationChanges": [],
    "pendingThreads": [],
    "highlight": "",
    "tags": [],
    "embarrassmentLevel": 0,
    "visibility": "private"
  }
]
【/记忆】
【记忆:结构化表格】
输出 0～4 条未来续聊真的用得上的事实，严格用 JSON 数组。字段：subjectName, objectName, factType, canonicalKey, content, evidence, confidence, visibility, knownBy, tags, temporalState, expiresAt。
subjectName 必须是事实归属者；factType 仅用 relationship_impression / preference / secret / promise / topic_affinity / boundary / status / character_evolution_signal；knownBy 只写真实知情者；visibility 写 private。
canonicalKey 必须使用“归属者|factType|具体主题”的稳定短键；同一事实换句话说也沿用同一键。
【/记忆】
要求：保留信息差、关系变化和真正仍会产生后续影响的未完成事项，丢弃寒暄与重复内容；普通问答里一方暂时没接的随口问题（如想吃什么、在干嘛），只要后续聊天已经换题，就不算 pendingThreads；不要编造，不要输出解释文字或 Markdown。${relationshipExtractionPrompt}${extraPrivate}`
      : isGroup
      ? `${vt}${anonymousPrompt ? `${anonymousPrompt}\n\n` : ''}${aliasIsolationPrompt ? `${aliasIsolationPrompt}\n\n` : ''}

你要为一段群聊生成记忆摘要。这**不是会议纪要**，不要写“大家讨论了/达成共识/氛围很好”这种空话；要写给未来续写用的「剧情备忘录」：保留好玩的东西、信息差、矛盾与钩子。

必须保留（按优先级）：
1) 事件与冲突（谁和谁矛盾/合作/误会）
2) 信息差（谁知道什么、谁不知道、谁被蒙在鼓里）
3) 关系变化（谁对谁更熟/更僵/出现新动态）
4) 悬念/未完成（还没揭晓/还在酝酿）
5) 名场面/金句（确有关系后果或被多人主动接住才保留；角色单方面制造的一次性昵称、冷梗和比喻不保留）
6) 情绪状态（摘要结束时主要角色的情绪/态度）

必须丢弃：
- 寒暄水聊、无实质内容
- 已彻底解决且不会再提的琐事
- 同一意思的重复消息（只留最精华一条）

输出格式严格如下（不要改标签格式）：
【全局】
按时间顺序列 15～25 行，每行一条、用标签开头（不要写项目符号，不要写段落）：
[事件] … | 涉及：角色名A,角色名B | 状态：已解决/未解决/悬而未决
[信息差] …（写清谁知道/谁不知道/谁误会）
[关系] 角色名A→角色名B：从…变为…（原因：…）
[悬念] … | 知情者：… | 不知情：…
[名场面] "原话摘录" ——角色名 | 上下文：…
[状态] 角色名A：… | 角色名B：…

【角色:角色ID】
可选：仅对 1～3 个最关键角色补 1～3 条“他做了什么/回应了谁/态度变化”，严禁写成流水账。

【事件记忆】
输出 1～4 条真正值得跨会话保留的事件记忆，严格用一个 JSON 数组（只允许 JSON，不要解释文字，不要 Markdown）。普通闲聊、已消化的小插曲、没有后续影响的碎片不要硬写进事件记忆。
注意：JSON 的 knownBy 键在匿名房里**优先使用本房匿名ID**；若模型仍输出中文名，客户端也会尽量映射。knownBy 请按证据稀疏填写：只写实际知道/听说/卷入的人，不要因为角色在当前群里就默认他知道；heard 仅用于确实被转述、看到片段或听到风声的角色。用于客户端写入：
【记忆:事件摘要】
[
  {
    "summary": "一句话概括发生了什么（<=80字）",
    "timestamp": ${memoryEventTs},
    "knownBy": { "角色名或匿名ID": "heard/known/involved" },
    "involvedChats": ["${chat.id}"],
    "relationChanges": [],
    "pendingThreads": [],
    "highlight": "名场面/社死瞬间（可空）",
    "tags": ["事件标签"],
    "embarrassmentLevel": 1,
    "visibility": "public/private/spreading"
  }
]
【/记忆】
【记忆:结构化表格】
输出 0～6 条可供未来检索的小事实，严格用 JSON 数组（只允许 JSON）。只记录“未来真的可能用得上”的事实，不要把普通寒暄、一次性笑声、无后续的水聊硬写进去。
字段：subjectName, objectName, factType, canonicalKey, content, evidence, confidence, visibility, knownBy, tags, temporalState, expiresAt。
归属零容错：subjectName＝这条事实的归属者（外号/头衔是谁的、事是谁做的、偏好是谁的就写谁），content 必须自带主语写清「谁」怎么样；严禁把角色自己的外号/头衔/做过的事记到${summaryCurrentUserName}头上，或把${summaryCurrentUserName}的记到角色头上——拿不准归属就不写这条。
factType 仅用：group_meme / relationship_impression / preference / secret / promise / topic_affinity / boundary / status / character_evolution_signal。
canonicalKey：使用“归属者|factType|具体主题”的稳定短键；同一事实换句话说也沿用同一键，不同主题不得共用宽泛键。
temporalState 仅用：planned（带明确未来日期、日期尚未到）、ongoing（约定还没兑现/状态仍在持续）、completed（已经兑现、日期已过或已经不了了之）、evergreen（偏好/关系印象/秘密/话题倾向/边界/真正形成的群梗这类不涉及"完不完成"的常态化事实）。preference/relationship_impression/secret/topic_affinity/boundary 默认写 evergreen；group_meme 只有满足上方“多轮持续正面接梗”的证据才可写 evergreen，单次出现必须不输出；promise/status 按对话里的实际结果与当前日期判断，明确未来日期未到写 planned，日期已过不得继续写 planned。
expiresAt：factType 是 promise/status 且 temporalState 是 planned 或 ongoing，并且原文有明确兑现日期时，填写该日期对应的大致毫秒时间戳；无法判断具体时间就留空，不要瞎编或把已过日期顺延到今天。
匿名房要求：subjectName/objectName/knownBy 都优先使用本房匿名ID，不写真名；群跳私聊相关事实可保留 sourceChatId 以继承来源群公屏记忆。
【/记忆】
要求：
1) 仅使用以下角色ID作为【角色:…】块：${roleLine || '（无）'}；用户相关只写在【全局】，不要伪造【角色:user】块。
2) 【全局】严禁会议纪要口吻；必须用上述标签行表达“发生了什么/谁知道什么/谁对谁怎样”。
3) 已收束/已解决的事件，pendingThreads 必须写 []；只有确实还存在后续影响、误会未解、或扩散未结束时才填写未解决钩子。普通问答里一方暂时没接的随口问题，只要后续聊天已经换题，也必须视为已过期，不能写进 pendingThreads。
4) 不要编造，不要输出解释文字或 Markdown。${relationshipExtractionPrompt}${extraGroup}`
      : `${vt}${anonymousPrompt ? `${anonymousPrompt}\n\n` : ''}${aliasIsolationPrompt ? `${aliasIsolationPrompt}\n\n` : ''}

你是对话纪要助手。请总结私聊增量记录，偏关系导向：话题流、私密信息（不要泄露给无关第三方）、约定与转折、对方释放的信号（试探/示好/敷衍/回避）、后续钩子。输出格式严格如下：
【全局】
控制在 8～15 行以内，每行一条、用标签开头（不要写段落）：
[话题] … | 角色态度：主动/被动/热情/敷衍/欲言又止
[私密] 角色告诉${summaryCurrentUserName}：…
[用户说] ${summaryCurrentUserName} 告诉角色：…
[约定] … | 状态：待执行/已完成
[转折] 提到…时角色从…变为…
[信号] 角色做了…（分析：可能意味着…）
【角色:${roleIds[0] || 'partner'}】
可选：补 1～3 条“他对${summaryCurrentUserName}的态度/边界/动机变化”，不要复读【全局】。
【事件记忆】
输出 0～2 条真正值得跨会话保留的事件记忆（JSON 数组）。不是每个有记忆点的私聊都要写成事件记忆；没有后续影响、没有信息差价值、不会影响后续关系/公共扩散的内容可以不写。
注意：JSON 的 knownBy 键**可用中文名**（推荐中文名）；客户端会自动映射到角色ID 存储。knownBy 请按证据稀疏填写：只写实际知道/听说/卷入的人，不要默认扩大到未参与者。用于客户端写入：
【记忆:事件摘要】
[
  {
    "summary": "一句话概括发生了什么（<=80字）",
    "timestamp": ${memoryEventTs},
    "knownBy": { "对方角色中文名": "heard/known/involved" },
    "involvedChats": ["${chat.id}"],
    "relationChanges": [],
    "pendingThreads": [],
    "highlight": "名场面/社死瞬间（可空）",
    "tags": ["事件标签"],
    "embarrassmentLevel": 1,
    "visibility": "public/private/spreading"
  }
]
【/记忆】
【记忆:结构化表格】
输出 0～4 条可供未来检索的小事实，严格用 JSON 数组（只允许 JSON）。只记录偏好、边界、秘密、约定、关系印象、话题倾向等未来会影响续聊的内容；普通水聊不要硬写。
字段：subjectName, objectName, factType, canonicalKey, content, evidence, confidence, visibility, knownBy, tags, temporalState, expiresAt。
归属零容错：subjectName＝这条事实的归属者（外号/头衔是谁的、事是谁做的、偏好是谁的就写谁），content 必须自带主语写清「谁」怎么样；严禁把角色自己的外号/头衔/做过的事记到${summaryCurrentUserName}头上，或把${summaryCurrentUserName}的记到角色头上——拿不准归属就不写这条。
factType 仅用：relationship_impression / preference / secret / promise / topic_affinity / boundary / status / character_evolution_signal。
canonicalKey：为同一事实生成稳定短键，格式“归属者|factType|具体主题”，例如“${summaryCurrentUserName}|preference|咖啡甜度”；同一事实换句话说也必须使用同一键，不同偏好/约定不得共用一个宽泛键。
temporalState 仅用：planned（带明确未来日期、日期尚未到）、ongoing（约定还没兑现/状态仍在持续）、completed（已经兑现、日期已过或已经不了了之）、evergreen（偏好/关系印象/秘密/话题倾向/边界这类不涉及"完不完成"的常态化事实）。preference/relationship_impression/secret/topic_affinity/boundary 默认写 evergreen；promise/status 按实际结果与当前日期判断，明确未来日期未到写 planned，日期已过不得继续写 planned。
expiresAt：factType 是 promise/status 且 temporalState 是 planned 或 ongoing，并且原文有明确兑现日期时，填写该日期对应的大致毫秒时间戳；判断不出具体时间就留空，不得顺延已过日期。
匿名私聊要求：使用匿名ID叙述；若来自匿名群跳私聊，群公屏事实可被承接，但本私聊事实 visibility 默认 private_to_pair，不自动公开给群里其他人。
【/记忆】
要求：事件已收束/已解决时，pendingThreads 必须写 []；只有确实还留有后续钩子时才填写。普通问答里一方暂时没接的随口问题（如想吃什么、在干嘛），只要后续聊天已经换题，就不算未完成事项。每条具体，不要编造，不要输出解释文字。${relationshipExtractionPrompt}${extraPrivate}`;

    const summaryResponse = await requestSummaryTask([
      {
        role: 'user',
        content:
          `${systemPrompt}\n\n`
          + `${existingFactLedgerBlock ? `${existingFactLedgerBlock}\n\n` : ''}`
          + `【会话定位】${sessionTag}\n`
          + `会话类型：${isGroup ? '群聊' : '私聊'}\n`
          + `增量区间：${rangeText}\n\n`
          + `以下是该会话窗口内的增量聊天记录（勿与其它私聊/群聊混写为同屏）：\n${textBlock}`,
      },
    ], { temperature: 0.3 }, 'chatSummary');
    const result = summaryResponse.text;
    if (!result.trim()) return buildEmptyChatSummaryFailure({
      completionMeta: summaryResponse.completionMeta,
      requestStat: summaryResponse.requestStat,
    });
    if (looksLikeTemplateEcho(result)) {
      return { ok: false, reason: 'template-echo-output', deltaCount: delta.length, rangeText };
    }

    const latestMemsBeforeWrite = await db.getAllByIndex('memories', 'chatId', chat.id);
    const duplicatedRange = hasStoredChatSummaryRange(latestMemsBeforeWrite, {
      chatId: chat.id,
      userId,
      rangeText,
      summaryRangeKey,
    });
    if (!force && duplicatedRange) {
      return { ok: false, reason: 'already-summarized', deltaCount: delta.length, rangeText };
    }
    if (!force && hasStoredChatSummaryOverlap(latestMemsBeforeWrite, {
      chatId: chat.id,
      userId,
      messageIds: deltaMessageIds,
    })) {
      return { ok: false, reason: 'already-summarized', deltaCount: delta.length, rangeText };
    }
    const resetTokensBeforeWrite = await loadSummaryResetTokens(chat, userId);
    if (didSummaryResetTokensChange(resetTokensAtStart, resetTokensBeforeWrite)) {
      return { ok: false, reason: 'character-progress-reset', deltaCount: delta.length, rangeText };
    }
    if (!(await areSummarySourceMessagesCurrent(chat.id, deltaMessageIds))) {
      return { ok: false, reason: 'source-messages-changed', deltaCount: delta.length, rangeText };
    }

    const cleanResultForSummary = stripRelationshipChangesBlock(
      stripMemoryFactBlocks(stripMemoryBlocks(result)),
    );
    const parsed = parseRoleBlocks(cleanResultForSummary);
    const globalContent = parsed.global || cleanResultForSummary.trim();
    const mentionFallback = parseMentionRoleBlocksFromGlobal(globalContent, roleIds, resolveName);
    const mergedRoleMap = new Map();
    for (const r of [...parsed.roles, ...mentionFallback]) {
      if (!roleIds.includes(r.roleId)) continue;
      const prev = mergedRoleMap.get(r.roleId) || '';
      const next = [prev, String(r.body || '').trim()].filter(Boolean).join('\n');
      if (next) mergedRoleMap.set(r.roleId, next);
    }

    const rangePrefix = `【区间】${rangeText}\n`;
    const sameRangeSummaries = latestMemsBeforeWrite.filter((memory) => (
      memory?.type === 'summary'
      && (!memory.userId || memory.userId === userId)
      && String(memory.content || '').startsWith(rangePrefix)
    ));
    const existingGlobalSummary = sameRangeSummaries.find((memory) => !memory.characterId);

    const globalSummaryMemory = createMemory({
      id: existingGlobalSummary?.id || `mem_summary_${chat.id}_${summaryRangeKey}_global`,
      chatId: chat.id,
      userId,
      characterId: '',
      type: 'summary',
      content: `【区间】${rangeText}\n${globalContent}`,
      timestamp: summaryCursorTs,
      source: force ? 'api-summary-manual' : 'api-summary-auto',
    });
    globalSummaryMemory.summaryMessageIds = delta
      .map((message) => String(message?.id || ''))
      .filter(Boolean);
    globalSummaryMemory.summaryRangeKey = summaryRangeKey;
    globalSummaryMemory.summaryFromTs = deltaStartTs;
    globalSummaryMemory.summaryToTs = deltaEndTs;
    globalSummaryMemory.hotSummary = true;
    globalSummaryMemory.vectorArchived = false;
    if (isolatedAlias) {
      globalSummaryMemory.memoryMode = 'isolated_alias';
      globalSummaryMemory.isolatedAlias = true;
      globalSummaryMemory.aliasThreadKey = String(chat.metadata?.strangerThreadKey || '');
    }
    const roleSummaryMemories = [];
    for (const [roleId, body] of mergedRoleMap.entries()) {
      const existingRoleSummary = sameRangeSummaries.find(
        (memory) => String(memory?.characterId || '') === String(roleId),
      );
      const roleSummaryMemory = createMemory({
        id: existingRoleSummary?.id || `mem_summary_${chat.id}_${summaryRangeKey}_${roleId}`,
        chatId: chat.id,
        userId,
        characterId: roleId,
        type: 'summary',
        content: `【区间】${rangeText}\n${body}`,
        timestamp: summaryCursorTs,
        source: force ? 'api-summary-manual-role' : 'api-summary-auto-role',
      });
      roleSummaryMemory.hotSummary = true;
      roleSummaryMemory.vectorArchived = false;
      roleSummaryMemory.summaryMessageIds = delta
        .map((message) => String(message?.id || ''))
        .filter(Boolean);
      roleSummaryMemory.summaryRangeKey = summaryRangeKey;
      roleSummaryMemory.summaryFromTs = deltaStartTs;
      roleSummaryMemory.summaryToTs = deltaEndTs;
      if (isolatedAlias) {
        roleSummaryMemory.memoryMode = 'isolated_alias';
        roleSummaryMemory.isolatedAlias = true;
        roleSummaryMemory.aliasThreadKey = String(chat.metadata?.strangerThreadKey || '');
      }
      roleSummaryMemories.push(roleSummaryMemory);
    }

    // 主摘要是本次昂贵 API 调用的核心产物，必须先完整落库。
    // 使用稳定范围 id 后，即便设备在后续派生写入阶段中断，重试也只会刷新同一批摘要。
    const savedGlobalSummary = await saveMemory(globalSummaryMemory);
    if (!savedGlobalSummary) {
      // 删除记忆保护会有意拒绝语义相近的模型产物。此时仍需持久化一个不含原内容的
      // 覆盖检查点，否则下一轮会继续把同一批消息送去付费总结，形成成功日志反复出现。
      const coverageMemory = buildSuppressedChatSummaryCoverageMemory(globalSummaryMemory, rangeText);
      await db.putRecord('memories', coverageMemory);
      return {
        ok: true,
        deltaCount: delta.length,
        rangeText,
        messageRange: hasManualRange ? { from: rangeFrom, to: rangeTo } : null,
        summarySuppressed: true,
      };
    }
    const recoveredCheckpointIds = legacySuppressedSummaryIdsCoveredBy(
      latestMemsBeforeWrite,
      deltaMessageIds,
    ).filter((id) => id !== globalSummaryMemory.id);
    await Promise.all(recoveredCheckpointIds.map((id) => (
      db.deleteRecord('memories', id).catch(() => null)
    )));
    for (const roleSummaryMemory of roleSummaryMemories) {
      await saveMemory(roleSummaryMemory);
    }

    const currentSummaryIds = new Set([
      globalSummaryMemory.id,
      ...roleSummaryMemories.map((memory) => memory.id),
    ]);
    const priorSummaries = (Array.isArray(latestMemsBeforeWrite) ? latestMemsBeforeWrite : [])
      .filter((memory) => (
        memory?.type === 'summary'
        && (!memory.userId || memory.userId === userId)
        && !currentSummaryIds.has(memory.id)
      ));
    if (priorSummaries.length) {
      await db.putMany('memories', priorSummaries.map((memory) => ({
        ...memory,
        hotSummary: false,
        vectorArchived: true,
      })));
    }

    if (!isolatedAlias) {
      try {
        await persistEventMemoriesFromRaw({
          rawText: result,
          userId,
          chat,
          defaultChatId: chat.id,
          defaultVisibility: isGroup ? 'spreading' : 'private',
          defaultTimestamp: deltaEndTs,
          sourceKey: `chat-summary:${chat.id}:${summaryRangeKey}`,
        });
      } catch (_) {}
      try {
        await persistMemoryFactsFromRaw({
          rawText: result,
          userId,
          chat,
          defaultChatId: chat.id,
          sourceKey: `chat-summary:${chat.id}:${summaryRangeKey}`,
          defaultEvidenceAt: deltaEndTs,
        });
      } catch (_) {}
    }
    const relationshipChanges = parseRelationshipChanges(result, roleIds);
    for (const change of relationshipChanges) {
      await recordAcquaintance(change.a, change.b, {
        level: 'familiar',
        label: change.label,
        source: 'ai',
      }).catch(() => {});
    }

    return {
      ok: true,
      deltaCount: delta.length,
      rangeText,
      messageRange: hasManualRange ? { from: rangeFrom, to: rangeTo } : null,
    };
  } catch (error) {
    return { ok: false, reason: 'error', message: error?.message || String(error) };
  } finally {
    releaseSummaryTask(summaryKey);
    releaseSummaryStorageLease(storageLease);
  }
}

/**
 * 将用户指定的一段聊天单次提炼成「共同回忆」。
 * 同一消息范围使用稳定 id，重复提取会刷新原条目，不会不断制造重复记忆。
 */
async function extractChatSharedMemoryUnlocked({
  chat,
  userId,
  currentUserName = '用户',
  resolveName = (id) => id,
  messageRange = null,
  focusHint = '',
} = {}) {
  if (!chat?.id || !userId) return { ok: false, reason: 'missing-chat-or-user' };
  const { sorted } = await loadSummaryRows(chat.id, userId);
  if (!sorted.length) return { ok: false, reason: 'no-messages' };

  const requestedFrom = Math.trunc(Number(messageRange?.from));
  const requestedTo = Math.trunc(Number(messageRange?.to));
  if (!Number.isFinite(requestedFrom) || !Number.isFinite(requestedTo)) {
    return { ok: false, reason: 'invalid-range' };
  }
  const from = Math.max(1, Math.min(sorted.length, requestedFrom));
  const to = Math.max(1, Math.min(sorted.length, requestedTo));
  if (from > to) return { ok: false, reason: 'invalid-range' };
  const selected = sorted.slice(from - 1, to);
  if (!selected.length) return { ok: false, reason: 'no-messages' };

  const textRows = await Promise.all(selected.map(async (message) => {
    const resolvedName = message.senderId && message.senderId !== 'user'
      ? await Promise.resolve(resolveName(message.senderId))
      : '';
    const sender = message.senderId === 'user'
      ? currentUserName
      : resolveSummaryActorLabel(chat, message.senderId, resolvedName, message.senderName);
    const sid = message.senderId === 'user' ? 'user' : (message.senderId || 'unknown');
    return `[发言者:${sender || '未知人物'} · 角色ID:${sid}] ${compactMessageWithMentionContext(message, chat, currentUserName)}`;
  }));
  const textBlock = buildCappedSummaryTextBlock(textRows);
  const rangeText = `${formatTs(selected[0]?.timestamp)} ~ ${formatTs(selected[selected.length - 1]?.timestamp)}`;
  const manualFocusHint = String(focusHint || '').replace(/\s+/g, ' ').trim().slice(0, 240);
  const focusBlock = manualFocusHint
    ? `用户特别希望补记的重点：${manualFocusHint}\n必须优先围绕这个重点提炼；只能采用聊天中确实存在的证据，不要按用户提示补写未发生的事。`
    : '用户未指定具体重点：请选择对未来关系或剧情影响最大、最值得长期保留的一件事。';
  const summaryResponse = await requestSummaryTask([
    {
      role: 'user',
      content: `请把下面这一段聊天提炼成一条可长期保留的「共同回忆」。

要求：
- 只写已经发生的事，不补写聊天中没有的信息。
- 写清谁和谁、发生了什么、结果或仍未完成的部分；保留对以后续聊有用的情绪与关系变化。
- 忽略寒暄、重复句和无关水聊。
- 用第三人称写 1～3 句完整中文，控制在 300 字内。
- 只输出 JSON：{"content":"共同回忆正文"}，不要 Markdown 或解释。

${focusBlock}

会话类型：${chat.type === 'group' ? '群聊' : '私聊'}
消息区间：${rangeText}

聊天记录：
${textBlock}`,
    },
  ], { temperature: 0.2 }, 'chatSummary');
  const result = summaryResponse.text;
  const content = parseSharedMemoryExtraction(result);
  if (!content) {
    if (!result.trim()) return buildEmptyChatSummaryFailure({
      completionMeta: summaryResponse.completionMeta,
      requestStat: summaryResponse.requestStat,
    });
    return { ok: false, reason: 'invalid-output' };
  }

  const sourceMessageIds = selected.map((message) => String(message?.id || '')).filter(Boolean);
  const rangeKey = sourceMessageIds.length
    ? sourceMessageIds.join('|')
    : `${selected[0]?.timestamp || 0}|${selected[selected.length - 1]?.timestamp || 0}|${selected.length}`;
  const focusKey = manualFocusHint ? `|focus:${manualFocusHint}` : '';
  const id = `mem_shared_manual_${stableMemoryRangeHash(`${chat.id}|${rangeKey}${focusKey}`)}`;
  const existed = await db.getRecord('memories', id).catch(() => null);
  const partnerId = chat.type === 'group'
    ? ''
    : String((chat.participants || []).find((actorId) => actorId && actorId !== 'user') || '');
  const memory = createMemory({
    id,
    chatId: chat.id,
    characterId: partnerId,
    userId,
    type: 'event',
    category: 'shared',
    content,
    importance: 'high',
    timestamp: Number(selected[selected.length - 1]?.timestamp || 0) || await getNowForUser(userId),
    source: 'api-shared-memory-manual',
  });
  memory.sourceMessageIds = sourceMessageIds;
  memory.messageRange = { from, to };
  if (manualFocusHint) memory.manualFocusHint = manualFocusHint;
  await saveMemory(memory);
  return { ok: true, stored: 1, updated: !!existed, rangeText, messageRange: { from, to } };
}

async function runManualChatSummaryExclusive(chat, userId, runner) {
  const summaryKey = summaryTaskKey(userId, chat?.id);
  if (!summaryKey || SUMMARY_IN_FLIGHT.has(summaryKey)) return { ok: false, reason: 'in-flight' };
  const storageLease = claimSummaryStorageLease(summaryKey);
  if (!storageLease.acquired) return { ok: false, reason: 'in-flight' };
  SUMMARY_IN_FLIGHT.add(summaryKey);
  try {
    return await runner();
  } finally {
    releaseSummaryTask(summaryKey);
    releaseSummaryStorageLease(storageLease);
  }
}

export async function extractChatSharedMemory(options = {}) {
  return runManualChatSummaryExclusive(options.chat, options.userId, () => (
    extractChatSharedMemoryUnlocked(options)
  ));
}

async function extractChatMemoryFactsUnlocked({
  chat,
  userId,
  currentUserName = '用户',
  resolveName = (id) => id,
  limit = 160,
} = {}) {
  if (!chat?.id || !userId) return { ok: false, reason: 'missing-chat-or-user' };
  const cap = Math.max(20, Math.min(500, Number(limit) || 160));
  const allMessages = await db.getAllByIndex('messages', 'chatId', chat.id);
  const sorted = filterNonGuidanceMessages([...allMessages]
    .filter((m) => !m.deleted && !m.recalled))
    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
    .slice(-cap);
  if (!sorted.length) return { ok: false, reason: 'no-messages' };

  const isGroup = chat.type === 'group';
  const roleIds = (chat.participants || []).filter((id) => id && id !== 'user');
  const currentUserRow = userId ? await db.getRecord('users', userId) : null;
  const anonymousCurrentUserName = isAnonymousChat(chat) ? '匿名网友' : currentUserName;
  const anonymousOptions = {
    currentUserName: anonymousCurrentUserName,
    userRow: currentUserRow,
  };
  const formatSummaryText = (value = '') => (
    isAnonymousChat(chat)
      ? replaceTextWithAnonymousIds(String(value || ''), chat, anonymousOptions)
      : String(value || '')
  );
  const roleDisplayEntries = await Promise.all(roleIds.map(async (id) => {
    const resolvedName = await Promise.resolve(resolveName(id));
    const display = isAnonymousChat(chat)
      ? (getAnonymousDisplayProfile(chat, id, anonymousOptions)?.anonymousId || resolvedName)
      : resolveSummaryActorLabel(chat, id, resolvedName);
    return `${id}:${display}`;
  }));
  const roleLine = roleDisplayEntries.join('，');
  const textRows = await Promise.all(sorted.map(async (m) => {
    const resolvedName = m.senderId && m.senderId !== 'user'
      ? await Promise.resolve(resolveName(m.senderId))
      : '';
    const sender = m.senderId === 'user'
      ? (isAnonymousChat(chat)
        ? (getAnonymousDisplayProfile(chat, 'user', anonymousOptions)?.anonymousId || anonymousCurrentUserName)
        : currentUserName)
      : (isAnonymousChat(chat)
        ? (getAnonymousDisplayProfile(chat, m.senderId, anonymousOptions)?.anonymousId || m.senderName || resolvedName)
        : resolveSummaryActorLabel(chat, m.senderId, resolvedName, m.senderName));
    const sid = m.senderId === 'user' ? 'user' : (m.senderId || 'unknown');
    return `[发言者:${sender} · 角色ID:${sid}] ${formatSummaryText(compactMessageWithMentionContext(m, chat, currentUserName))}`;
  }));
  const textBlock = buildCappedSummaryTextBlock(textRows);
  const rangeText = `${formatTs(sorted[0]?.timestamp)} ~ ${formatTs(sorted[sorted.length - 1]?.timestamp)}`;
  const anonymousPrompt = isAnonymousChat(chat)
    ? [
      buildAnonymousSummaryProtocol(chat, anonymousOptions),
      '[匿名结构化记忆要求]\n- 只允许使用本房匿名ID叙述 subjectName/objectName/knownBy。\n- 禁止输出真实姓名、住址、联系方式等可识别信息。\n- 群跳私聊只把来源群公屏事实视为双方共同背景；私聊事实默认 private_to_pair。',
    ].filter(Boolean).join('\n\n')
    : '';
  const timeBlock = await buildTimeAndHolidayPromptBlock(userId);
  const vt = [
    timeBlock,
    buildSummaryAttributionRuleBlock(),
    buildEphemeralLanguageMemoryRuleBlock(),
    buildCharacterEvolutionExtractionRuleBlock({ roleLine, userName: currentUserName }),
  ].filter(Boolean).join('\n\n') + '\n\n';
  const systemPrompt = `${vt}${anonymousPrompt ? `${anonymousPrompt}\n\n` : ''}

你是结构化记忆表格整理器。请从聊天记录中提取“未来续写真正有用的小事实”，不要写普通摘要，不要写会议纪要。

只记录这些类型：
- group_meme：已被多人主动复用、持续正面接住，确实形成的群内梗；单次昵称、冷梗、比喻不得记录
- relationship_impression：关系印象、熟悉度变化、谁对谁的态度
- preference：偏好、习惯、雷点
- secret：秘密、私密信息、只限部分人知道的内容
- promise：约定、待办、承诺
- topic_affinity：对某类话题的兴趣/排斥
- boundary：明确边界、禁区、不想被提的事
- status：阶段性状态，确实会影响后续对话才写
- character_evolution_signal：角色经过共同经历后形成的软变化；严格服从上方“角色演化信号”证据门槛

输出格式严格如下，只输出这一段，不要解释，不要 Markdown：
【记忆:结构化表格】
[
  {
    "subjectName": "事实归属者（外号/头衔是谁的、事是谁做的、偏好是谁的，就写谁；人物名或匿名ID）",
    "objectName": "对象，可空",
    "factType": "group_meme/relationship_impression/preference/secret/promise/topic_affinity/boundary/status/character_evolution_signal",
    "canonicalKey": "归属者|factType|具体主题；同一事实换句话说仍使用同一键",
    "content": "一句可检索的小事实，<=90字；必须自带主语（写清「谁」怎么样），禁止省略主语",
    "evidence": "依据或短原话，可空，<=60字",
    "confidence": 0.75,
    "visibility": "${isGroup ? 'group_public' : 'private'}",
    "knownBy": { "人物或匿名ID": "involved/known/heard" },
    "tags": ["标签"],
    "temporalState": "planned/ongoing/completed/evergreen",
    "expiresAt": 0
  }
]
【/记忆】

要求：
1) 最多输出 10 条，宁缺毋滥。
2) 不要把水聊、寒暄、一次性笑声、已彻底结束的小插曲硬写进表格。
3) 同一事实只写一条；能合并就合并。
3.1) canonicalKey 必须具体到偏好对象、约定事项或关系主题；禁止只写“饮食偏好”“关系印象”这类会把不同事实混在一起的宽泛键。
3.5) 归属零容错：先看每条发言前的 [发言者:… · 角色ID:…] 再下笔——外号/头衔/梗被安在谁头上、事是谁做的、话是谁说的，subjectName 和 content 主语必须写那个人，严禁写反（尤其不要把角色自己的外号/事迹记到用户头上，或反过来）。分不清归属的直接不写这条。
4) ${isAnonymousChat(chat) ? '匿名房必须使用匿名ID，不得写真名。' : `角色ID参考：${roleLine || '（无）'}`}
5) temporalState：preference/relationship_impression/secret/topic_affinity/boundary 默认 evergreen（不涉及"完不完成"）；group_meme 仅在确有多人主动复用与持续正面接梗证据时写 evergreen，单次出现不输出；promise/status 中明确未来日期尚未到写 planned，还没兑现或状态仍持续写 ongoing，已兑现、日期已过或已不了了之写 completed。expiresAt 在 promise/status 为 planned 或 ongoing 且原文有明确兑现日期时填写大致到期毫秒时间戳，判断不出来写 0；不得把已过日期顺延成今天或明天。`;

  const summaryResponse = await requestSummaryTask([
    {
      role: 'user',
      content:
        `${systemPrompt}\n\n`
        + `【会话类型】${isGroup ? '群聊' : '私聊'}\n`
        + `【区间】${rangeText}\n\n`
        + `以下是最近 ${sorted.length} 条聊天记录：\n${textBlock}`,
    },
  ], { temperature: 0.2 }, 'memoryFacts');
  const result = summaryResponse.text;
  if (!result.trim()) return buildEmptyChatSummaryFailure({
    completionMeta: summaryResponse.completionMeta,
    requestStat: summaryResponse.requestStat,
  });
  const persisted = await persistMemoryFactsFromRaw({
    rawText: result,
    userId,
    chat,
    defaultChatId: chat.id,
    sourceKey: `memory-facts:${chat.id}:${stableMemoryRangeHash([
      chat.id,
      ...sorted.map((message) => String(message?.id || message?.timestamp || '')),
    ].join('|'))}`,
    defaultEvidenceAt: Number(sorted[sorted.length - 1]?.timestamp || Date.now()),
  });
  return { ok: true, stored: persisted.stored || 0, scanned: sorted.length, rangeText };
}

export async function extractChatMemoryFacts(options = {}) {
  return runManualChatSummaryExclusive(options.chat, options.userId, () => (
    extractChatMemoryFactsUnlocked(options)
  ));
}
