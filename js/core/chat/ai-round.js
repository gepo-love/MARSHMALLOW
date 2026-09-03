import {
  createMessage,
  isAllMutedGroup,
  isNoUserGroup,
  resolveUserTopicPolicy,
} from '../../models/chat.js';
import {
  repairChatRoundTranslations,
  sanitizeAiTranslation,
} from '../translation-utils.js';
import {
  parseMarshmallowChatV2,
  salvageParseMarshmallowChatV2,
  filterSalvageableMarshmallowBubbleEvents,
  validateMarshmallowChatEvents,
  materializeMarshmallowChatEvents,
  isMarshmallowChatLikelyInProgress,
  stripThinkingBlocks,
  synthesizeStateEventsFromMsgEvents,
  normalizeStateCustomFields,
  resolveTargetRef,
  isEphemeralNpcActorId,
  stripEphemeralNpcLabel,
  normalizeCrossWindowSideEvents,
  isGenericPeerActorLabel,
  expandSideChatLineBodies,
  extractSideEventPlot,
  buildSideChatPlotExplainContent,
  repairUnfulfilledGeneratedImageClaim,
  suppressRepeatedNarrationEvents,
} from '../marshmallow-protocol.js';
import { recoverFinalOutputFromReasoning } from '../narration-sanitize.js';
import { classifyMarshmallowParseFailure, formatUpstreamResponseText } from '../generation-error-guide.js';
import { resolveEnabledChatBubbleRange } from '../chat-bubble-range.js';
import { applyRoundStateEvents } from './character-state.js';
import { applyVisibleReplyCompositionDelivery } from './psychological-continuity.js';
import { repairRedPacketClaimSpeech } from './red-packet-claims.js';
import {
  advanceVirtualTimeForMessages,
  createGapFillTimestampAllocator,
  getNowForUser,
  getPacingNowForUser,
  planGapFillTimestamps,
} from '../time-mode.js';
import {
  saveMessages,
  deleteMessagesWithAiRoundId,
  updateChatPreview,
  previewFromMessage,
  ensureBackstageChat,
  ensurePrivateChat,
  ensurePeerPrivateChat,
  saveChat,
  saveMessage,
  getChat,
  listMessagesForChat,
  repairChatFutureTimestampDrift,
  resolveChatRoundBaseTimestamp,
  rebaseLiveMessageBatch,
  findBackstageChat,
  findPresetGroupChatForParticipants,
  listBackstageChats,
  participantSetKey,
  areBackstageParticipantSetsCompatible,
  listChatsForUser,
  markAiRoundCascadeIndexComplete,
} from '../chat-store.js';
import { maybeSummarizeChatMemory } from '../chat-summary.js';
import { listCharacters } from '../character-store.js';
import {
  ensureLightweightNpc,
  getLightweightNpc,
  isLightweightNpcId,
  listLightweightNpcs,
  promoteLightweightNpcToCharacter,
} from '../lightweight-npc.js';
import { markQqContactApplicationDecision } from '../qq-contact-applications.js';
import { resolveCharacterAiContextName } from '../../models/character.js';
import { getUserConversationName, normalizeUserFacingLabel } from '../../models/user.js';
import { shouldStreamAsMarshmallowProtocol } from './marshmallow-turn-persist.js';
import {
  repairOfflineInviteTransitionEvents,
  sanitizeOfflineArrivalEvents,
} from './offline-invite-arrival.js';
import { appendReplyCompositionContract } from './reply-composition.js';
import {
  applyReplyCompositionReceipt,
  extractReplyCompositionReceipt,
} from './reply-composition-runtime.js';
import { advanceActiveEventAfterAiReply, rewindActiveEventAfterReroll } from './active-event.js';
import {
  describeCrossWindowGroupSendFailure,
  parseExecutableSendBlocks,
  executeSendOps,
} from './send-ops.js';
import { applyEmojiReactionToMessage } from './reactions.js';
import { applyMarshmallowRecallEvents } from './apply-recall-events.js';
import {
  appendUserPrivateActorHistory,
  appendLinkageRouteHistory,
  classifyLinkageAudienceOutcome,
  filterCrossWindowLinkageEvents,
  getPrivateLinkageIds,
  resolveAllowPrivateSend,
  resolveAiGroupCreationCooldownState,
  resolveLinkageIntervalState,
  resolveNextLinkageTurn,
  shouldConsumeLinkageInterval,
} from './chat-linkage-settings.js';
import { resetBackstagePity } from './backstage-pity.js';
import { loadChatOutputPrefs } from './chat-output-prefs.js';
import { get, put, getRecord } from '../db.js';
import { appendDebugEvent } from '../debug-log.js';
import { acquireNetworkLease, releaseNetworkLease } from '../native-http.js';
import {
  isCharacterAliasBlockedByUser,
  isCharacterAliasActiveInChat,
  isStrangerInterceptChat,
  normalizeRevealEntry,
  transitionFriendship,
} from '../stranger-thread-model.js';
import { applyMainChatFriendshipPromisesToAliases } from '../stranger-thread-store.js';
import { principalKey } from '../alias-account-model.js';
import {
  getChatBlockedState,
  loadCharacterBlockState,
  noteBlockedContactFailureRound,
  patchChatPrefs,
} from '../chat-block-state.js';
import {
  findProactiveNearDuplicate,
  isUserPresentInChat,
  isAnonymousChat,
} from '../chat-helpers.js';
import { applyPermanentRegex, primeRegex } from '../display-regex.js';
import { commitVisionContextMarks } from './vision-context.js';
import { showToast } from '../../components/toast.js';
import { showGenerationErrorReport } from '../../components/generation-error-report.js';
import { stripLeakedVoiceCallContextPrefix } from './voice-call-guard.js';
import { prepareConversationCapabilityMessages } from '../capabilities/conversation.js';
import { formatCapabilityFailure, formatCapabilityPlannerError } from '../capabilities/planner.js';
import {
  buildCapabilityIntentGoal,
  buildCapabilityUnavailableBlock,
  clearCapabilityContinuation,
  extractCapabilityIntent,
  loadCapabilityContinuation,
  resolveCapabilityIntentPermissionContext,
  saveCapabilityContinuation,
  stripCapabilityIntentEvents,
} from '../capabilities/intent.js';
import {
  hasExplicitUserCrossWindowForwardRequest,
  shouldBlockUserMaterialCrossWindowForward,
} from './cross-window-forward-policy.js';
import {
  applyMarshmallowGroupAdminEvents,
  applyMarshmallowPrivateMsgEvents,
  applyMarshmallowGroupInviteUserEvents,
  applyMarshmallowRemoteGroupEvents,
  applyClaimedCrossWindowGroupActions,
} from './marshmallow-group-admin.js';
import {
  claimedGroupActionTypes,
  describeGroupActionFailure,
  groundClaimedGroupActions,
  isExplicitGroupManagementRequest,
  reconcileGroupActionClaimMessages,
  shouldSurfaceGroupActionFailure,
} from './group-action-grounding.js';
import { applyMarshmallowGeneratedImageEvents } from './marshmallow-gen-image.js';
import { applyMarshmallowStatusEvents, resolveStatusTimelineTimestamp } from './marshmallow-status.js';
import { applyMarshmallowScheduleEvents } from './marshmallow-schedule.js';
import { applyMarshmallowMemoEvents } from './marshmallow-memo.js';
import { applyMarshmallowRadioPlanEvents } from './marshmallow-radio-plan.js';
import { applyMarshmallowPeriodEvents } from './marshmallow-period.js';
import { applyMarshmallowAutoReplyEvents } from './marshmallow-auto-reply.js';
import { applyMarshmallowNextReplyDelayEvents } from './marshmallow-next-reply.js';
import { applyMarshmallowPresenceEvents, applyMarshmallowWaitMoodEvents } from './marshmallow-presence.js';
import { applyMarshmallowHardOfflineEvents } from './real-person-hard-offline.js';
import { applyMarshmallowProfileEvents } from './marshmallow-profile-events.js';
import { executeChatIntentSideEffects } from './intent-side-effects.js';
import {
  convertLegacyTaggedChatOutput,
  splitPlainTextFallbackBubbles,
} from './plain-text-fallback.js';
import {
  filterEnsembleConflictingEvents,
  recordEnsembleRound,
  reserveEnsembleSituationFromUserMessage,
} from '../ensemble-mode.js';
import {
  buildDeterministicAliasDigest,
  recordAliasWindowDigest,
  recordUserAliasContactFact,
  upsertAliasAwareness,
  upsertMemoryFact,
} from '../memory/memory-facts.js';
import {
  loadImageToolConfig,
  resolveChatImageGenerationCapability,
} from '../image-generation-tools.js';
import { buildStatusOpportunityResultPatch } from './status-proactive-policy.js';
import {
  prepareChatContinuityRepair,
  resolveChatContinuityIncidents,
} from './continuity-repair.js';
import { applyRedPacketClaimEvents } from './apply-red-packet-claim-events.js';
import { applyTransferEvents } from './apply-transfer-events.js';
import { loadOfflineSession } from '../offline-session-store.js';
import {
  attachReceipts,
  createChatRoundReceiptCollector,
} from './chat-round-receipt.js';
import {
  decideBackstagePersistenceGate,
  isExplicitRelationshipObserverGroup,
} from './chat-round-gate.js';
import {
  buildNeedSearchDeclinedBlock,
  extractNeedSearchRequest,
  stripNeedSearchEvents,
  resolveNeedSearchContext,
} from './need-search.js';
import { markVerifiedPostShared } from '../interest-search-orchestrator.js';
import { enhanceStoredLinkMessages } from '../link-card-enhancer.js';
import { consumeShareImpulse } from '../share-impulse.js';
import { markUserSocialPostMentioned } from '../user-social-watch.js';
import {
  createGenerationTask,
  createGenerationTaskCheckpointWriter,
  describeGenerationTransport,
  isGenerationTaskSafePreDispatch,
  makeGenerationTaskIdentity,
  saveGenerationTask,
  summarizeGenerationPrompt,
} from './generation-task-store.js';
import {
  getGenerationRelayPrefs,
  isGenerationRelayEnabled,
} from '../generation-relay.js';
import { canPhoneCharacterIdsKnowEachOther, checkPhoneSocialParticipantIds } from '../phone-social-eligibility.js';

function makeAiRoundId(createdAt = Date.now()) {
  return `round_${createdAt}_${Math.random().toString(36).slice(2, 8)}`;
}

function getPartnerActor(chat) {
  return (chat?.participants || []).find((p) => p && p !== 'user') || '';
}

function resolveCapabilityIntentActorId(request = {}, chat = {}, options = {}) {
  const participants = (Array.isArray(chat?.participants) ? chat.participants : [])
    .map((id) => String(id || '').trim())
    .filter((id) => id && id !== 'user');
  const fallback = String(options.currentActorId || getPartnerActor(chat) || '').trim();
  const requested = String(request.from || '').trim();
  if (requested && participants.includes(requested)) return requested;
  if (fallback && participants.includes(fallback)) return fallback;
  return participants[0] || '';
}

export function resolveAiRoundSummaryActorName({
  chat = null,
  actorId = '',
  userId = '',
  currentUserName = '用户',
  characters = {},
  fallbackName = '',
} = {}) {
  const id = String(actorId || '').trim();
  if (isStrangerInterceptChat(chat)) {
    const key = id === 'user'
      ? principalKey('user', userId)
      : principalKey('character', id);
    const accountId = String(chat?.metadata?.accountIdentityMap?.[key] || '').trim();
    const snapshot = accountId ? chat?.metadata?.accountSnapshots?.[accountId] : null;
    const frontStageName = String(snapshot?.displayName || fallbackName || '').trim();
    if (frontStageName) return frontStageName;
    return id === 'user' ? '陌生账号' : '陌生人';
  }
  if (id === 'user') return currentUserName;
  return String(fallbackName || resolveCharacterAiContextName(id, characters) || id || '角色').trim();
}

function isPhoneLightCharacterRow(row) {
  return !!(row && (row._phoneLightContact || row.metadata?.isPhoneLightContact));
}

/**
 * 陌生消息里的原创骚扰者由轻量 NPC 承载，不是通讯录正式角色。
 * 线程已经把该 NPC 的主体键与前台账号快照固化在 metadata 中；即使关系网读取
 * 短暂失败，也不能把它误判成「生成期间删除了角色」并丢掉整轮回复。
 */
export function isThreadScopedStrangerLightweightParticipant(chat, participantId = '') {
  const id = String(participantId || '').trim();
  if (!id || !isLightweightNpcId(id) || !isStrangerInterceptChat(chat)) return false;
  const subjectKey = principalKey('character', id);
  const participantKeys = Array.isArray(chat?.metadata?.strangerParticipantKeys)
    ? chat.metadata.strangerParticipantKeys.map((key) => String(key || '').trim())
    : [];
  const accountId = String(chat?.metadata?.accountIdentityMap?.[subjectKey] || '').trim();
  return participantKeys.includes(subjectKey) && Boolean(accountId);
}

/**
 * 落库前核验：真角色被删要拦；手机轻量 NPC / 一次性 npc_ 不在 characters 表，不能误报。
 *
 * 手机群 memberIds 常保留 phone-contact: 本地 id（即使已 linked 主角色）。
 * 旧逻辑只豁免「未转正」联系人，已链接的 contact.id 会被当成角色库缺失，
 * 幕后群/手机群一点「推进」就整轮 character-deleted-during-generation。
 */
async function listMissingCharactersDuringGeneration(participantIds, {
  characters = {},
  userId = '',
  phoneOwnerId = '',
  chat = null,
} = {}) {
  const unresolved = [];
  for (const id of participantIds) {
    if (!id || id === 'user' || isEphemeralNpcActorId(id)) continue;
    if (isPhoneLightCharacterRow(characters[id])) continue;
    if (isThreadScopedStrangerLightweightParticipant(chat, id)) continue;
    const live = await getRecord('characters', id).catch(() => null);
    if (live) continue;
    if (isLightweightNpcId(id) && await getLightweightNpc(id, userId).catch(() => null)) continue;
    unresolved.push(id);
  }
  if (!unresolved.length) return [];

  const ownerId = String(phoneOwnerId || '').trim()
    || String(
      Object.values(characters || {}).find((row) => isPhoneLightCharacterRow(row))?.metadata?.ownerId || '',
    ).trim();

  try {
    const {
      loadCharacterPhoneContacts,
      findPhoneContactAcrossOwners,
      isPhoneContactActorId,
    } = await import('../character-phone-contacts.js');
    const liveContactIds = new Set();
    if (userId && ownerId) {
      const state = await loadCharacterPhoneContacts(userId, ownerId).catch(() => null);
      for (const contact of state?.contacts || []) {
        const contactId = String(contact?.id || '').trim();
        // 通讯录里还挂着这条联系人（不论是否已 linked）：群成员用 contact.id 就算合法身份。
        // 已转正的主角色是否还在，由 participants 里的 linkedCharacterId / char_* 那一项单独核验。
        if (contactId) liveContactIds.add(contactId);
      }
    }
    const stillMissing = [];
    for (const id of unresolved) {
      if (liveContactIds.has(id)) continue;
      if (isPhoneContactActorId(id)) {
        const hit = await findPhoneContactAcrossOwners(id).catch(() => null);
        if (hit?.contact) continue;
      }
      stillMissing.push(id);
    }
    return stillMissing;
  } catch (_) {
    return unresolved;
  }
}

async function saveAiDebugSnapshot(chatId, rawText = '') {
  if (!chatId) return;
  await put({
    key: `chatAiDebug_${chatId}`,
    value: { text: String(rawText || '').slice(0, 120000), savedAt: Date.now() },
  });
}

/**
 * HTTP errors (401/429/5xx) must surface as API errors, not "流传输中断":
 * users were being told to retry streaming when the key/quota was the problem.
 */
function isLocalStorageConnectionError(error) {
  const msg = String(error?.message || '');
  return (
    /connection to (?:the )?indexed database server lost|connection has been lost|database has been closed|database connection (?:has been )?lost/i.test(msg)
    || (String(error?.name || '') === 'UnknownError' && /indexed\s*database|database server/i.test(msg))
  );
}

function classifyAiRoundCatchReason(error, abortLike) {
  if (abortLike) return error?.abortReason === 'watchdog' ? 'client-timeout' : 'aborted';
  const status = Number(error?.status || 0);
  const msg = String(error?.message || '');
  const code = String(error?.code || '').toLowerCase();
  if (isLocalStorageConnectionError(error)) return 'local-storage-error';
  if (code === 'relay_unreachable') return 'relay-unreachable';
  if (code === 'relay_error_decrypt' || code === 'crypto_mismatch') return 'relay-crypto-error';
  if (code === 'upstream_timeout') return 'relay-upstream-timeout';
  if (code === 'upstream_unavailable') return 'relay-upstream-unavailable';
  if (code === 'opaque_network_error') return 'network-unknown';
  // 接口已明确回了 HTTP 错：优先展示 API 侧，不要被客户端断连/streamIncomplete 盖掉。
  if (status >= 400 || /API错误 \(\d+\)/.test(msg)) {
    // 仅当整段是「直连断了 + 死代理 404/405」的合成文案时，才退回 stream-error。
    if (
      (status === 404 || status === 405 || /API错误 \(404\)|API错误 \(405\)|Method not allowed/i.test(msg))
      && /已跳过不可用的同源代理|同源代理/i.test(msg)
      && /连接在返回|Failed to fetch|浏览器拦截|网络连接中断|streamIncomplete/i.test(msg)
    ) {
      return 'stream-error';
    }
    return 'api-http-error';
  }
  if (
    error?.streamIncomplete === true
    || /连接在返回中途断开|连接在返回阶段断开|流式连接提前结束|网络连接中断|客户端断开/i.test(msg)
  ) {
    return 'stream-error';
  }
  if (/网页而非 JSON/i.test(msg)) return 'api-html-response';
  if (/明确.*CORS|浏览器拦截|WebView 拦截/i.test(msg)) return 'network-cors';
  if (error?.timeoutStage) return 'client-timeout';
  return 'stream-error';
}

function buildTimestampAllocator(baseTs) {
  let cursor = Number(baseTs) || Date.now();
  return () => {
    cursor += 1200 + Math.floor(Math.random() * 800);
    return cursor;
  };
}

function normalizeSideChatText(value = '') {
  return String(value || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

function trigramSet(value = '') {
  const text = normalizeSideChatText(value);
  const out = new Set();
  for (let i = 0; i <= text.length - 3; i += 1) out.add(text.slice(i, i + 3));
  return out;
}

function textSimilarity(a = '', b = '') {
  const aa = trigramSet(a);
  const bb = trigramSet(b);
  if (!aa.size || !bb.size) return 0;
  let shared = 0;
  for (const token of aa) if (bb.has(token)) shared += 1;
  return shared / Math.max(aa.size, bb.size);
}

function phonePeerActorKey(value = '') {
  return String(value || '').trim().toLowerCase().replace(/[\s_\-./·]+/g, '');
}

function eventActorValue(event = {}) {
  return String(event?.from || event?.actor || event?.senderId || '').trim();
}

const GROUP_ADMIN_EVENT_TYPES = new Set([
  'group_title',
  'group_name',
  'group_announcement',
  'group_todo',
  'group_transfer',
  'group_admin',
  'group_member',
  'mute',
  'vote_close',
]);

const ACTOR_CONTENT_EVENT_TYPES = new Set([
  'msg', 'state', 'react', 'recall', 'sticker', 'image', 'gen_image', 'textimg',
  'voice', 'voice_call', 'dice', 'link', 'location', 'nudge', 'html_widget',
  'redpacket', 'redpacket_claim', 'transfer', 'transfer_accept', 'transfer_return',
  'order_share', 'offline_invite', 'vote', 'private_msg', 'peer_private',
  'backstage', 'chat_bundle', 'status', 'schedule_change', 'auto_reply', 'memo', 'radio_plan', 'interaction_plan',
  'period_offer', 'period_confirm', 'period_decline', 'period_set', 'period_end', 'npc_card', 'social_post',
  'open_alias', 'alias', 'avatar', 'memory_fact', 'invite_user',
  'anonymous_reveal', 'stranger_block', 'stranger_friend', 'stranger_suspect',
]);

// 第一阶段只在前台一对一纯文字回合启用气泡 packing。state 是隐藏心理快照，
// 不改变可见消息的顺序；任何其它事件都保留旧路径，先只做收据诊断。
const REPLY_COMPOSITION_ACTIVE_EVENT_TYPES = new Set(['msg', 'state']);
const REPLY_COMPOSITION_RICH_MESSAGE_FIELDS = [
  'reply', 'zh', 'translation', 'speech', 'speechPlan', 'speech_plan', 'sound', 'relay',
  'inner', 'intent', 'mood', 'custom',
];

function isPlainReplyCompositionMessage(event = {}) {
  if (event?.t !== 'msg') return true;
  if (REPLY_COMPOSITION_RICH_MESSAGE_FIELDS.some((field) => {
    const value = event[field];
    if (value === undefined || value === null || value === '') return false;
    if (Array.isArray(value)) return value.length > 0;
    if (value && typeof value === 'object') return Object.keys(value).length > 0;
    return true;
  })) return false;
  return !/(?:\[\s*(?:回复|图片|发送图片|表情包|红包|转账)|(?:https?:\/\/|www\.)\S+)/iu.test(
    String(event.body || event.text || event.content || ''),
  );
}

function canActorManageGroup(chat, actorId) {
  const id = String(actorId || '').trim();
  if (!id || chat?.type !== 'group') return false;
  const gs = chat.groupSettings || {};
  const owner = String(gs.owner || '').trim()
    || ((chat.participants || []).includes('user')
      ? 'user'
      : String((chat.participants || []).find((pid) => pid && pid !== 'user') || '').trim());
  return id === owner || (Array.isArray(gs.admins) && gs.admins.includes(id));
}

function filterSideEventLines(event, mutedIds) {
  if (!Array.isArray(event?.lines)) return event;
  const lines = event.lines.filter((line) => {
    const actor = String(line?.from || line?.actor || line?.senderId || '').trim();
    return !actor || actor === 'user' || actor === 'system' || !mutedIds.has(actor);
  });
  return lines.length ? { ...event, lines } : null;
}

/**
 * 协议校验后、物化落库前的确定性群禁言闸门。
 * UI/提示词只负责解释；这里保证被禁言角色无法借任意事件类型产生内容或副作用。
 */
export function filterMutedGroupActorEvents(events = [], chat = {}) {
  if (chat?.type !== 'group') return [...(Array.isArray(events) ? events : [])];
  const allMuted = isAllMutedGroup(chat);
  const mutedIds = new Set((Array.isArray(chat.groupSettings?.muted) ? chat.groupSettings.muted : []).map(String));
  const out = [];
  for (const event of (Array.isArray(events) ? events : [])) {
    if (!event) continue;
    const type = String(event.t || '').trim();
    const actor = eventActorValue(event);
    if (GROUP_ADMIN_EVENT_TYPES.has(type)) {
      if (type !== 'mute') {
        out.push(event);
      } else if (!allMuted || (event.muted === false && canActorManageGroup(chat, actor))) {
        out.push(event);
      }
      continue;
    }
    if (!ACTOR_CONTENT_EVENT_TYPES.has(type)) {
      out.push(event);
      continue;
    }
    if (actor === 'user' || actor === 'system') {
      out.push(event);
      continue;
    }
    if (allMuted) continue;
    if (actor && mutedIds.has(actor)) continue;
    const filtered = filterSideEventLines(event, mutedIds);
    if (filtered) out.push(filtered);
  }
  return out;
}

/**
 * 弱模型偶尔会把同一轮群聊写成 A 的整块消息后再接 B 的整块消息。
 * 只纠正「多个发言人各占一个连续块」且存在三连发的纯 msg 片段；显式引用保留
 * 原顺序，非 msg 事件也作为边界，避免改坏卡片、撤回和群管动作的时序。
 */
export function interleaveMonolithicGroupMessageBlocks(events = [], chat = {}) {
  const source = Array.isArray(events) ? events : [];
  const participants = new Set((chat?.participants || [])
    .map((id) => String(id || '').trim())
    .filter((id) => id && id !== 'user' && id !== 'system'));
  if (chat?.type !== 'group' || participants.size < 2 || source.length < 4) return [...source];

  const weaveChunk = (chunk) => {
    if (chunk.length < 4 || chunk.some((event) => event?.reply || event?.replyTo || event?.target)) return chunk;
    const blocks = [];
    for (const event of chunk) {
      const actor = eventActorValue(event);
      const last = blocks[blocks.length - 1];
      if (last?.actor === actor) last.events.push(event);
      else blocks.push({ actor, events: [event] });
    }
    const actors = blocks.map((block) => block.actor);
    if (new Set(actors).size < 2 || new Set(actors).size !== blocks.length) return chunk;
    if (!blocks.some((block) => block.events.length >= 3)) return chunk;
    if (actors.some((actor) => !actor || !participants.has(actor))) return chunk;

    const queues = blocks.map((block) => [...block.events]);
    const woven = [];
    while (queues.some((queue) => queue.length)) {
      for (const queue of queues) woven.push(...queue.splice(0, 2));
    }
    return woven;
  };

  const out = [];
  for (let index = 0; index < source.length;) {
    if (String(source[index]?.t || '') !== 'msg') {
      out.push(source[index]);
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < source.length && String(source[end]?.t || '') === 'msg') end += 1;
    out.push(...weaveChunk(source.slice(index, end)));
    index = end;
  }
  return out;
}

function replaceEventActor(event = {}, actorId = '') {
  const next = { ...event, from: actorId };
  if (event.actor) next.actor = actorId;
  if (event.senderId) next.senderId = actorId;
  return next;
}

/**
 * 角色手机里的无 user 双人窗必须允许双方发言。模型偶尔会把手机主人写成“主人/我”，或把
 * 联系人写成备注称呼；常规 actor 校验会只拒掉这一方，剩下一方仍落库，于是看起来像吞消息。
 * 这里只在恰好两名成员的手机私聊里做无歧义映射，不放宽普通私聊、群聊或跨窗权限。
 */
export function repairPhonePeerActorEvents(events = [], options = {}) {
  const chat = options.chat || null;
  const viewerId = String(options.phoneViewerId || '').trim();
  const participantIds = [...new Set((chat?.participants || [])
    .map((id) => String(id || '').trim())
    .filter((id) => id && id !== 'user' && id !== 'system'))];
  if (!viewerId || chat?.type === 'group' || (chat?.participants || []).includes('user') || participantIds.length !== 2) {
    return Array.isArray(events) ? events : [];
  }
  const peerId = participantIds.find((id) => id !== viewerId) || '';
  if (!peerId || !participantIds.includes(viewerId)) return Array.isArray(events) ? events : [];

  const characters = options.characters || {};
  const aliasToId = new Map();
  const ambiguous = new Set();
  const addAlias = (alias, id) => {
    const key = phonePeerActorKey(alias);
    if (!key || ambiguous.has(key)) return;
    const previous = aliasToId.get(key);
    if (previous && previous !== id) {
      aliasToId.delete(key);
      ambiguous.add(key);
      return;
    }
    aliasToId.set(key, id);
  };
  for (const id of participantIds) {
    const row = characters[id] || {};
    [id, row.name, row.realName, row.customNickname, ...(Array.isArray(row.aliases) ? row.aliases : [])]
      .forEach((alias) => addAlias(alias, id));
  }
  ['手机主人', '主人', '机主', '自己', '我'].forEach((alias) => addAlias(alias, viewerId));
  ['聊天对象', '联系人', '对方'].forEach((alias) => addAlias(alias, peerId));

  const source = Array.isArray(events) ? events : [];
  const direct = source.filter((event) => event && event.t !== 'peer_private' && event.t !== 'backstage' && eventActorValue(event));
  const rawKeys = [...new Set(direct.map((event) => phonePeerActorKey(eventActorValue(event))).filter(Boolean))];
  const mappedIds = new Set(rawKeys.map((key) => aliasToId.get(key)).filter(Boolean));
  const unknownKeys = rawKeys.filter((key) => !aliasToId.has(key));
  if (rawKeys.length === 2 && mappedIds.size === 1 && unknownKeys.length === 1) {
    const missingId = participantIds.find((id) => !mappedIds.has(id));
    if (missingId) aliasToId.set(unknownKeys[0], missingId);
  }

  return source.map((event) => {
    if (!event || event.t === 'peer_private' || event.t === 'backstage') return event;
    const rawActor = eventActorValue(event);
    const resolved = aliasToId.get(phonePeerActorKey(rawActor));
    return resolved && resolved !== rawActor ? replaceEventActor(event, resolved) : event;
  });
}

function sideBatchSpeakerKey(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .filter((m) => m && m.senderId !== 'system' && !m.metadata?.plotExplain)
    .map((m) => `${String(m.senderId || '')}:${String(m.type || 'text')}`)
    .join('|');
}

function sideBatchExactKey(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .filter((m) => m && m.senderId !== 'system' && !m.metadata?.plotExplain)
    .map((m) => [
      String(m.senderId || ''),
      String(m.type || 'text'),
      normalizeSideChatText(m.content || ''),
    ].join(':'))
    .join('|');
}

export function shouldTreatSideBatchAsDuplicate(batch = [], recent = []) {
  const visibleBatch = batch.filter((m) => m && m.senderId !== 'system' && !m.metadata?.plotExplain);
  if (!visibleBatch.length) return { duplicate: false, reason: '' };
  const nextExact = sideBatchExactKey(visibleBatch);
  const nextSpeakerKey = sideBatchSpeakerKey(visibleBatch);
  const nextText = visibleBatch.map((m) => m.content || '').join(' ');
  const byRound = new Map();
  for (const msg of recent) {
    if (!msg || msg.senderId === 'system' || msg.metadata?.plotExplain) continue;
    const key = String(msg.metadata?.aiRoundId || `msg_${msg.id}`);
    if (!byRound.has(key)) byRound.set(key, []);
    byRound.get(key).push(msg);
  }
  for (const rows of [...byRound.values()].slice(-8)) {
    if (nextExact && sideBatchExactKey(rows) === nextExact) {
      return { duplicate: true, reason: 'exact-batch' };
    }
    // 模糊去重只处理“刚刚重复生成”的几乎相同批次；说话人/消息类型顺序不同一律保留。
    if (normalizeSideChatText(nextText).length < 48 || sideBatchSpeakerKey(rows) !== nextSpeakerKey) continue;
    const latestOld = Math.max(...rows.map((m) => Number(m.timestamp || 0)), 0);
    const earliestNew = Math.min(...visibleBatch.map((m) => Number(m.timestamp || 0)).filter((n) => n > 0));
    if (!latestOld || !Number.isFinite(earliestNew) || Math.abs(earliestNew - latestOld) > 5 * 60_000) continue;
    const oldText = rows.map((m) => m.content || '').join(' ');
    if (textSimilarity(nextText, oldText) >= 0.94) {
      return { duplicate: true, reason: 'near-identical-retry' };
    }
  }
  return { duplicate: false, reason: '' };
}

async function isNearDuplicateSideBatch(chatId, batch = []) {
  const recent = await listMessagesForChat(chatId, 24).catch(() => []);
  const result = shouldTreatSideBatchAsDuplicate(batch, recent);
  if (result.duplicate) {
    appendDebugEvent({
      type: 'side_chat_duplicate_suppressed',
      level: 'info',
      message: `跨窗消息批次已去重：${result.reason}`,
      context: { chatId, reason: result.reason, messageCount: batch.length },
    });
  }
  return result.duplicate;
}

function buildSideChatPlotMessage(chatId, event = {}, options = {}) {
  const plot = extractSideEventPlot(event);
  const content = buildSideChatPlotExplainContent(plot, { userName: options.userName });
  return createMessage({
    chatId,
    senderId: 'system',
    senderName: '剧情',
    type: 'system',
    content,
    timestamp: options.timestamp || Date.now(),
    metadata: {
      protocol: 'MARSHMALLOW_CHAT_V2',
      plotExplain: true,
      ...(options.kind === 'peer_private' ? { peerPrivate: true } : { backstage: true }),
      parentChatId: options.parentChatId || '',
      ...(options.aiRoundId ? {
        aiRoundId: options.aiRoundId,
        sourceAiRoundId: options.sourceAiRoundId || '',
        aiGenerated: true,
      } : {}),
    },
  });
}

/**
 * 闲聊补充/断档补发场景：把本轮可见气泡按各自内容推断的时段，分散落进「上一条消息->当前锚点」
 * 这段断档区间里，而不是像普通回合一样全部贴着当前时间；window 缺失或跨度太小时退回普通分配器。
 */
function buildGapFillAwareAllocator(baseTs, window, visibleEventCount) {
  const startTs = Number(window?.startTs || 0);
  const endTs = Number(window?.endTs || 0) || baseTs;
  const MIN_GAP_MS = 10 * 60 * 1000;
  if (!startTs || endTs - startTs < MIN_GAP_MS) {
    return buildTimestampAllocator(baseTs);
  }
  const planned = planGapFillTimestamps(Math.max(1, visibleEventCount), { startTs, endTs });
  return createGapFillTimestampAllocator({ planned, startTs, endTs, fallbackStepMs: 1500 });
}

function phoneEnsureOptions(options = {}) {
  const phoneUserId = String(options.phoneUserId || options.userId || '').trim();
  const phoneOwnerId = String(options.phoneOwnerId || options.phoneViewerId || '').trim();
  const owner = options.characters?.[phoneOwnerId]
    || (Array.isArray(options.addressBookCharacters)
      ? options.addressBookCharacters.find((row) => String(row?.id || '') === phoneOwnerId)
      : null);
  return {
    userId: String(options.userId || phoneUserId || '').trim(),
    userName: String(options.userName || options.currentUserName || '').trim(),
    ...(phoneUserId && phoneOwnerId ? {
      phoneUserId,
      phoneOwnerId,
      ownerName: String(owner?.realName || owner?.name || owner?.customNickname || '').trim(),
      ownerAliases: Array.isArray(owner?.aliases) ? owner.aliases : [],
    } : {}),
  };
}

function isPhoneLightActorRow(row) {
  return !!(row && (row._phoneLightContact || row.metadata?.isPhoneLightContact));
}

async function persistFrontstageLightweightNpcs(chat, messages = [], options = {}) {
  if (chat?.type !== 'group') return messages;
  const rows = Array.isArray(messages) ? messages : [];
  const aliases = new Map();
  const phoneOpts = phoneEnsureOptions(options);
  for (const message of rows) {
    const rawId = String(message?.senderId || '').trim();
    if (!message || (message.metadata?.ephemeralNpc !== true && !isEphemeralNpcActorId(rawId))) continue;
    const label = String(message.senderName || '').trim()
      || stripEphemeralNpcLabel(rawId)
      || '路人';
    let lightweight = aliases.get(label);
    if (!lightweight) {
      lightweight = await ensureLightweightNpc({
        name: label,
        sourceChatId: chat.id,
        note: `来自「${chat.groupSettings?.name || '群聊'}」`,
        ...phoneOpts,
      });
      if (!lightweight) continue;
      aliases.set(label, lightweight);
    }
    const metadata = { ...(message.metadata || {}) };
    delete metadata.ephemeralNpc;
    if (isPhoneLightActorRow(lightweight)) {
      metadata.phoneLightContact = true;
      delete metadata.lightweightNpc;
    } else {
      metadata.lightweightNpc = true;
    }
    message.senderId = lightweight.id;
    message.senderName = lightweight.name;
    message.metadata = metadata;
  }
  const ids = [...aliases.values()].filter(Boolean).map((row) => row.id);
  if (ids.some((id) => !(chat.participants || []).includes(id))) {
    chat.participants = [...new Set([...(chat.participants || []), ...ids])];
    await saveChat(chat);
  }
  return rows;
}

/**
 * 跨窗落库时的发言人名字解析。页面级 resolveSenderName 只认识当前窗成员，
 * 对窗外的正式角色会兜底返回「对方」——这个词恰好在占位符黑名单里，
 * 曾把身份已正确解析的整行台词静默丢掉。这里先信 resolveSenderName 的
 * 非占位结果（保留群名片/备注语义），再查角色表与轻量 NPC 表的真名，
 * 保证已解析成员的名字永远不会落成通用占位词。
 */
export async function resolveSideChatActorName(actorId, options = {}, rawLabel = '') {
  const id = String(actorId || '').trim();
  if (!id) return '';
  const usable = (value) => {
    const name = String(value || '').trim();
    return name && name !== id && !isGenericPeerActorLabel(name) ? name : '';
  };
  if (typeof options.resolveSenderName === 'function') {
    const resolved = await Promise.resolve(options.resolveSenderName(id)).catch(() => '');
    const name = usable(resolved);
    if (name) return name;
  }
  const row = options.characters?.[id];
  if (row) {
    const name = usable(row.realName) || usable(row.name) || usable(row.customNickname);
    if (name) return name;
  }
  for (const entry of Array.isArray(options.addressBookCharacters) ? options.addressBookCharacters : []) {
    if (String(entry?.id || '') !== id) continue;
    const name = usable(entry.realName) || usable(entry.name) || usable(entry.customNickname);
    if (name) return name;
  }
  return usable(rawLabel) || id;
}

/**
 * 幕后群目标解析：稳定 chatId 优先；旧输出按原群名兼容；
 * ID/名称写坏时，仅在完整成员集合只对应一个现有群时自动纠正。
 */
export function resolveBackstageTargetChat(
  chats = [],
  event = {},
  participantIds = [],
  userId = '',
  parentChatId = '',
) {
  const required = [...new Set((Array.isArray(participantIds) ? participantIds : [])
    .map((id) => String(id || '').trim())
    .filter((id) => id && id !== 'user'))];
  const eligible = (Array.isArray(chats) ? chats : [])
    .filter((row) => row?.type === 'group'
      && !(row.participants || []).includes('user')
      && !isAnonymousChat(row))
    .filter((row) => !userId || !row.userId || String(row.userId) === String(userId))
    .filter((row) => required.every((id) => (row.participants || []).includes(id)));
  const requestedId = String(event?.targetChatId || '').trim();
  if (requestedId) {
    const direct = eligible.find((row) => String(row.id || '') === requestedId);
    if (direct) return { chat: direct, resolution: 'id' };
  }
  const room = String(event?.room || '').trim();
  const pid = String(parentChatId || '').trim();
  const exactRoom = eligible.filter((row) => String(row.groupSettings?.name || '').trim() === room);
  const scopedExact = pid
    ? exactRoom.filter((row) => String(row.metadata?.parentChatId || '') === pid)
    : exactRoom;
  const roomMatches = scopedExact.length ? scopedExact : exactRoom;
  if (roomMatches.length === 1) {
    return { chat: roomMatches[0], resolution: requestedId ? 'corrected_name' : 'name' };
  }
  const exactMembers = eligible.filter((row) => {
    const ids = [...new Set((row.participants || []).filter((id) => id && id !== 'user'))].sort();
    return ids.join('\0') === [...required].sort().join('\0');
  });
  if (required.length >= 2 && exactMembers.length === 1) {
    return { chat: exactMembers[0], resolution: 'corrected_members' };
  }
  if (required.length >= 2 && eligible.length === 1) {
    return { chat: eligible[0], resolution: 'corrected_members' };
  }
  return { chat: null, resolution: 'unresolved' };
}

export async function persistCrossWindowStateEvents(targetChat, event = {}, options = {}) {
  const targetChatId = String(targetChat?.id || '').trim();
  if (!targetChatId) return { handled: 0, reason: 'missing-target-chat' };
  const prefsRow = await get(`chatPrefs_${targetChatId}`).catch(() => null);
  const prefs = prefsRow?.value || {};
  if (prefs.innerVoiceDisabled === true) return { handled: 0, reason: 'inner-voice-disabled' };

  const participantIds = new Set((targetChat?.participants || [])
    .map((id) => String(id || '').trim())
    .filter((id) => id && id !== 'user' && id !== 'system'));
  const allowedSpeakerIds = new Set((Array.isArray(options.allowedSpeakerIds)
    ? options.allowedSpeakerIds
    : [...participantIds])
    .map((id) => String(id || '').trim())
    .filter((id) => participantIds.has(id)));
  const stateByActor = new Map();
  for (const state of Array.isArray(event?.states) ? event.states : []) {
    const actorId = String(state?.from || state?.actor || state?.senderId || '').trim();
    if (!actorId || !allowedSpeakerIds.has(actorId)) continue;
    const context = {
      surface: options.regexSurface || 'chat',
      placement: 2,
      depth: 0,
      macros: { user: options.userName || '用户', char: state?.fromName || actorId },
    };
    stateByActor.set(actorId, {
      ...state,
      t: 'state',
      from: actorId,
      inner: applyPermanentRegex(state?.inner, context),
      intent: applyPermanentRegex(state?.intent, context),
      mood: applyPermanentRegex(state?.mood, context),
      status: applyPermanentRegex(state?.status, context),
      custom: normalizeStateCustomFields(state),
    });
  }
  const states = [...stateByActor.values()];
  if (!states.length) return { handled: 0, reason: 'no-usable-states' };

  await applyRoundStateEvents(targetChatId, states, {
    resolveSenderName: options.resolveSenderName,
    userName: options.userName,
    aiRoundId: String(options.aiRoundId || '').trim(),
    aiRoundCreatedAt: Number(options.aiRoundCreatedAt || 0) || Date.now(),
    userId: options.userId,
    now: Number(options.now || 0) || Date.now(),
    sceneSource: options.proactiveChannel === 'schedule'
      ? 'schedule_proactive_state'
      : (options.proactiveChannel ? 'background_proactive_state' : 'foreground_chat_state'),
    allowScheduleOverride: prefs.allowAiStatusScheduleOverride !== false,
    persistCharacterLiveState: !isStrangerInterceptChat(targetChat),
    replaceEmptyInner: targetChat?.groupSettings?.innerVoiceCard?.generationMode === 'custom',
  });
  return { handled: states.length, reason: '' };
}

function remapCrossWindowStateActor(event, priorIds = [], nextId = '') {
  const target = String(nextId || '').trim();
  const aliases = new Set((Array.isArray(priorIds) ? priorIds : [priorIds])
    .map((id) => String(id || '').trim())
    .filter(Boolean));
  if (!target || !aliases.size || !Array.isArray(event?.states)) return;
  event.states = event.states.map((state) => (
    aliases.has(String(state?.from || state?.actor || state?.senderId || '').trim())
      ? { ...state, t: 'state', from: target }
      : state
  ));
}

async function persistBackstageSideEffects(sideEffects = [], options = {}) {
  const { chat, userId, parentChatId, resolveSenderName, aiRoundId = '' } = options;
  const allowGroupCreation = options.allowGroupCreation !== false;
  if (!sideEffects.length || !userId) return [];
  // 幕后窗口拥有独立的可重 roll 轮次；保留来源轮次仅用于追溯，避免重 roll 幕后时误排除前台轮次状态。
  const backstageAiRoundId = aiRoundId ? `backstage_${aiRoundId}` : '';
  const saved = [];
  const receipts = createChatRoundReceiptCollector();
  const touchedChatIds = new Set();
  const groupCreationBudget = options.groupCreationBudget && typeof options.groupCreationBudget === 'object'
    ? options.groupCreationBudget
    : { remaining: 1 };
  if (!Number.isFinite(Number(groupCreationBudget.remaining))) groupCreationBudget.remaining = 1;
  // 同一轮里 backstage 和 chat_bundle 常常是同一个场景（先对白、再甩证据截图），
  // 后面没写 room 的 chat_bundle 默认跟上前面最近一个 backstage 的房间，避免拆成两个群。
  let lastRoomName = '';
  const normalizedEffects = normalizeCrossWindowSideEvents(sideEffects, {
    chat,
    characters: options.characters,
    addressBookCharacters: options.addressBookCharacters,
    actorResolutionExtraIds: options.actorResolutionExtraIds,
    extraActorIds: options.extraActorIds,
    preferPeerIds: options.preferPeerIds,
  });
  for (const event of normalizedEffects) {
    if (event.t === 'peer_private') {
      const lines = expandSideChatLineBodies(Array.isArray(event.lines) ? event.lines : []);
      const provisionalIds = [...new Set([
        String(event.to || '').trim(),
        ...lines.map((line) => String(line?.from || line?.actor || line?.senderId || '').trim()),
      ].filter((id) => id && id !== 'user' && id !== 'unknown'))];
      if (!lines.length || !provisionalIds.some((id) => !isEphemeralNpcActorId(id))) {
        appendDebugEvent({
          type: 'peer_private_persist_skipped',
          level: 'warn',
          message: '角色私聊缺少可落库台词或正式角色，已跳过',
          context: { parentChatId: parentChatId || chat?.id || '', provisionalIds, lineCount: lines.length },
        });
        continue;
      }
      const lightweightByRawId = new Map();
      for (const line of lines) {
        const rawId = String(line?.from || line?.actor || line?.senderId || '').trim();
        if (!isEphemeralNpcActorId(rawId) && line?.ephemeralNpc !== true) continue;
        const label = stripEphemeralNpcLabel(line.fromLabel)
          || stripEphemeralNpcLabel(rawId)
          || '路人';
        let lightweight = lightweightByRawId.get(rawId);
        if (!lightweight) {
          lightweight = await ensureLightweightNpc({
            name: label,
            sourceChatId: parentChatId || chat?.id || 'peer-private',
            note: '来自角色私聊',
            ...phoneEnsureOptions(options),
          });
          if (!lightweight) continue;
          lightweightByRawId.set(rawId, lightweight);
        }
        if (line.from) line.from = lightweight.id;
        if (line.actor) line.actor = lightweight.id;
        if (line.senderId) line.senderId = lightweight.id;
        line.fromLabel = lightweight.name;
        line.ephemeralNpc = false;
      }
      for (const [rawId, lightweight] of lightweightByRawId) {
        if (!lightweight) continue;
        if (String(event.from || '').trim() === rawId) event.from = lightweight.id;
        if (String(event.to || '').trim() === rawId) event.to = lightweight.id;
        remapCrossWindowStateActor(event, [rawId], lightweight.id);
      }
      const realIds = [...new Set([
        String(event.to || '').trim(),
        ...lines.map((line) => String(line?.from || line?.actor || line?.senderId || '').trim()),
      ].filter((id) => id && id !== 'user' && id !== 'unknown' && !isEphemeralNpcActorId(id)))];
      if (realIds.length !== 2 || !lines.length) {
        receipts.add({
          code: 'peer_private_identity_incomplete',
          status: 'dropped',
          stage: 'side-effect-persist',
          eventType: 'peer_private',
          chatId: parentChatId || chat?.id || '',
          context: { participantIds: realIds, lineCount: lines.length },
        });
        appendDebugEvent({
          type: 'peer_private_persist_skipped',
          level: 'warn',
          message: '角色私聊身份未收敛为两人，已跳过',
          context: {
            parentChatId: parentChatId || chat?.id || '',
            realIds,
            lineActors: lines.map((line) => String(line?.from || line?.actor || line?.senderId || '').trim()),
          },
        });
        continue;
      }
      if (event.coercedFromBackstage === true) {
        const preset = await findPresetGroupChatForParticipants(userId, realIds).catch(() => null);
        if (isExplicitRelationshipObserverGroup(preset)) {
          const nested = await persistBackstageSideEffects([{
            ...event,
            t: 'backstage',
            room: String(event.roomHint || preset.groupSettings?.name || '秘密基地').trim(),
            preserveBackstage: true,
          }], options);
          saved.push(...nested);
          for (const receipt of nested.receipts || []) receipts.add(receipt);
          receipts.add({
            code: 'explicit_observer_group_reused',
            status: 'persisted',
            stage: 'side-effect-persist',
            eventType: 'backstage',
            targetChatId: preset.id,
            context: { participantIds: realIds },
          });
          continue;
        }
      }
      const sociallyEligible = await canPhoneCharacterIdsKnowEachOther(
        realIds[0],
        realIds[1],
        userId,
      ).catch(() => false);
      if (sociallyEligible === false) {
        receipts.add({
          code: 'peer_private_social_boundary',
          status: 'blocked',
          stage: 'side-effect-persist',
          eventType: 'peer_private',
          chatId: parentChatId || chat?.id || '',
          context: { participantIds: realIds },
        });
        appendDebugEvent({
          type: 'peer_private_social_boundary_blocked',
          level: 'warn',
          message: '角色私聊跨越通讯录分组且无关系网授权，已跳过',
          context: {
            parentChatId: parentChatId || chat?.id || '',
            participantIds: realIds,
          },
        });
        continue;
      }
      // Actor resolution can occasionally resolve `event.to` to a real contact
      // while the same display name inside `lines[].from` has already fallen
      // back to an ephemeral NPC id. The old membership check then silently
      // dropped only that participant's replies, leaving a one-sided chat.
      // Reconcile line speakers against the known pair by id and display name
      // before filtering so both sides survive persistence.
      const peerNames = new Map();
      for (const id of realIds) {
        peerNames.set(id, await resolveSideChatActorName(id, options));
      }
      const peerAliasToId = new Map();
      for (const [id, name] of peerNames) {
        peerAliasToId.set(id, id);
        if (name) peerAliasToId.set(name, id);
      }
      const peerChat = await ensurePeerPrivateChat(userId, realIds, {
        parentChatId: parentChatId || chat?.id,
        focalActorId: String(event.from || lines[0]?.from || realIds[0]).trim(),
      });
      const nextTs = buildTimestampAllocator(await getNowForUser(userId));
      const batch = [];
      const acceptedSpeakerIds = new Set();
      const droppedLineActors = [];
      batch.push(buildSideChatPlotMessage(peerChat.id, event, {
        timestamp: nextTs(),
        kind: 'peer_private',
        parentChatId: parentChatId || chat?.id || '',
        userName: options.userName,
        aiRoundId: aiRoundId ? `peer_${aiRoundId}` : '',
        sourceAiRoundId: aiRoundId,
      }));
      for (const line of lines) {
        const rawSenderId = String(line?.from || line?.actor || line?.senderId || '').trim();
        const rawSenderLabel = String(line?.fromLabel || '').trim();
        const senderId = peerAliasToId.get(rawSenderId)
          || peerAliasToId.get(rawSenderLabel)
          || rawSenderId;
        if (!realIds.includes(senderId)) {
          droppedLineActors.push(rawSenderLabel || rawSenderId || 'unknown');
          continue;
        }
        if (isGenericPeerActorLabel(senderId) || isGenericPeerActorLabel(line?.fromLabel)) {
          droppedLineActors.push(rawSenderLabel || rawSenderId || 'generic-peer');
          continue;
        }
        const body = String(line?.body || line?.text || line?.content || '').trim();
        const isImageLine = line.kind === 'image' && /^(https?:\/\/|data:image\/)/i.test(String(line.imageUrl || '').trim());
        const isLinkLine = line.kind === 'link' && /^https?:\/\//i.test(String(line.linkUrl || '').trim());
        // Image/link relay lines often have empty body after resolveBackstageLineImages.
        if (!body && !isImageLine && !isLinkLine) continue;
        // senderId 已确认在 realIds 里，是真实身份；名字解析不再可能返回「对方」
        // 这类占位词，也绝不能因为显示名兜底失败而丢掉整行台词。
        const senderName = peerNames.get(senderId)
          || await resolveSideChatActorName(senderId, options, rawSenderLabel);
        const senderTranslationProfile = options.characters?.[senderId]?.translationProfile || {};
        const translation = sanitizeAiTranslation(body, line?.zh || line?.translation, {
          languageHint: senderTranslationProfile.language || senderTranslationProfile.dialectNote || '',
        });
        acceptedSpeakerIds.add(senderId);
        batch.push(createMessage({
          chatId: peerChat.id,
          senderId,
          senderName,
          type: isImageLine ? 'image' : (isLinkLine ? 'link' : 'text'),
          content: isImageLine
            ? String(line.imageUrl).trim()
            : (isLinkLine ? String(line.linkUrl).trim() : body),
          timestamp: nextTs(),
          metadata: {
            protocol: 'MARSHMALLOW_CHAT_V2',
            peerPrivate: true,
            parentChatId: parentChatId || chat?.id || '',
            ...(backstageAiRoundId ? { aiRoundId: `peer_${aiRoundId}`, sourceAiRoundId: aiRoundId, aiGenerated: true } : {}),
            ...(isImageLine ? { relayImage: true, ...(line.relayFromMessageId ? { relayFromMessageId: line.relayFromMessageId } : {}) } : {}),
            ...(isLinkLine ? {
              ...(line.linkMetadata && typeof line.linkMetadata === 'object' ? line.linkMetadata : {}),
              relayLink: true,
              url: String(line.linkUrl).trim(),
              ...(line.relayFromMessageId ? { relayFromMessageId: line.relayFromMessageId } : {}),
            } : {}),
            ...(translation ? { translation } : {}),
          },
        }));
      }
      if (droppedLineActors.length) {
        receipts.add({
          code: 'peer_private_lines_dropped',
          status: 'dropped',
          stage: 'side-effect-persist',
          eventType: 'peer_private',
          targetChatId: peerChat.id,
          context: { participantIds: realIds, actors: droppedLineActors },
        });
        appendDebugEvent({
          type: 'peer_private_lines_dropped',
          level: 'warn',
          message: '角色私聊仍有台词未能对齐成员身份',
          context: { chatId: peerChat.id, realIds, droppedLineActors },
        });
      }
      if (batch.some((m) => m && !m.metadata?.plotExplain)) {
        if (await isNearDuplicateSideBatch(peerChat.id, batch)) {
          receipts.add({
            code: 'side_batch_duplicate',
            status: 'deduplicated',
            stage: 'side-effect-persist',
            eventType: 'peer_private',
            targetChatId: peerChat.id,
          });
          continue;
        }
        await saveMessages(batch);
        const last = batch[batch.length - 1];
        await updateChatPreview(peerChat.id, previewFromMessage(last), last.timestamp);
        await persistCrossWindowStateEvents(peerChat, event, {
          allowedSpeakerIds: [...acceptedSpeakerIds],
          resolveSenderName,
          aiRoundId: aiRoundId ? `peer_${aiRoundId}` : '',
          aiRoundCreatedAt: options.aiRoundCreatedAt,
          userId,
          userName: options.userName,
          regexSurface: options.regexSurface,
          now: last.timestamp,
        }).catch(() => null);
        saved.push({ chatId: peerChat.id, count: batch.length, kind: 'peer_private' });
        touchedChatIds.add(peerChat.id);
        resetBackstagePity(realIds).catch(() => {});
      }
      continue;
    }
    if (event.t === 'backstage') {
      const room = String(event.room || '秘密基地').trim() || '秘密基地';
      lastRoomName = room;
      const nextTs = buildTimestampAllocator(await getNowForUser(userId));
      const lines = expandSideChatLineBodies(Array.isArray(event.lines) ? event.lines : []);
      const activeFormalParticipantIds = [...new Set([
        ...lines
          .map((line) => String(line?.from || line?.actor || line?.senderId || '').trim())
          .filter((id) => !isEphemeralNpcActorId(id)),
      ].filter((id) => id && id !== 'user' && id !== 'unknown'))];
      if (!lines.length) continue;
      const explicitMemberIds = [...new Set((Array.isArray(event.memberIds) ? event.memberIds : [])
        .map((id) => String(id || '').trim())
        .filter((id) => id && id !== 'user' && id !== 'unknown' && !isEphemeralNpcActorId(id)))];
      if (explicitMemberIds.length
        && activeFormalParticipantIds.some((id) => !explicitMemberIds.includes(id))) {
        receipts.add({
          code: 'backstage_speaker_not_in_explicit_roster',
          status: 'blocked',
          stage: 'side-effect-persist',
          eventType: 'backstage',
          chatId: parentChatId || chat?.id || '',
          context: { room, memberIds: explicitMemberIds, speakerIds: activeFormalParticipantIds },
        });
        continue;
      }
      let formalParticipantIds = explicitMemberIds.length
        ? explicitMemberIds
        : activeFormalParticipantIds;
      const backstageChats = await listBackstageChats(userId).catch(() => []);
      const requestedInitiatorId = String(event.initiatorId || '').trim();
      const sameRosterChats = backstageChats.filter(
        (row) => participantSetKey(row?.participants) === participantSetKey(formalParticipantIds),
      );
      const distinctRoomKey = String(room || '').replace(/\s+/g, '').toLowerCase();
      const relatedRosterChats = backstageChats.filter(
        (row) => areBackstageParticipantSetsCompatible(row?.participants, formalParticipantIds),
      );
      const allowDistinctGroup = event.create === true
        && event.initiatorExplicit === true
        && !!requestedInitiatorId
        && !!String(event.newGroupReason || '').trim()
        && relatedRosterChats.length > 0
        && (sameRosterChats.length === 0 || sameRosterChats.every(
          (row) => String(row.groupSettings?.owner || '').trim() !== requestedInitiatorId,
        ))
        && relatedRosterChats.every(
          (row) => String(row.groupSettings?.name || '').replace(/\s+/g, '').toLowerCase() !== distinctRoomKey,
        );
      const targetResolution = allowDistinctGroup
        ? { chat: null, resolution: 'distinct_create' }
        : resolveBackstageTargetChat(
          backstageChats,
          event,
          formalParticipantIds,
          userId,
          parentChatId || chat?.id || '',
        );
      const existingRoom = targetResolution.chat;
      if (existingRoom) {
        const storedMemberIds = [...new Set((existingRoom.participants || [])
          .map((id) => String(id || '').trim())
          .filter((id) => id && id !== 'user'))];
        if (storedMemberIds.length
          && storedMemberIds.some((id) => !formalParticipantIds.includes(id))) {
          formalParticipantIds = storedMemberIds;
          receipts.add({
            code: 'backstage_roster_corrected',
            status: 'routed',
            stage: 'side-effect-persist',
            eventType: 'backstage',
            targetChatId: existingRoom.id,
            context: {
              declaredMemberIds: explicitMemberIds,
              storedMemberIds,
            },
          });
        }
      }
      const socialBoundary = await checkPhoneSocialParticipantIds(formalParticipantIds, userId)
        .catch(() => ({ allowed: false }));
      if (!socialBoundary.allowed) {
        receipts.add({
          code: 'phone_social_group_boundary',
          status: 'blocked',
          stage: 'side-effect-persist',
          eventType: 'backstage',
          chatId: existingRoom?.id || parentChatId || chat?.id || '',
          context: {
            room,
            participantIds: [
              socialBoundary.pair?.leftId,
              socialBoundary.pair?.rightId,
            ].filter(Boolean),
          },
        });
        appendDebugEvent({
          type: 'phone_social_group_boundary_blocked',
          level: 'warn',
          message: '幕后群成员之间尚未建立社交联系，已跳过',
          context: { room, participantIds: formalParticipantIds },
        });
        continue;
      }
      if (existingRoom && targetResolution.resolution.startsWith('corrected_')) {
        receipts.add({
          code: 'backstage_target_corrected',
          status: 'routed',
          stage: 'side-effect-persist',
          eventType: 'backstage',
          targetChatId: existingRoom.id,
          context: {
            requestedTargetChatId: String(event.targetChatId || ''),
            room,
            resolution: targetResolution.resolution,
          },
        });
      }
      if (!existingRoom && event.create !== true && formalParticipantIds.length !== 2) {
        receipts.add({
          code: 'backstage_target_unresolved',
          status: 'blocked',
          stage: 'side-effect-persist',
          eventType: 'backstage',
          chatId: parentChatId || chat?.id || '',
          context: {
            requestedTargetChatId: String(event.targetChatId || ''),
            room,
            participantIds: formalParticipantIds,
          },
        });
        appendDebugEvent({
          type: 'backstage_target_unresolved',
          level: 'warn',
          message: '幕后群目标无法唯一确定，已跳过写入',
          context: { room, participantIds: formalParticipantIds },
        });
        continue;
      }
      const explicitObserver = formalParticipantIds.length === 2
        ? await findPresetGroupChatForParticipants(userId, formalParticipantIds).catch(() => null)
        : null;
      const gate = decideBackstagePersistenceGate({
        participantIds: formalParticipantIds,
        existingChat: existingRoom,
        explicitObserverChat: explicitObserver,
        explicitMemberIds,
      });
      if (!gate.allowed) {
        receipts.add({
          code: gate.code,
          status: 'blocked',
          stage: 'side-effect-persist',
          eventType: 'backstage',
          chatId: parentChatId || chat?.id || '',
          context: { room, participantIds: formalParticipantIds },
        });
        appendDebugEvent({
          type: 'backstage_round_gate_blocked',
          level: 'warn',
          message: '幕后事件未命中完整多人 roster，已跳过建群',
          context: { room, participantIds: formalParticipantIds, code: gate.code },
        });
        continue;
      }
      if (gate.route === 'peer_private') {
        const initiator = formalParticipantIds.includes(event.from) ? event.from : formalParticipantIds[0];
        const nested = await persistBackstageSideEffects([{
          ...event,
          t: 'peer_private',
          from: initiator,
          to: formalParticipantIds.find((id) => id !== initiator) || formalParticipantIds[1],
          coercedFromBackstage: true,
          roomHint: room,
        }], options);
        saved.push(...nested);
        for (const receipt of nested.receipts || []) receipts.add(receipt);
        receipts.add({
          code: gate.code,
          status: 'routed',
          stage: 'side-effect-persist',
          eventType: 'peer_private',
          context: { participantIds: formalParticipantIds },
        });
        continue;
      }
      let backstageChat = gate.chat || existingRoom;
      if (!backstageChat) {
        if (!allowGroupCreation) {
          receipts.add({
            code: 'group_creation_disabled',
            status: 'blocked',
            stage: 'side-effect-persist',
            eventType: 'backstage',
            chatId: parentChatId || chat?.id || '',
            context: { room, participantIds: gate.participantIds },
          });
          continue;
        }
        if (Number(groupCreationBudget.remaining) <= 0) {
          receipts.add({
            code: groupCreationBudget.cooldownBlocked
              ? 'group_creation_cooldown'
              : 'group_creation_round_limit',
            status: 'blocked',
            stage: 'side-effect-persist',
            eventType: 'backstage',
            chatId: parentChatId || chat?.id || '',
            context: { room, participantIds: gate.participantIds },
          });
          continue;
        }
        try {
          const existingBackstageIds = new Set((await listBackstageChats(userId).catch(() => []))
            .map((candidate) => String(candidate?.id || ''))
            .filter(Boolean));
          backstageChat = await ensureBackstageChat(
            userId,
            parentChatId || chat?.id,
            room,
            gate.participantIds,
            {
              ownerId: gate.participantIds.includes(event.initiatorId)
                ? event.initiatorId
                : gate.participantIds.includes(event.from)
                  ? event.from
                  : String(lines[0]?.from || lines[0]?.actor || lines[0]?.senderId || '').trim(),
              allowDistinctGroup,
              distinctPurpose: allowDistinctGroup ? event.newGroupReason : '',
            },
          );
          if (!existingBackstageIds.has(String(backstageChat?.id || ''))) {
            groupCreationBudget.remaining = Math.max(0, Number(groupCreationBudget.remaining) - 1);
          }
        } catch (error) {
          if (error?.code !== 'BACKSTAGE_MEMBER_EXPANSION_REQUIRES_GROUP_ACTION') throw error;
          receipts.add({
            code: 'backstage_member_expansion_requires_group_action',
            status: 'blocked',
            stage: 'side-effect-persist',
            eventType: 'backstage',
            targetChatId: String(error.chatId || ''),
            context: {
              room,
              addedMemberIds: error.participantIds || [],
            },
          });
          continue;
        }
      }
      // 模型现场编出的名字先落成非通讯录轻量 NPC，再进入群成员表。ID 在这个群里稳定复用；
      // 日后从群详情加入通讯录时沿用同一 ID，因此历史消息和群成员关系无需迁移。
      const lightweightByLabel = new Map();
      for (const line of lines) {
        const rawId = String(line?.from || line?.actor || line?.senderId || '').trim();
        if (!isEphemeralNpcActorId(rawId) && line?.ephemeralNpc !== true) continue;
        const label = stripEphemeralNpcLabel(line.fromLabel)
          || stripEphemeralNpcLabel(rawId)
          || '路人';
        let lightweight = lightweightByLabel.get(label);
        if (!lightweight) {
          lightweight = await ensureLightweightNpc({
            name: label,
            sourceChatId: backstageChat.id,
            note: `来自「${room}」`,
            ...phoneEnsureOptions(options),
          });
          if (!lightweight) continue;
          lightweightByLabel.set(label, lightweight);
        }
        line.from = lightweight.id;
        line.fromLabel = lightweight.name;
        line.ephemeralNpc = false;
        remapCrossWindowStateActor(event, [rawId, label], lightweight.id);
      }
      const lightweightIds = [...lightweightByLabel.values()].filter(Boolean).map((row) => row.id);
      if (lightweightIds.some((id) => !(backstageChat.participants || []).includes(id))) {
        backstageChat.participants = [...new Set([
          ...(backstageChat.participants || []),
          ...lightweightIds,
        ])];
        await saveChat(backstageChat);
      }
      const batch = [];
      const acceptedSpeakerIds = new Set();
      batch.push(buildSideChatPlotMessage(backstageChat.id, event, {
        timestamp: nextTs(),
        kind: 'backstage',
        parentChatId: parentChatId || chat?.id || '',
        userName: options.userName,
        aiRoundId: backstageAiRoundId,
        sourceAiRoundId: aiRoundId,
      }));
      for (const line of lines) {
        const senderId = String(line.from || line.actor || line.senderId || 'unknown').trim();
        const ephemeral = isEphemeralNpcActorId(senderId) || line.ephemeralNpc === true;
        const senderName = isLightweightNpcId(senderId)
          ? (String(line.fromLabel || '').trim() || senderId)
          : ephemeral
          ? (stripEphemeralNpcLabel(line.fromLabel) || stripEphemeralNpcLabel(senderId) || '路人')
          : await resolveSideChatActorName(senderId, options, line.fromLabel);
        // 只有身份本身是占位符才丢行；正式成员的显示名兜底失败不构成丢弃理由。
        if (isGenericPeerActorLabel(line.fromLabel) || isGenericPeerActorLabel(senderId)) {
          receipts.add({
            code: 'backstage_line_actor_dropped',
            status: 'dropped',
            stage: 'side-effect-persist',
            eventType: 'backstage',
            targetChatId: backstageChat.id,
            context: { actor: String(line.fromLabel || senderId || '') },
          });
          continue;
        }
        acceptedSpeakerIds.add(senderId);
        const lineBody = String(line.body || line.text || line.content || '').trim();
        const senderTranslationProfile = options.characters?.[senderId]?.translationProfile || {};
        const lineTranslation = sanitizeAiTranslation(lineBody, line.zh || line.translation, {
          languageHint: senderTranslationProfile.language || senderTranslationProfile.dialectNote || '',
        });
        const isImageLine = line.kind === 'image' && /^(https?:\/\/|data:image\/)/i.test(String(line.imageUrl || '').trim());
        const isLinkLine = line.kind === 'link' && /^https?:\/\//i.test(String(line.linkUrl || '').trim());
        batch.push(createMessage({
          chatId: backstageChat.id,
          senderId,
          senderName,
          type: isImageLine ? 'image' : (isLinkLine ? 'link' : 'text'),
          content: isImageLine
            ? String(line.imageUrl).trim()
            : (isLinkLine ? String(line.linkUrl).trim() : String(line.body || line.text || line.content || '').trim()),
          timestamp: nextTs(),
          metadata: {
            protocol: 'MARSHMALLOW_CHAT_V2',
            backstage: true,
            parentChatId: parentChatId || chat?.id || '',
            ...(backstageAiRoundId ? { aiRoundId: backstageAiRoundId, sourceAiRoundId: aiRoundId, aiGenerated: true } : {}),
            ...(isImageLine ? { relayImage: true, ...(line.relayFromMessageId ? { relayFromMessageId: line.relayFromMessageId } : {}) } : {}),
            ...(isLinkLine ? {
              ...(line.linkMetadata && typeof line.linkMetadata === 'object' ? line.linkMetadata : {}),
              relayLink: true,
              url: String(line.linkUrl).trim(),
              ...(line.relayFromMessageId ? { relayFromMessageId: line.relayFromMessageId } : {}),
            } : {}),
            ...(ephemeral ? { ephemeralNpc: true } : {}),
            ...(lineTranslation ? { translation: lineTranslation } : {}),
          },
        }));
      }
      if (batch.some((m) => m && !m.metadata?.plotExplain)) {
        if (await isNearDuplicateSideBatch(backstageChat.id, batch)) {
          receipts.add({
            code: 'side_batch_duplicate',
            status: 'deduplicated',
            stage: 'side-effect-persist',
            eventType: 'backstage',
            targetChatId: backstageChat.id,
          });
          continue;
        }
        await saveMessages(batch);
        const last = batch[batch.length - 1];
        await updateChatPreview(backstageChat.id, previewFromMessage(last), last.timestamp);
        await persistCrossWindowStateEvents(backstageChat, event, {
          allowedSpeakerIds: [...acceptedSpeakerIds],
          resolveSenderName,
          aiRoundId: backstageAiRoundId,
          aiRoundCreatedAt: options.aiRoundCreatedAt,
          userId,
          userName: options.userName,
          regexSurface: options.regexSurface,
          now: last.timestamp,
        }).catch(() => null);
        saved.push({ chatId: backstageChat.id, count: batch.length });
        touchedChatIds.add(backstageChat.id);
        const realSpeakerIds = lines
          .map((line) => String(line?.from || line?.actor || line?.senderId || '').trim())
          .filter((id) => id && id !== 'user' && id !== 'unknown' && !isEphemeralNpcActorId(id));
        resetBackstagePity(realSpeakerIds).catch(() => {});
      }
      continue;
    }
    if (event.t === 'chat_bundle') {
      let senderId = String(event.from || '').trim();
      if (!senderId) continue;
      let lightweightSender = null;
      if (event.ephemeralNpc === true || isEphemeralNpcActorId(senderId)) {
        const label = stripEphemeralNpcLabel(event.fromName)
          || stripEphemeralNpcLabel(event.fromLabel)
          || stripEphemeralNpcLabel(senderId)
          || '路人';
        lightweightSender = await ensureLightweightNpc({
          name: label,
          sourceChatId: parentChatId || chat?.id || 'chat-bundle',
          note: '来自合并转发',
          ...phoneEnsureOptions(options),
        });
        if (!lightweightSender) continue;
        senderId = lightweightSender.id;
        event.from = senderId;
        event.fromName = lightweightSender.name;
        event.ephemeralNpc = false;
      }
      const targetId = String(event.to || '').trim();
      const ts = await getNowForUser(userId);
      if (targetId === 'user') {
        const senderName = lightweightSender?.name || event.fromName
          || await resolveSideChatActorName(senderId, options);
        const userChat = await ensurePrivateChat(userId, senderId, senderName);
        const msg = createMessage({
          chatId: userChat.id,
          senderId,
          senderName,
          type: 'chatBundle',
          content: `[合并转发] ${event.bundleTitle || '聊天记录'}`,
          timestamp: ts,
          metadata: {
            protocol: 'MARSHMALLOW_CHAT_V2',
            parentChatId: parentChatId || chat?.id || '',
            ...(aiRoundId ? { aiRoundId: `private_${aiRoundId}`, sourceAiRoundId: aiRoundId, aiGenerated: true } : {}),
            bundleTitle: event.bundleTitle || '聊天记录',
            bundleSummary: event.bundleSummary || '',
            items: Array.isArray(event.items) ? event.items : [],
            relayBundle: true,
            forwardedFromRoleOnlyChat: true,
          },
        });
        if (await isNearDuplicateSideBatch(userChat.id, [msg])) continue;
        await saveMessages([msg]);
        await updateChatPreview(userChat.id, previewFromMessage(msg), msg.timestamp);
        saved.push({ chatId: userChat.id, count: 1, kind: 'private_user' });
        touchedChatIds.add(userChat.id);
        continue;
      }
      if (targetId && targetId !== 'user' && targetId !== senderId) {
        const sociallyEligible = await canPhoneCharacterIdsKnowEachOther(
          senderId,
          targetId,
          userId,
        ).catch(() => false);
        if (sociallyEligible === false) {
          appendDebugEvent({
            type: 'chat_bundle_social_boundary_blocked',
            level: 'warn',
            message: '合并转发目标跨越通讯录分组且无关系网授权，已跳过',
            context: {
              parentChatId: parentChatId || chat?.id || '',
              participantIds: [senderId, targetId],
            },
          });
          continue;
        }
        const peerChat = await ensurePeerPrivateChat(userId, [senderId, targetId], {
          parentChatId: parentChatId || chat?.id,
          focalActorId: senderId,
        });
        const msg = createMessage({
          chatId: peerChat.id,
          senderId,
          senderName: lightweightSender?.name || event.fromName
            || await resolveSideChatActorName(senderId, options),
          type: 'chatBundle',
          content: `[合并转发] ${event.bundleTitle || '聊天记录'}`,
          timestamp: ts,
          metadata: {
            protocol: 'MARSHMALLOW_CHAT_V2',
            peerPrivate: true,
            parentChatId: parentChatId || chat?.id || '',
            ...(aiRoundId ? { aiRoundId: `peer_${aiRoundId}`, sourceAiRoundId: aiRoundId, aiGenerated: true } : {}),
            bundleTitle: event.bundleTitle || '聊天记录',
            bundleSummary: event.bundleSummary || '',
            items: Array.isArray(event.items) ? event.items : [],
            relayBundle: true,
            forwardedToCharacterId: targetId,
          },
        });
        if (await isNearDuplicateSideBatch(peerChat.id, [msg])) continue;
        await saveMessages([msg]);
        await updateChatPreview(peerChat.id, previewFromMessage(msg), msg.timestamp);
        saved.push({ chatId: peerChat.id, count: 1, kind: 'peer_private' });
        touchedChatIds.add(peerChat.id);
        resetBackstagePity([senderId, targetId]).catch(() => {});
        continue;
      }
      const room = String(event.room || lastRoomName || '秘密基地').trim() || '秘密基地';
      const senderName = lightweightSender?.name || event.fromName
        || await resolveSideChatActorName(senderId, options);
      const participantIds = [...new Set([
        ...(chat?.participants || []),
        senderId,
      ].filter((id) => id && id !== 'user' && id !== 'unknown'))];
      const backstageChat = await ensureBackstageChat(
        userId,
        parentChatId || chat?.id,
        room,
        participantIds,
        { ownerId: participantIds.includes(event.from) ? event.from : senderId },
      );
      const msg = createMessage({
        chatId: backstageChat.id,
        senderId,
        senderName,
        type: 'chatBundle',
        content: `[合并转发] ${event.bundleTitle || '聊天记录'}`,
        timestamp: ts,
        metadata: {
          protocol: 'MARSHMALLOW_CHAT_V2',
          backstage: true,
          parentChatId: parentChatId || chat?.id || '',
          ...(backstageAiRoundId ? { aiRoundId: backstageAiRoundId, sourceAiRoundId: aiRoundId, aiGenerated: true } : {}),
          bundleTitle: event.bundleTitle || '聊天记录',
          bundleSummary: event.bundleSummary || '',
          items: Array.isArray(event.items) ? event.items : [],
          relayBundle: true,
        },
      });
      await saveMessages([msg]);
      await updateChatPreview(backstageChat.id, previewFromMessage(msg), msg.timestamp);
      saved.push({ chatId: backstageChat.id, count: 1 });
      touchedChatIds.add(backstageChat.id);
      continue;
    }
  }
  if (touchedChatIds.size && userId) {
    for (const backstageChatId of touchedChatIds) {
      const backstageChatRow = await getChat(backstageChatId).catch(() => null);
      if (!backstageChatRow) continue;
      // 幕后聊天记录也走同一套「按时间线增量 + 群聊上下文 + 真实发言人物」摘要管线，
      // 是否真的生成取决于该幕后群自己的自动摘要开关（不强改默认值）。
      maybeSummarizeChatMemory({
        chat: backstageChatRow,
        userId,
        resolveName: resolveSenderName,
      }).catch(() => {});
    }
  }
  return attachReceipts(saved, receipts.list());
}

const MEMORY_FACT_USER_LABELS = new Set(['user', '用户', '我', '匿名用户', '匿名网友']);

/**
 * memory_fact 事件的 subject/object 是模型现场写的自然语言人名（曾用名/外号，甚至偶尔
 * 是幻觉出的一句话），不能像 from 字段那样直接假定它已经是真实 id。这里把它按「用户占位/
 * 用户当前昵称/已知角色」解析成内部 id；三者都对不上时故意返回空——不把 AI 写的原始文本
 * 直接当成一个新角色 id 落库（那会在记忆馆里生出一个不存在的"角色"，参见 memory-facts.js
 * 里 resolveEntityId 的同一处理）。
 */
function buildMemoryFactEntityResolver({ chat = null, characters = {}, currentUserName = '' } = {}) {
  const participantIds = new Set((chat?.participants || []).filter(Boolean));
  const nameMap = new Map();
  for (const pid of participantIds) {
    if (pid === 'user') continue;
    const char = characters?.[pid] || null;
    const keys = [pid, char?.name, char?.realName, char?.customNickname, ...(Array.isArray(char?.aliases) ? char.aliases : [])];
    for (const key of keys) {
      const k = String(key || '').trim();
      if (k && !nameMap.has(k)) nameMap.set(k, pid);
    }
  }
  const userLabel = String(currentUserName || '').trim();
  return function resolve(raw = '') {
    const name = String(raw || '').trim();
    if (!name) return '';
    if (MEMORY_FACT_USER_LABELS.has(name)) return 'user';
    if (userLabel && name === userLabel) return 'user';
    if (participantIds.has(name)) return name;
    return nameMap.get(name) || '';
  };
}

async function applyMarshmallowMemoryFactEvents(events = [], options = {}) {
  const list = Array.isArray(events) ? events.filter((e) => e?.t === 'memory_fact') : [];
  const chat = options.chat || null;
  const chatId = String(options.chatId || chat?.id || '').trim();
  const userId = String(options.userId || '').trim();
  if (!list.length || !chatId || !userId) return { stored: 0 };
  const currentUserName = String(options.currentUserName || '').trim();
  const resolveEntity = buildMemoryFactEntityResolver({ chat, characters: options.characters || {}, currentUserName });
  let stored = 0;
  for (const event of list) {
    const content = String(event.content || '').trim();
    if (!content) continue;
    const subjectRaw = String(event.subject || 'user').trim() || 'user';
    const objectRaw = String(event.object || '').trim();
    const actor = String(event.from || '').trim();
    const subjectId = resolveEntity(subjectRaw);
    const userLabel = currentUserName || '用户';
    const subjectName = subjectId === 'user'
      ? normalizeUserFacingLabel(event.subjectName || subjectRaw, userLabel)
      : String(event.subjectName || subjectRaw).trim();
    const objectId = resolveEntity(objectRaw);
    const objectName = objectId === 'user'
      ? normalizeUserFacingLabel(event.objectName || objectRaw, userLabel)
      : String(event.objectName || objectRaw).trim();
    const knownBy = actor ? { [actor]: true } : {};
    const aliasScope = isStrangerInterceptChat(chat);
    const principalType = subjectId === 'user' ? 'user' : 'character';
    const principalId = subjectId === 'user' ? userId : subjectId;
    const subjectKey = principalKey(principalType, principalId);
    const accountId = aliasScope ? String(chat.metadata?.accountIdentityMap?.[subjectKey] || '').trim() : '';
    const revealState = aliasScope
      ? normalizeRevealEntry(chat.metadata?.identityReveal?.[subjectKey]).state
      : '';
    // 知情主体始终可跨窗召回：线程里挂了马甲的角色、以及作为参与方经历本线程的角色
    const linkedPrincipalKeys = aliasScope
      ? [...new Set([
        ...Object.keys(chat.metadata?.accountIdentityMap || {})
          .filter((key) => String(key).startsWith('character:') && String(chat.metadata.accountIdentityMap[key] || '').trim()),
        ...(Array.isArray(chat.participants) ? chat.participants : [])
          .map((id) => String(id || '').trim())
          .filter((id) => id && id !== 'user')
          .map((id) => principalKey('character', id)),
        subjectId && subjectId !== 'user' ? principalKey('character', subjectId) : '',
        objectId && objectId !== 'user' ? principalKey('character', objectId) : '',
      ].filter(Boolean))]
      : [];
    const saved = await upsertMemoryFact({
      userId,
      chatId,
      sourceChatId: chatId,
      subjectId,
      subjectName,
      objectId,
      objectName,
      factType: String(event.factType || '关系印象').trim() || '关系印象',
      canonicalKey: String(event.canonicalKey || '').trim(),
      content,
      evidence: String(event.evidence || 'AI 根据本轮聊天/头像视觉记录').trim(),
      confidence: 0.82,
      visibility: 'private',
      knownBy,
      tags: Array.isArray(event.tags) ? event.tags : [],
      sourceMessageIds: [],
      ...(aliasScope ? {
        scope: 'account_alias',
        principalType,
        principalId,
        accountId,
        revealState,
        linkedPrincipalKeys,
      } : {}),
    }).catch((err) => {
      console.warn('[ai-round] persist memory_fact failed', err);
      return null;
    });
    if (saved) stored += 1;
  }
  return { stored };
}

/**
 * 解析并落库棉花糖协议回合
 */
export async function persistMarshmallowTurn(rawText = '', options = {}) {
  const persistStartedAt = Date.now();
  const persistTiming = {};
  const markPersistTiming = (name) => {
    persistTiming[name] = Math.max(0, Date.now() - persistStartedAt);
  };
  await primeRegex().catch(() => null);
  // need_search 是给客户端的查证申请，不是可落库事件；无论哪条持久化路径都先剥掉
  rawText = stripNeedSearchEvents(rawText);
  rawText = stripCapabilityIntentEvents(rawText);
  const replyCompositionReceipt = extractReplyCompositionReceipt(rawText);
  let replyCompositionDiagnostics = {
    receipt: replyCompositionReceipt.reason,
    mode: 'legacy',
  };
  const chat = options.chat;
  const chatId = String(options.chatId || chat?.id || '').trim();
  const aiRoundId = String(options.aiRoundId || '').trim();
  const aiRoundCreatedAt = Number(options.aiRoundCreatedAt || 0);
  const rerollRootId = String(options.rerollRootId || aiRoundId).trim();
  const aiRoundKind = String(options.aiRoundKind || '').trim();
  const gapStart = Number(options.gapFillWindow?.startTs || 0);
  const gapEnd = Number(options.gapFillWindow?.endTs || 0);
  let messages = Array.isArray(options.messages) ? options.messages : [];
  const user = options.user || null;
  const userId = String(options.userId || user?.id || '').trim();
  const currentUserName = String(options.currentUserName || getUserConversationName(user)).trim() || '用户';
  const characters = options.characters || {};
  const resolveSenderName = typeof options.resolveSenderName === 'function'
    ? options.resolveSenderName
    : async (id) => (id === 'user' ? currentUserName : String(id));

  async function checkDeliveryGuard(stage = '') {
    if (typeof options.deliveryGuard !== 'function') return { ok: true };
    try {
      const result = await options.deliveryGuard({ stage, chatId, aiRoundId });
      if (result === false) return { ok: false, reason: 'delivery-blocked' };
      if (result && typeof result === 'object' && result.ok === false) return result;
      return { ok: true };
    } catch (_) {
      return { ok: false, reason: 'delivery-guard-failed' };
    }
  }

  const parseOpts = {
    allowOpenTail: options.allowOpenTail !== false,
    allowBareJsonl: true,
    salvageTruncated: options.salvageTruncated !== false,
  };
  let parsed = parseMarshmallowChatV2(rawText, parseOpts);
  if (!parsed.events.length) {
    const salvagedParse = salvageParseMarshmallowChatV2(rawText);
    if (salvagedParse.events.length) parsed = salvagedParse;
  }
  if (!parsed.events.length) {
    const safeDefaultActorId = chat?.type === 'private' || options.onlySenderId
      ? String(options.onlySenderId || options.currentActorId || getPartnerActor(chat) || '').trim()
      : '';
    const safeDefaultActor = safeDefaultActorId ? characters?.[safeDefaultActorId] : null;
    const legacyTagged = convertLegacyTaggedChatOutput(rawText, {
      defaultActorId: safeDefaultActorId,
      defaultActorLabels: [
        safeDefaultActor?.name,
        safeDefaultActor?.realName,
        safeDefaultActor?.customNickname,
      ],
    });
    if (legacyTagged) {
      const legacyParsed = parseMarshmallowChatV2(legacyTagged, parseOpts);
      if (legacyParsed.events.length) parsed = { ...legacyParsed, legacyTaggedFallback: true };
    }
  }
  if (!parsed.found || !parsed.events.length) {
    return {
      ok: false,
      ...classifyMarshmallowParseFailure(rawText, parsed),
      errors: parsed.errors,
    };
  }
  markPersistTiming('protocolParsedMs');

  const phoneViewerId = String(options.phoneViewerId || '').trim();
  const phoneAddressBookOwnerId = phoneViewerId
    || String(options.currentActorId || getPartnerActor(chat) || '').trim();
  const shouldResolveRemoteGroups = chat?.type === 'private' && isUserPresentInChat(chat);
  const [storedCharacters, lightweightNpcs, phoneAddressBook, remoteGroupChats] = await Promise.all([
    listCharacters({ userId }).catch(() => []),
    // 手机侧只能解析当前手机主人的本地联系人；普通聊天仍保留全局轻量 NPC
    // 兼容旧事件，同时额外装入本轮发起角色自己的手机通讯录。
    phoneViewerId ? Promise.resolve([]) : listLightweightNpcs(userId).catch(() => []),
    (async () => {
      if (!userId || !phoneAddressBookOwnerId) return [];
      try {
        const {
          loadCharacterPhoneContacts,
          buildPhoneContactsAddressBook,
        } = await import('../character-phone-contacts.js');
        const state = await loadCharacterPhoneContacts(userId, phoneAddressBookOwnerId).catch(() => null);
        return buildPhoneContactsAddressBook(state?.contacts || [], phoneAddressBookOwnerId);
      } catch (_) {
        return [];
      }
    })(),
    shouldResolveRemoteGroups ? listChatsForUser(userId).catch(() => []) : [],
  ]);
  // 手机通讯录 = 角色自己的小关系网；手机模式不混入全局轻量 NPC。
  const addressBookCharacters = [...storedCharacters, ...lightweightNpcs, ...phoneAddressBook];
  // 页面级 characters 只装本窗成员是 UI 优化；AI 落库（尤其跨窗 peer_private /
  // backstage）必须认识通讯录全员，否则窗外正式角色会被名字解析兜底成「对方」后误丢。
  for (const row of addressBookCharacters) {
    if (row?.id && !characters[row.id]) characters[row.id] = row;
  }
  const phoneContactIds = phoneAddressBook.map((row) => row?.id).filter(Boolean);
  const preferPeerIds = [...new Set([
    ...((chat?.participants || []).filter((id) => id && id !== 'user')),
    ...(Array.isArray(options.preferPeerIds) ? options.preferPeerIds : []),
  ])];
  const remoteGroupIds = shouldResolveRemoteGroups
    ? remoteGroupChats
      .filter((candidate) => (
        candidate?.type === 'group'
        && !isAnonymousChat(candidate)
        && (candidate.participants || []).some((id) => id && id !== 'user' && (chat.participants || []).includes(id))
      ))
      .map((candidate) => candidate.id)
      .filter(Boolean)
    : [];
  markPersistTiming('actorContextReadyMs');
  const validateOpts = {
    chat,
    messages,
    characters,
    currentUserName,
    addressBookCharacters,
    extraActorIds: [...new Set([
      ...(Array.isArray(options.extraActorIds) ? options.extraActorIds : []),
      ...phoneContactIds,
    ])],
    actorResolutionExtraIds: options.actorResolutionExtraIds
      || [...new Set([
        ...Object.keys(characters || {}),
        ...addressBookCharacters.map((row) => row.id),
        ...phoneContactIds,
      ].filter(Boolean))],
    preferPeerIds,
    remoteGroupIds,
  };
  const protocolEvents = repairPhonePeerActorEvents(parsed.events, {
    chat,
    characters,
    phoneViewerId: options.phoneViewerId,
  });
  let checked = validateMarshmallowChatEvents(protocolEvents, validateOpts);
  let partialSalvage = !!parsed.salvagedParse;
  if (!checked.valid.length) {
    const bubbleEvents = filterSalvageableMarshmallowBubbleEvents(protocolEvents);
    if (bubbleEvents.length) {
      const salvageChecked = validateMarshmallowChatEvents(bubbleEvents, {
        ...validateOpts,
        salvageBubbles: true,
      });
      if (salvageChecked.valid.length) {
        checked = salvageChecked;
        partialSalvage = true;
      }
    }
  }
  if (checked.valid.length && checked.rejected.length) {
    const rejectedSummary = checked.rejected.slice(0, 6).map((row) => ({
      type: String(row?.event?.t || ''),
      actor: eventActorValue(row?.event),
      to: String(row?.event?.to || '').trim(),
      from: String(row?.event?.from || row?.event?.actor || '').trim(),
      errors: (row?.errors || []).map((error) => String(error?.code || '')).filter(Boolean),
    }));
    const rejectBits = rejectedSummary.map((row) => {
      const codes = (row.errors || []).join('/') || 'unknown';
      return `${row.type || 'event'}:${codes}`;
    }).join('；');
    appendDebugEvent({
      type: 'chat_events_partially_rejected',
      level: 'warn',
      message: `模型输出中有部分聊天事件未通过身份或事件校验（${rejectBits}）`,
      context: {
        chatId,
        phoneViewerId: String(options.phoneViewerId || '').trim(),
        validCount: checked.valid.length,
        rejected: rejectedSummary,
      },
    });
  }
  if (!checked.valid.length) {
    return {
      ok: false,
      reason: 'validation-failed',
      error: '模型输出的协议事件未通过校验，本轮未落库。',
      rejected: checked.rejected,
      errors: parsed.errors,
      rawText,
    };
  }

  const blockPrefsRow = chatId ? await get(`chatPrefs_${chatId}`).catch(() => null) : null;
  const chatPrefs = blockPrefsRow?.value && typeof blockPrefsRow.value === 'object' ? blockPrefsRow.value : {};
  // 旧存档可能只有 enabled=true、没有用户实际保存的上下限。这种幽灵状态
  // 与“未开启”一致，不能拿展示层的回退值给提示词或落库链路暗加范围。
  const preferredBubbleRange = resolveEnabledChatBubbleRange(chatPrefs);

  if (replyCompositionReceipt.receipt && options.replyCompositionEnabled !== false) {
    const packingEnabled = chat?.type === 'private'
      && !partialSalvage
      && parsed.legacyTaggedFallback !== true
      && checked.rejected.length === 0
      && !options.onlySenderId
      && !options.phoneViewerId
      && !options.proactiveChannel
      && options.realPersonChase !== true
      && !options.gapFillWindow
      && options.offlineReturnBridge !== true
      && checked.valid.every((event) => (
        REPLY_COMPOSITION_ACTIVE_EVENT_TYPES.has(String(event?.t || ''))
        && isPlainReplyCompositionMessage(event)
      ));
    const candidate = applyReplyCompositionReceipt(
      checked.valid,
      replyCompositionReceipt.receipt,
      {
        packingEnabled,
        bubbleRange: preferredBubbleRange,
        shortBubble: chatPrefs.shortBubbleReply === true,
      },
    );
    replyCompositionDiagnostics = {
      receipt: replyCompositionReceipt.reason,
      mode: packingEnabled ? 'active' : 'metadata-only',
      packingEnabled,
      metadataAttached: false,
      applied: candidate.applied === true,
      reason: String(candidate.reason || ''),
      ...(candidate.diagnostics || {}),
    };
    if (!packingEnabled && candidate.applied === true) {
      // 富消息（翻译、引用、语音计划等）不能参与 packing：合并会让附着在单个
      // 气泡上的字段丢失或错位。但这些事件在进入这里前已经通过协议校验，收据
      // 也已经由 applyReplyCompositionReceipt 完整校验；metadata-only candidate
      // 只在原事件上附加由本地生成的交付元数据，正文、顺序和富字段均不改动。
      // 必须把它写回 checked，否则后续 materialize 看不到回执，心理结算会断链。
      checked = {
        ...checked,
        valid: candidate.events,
      };
      replyCompositionDiagnostics.metadataAttached = true;
    } else if (packingEnabled && candidate.applied === true) {
      const rechecked = validateMarshmallowChatEvents(candidate.events, validateOpts);
      const candidateMsgCount = candidate.events.filter((event) => event?.t === 'msg').length;
      const recheckedMsgCount = rechecked.valid.filter((event) => event?.t === 'msg').length;
      if (!rechecked.rejected.length && recheckedMsgCount === candidateMsgCount) {
        checked = rechecked;
        replyCompositionDiagnostics.revalidated = true;
        replyCompositionDiagnostics.metadataAttached = true;
      } else {
        replyCompositionDiagnostics.mode = 'legacy';
        replyCompositionDiagnostics.applied = false;
        replyCompositionDiagnostics.reason = 'post-pack-validation-failed';
        replyCompositionDiagnostics.revalidated = false;
      }
    }
    void appendDebugEvent({
      type: 'chat_reply_composition',
      level: replyCompositionDiagnostics.applied ? 'info' : 'warn',
      message: replyCompositionDiagnostics.applied
        ? `回复组织收据已${replyCompositionDiagnostics.mode === 'active' ? '参与气泡装配' : '附加到原始气泡'}`
        : '回复组织收据未通过，已保留原始气泡',
      context: {
        chatId,
        aiRoundId,
        ...replyCompositionDiagnostics,
      },
    });
  }

  // 平行世界模式：转账/红包/线下邀约是「跨世界不可能」的虚空许诺，不依赖模型自觉，确定性丢弃
  let validEvents = groundClaimedGroupActions(checked.valid, chat);
  // 陌生/马甲窗属于用户自己的收件箱。模型即使误写 U/user，也只能生成对方侧事件，
  // 不能替用户发气泡、改关系或执行其它动作；用户操作只允许从真实 UI 入口进入。
  if (isStrangerInterceptChat(chat)) {
    validEvents = validEvents.filter((event) => eventActorValue(event) !== 'user');
  }
  const onlySenderId = String(options.onlySenderId || '').trim();
  if (onlySenderId) {
    const forbiddenSideEffects = new Set([
      'backstage', 'peer_private', 'private_msg', 'invite_user',
      'group_name', 'group_title', 'group_announcement', 'group_todo',
      'group_transfer', 'group_remote', 'mute', 'vote',
    ]);
    validEvents = validEvents.filter((event) => {
      if (!event || forbiddenSideEffects.has(String(event.t || ''))) return false;
      const actor = String(event.from || event.actor || event.senderId || '').trim();
      return actor === onlySenderId;
    });
    if (!validEvents.length) {
      return {
        ok: false,
        reason: 'only-sender-empty',
        error: '本轮没有符合单角色发言约束的消息，未落库。',
        rejected: checked.rejected,
        errors: parsed.errors,
        rawText,
      };
    }
  }
  const roundReceipts = createChatRoundReceiptCollector();
  const allowPrivateMsg = resolveAllowPrivateSend(chat, chatPrefs)
    && !(isNoUserGroup(chat) && resolveUserTopicPolicy(chat) === 'off');
  const privateMsgBeforeGate = validEvents.filter((event) => String(event?.t || '') === 'private_msg').length;
  validEvents = validEvents.filter((event) => String(event?.t || '') !== 'private_msg' || allowPrivateMsg);
  if (!allowPrivateMsg && privateMsgBeforeGate) {
    roundReceipts.add({
      code: 'private_linkage_disabled',
      status: 'blocked',
      stage: 'round-gate',
      eventType: 'private_msg',
      chatId,
      context: { count: privateMsgBeforeGate },
    });
  }
  validEvents = filterMutedGroupActorEvents(validEvents, chat);
  if (!validEvents.length) {
    const allMuted = isAllMutedGroup(chat);
    return {
      ok: false,
      reason: allMuted ? 'all-muted' : 'validation-failed',
      error: allMuted
        ? '本群正处于全员禁言，本轮没有可执行的角色事件，未落库。'
        : '本轮事件均被群禁言或私聊联动设置拦截，未落库。',
      rejected: checked.rejected,
      errors: parsed.errors,
      rawText,
    };
  }
  if (chatPrefs.parallelWorldMode === true) {
    const bannedInParallelWorld = new Set(['transfer', 'transfer_accept', 'transfer_return', 'redpacket', 'redpacket_claim', 'order_share', 'group_transfer', 'offline_invite']);
    validEvents = validEvents.filter((e) => !bannedInParallelWorld.has(String(e?.t || '')));
    if (!validEvents.length) {
      return {
        ok: false,
        reason: 'validation-failed',
        error: '本轮事件全部属于平行世界模式下不可用的类型（转账/红包/购物礼物/线下邀约），未落库。',
        rejected: checked.rejected,
        errors: parsed.errors,
        rawText,
      };
    }
  } else if (chatPrefs.longDistanceMode === true) {
    // Long-distance mode: same world, so money/gifts stay; only in-person invites are impossible.
    validEvents = validEvents.filter((e) => String(e?.t || '') !== 'offline_invite');
    if (!validEvents.length) {
      return {
        ok: false,
        reason: 'validation-failed',
        error: '本轮事件全部是异地模式下不可用的线下邀约，未落库。',
        rejected: checked.rejected,
        errors: parsed.errors,
        rawText,
      };
    }
  }
  // 通话记录在上下文里带有内部识别标签；弱模型偶尔会把标签连同新正文一起照抄。
  // 在消息物化前剥掉，避免内部格式落库并继续污染下一轮上下文。
  validEvents = validEvents.flatMap((event) => {
    if (!event || typeof event.text !== 'string') return [event];
    const text = stripLeakedVoiceCallContextPrefix(event.text);
    if (String(event.t || '') === 'msg' && !text) return [];
    return [{ ...event, text }];
  });
  if (!validEvents.length) {
    return {
      ok: false,
      reason: 'voice-call-context-leak-only',
      error: '模型只返回了通话上下文标签，本轮未落库。',
      rejected: checked.rejected,
      errors: parsed.errors,
      rawText,
    };
  }
  const ensembleGuard = await filterEnsembleConflictingEvents({
    userId,
    chatId,
    events: validEvents,
  }).catch(() => ({ events: validEvents, blocked: [] }));
  validEvents = ensembleGuard.events;
  if (ensembleGuard.blocked.length) {
    appendDebugEvent({
      type: 'ensemble_physical_conflict_blocked',
      level: 'info',
      message: '群像模式拦截了与进行中线下在场状态冲突的事件',
      context: {
        chatId,
        blocked: ensembleGuard.blocked,
      },
    });
  }
  if (!validEvents.length) {
    return {
      ok: false,
      reason: 'ensemble-physical-conflict',
      error: '本轮事件与进行中的线下在场状态冲突，未落库。',
      rejected: checked.rejected,
      errors: parsed.errors,
      rawText,
    };
  }

  const offlineArrivalFeatureEnabled = chat?.groupSettings?.allowAiOfflineInvite === true
    && isUserPresentInChat(chat)
    && !isAnonymousChat(chat)
    && chatPrefs.parallelWorldMode !== true
    && chatPrefs.longDistanceMode !== true
    && options.suppressVisibleMessages !== true;
  if (offlineArrivalFeatureEnabled) {
    const activeOfflineSession = await loadOfflineSession(chatId).catch(() => null);
    const arrivalRepair = repairOfflineInviteTransitionEvents(validEvents, {
      allow: true,
      activeSession: activeOfflineSession?.status === 'active',
      messages,
      chat,
    });
    validEvents = sanitizeOfflineArrivalEvents(arrivalRepair.events);
    if (arrivalRepair.repaired) {
      appendDebugEvent({
        type: 'offline_arrival_card_repaired',
        level: 'info',
        message: '聊天已推进到线下见面阶段，已补齐或刷新线下入口',
        context: {
          chatId,
          reason: arrivalRepair.reason,
        },
      });
    }
  }

  const currentWorldNow = await getNowForUser(userId);
  const requestedBaseTs = Number(options.baseTimestamp || 0) || currentWorldNow;
  const futureTimestampRepairStartedAt = Date.now();
  let futureTimestampRepairCount = 0;
  if (!options.gapFillWindow && chatId && userId) {
    const timeRepair = await repairChatFutureTimestampDrift(chatId, userId, {
      knownMessages: messages,
      // 延迟任务和重 roll 会传入历史 baseTimestamp；修复判断必须看真正的当前世界钟，
      // 否则会把正常的近期记录误当成“未来尾段”一起回拨。
      worldNow: currentWorldNow,
      allowVirtualRollback: true,
    }).catch(() => ({ repaired: false }));
    futureTimestampRepairCount = Math.max(0, Number(timeRepair.count || 0));
    if (timeRepair.repaired) {
      // 修复目标仅位于异常尾段，后续时间分配也只依赖最新记录。全量重读会让三万条
      // 会话在一次回复后永久滞留内存，并放大每次过滤/刷新成本。
      messages = await listMessagesForChat(chatId, 200, { deferHeavyImages: true }).catch(() => messages);
    }
  }
  persistTiming.futureTimestampRepairMs = Math.max(0, Date.now() - futureTimestampRepairStartedAt);
  persistTiming.futureTimestampRepairCount = futureTimestampRepairCount;
  // 闲聊补充会有意写进历史时间窗；其余实时轮次必须接在现有消息之后，
  // 防止虚拟时间回拨或延迟计划晚到时，新气泡在重载后跳到前面。
  const baseTs = resolveChatRoundBaseTimestamp(messages, requestedBaseTs, options.gapFillWindow);
  const visibleEventCount = validEvents.filter((e) => e && (e.t === 'msg' || e.t === 'sticker')).length;
  const nextTs = options.gapFillWindow
    ? buildGapFillAwareAllocator(baseTs, options.gapFillWindow, visibleEventCount)
    : buildTimestampAllocator(baseTs);
  const imageToolCfg = options.allowImageGen == null
    ? await loadImageToolConfig().catch(() => null)
    : null;
  const allowImageGen = options.allowImageGen ?? resolveChatImageGenerationCapability(
    imageToolCfg || {},
    chatPrefs,
  ).allowed;
  const redpacketClaimRepair = repairRedPacketClaimSpeech(validEvents, messages);
  if (redpacketClaimRepair.repaired) {
    validEvents = redpacketClaimRepair.events;
    appendDebugEvent({
      type: 'chat_redpacket_claim_repaired',
      level: 'info',
      message: '角色已在台词中明确抢红包但漏掉领取事件，已改用本地真实份额结算',
      context: {
        chatId,
        aiRoundId,
        addedClaims: redpacketClaimRepair.added,
        sanitizedMessages: redpacketClaimRepair.sanitized,
      },
    });
  }
  const generatedImageClaimRepair = repairUnfulfilledGeneratedImageClaim(validEvents, {
    allowImageGen,
    recentMessages: messages,
  });
  if (generatedImageClaimRepair.repaired) {
    validEvents = generatedImageClaimRepair.events;
    appendDebugEvent({
      type: 'chat_gen_image_claim_repaired',
      level: 'info',
      message: '角色已答应发图但漏掉图片事件，已补成真实生图任务',
      context: {
        chatId,
        aiRoundId,
        actorId: String(generatedImageClaimRepair.event?.from || ''),
        people: String(generatedImageClaimRepair.event?.people || ''),
      },
    });
  }
  validEvents = interleaveMonolithicGroupMessageBlocks(validEvents, chat);
  const narrationDedup = suppressRepeatedNarrationEvents(validEvents, messages);
  validEvents = narrationDedup.events;
  if (narrationDedup.suppressed > 0) {
    appendDebugEvent({
      type: 'chat_narration_repeat_suppressed',
      level: 'info',
      message: '已移除与最近剧情几乎相同的重复旁白',
      context: { chatId, aiRoundId, count: narrationDedup.suppressed },
    });
  }
  const trackPreferredBubbleRange = !!preferredBubbleRange
    && options.guidanceMode !== true
    && options.presetMode !== 'guidance'
    && options.presetMode !== 'offline'
    && aiRoundKind !== 'guidance'
    && options.suppressVisibleMessages !== true;
  if (trackPreferredBubbleRange) {
    const actualMsgCount = validEvents.filter((event) => event?.t === 'msg').length;
    if (actualMsgCount < preferredBubbleRange.min || actualMsgCount > preferredBubbleRange.max) {
      const direction = actualMsgCount < preferredBubbleRange.min ? 'underflow' : 'overflow';
      appendDebugEvent({
        type: 'chat_bubble_range_missed',
        level: 'warn',
        message: `模型本轮生成 ${actualMsgCount} 条可见消息，未落在用户偏好的 ${preferredBubbleRange.min}～${preferredBubbleRange.max} 条范围内，仍保留本轮结果`,
        context: {
          chatId,
          aiRoundId,
          direction,
          actualMsgCount,
          min: preferredBubbleRange.min,
          max: preferredBubbleRange.max,
        },
      });
    }
  }
  const outputPrefs = await loadChatOutputPrefs().catch(() => ({ stripTrailingPeriod: false }));
  const materializeStartedAt = Date.now();
  const materialized = await materializeMarshmallowChatEvents(validEvents, {
    chat,
    chatId,
    userId,
    messages,
    characters,
    addressBookCharacters,
    preferPeerIds,
    actorResolutionExtraIds: validateOpts.actorResolutionExtraIds,
    extraActorIds: validateOpts.extraActorIds,
    resolveSenderName,
    currentUserName,
    nextTimestamp: (event) => nextTs(event),
    baseMetadata: {
      aiRoundId,
      aiGenerated: true,
      ...(aiRoundCreatedAt > 0 ? { aiRoundCreatedAt } : {}),
      ...(rerollRootId ? { rerollRootId } : {}),
      ...(aiRoundKind ? { aiRoundKind } : {}),
      ...(options.proactiveChannel ? {
        proactiveChannel: String(options.proactiveChannel),
        proactiveMotive: String(options.proactiveMotive || ''),
        proactiveReservationId: String(options.proactiveReservationId || ''),
      } : {}),
      ...(options.offlineReturnBridge === true ? {
        offlineReturnBridge: true,
        offlineReturnArchiveId: String(options.offlineReturnArchiveId || ''),
      } : {}),
      ...(gapStart > 0 && gapEnd > gapStart
        ? { aiRoundGapStart: gapStart, aiRoundGapEnd: gapEnd }
        : {}),
    },
    allowImageGen,
    stripTrailingPeriod: outputPrefs.stripTrailingPeriod === true,
    voicePerformanceModeEnabled: chatPrefs.voicePerformanceMode === true,
  });
  const checkoutOrder = options.mcpCheckout?.shoppingOrder;
  if (checkoutOrder?.id && options.suppressVisibleMessages !== true) {
    // The model may emit its legacy fictional shopping-gift card after seeing
    // an actual MCP order result. Replace it with the durable order created
    // from the trusted tool response so the UI never depends on a copied URL.
    materialized.messages = (materialized.messages || []).filter((message) => message.type !== 'orderShare');
    const senderId = String(options.onlySenderId || options.currentActorId || getPartnerActor(chat) || '').trim();
    const senderName = await resolveSenderName(senderId);
    const orderMessage = createMessage({
      chatId,
      senderId,
      senderName,
      type: 'orderShare',
      content: checkoutOrder.title,
      metadata: {
        aiRoundId,
        aiGenerated: true,
        mcpCheckout: true,
        shoppingOrderId: checkoutOrder.id,
        shoppingProviderId: checkoutOrder.providerId,
        shoppingRoute: checkoutOrder.providerId === 'mcd-cn' ? 'shopping/mcd' : 'shopping/luckin',
        orderPlatform: checkoutOrder.providerLabel,
        orderTitle: checkoutOrder.title,
        orderPrice: checkoutOrder.amount,
        orderNote: checkoutOrder.note,
        orderImageUrl: checkoutOrder.imageUrl,
        orderItemCount: checkoutOrder.items?.reduce((sum, item) => sum + (Number(item.quantity) || 1), 0) || 0,
        orderStoreName: checkoutOrder.storeName,
        shoppingCheckoutAvailable: checkoutOrder.checkoutAvailable === true,
        orderStatus: checkoutOrder.status,
        externalOrderId: checkoutOrder.externalOrderId,
      },
    });
    orderMessage.timestamp = nextTs({ t: 'order_share' });
    materialized.messages.push(orderMessage);
  }
  persistTiming.materializeMs = Math.max(0, Date.now() - materializeStartedAt);
  markPersistTiming('eventsMaterializedMs');
  // 完全下线期间的“扫一眼”轮只允许后台生活动作：即使模型误输出气泡，
  // 也在任何落库/通知/跨窗处理之前由代码强制丢弃。side effect 同样按调用方白名单收口，
  // 防止 private_msg / nudge 等动作绕回用户。
  if (options.suppressVisibleMessages === true) {
    materialized.messages = [];
  }
  if (Array.isArray(options.allowedSideEffectTypes)) {
    const allowedSideEffects = new Set(options.allowedSideEffectTypes.map((item) => String(item || '').trim()));
    materialized.sideEffects = (materialized.sideEffects || [])
      .filter((event) => allowedSideEffects.has(String(event?.t || '').trim()));
  }
  const explicitUserForwardAuthorization = hasExplicitUserCrossWindowForwardRequest(messages);
  const forwardPolicyBeforeCount = (materialized.sideEffects || []).length;
  materialized.sideEffects = (materialized.sideEffects || []).filter((event) => (
    !shouldBlockUserMaterialCrossWindowForward(event, {
      sourceMessages: messages,
      userName: currentUserName,
      explicitUserAuthorization: explicitUserForwardAuthorization,
    })
  ));
  const blockedUserForwardCount = forwardPolicyBeforeCount - materialized.sideEffects.length;
  if (blockedUserForwardCount > 0) {
    materialized.warnings = [
      ...(materialized.warnings || []),
      { code: 'user_material_cross_window_forward_blocked', droppedCount: blockedUserForwardCount },
    ];
    appendDebugEvent({
      type: 'user_material_cross_window_forward_blocked',
      level: 'info',
      message: '未获用户本轮明确授权，已阻止把用户记录转入角色私聊或幕后群',
      context: { chatId, aiRoundId, droppedCount: blockedUserForwardCount },
    });
  }
  const userPrivateLinkageEnabled = chat?.type === 'group' && resolveAllowPrivateSend(chat, chatPrefs);
  const linkageEnabled = chat?.groupSettings?.allowSocialLinkage === true
    || userPrivateLinkageEnabled;
  const linkageIntervalState = resolveLinkageIntervalState(chat);
  const linkageIntervalBlocked = linkageEnabled && !linkageIntervalState.allowed;
  if (linkageIntervalBlocked) {
    const beforeCount = (materialized.sideEffects || []).length;
    materialized.sideEffects = filterCrossWindowLinkageEvents(materialized.sideEffects);
    const droppedCount = beforeCount - materialized.sideEffects.length;
    if (droppedCount > 0) {
      materialized.warnings = [
        ...(materialized.warnings || []),
        {
          code: 'linkage_interval_blocked',
          droppedCount,
          remainingTurns: linkageIntervalState.remainingTurns,
        },
      ];
    }
  }
  const translationRepair = await repairChatRoundTranslations({
    messages: materialized.messages || [],
    sideEffects: materialized.sideEffects || [],
    characters,
    signal: options.signal,
    automatic: true,
    auditContext: {
      operation: 'chat-round-translation-repair',
      trigger: String(options.reason || 'chat-round'),
      chatId,
      logicalRoundId: aiRoundId,
    },
  }).catch(() => null);
  if (translationRepair) {
    materialized.messages = translationRepair.messages;
    materialized.sideEffects = translationRepair.sideEffects;
  }
  markPersistTiming('translationsReadyMs');
  materialized.messages = await persistFrontstageLightweightNpcs(chat, materialized.messages, {
    userId,
    phoneViewerId,
    phoneUserId: userId,
    phoneOwnerId: phoneViewerId,
  });
  // 名字直接解析到手机联系人（未走 ephemeral）时，也要把发言人补进群成员，避免只出气泡不进列表。
  if (chat?.type === 'group' && phoneContactIds.length) {
    const phoneSet = new Set(phoneContactIds);
    const speakerIds = (materialized.messages || [])
      .map((row) => String(row?.senderId || '').trim())
      .filter((id) => phoneSet.has(id));
    if (speakerIds.some((id) => !(chat.participants || []).includes(id))) {
      chat.participants = [...new Set([...(chat.participants || []), ...speakerIds])];
      await saveChat(chat);
    }
  }

  const guardedProactiveChannel = String(options.proactiveChannel || '').trim();
  if (guardedProactiveChannel && !['idle-continue', 'delayed-reply'].includes(guardedProactiveChannel)) {
    const proactiveActorId = String(
      options.onlySenderId
      || options.currentActorId
      || getPartnerActor(chat)
      || '',
    ).trim();
    const duplicate = findProactiveNearDuplicate(
      materialized.messages || [],
      messages,
      proactiveActorId,
    );
    if (duplicate) {
      return {
        ok: false,
        skipped: true,
        reason: 'proactive-near-duplicate',
        duplicateSuppressed: true,
        duplicatePreview: String(duplicate.generatedText || '').slice(0, 160),
        historicalPreview: String(duplicate.historicalText || '').slice(0, 160),
        duplicateScore: Number(duplicate.score || 0),
        duplicateContainment: Number(duplicate.containment || 0),
        messages: [],
        messageCount: 0,
      };
    }
  }

  if (aiRoundId && options.skipExistingAiRoundCleanup !== true) {
    await deleteMessagesWithAiRoundId(chatId, aiRoundId);
    if (!options.skipEventRewind) {
      rewindActiveEventAfterReroll(chatId).catch(() => {});
    }
  }

  // 群管必须先真实执行，再允许“已经改好/已经邀请”的台词落库。
  // 远程群命令使用本轮白名单；自然语言声明只作为兼容兜底。
  const groupActionDeliveryGate = await checkDeliveryGuard('before-group-actions');
  if (!groupActionDeliveryGate.ok) {
    return {
      ok: false,
      skipped: true,
      reason: String(groupActionDeliveryGate.reason || 'delivery-blocked'),
      messages: [],
      messageCount: 0,
    };
  }
  const remoteGroupEvents = materialized.sideEffects.filter((event) => event?.t === 'group_remote');
  const explicitGroupManagementRequested = [...messages].reverse().slice(0, 10)
    .some(isExplicitGroupManagementRequest);
  const claimedGroupActionTypesBeforeReconcile = [...new Set(materialized.messages
    .flatMap((message) => claimedGroupActionTypes(message?.content || message?.body || '')))];
  const remoteGroupResult = remoteGroupEvents.length
    ? await applyMarshmallowRemoteGroupEvents(remoteGroupEvents, {
      userId,
      aiRoundId,
      resolveName: resolveSenderName,
      allowedGroupIds: remoteGroupIds,
      allowedAddMemberIds: addressBookCharacters.map((row) => row?.id).filter(Boolean),
    }).catch(() => ({ handled: 0, skipped: remoteGroupEvents.length, actions: [], receipts: [] }))
    : { handled: 0, skipped: 0, actions: [], receipts: [] };
  const completedCrossWindowActions = (remoteGroupResult.actions || []).map((action) => (
    action.type === 'group_name'
      ? `rename:${action.actorId}`
      : (action.type === 'invite_user' ? `invite:${action.actorId}` : '')
  )).filter(Boolean);
  const crossWindowGroupResult = await applyClaimedCrossWindowGroupActions(materialized.messages, {
    sourceChat: chat,
    sourceMessages: messages,
    userId,
    aiRoundId,
    resolveName: resolveSenderName,
    completedActions: completedCrossWindowActions,
  }).catch(() => ({ handled: 0, skipped: 0, actions: [], failedClaims: [], receipts: [] }));

  const groupAdminEvents = materialized.sideEffects.filter((event) => (
    event?.t === 'group_title'
    || event?.t === 'group_name'
    || event?.t === 'group_announcement'
    || event?.t === 'group_todo'
    || event?.t === 'group_transfer'
    || event?.t === 'group_admin'
    || event?.t === 'group_member'
    || event?.t === 'mute'
    || event?.t === 'vote_close'
  ));
  const groupAdminResult = groupAdminEvents.length
    ? await applyMarshmallowGroupAdminEvents(groupAdminEvents, {
      sourceChatId: chatId,
      sourceChat: chat,
      userId,
      aiRoundId,
      resolveName: resolveSenderName,
      allowedAddMemberIds: addressBookCharacters.map((row) => row?.id).filter(Boolean),
      explicitUserRequest: explicitGroupManagementRequested,
    })
    : { handled: 0, skipped: 0, receipts: [], appliedTypes: [] };

  const groupInviteUserEvents = materialized.sideEffects.filter((event) => event?.t === 'invite_user');
  const groupInviteUserResult = groupInviteUserEvents.length
    ? await applyMarshmallowGroupInviteUserEvents(groupInviteUserEvents, {
      sourceChatId: chatId,
      sourceChat: chat,
      userId,
      aiRoundId,
      resolveName: resolveSenderName,
    })
    : { handled: 0, skipped: 0, effective: false, receipts: [] };

  const renameAttempted = groupAdminEvents.some((event) => event.t === 'group_name')
    || remoteGroupEvents.some((event) => event.operation === 'group_name');
  const inviteAttempted = groupInviteUserEvents.length > 0
    || remoteGroupEvents.some((event) => event.operation === 'invite_user');
  const renameSucceeded = (groupAdminResult.appliedTypes || []).includes('group_name')
    || (remoteGroupResult.actions || []).some((action) => action.type === 'group_name')
    || (crossWindowGroupResult.actions || []).some((action) => action.type === 'group_name');
  const inviteSucceeded = groupInviteUserResult.effective === true
    || (remoteGroupResult.actions || []).some((action) => action.type === 'invite_user')
    || (crossWindowGroupResult.actions || []).some((action) => action.type === 'invite_user');
  const attemptedGroupActionTypes = [
    ...groupAdminEvents.map((event) => event.t),
    ...groupInviteUserEvents.map(() => 'invite_user'),
    ...remoteGroupEvents.map((event) => event.operation),
  ].filter(Boolean);
  const succeededGroupActionTypes = [
    ...(groupAdminResult.appliedTypes || []),
    ...(groupInviteUserResult.effective ? ['invite_user'] : []),
    ...(remoteGroupResult.actions || []).map((action) => action.type),
    ...(crossWindowGroupResult.actions || []).map((action) => action.type),
  ].filter(Boolean);
  const groupActionFailureReceipts = [
    ...(groupAdminResult.receipts || []),
    ...(groupInviteUserResult.receipts || []),
    ...(remoteGroupResult.receipts || []),
    ...(crossWindowGroupResult.receipts || []),
  ];
  materialized.messages = reconcileGroupActionClaimMessages(materialized.messages, {
    renameAttempted,
    inviteAttempted,
    renameSucceeded,
    inviteSucceeded,
    failedClaims: crossWindowGroupResult.failedClaims,
    attemptedTypes: attemptedGroupActionTypes,
    succeededTypes: succeededGroupActionTypes,
  });
  const failedGroupActionCount = Number(groupAdminResult.skipped || 0)
    + Number(remoteGroupResult.skipped || 0)
    + Number(crossWindowGroupResult.skipped || 0)
    + (groupInviteUserResult.effective === true ? 0 : Number(groupInviteUserResult.skipped || 0));
  const surfaceGroupActionFailure = shouldSurfaceGroupActionFailure({
    explicitRequest: explicitGroupManagementRequested,
    claimedTypes: claimedGroupActionTypesBeforeReconcile,
    failedClaims: crossWindowGroupResult.failedClaims,
    attemptedTypes: attemptedGroupActionTypes,
  });
  if (failedGroupActionCount > 0 && surfaceGroupActionFailure) {
    const failureFeedback = describeGroupActionFailure({
      receipts: groupActionFailureReceipts,
      failedClaims: crossWindowGroupResult.failedClaims,
      attemptedTypes: attemptedGroupActionTypes,
      failedCount: failedGroupActionCount,
    });
    materialized.messages.push(createMessage({
      chatId,
      senderId: 'system',
      senderName: '群聊动作',
      type: 'chatAction',
      content: failureFeedback.message,
      timestamp: Number(requestedBaseTs || Date.now()) + materialized.messages.length + 1,
      metadata: {
        aiRoundId,
        marshmallowEventType: 'group_action_failed',
        failedCount: failedGroupActionCount,
        failureReason: failureFeedback.reason,
        failureCategory: failureFeedback.category,
        failureCodes: failureFeedback.codes,
      },
    }));
  }

  // 「发给 user 被拒收/红色感叹号」这套语义只在 user 真的是这个会话的参与者时才成立——
  // 无 user 的秘密基地/幕后群本来就没有「发给 user」这件事，不该被打上这个标记。
  // 例外：角色手机拦截箱会话本身就要全红叹号，表示已被拦截/拒收。
  const isPhoneInterceptChat = String(chat?.metadata?.phoneChannel || '') === 'intercept';
  const characterAliasBlockedByUser = isCharacterAliasBlockedByUser(chat);
  const userInThisChat = isUserPresentInChat(chat);
  const deliveryBlockedState = userInThisChat ? getChatBlockedState(chat, chatPrefs) : { blocked: false };
  const blockedActorIds = new Set();
  const blockStateStartedAt = Date.now();
  if (userInThisChat) {
    const actorIds = (chat?.participants || []).filter((p) => p && p !== 'user');
    const actorStates = await Promise.all(actorIds.map(async (id) => ({
      id,
      state: await loadCharacterBlockState(id, userId).catch(() => null),
    })));
    for (const { id, state } of actorStates) {
      // 全局 characterId 拉黑记录代表本体账号。马甲线程虽然复用同一个 senderId，
      // 但前台是独立账号，不能跟着本体一起显示拒收红叹号。
      if (state?.blocked && !isCharacterAliasActiveInChat(chat, id)) {
        blockedActorIds.add(String(id));
      }
    }
  }
  persistTiming.blockStateMs = Math.max(0, Date.now() - blockStateStartedAt);
  const markRejected = isPhoneInterceptChat
    || characterAliasBlockedByUser
    || deliveryBlockedState.blocked === true
    || blockedActorIds.size > 0;
  // linkageFired 必须等跨窗动作真正落库后再标。仅凭模型输出过协议块就提前销账，
  // 会让目标不存在、成员不合法等失败尝试也重置保底，最终看起来像联动长期熄火。
  const linkageMarkerMessageIndex = materialized.messages.length - 1;
  const aliasThread = isStrangerInterceptChat(chat);
  let toSave = materialized.messages.map((m, idx) => ({
    ...m,
    content: typeof m.content === 'string'
      ? applyPermanentRegex(m.content, {
        surface: options.regexSurface || 'chat',
        placement: m.senderId === 'user' ? 1 : 2,
        depth: 0,
        macros: { user: currentUserName, char: m.senderName || '角色' },
      })
      : m.content,
    metadata: {
      ...(m.metadata || {}),
      aiRoundId,
      aiGenerated: true,
      ...(options.offlineReturnBridge === true
        && m.senderId
        && m.senderId !== 'user'
        && m.senderId !== 'system'
        && m.senderId !== 'guidance'
        ? {
          offlineReturnBridge: true,
          offlineReturnArchiveId: String(options.offlineReturnArchiveId || ''),
        }
        : {}),
      ...(options.tagBusyFauxAutoReply === true
        && m.senderId
        && m.senderId !== 'user'
        && m.senderId !== 'system'
        && m.senderId !== 'guidance'
        ? {
          busyFauxAutoReply: true,
          generatedBy: 'character-busy-faux-auto-reply',
        }
        : {}),
      ...(aliasThread && m.senderId !== 'system'
        ? {
          accountId: chat.metadata?.accountIdentityMap?.[
            m.senderId === 'user'
              ? principalKey('user', userId)
              : principalKey('character', m.senderId)
          ] || '',
        }
        : {}),
      ...(parsed.legacyTaggedFallback === true ? {
        modelFormatRecovered: true,
        modelFormatKind: 'legacy-tagged-lines',
        modelFormatRecoveryNotice: idx === 0,
      } : {}),
      ...((isPhoneInterceptChat
        ? (m.senderId !== 'system')
        : (markRejected
          && m.senderId !== 'user'
          && m.senderId !== 'system'
          && (
            characterAliasBlockedByUser
            || deliveryBlockedState.blocked === true
            || blockedActorIds.has(String(m.senderId || ''))
          )))
        ? {
          deliveryBlockedByUser: true,
          deliveryStatus: 'rejected',
          deliveryRejectedConfirmed: true,
          deliveryRejectedUserId: userId,
          deliveryRejectedAt: Date.now(),
          deliveryRejectedReason: characterAliasBlockedByUser
            ? 'blocked-character-alias-by-user'
            : 'blocked-by-user',
        }
        : {}),
    },
  }));
  if (toSave.length) {
    // 生成期间用户可能刚好又发了一条；落库前重读一次真正的末条消息，
    // 整批平移而不改变批内间隔，避免竞态让主动回复插到用户消息前。
    const latestStored = await listMessagesForChat(chatId, 1).catch(() => messages);
    toSave = rebaseLiveMessageBatch(latestStored, toSave, options.gapFillWindow);
  }
  const anonymousPeerReply = (options.anonymousChat === true || isAnonymousChat(chat))
    && toSave.some((m) => {
      const senderId = String(m?.senderId || '').trim();
      return senderId && senderId !== 'user' && senderId !== 'system' && senderId !== 'guidance';
    });
  let anonymousReadUpdates = [];
  if (anonymousPeerReply) {
    const storedMessages = await listMessagesForChat(chatId, 0).catch(() => []);
    const readAt = Date.now();
    anonymousReadUpdates = storedMessages
      .filter((m) => m && !m.deleted && String(m.senderId || '') === 'user')
      .filter((m) => {
        const status = m.metadata?.readStatus;
        return status !== true && status !== 'true' && status !== 'read' && status !== 'seen';
      })
      .map((m) => ({
        ...m,
        metadata: {
          ...(m.metadata || {}),
          readStatus: 'read',
          readAt,
        },
      }));
  }
  if (toSave.length) {
    const deliveryGate = await checkDeliveryGuard('before-message-persist');
    if (!deliveryGate.ok) {
      return {
        ok: false,
        skipped: true,
        reason: String(deliveryGate.reason || 'delivery-blocked'),
        messages: [],
        messageCount: 0,
      };
    }
    const visibleCharacterMessages = toSave.filter((message) => {
      const senderId = String(message?.senderId || '').trim();
      return senderId && senderId !== 'user' && senderId !== 'system' && senderId !== 'guidance';
    });
    const messagePutStartedAt = Date.now();
    try {
      await saveMessages([...anonymousReadUpdates, ...toSave]);
    } catch (error) {
      throw error;
    }
    // 重 roll 与断档补写保留原历史位置；普通实时回复则在成功落库后推进剧情钟。
    // 暂停态仍保持 paused，只增加消息刻度，避免连续气泡长期显示同一分钟。
    if (!options.gapFillWindow && !(Array.isArray(options.excludeAiRoundIds) && options.excludeAiRoundIds.length)) {
      await advanceVirtualTimeForMessages(
        userId,
        toSave.map((message) => message?.timestamp),
      ).catch(() => null);
    }
    persistTiming.messagePutMs = Math.max(0, Date.now() - messagePutStartedAt);
    // 可见气泡的耐久写已经完成，立即把它交给前台绘制。心理连续性回执和其它
    // 副作用仍会在本函数返回前完成，但不能再把它们的锁等待记成“消息尚未保存”。
    markPersistTiming('visibleMessagesSavedMs');
    persistTiming.translationsToDurableMs = Math.max(
      0,
      Number(persistTiming.visibleMessagesSavedMs || 0) - Number(persistTiming.translationsReadyMs || 0),
    );
    if (typeof options.onVisibleMessagesPersisted === 'function') {
      try {
        options.onVisibleMessagesPersisted({
          chatId,
          aiRoundId,
          messageIds: visibleCharacterMessages.map((message) => message.id).filter(Boolean),
          at: Date.now(),
        });
      } catch (_) { /* timing callbacks must never break a completed message write */ }
    }
    if (typeof window !== 'undefined') {
      window.dispatchEvent?.(new CustomEvent('chat-visible-ai-reply-persisted', {
        detail: {
          chatId,
          aiRoundId,
          messageIds: visibleCharacterMessages.map((message) => message.id).filter(Boolean),
          messages: toSave,
          at: Date.now(),
        },
      }));
    }
    if (visibleCharacterMessages.length && userId && chatId) {
      const psychologyDeliveryStartedAt = Date.now();
      try {
        const psychologyDelivery = await applyVisibleReplyCompositionDelivery({
          userId,
          chatId,
          participantIds: Array.isArray(chat?.participants) ? chat.participants : undefined,
        }, visibleCharacterMessages, {
          aiRoundId,
          now: Date.now(),
        });
        replyCompositionDiagnostics.psychologyDelivery = psychologyDelivery.reason;
        replyCompositionDiagnostics.psychologyActorIds = psychologyDelivery.actorIds;
      } catch (error) {
        replyCompositionDiagnostics.psychologyDelivery = 'failed-after-visible-save';
        void appendDebugEvent({
          type: 'chat_reply_composition_psychology_delivery_failed',
          level: 'warn',
          message: '可见回复已保存，但心理连续性回执写入失败',
          context: {
            chatId,
            aiRoundId,
            error: String(error?.message || error || 'unknown'),
          },
        });
      } finally {
        persistTiming.psychologyDeliveryMs = Math.max(0, Date.now() - psychologyDeliveryStartedAt);
      }
    }
    if (
      !isStrangerInterceptChat(chat)
      && chat?.type === 'private'
      && toSave.some((message) => message?.metadata?.deliveryStatus === 'rejected')
    ) {
      await noteBlockedContactFailureRound(chatId, Date.now()).catch(() => null);
    }
    void enhanceStoredLinkMessages(toSave.filter((m) => m.type === 'link'));
    const last = toSave[toSave.length - 1];
    await updateChatPreview(chatId, previewFromMessage(last), last.timestamp);
    // 角色真的把「TA刷到过的真实帖子」甩出去了：标记已分享，下次注入块不再让 TA 重复甩同一条链接；
    // 同时熄掉当天的「分享冲动」，并给命中的用户动态打「已聊过」标记
    const sharedLinks = toSave.filter((m) => m.type === 'link' && m.senderId && m.senderId !== 'user' && (m.metadata?.url || m.content));
    for (const m of sharedLinks) {
      const url = m.metadata?.url || m.content;
      markVerifiedPostShared(userId, m.senderId, url).catch(() => {});
      markUserSocialPostMentioned(userId, m.senderId, { url }).catch(() => {});
      consumeShareImpulse(userId, m.senderId).catch(() => {});
    }
  }

  const strangerBlockEvent = materialized.sideEffects.find((event) => event?.t === 'stranger_block');
  if (strangerBlockEvent && isStrangerInterceptChat(chat)) {
    const latest = await getChat(chatId).catch(() => null);
    const actorId = String(strangerBlockEvent.from || '').trim();
    const userKey = principalKey('user', userId);
    const accountId = String(latest?.metadata?.accountIdentityMap?.[userKey] || '').trim();
    if (latest && actorId && accountId && latest.metadata?.friendshipState !== 'blocked') {
      const reason = String(strangerBlockEvent.reason || '').trim();
      latest.metadata = transitionFriendship(latest.metadata, 'blocked', {
        by: principalKey('character', actorId),
        at: Date.now(),
        reason,
      });
      await saveChat(latest);
      chat.metadata = latest.metadata;
      const aliasSnapshot = latest.metadata?.accountSnapshots?.[accountId] || {};
      await recordUserAliasContactFact({
        userId,
        chatId,
        accountId,
        aliasName: aliasSnapshot.displayName || currentUserName,
        characterId: actorId,
        blocked: true,
        blockReason: reason,
      }).catch(() => null);
    }
  }

  const strangerUnblockEvent = materialized.sideEffects.find((event) => event?.t === 'stranger_unblock');
  if (strangerUnblockEvent && !strangerBlockEvent && isStrangerInterceptChat(chat)) {
    const latest = await getChat(chatId).catch(() => null);
    const actorId = String(strangerUnblockEvent.from || '').trim();
    const reason = String(strangerUnblockEvent.reason || '').trim();
    if (latest && actorId && latest.metadata?.friendshipState === 'blocked') {
      latest.metadata = transitionFriendship(latest.metadata, 'intercepted', {
        by: principalKey('character', actorId),
        at: Date.now(),
        reason,
      });
      latest.metadata = {
        ...latest.metadata,
        friendshipUnblockedBy: principalKey('character', actorId),
        friendshipUnblockedAt: Date.now(),
        friendshipUnblockReason: reason,
      };
      await saveChat(latest);
      chat.metadata = latest.metadata;
    }
  }

  const strangerFriendEvent = materialized.sideEffects.find((event) => event?.t === 'stranger_friend');
  if (strangerFriendEvent && !strangerBlockEvent && isStrangerInterceptChat(chat)) {
    const latest = await getChat(chatId).catch(() => null);
    const actorId = String(strangerFriendEvent.from || '').trim();
    const action = String(strangerFriendEvent.action || '').trim();
    const reason = String(strangerFriendEvent.reason || '').trim();
    const state = String(latest?.metadata?.friendshipState || 'stranger').trim() || 'stranger';
    let nextState = '';
    if (action === 'accept' && ['requested', 'intercepted', 'stranger'].includes(state)) nextState = 'accepted';
    else if (action === 'decline' && state === 'requested') nextState = 'intercepted';
    else if (action === 'request' && ['stranger', 'intercepted'].includes(state)) nextState = 'requested';
    if (latest && actorId && nextState) {
      latest.metadata = {
        ...transitionFriendship(latest.metadata, nextState),
        friendshipDecisionBy: principalKey('character', actorId),
        friendshipDecisionAt: Date.now(),
        friendshipDecision: action,
        friendshipDecisionReason: reason,
      };
      await saveChat(latest);
      chat.metadata = latest.metadata;
      const application = latest.metadata?.contactApplication;
      if (application?.id && ['accept', 'decline'].includes(action)) {
        let promotedCharacterId = actorId;
        let promotionError = '';
        if (action === 'accept' && isLightweightNpcId(actorId)) {
          try {
            const promoted = await promoteLightweightNpcToCharacter(actorId, { userId });
            promotedCharacterId = String(promoted?.character?.id || actorId).trim() || actorId;
            const phoneOwnerId = String(application.phoneOwnerId || '').trim();
            const phoneContactId = String(application.phoneContactId || '').trim();
            if (phoneOwnerId && phoneContactId) {
              const { getPhoneContact, upsertPhoneContact } = await import('../character-phone-contacts.js');
              const contact = await getPhoneContact(userId, phoneOwnerId, phoneContactId).catch(() => null);
              if (contact) {
                await upsertPhoneContact(userId, phoneOwnerId, {
                  ...contact,
                  id: contact.id,
                  linkedCharacterId: promotedCharacterId,
                });
              }
            }
          } catch (error) {
            promotionError = String(error?.message || error || '转正失败').slice(0, 240);
            console.warn('[qq-contact-application] lightweight NPC promotion failed', error);
          }
        }
        await markQqContactApplicationDecision(userId, application.id, {
          status: action === 'accept' ? 'accepted' : 'declined',
          reason,
          characterId: promotedCharacterId,
          chatId,
        }).catch(() => null);
        latest.metadata = {
          ...(latest.metadata || {}),
          contactApplication: {
            ...application,
            status: action === 'accept' ? 'accepted' : 'declined',
            decidedAt: Date.now(),
            decisionReason: reason,
            promotedCharacterId: action === 'accept' ? promotedCharacterId : '',
            promotionError,
          },
        };
        await saveChat(latest);
        chat.metadata = latest.metadata;
      }
    }
  }

  // 大号私聊口头承诺加好友/解黑 → 同步到对应用户马甲陌生线程
  if (!isStrangerInterceptChat(chat) && chat?.type === 'private' && Array.isArray(toSave) && toSave.length) {
    const characterIds = [...new Set(
      toSave
        .map((m) => String(m?.senderId || '').trim())
        .filter((id) => id && id !== 'user' && id !== 'system'),
    )];
    const promiseText = toSave
      .filter((m) => m && String(m.senderId || '') !== 'user' && (!m.type || m.type === 'text'))
      .map((m) => String(m.content || ''))
      .join('\n');
    for (const characterId of characterIds) {
      await applyMainChatFriendshipPromisesToAliases({
        userId,
        characterId,
        text: promiseText,
        reason: '大号会话承诺同步',
      }).catch(() => null);
    }
  }

  const strangerSuspectEvents = materialized.sideEffects.filter((event) => event?.t === 'stranger_suspect');
  if (strangerSuspectEvents.length && isStrangerInterceptChat(chat)) {
    const latest = await getChat(chatId).catch(() => null);
    const userKey = principalKey('user', userId);
    const accountId = String(latest?.metadata?.accountIdentityMap?.[userKey] || '').trim();
    const snapshot = accountId ? latest?.metadata?.accountSnapshots?.[accountId] || {} : {};
    if (latest && accountId) {
      for (const event of strangerSuspectEvents) {
        const actorId = String(event.from || '').trim();
        if (!actorId || actorId === 'user') continue;
        const reason = String(event.reason || '').trim();
        await upsertAliasAwareness({
          userId,
          accountId,
          awareCharacterId: actorId,
          awarenessLevel: 'suspects',
          confidence: 0.55,
          provenance: {
            source: 'observed',
            sourceChatId: chatId,
            note: reason || '当前线程出现可疑的表达或行为线索',
          },
          accountLabel: snapshot.displayName || '',
        }).catch(() => null);
        const current = normalizeRevealEntry(latest.metadata?.identityReveal?.[userKey]).state;
        if (current === 'hidden') {
          latest.metadata = {
            ...latest.metadata,
            identityReveal: {
              ...(latest.metadata?.identityReveal || {}),
              [userKey]: {
                state: 'suspected',
                evidence: reason,
                updatedAt: Date.now(),
                updatedBy: principalKey('character', actorId),
              },
            },
          };
        }
      }
      await saveChat(latest);
      chat.metadata = latest.metadata;
    }
  }

  const redpacketClaimEvents = materialized.sideEffects.filter((e) => e?.t === 'redpacket_claim');
  if (redpacketClaimEvents.length) {
    try {
      await applyRedPacketClaimEvents(redpacketClaimEvents, {
        chatId,
        messages: [...(Array.isArray(messages) ? messages : []), ...toSave],
        userId,
        resolveName: resolveSenderName,
        aiRoundId,
      });
    } catch (err) {
      console.warn('[ai-round] redpacket_claim apply failed', err);
    }
  }

  const transferActionEvents = materialized.sideEffects.filter((e) => e?.t === 'transfer_accept' || e?.t === 'transfer_return');
  if (transferActionEvents.length) {
    try {
      await applyTransferEvents(transferActionEvents, {
        chatId,
        messages: [...(Array.isArray(messages) ? messages : []), ...toSave],
        userId,
        resolveName: resolveSenderName,
        aiRoundId,
      });
    } catch (err) {
      console.warn('[ai-round] transfer_accept/return apply failed', err);
    }
  }

  const groupCreationEnabled = chat?.groupSettings?.allowAiGroupCreation !== false;
  const groupCreationCooldown = resolveAiGroupCreationCooldownState(chat);
  const groupCreationBudget = {
    remaining: groupCreationEnabled && groupCreationCooldown.allowed ? 1 : 0,
    cooldownBlocked: groupCreationEnabled && !groupCreationCooldown.allowed,
  };
  const backstageSaved = await persistBackstageSideEffects(materialized.sideEffects, {
    chat,
    userId,
    parentChatId: chatId,
    resolveSenderName,
    aiRoundId,
    aiRoundCreatedAt,
    characters,
    addressBookCharacters,
    preferPeerIds,
    actorResolutionExtraIds: validateOpts.actorResolutionExtraIds,
    extraActorIds: validateOpts.extraActorIds,
    userName: currentUserName,
    allowGroupCreation: groupCreationEnabled,
    regexSurface: options.regexSurface || 'chat',
    phoneViewerId,
    phoneUserId: userId,
    phoneOwnerId: phoneViewerId,
    groupCreationBudget,
  });

  await Promise.all([
    applyMarshmallowProfileEvents(materialized.sideEffects, {
      chat,
      userId,
      aiRoundId,
      messages: [...(Array.isArray(messages) ? messages : []), ...toSave],
      imageCandidates: options.avatarImageCandidates,
    }).catch(() => {}),
    applyMarshmallowMemoryFactEvents(materialized.sideEffects, {
      chat,
      chatId,
      userId,
      currentUserName,
      characters,
      aiRoundId,
    }).catch(() => {}),
  ]);

  // 每个角色马甲窗只从本线程近期消息做确定性摘录，不追加第二次 AI 请求。
  if (aliasThread && userId && toSave.length) {
    const recentAliasMessages = await listMessagesForChat(chatId, 12).catch(() => []);
    const digestTasks = (chat.participants || [])
      .map((characterId) => {
        if (!characterId || characterId === 'user') return null;
        const accountId = String(chat.metadata?.accountIdentityMap?.[principalKey('character', characterId)] || '').trim();
        if (!accountId) return null;
        const snapshot = chat.metadata?.accountSnapshots?.[accountId] || {};
        const digest = buildDeterministicAliasDigest(recentAliasMessages, {
          accountId,
          chatId,
          frontstageLabel: snapshot.displayName || '马甲',
        });
        if (!digest) return null;
        return getRecord('aliasAccounts', accountId).catch(() => null).then((account) => {
          if (!account || String(account.userId || '') !== userId || String(account.ownerId || '') !== String(characterId)) {
            return null;
          }
          return recordAliasWindowDigest({
            userId,
            ownerId: characterId,
            accountId,
            chatId,
            displayName: account.displayName || snapshot.displayName || '',
            windowLabel: account.windowLabel || '',
            digest,
          });
        });
      })
      .filter(Boolean);
    await Promise.all(digestTasks).catch(() => {});
  }

  const prefsRow = chatId ? await get(`chatPrefs_${chatId}`) : null;
  const prefs = prefsRow?.value || {};
  const innerVoiceDisabled = prefs.innerVoiceDisabled === true;
  const existingStateEvents = materialized.sideEffects.filter((e) => e?.t === 'state');
  // 按角色补齐：群聊常出现「A 有 state、B 只有 msg」；旧逻辑在已有任意 state 时整轮不再合成。
  const rawRoundStateEvents = innerVoiceDisabled ? [] : [
    ...existingStateEvents,
    ...synthesizeStateEventsFromMsgEvents(validEvents, existingStateEvents),
  ];
  const roundStateEvents = rawRoundStateEvents.map((event) => {
    const context = {
      surface: options.regexSurface || 'chat',
      placement: 2,
      depth: 0,
      macros: { user: currentUserName, char: event?.fromName || event?.from || '角色' },
    };
    return {
      ...event,
      inner: applyPermanentRegex(event?.inner, context),
      intent: applyPermanentRegex(event?.intent, context),
      mood: applyPermanentRegex(event?.mood, context),
      status: applyPermanentRegex(event?.status, context),
    };
  });
  if (roundStateEvents.length) {
    const resumePresenceActorIds = [...new Set((Array.isArray(toSave) ? toSave : [])
      .map((message) => String(message?.senderId || '').trim())
      .filter((actorId) => actorId && actorId !== 'user' && actorId !== 'system'))];
    await applyRoundStateEvents(chatId, roundStateEvents, {
      resolveSenderName,
      characters,
      userName: currentUserName,
      aiRoundId,
      aiRoundCreatedAt,
      userId,
      now: requestedBaseTs,
      sceneSource: options.proactiveChannel === 'schedule'
        ? 'schedule_proactive_state'
        : (options.proactiveChannel ? 'background_proactive_state' : 'foreground_chat_state'),
      allowScheduleOverride: chatPrefs.allowAiStatusScheduleOverride !== false,
      // 只有本轮确实落下了该角色的可见消息，state 场景才能证明其已回到前台；
      // 纯心声/场景副作用不具备修改显式在线态的权限。
      resumePresenceActorIds,
      persistCharacterLiveState: !aliasThread,
      statusStoryScenes: Object.fromEntries(roundStateEvents
        .map((event) => [String(event?.from || event?.actor || '').trim(), String(event?.status || '').trim()])
        .filter(([actorId, scene]) => actorId && scene)),
      replaceEmptyInner: chat?.groupSettings?.innerVoiceCard?.generationMode === 'custom',
    }).catch(() => {});
    // state.status 维护真实处境；发生有效转场时，模型应在同轮另发 status，
    // 用独立字段同步在线态与公开心情，避免把活动原文直接抄成顶栏。
  }

  const privateMsgEvents = materialized.sideEffects.filter((e) => e?.t === 'private_msg');
  let privateMsgResult = { handled: 0, chats: [] };
  if (privateMsgEvents.length) {
    const allowPrivate = resolveAllowPrivateSend(chat, prefs);
    privateMsgResult = await applyMarshmallowPrivateMsgEvents(privateMsgEvents, {
      sourceChatId: chatId,
      sourceChat: chat,
      userId,
      userRow: user,
      userName: currentUserName,
      aiRoundId,
      resolveName: resolveSenderName,
      allowPrivateLinkage: allowPrivate,
    });
  }
  for (const receipt of [
    ...(backstageSaved.receipts || []),
    ...(groupAdminResult.receipts || []),
    ...(groupInviteUserResult.receipts || []),
    ...(remoteGroupResult.receipts || []),
    ...(crossWindowGroupResult.receipts || []),
    ...(privateMsgResult.receipts || []),
  ]) roundReceipts.add(receipt);

  if (materialized.reactionOps?.length && chatPrefs.allowAiReact !== false) {
    for (const op of materialized.reactionOps) {
      const resolved = resolveTargetRef(op.target, messages, materialized.messages);
      const targetId = resolved?.id;
      if (targetId && op.emoji) {
        await applyEmojiReactionToMessage(String(targetId), String(op.emoji), { aiRoundId }).catch(() => {});
      }
    }
  }

  if (materialized.recallOps?.length) {
    try {
      await applyMarshmallowRecallEvents(materialized.recallOps, {
        chatId,
        chat,
        messages: [...(Array.isArray(messages) ? messages : []), ...toSave],
        userId,
        resolveName: resolveSenderName,
        currentUserName,
        aiRoundId,
      });
    } catch (err) {
      console.warn('[ai-round] recall apply failed', err);
    }
  }

  const genImageEvents = materialized.sideEffects.filter((e) => e?.t === 'gen_image');
  if (genImageEvents.length) {
    // 图片占位已经随本轮消息批量落库；生图很慢，不能阻塞文字气泡出现在界面上。
    void applyMarshmallowGeneratedImageEvents(genImageEvents, {
      sourceChatId: chatId,
      sourceChat: chat,
      userId,
      aiRoundId,
      signal: options.signal,
      resolveSenderName,
    }).catch((error) => console.warn('[ai-round] background image generation failed', error));
  }

  const statusEvents = materialized.sideEffects.filter((e) => e?.t === 'status');
  const statusCounterpartId = (chat?.participants || []).find((id) => id && id !== 'user') || '';
  // 同轮登记了 next_reply_delay 时，模型自设的状态跟着延时到点过期，而不是走关键词默认 TTL。
  const nextReplyTtlHintMinutes = materialized.sideEffects.reduce((max, e) => (
    e?.t === 'next_reply_delay' || e?.t === 'hard_offline'
      ? Math.max(max, Math.trunc(Number(e?.minutes || 0)) || 0)
      : max
  ), 0);
  const runStatusTask = () => statusEvents.length
    ? applyMarshmallowStatusEvents(statusEvents, {
      sourceChatId: chatId,
      sourceChat: chat,
      userId,
      ttlHintMinutes: nextReplyTtlHintMinutes,
      resolveSenderName,
      aiRoundId,
      aiRoundCreatedAt,
      sceneSource: options.proactiveChannel === 'schedule'
        ? 'schedule_proactive_state'
        : (options.proactiveChannel ? 'background_proactive_state' : 'foreground_chat_state'),
      persistCharacterLiveState: !aliasThread,
      // 系统小字跟顶栏称呼一致：优先会话备注，再退回角色昵称。
      statusDisplayName: String(
        chatPrefs?.remarkName
        || characters?.[statusCounterpartId]?.customNickname
        || characters?.[statusCounterpartId]?.name
        || ''
      ).trim(),
      // 系统小字/小剧场卡排在本轮气泡之后，紧挨着状态变化那一刻。
      timelineTs: resolveStatusTimelineTimestamp(toSave, requestedBaseTs),
    }).catch(() => null)
    : Promise.resolve(null);
  const scheduleChangeEvents = materialized.sideEffects.filter((e) => e?.t === 'schedule_change');
  const scheduleTask = scheduleChangeEvents.length
    ? applyMarshmallowScheduleEvents(scheduleChangeEvents, {
      sourceChatId: chatId,
      sourceChat: chat,
      userId,
      userRow: user,
      characters,
      aiRoundId,
    }).catch((error) => ({
      handled: 0,
      skipped: scheduleChangeEvents.length,
      errors: [{ message: String(error?.message || error || 'schedule_change_failed') }],
      }))
    : Promise.resolve(null);
  // 同轮 schedule_change 与 status 描述的是同一次现实变化：先把正式日程改动落稳，
  // 再写角色最后决定公开的顶栏状态。两者并行会因 IndexedDB 完成顺序不同，随机
  // 出现“新状态 / 日程步骤 / 没刷新”三种结果。
  const statusTask = scheduleTask.then(() => runStatusTask());
  const memoEvents = materialized.sideEffects.filter((e) => e?.t === 'memo');
  const memoTask = memoEvents.length
    ? applyMarshmallowMemoEvents(memoEvents, {
      sourceChatId: chatId,
      sourceChat: chat,
      userId,
      userRow: user,
    }).catch((error) => ({
      handled: 0,
      skipped: memoEvents.length,
      errors: [{ message: String(error?.message || error || 'memo_failed') }],
      }))
    : Promise.resolve(null);
  const radioPlanEvents = materialized.sideEffects.filter((e) => e?.t === 'radio_plan');
  const radioPlanTask = radioPlanEvents.length
    ? applyMarshmallowRadioPlanEvents(radioPlanEvents, {
      sourceChatId: chatId,
      sourceChat: chat,
      userId,
      userRow: user,
      aiRoundId,
    }).catch((error) => ({
      handled: 0,
      skipped: radioPlanEvents.length,
      errors: [{ message: String(error?.message || error || 'radio_plan_failed') }],
    }))
    : Promise.resolve(null);
  const periodEvents = materialized.sideEffects.filter((e) => (
    ['period_offer', 'period_confirm', 'period_decline', 'period_set', 'period_end'].includes(e?.t)
  ));
  const periodTask = periodEvents.length
    ? applyMarshmallowPeriodEvents(periodEvents, {
      sourceChatId: chatId,
      sourceChat: chat,
      userId,
      userRow: user,
    }).catch((error) => ({
      handled: 0,
      skipped: periodEvents.length,
      errors: [{ message: String(error?.message || error || 'period_failed') }],
    }))
    : Promise.resolve(null);
  const autoReplyEvents = materialized.sideEffects.filter((e) => e?.t === 'auto_reply');
  const autoReplyTask = autoReplyEvents.length
    ? applyMarshmallowAutoReplyEvents(autoReplyEvents, {
      sourceChatId: chatId,
      chatId,
      chat,
      sourceChat: chat,
      userId,
      userRow: user,
      characters,
      aiRoundId,
    }).catch((error) => ({
      handled: 0,
      skipped: autoReplyEvents.length,
      errors: [{ message: String(error?.message || error || 'auto_reply_failed') }],
      }))
    : Promise.resolve(null);
  const nextReplyEvents = materialized.sideEffects.filter((e) => e?.t === 'next_reply_delay');
  const nextReplyTask = nextReplyEvents.length
    ? applyMarshmallowNextReplyDelayEvents(nextReplyEvents, {
      chat,
      sourceChat: chat,
      user,
      userId,
      aiRoundId,
      hasStatusEvent: statusEvents.length > 0,
    }).catch((error) => ({
      handled: 0,
      skipped: nextReplyEvents.length,
      errors: [{ message: String(error?.message || error || 'next_reply_delay_failed') }],
    }))
    : Promise.resolve(null);
  const presenceEvents = materialized.sideEffects.filter((e) => e?.t === 'presence');
  const presenceTask = presenceEvents.length
    ? applyMarshmallowPresenceEvents(presenceEvents, {
      chat,
      sourceChat: chat,
      user,
      userId,
      aiRoundId,
    }).catch((error) => ({
      handled: 0,
      skipped: presenceEvents.length,
      errors: [{ message: String(error?.message || error || 'presence_failed') }],
    }))
    : Promise.resolve(null);
  const waitMoodEvents = materialized.sideEffects.filter((e) => e?.t === 'wait_mood');
  const waitMoodTask = waitMoodEvents.length
    ? applyMarshmallowWaitMoodEvents(waitMoodEvents, {
      chat,
      sourceChat: chat,
      user,
      userId,
      aiRoundId,
    }).catch((error) => ({
      handled: 0,
      skipped: waitMoodEvents.length,
      errors: [{ message: String(error?.message || error || 'wait_mood_failed') }],
    }))
    : Promise.resolve(null);
  const [statusResult, scheduleChangeResult, memoResult, radioPlanResult, periodResult, autoReplyResult, nextReplyResult] = await Promise.all([
    statusTask,
    scheduleTask,
    memoTask,
    radioPlanTask,
    periodTask,
    autoReplyTask,
    nextReplyTask,
    presenceTask,
    waitMoodTask,
  ]);
  const hardOfflineEvents = materialized.sideEffects.filter((e) => e?.t === 'hard_offline');
  if (hardOfflineEvents.length) {
    await applyMarshmallowHardOfflineEvents(hardOfflineEvents, {
      chat,
      sourceChat: chat,
      user,
      userId,
      aiRoundId,
      hasStatusEvent: statusEvents.length > 0,
    }).catch((error) => ({
      handled: 0,
      skipped: hardOfflineEvents.length,
      errors: [{ message: String(error?.message || error || 'hard_offline_failed') }],
    }));
  }
  const statusPrefs = statusResult?.latestPrefs || null;
  const statusActivityPatch = buildStatusOpportunityResultPatch({
    prefs: statusPrefs || prefs,
    opportunity: options.statusOpportunity || null,
    statusHandled: statusResult?.changed === true,
    now: Date.now(),
  });
  if (chatId && Object.keys(statusActivityPatch).length) {
    await patchChatPrefs(chatId, statusActivityPatch).catch(() => {});
  }

  // 隐藏思维只用于模型自检，不能成为真实跨窗动作来源。
  // 未闭合思维后的正式协议由 stripThinkingBlocks 自身负责抢救保留。
  const { cleaned, ops } = parseExecutableSendBlocks(String(rawText || options.rawText || ''));
  const sendOpsActorId = String(options.currentActorId || getPartnerActor(chat) || '').trim();
  const sendOpsActorMuted = chat?.type === 'group'
    && (Array.isArray(chat.groupSettings?.muted) ? chat.groupSettings.muted : []).includes(sendOpsActorId);
  let sendOpLogs = [];
  if (ops.length && !linkageIntervalBlocked && !options.onlySenderId && !isAllMutedGroup(chat) && !sendOpsActorMuted) {
    sendOpLogs = await executeSendOps(ops, sendOpsActorId, {
      userId,
      userName: currentUserName,
      currentChatId: chatId,
      sourceChat: chat,
      allowGroupLinkage: chat?.groupSettings?.allowSocialLinkage === true,
      allowGroupCreation: groupCreationEnabled,
      allowPrivateLinkage: resolveAllowPrivateSend(chat, prefs),
      privateLinkageIds: getPrivateLinkageIds(chat, prefs),
      resolveName: resolveSenderName,
      relayMeta: aiRoundId ? {
        aiRoundId: `relay_${aiRoundId}`,
        sourceAiRoundId: aiRoundId,
        aiGenerated: true,
      } : null,
      explicitUserForwardAuthorization,
      groupCreationBudget,
      addressBookCharacters,
    });
    const deliveredGroupReceipts = (sendOpLogs.receipts || []).filter((receipt) => (
      ['group_send_delivered', 'observer_group_send_delivered'].includes(String(receipt?.code || ''))
      && receipt?.targetChatId
    ));
    await Promise.all(deliveredGroupReceipts.map(async (receipt) => {
      const targetChat = await getChat(String(receipt.targetChatId)).catch(() => null);
      if (!targetChat) return;
      await persistCrossWindowStateEvents(targetChat, { states: rawRoundStateEvents }, {
        allowedSpeakerIds: receipt?.context?.speakerIds || [],
        resolveSenderName,
        userName: currentUserName,
        aiRoundId: aiRoundId ? `relay_${aiRoundId}` : '',
        aiRoundCreatedAt,
        userId,
        now: requestedBaseTs,
        proactiveChannel: options.proactiveChannel,
      }).catch(() => {});
    }));
  }
  for (const receipt of sendOpLogs.receipts || []) roundReceipts.add(receipt);
  const groupSendRequested = ops.some((op) => String(op?.type || '').trim() === '群聊');
  const groupSendSucceeded = sendOpLogs.some((log) => /^(?:群聊|旁观群)「/.test(String(log || '')));
  if (groupSendRequested && !groupSendSucceeded) {
    let fallbackCode = 'group_send_no_effect';
    if (linkageIntervalBlocked) fallbackCode = 'group_send_interval_blocked';
    else if (options.onlySenderId) fallbackCode = 'group_send_sender_restricted';
    else if (isAllMutedGroup(chat)) fallbackCode = 'group_send_source_muted';
    else if (sendOpsActorMuted) fallbackCode = 'group_send_actor_muted';
    const feedback = describeCrossWindowGroupSendFailure(sendOpLogs.receipts, fallbackCode);
    const latestTimestamp = Math.max(
      Number(await getNowForUser(userId).catch(() => Date.now())) || Date.now(),
      ...toSave.map((message) => Number(message?.timestamp || 0)),
    ) + 1;
    const failureMessage = createMessage({
      chatId,
      senderId: 'system',
      senderName: '跨窗消息',
      type: 'chatAction',
      content: feedback.message,
      timestamp: latestTimestamp,
      metadata: {
        aiRoundId,
        marshmallowEventType: 'group_send_failed',
        failureCode: feedback.code,
        failureReason: feedback.reason,
        failureCategory: feedback.category,
      },
    });
    await saveMessage(failureMessage);
    await updateChatPreview(chatId, previewFromMessage(failureMessage), failureMessage.timestamp);
    toSave.push(failureMessage);
  }
  const linkageAudience = classifyLinkageAudienceOutcome({
    backstageSaved,
    privateHandled: privateMsgResult?.handled,
    sendLogs: sendOpLogs,
  });
  const linkageRoute = linkageAudience.route;
  if (linkageRoute && linkageMarkerMessageIndex >= 0 && toSave[linkageMarkerMessageIndex]?.id) {
    const markedMessage = {
      ...toSave[linkageMarkerMessageIndex],
      metadata: {
        ...(toSave[linkageMarkerMessageIndex].metadata || {}),
        linkageFired: true,
      },
    };
    await saveMessage(markedMessage).catch(() => {});
    toSave[linkageMarkerMessageIndex] = markedMessage;
  }
  if (chatId) {
    const latest = await getChat(chatId).catch(() => null);
    if (latest) {
      const metadata = {
        ...(latest.metadata || {}),
        linkageTurnCounter: Math.max(
          Math.round(Number(latest.metadata?.linkageTurnCounter || 0) || 0),
          resolveNextLinkageTurn(chat),
        ),
        ...(linkageEnabled && shouldConsumeLinkageInterval(linkageIntervalState, linkageRoute, {
          requireUserPrivate: userPrivateLinkageEnabled,
          userPrivateHandled: privateMsgResult?.handled,
        }) ? {
          linkageLastOpportunityTurn: resolveNextLinkageTurn(chat),
        } : {}),
        ...(Number(privateMsgResult?.handled || 0) > 0 ? {
          linkageLastUserPrivateTurn: resolveNextLinkageTurn(chat),
          linkageLastUserPrivateAt: Date.now(),
          linkageUserPrivateActorHistory: appendUserPrivateActorHistory(
            latest,
            (privateMsgResult.chats || []).map((entry) => entry?.actorId),
            {
              aiRoundId,
              at: Date.now(),
              turn: resolveNextLinkageTurn(chat),
            },
          ),
        } : {}),
        ...(linkageRoute ? {
          linkageRouteHistory: appendLinkageRouteHistory(latest, linkageRoute, {
            aiRoundId,
            at: Date.now(),
            turn: resolveNextLinkageTurn(chat),
            frontstageGroup: linkageAudience.hasFrontstageGroup,
            backstageGroup: linkageAudience.hasBackstageGroup,
          }),
        } : {}),
        ...(groupCreationBudget.remaining === 0
          && groupCreationEnabled
          && groupCreationCooldown.allowed ? {
            linkageLastGroupCreationTurn: resolveNextLinkageTurn(chat),
            linkageLastGroupCreationAt: Date.now(),
          } : {}),
      };
      await saveChat({ ...latest, metadata });
      chat.metadata = metadata;
    }
  }

  if (chat && userId) {
    // 指导模式回合不写入普通扮演摘要，避免 OOC 讨论沉淀成角色记忆。
    if (aiRoundKind !== 'guidance') {
      const summaryUserName = resolveAiRoundSummaryActorName({
        chat,
        actorId: 'user',
        userId,
        currentUserName,
        characters,
      });
      maybeSummarizeChatMemory({
        chat,
        userId,
        currentUserName: summaryUserName,
        resolveName: (id) => resolveAiRoundSummaryActorName({
          chat,
          actorId: id,
          userId,
          currentUserName: summaryUserName,
          characters,
        }),
      }).catch(() => {});
    }
    if (!options.skipEventAdvance) {
      advanceActiveEventAfterAiReply(chatId).catch(() => {});
    }
    if (aiRoundKind !== 'guidance' && !options.phoneViewerId) {
      await recordEnsembleRound({
        userId,
        chat,
        aiRoundId,
        savedMessages: toSave,
        sideEffects: materialized.sideEffects || [],
        backstageSaved,
        characters,
      }).catch((error) => {
        console.warn('[ai-round] ensemble event record failed', error);
      });
    }
    const chatIntentEvents = materialized.sideEffects.filter((event) => (
      event?.t === 'social_post' || event?.t === 'open_alias'
      || event?.t === 'social_react' || event?.t === 'share_back' || event?.t === 'alias_poke'
      || event?.t === 'interaction_plan'
    )).filter((event) => (
      event?.t !== 'social_post'
      || !['later', 'queue', 'defer'].includes(String(event?.timing || '').trim().toLowerCase())
    ));
    if (chatIntentEvents.length) {
      // 发帖/点赞评论/刷帖分享/开号/小号使用各自现有生成与存储管线；回合已成功落库后再异步执行，
      // 失败只记旁路警告，绝不回滚或遮住正常聊天回复。
      void executeChatIntentSideEffects(chatIntentEvents, {
        chat,
        chatId,
        aiRoundId,
        user,
        userId,
        characters,
        chatPrefs,
        recentMessages: [...(Array.isArray(messages) ? messages : []), ...toSave].slice(-24),
      }).catch((error) => {
        console.warn('[ai-round] chat intent side effects failed', error);
      });
    }
    // 真人感后台追发拍：这轮以角色发言收尾、用户迟迟不接时，把下一拍登记成待办，
    // 切后台/关 App 也能由保活扫描或回前台补跑接住；用户开口或 TA 自己排了延时则清拍。
    if (
      aiRoundKind !== 'guidance'
      && !options.onlySenderId
      && !options.phoneViewerId
      && options.skipChaseAutoSchedule !== true
      && options.realPersonChase !== true
    ) {
      import('./real-person-chase-beat.js')
        .then((mod) => mod.maybeScheduleChaseBeatAfterRound({
          chat,
          userId,
          prefs: chatPrefs,
          priorMessages: Array.isArray(messages) ? messages : [],
          savedMessages: toSave,
          sideEffects: materialized.sideEffects || [],
          reason: String(options.reason || ''),
          realPersonChase: options.realPersonChase === true,
        }))
        .catch((error) => console.warn('[ai-round] chase beat schedule failed', error));
    }
    // 回合成功落库的完成信号：朋友圈「聊完天后可能发圈」等旁路功能挂在这上面，
    // 不直接 import 业务模块，避免核心回合链路反向依赖社交功能。
    if (typeof window !== 'undefined' && toSave.length) {
      window.dispatchEvent(new CustomEvent('marshmallow-ai-round-complete', {
        detail: {
          chatId,
          userId,
          userPresent: userInThisChat === true,
          partnerIds: (chat?.participants || []).filter((p) => p && p !== 'user'),
        },
      }));
    }
  }

  // 同步跨窗产物至此已经全部落库。只登记轻量 id 清单，重 roll 时便可精准回滚，
  // 不需要再逐个聊天读取全部历史；缓存写入延后执行，不阻塞本轮气泡上屏。
  markAiRoundCascadeIndexComplete(aiRoundId);

  markPersistTiming('completedMs');
  if (persistTiming.completedMs >= 2_000) {
    const visibleSavedMs = Number(persistTiming.visibleMessagesSavedMs || 0);
    void appendDebugEvent({
      type: 'chat_persist_timing',
      level: persistTiming.completedMs >= 10_000 ? 'warn' : 'info',
      message: `聊天结果本地整理耗时 ${Math.round(persistTiming.completedMs / 100) / 10} 秒`,
      durationMs: persistTiming.completedMs,
      context: {
        chatId,
        aiRoundId,
        messageCount: toSave.length,
        sideEffectCount: (materialized.sideEffects || []).length,
        ...persistTiming,
        postVisibleMs: visibleSavedMs > 0
          ? Math.max(0, persistTiming.completedMs - visibleSavedMs)
          : 0,
      },
    });
  }

  return {
    ok: true,
    messageCount: toSave.length,
    messages: toSave,
    backstageSaved,
    receipts: roundReceipts.list(),
    rejected: checked.rejected,
    warnings: materialized.warnings,
    genImageCount: genImageEvents.length,
    statusPrefs,
    scheduleChangeResult,
    autoReplyResult,
    memoResult,
    radioPlanResult,
    periodResult,
    replyCompositionDiagnostics,
    partialSalvage: partialSalvage
      || (toSave.length > 0 && (parsed.errors || []).some((e) => e?.code === 'invalid_json')),
    legacyTaggedFallback: parsed.legacyTaggedFallback === true,
  };
}

export async function runChatAiTurn(options = {}) {
  const chat = options.chat;
  const chatId = String(options.chatId || chat?.id || '').trim();
  if (!chatId || !chat) throw new Error('chat required');
  const user = options.user || null;
  const userId = String(options.userId || user?.id || '').trim();
  const requiresSocialGroupBoundary = String(chat?.metadata?.channel || '') === 'backstage'
    || String(chat?.metadata?.groupOrigin || '') === 'send-op';
  if (requiresSocialGroupBoundary) {
    const socialBoundary = await checkPhoneSocialParticipantIds(chat.participants, userId)
      .catch(() => ({ allowed: false }));
    if (!socialBoundary.allowed) {
      return {
        ok: false,
        reason: 'phone-social-group-boundary',
        blocked: true,
        participantIds: [
          socialBoundary.pair?.leftId,
          socialBoundary.pair?.rightId,
        ].filter(Boolean),
      };
    }
  }
  if (options.allowBlockedManual !== true && options.allowBlocked !== true) {
    const { shouldSuppressAiDelivery } = await import('../chat-block-state.js');
    const blocked = await shouldSuppressAiDelivery(chat, { allowManual: !!options.manual });
    if (blocked.blocked) {
      return { ok: false, reason: blocked.reason || 'blocked-by-user', blocked: true };
    }
  }

  const {
    chat: chatCompletion,
    chatWithPreferredStream,
    getConfig,
    resolveChatPreferStream,
    resolveGenerationMaxTokens,
    getStreamPartialText,
    isStreamTransportError,
  } = await import('../api.js');
  const { resolveChatMainApiOverride } = await import('../api-presets.js');
  const { buildChatContext, resolveFrontStageUserName } = await import('../context/build-chat-context.js');
  const { loadAnonymousSpaceUserProfile } = await import('../anonymous-space.js');
  const { isAnonymousChat } = await import('../chat-helpers.js');

  const history = Array.isArray(options.messages) ? options.messages : [];
  const aiRoundCreatedAt = Number(options.aiRoundCreatedAt || 0) || Date.now();
  const suppliedAiRoundId = String(options.aiRoundId || '').trim();
  const aiRoundId = suppliedAiRoundId || makeAiRoundId(aiRoundCreatedAt);
  const rerollRootId = String(options.rerollRootId || aiRoundId).trim() || aiRoundId;
  const aiRoundKind = String(options.aiRoundKind || (options.gapFillWindow ? 'gap' : 'advance')).trim();
  const { loadChatPrefs } = await import('../chat-block-state.js');
  const chatPrefs = await loadChatPrefs(chatId).catch(() => ({}));
  const guidanceMode = options.guidanceMode === true
    || chatPrefs.guidanceMode === true
    || options.presetMode === 'guidance';
  const preferMarshmallowV2 = guidanceMode
    ? false
    : (options.preferMarshmallowV2 !== false && options.preferGuguV2 !== false);
  const anonymousChat = options.anonymousChat === true || isAnonymousChat(chat);
  const anonSpaceProfile = anonymousChat && userId
    ? await loadAnonymousSpaceUserProfile(userId).catch(() => null)
    : null;
  const frontStageUserName = anonymousChat || isStrangerInterceptChat(chat)
    ? resolveFrontStageUserName(chat, user, anonSpaceProfile)
    : getUserConversationName(user);
  const streamExpectsMarshmallow = shouldStreamAsMarshmallowProtocol({
    preferMarshmallowV2,
    preferGuguV2: options.preferGuguV2,
    anonymousChat,
  });

  const characters = options.characters || {};
  const auditActorIds = (chat?.participants || [])
    .map((id) => String(id || '').trim())
    .filter((id) => id && id !== 'user');
  const auditActorNames = auditActorIds.map((id) => {
    const row = characters[id] || {};
    return String(row.customNickname || row.name || id).trim();
  });
  const roundAuditContext = {
    ...(options.auditContext || {}),
    operation: String(options.auditContext?.operation || 'chat-round'),
    trigger: String(options.reason || (aiRoundKind === 'reroll' ? 'user-reroll' : 'user-advance')),
    initiator: options.reason ? 'background' : 'user',
    chatId,
    logicalRoundId: aiRoundId,
    proactiveChannel: String(options.proactiveChannel || ''),
    actorIds: auditActorIds,
    actorNames: auditActorNames,
  };
  const resolveSenderName = typeof options.resolveSenderName === 'function'
    ? options.resolveSenderName
    : async (id) => {
      if (id === 'user') return frontStageUserName;
      if (anonymousChat) {
        const { getAnonymousDisplayProfile } = await import('../anonymous-chat.js');
        const profile = getAnonymousDisplayProfile(chat, id, {
          currentUserName: frontStageUserName,
          spaceProfile: anonSpaceProfile,
        });
        if (profile?.anonymousId) return profile.anonymousId;
      }
      const char = characters[id];
      return String(char?.customNickname || char?.name || id);
    };

  let sceneDirective = options.sceneDirective;
  let capabilityCheckout = options.capabilityCheckout || null;
  let activeCapabilityContinuationId = String(options.capabilityContinuationId || '').trim();
  let tagBusyFauxAutoReply = options.tagBusyFauxAutoReply === true;
  if (options.skipBusyAutoReply !== true) {
    const { maybeHandleBusyAutoReply } = await import('../character-phone-proactive.js');
    const busyReply = await maybeHandleBusyAutoReply({
      chat,
      user,
      messages: history,
      characters,
      resolveSenderName,
      chatPrefs,
    });
    if (busyReply?.handled) return busyReply;
    // 忙碌被戳醒：这一轮走真实回复，带上「忙里偷闲冒头」的场景提示。
    if (busyReply?.breakThrough && busyReply.directive) {
      sceneDirective = [sceneDirective, busyReply.directive].filter(Boolean).join('\n\n');
    }
    // 系统挡刀循环里穿插手打假装自动回复。
    if (busyReply?.fauxAutoReply && busyReply.directive) {
      sceneDirective = [sceneDirective, busyReply.directive].filter(Boolean).join('\n\n');
      tagBusyFauxAutoReply = true;
    }
  }

  const continuityRepair = (!guidanceMode && !anonymousChat && userId)
    ? await prepareChatContinuityRepair({
      userId,
      chatId,
      characterIds: auditActorIds,
      characterNames: Object.fromEntries(auditActorIds.map((id) => {
        const row = characters[id] || {};
        return [id, String(row.customNickname || row.name || id).trim()];
      })),
      now: Date.now(),
    }).catch(() => ({ incidents: [], incidentIds: [], block: '' }))
    : { incidents: [], incidentIds: [], block: '' };
  if (continuityRepair.block) {
    sceneDirective = [sceneDirective, continuityRepair.block].filter(Boolean).join('\n\n');
  }

  // MCP 已成功、最终角色回复却因 429/断流失败时，下一次明确推进
  // 直接复用已落本地的工具结果，绝不再执行 MCP。
  if (!guidanceMode && !anonymousChat && !activeCapabilityContinuationId) {
    const pendingCapability = await loadCapabilityContinuation(chatId).catch(() => null);
    if (pendingCapability?.block) {
      activeCapabilityContinuationId = String(pendingCapability.id || '').trim();
      capabilityCheckout = pendingCapability.checkout || capabilityCheckout;
      sceneDirective = [sceneDirective, pendingCapability.block].filter(Boolean).join('\n\n');
    }
  }

  // 用户明确写出已经发生的同处身体动作时，在构建提示词和发请求之前先建立短时物理占用。
  // 这样同一时刻运行的后台群像任务不会趁本轮尚未落库，把 user/角色安排到第二个地点。
  const ensembleReservation = (!guidanceMode && !anonymousChat && userId)
    ? await reserveEnsembleSituationFromUserMessage({
      userId,
      chat,
      messages: history,
      aiRoundId,
    }).catch(() => null)
    : null;
  if (ensembleReservation?.ok === false && ensembleReservation.reason === 'physical-conflict') {
    sceneDirective = [
      sceneDirective,
      '【群像现实冲突 · 本轮输入不能直接确立为已发生】user 或当前角色仍被另一段进行中的实体场景占用。不得把本轮身体动作写成已经成功发生，也不得泄露另一场景的同行者、地点和活动；可以按远程表达、未能碰面、动作尚未发生或需要稍后承接来回应。',
    ].filter(Boolean).join('\n\n');
  }

  const mainApiConfig = await getConfig();
  const apiOverride = await resolveChatMainApiOverride(chatId).catch(() => null);
  const initialStreamMode = typeof options.preferStream === 'boolean'
    ? options.preferStream
    : await resolveChatPreferStream(apiOverride || null);
  const configuredTransport = options.generationTransport && typeof options.generationTransport === 'object'
    ? options.generationTransport
    : {};
  const relayPrefs = getGenerationRelayPrefs();
  const relayEnabled = isGenerationRelayEnabled(relayPrefs);
  const generationTransport = describeGenerationTransport({
    baseUrl: relayEnabled ? relayPrefs.baseUrl : (apiOverride?.baseUrl ?? mainApiConfig.baseUrl),
    stream: initialStreamMode,
    supportsServerIdempotency: relayEnabled || configuredTransport.supportsServerIdempotency === true,
    supportsStatusQuery: relayEnabled || configuredTransport.supportsStatusQuery === true,
  });
  if (relayEnabled) generationTransport.kind = 'self-host-relay';
  const suppliedTaskIdentity = Boolean(
    String(options.generationTaskId || '').trim()
    && String(options.generationIdempotencyKey || '').trim()
  );
  const requestedTaskIdentity = suppliedTaskIdentity
    ? {
      taskId: String(options.generationTaskId),
      idempotencyKey: String(options.generationIdempotencyKey),
    }
    : makeGenerationTaskIdentity();
  const generationLedgerCreateStartedAt = Date.now();
  let generationTask;
  let generationLedgerAvailable = true;
  try {
    generationTask = await createGenerationTask({
      taskId: requestedTaskIdentity.taskId,
      idempotencyKey: requestedTaskIdentity.idempotencyKey,
      chatId,
      aiRoundId,
      sourceActionId: options.sourceActionId,
      anchorMessageId: options.generationAnchorMessageId,
      anchorTimestamp: options.generationAnchorTimestamp,
      startedAt: options.generationStartedAt || aiRoundCreatedAt,
      transport: generationTransport,
      promptSummary: { sourceMessageCount: history.length },
      status: 'preparing',
    });
  } catch (error) {
    // 自动待办不能在账本未知时盲发，避免 claim 过期后第二次计费；但用户明确
    // 发起的前台调用不能因为辅助恢复账本故障而完全失去基本发送能力。前台降级为
    // 本轮内存账本，后续不会宣称它可自动恢复。
    if (options.manual === true) {
      generationLedgerAvailable = false;
      const startedAt = Number(options.generationStartedAt || aiRoundCreatedAt) || Date.now();
      generationTask = {
        version: 1,
        taskId: requestedTaskIdentity.taskId,
        idempotencyKey: requestedTaskIdentity.idempotencyKey,
        chatId: String(chatId || '').trim(),
        aiRoundId: String(aiRoundId || '').trim(),
        sourceActionId: String(options.sourceActionId || '').trim(),
        anchorMessageId: String(options.generationAnchorMessageId || '').trim(),
        anchorTimestamp: Number(options.generationAnchorTimestamp || 0),
        startedAt,
        updatedAt: Date.now(),
        transport: { ...generationTransport },
        promptSummary: { sourceMessageCount: history.length },
        status: 'preparing',
        attemptCount: 0,
        partial: '',
        sseFragments: [],
        error: null,
        recoveryUnavailable: true,
      };
      void appendDebugEvent({
        type: 'generation_ledger_degraded',
        level: 'warn',
        message: '生成恢复账本暂不可用；本次前台调用继续，但不会承诺崩溃恢复',
        context: {
          chatId,
          aiRoundId,
          error: String(error?.message || error || ''),
        },
      });
    } else {
    const ledgerError = error instanceof Error
      ? error
      : new Error(String(error || 'generation ledger unavailable'));
    ledgerError.code ||= 'generation-ledger-unavailable';
    ledgerError.requestNotStarted = true;
    ledgerError.modelRequestAttempted = false;
    throw ledgerError;
    }
  }
  const generationLedgerCreateMs = Math.max(0, Date.now() - generationLedgerCreateStartedAt);
  if (
    suppliedTaskIdentity
    && !isGenerationTaskSafePreDispatch(generationTask)
  ) {
    const error = new Error('这条自动回复的上次请求结果不明，已停止自动重发');
    error.code = 'generation-outcome-unknown';
    // Unknown is intentionally terminal for automatic work: false would make the
    // pending-action runner schedule a fresh paid request after its claim timeout.
    error.modelRequestAttempted = true;
    throw error;
  }
  const persistGenerationCheckpoint = async (task) => {
    if (!generationLedgerAvailable) return task;
    try {
      return await saveGenerationTask(task);
    } catch (error) {
      if (options.manual !== true) throw error;
      generationLedgerAvailable = false;
      void appendDebugEvent({
        type: 'generation_ledger_degraded',
        level: 'warn',
        message: '生成恢复账本中途不可用；本次前台调用继续，后续检查点已降级为内存',
        context: { chatId, aiRoundId, error: String(error?.message || error || '') },
      });
      return task;
    }
  };
  const taskWriter = createGenerationTaskCheckpointWriter(generationTask, {
    persist: persistGenerationCheckpoint,
  });
  // Android 以前只在真正发出 HTTP 请求后申请网络租约。用户点推进/重 roll 后若在
  // 上下文构建的几秒内切后台，WebView 会先被冻结，导致请求根本没有机会发出。
  // 租约请求必须先于恢复账本写入发起：APK 原生主库繁忙时，账本可能需要排队，
  // 但通知栏的“正在准备聊天上下文”和临时保活不应跟着延迟数秒。
  let preparationNetworkLease = await acquireNetworkLease({ timeoutMs: 4 * 60_000 });
  const releasePreparationNetworkLease = () => {
    if (!preparationNetworkLease) return;
    releaseNetworkLease(preparationNetworkLease);
    preparationNetworkLease = '';
  };
  let built;
  let contextBuildStartedAt = 0;
  try {
    if (generationTask.status !== 'preparing' || generationTask.error) {
      await taskWriter.checkpoint({
        status: 'preparing',
        attemptCount: 0,
        error: null,
      }, { immediate: true, strict: true });
    }
    contextBuildStartedAt = Date.now();
    built = await buildChatContext({
      chat,
      user,
      userId,
      messages: history,
      characters,
      contextDepth: options.contextDepth,
      sceneDirective,
      forcedLinkVisionMessageId: options.forcedLinkVisionMessageId,
      excludeAiRoundId: options.excludeAiRoundId,
      excludeAiRoundIds: options.excludeAiRoundIds,
      guidanceMode,
      guidanceScopeMode: options.guidanceScopeMode || options.aiRoundKind,
      presetMode: guidanceMode ? 'guidance' : options.presetMode,
      enabledLayers: options.enabledLayers,
      phoneViewerId: options.phoneViewerId,
      onlySenderId: options.onlySenderId,
      // 历史重生成由调用方传入原回合时间。它必须进入完整上下文构建，不能只
      // 控制回复落库时间，否则气泡仍在旧时刻，system 世界钟和心声却跑到当前。
      contextNow: options.contextNow,
      manualAdvance: options.manualAdvance === true && aiRoundKind === 'advance',
      disableMcpCapabilityIntent: Boolean(activeCapabilityContinuationId || options._capabilityIntentDepth),
      systemPromptCacheKey: (activeCapabilityContinuationId || options._capabilityIntentDepth)
        ? ''
        : options.contextPrewarmKey,
      structureStrengthening: (apiOverride?.structureStrengthening ?? mainApiConfig.structureStrengthening) === true,
    });
  } catch (error) {
    releasePreparationNetworkLease();
    throw error;
  }
  const contextBuildCompletedAt = Date.now();
  // ready 只是本地阶段提示，不值得在 API 前单独制造一次原生 fsync。让 writer
  // 与稍后的 dispatching 合并；真正的请求边界仍由 immediate checkpoint 覆盖。
  taskWriter.checkpoint({
    status: 'ready',
    promptSummary: summarizeGenerationPrompt(built.messages),
  });
  const contextBuildElapsedMs = Number(built.contextDiagnostics?.contextElapsedMs)
    || (Date.now() - contextBuildStartedAt);
  const contextBuildHiddenMs = Number(built.contextDiagnostics?.contextHiddenMs || 0);
  const contextBuildMs = Number(built.contextDiagnostics?.contextTotalMs)
    || Math.max(0, contextBuildElapsedMs - contextBuildHiddenMs);
  const systemPromptPhaseMs = built.contextDiagnostics?.systemPromptPhaseMs || {};
  const [slowestSystemPromptPhase = '', slowestSystemPromptPhaseMs = 0] = Object.entries(systemPromptPhaseMs)
    .sort((left, right) => Number(right[1] || 0) - Number(left[1] || 0))[0] || [];
  const systemPromptTaskMs = built.contextDiagnostics?.systemPromptTaskMs || {};
  const systemPromptTaskEntries = Object.entries(systemPromptTaskMs);
  const leafSystemPromptTaskEntries = systemPromptTaskEntries
    .filter(([name]) => ![
      'socialAndState',
      'socialLinkage',
      'layeredAndTimeline',
      'characterCards',
    ].includes(name));
  const [slowestSystemPromptTask = '', slowestSystemPromptTaskMs = 0] = (
    leafSystemPromptTaskEntries.length ? leafSystemPromptTaskEntries : systemPromptTaskEntries
  )
    .sort((left, right) => Number(right[1] || 0) - Number(left[1] || 0))[0] || [];
  if (contextBuildMs > 2500) {
    // Slow "回复慢" often happens before the request leaves the device; make it visible.
    const slowestPhaseSuffix = slowestSystemPromptPhase
      ? `；最慢阶段 ${slowestSystemPromptPhase} ${Math.round(Number(slowestSystemPromptPhaseMs || 0) / 100) / 10} 秒`
      : '';
    const slowestTaskSuffix = slowestSystemPromptTask
      ? `；最慢任务 ${slowestSystemPromptTask} ${Math.round(Number(slowestSystemPromptTaskMs || 0) / 100) / 10} 秒`
      : '';
    const sourceMessageCount = Number(built.contextDiagnostics?.sourceMessageCount || history.length);
    const workingMessageCount = Number(built.contextDiagnostics?.workingMessageCount || sourceMessageCount);
    const messageWindowSuffix = sourceMessageCount > workingMessageCount
      ? `；即时窗口 ${workingMessageCount}/${sourceMessageCount} 条`
      : '';
    appendDebugEvent({
      type: 'chat_context_build_slow',
      level: 'warn',
      message: `本地构建聊天上下文耗时 ${Math.round(contextBuildMs / 100) / 10} 秒（发请求之前${slowestPhaseSuffix}${slowestTaskSuffix}${messageWindowSuffix}）`,
      durationMs: contextBuildMs,
      context: {
        chatId,
        messageCount: history.length,
        sourceMessageCount,
        workingMessageCount,
        contextDepth: Number(built.contextDiagnostics?.contextDepth || 0),
        elapsedMs: contextBuildElapsedMs,
        hiddenMs: contextBuildHiddenMs,
        systemPromptMs: Number(built.contextDiagnostics?.systemPromptMs || 0),
        systemPromptElapsedMs: Number(built.contextDiagnostics?.systemPromptElapsedMs || 0),
        systemPromptHiddenMs: Number(built.contextDiagnostics?.systemPromptHiddenMs || 0),
        vectorSemanticMs: Number(built.contextDiagnostics?.vectorSemanticMs || 0),
        vectorSemanticTimedOut: built.contextDiagnostics?.vectorSemanticTimedOut === true,
        vectorSemanticAvailable: built.contextDiagnostics?.vectorSemanticAvailable === true,
        layeredMemoryMs: Number(built.contextDiagnostics?.layeredMemoryMs || 0),
        unifiedTimelineMs: Number(built.contextDiagnostics?.unifiedTimelineMs || 0),
        visionMs: Number(built.contextDiagnostics?.visionMs || 0),
        slowestSystemPromptPhase,
        slowestSystemPromptPhaseMs: Number(slowestSystemPromptPhaseMs || 0),
        systemPromptPhaseMs,
        systemPromptPhaseElapsedMs: built.contextDiagnostics?.systemPromptPhaseElapsedMs || {},
        systemPromptPhaseHiddenMs: built.contextDiagnostics?.systemPromptPhaseHiddenMs || {},
        slowestSystemPromptTask,
        slowestSystemPromptTaskMs: Number(slowestSystemPromptTaskMs || 0),
        systemPromptTaskMs,
        systemPromptTaskElapsedMs: built.contextDiagnostics?.systemPromptTaskElapsedMs || {},
        systemPromptTaskHiddenMs: built.contextDiagnostics?.systemPromptTaskHiddenMs || {},
        prewarmHit: built.contextDiagnostics?.prewarmHit === true,
        prewarmAgeMs: Number(built.contextDiagnostics?.prewarmAgeMs || 0),
        prewarmBuildMs: Number(built.contextDiagnostics?.prewarmBuildMs || 0),
        prewarmFallbackHit: built.contextDiagnostics?.prewarmFallbackHit === true,
        prewarmFallbackAgeMs: Number(built.contextDiagnostics?.prewarmFallbackAgeMs || 0),
        stableBlockCacheHits: built.contextDiagnostics?.stableBlockCacheHits || {},
        stableBlockCacheMisses: built.contextDiagnostics?.stableBlockCacheMisses || {},
      },
    });
  }

  let fullText = '';
  const genMaxTokens = options.maxTokens ?? await resolveGenerationMaxTokens(apiOverride);
  let finishReason = '';
  let upstreamMeta = {};
  let lastRequestStat = null;
  let lastEmptyRequestStat = null;
  let lastEmptyUpstreamMeta = null;
  let recoveredFromReasoning = false;
  let rawResponseEvidence = '';
  let relayCompletedAt = 0;
  let relayClaimedAt = 0;
  let generationRequestQueuedNotified = false;
  const notifyGenerationRequestQueued = (evidence = {}) => {
    if (generationRequestQueuedNotified) return;
    generationRequestQueuedNotified = true;
    if (typeof options.onGenerationRequestQueued !== 'function') return;
    try {
      options.onGenerationRequestQueued({
        queuedAt: Date.now(),
        attempt: Number(taskWriter.getTask()?.attemptCount || 0),
        aiRoundKind: guidanceMode ? 'guidance' : aiRoundKind,
        ...(guidanceMode ? { guidanceMode: true, guidanceReply: true } : {}),
        ...(evidence || {}),
      });
    } catch (_) { /* submitted evidence is already durable; UI bookkeeping is secondary */ }
  };
  const appendRawResponseEvidence = (value) => {
    const text = String(value || '');
    if (!text || rawResponseEvidence.length >= 120_000) return;
    rawResponseEvidence += text.slice(0, 120_000 - rawResponseEvidence.length);
  };
  const streamRequestOpts = {
    signal: options.signal,
    generationTask: generationTask ? {
      taskId: generationTask.taskId,
      idempotencyKey: generationTask.idempotencyKey,
      supportsServerIdempotency: generationTask.transport?.supportsServerIdempotency === true,
    } : null,
    auditContext: roundAuditContext,
    onRawSseFragment: (fragment) => {
      appendRawResponseEvidence(fragment);
      taskWriter.appendSseFragment(fragment, { partial: fullText });
    },
    onRawResponse: (text) => {
      appendRawResponseEvidence(text);
    },
    onRelayJob: async (job) => {
      const remoteJobId = String(job?.remoteJobId || job?.id || '');
      const firstAcceptedJob = Boolean(remoteJobId && !generationRequestQueuedNotified);
      if (firstAcceptedJob) {
        const queuedAt = Date.now();
        // generation-relay 已同步写入轻量 dispatch journal；先让页面进入 submitted
        // 并开始轮询，原生恢复账本异步追上，避免它被其它原生写入堵住几十秒。
        notifyGenerationRequestQueued({
          queuedAt,
          transport: 'self-host-relay',
          remoteJobId,
        });
        void taskWriter.checkpoint({
          status: job?.status === 'succeeded' ? 'received' : 'remote-running',
          transport: {
            ...generationTransport,
            remoteJobId,
            remoteQueuedAt: queuedAt,
          },
        }, { immediate: true }).catch((error) => {
          // 远端 job 已创建，继续轮询比因本地账本失败丢掉一份已付费结果更重要。
          // dispatching 证据与轻量任务号都已落下；恢复端不会把它当安全重放。
          void appendDebugEvent({
            type: 'generation_remote_job_checkpoint_failed',
            level: 'warn',
            message: '中继任务已接单，但本地任务编号检查点写入失败；当前页面继续领取结果',
            context: { chatId, aiRoundId, remoteJobId, error: String(error?.message || error || '') },
          });
        });
      }
      if (job?.status === 'succeeded') {
        relayClaimedAt = Date.now();
        const remoteUpdatedAt = Date.parse(String(job?.updatedAt || ''));
        relayCompletedAt = Number.isFinite(remoteUpdatedAt) ? remoteUpdatedAt : 0;
        if (typeof options.onGenerationRelayReady === 'function') {
          try {
            options.onGenerationRelayReady({
              completedAt: relayCompletedAt,
              claimedAt: relayClaimedAt,
              remoteJobId,
            });
          } catch (_) { /* lifecycle bookkeeping must never block result delivery */ }
        }
      }
      // 首次回执与后续轮询的原生账本更新都保持 best-effort；同步轻量旁路负责
      // 覆盖账本追上前的崩溃窗口，慢本地 DB 不再拉长领取间隔。
      if (!firstAcceptedJob) {
        void taskWriter.checkpoint({
          status: job?.status === 'succeeded' ? 'received' : 'remote-running',
          transport: {
            ...generationTransport,
            remoteJobId,
          },
        }, { immediate: true }).catch(() => {});
      }
    },
    onNativeRequestStart: (nativeRequestId, capabilities = {}) => {
      return taskWriter.checkpoint({
        status: 'dispatching',
        transport: {
          ...generationTransport,
          nativeRequestId: String(nativeRequestId || ''),
          supportsStatusQuery: capabilities.supportsStatusQuery === true,
        },
      }, { immediate: true, strict: true });
    },
    onNativeRequestQueued: async (nativeRequestId, event = {}) => {
      const queuedAt = Number(event?.queuedAt || event?.timestamp || 0) || Date.now();
      try {
        await taskWriter.checkpoint({
          status: 'running',
          transport: {
            ...generationTransport,
            nativeRequestId: String(nativeRequestId || ''),
            nativeQueuedAt: queuedAt,
            supportsStatusQuery: true,
          },
        }, { immediate: true, strict: true });
      } catch (error) {
        void appendDebugEvent({
          type: 'generation_native_queue_checkpoint_failed',
          level: 'warn',
          message: '原生请求已接管，但本地运行态检查点写入失败；当前请求继续',
          context: { chatId, aiRoundId, nativeRequestId, error: String(error?.message || error || '') },
        });
      }
      notifyGenerationRequestQueued({
        queuedAt,
        transport: 'native-http',
        nativeRequestId: String(nativeRequestId || ''),
      });
    },
    onTransportProgress: (progress) => {
      taskWriter.checkpoint({ transportProgress: { ...(progress || {}) }, partial: fullText });
      if (typeof options.onTransportProgress === 'function') options.onTransportProgress(progress);
    },
    onRequestStat: (stat) => {
      lastRequestStat = stat && typeof stat === 'object' ? { ...stat } : null;
      if (['reasoning_only', 'empty_content'].includes(String(stat?.errorKind || ''))) {
        lastEmptyRequestStat = { ...stat };
        lastEmptyUpstreamMeta = { ...upstreamMeta };
      }
      taskWriter.checkpoint({
        transport: {
          usedUrl: stat?.usedUrl || '',
          requestStream: stat?.requestStream === true,
          viaNativeHttp: stat?.viaNativeHttp === true,
          nativeHttpTransport: stat?.nativeHttpTransport || '',
          nativeRequestId: stat?.nativeRequestId || '',
          recoveredFromNativeTaskState: stat?.recoveredFromNativeTaskState === true,
          supportsStatusQuery: !!stat?.nativeRequestId,
          viaProxyFallback: stat?.viaProxyFallback === true,
        },
      });
      if (typeof options.onRequestStat === 'function') options.onRequestStat(stat);
    },
    buildMs: contextBuildMs,
    temperature: options.temperature,
    maxTokens: genMaxTokens,
    configOverride: apiOverride || undefined,
  };
  const placeholderTs = Number(options.baseTimestamp || 0) || await getNowForUser(userId);
  // 「正在输入」是运行态，不是聊天内容。前台和 headless 都由各自的会话状态绘制占位；
  // 不再先写一条 aiPlaceholder 到消息库，避免后台请求触发消息订阅、短暂顶掉真实气泡，
  // 或在异常退出后留下与常规气泡不同的孤儿记录。

  const onChunk = typeof options.onChunk === 'function' ? options.onChunk : null;
  const onStreamText = typeof options.onStreamText === 'function' ? options.onStreamText : null;
  let completionMessages = built.messages;
  const replyCompositionEnabled = options.replyCompositionEnabled === true
    || (
      options.replyCompositionEnabled !== false
      && built.runtimeCapabilities?.replyComposition === true
    );
  if (replyCompositionEnabled) {
    completionMessages = appendReplyCompositionContract(completionMessages);
  }

  const receiveText = (_delta, acc) => {
    if (typeof acc === 'string') fullText = acc;
    else fullText += String(_delta || '');
    taskWriter.checkpoint({ partial: fullText, status: 'running' });
    if (streamExpectsMarshmallow) {
      if (onStreamText) onStreamText('正在输入…', fullText);
      return;
    }
    if (onChunk) onChunk(fullText);
    if (onStreamText) onStreamText(fullText, fullText);
  };

  async function requestCompletion() {
    fullText = '';
    finishReason = '';
    const requestOptions = {
      ...streamRequestOpts,
      onFinishReason: (reason) => { finishReason = String(reason || '').trim(); },
      onCompletionMeta: (meta) => { upstreamMeta = { ...upstreamMeta, ...(meta || {}) }; },
    };
    const currentAttempt = Number(taskWriter.getTask()?.attemptCount || 0) + 1;
    const requestLedgerStartedAt = Date.now();
    try {
      await taskWriter.checkpoint({
        status: 'dispatching',
        attemptCount: currentAttempt,
        partial: '',
        completedAt: null,
        error: null,
        transport: { stream: initialStreamMode },
      }, { immediate: true, strict: true });
    } catch (error) {
      // saveGenerationTask writes the row before repairing its recovery index. If
      // that index repair fails, the durable row can say "dispatching" even though
      // the API call below was never reached. Best-effort rollback preserves the
      // stronger proof that this exact attempt is still safe to resume.
      await saveGenerationTask({
        ...(taskWriter.getTask() || generationTask),
        status: 'ready',
        attemptCount: Math.max(0, currentAttempt - 1),
        completedAt: null,
        error: {
          kind: 'dispatch-ledger-write-failed',
          message: String(error?.message || error || '任务账本写入失败'),
        },
        updatedAt: Date.now(),
      }).catch(() => null);
      const dispatchLedgerError = error instanceof Error
        ? error
        : new Error(String(error || 'generation dispatch ledger unavailable'));
      dispatchLedgerError.code ||= 'generation-ledger-unavailable';
      dispatchLedgerError.requestNotStarted = true;
      dispatchLedgerError.modelRequestAttempted = false;
      throw dispatchLedgerError;
    }
    const requestDispatchAt = Date.now();
    const requestLedgerMs = Math.max(0, requestDispatchAt - requestLedgerStartedAt);
    const preRequestPreparationMs = Math.max(0, requestDispatchAt - contextBuildCompletedAt);
    if (preRequestPreparationMs >= 1_000) {
      void appendDebugEvent({
        type: 'chat_request_dispatch_slow',
        level: preRequestPreparationMs >= 5_000 ? 'warn' : 'info',
        message: `聊天上下文完成后又等待 ${Math.round(preRequestPreparationMs / 100) / 10} 秒才发出主请求`,
        durationMs: preRequestPreparationMs,
        context: {
          chatId,
          aiRoundId,
          attempt: currentAttempt,
          generationLedgerCreateMs,
          requestLedgerMs,
          capabilityIntentContinuation: Boolean(activeCapabilityContinuationId),
        },
      });
    }
    if (typeof options.onGenerationRequestStart === 'function') {
      try {
        options.onGenerationRequestStart({
          startedAt: Date.now(),
          attempt: currentAttempt,
          preRequestPreparationMs,
          generationLedgerCreateMs,
          requestLedgerMs,
        });
      } catch (_) { /* lifecycle bookkeeping must never block the model request */ }
    }
    if (typeof options.preferStream !== 'boolean') {
      await chatWithPreferredStream(completionMessages, receiveText, requestOptions);
      if (typeof options.onGenerationResponseReady === 'function') {
        try {
          options.onGenerationResponseReady({
            readyAt: Date.now(),
            relayCompletedAt,
            relayClaimedAt,
          });
        } catch (_) { /* lifecycle bookkeeping must never block result delivery */ }
      }
      // 任务账本只是中断恢复旁路。完整结果已经在内存中时，不应等待 IndexedDB
      // 检查点写链才开始聊天落库；终态 flush 会继续按顺序收束这些写入。
      void taskWriter.checkpoint({ status: 'received', partial: fullText }, { immediate: true });
      return;
    }
    await chatCompletion(completionMessages, {
      ...requestOptions,
      stream: initialStreamMode,
      onChunk: receiveText,
    });
    if (typeof options.onGenerationResponseReady === 'function') {
      try {
        options.onGenerationResponseReady({
          readyAt: Date.now(),
          relayCompletedAt,
          relayClaimedAt,
        });
      } catch (_) { /* lifecycle bookkeeping must never block result delivery */ }
    }
    void taskWriter.checkpoint({ status: 'received', partial: fullText }, { immediate: true });
  }

  function describeEmptyCompletion() {
    const stat = lastEmptyRequestStat
      || (lastRequestStat && typeof lastRequestStat === 'object' ? lastRequestStat : {});
    const emptyUpstreamMeta = lastEmptyUpstreamMeta || upstreamMeta;
    const reasoningOnly = stat.errorKind === 'reasoning_only'
      || Number(stat.reasoningLength || 0) > 0;
    const completed = stat.sawDone === true || Boolean(stat.finishReason || finishReason);
    const closedWithoutProtocolEnd = stat.protocolIncomplete === true;
    const title = reasoningOnly
      ? '接口只返回了推理内容'
      : (completed
        ? '接口已结束，但正文为空'
        : (closedWithoutProtocolEnd ? '上游结束响应，但正文为空' : '未抽到可用正文'));
    const baseMessage = reasoningOnly
      ? '接口已返回推理内容并结束，但没有返回可显示的正文 content。请检查模型/中转是否会把最终答案写入 content，或换一条兼容线路。'
      : (completed
        ? '接口已正常结束这次响应，但返回的正文 content 为空。这不是后台断流；更可能是上游空 completion 或正文字段不兼容。'
        : (closedWithoutProtocolEnd
          ? '浏览器收到的响应连接已正常闭合，但其中没有可显示正文，也没有结束标记；这更接近上游空回或响应格式不兼容，不按网络断线处理。'
          : '未从接口响应中抽到可显示的正文；请在详情中查看结束标记与传输证据。'));
    return {
      title,
      message: baseMessage,
      emptyKind: reasoningOnly
        ? 'reasoning-only'
        : (completed ? 'completed-empty' : (closedWithoutProtocolEnd ? 'closed-empty' : 'unknown-empty')),
      finishReason: stat.finishReason || finishReason || '',
      upstreamMeta: emptyUpstreamMeta,
      upstreamResponse: formatUpstreamResponseText(emptyUpstreamMeta),
      responseText: rawResponseEvidence.trim(),
      correlationId: stat.correlationId || '',
      usedUrl: stat.usedUrl || '',
      requestModel: stat.model || emptyUpstreamMeta.requestModel || '',
      requestStream: stat.requestStream,
      status: Number(stat.status || 0) || undefined,
      streamStats: Object.keys(stat).length ? stat : null,
      requestElapsedMs: Number(stat.durationMs || 0),
    };
  }

  async function tryPersistMarshmallow(rawText, persistOpts = {}) {
    if (typeof options.onGenerationPersistPreflightStart === 'function') {
      try {
        options.onGenerationPersistPreflightStart({ startedAt: Date.now() });
      } catch (_) { /* lifecycle bookkeeping must never block result delivery */ }
    }
    const liveChat = await getChat(chatId).catch(() => null);
    if (!liveChat) {
      await deleteMessagesWithAiRoundId(chatId, aiRoundId, { deleteSystem: true }).catch(() => {});
      return { ok: false, reason: 'chat-deleted-during-generation', messages: [] };
    }
    if (!anonymousChat) {
      const participantIds = (liveChat.participants || []).filter((id) => id && id !== 'user');
      const phoneOwnerId = String(
        options.phoneViewerId
        || liveChat?.metadata?.phoneOwnerId
        || liveChat?.metadata?.focalActorId
        || '',
      ).trim();
      const missingIds = await listMissingCharactersDuringGeneration(participantIds, {
        characters,
        userId,
        phoneOwnerId,
        chat: liveChat,
      });
      if (missingIds.length) {
        await deleteMessagesWithAiRoundId(chatId, aiRoundId, { deleteSystem: true }).catch(() => {});
        return {
          ok: false,
          reason: 'character-deleted-during-generation',
          error: '会话中的角色在生成期间已被删除或移出，本轮回复未保存。',
          detail: `missingCharacterIds: ${missingIds.join(', ')}`,
          missingCharacterIds: missingIds,
          messages: [],
        };
      }
    }
    if (typeof options.deliveryGuard === 'function') {
      let deliveryGate = null;
      try {
        deliveryGate = await options.deliveryGuard({
          stage: 'before-turn-persist',
          chatId,
          aiRoundId,
        });
      } catch (_) {
        deliveryGate = { ok: false, reason: 'delivery-guard-failed' };
      }
      if (deliveryGate === false || deliveryGate?.ok === false) {
        await deleteMessagesWithAiRoundId(chatId, aiRoundId, { deleteSystem: true }).catch(() => {});
        return {
          ok: false,
          skipped: true,
          reason: String(deliveryGate?.reason || 'delivery-blocked'),
          messages: [],
        };
      }
    }
    if (typeof options.onGenerationPersistStart === 'function') {
      try {
        options.onGenerationPersistStart({ startedAt: Date.now() });
      } catch (_) { /* lifecycle bookkeeping must never block result delivery */ }
    }
    const result = await persistMarshmallowTurn(rawText, {
      // 设置可能在请求期间变化；落库闸门必须使用刚重新读取的群禁言/联动状态。
      chat: liveChat,
      chatId,
      aiRoundId,
      messages: history,
      user,
      userId,
      characters,
      // 匿名/陌生马甲会话必须以前台身份落库；调用方即使误传外部实名，
      // 也不能污染心声身份绑定、引用名和动作目标名。
      currentUserName: (anonymousChat || isStrangerInterceptChat(liveChat))
        ? frontStageUserName
        : frontStageUserName,
      resolveSenderName,
      extraActorIds: options.extraActorIds || [],
      actorResolutionExtraIds: options.actorResolutionExtraIds || Object.keys(characters || {}),
      rawText,
      currentActorId: options.onlySenderId || options.currentActorId || getPartnerActor(liveChat),
      signal: options.signal,
      onStreamText,
      baseTimestamp: options.baseTimestamp,
      gapFillWindow: options.gapFillWindow,
      aiRoundCreatedAt,
      rerollRootId,
      aiRoundKind,
      onlySenderId: options.onlySenderId,
      anonymousChat,
      reason: String(options.reason || ''),
      realPersonChase: options.realPersonChase === true,
      tagBusyFauxAutoReply,
      offlineReturnBridge: options.offlineReturnBridge === true,
      offlineReturnArchiveId: String(options.offlineReturnArchiveId || ''),
      ...persistOpts,
      mcpCheckout: capabilityCheckout,
      // 提示词与落地使用同一次上下文构建得到的能力快照；避免请求期间再次读取设置后
      // 把模型已经输出的 gen_image 静默降级成 textimg。
      allowImageGen: built.runtimeCapabilities?.imageGeneration?.allowed === true,
      statusOpportunity: options.statusOpportunity || null,
      auditContext: roundAuditContext,
      deliveryGuard: options.deliveryGuard,
      onVisibleMessagesPersisted: options.onVisibleMessagesPersisted,
      // 本次 run 内新建的 round id 不可能已有落库产物；省掉一次全会话扫描、
      // reaction/recall/state 四路回滚与无意义的 active-event rewind。显式复用
      // round id（中继接管/幂等重放）仍保留原来的先清理语义。
      skipExistingAiRoundCleanup: !suppliedAiRoundId,
      avatarImageCandidates: (built.pendingVisionMarks || [])
        .map((item) => item?.msg)
        .filter((message) => message?.senderId === 'user' && message?.type === 'image'),
    });
    await saveAiDebugSnapshot(chatId, rawText);
    if (result.ok) {
      const visibleRepairMessages = (Array.isArray(result.messages) ? result.messages : []).filter((message) => {
        const senderId = String(message?.senderId || '').trim();
        return senderId && senderId !== 'user' && senderId !== 'system' && senderId !== 'guidance';
      });
      if (visibleRepairMessages.length && continuityRepair.incidentIds.length) {
        const visibleRepairActorIds = new Set(visibleRepairMessages.map((message) => (
          String(message?.senderId || '').trim()
        )).filter(Boolean));
        const resolvedIncidentIds = continuityRepair.incidents
          .filter((incident) => visibleRepairActorIds.has(String(incident.characterId || '').trim()))
          .map((incident) => incident.id);
        await resolveChatContinuityIncidents(userId, chatId, resolvedIncidentIds, {
          aiRoundId,
          resolvedAt: Date.now(),
          messageIds: visibleRepairMessages.map((message) => message.id).filter(Boolean),
        }).catch(() => null);
      }
      await commitVisionContextMarks(built.pendingVisionMarks);
      if (activeCapabilityContinuationId) {
        await clearCapabilityContinuation(chatId, activeCapabilityContinuationId).catch(() => false);
      }
      void taskWriter.flush({
        status: 'completed',
        partial: String(rawText || ''),
        completedAt: Date.now(),
        persistedMessageCount: Number(result.messageCount || 0),
        error: null,
      });
    } else if (aiRoundId) {
      await deleteMessagesWithAiRoundId(chatId, aiRoundId);
      void taskWriter.flush({
        status: result.skipped === true ? 'aborted' : 'failed',
        partial: String(rawText || ''),
        completedAt: Date.now(),
        error: {
          kind: String(result.reason || 'persist-failed'),
          message: String(result.error || '生成结果未能落库'),
        },
      });
    }
    return {
      ...result,
      aiRoundId,
      rawText,
      reasoningText: String(upstreamMeta?.reasoningText || ''),
      finishReason: result?.finishReason || upstreamMeta?.finishReason || finishReason || '',
      upstreamMeta,
      requestModel: lastRequestStat?.model || upstreamMeta?.requestModel || '',
      requestStream: lastRequestStat?.requestStream,
      status: Number(lastRequestStat?.status || upstreamMeta?.status || 0) || undefined,
      streamStats: lastRequestStat && typeof lastRequestStat === 'object' ? { ...lastRequestStat } : null,
      ...(tagBusyFauxAutoReply && result.ok ? { fauxAutoReply: true, busyGate: true } : {}),
      ...(options.offlineReturnBridge === true && result.ok ? {
        offlineReturnBridge: true,
        offlineReturnArchiveId: String(options.offlineReturnArchiveId || ''),
      } : {}),
    };
  }

  async function persistGuidancePlainText(rawText) {
    if (!guidanceMode) throw new Error('普通聊天禁止自动落库掉格式原文');
    await deleteMessagesWithAiRoundId(chatId, aiRoundId);
    const rawFallbackText = stripThinkingBlocks(String(rawText || '')).trim() || '…';
    const fallbackParts = splitPlainTextFallbackBubbles(rawFallbackText);
    const partnerId = String(options.onlySenderId || '').trim()
      || (chat.participants || []).find((p) => p && p !== 'user')
      || 'character';
    const { GUIDANCE_SENDER_ID } = guidanceMode
      ? await import('../guidance-memory.js')
      : { GUIDANCE_SENDER_ID: '' };
    const fallbackSenderId = guidanceMode ? GUIDANCE_SENDER_ID : partnerId;
    const partnerName = guidanceMode
      ? '本体'
      : await resolveSenderName(fallbackSenderId);
    const gapMetadata = Number(options.gapFillWindow?.startTs || 0) > 0
      && Number(options.gapFillWindow?.endTs || 0) > Number(options.gapFillWindow?.startTs || 0)
      ? {
        aiRoundGapStart: Number(options.gapFillWindow.startTs),
        aiRoundGapEnd: Number(options.gapFillWindow.endTs),
      }
      : {};
    let fallbackMessages = (fallbackParts.length ? fallbackParts : [rawFallbackText]).map((part, index, list) => {
      const transformed = applyPermanentRegex(part, {
        surface: options.regexSurface || 'chat',
        placement: fallbackSenderId === 'user' ? 1 : 2,
        depth: 0,
        macros: { user: frontStageUserName, char: partnerName || '角色' },
      });
      return createMessage({
        chatId,
        senderId: fallbackSenderId,
        senderName: partnerName,
        type: 'text',
        content: transformed || part,
        timestamp: placeholderTs + 1500 + index * 1500,
        metadata: {
          aiRoundId,
          aiGenerated: true,
          legacyFallback: true,
          plainTextFallback: true,
          fallbackPartIndex: index,
          fallbackPartCount: list.length,
          aiRoundCreatedAt,
          rerollRootId,
          aiRoundKind: guidanceMode ? 'guidance' : aiRoundKind,
          ...(guidanceMode ? { guidanceMode: true, guidanceReply: true } : {}),
          ...gapMetadata,
        },
      });
    });
    if (fallbackMessages.length) {
      // 指导模式使用普通文本落库，但它仍是当下实时发生的一轮。
      // 用户回拨虚拟时间或会话中已有未来时间戳时，placeholderTs 可能早于库内末条；
      // 若直接保存，长会话的“最新一页”会在流式预览结束后把新回复排除在外。
      const latestStored = await listMessagesForChat(chatId, 1).catch(() => messages);
      fallbackMessages = rebaseLiveMessageBatch(latestStored, fallbackMessages);
    }
    await saveMessages(fallbackMessages);
    const lastFallback = fallbackMessages[fallbackMessages.length - 1];
    await updateChatPreview(chatId, previewFromMessage(lastFallback), lastFallback.timestamp);
    await commitVisionContextMarks(built.pendingVisionMarks);
    await taskWriter.flush({
      status: 'completed',
      partial: String(rawText || ''),
      completedAt: Date.now(),
      persistedMessageCount: fallbackMessages.length,
      error: null,
    });
    void appendDebugEvent({
      type: 'chat_guidance_plain_text_persisted',
      level: 'warn',
      message: '指导模式回复已按普通文本气泡落库',
      context: {
        chatId,
        aiRoundId,
        messageCount: fallbackMessages.length,
      },
    });
    return {
      ok: true,
      aiRoundId,
      messageCount: fallbackMessages.length,
      messages: fallbackMessages,
      legacyFallback: true,
      plainTextFallback: true,
      rawText: String(rawText || ''),
      reasoningText: String(upstreamMeta?.reasoningText || ''),
      finishReason: upstreamMeta?.finishReason || finishReason || '',
      upstreamMeta,
      requestModel: lastRequestStat?.model || upstreamMeta?.requestModel || '',
      requestStream: lastRequestStat?.requestStream,
      status: Number(lastRequestStat?.status || upstreamMeta?.status || 0) || undefined,
      streamStats: lastRequestStat && typeof lastRequestStat === 'object' ? { ...lastRequestStat } : null,
      ...(tagBusyFauxAutoReply ? { fauxAutoReply: true, busyGate: true } : {}),
    };
  }

  try {
    try {
      await requestCompletion();
    } finally {
      // api.js 会为真正的原生 HTTP 请求持有自己的租约；准备租约到这里即可释放。
      releasePreparationNetworkLease();
    }
    if (!String(fullText || '').trim()) {
      const recoveredOutput = recoverFinalOutputFromReasoning(
        upstreamMeta.reasoningText || lastEmptyUpstreamMeta?.reasoningText,
        {
          // 在线聊天只恢复能明确识别为棉花糖协议的成稿。普通文字、接口响应对象和报错 JSON
          // 仍留在错误详情里，不能再进入纯文本兜底并写成角色气泡。
          accept: (candidate) => !guidanceMode && isMarshmallowChatLikelyInProgress(candidate),
        },
      );
      if (recoveredOutput) {
        fullText = recoveredOutput;
        recoveredFromReasoning = true;
        await taskWriter.checkpoint({
          status: 'received',
          partial: fullText,
        }, { immediate: true });
        void appendDebugEvent({
          type: 'chat_reasoning_content_recovered',
          level: 'info',
          message: '聊天输出从上游推理字段中的最终成稿恢复',
          context: {
            chatId,
            aiRoundId,
            recoveredLength: fullText.length,
            finishReason: String(finishReason || upstreamMeta.finishReason || ''),
            requestModel: String(lastRequestStat?.model || upstreamMeta.requestModel || ''),
          },
        });
      } else {
        const empty = describeEmptyCompletion();
        await saveAiDebugSnapshot(chatId, '');
        await deleteMessagesWithAiRoundId(chatId, aiRoundId);
        await taskWriter.flush({
          status: 'failed',
          completedAt: Date.now(),
          error: {
            kind: 'empty-api-response',
            message: empty.message,
          },
        });
        return {
          ok: false,
          reason: 'empty-api-response',
          title: empty.title,
          error: `${empty.message} 本轮未自动重发，请手动重试或更换线路。`,
          aiRoundId,
          rawText: '',
          ...empty,
        };
      }
    }
  } catch (error) {
    const abortLike = error?.name === 'AbortError' || /abort/i.test(String(error?.message || ''));
    const partialText = String(fullText || getStreamPartialText(error) || '').trim();
    const marshmallowLike = streamExpectsMarshmallow || isMarshmallowChatLikelyInProgress(partialText);
    if (!abortLike && partialText.length >= 16 && marshmallowLike) {
      const recovered = await tryPersistMarshmallow(partialText, { allowOpenTail: true });
      if (recovered.ok) {
        return { ...recovered, recoveredFromPartial: true };
      }
      if (recovered.skipped) return recovered;
    }
    if (marshmallowLike) {
      const interruptionReason = classifyAiRoundCatchReason(error, abortLike);
      await saveAiDebugSnapshot(chatId, partialText || fullText);
      await deleteMessagesWithAiRoundId(chatId, aiRoundId);
      await taskWriter.flush({
        status: abortLike ? 'aborted' : 'interrupted',
        partial: partialText || fullText,
        completedAt: Date.now(),
        ...(error?.nativeRequestId ? {
          transport: {
            ...generationTransport,
            nativeRequestId: String(error.nativeRequestId),
            supportsStatusQuery: true,
          },
        } : {}),
        error: {
          kind: interruptionReason,
          message: String(error?.message || error || '生成连接中断'),
        },
      });
      return {
        ok: false,
        aborted: abortLike,
        abortReason: error?.abortReason || '',
        reason: interruptionReason,
        error: error?.message || String(error),
        rawText: partialText || fullText,
        responseText: error?.responseText || rawResponseEvidence.trim(),
        status: Number(error?.status || 0) || undefined,
        transportError: !abortLike && isStreamTransportError(error),
        usedUrl: error?.usedUrl || '',
        correlationId: error?.correlationId || '',
        requestAttempts: error?.requestAttempts || [],
        requestModel: error?.requestModel || '',
        requestStream: error?.requestStream,
        streamStats: error?.streamStats || null,
        requestElapsedMs: Number(error?.requestElapsedMs || lastRequestStat?.durationMs || 0),
      };
    }
    await taskWriter.flush({
      status: abortLike ? 'aborted' : 'interrupted',
      partial: partialText || fullText,
      completedAt: Date.now(),
      ...(error?.nativeRequestId ? {
        transport: {
          ...generationTransport,
          nativeRequestId: String(error.nativeRequestId),
          supportsStatusQuery: true,
        },
      } : {}),
      error: {
        kind: classifyAiRoundCatchReason(error, abortLike),
        message: String(error?.message || error || '生成连接中断'),
      },
    });
    throw error;
  }

  if (!guidanceMode && (streamExpectsMarshmallow || isMarshmallowChatLikelyInProgress(fullText))) {
    if (!String(fullText || '').trim()) {
      const empty = describeEmptyCompletion();
      await saveAiDebugSnapshot(chatId, '');
      await deleteMessagesWithAiRoundId(chatId, aiRoundId);
      await taskWriter.flush({
        status: 'failed',
        completedAt: Date.now(),
        error: { kind: 'empty-api-response', message: empty.message },
      });
      return {
        ok: false,
        reason: 'empty-api-response',
        title: empty.title,
        error: empty.message,
        aiRoundId,
        rawText: '',
        ...empty,
      };
    }
    if (finishReason === 'length') {
      const recovered = await tryPersistMarshmallow(fullText, { allowOpenTail: true });
      if (recovered.ok) return { ...recovered, recoveredFromPartial: true, finishReason };
      if (recovered.skipped) return recovered;
      await deleteMessagesWithAiRoundId(chatId, aiRoundId);
      const truncatedChars = String(fullText || '').length;
      const upstreamResponse = formatUpstreamResponseText(upstreamMeta);
      await taskWriter.flush({
        status: 'failed',
        partial: fullText,
        completedAt: Date.now(),
        error: { kind: 'upstream-finish-length', message: '上游输出未完成' },
      });
      return {
        ok: false,
        reason: 'upstream-finish-length',
        title: '上游输出未完成',
        error: [
          `上游 API 以 finish_reason=length 结束，协议块未写完（已收到约 ${truncatedChars} 字）。`,
          '聊天单轮输出通常远不到模型上限，这更像是线路不稳定或上游提前截流，不是本地配置问题。',
          '本轮未自动重发，请手动重试或更换线路。',
        ].filter(Boolean).join(''),
        finishReason: upstreamMeta.finishReason || finishReason || 'length',
        upstreamMeta,
        upstreamResponse,
        retried: false,
        aiRoundId,
        rawText: fullText,
      };
    }
    const needSearchResult = await maybeHandleNeedSearch(fullText);
    if (needSearchResult) return needSearchResult;
    const capabilityIntentResult = await maybeHandleCapabilityIntent(fullText);
    if (capabilityIntentResult) return capabilityIntentResult;
    const persisted = await tryPersistMarshmallow(fullText);
    if (persisted.ok || persisted.skipped) return persisted;
    return persisted;
  }

  /**
   * need_search 逃生口：角色在本轮申请了联网查证时——
   * 先把已有的过渡消息落库（「等我查一眼」），查证成功后把结果注入上下文重跑一轮，
   * 用户看到的是「角色去查了 → 带着真实信息回来接话」。查证失败/未开启则按普通轮次落库。
   */
  async function maybeHandleNeedSearch(rawText) {
    if (options._needSearchDepth) return null;
    const request = extractNeedSearchRequest(rawText);
    if (!request) return null;
    const actorId = request.from || options.currentActorId || getPartnerActor(chat);
    const actorName = await resolveSenderName(actorId).catch(() => '');
    if (onStreamText) onStreamText(`等待确认联网搜索「${request.query}」…`, rawText);
    let declined = false;
    let resolved = null;
    try {
      resolved = await resolveNeedSearchContext({
        userId,
        characterId: actorId,
        characterName: actorName,
        query: request.query,
        signal: options.signal,
        approvalHandler: options.capabilityApprovalHandler,
        mode: typeof options.capabilityApprovalHandler === 'function' ? 'foreground' : 'background',
        userInitiated: options.manual === true,
      });
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      declined = err?.code === 'capability_denied' && err?.decision?.reason === 'approval_declined';
      if (!declined && err?.code !== 'capability_approval_required') {
        console.warn('[need-search] resolve failed', err);
      }
    }
    if (declined) {
      const first = await tryPersistMarshmallow(rawText).catch(() => null);
      if (first?.skipped) return first;
      const carried = first?.ok && Array.isArray(first.messages) ? first.messages : [];
      const retry = await runChatAiTurn({
        ...options,
        aiRoundId: undefined,
        aiRoundCreatedAt: undefined,
        generationTaskId: undefined,
        generationIdempotencyKey: undefined,
        generationStartedAt: undefined,
        rerollRootId,
        messages: [...history, ...carried],
        sceneDirective: buildNeedSearchDeclinedBlock(request.query),
        _needSearchDepth: 1,
        skipBusyAutoReply: true,
        allowBlockedManual: true,
      });
      return {
        ...retry,
        needSearch: { query: request.query, declined: true },
        needSearchFirstRound: first?.ok ? { aiRoundId, messageCount: carried.length } : null,
      };
    }
    if (!resolved?.block) return null;
    const first = await tryPersistMarshmallow(rawText).catch(() => null);
    if (first?.skipped) return first;
    const carried = first?.ok && Array.isArray(first.messages) ? first.messages : [];
    if (!resolved.fromCache) showToast(`${actorName || 'TA'} 查了下「${request.query}」…`, 3000);
    if (!resolved.fromCache && first?.ok && chat?.type !== 'group') {
      try {
        const [{ loadResolvedCharacterAutonomyPolicy }, { enqueuePendingAction }] = await Promise.all([
          import('../character-autonomy-settings.js'),
          import('./pending-actions.js'),
        ]);
        const policy = await loadResolvedCharacterAutonomyPolicy(userId, actorId, chatId);
        if (policy?.realPersonMode?.enabled === true) {
          const delayMinutes = 1 + (String(request.query || '').length % 3);
          const pacingNow = await getPacingNowForUser(userId);
          const queued = await enqueuePendingAction({
            userId,
            characterId: actorId,
            chatId,
            kind: 'delayed_reply',
            dueAt: pacingNow + delayMinutes * 60 * 1000,
            createdAt: pacingNow,
            dedupeKey: `need-search:${chatId}:${aiRoundId}:${request.query}`,
            payload: {
              reason: `查完「${request.query}」后回来接话`,
              topic: request.query,
              sceneDirective: resolved.block,
              sourceAiRoundId: aiRoundId,
            },
          });
          if (queued?.ok) {
            return {
              ...first,
              needSearch: {
                query: request.query,
                cached: false,
                delayed: true,
                delayMinutes,
              },
              needSearchFirstRound: { aiRoundId, messageCount: carried.length },
            };
          }
        }
      } catch (error) {
        console.warn('[need-search] delayed return unavailable', error);
      }
    }
    const retry = await runChatAiTurn({
      ...options,
      aiRoundId: undefined,
      aiRoundCreatedAt: undefined,
      generationTaskId: undefined,
      generationIdempotencyKey: undefined,
      generationStartedAt: undefined,
      rerollRootId,
      messages: [...history, ...carried],
      sceneDirective: resolved.block,
      _needSearchDepth: 1,
      skipBusyAutoReply: true,
      allowBlockedManual: true,
    });
    return {
      ...retry,
      needSearch: { query: request.query, cached: resolved.fromCache === true },
      needSearchFirstRound: first?.ok ? { aiRoundId, messageCount: carried.length } : null,
    };
  }

  /**
   * 主模型只做符合人设的高层决策；命中 capability_intent 后才让工具模型
   * 读取完整 schema、执行 MCP 链。普通聊天不会进入这里，因而不多一次工具模型请求。
   */
  async function maybeHandleCapabilityIntent(rawText) {
    if (options._capabilityIntentDepth || activeCapabilityContinuationId) return null;
    const request = extractCapabilityIntent(rawText);
    if (!request) return null;
    const actorId = resolveCapabilityIntentActorId(request, chat, options);
    const actorName = await resolveSenderName(actorId).catch(() => '');
    const intentGoal = buildCapabilityIntentGoal(request);
    if (onStreamText) onStreamText(`正在准备外部能力…`, rawText);

    const permissionContext = resolveCapabilityIntentPermissionContext(request, {
      foreground: options.manual === true,
      approvalHandler: options.capabilityApprovalHandler,
    });
    const capabilityTurn = await prepareConversationCapabilityMessages({
      enabled: true,
      messages: built.messages,
      intentText: intentGoal,
      connectionHint: request.connection,
      context: 'chat',
      chatId,
      actorId,
      actorName,
      userInitiated: permissionContext.userInitiated,
      autonomousOnly: request.initiative === 'character',
      signal: options.signal,
      approvalHandler: permissionContext.approvalHandler,
      onStatus: (status) => onStreamText?.(status, rawText),
      onFailure: (step) => {
        const message = formatCapabilityFailure(step);
        if (message) showToast(message, 7000);
      },
      onError: (error) => {
        const route = error?.capabilityRoute || {};
        const routeLabel = route.apiSection === 'tool' ? '工具模型' : '聊天模型';
        const timedOut = error?.code === 'capability_chain_timeout';
        showGenerationErrorReport({
          ...error,
          scope: `MCP 工具选择 · ${routeLabel}${route.model ? ` · ${route.model}` : ''}`,
          title: timedOut ? 'MCP 调用超时' : 'MCP 未调用',
          message: formatCapabilityPlannerError(error),
          rawText: error?.rawText || error?.rawResponse || '',
          requestElapsedMs: Number(error?.elapsedMs || 0),
          reason: error?.reason || error?.code || (error?.rawText ? 'json-parse-failed' : 'empty-api-response'),
        });
      },
    });

    const continuationBlock = capabilityTurn.block || buildCapabilityUnavailableBlock(
      request,
      capabilityTurn.plannerError
        ? formatCapabilityPlannerError(capabilityTurn.plannerError)
        : '工具模型判断本次无需或无法调用',
    );
    let continuation = null;
    try {
      continuation = await saveCapabilityContinuation(chatId, {
        goal: request.goal,
        block: continuationBlock,
        checkout: capabilityTurn.checkout || null,
        sourceAiRoundId: aiRoundId,
      });
      await taskWriter.checkpoint({
        capabilityIntent: {
          goal: request.goal,
          initiative: request.initiative,
          continuationId: continuation.id,
          toolResultStored: true,
        },
      }, { immediate: true });
    } catch (error) {
      showToast('外部工具已返回，但续接断点保存失败；将尝试在本轮继续回复', 6000);
    }

    const first = await tryPersistMarshmallow(rawText).catch(() => null);
    if (first?.skipped) return first;
    const carried = first?.ok && Array.isArray(first.messages) ? first.messages : [];
    const retry = await runChatAiTurn({
      ...options,
      aiRoundId: undefined,
      aiRoundCreatedAt: undefined,
      generationTaskId: undefined,
      generationIdempotencyKey: undefined,
      generationStartedAt: undefined,
      rerollRootId,
      messages: [...history, ...carried],
      sceneDirective: continuationBlock,
      capabilityCheckout: capabilityTurn.checkout || null,
      capabilityContinuationId: continuation?.id || '',
      _capabilityIntentDepth: 1,
      skipBusyAutoReply: true,
      allowBlockedManual: true,
    });
    return {
      ...retry,
      capabilityIntent: {
        goal: request.goal,
        connection: request.connection,
        initiative: request.initiative,
        used: capabilityTurn.used === true,
        resumed: false,
      },
      capabilityIntentFirstRound: first?.ok ? { aiRoundId, messageCount: carried.length } : null,
    };
  }

  if (guidanceMode) return persistGuidancePlainText(fullText);
  return tryPersistMarshmallow(fullText);
}
