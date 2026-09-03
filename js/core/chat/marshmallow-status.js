import { patchChatPrefs, loadChatPrefs } from '../chat-block-state.js';
import { defaultStatusTtlMs, saveChatStatusWithTtl } from '../status-ttl.js';
import { saveMessage } from '../chat-store.js';
import { createMessage } from '../../models/chat.js';
import { applyAiCharacterStatusLine, loadCharacterLiveState } from '../character-live-state.js';

function clean(value = '', max = 120) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

// 状态是角色自己写的一句话（像签名档），不再压到 10 字的词组。
export const MARSHMALLOW_STATUS_TEXT_MAX = 40;
const STATUS_STORY_MIN_CHARS = 30;
const STATUS_STORY_MAX_CHARS = 1600;
const PRESENCE_STATES = new Set(['online', 'away', 'busy', 'offline']);

function normalizePresenceState(value = '') {
  const state = String(value || '').trim().toLowerCase();
  return PRESENCE_STATES.has(state) ? state : 'online';
}

export function normalizeMarshmallowStatusText(input = '') {
  return String(input || '')
    .replace(/\r?\n/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/[【】\[\]<>]/g, '')
    .trim()
    .slice(0, MARSHMALLOW_STATUS_TEXT_MAX);
}

export function normalizeStatusStoryText(input = '') {
  const text = String(input || '')
    .replace(/\r/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, STATUS_STORY_MAX_CHARS);
  return text.length >= STATUS_STORY_MIN_CHARS ? text : '';
}

/** 模型漏掉 story 时的最后兜底：只复述本轮已经落下的真实场景与公开短句，不补新事实。 */
export function buildStatusStoryFallbackText(scene = '', statusText = '', presenceState = 'online') {
  const currentScene = clean(scene, 220);
  const publicLine = normalizeMarshmallowStatusText(statusText);
  if (!currentScene && !publicLine) return '';
  const presenceLabel = ({ away: '暂离', busy: '忙碌', offline: '离线', online: '在线' })[
    normalizePresenceState(presenceState)
  ] || '在线';
  return [
    currentScene
      ? `镜头转到这一刻，TA 此时的现实场景是：${currentScene}。`
      : `镜头转到这一刻，TA 的在线状态已经变为${presenceLabel}。`,
    publicLine
      ? `这段没有发进聊天的间隙，最后只在状态栏留下了“${publicLine}”。`
      : `这次变化没有变成新的聊天内容，只安静地留在了状态栏里。`,
  ].join('\n\n');
}

/** 状态变更的系统小字：仅私聊对手方、文本真的变了才值得提示一行。 */
export function buildStatusChangeHintText(name = 'TA', statusText = '', presenceState = 'online') {
  const who = clean(name, 24) || 'TA';
  const text = clean(statusText, MARSHMALLOW_STATUS_TEXT_MAX);
  if (text) return `${who} 更新了状态：${text}`;
  if (presenceState === 'offline') return `${who} 的状态变成了离线`;
  if (presenceState === 'busy') return `${who} 的状态变成了忙碌`;
  if (presenceState === 'away') return `${who} 暂时离开了`;
  return '';
}

export function findLatestCounterpartStatus(events = [], counterpart = '', participantIds = []) {
  const target = String(counterpart || '').trim();
  const participants = new Set((Array.isArray(participantIds) ? participantIds : [])
    .map((id) => String(id || '').trim())
    .filter(Boolean));
  if (!target || (participants.size && !participants.has(target))) return null;
  const items = Array.isArray(events) ? events : [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const event = items[index];
    const actorId = String(event?.actor || event?.from || '').trim();
    if (actorId !== target || (participants.size && !participants.has(actorId))) continue;
    return {
      actorId,
      statusText: normalizeMarshmallowStatusText(event?.statusText || event?.status || event?.body || event?.text),
      presenceState: normalizePresenceState(event?.presenceState || event?.presence),
    };
  }
  return null;
}

export function resolveStatusTimelineTimestamp(messages = [], fallback = Date.now()) {
  const latest = (Array.isArray(messages) ? messages : []).reduce((max, message) => (
    Math.max(max, Number(message?.timestamp || 0) || 0)
  ), 0);
  return latest > 0 ? latest + 1 : (Number(fallback) || Date.now());
}

async function persistStatusTimelineEntries({
  chatId,
  actorId,
  actorName,
  statusText,
  presenceState,
  story,
  storyEnabled,
  timelineTs,
  aiRoundId,
}) {
  const hintText = buildStatusChangeHintText(actorName, statusText, presenceState);
  const baseTs = Number(timelineTs || 0) || Date.now();
  const saved = { hintId: '', storyId: '' };
  if (hintText) {
    const hint = createMessage({
      chatId,
      senderId: 'system',
      senderName: '系统',
      type: 'system',
      content: hintText,
      timestamp: baseTs,
      metadata: { statusChangeHint: true, statusActorId: actorId, aiRoundId },
    });
    await saveMessage(hint);
    saved.hintId = hint.id;
  }
  const storyText = storyEnabled ? normalizeStatusStoryText(story) : '';
  if (storyText) {
    const paragraphs = storyText.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
    const summary = clean(paragraphs[0] || storyText, 60);
    const card = createMessage({
      chatId,
      senderId: 'system',
      senderName: '系统',
      type: 'storyCard',
      content: storyText,
      timestamp: baseTs + 1,
      metadata: {
        title: clean(statusText, MARSHMALLOW_STATUS_TEXT_MAX) || '状态更新',
        badge: '状态小剧场',
        summary,
        fullText: storyText,
        paragraphs,
        characters: actorName ? [clean(actorName, 24)] : [],
        storyKind: 'status',
        statusActorId: actorId,
        expanded: false,
        aiRoundId,
      },
    });
    await saveMessage(card);
    saved.storyId = card.id;
  }
  return saved;
}

export async function applyMarshmallowStatusEvents(events = [], options = {}) {
  const sourceChatId = String(options.sourceChatId || options.sourceChat?.id || '').trim();
  const sourceChat = options.sourceChat || null;
  const items = (Array.isArray(events) ? events : []).filter((event) => event?.t === 'status');
  if (!sourceChatId || !sourceChat || !items.length) {
    return { handled: 0, skipped: items.length, latestPrefs: null };
  }

  const participants = new Set((sourceChat.participants || []).map((id) => String(id || '').trim()).filter(Boolean));
  const basePrefs = await loadChatPrefs(sourceChatId);
  const actorStatusMap = { ...(basePrefs.actorStatusMap || {}) };
  let handled = 0;
  let skipped = 0;
  let privateStatusUpdatedAt = basePrefs.statusUpdatedAt;
  const persistCharacterLiveState = options.persistCharacterLiveState !== false;

  const counterpart = (sourceChat.participants || []).find((id) => id && id !== 'user');
  let counterpartChange = null;
  let latestCounterpartStatus = null;
  for (const [eventIndex, event] of items.entries()) {
    const actorId = String(event.actor || event.from || '').trim();
    let statusText = normalizeMarshmallowStatusText(event.statusText || event.status || event.body || event.text);
    let presenceState = normalizePresenceState(event.presenceState || event.presence);
    const reason = clean(event.reason || '', 120);
    if (!actorId || !participants.has(actorId) || (!statusText && !presenceState)) {
      skipped += 1;
      continue;
    }
    const userId = String(options.userId || options.user?.id || '').trim();
    // 旧版私聊开关仍作为兼容闸门；真正的权限按角色全局保存，群聊/后台也不能绕过手动锁。
    const textUpdatesAllowed = Object.prototype.hasOwnProperty.call(basePrefs, 'allowAiStatusTextUpdates')
      ? basePrefs.allowAiStatusTextUpdates !== false
      : basePrefs.allowAiStatusUpdates !== false;
    const presenceUpdatesAllowed = Object.prototype.hasOwnProperty.call(basePrefs, 'allowAiPresenceUpdates')
      ? basePrefs.allowAiPresenceUpdates !== false
      : basePrefs.allowAiStatusUpdates !== false;
    if (sourceChat.type === 'private' && participants.has('user')
      && !textUpdatesAllowed && !presenceUpdatesAllowed) {
      skipped += 1;
      continue;
    }
    let appliedText = textUpdatesAllowed;
    let appliedPresence = presenceUpdatesAllowed;
    let changedText = textUpdatesAllowed;
    let changedPresence = presenceUpdatesAllowed;
    if (persistCharacterLiveState && userId && actorId !== 'user') {
      const ttlHintMinutes = Math.max(0, Math.trunc(Number(options.ttlHintMinutes || 0)) || 0);
      const updatedAt = Date.now();
      const statusTtlMs = ttlHintMinutes > 0
        ? ttlHintMinutes * 60 * 1000
        : defaultStatusTtlMs(statusText, presenceState);
      const applied = await applyAiCharacterStatusLine(userId, actorId, {
        text: statusText,
        presenceState,
        updatedAt,
        decisionAt: Number(options.aiRoundCreatedAt || 0) || updatedAt,
        decisionSequence: eventIndex,
        statusExpiresAt: statusText || presenceState !== 'online' ? updatedAt + statusTtlMs : 0,
        presenceExpiresAt: presenceState !== 'online' ? updatedAt + statusTtlMs : 0,
        sourceChatId,
        sourceRoundId: options.aiRoundId,
        sceneSource: options.sceneSource,
      }).catch(() => null);
      if (!applied?.accepted || !applied.changed) {
        skipped += 1;
        continue;
      }
      appliedText = applied.appliedText !== false;
      appliedPresence = applied.appliedPresence !== false;
      changedText = applied.textChanged === true;
      changedPresence = applied.presenceChanged === true;
      statusText = String(applied.state?.statusLine?.text || '');
      presenceState = normalizePresenceState(applied.state?.presence?.state);
    }
    actorStatusMap[actorId] = {
      presenceState,
      statusText,
      reason,
      updatedAt: Date.now(),
    };
    handled += 1;

    if (sourceChat.type === 'private' && actorId === counterpart) {
      if (participants.has('user')) {
        counterpartChange = {
          actorId,
          // 只提示本轮真正改动的字段。短句被锁定时，保留下来的固定短句
          // 不能冒充“角色刚更新了状态”。
          statusText: changedText ? statusText : '',
          presenceState,
          story: String(event.story || ''),
          stateScene: String(options.statusStoryScenes?.[actorId] || ''),
          synthesizedFromState: event.synthesizedFromState === true,
        };
      }
      latestCounterpartStatus = {
        actorId,
        statusText,
        presenceState,
        appliedText,
        appliedPresence,
        changedText,
        changedPresence,
      };
      privateStatusUpdatedAt = Date.now();
    }
  }

  // 用户可能在 AI 事件通过第一次检查后立刻关闭权限或清空短句。落会话兼容副本、
  // 系统提示和小剧场之前再核验一次角色级真源，避免旧请求从竞态窗口把状态写回来。
  if (persistCharacterLiveState && latestCounterpartStatus && options.userId && counterpart) {
    const latestLiveState = await loadCharacterLiveState(options.userId, counterpart).catch(() => null);
    const currentLine = latestLiveState?.statusLine || {};
    const currentPresence = latestLiveState?.presence || {};
    const sameTextRound = !options.aiRoundId
      || String(currentLine.sourceRoundId || '') === String(options.aiRoundId || '');
    const samePresenceRound = !options.aiRoundId
      || String(currentPresence.sourceRoundId || '') === String(options.aiRoundId || '');
    const textStillCurrent = !latestCounterpartStatus.appliedText || (
      latestLiveState?.policy?.aiUpdatesAllowed !== false
      && latestLiveState?.policy?.manualLocked !== true
      && currentLine.source === 'ai'
      && sameTextRound
      && String(currentLine.text || '') === latestCounterpartStatus.statusText
    );
    const presenceStillCurrent = !latestCounterpartStatus.appliedPresence || (
      latestLiveState?.policy?.presenceUpdatesAllowed !== false
      && latestLiveState?.policy?.presenceManualLocked !== true
      && currentPresence.source === 'ai'
      && samePresenceRound
      && normalizePresenceState(currentPresence.state) === latestCounterpartStatus.presenceState
    );
    const stillCurrent = textStillCurrent && presenceStillCurrent;
    if (!stillCurrent) {
      delete actorStatusMap[counterpart];
      latestCounterpartStatus = null;
      counterpartChange = null;
      handled = Math.max(0, handled - 1);
      skipped += 1;
    }
  }

  if (!handled) return { handled, skipped, latestPrefs: null };

  let statusTimeline = null;
  if (counterpartChange && counterpartChange.synthesizedFromState !== true && options.suppressTimelineHint !== true) {
    // 顶栏小字用聊天里看到的称呼（备注/昵称），不要用 AI 上下文里的本名，
    // 否则会出现顶栏叫「烦烦」、提示却写「黄少 更新了状态」。
    let actorName = clean(options.statusDisplayName, 24);
    if (!actorName && typeof options.resolveSenderName === 'function') {
      actorName = clean(await options.resolveSenderName(counterpartChange.actorId).catch(() => ''), 24);
    }
    statusTimeline = await persistStatusTimelineEntries({
      chatId: sourceChatId,
      actorId: counterpartChange.actorId,
      actorName: actorName || 'TA',
      statusText: counterpartChange.statusText,
      presenceState: counterpartChange.presenceState,
      story: counterpartChange.story || buildStatusStoryFallbackText(
        counterpartChange.stateScene,
        counterpartChange.statusText,
        counterpartChange.presenceState,
      ),
      // 长篇幕后叙事由独立 life_glimpse 生成；状态事件只负责顶栏与轻量时间线提示。
      storyEnabled: false,
      timelineTs: options.timelineTs,
      aiRoundId: String(options.aiRoundId || '').trim(),
    }).catch(() => null);
  }

  if (sourceChat.type === 'private') {
    // 顶栏只跟私聊对手方走，不能拿原始数组最后一项做闸门：
    // 同轮后面若夹着用户/无效 status，提示已经落库但顶栏会漏写，留下「更新了状态」
    // 与「当前在线」并存。这里使用循环中最后一条真正处理过的对手方状态。
    if (latestCounterpartStatus) {
      const ttlHintMinutes = Math.max(0, Math.trunc(Number(options.ttlHintMinutes || 0)) || 0);
      const latestPrefs = await saveChatStatusWithTtl(sourceChatId, {
        presenceState: latestCounterpartStatus.presenceState,
        statusText: latestCounterpartStatus.statusText,
        statusSource: 'ai',
        statusUpdatedAt: privateStatusUpdatedAt,
        // 同轮的 next_reply_delay 是模型自己说的「什么时候回来」，状态到点一起恢复。
        statusExpiresAt: ttlHintMinutes > 0 ? privateStatusUpdatedAt + ttlHintMinutes * 60 * 1000 : 0,
        actorStatusMap,
      });
      // 公开短句不代表回复可用性：普通 online status 不能清自动回复、延时回复或真人回复。
      // 收工由 auto_reply clear / hard_offline clear / 在线态到期各自处理。
      return { handled, skipped, changed: Boolean(counterpartChange), latestPrefs, statusTimeline };
    }
  }

  const latestPrefs = await patchChatPrefs(sourceChatId, { actorStatusMap });
  return { handled, skipped, changed: Boolean(counterpartChange), latestPrefs, statusTimeline };
}
