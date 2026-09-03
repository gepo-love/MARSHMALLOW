import { selectArchiveAudienceScope } from '../context/context-injection-scope.js';
import { buildOfflineAttributionBoundary } from './offline-attribution.js';

const DEFAULT_MAX_CHARACTER_TURNS = 3;
const DEFAULT_COMPACT_CHARACTER_TURNS = 8;
const DEFAULT_MAX_RESUMED_MESSAGES = 20;
export const OFFLINE_RETURN_PROACTIVE_COOLDOWN_MS = 30 * 60 * 1000;

function clean(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function clip(value = '', limit = 1200) {
  const text = clean(value);
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/** 超限时保留开头摘要段和结尾前情提要段，砍中间。 */
function clipKeepTail(value = '', limit = 1200) {
  const text = clean(value);
  if (text.length <= limit) return text;
  const headLen = Math.floor(limit * 0.4);
  const tailLen = limit - headLen;
  return `${text.slice(0, headLen)}…（中段略）…${text.slice(-tailLen)}`;
}

function formatAbsoluteTime(timestamp = 0) {
  const value = Number(timestamp || 0);
  if (!value || !Number.isFinite(value)) return '时间未标';
  return new Date(value).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatRelativeTime(timestamp = 0, now = Date.now()) {
  const value = Number(timestamp || 0);
  const current = Number(now || Date.now());
  if (!value || !Number.isFinite(value) || !Number.isFinite(current)) return '';
  const delta = Math.max(0, current - value);
  if (delta < 3 * 60 * 1000) return '刚刚';
  if (delta < 60 * 60 * 1000) return `${Math.floor(delta / 60000)}分钟前`;
  if (delta < 24 * 60 * 60 * 1000) {
    const hours = Math.floor(delta / 3600000);
    const minutes = Math.floor((delta % 3600000) / 60000);
    return `${hours}小时前${minutes ? `${minutes}分` : ''}`;
  }
  const days = Math.floor(delta / 86400000);
  const hours = Math.floor((delta % 86400000) / 3600000);
  return `${days}天前${hours ? `${hours}小时` : ''}`;
}

function listDigestLine(label, values = [], limit = 3) {
  const rows = (Array.isArray(values) ? values : [])
    .map((value) => clip(value, 180))
    .filter(Boolean)
    .slice(0, limit);
  return rows.length ? `- ${label}：${rows.join('；')}` : '';
}

function quoteDigestLine(quotes = []) {
  const rows = (Array.isArray(quotes) ? quotes : [])
    .map((quote) => {
      const line = clip(quote?.line, 180);
      if (!line) return '';
      const speaker = clip(quote?.speaker, 32);
      return speaker ? `${speaker}「${line}」` : `「${line}」`;
    })
    .filter(Boolean)
    .slice(0, 3);
  return rows.length ? `- 关键台词：${rows.join('；')}` : '';
}

function normalizedBigrams(value = '') {
  const text = clean(value)
    .toLowerCase()
    .replace(/[，。！？、；：,.!?;:'"“”‘’（）()[\]{}<>《》【】\s]/g, '');
  const result = new Set();
  for (let index = 0; index < text.length - 1; index += 1) {
    result.add(text.slice(index, index + 2));
  }
  return result;
}

function textIsRelated(left = '', right = '') {
  const leftTokens = normalizedBigrams(left);
  const rightTokens = normalizedBigrams(right);
  if (!leftTokens.size || !rightTokens.size) return false;
  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) overlap += 1;
  }
  return overlap >= 2;
}

function messageCreatedAtReal(message = {}) {
  const explicit = Number(
    message?.createdAt
    || message?.metadata?.createdAtReal
    || message?.metadata?.createdAt
    || message?.metadata?.aiRoundCreatedAt
    || 0,
  );
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const idMatch = String(message?.id || '').match(/^msg_(\d{10,})_/);
  const fromId = Number(idMatch?.[1] || 0);
  return Number.isFinite(fromId) && fromId > 0 ? fromId : 0;
}

function archiveCreatedAtReal(archive = {}) {
  const explicit = Number(archive?.archivedAtReal || 0);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  // 旧版 oda_<Date.now().toString(36)>_<random> 已自带真实创建时间。
  const idMatch = String(archive?.id || '').match(/^oda_([a-z0-9]+)_/i);
  const fromId = Number.parseInt(idMatch?.[1] || '', 36);
  return Number.isFinite(fromId) && fromId > 0 ? fromId : 0;
}

function messagesAfterArchive(messages = [], archive = {}) {
  const endedAt = Number(archive?.endedAt || archive?.startedAt || 0);
  const archivedAtReal = archiveCreatedAtReal(archive);
  return (Array.isArray(messages) ? messages : []).filter((message) => {
    if (!message || message.deleted || message.recalled) return false;
    if (message.senderId === 'system' || message.type === 'system') return false;
    if (archivedAtReal > 0) {
      const createdAtReal = messageCreatedAtReal(message);
      if (createdAtReal > 0) return createdAtReal > archivedAtReal;
    }
    // 旧档案没有真实收纳边界，只能沿用世界时间兼容。
    return Number(message.timestamp || 0) > endedAt;
  });
}

function selectLatestArchiveForTargets(archives = [], targets = new Set(), { preferRealArchiveTime = false } = {}) {
  return (Array.isArray(archives) ? archives : [])
    .filter((archive) => {
      if (!archive) return false;
      const scope = selectArchiveAudienceScope(archive, [...targets]);
      if (!targets.size) return true;
      if (targets.size > 1) return scope.allInRoster;
      return scope.allInRoster || scope.owned.length > 0;
    })
    .slice()
    .sort((left, right) => {
      if (preferRealArchiveTime) {
        const realDelta = archiveCreatedAtReal(right) - archiveCreatedAtReal(left);
        if (realDelta) return realDelta;
      }
      return Number(right.endedAt || right.startedAt || 0) - Number(left.endedAt || left.startedAt || 0);
    })[0] || null;
}

/**
 * 线下刚收纳、用户尚未重新开口时，把下一次后台主动机会改造成一次返线上承接轮。
 * 承接轮之后，其他后台主动消息先让路；用户一回复就立即恢复，避免把正常对话也锁住。
 */
export function resolveOfflineReturnProactiveState({
  archives = [],
  characterIds = [],
  messages = [],
  now = Date.now(),
  cooldownMs = OFFLINE_RETURN_PROACTIVE_COOLDOWN_MS,
} = {}) {
  const targets = new Set(
    (Array.isArray(characterIds) ? characterIds : [])
      .map((id) => String(id || '').trim())
      .filter(Boolean),
  );
  const latest = selectLatestArchiveForTargets(archives, targets, { preferRealArchiveTime: true });
  if (!latest) return { mode: 'normal', reason: 'no-offline-archive' };

  const resumedMessages = messagesAfterArchive(messages, latest);
  const userResumed = resumedMessages.some((message) => (
    message.senderId === 'user' && message.metadata?.userComposedAsCharacter !== true
  ));
  if (userResumed) {
    return { mode: 'normal', reason: 'user-resumed', archiveId: String(latest.id || '') };
  }

  const manualCharacterRound = resumedMessages.some((message) => (
    message.senderId
    && message.senderId !== 'user'
    && message.senderId !== 'system'
    && message.type !== 'system'
    && !String(message.metadata?.proactiveChannel || '').trim()
  ));
  if (manualCharacterRound) {
    return { mode: 'normal', reason: 'manual-return-complete', archiveId: String(latest.id || '') };
  }

  const bridgeMessages = resumedMessages.filter((message) => message.metadata?.offlineReturnBridge === true);
  if (!bridgeMessages.length) {
    return {
      mode: 'bridge',
      reason: 'offline-return-pending',
      archiveId: String(latest.id || ''),
      archivedAtReal: archiveCreatedAtReal(latest),
    };
  }

  const bridgeAt = bridgeMessages.reduce((latestAt, message) => (
    Math.max(latestAt, messageCreatedAtReal(message))
  ), 0);
  const waitMs = Math.max(0, Number(cooldownMs) || OFFLINE_RETURN_PROACTIVE_COOLDOWN_MS);
  const elapsed = Number(now || Date.now()) - bridgeAt;
  if (bridgeAt > 0 && elapsed >= 0 && elapsed < waitMs) {
    return {
      mode: 'defer',
      reason: 'offline-return-proactive-cooldown',
      archiveId: String(latest.id || ''),
      retryAt: bridgeAt + waitMs,
    };
  }
  return { mode: 'normal', reason: 'offline-return-bridge-complete', archiveId: String(latest.id || '') };
}

export function buildOfflineReturnProactiveDirective() {
  return [
    '[线下收纳后的返线上承接轮]',
    '这是最近一次线下收纳后的第一轮主动联系。完整档案、角色亲历记忆、结束时间与返线上事实锚已经由聊天上下文提供；本轮必须从线下结束后的关系、情绪和认知继续。',
    '本轮优先完成跨模式承接，暂不执行原本触发这次机会的日程分享、链接分享、备忘录话题、冷场重启或其它主动主题；那些机会应留到之后。',
    '不要声称不记得、没印象或退回见面前的相处状态，也不要把已经完成的线下重新演一遍。根据标注的真实先后与距今时间自然开口；可以只让语气和态度体现经历，不必复述摘要、汇报细节或强行续接伏笔。',
  ].join('\n');
}

function countCharacterReplyRounds(messages = []) {
  const seenAiRounds = new Set();
  let rounds = 0;
  let legacyBlockOpen = false;
  for (const message of (Array.isArray(messages) ? messages : [])) {
    if (!message || message.deleted || message.recalled) continue;
    if (message.senderId === 'user' || message.metadata?.userComposedAsCharacter === true) {
      legacyBlockOpen = false;
      continue;
    }
    if (!message.senderId || message.senderId === 'system' || message.type === 'system') continue;
    // 纯后台主动消息不代表用户与角色已经形成新的线上节奏，不能连续烧掉返线上事实锚。
    // 唯一例外是线下收纳后的专用承接轮：它作为返线上第一轮正常计数。
    if (String(message.metadata?.proactiveChannel || '').trim()
      && message.metadata?.offlineReturnBridge !== true) {
      legacyBlockOpen = false;
      continue;
    }
    const aiRoundId = String(message.metadata?.aiRoundId || '').trim();
    if (aiRoundId) {
      legacyBlockOpen = false;
      if (!seenAiRounds.has(aiRoundId)) {
        seenAiRounds.add(aiRoundId);
        rounds += 1;
      }
      continue;
    }
    // 旧消息没有 aiRoundId：用户两次发言之间连续出现的角色气泡视为一轮回复。
    if (!legacyBlockOpen) {
      rounds += 1;
      legacyBlockOpen = true;
    }
  }
  return rounds;
}

/**
 * 在线下收纳后尚未形成新的线上节奏时，保证模型看见最近一次线下的时间与事实。
 * “强”只表示时间顺序不可忽略，不表示必须继续谈论线下；长期记忆仍由统一事件时间轴负责。
 */
export function buildLatestOfflineReturnContext({
  archives = [],
  characterIds = [],
  messages = [],
  now = Date.now(),
  maxCharacterTurns = DEFAULT_MAX_CHARACTER_TURNS,
  maxCompactCharacterTurns = DEFAULT_COMPACT_CHARACTER_TURNS,
  maxResumedMessages = DEFAULT_MAX_RESUMED_MESSAGES,
} = {}) {
  const targets = new Set(
    (Array.isArray(characterIds) ? characterIds : [])
      .map((id) => String(id || '').trim())
      .filter(Boolean),
  );
  const latest = selectLatestArchiveForTargets(archives, targets, { preferRealArchiveTime: true });
  if (!latest) return '';

  const endedAt = Number(latest.endedAt || latest.startedAt || 0);
  if (!endedAt) return '';
  const resumedMessages = messagesAfterArchive(messages, latest);
  // 一轮回复可能拆成很多气泡，只按“角色轮数”会让返线上强锚在界面上
  // 已经过了几十条新消息后仍然存活。线上消息积累到一定规模后，时间顺序
  // 已由真实聊天本身确立；旧线下事实退回统一记忆按需召回，不再常驻当前轮。
  const resumedMessageLimit = Math.max(1, Number(maxResumedMessages) || DEFAULT_MAX_RESUMED_MESSAGES);
  const resumedConversationMessages = resumedMessages.filter((message) => (
    !String(message?.metadata?.proactiveChannel || '').trim()
    || message?.metadata?.offlineReturnBridge === true
  ));
  if (resumedConversationMessages.length >= resumedMessageLimit) return '';
  const characterTurns = countCharacterReplyRounds(resumedMessages);
  const fullTurns = Math.max(1, Number(maxCharacterTurns) || DEFAULT_MAX_CHARACTER_TURNS);
  const compactTurns = Math.max(fullTurns + 1, Number(maxCompactCharacterTurns) || DEFAULT_COMPACT_CHARACTER_TURNS);
  if (characterTurns >= compactTurns) return '';
  const compact = characterTurns >= fullTurns;

  const archiveScope = selectArchiveAudienceScope(latest, [...targets]);
  const ownedMemories = archiveScope.owned;
  const lines = [];
  // 线上已经有几轮真实对话后，旧卷宗只负责防止时间线倒退；
  // 具体情绪、地点和伏笔退回统一记忆按话题召回，不再常驻当前轮。
  if (!compact && targets.size === 1 && ownedMemories.length) {
    for (const entry of ownedMemories) {
      const name = clean(entry.characterName || entry.characterId || 'TA');
      const boundary = buildOfflineAttributionBoundary({
        currentCharacterId: entry.characterId,
        currentCharacterName: name,
        participantIds: latest.participantIds || latest.participantSnapshot?.actorIds || [],
        participantNames: latest.participantNames || latest.participantSnapshot?.names || [],
        quotes: latest.digest?.quotes || [],
      });
      if (boundary && !String(entry.content || '').includes('【多人线下说话人归属】')) {
        lines.push(`- ${boundary}`);
      }
      // 记忆正文的结尾是「前情提要」，截断方向必须保尾，头部靠摘要兜底。
      lines.push(`- ${name}亲历并记得：${clipKeepTail(entry.content, compact ? 900 : 2400)}`);
    }
  } else if (!compact && targets.size > 1 && archiveScope.canUseSharedSummary) {
    const summary = clip(latest.summary, 1200);
    if (summary) lines.push(`- 共同经历摘要：${summary}`);
  }

  // 卷宗是全场视角。只有当前角色都有完整在场记忆时才展开，避免给中途加入/离场者泄漏不可见剧情。
  const everyTargetCoveredAll = archiveScope.canUseSharedSummary;
  if (!compact && everyTargetCoveredAll && latest.digest) {
    const story = clip(latest.digest.story, 900);
    if (story) lines.push(`- 完整剧情复盘：${story}`);
    const recentUserText = resumedMessages
      .filter((message) => message.senderId === 'user')
      .slice(-3)
      .map((message) => clean(message.content))
      .filter(Boolean)
      .join(' ');
    const relevantHooks = (Array.isArray(latest.digest.hooks) ? latest.digest.hooks : [])
      .filter((hook) => textIsRelated(recentUserText, hook));
    lines.push(
      quoteDigestLine(latest.digest.quotes),
      listDigestLine('情感与认知变化', latest.digest.shifts),
      listDigestLine('关键物品与伏笔', latest.digest.items),
      listDigestLine('用户本轮提到的存档线索（仅回应当前话题，不是待办）', relevantHooks),
    );
  }

  const relative = formatRelativeTime(endedAt, now);
  const mayUseArchiveDetails = (targets.size === 1 && ownedMemories.length > 0)
    || archiveScope.canUseSharedSummary;
  const place = mayUseArchiveDetails ? clip(latest.scene?.place || latest.scene?.goal, 80) : '';
  const onlineUserTurns = resumedMessages.filter((message) => message.senderId === 'user').length;
  return [
    compact
      ? '【跨模式事实锚 · 最近一次线下已经结束】'
      : '【跨模式时间锚 · 最近一次线下已经结束】',
    '这段内容用于校准先后顺序与角色已知事实，不是要求本轮继续聊线下。',
    '多人归属要求：共同经历或“某角色亲历并记得”只代表知情范围，不代表摘要里的所有台词和行为都属于当前角色；必须按明确姓名、角色ID与说话人标签归属，禁止把同行角色的话认成自己说过。',
    `线下于 ${formatAbsoluteTime(endedAt)}${relative ? `（距今${relative}）` : ''}${place ? `在「${place}」` : ''}结束并收纳；“距今”可能是刚刚、昨天或更早，必须按标注时间理解，不要一律写成刚结束。`,
    compact
      ? `结束后本聊天已有 ${characterTurns} 轮角色回复、${onlineUserTurns} 条用户消息；线上节奏已经形成。此处只校准“那次线下已结束”的先后顺序，不再注入当时的具体情绪、地点、话题或伏笔；具体经历只在当前话题相关时由长期记忆召回。`
      : `结束后本聊天目前有 ${characterTurns} 轮角色回复、${onlineUserTurns} 条用户消息；新的线上节奏尚未完全形成，因此暂时保留这枚时间锚。`,
    ...lines.filter(Boolean),
    '事实要求：上述经历及其关系、情绪、认知和物品后果均已发生。API 历史中早于结束时间的线上消息属于见面前旧记录，不得把时间线退回线下之前，也不得把已完成线下重新演一遍。',
    '承接要求：本轮用户发言发生在这段线下经历之后。角色可以因当前话语而惊讶、迟疑或确认，但不能用“我不记得”“没印象”“我们见过吗”“您刚才说什么”等失忆式反应绕开已经发生的经历；回应必须建立在角色亲历并记得上述事实的前提上。',
    '话题要求：当前用户消息决定聊什么。卷宗里的伏笔、悬念只是存档线索，不是角色必须惦记或主动推进的待办；只有用户本轮明确提到相关线索时才可回应。禁止主动复述摘要、逐项汇报细节、强行续接悬念或连续多轮围着线下打转。用户开启新话题时可以完全聊新话题。',
  ].join('\n');
}
