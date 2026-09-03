import {
  back,
  navigate,
  navigateDismissing,
  invalidateKeepAlive,
  invalidateOfflinePresenceKeepAlive,
} from '../core/router.js';
import { consumeRoutePrefetchData, prefetchRoute } from '../core/route-prefetch.js';
import { icon } from '../components/svg-icons.js';
import { wechatGlyph } from '../core/chat/wechat-shell.js';
import {
  getChatAppearance,
  isChatSessionAppearanceActive,
  applyChatThreadAppearance,
  applyChatThreadWallpaper,
  clearChatThreadWallpaper,
  shouldFillChatNavbarSafeTop,
  shouldUsePlatformBubbleCssCompat,
} from '../core/chat-appearance.js';
import {
  getActiveTheme,
  isSeaHomeTheme,
  isWindowHomeTheme,
  loadAppearancePrefs,
  normalizeChatPlatform,
  saveAppearancePrefs,
} from '../core/appearance-prefs.js';
import {
  CHAT_TOOL_DEFAULT_ORDER,
  mergeVisibleChatToolOrder,
  normalizeChatToolOrder,
  paginateChatToolbarItems,
  sortChatToolbarItems,
} from '../core/chat-toolbar-order.js';
import {
  buildChatInteractionDirective,
  createChatInteractionSession,
  normalizeChatInteractionPlan,
  normalizeChatInteractionSession,
  planChatInteraction,
} from '../core/chat-interactions.js';
import { openChatToolbarOrderModal } from '../components/chat-toolbar-order-modal.js';
import { openCapabilityApprovalModal } from '../components/capability-approval-modal.js';
import { characterAvatarHtml, emptyIllustration } from '../components/scrapbook-illustrations.js';
import { showToast } from '../components/toast.js';
import { openTextEditorModal } from '../components/text-editor-modal.js';
import {
  openGuidanceExitScopeSheet,
  openGuidanceModeSheet,
  openGuidanceMemoryManageModal,
} from '../components/guidance-memory-modal.js';
import {
  distillGuidanceSession,
  saveGuidanceMemory,
  formatMessagesAsGuidanceNote,
  guidanceChatScopeId,
  GUIDANCE_SCENE_DEFAULT_TURNS,
  GUIDANCE_SENDER_ID,
  isGuidanceMessage,
  scopedGuidanceSuccessPatch,
  selectGuidanceDisplayMessages,
  selectGuidanceSessionMessages,
} from '../core/guidance-memory.js';
import { openChatVoiceComposerSheet } from '../components/chat-voice-composer-sheet.js';
import { openInsertBubbleAfterModal } from '../components/insert-bubble-modal.js';
import { openEditBubbleModal } from '../components/edit-bubble-modal.js';
import { openVoteEditorModal } from '../components/vote-editor-modal.js';
import { updateStoryCardKnowledgeByMessageId } from '../core/memory/shared-event-knowledge.js';
import { openChatBubbleMenu, bindLongPress } from '../components/chat-bubble-menu.js';
import { bindBubbleSwipeReply } from '../components/bubble-swipe-reply.js';
import { recordSupportOperation } from '../core/support/support-context.js';
import { openChatCardModal } from '../components/chat-interactive-modals.js';
import { resolveChatInternalLink } from '../core/chat/internal-link.js';
import { createTransferReceiptMessage } from '../core/chat/apply-transfer-events.js';
import {
  collectPersistedChatMentions,
  findComposerMentionQuery,
  insertComposerMention,
} from '../core/chat/mentions.js';
import {
  buildRedPacketSendMetadata,
  reconcileRedPacketClaimNotices,
} from '../core/chat/red-packet-claims.js';
import { normalizeVoiceCallText, openVoiceCallModal, openVoiceCallRecordModal } from '../components/voice-call-modal.js';
import { openParticipantPicker } from '../components/participant-picker.js';
import { chooseOfflineExperienceMode } from '../components/offline-experience-mode-sheet.js';
import { openPlainTextBubblePickerModal } from '../components/plain-text-bubble-picker-modal.js';
import { openChatRowSheet } from '../components/chat-row-sheet.js';
import { openImageLightbox } from '../components/image-lightbox.js';
import {
  dismissGenerationErrorReport,
  showGenerationErrorReport,
} from '../components/generation-error-report.js';
import {
  buildGenerationErrorCopyText,
  generationErrorFromCatch,
  isProtocolParseFailure,
  normalizeGenerationError,
  openGenerationErrorDetail,
  recordLastGenerationError,
} from '../core/generation-error-guide.js';
import {
  applyEditRegex,
  applyPermanentRegex,
  primeDisplayRegex,
} from '../core/display-regex.js';
import {
  fileToOptimizedChatImageDataUrl,
  dataUrlApproxBytes,
  CHAT_IMAGE_INLINE_MAX_BYTES,
  CHAT_IMAGE_TARGET_MAX_BYTES,
} from '../core/chat/chat-image-utils.js';
import { stripTranslationMarks } from '../core/narration-translation.js';
import {
  handleTranslationToggleClick,
  isChineseDialectLanguageHint,
  isValidUserFacingTranslation,
  resolveMessageSourceText,
  sanitizeAiTranslation,
} from '../core/translation-utils.js';
import { resolveVoiceTranslationProfile } from '../models/character.js';
import { loadAnonymousSpaceUserProfile, loadAnonymousSpaceState, normalizeAnonymousSpaceProfile } from '../core/anonymous-space.js';
import {
  createLinkEnhanceToken,
  attachLinkDetailSnapshotMetadata,
  captureLinkDetailSnapshot,
  enhanceLinkMetadata,
  isLinkMessageMetadataStale,
  normalizeLinkUrl,
  parseSingleLinkShareText,
  buildPendingLinkMetadata,
  shouldAwaitLinkEnhanceQueue,
} from '../core/link-card-enhancer.js';
import { loadSocialLinkConfig } from '../core/social-link-tools.js';
import { openLinkPreview } from '../components/link-preview-sheet.js';
import { openChatUserGenImageModal } from '../components/chat-user-gen-image-modal.js';
import {
  loadChatCharState,
  loadChatCharStateHistory,
  canReadLegacyUnscopedChatState,
  filterChatCharStateForUser,
} from '../core/chat/character-state.js';
import { getInnerVoiceCard, INNER_VOICE_CARD_CHANGED_EVENT, resolveInnerVoiceLabel } from '../core/chat/inner-voice-style.js';
import { closeCharStatePopover, openCharStatePopover, renderInnerVoiceBodyTemplate } from '../components/char-state-popover.js';
import {
  bindVoiceBubbleInteractions,
  cancelVoiceMessagePlayback,
  canReadTextBubbleAsVoice,
  exportCachedTextBubbleRoundVoice,
  exportCachedTextBubbleVoice,
  getCachedVoiceExportAvailability,
  isVoiceMessagePlaybackActive,
  isVoiceMessageSequencePlaybackActive,
  playTextBubbleAsVoice,
  playTextBubbleSequenceAsVoice,
} from '../core/chat/voice-bubble.js';
import { get, put, onStoreWrite } from '../core/db.js';
import { ensureDefaultUser } from '../core/user-slot.js';
import {
  recoverQqContactApplicationFromHistory,
  resolveQqContactApplication,
} from '../core/qq-contact-application-response.js';
import { getUserDisplayName } from '../models/user.js';
import {
  resolveActorDisplayLabel,
  looksLikeRawParticipantId,
  participantIdentityLookupIds,
} from '../core/chat/character-code-fallback.js';
import { resolvePhoneSocialActorDisplayName } from '../core/phone-social-actor-directory.js';
import {
  getChat,
  chatBelongsToUserSlot,
  ensurePrivateChat,
  saveChat,
  updateChatDirectives,
  listMessagesForChat,
  listMessagesPageForChat,
  listMessagesAroundForChat,
  listMessageDaysForChat,
  findFirstMessageForChatDay,
  saveMessage,
  saveMessages,
  deleteMessage,
  updateChatPreview,
  previewFromMessage,
  deleteMessagesWithAiRoundId,
  rewindChatPsychologicalContinuityForReroll,
  restoreChatPsychologicalContinuityRollback,
  captureAiRoundMessageRestoreBundle,
  deleteAiRoundCascadeArtifacts,
  restoreAiRoundCascadeArtifacts,
  recalcChatPreview,
  clearChatUnread,
  bumpChatUnread,
  promoteBackstageChatToGroup,
  deferHeavyMediaForDisplay,
  compareChatMessageChronology,
  clampLiveMessageTimestamp,
  repairChatFutureTimestampDrift,
  computeSparkStatsForChat,
  lightChatSparkDayFromMessage,
  shouldReloadCachedThreadMessages,
} from '../core/chat-store.js';
import {
  beginChatStreamSession,
  clearPendingChatStream,
  endChatStreamSession,
  abortChatStream,
  getChatStreamSession,
  getPendingChatStreamRecord,
  updateChatStreamSession,
  isChatStreamPendingAnywhere,
  subscribeChatStreamSession,
  takeInterruptedChatStreamNotice,
  CHAT_STREAM_INTERRUPTED_EVENT,
  CHAT_STREAM_PREVIEW,
} from '../core/chat/chat-stream-session.js';
import { acquireGenerationExecutionLock } from '../core/chat/generation-execution-lock.js';
import {
  getGenerationTaskStrict,
  isGenerationTaskSafePreDispatch,
  isGenerationTaskTerminal,
  makeGenerationTaskIdentity,
  saveGenerationTask,
} from '../core/chat/generation-task-store.js';
import {
  completeReplyIntentOutbox,
  stageReplyIntentOutbox,
} from '../core/chat/reply-intent-outbox.js';
import {
  loadPresenceWatch,
  consumePresenceGrab,
  computeRealPersonReplyDelayMs,
  computeRealPersonChaseDelayMs,
  buildRealPersonReplyFreshnessBlock,
  detectRapidExchange,
  getLastVisibleConversationMessage,
  getUnansweredRealUserMessage,
  isCharacterConversationMessage,
  isRealUserMessage,
  isVisibleConversationMessage,
  isAutomaticGenerationAnchorStopped,
  REAL_PERSON_MAX_CHASES_PER_SILENCE,
  resolveActiveWaitMood,
  resolveChaseMinIntervalMs,
} from '../core/chat/marshmallow-presence.js';
import {
  markChatManuallyAdvanced,
  ensureKeepAliveDuringActiveGeneration,
} from '../core/background-scheduler.js';
import {
  notifyCharacterSentMessageIfEnabled,
  notifyGroupChatMessageIfEnabled,
  resolveChatNotifyCharacterInfo,
  shouldNotifyForBackgroundReason,
  isViewingChatThread,
  isGroupChatForNotify,
} from '../core/native-notifications.js';
import { getRecord } from '../core/db.js';
import { getCharactersByIds } from '../core/character-store.js';
import { createMessage, isAllMutedGroup } from '../models/chat.js';
import {
  loadOfflineSession,
  offlineSessionHasProgress,
  offlineSessionKey,
} from '../core/offline-session-store.js';
import {
  canRunOfflineSideTripTakeover,
  generatePhoneCinematicExchange,
  loadOfflineAutoReplySettings,
  resolveOfflineAutoReplyConfig,
  syncOfflineChatContinuityMemory,
} from '../core/offline-auto-reply.js';
import {
  completeOfflinePhoneCinematicJob,
  createOfflinePhoneCinematicJob,
  getOfflinePhoneCinematicJob,
  rollOfflinePhoneCinematic,
  updateOfflinePhoneCinematicJob,
} from '../core/offline-phone-cinematic.js';
import {
  buildReplyTargetFields,
  getLastAiRoundId,
  getLastAiRerollTarget,
  getReplyContentPreview,
  normalizeMessageForUi,
  isBackstageChat,
  isObserverLikeChat,
  isAnonymousChat,
  isUserPresentInChat,
  canRunUserRealPersonScheduling,
  isStreamerSourcedChat,
  getMessageCopyText,
  copyTextToClipboard,
  buildOrderShareMessageContent,
  normalizeOrderSharePrice,
  buildPhoneProxyOwnerFeedbackExplain,
  createPhoneProxyMessageMetadata,
} from '../core/chat-helpers.js';
import {
  rerollGeneratedImageMessage,
  canRerollGeneratedImage,
  isGenImageStuck,
  recoverInterruptedGeneratedImageMessage,
  localizeLegacyGeneratedImageMessage,
} from '../core/chat/marshmallow-gen-image.js';
import { persistMarshmallowTurn, runChatAiTurn } from '../core/chat/marshmallow-turn-persist.js';
import {
  abortHeadlessChatReply,
  isHeadlessChatReplyRunning,
  isHeadlessChatReplyTyping,
  waitForHeadlessChatReplyIdle,
} from '../core/chat/headless-reply.js';
import { requestPendingChatActionCancellation } from '../core/chat/pending-actions.js';
import {
  createControlGestureLatch,
  createGenerationIntentGate,
} from '../core/chat/generation-control-gate.js';
import {
  hasActiveVoiceCall,
  normalizeVoiceCallReplyText,
  resolveVoiceCallReplyDisplayMode,
  selectVoiceCallContextTurns,
  stripLeakedVoiceCallContextPrefix,
  validateVoiceCallTranslationText,
} from '../core/chat/voice-call-guard.js';
import {
  advanceVirtualTimeForMessages,
  getNowForUser,
  getAiTimeBlind,
  getPacingNowForUser,
  getUserTimezone,
  peekNowForUser,
} from '../core/time-mode.js';
import { nextChatMessageTimestamp } from '../core/virtual-time-shim.js';
import { renderAppendedMessagesHtml, renderMessagesHtml, renderStreamingPlaceholder } from '../core/chat/render-bubbles.js';
import { isReadOnlyStoryCardMessage } from '../core/chat/card-render.js';
import { hydrateHtmlExtensionHosts } from '../core/html-extensions.js';
import { isHiddenFromChatUi } from '../core/chat/message-timeline.js';
import {
  extractMarshmallowStreamPreviewEvents,
  stripLeakedMarshmallowProtocolMarkers,
  stripThinkingBlocks,
} from '../core/marshmallow-protocol.js';
import { splitPlainTextFallbackBubbles } from '../core/chat/plain-text-fallback.js';
import {
  buildAdvanceSceneMessage,
  buildManualTurnTimeAnchor,
  buildGapFillSceneMessage,
  buildRealPersonChatterSceneMessage,
  buildRealPersonChaseSceneMessage,
  buildNarratorMessage,
  buildRecentBeatSummary,
  stampSceneMessage,
  pickGroupSpeaker,
} from '../core/chat/thread-scene.js';
import { getActiveEvent, clearActiveEvent, isActiveEventUserVisible } from '../core/chat/active-event.js';
import { openChatStickerPicker, findChatStickerChoices } from '../components/chat-sticker-picker.js';
import { openEmojiReactionPicker } from '../components/emoji-reaction-picker.js';
import { applyEmojiReactionToMessage, removeUserEmojiReactionFromMessage } from '../core/chat/reactions.js';
import { applyOfflineInviteScheduleFromMessage } from '../core/chat/offline-invite-schedule.js';
import {
  resolveGroupOfflineInviteResponse,
  saveGroupInviteStoryCard,
} from '../core/chat/group-offline-invite-response.js';
import {
  ensureOfflineSessionFromInvite,
  findActiveOfflineSessionForUser,
  getActiveOfflineParticipantIds,
  inviteOfflineParticipant,
  joinOfflineParticipant,
  withdrawOfflineParticipantInvite,
} from '../core/offline-session.js';
import { declineInviteDueToOffline, mergeInviteIntoOffline } from '../core/offline-auto-reply.js';
import { getAnonymousDisplayProfile, buildAnonymousAdvanceDirective } from '../core/anonymous-chat.js';
import { isCyberConfessionChat } from '../core/anonymous-confession.js';
import { createAnonymousPrivateFromGroup } from '../core/anonymous-private-chat.js';
import {
  isStrangerInterceptChat,
  isUserAliasBlockedByCharacter,
  visibleIdentityFor,
} from '../core/stranger-thread-model.js';
import {
  principalKey,
  resolveSanitizedForwardAliasSource,
  sanitizeForwardedAliasItem,
} from '../core/alias-account-model.js';
import {
  ensureStrangerThread,
  ensureStrangerChatAppearanceInherited,
  purgeStrangerGeneratedUserMessages,
  refreshStrangerThreadAccountSnapshots,
  updateStrangerFriendship,
  updateStrangerIdentityReveal,
} from '../core/stranger-thread-store.js';
import { listAliasAccounts } from '../core/alias-account-store.js';
import { recordUserAliasContactFact } from '../core/memory/memory-facts.js';
import { saveChatMessageFavorite } from '../core/message-favorites.js';
import { buildAnonymousContactEntry } from '../core/anonymous-contacts.js';
import { getAnonymousRuntimeCharacterById } from '../core/anonymous-character-pool.js';
import { loadChatPrefsWithExpiredStatus, resolveChatHeaderStatus } from '../core/status-ttl.js';
import {
  chatPrefsKey,
  getChatBlockedState,
  loadChatPrefsFresh,
  patchChatPrefs,
} from '../core/chat-block-state.js';
import { buildTimezoneHeaderHint } from '../core/chat/chat-timezone.js';
import { chatWithPreferredStream, getConfig, resolveGenerationMaxTokens } from '../core/api.js';
import {
  listApiSectionPresetOptions,
  resolveApiSectionPresetConfig,
  resolveChatMainApiOverride,
} from '../core/api-presets.js';
import { runNarrativeExpertConsultation } from '../core/expert-consultation.js';
import {
  deleteExpertConsultationPreset,
  listExpertConsultationPresets,
  saveExpertConsultationPreset,
} from '../core/expert-consultation-presets.js';
import {
  buildCallLineAudioId,
  createVoicePlaybackUrl,
  isCharacterVoiceTtsEnabled,
  isVoiceToolEnabled,
  isVoiceTtsSkipError,
  loadVoiceToolConfig,
  primeVoicePlayback,
  resolveVoiceToolConfigForProfile,
  synthesizeCallLineVoice,
} from '../core/voice-tools.js';
import {
  buildVoiceWorldBookPrompt,
  VOICE_WORLD_BOOK_SURFACES,
} from '../core/voice-worldbook.js';
import {
  beginForegroundMediaSession,
  takePlayableAudio,
  captureMediaGesture,
  playAudioWhenReady,
  takePendingMediaGesture,
} from '../core/media-playback.js';
import { stripLeakedReasoning } from '../core/narration-sanitize.js';
import { commandDuckVolume, commandRestoreVolume } from '../core/companion/music-player-bridge.js';
import { createAutomaticSoundSession } from '../core/sound-playback-session.js';
import {
  appendCharacterPhoneCallRecord,
  CHARACTER_PHONE_UPDATED_EVENT,
  loadCharacterPhone,
} from '../core/character-phone-store.js';
import {
  collectCharacterPhoneCurrentContext,
} from '../core/character-phone-current-context.js';
import { CHARACTER_LIVE_STATE_UPDATED_EVENT } from '../core/character-live-state.js';
import { runStreamerFanGroupRound } from '../core/streamer-chat.js';
import { markUserActivity } from '../core/user-activity.js';
import {
  markChatComposerActive,
  markChatComposerDraft,
  markChatComposerIdle,
  markChatComposerKeyboardDismissed,
  isChatComposerActive,
  messageRealCreatedAt,
  suppressIdleContinueForCurrentAnchor,
} from '../core/chat/idle-continue-reply.js';

const IOS_WEBKIT_CHAT = typeof navigator !== 'undefined'
  && (/iPad|iPhone|iPod/i.test(String(navigator.userAgent || ''))
    || (navigator.platform === 'MacIntel' && Number(navigator.maxTouchPoints || 0) > 1));
const CHAT_THREAD_RENDER_BATCH = 60;
const CHAT_THREAD_REFRESH_LIMIT = IOS_WEBKIT_CHAT ? CHAT_THREAD_RENDER_BATCH : 120;
const IOS_FOREGROUND_DB_REFRESH_MIN_HIDDEN_MS = 15_000;
const CHAT_VOICE_INPUT_NOTICE_KEY = 'chatVoiceInputNoticeSeen:v1';

function generationAiRoundIdFromTask(taskId = '') {
  const id = String(taskId || '').trim();
  return id ? `round_${id}` : '';
}

export function makeStableReplyGenerationIdentity(seed = {}) {
  const seededTaskId = String(seed?.generationTaskId || seed?.taskId || '').trim();
  const seededIdempotencyKey = String(
    seed?.generationIdempotencyKey || seed?.idempotencyKey || '',
  ).trim();
  const paired = seededTaskId && seededIdempotencyKey
    ? { taskId: seededTaskId, idempotencyKey: seededIdempotencyKey }
    : makeGenerationTaskIdentity();
  return {
    taskId: paired.taskId,
    idempotencyKey: paired.idempotencyKey,
    aiRoundId: String(seed?.generationAiRoundId || seed?.aiRoundId || '').trim()
      || generationAiRoundIdFromTask(paired.taskId),
  };
}

export function ensureMessageReplyGenerationIdentity(message) {
  if (!message || !isRealUserMessage(message)) return null;
  const identity = makeStableReplyGenerationIdentity(message.metadata || {});
  message.metadata = {
    ...(message.metadata || {}),
    generationTaskId: identity.taskId,
    generationIdempotencyKey: identity.idempotencyKey,
    generationAiRoundId: identity.aiRoundId,
    replyIntentState: String(message.metadata?.replyIntentState || '').trim() || 'queued',
    replyIntentQueuedAt: Number(message.metadata?.replyIntentQueuedAt || 0) || Date.now(),
    replyIntentAnchorMessageId: String(message.id || ''),
    replyIntentAnchorTimestamp: Number(message.timestamp || 0),
  };
  return identity;
}

export function buildReplyGenerationPayload(message) {
  const identity = ensureMessageReplyGenerationIdentity(message);
  return {
    generationTaskId: identity?.taskId || '',
    generationIdempotencyKey: identity?.idempotencyKey || '',
    generationAiRoundId: identity?.aiRoundId || '',
  };
}

function esc(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escAttr(value = '') {
  return esc(value).replace(/'/g, '&#39;');
}

function showVoiceInputNoticeIfNeeded(variant = '') {
  const isAnon = variant === 'anon';
  const sheetClass = isAnon ? 'modal-sheet anon-modal-sheet' : 'modal-sheet scrapbook-card';
  try {
    if (localStorage.getItem(CHAT_VOICE_INPUT_NOTICE_KEY) === '1') return Promise.resolve(true);
  } catch (_) {}
  const host = document.getElementById('modal-container');
  if (!host) {
    showToast('语音输入仍在实验中，浏览器兼容性可能不稳定');
    return Promise.resolve(true);
  }
  host.classList.add('active');
  host.innerHTML = `
    <div class="modal-overlay" data-voice-input-notice>
      <div class="${sheetClass}" role="dialog" aria-modal="true" aria-label="语音输入提示">
        <header class="modal-header">
          <h2>语音输入提示</h2>
          <button type="button" class="navbar-btn modal-close-btn" data-voice-notice-cancel aria-label="关闭">${icon('close')}</button>
        </header>
        <div class="modal-body">
          <p class="text-secondary" style="line-height:1.65;margin:0;">语音转文字仍是实验功能，网页浏览器可能因为权限、录音 API 或系统策略导致识别失败；后续会继续优化，APK / 原生环境通常会更稳定。</p>
          <p class="text-hint" style="line-height:1.55;margin:10px 0 0;">进入语音模式后，按住中间按钮说话，松开后转文字。</p>
        </div>
        <footer class="modal-footer">
          <button type="button" class="btn btn-outline" data-voice-notice-cancel>取消</button>
          <button type="button" class="btn btn-primary" data-voice-notice-ok>继续使用</button>
        </footer>
      </div>
    </div>
  `;
  return new Promise((resolve) => {
    const close = (ok) => {
      if (ok) {
        try { localStorage.setItem(CHAT_VOICE_INPUT_NOTICE_KEY, '1'); } catch (_) {}
      }
      host.innerHTML = '';
      host.classList.remove('active');
      resolve(!!ok);
    };
    host.querySelectorAll('[data-voice-notice-cancel]').forEach((btn) => btn.addEventListener('click', () => close(false)));
    host.querySelector('[data-voice-notice-ok]')?.addEventListener('click', () => close(true));
    host.querySelector('[data-voice-input-notice]')?.addEventListener('click', (event) => {
      if (event.target === event.currentTarget) close(false);
    });
  });
}

function normalizeMoney(value = '', fallback = '0.01') {
  const raw = String(value || '').replace(/[^\d.]/g, '').trim();
  const n = Number(raw || fallback);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n.toFixed(2);
}

function normalizeCount(value = '', fallback = 1) {
  const raw = String(value ?? '').trim();
  if (!raw) return String(fallback);
  const n = Math.round(Number(raw.replace(/\D/g, '')));
  if (!Number.isFinite(n) || n < 1) return String(fallback);
  return String(Math.min(100, n));
}

function isAbortLikeError(err) {
  return err?.name === 'AbortError' || /abort|aborted|取消|中止/i.test(String(err?.message || err || ''));
}

function withTimeout(promise, ms, controller, message = '请求超时') {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try { controller?.abort?.(); } catch (_) {}
      reject(new Error(message));
    }, Math.max(1000, Number(ms) || 1000));
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function splitCallLines(text = '') {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean);
}

function buildCallTtsSegments(text = '') {
  const clean = stripVideoStageDirections(text)
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  const units = splitCallLines(clean)
    .flatMap((line) => line.match(/[^。！？!?]+[。！？!?]?/g) || [line])
    .map((line) => line.trim())
    .filter(Boolean);
  if (!units.length) return [];
  const segments = [];
  let buf = '';
  for (const unit of units) {
    const separator = buf && !/[。！？!?，,；;：:]$/.test(buf) ? '，' : '';
    const candidate = buf ? `${buf}${separator}${unit}` : unit;
    if (buf && candidate.length > 220) {
      segments.push(buf);
      buf = unit;
    } else {
      buf = candidate;
    }
  }
  if (buf) segments.push(buf);
  return segments;
}

function stripVideoStageDirections(text = '') {
  return String(text || '')
    .replace(/[（(]([^（）()\n]{1,80})[）)]/g, (match, inner) => {
      return /^(?:laughs|chuckle|coughs|clear-throat|groans|breath|pant|inhale|exhale|gasps|sniffs|sighs|snorts|burps|lip-smacking|humming|hissing|emm|sneezes)$/i.test(String(inner || '').trim()) ? match : ' ';
    })
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .trim();
}

// 通话（语音/视频）文本清洗仍复用显式 think / analysis / 协议过滤；
// 外语通话必须保留开头英文，不能把 〔中文翻译〕 里的首个汉字误认成“中文正文起点”。
function stripLeakedReasoningForCall(raw = '', { preserveLeadingForeign = false } = {}) {
  const text = stripThinkingBlocks(String(raw || ''));
  return stripLeakedReasoning(text, {
    preserveLeadingLatin: preserveLeadingForeign,
  })
    .replace(/```(?:json|javascript|js|text)?\s*([\s\S]*?)```/gi, '$1')
    .trim();
}

async function resolveTitle(chat, user = null, characters = null) {
  if (!chat) return '会话';
  if (isCyberConfessionChat(chat)) {
    // 告解室房间名固定（赛博告解室 · 我的值班室 等），不随换人变
    return String(chat.groupSettings?.name || '赛博告解室').trim();
  }
  // 陌生/马甲窗：标题用前台身份，避免列表/刷新露出本体名
  if (isStrangerInterceptChat(chat)) {
    const partnerId = (chat.participants || []).find((p) => p && p !== 'user');
    if (partnerId) {
      const char = characters?.[partnerId]
        || await getRecord('characters', partnerId).catch(() => null);
      const visible = visibleIdentityFor(
        chat.metadata,
        principalKey('character', partnerId),
        char || {},
      );
      if (visible?.displayName) return visible.displayName;
    }
  }
  if (isAnonymousChat(chat)) {
    // 匿名群聊用群名（随机群匹配房 / 喵喵咪咪种子房 / 自建匿名群），不要被对方匿名 ID 顶掉
    if (chat.type === 'group') {
      return String(chat.groupSettings?.name || '匿名群').trim();
    }
    const counterpartId = chat.anonymousPrivateConfig?.counterpartActorId
      || (chat.participants || []).find((p) => p && p !== 'user');
    const spaceProfile = user?.id ? await loadAnonymousSpaceUserProfile(user.id) : null;
    const profile = getAnonymousDisplayProfile(chat, counterpartId, {
      currentUserName: getUserDisplayName(user),
      spaceProfile,
    });
    return profile?.anonymousId || '匿名会话';
  }
  if (isBackstageChat(chat)) return String(chat.groupSettings?.name || '').trim() || '秘密基地';
  if (chat.type === 'group') return String(chat.groupSettings?.name || '').trim() || '群聊';
  const roleIds = (chat.participants || []).filter((id) => id && id !== 'user');
  if (!(chat.participants || []).includes('user') && roleIds.length >= 2) {
    const rows = roleIds.slice(0, 2).map((id) => characters?.[id] || null);
    const names = roleIds.slice(0, 2).map((id, index) => (
      String(rows[index]?.realName || rows[index]?.name || rows[index]?.customNickname || id).trim()
    ));
    return `${names.join(' ↔ ')} · 角色私聊`;
  }
  const partnerId = (chat.participants || []).find((p) => p && p !== 'user');
  if (!partnerId) return '私聊';
  const char = characters?.[partnerId]
    || await getRecord('characters', partnerId).catch(() => null);
  return resolveActorDisplayLabel(char?.name || char?.customNickname || partnerId, {
    user,
    characters: char ? { [partnerId]: char } : {},
    fallback: '私聊',
  });
}

async function loadCharacterMap(chat, options = {}) {
  const map = {};
  const ids = (chat?.participants || []).filter((id) => id && id !== 'user');
  const scopedUserId = String(options.userId || '').trim();
  // AI 与 UI 共用同一份“当前档位有效角色卡”。直接读 characters 表只会拿到公共模板，
  // 既漏掉 user.characterOverrides，又会让后续上下文把公共人设当成第二份继续注入。
  const lookupIdsByParticipant = ids.map((id) => participantIdentityLookupIds(id));
  const requestedCharacterIds = [...new Set(lookupIdsByParticipant.flat())];
  const storedCharacterRows = await getCharactersByIds(requestedCharacterIds, {
    userId: scopedUserId,
    user: options.user,
  }).catch(() => []);
  const storedById = new Map(requestedCharacterIds.map((id, index) => [id, storedCharacterRows[index] || null]));
  await Promise.all(ids.map(async (id, index) => {
    const lookupIds = lookupIdsByParticipant[index];
    const stored = lookupIds.map((lookupId) => storedById.get(lookupId)).find(Boolean) || null;
    if (stored) {
      map[id] = { ...stored, id };
      return;
    }
    const { getLightweightNpc } = await import('../core/lightweight-npc.js');
    let lightweight = null;
    for (const lookupId of lookupIds) {
      lightweight = await getLightweightNpc(lookupId, scopedUserId).catch(() => null);
      if (lightweight) break;
    }
    if (lightweight) {
      map[id] = { ...lightweight, id };
      return;
    }
    if (isAnonymousChat(chat)) {
      const runtimeOnly = await getAnonymousRuntimeCharacterById(id).catch(() => null);
      if (runtimeOnly) map[id] = runtimeOnly;
    }
  }));
  // 关系网 NPC 使用 canonical id 参与聊天时，也要补回它自己的稳定身份与人设。
  const unresolvedRelationshipIds = ids.filter((id) => !map[id]);
  if (unresolvedRelationshipIds.length) {
    try {
      const { loadRelationshipNetwork } = await import('../core/relationship-network.js');
      const network = await loadRelationshipNetwork(scopedUserId);
      const npcById = new Map((network?.npcs || []).map((npc) => [String(npc?.id || '').trim(), npc]));
      for (const id of unresolvedRelationshipIds) {
        const npc = participantIdentityLookupIds(id)
          .map((lookupId) => npcById.get(lookupId))
          .find(Boolean);
        if (!npc) continue;
        map[id] = {
          ...npc,
          id,
          name: String(npc.name || id).trim(),
          realName: String(npc.realName || npc.name || id).trim(),
          metadata: { ...(npc.metadata || {}), isRelationshipNetworkNpc: true },
        };
      }
    } catch (_) { /* 关系网读取失败时继续走原有联系人回填 */ }
  }
  // 手机视角：轻量 NPC 不在 characters 表，从手机通讯录补人设胶囊，推进时才有对方口吻。
  const phoneOwnerId = String(options.phoneOwnerId || chat?.metadata?.phoneOwnerId || chat?.metadata?.focalActorId || '').trim();
  const userId = String(options.userId || '').trim();
  if (phoneOwnerId && userId) {
    try {
      const { loadCharacterPhoneContacts, buildPhoneLightContactCharacter, findPhoneContactByActorName, resolvePhoneContactAvatar } = await import('../core/character-phone-contacts.js');
      const phoneContacts = await loadCharacterPhoneContacts(userId, phoneOwnerId).catch(() => ({ contacts: [] }));
      for (const contact of phoneContacts.contacts || []) {
        const canonicalId = String(contact?.linkedCharacterId || contact?.linkedActorId || '').trim();
        const contactId = String(contact?.id || '').trim();
        const matchingIds = ids.filter((actorId) => {
          const lookupIds = participantIdentityLookupIds(actorId);
          return (canonicalId && lookupIds.includes(canonicalId))
            || (contactId && lookupIds.includes(contactId));
        });
        if (!matchingIds.length) continue;
        const capsule = contact.personaCapsule || {};
        const nickname = String(contact.nickname || '').trim();
        const canonicalRow = canonicalId
          ? (map[canonicalId] || matchingIds.map((actorId) => map[actorId]).find(Boolean) || null)
          : null;
        for (const actorId of matchingIds) {
          const existingRow = map[actorId] || null;
          // 已链接主角色继续以角色卡为准；关系网/轻量 NPC 则让用户编辑的联系人胶囊覆盖
          // AI 自动铸造的简略 personality，避免同名气泡读到另一份人设。
          const isLinkedMainCharacter = (
            actorId === String(contact?.linkedCharacterId || '').trim()
            && existingRow
            && existingRow?._lightweightNpc !== true
            && existingRow?.metadata?.isRelationshipNetworkNpc !== true
          );
          if (isLinkedMainCharacter) continue;
          const displayName = resolvePhoneSocialActorDisplayName(
            contact.name,
            canonicalRow,
            contact.nickname,
          ) || actorId;
          const contactPersonality = [
            capsule.summary,
            capsule.relationship,
            ...(capsule.traits || []),
          ].filter(Boolean).join('；');
          map[actorId] = {
            ...(existingRow || {}),
            id: actorId,
            name: displayName,
            customNickname: nickname && nickname !== displayName ? nickname : '',
            realName: resolvePhoneSocialActorDisplayName(contact.name, canonicalRow),
            aliases: nickname && nickname !== displayName ? [nickname] : [],
            avatar: canonicalRow?.avatar
              || existingRow?.avatar
              || resolvePhoneContactAvatar(contact, map)
              || contact.avatar
              || contact.avatarUrl
              || '',
            personality: contactPersonality || existingRow?.personality || '',
            speechStyle: capsule.speechStyle || existingRow?.speechStyle || '',
            notes: [contact.note, capsule.boundary].filter(Boolean).join('；') || existingRow?.notes || '',
            metadata: {
              ...(existingRow?.metadata || {}),
              isPhoneLightContact: true,
              ownerId: phoneOwnerId,
              phoneContactId: contact.id,
            },
            _phoneLightContact: true,
          };
        }
      }
      // 历史气泡仍可能挂已摘掉的 lightnpc_*：从会话别名 / 关系网 / 同名通讯录回填
      const storedAliases = (
        chat?.metadata?.phoneLightNpcAliases
        && typeof chat.metadata.phoneLightNpcAliases === 'object'
      ) ? chat.metadata.phoneLightNpcAliases : {};
      for (const [npcId, row] of Object.entries(storedAliases)) {
        if (!npcId) continue;
        const contact = phoneContacts.contacts?.find((c) => (
          c?.id === row?.phoneContactId
          || c?.linkedCharacterId === row?.linkedCharacterId
          || c?.linkedActorId === row?.linkedActorId
        )) || findPhoneContactByActorName(phoneContacts.contacts || [], row?.name || row?.realName || '');
        const targetIds = [...new Set([
          npcId,
          ...ids.filter((actorId) => participantIdentityLookupIds(actorId).includes(npcId)),
        ])];
        if (!contact && targetIds.every((actorId) => map[actorId])) continue;
        const fromContact = contact ? buildPhoneLightContactCharacter(contact, phoneOwnerId) : null;
        const displayName = resolvePhoneSocialActorDisplayName(row, contact) || '联系人';
        const canonicalId = String(
          contact?.linkedCharacterId
          || contact?.linkedActorId
          || row?.linkedCharacterId
          || row?.linkedActorId
          || '',
        ).trim();
        const canonicalRow = canonicalId ? map[canonicalId] : null;
        for (const targetId of targetIds) {
          map[targetId] = {
            ...(map[targetId] || {}),
            ...(fromContact || {}),
            id: targetId,
            name: displayName,
            realName: String(row?.realName || contact?.name || displayName).trim(),
            customNickname: String(row?.customNickname || contact?.nickname || '').trim(),
            avatar: canonicalRow?.avatar
              || resolvePhoneContactAvatar(contact, map)
              || row?.avatar
              || fromContact?.avatar
              || '',
            metadata: {
              ...(fromContact?.metadata || {}),
              isLightweightNpc: true,
              isPhoneLightContactAlias: true,
              phoneContactId: contact?.id || row?.phoneContactId || '',
            },
          };
        }
      }
    } catch (_) { /* ignore */ }
  }
  // 同时保留 lightnpc_ 新键和旧版无前缀键：历史气泡可能仍引用旧 senderId，
  // 后续 AI 上下文、回复引用和头像解析都应落到同一份身份资料。
  for (const id of ids) {
    const lookupIds = participantIdentityLookupIds(id);
    const row = lookupIds.map((lookupId) => map[lookupId]).find(Boolean);
    if (!row) continue;
    for (const lookupId of lookupIds) {
      if (!map[lookupId]) map[lookupId] = { ...row, id: lookupId };
    }
  }
  return map;
}

/** 首帧骨架：数据到达前先画出会话页占位，避免路由「加载中」出现 */
function renderThreadSkeleton(container) {
  const anon = container.classList.contains('chat-thread-page--anon');
  container.innerHTML = `
    <div class="page-skeleton${anon ? ' page-skeleton--anon' : ''}" aria-hidden="true">
      <div class="sk-row">
        <span class="sk-block sk-circle"></span>
        <span class="sk-block sk-bar" style="width:38%"></span>
      </div>
      <div class="sk-bubble-col">
        <span class="sk-block sk-bubble" style="width:56%"></span>
        <span class="sk-block sk-bubble sk-bubble--right" style="width:44%"></span>
        <span class="sk-block sk-bubble" style="width:62%"></span>
        <span class="sk-block sk-bubble sk-bubble--right" style="width:36%"></span>
      </div>
    </div>`;
}

function isCompletedGeneratedImage(message) {
  if (message?.type !== 'image' || message?.metadata?.generatingImage || message?.metadata?.generationFailed) return false;
  const src = String(message?.content || message?.metadata?.url || '').trim();
  return !!src && (/^data:image\//i.test(src) || /^https?:\/\//i.test(src));
}

function mergeImageStateMonotonically(current, incoming) {
  if (!current) return incoming;
  if (!incoming) return current;
  if (isCompletedGeneratedImage(current) && !isCompletedGeneratedImage(incoming)) return current;
  const currentFailed = current?.type === 'image' && current?.metadata?.generationFailed === true;
  const incomingPending = incoming?.metadata?.deferredImage || incoming?.metadata?.generatingImage;
  if (currentFailed && incomingPending) return current;
  return incoming;
}

export default async function render(container, params = {}) {
  const perfStartedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
  let perfLastAt = perfStartedAt;
  const perfPhases = {};
  const perfTasks = {};
  const trackPerfTask = (name, promise) => {
    const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
    return Promise.resolve(promise).finally(() => {
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      perfTasks[name] = Math.max(0, Math.round(now - startedAt));
    });
  };
  const markPerfPhase = (name) => {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    perfPhases[name] = Math.max(0, Math.round(now - perfLastAt));
    perfLastAt = now;
  };
  const chatId = String(params.chatId || '').trim();
  const isolateBeautifyPreview = String(params.beautifyPreview || '').trim() === '1';
  // 进入会话就立即清未读，不等角色卡、世界书和气泡首屏全部完成。
  // 这样返回列表时红点已经落库消失；工作室预览不改真实会话状态。
  if (chatId && !isolateBeautifyPreview) void clearChatUnread(chatId).catch(() => {});
  const listThreadMessages = () => listMessagesForChat(chatId, CHAT_THREAD_REFRESH_LIMIT, {
    deferHeavyImages: true,
  });
  let offlineChatId = String(params.offlineChatId || '').trim();
  // 「他的手机」入口：以手机主人视角看这扇窗（主人消息靠右）。
  // 只影响气泡视角与旁观文案，推进/重roll/剧情等操作完全复用本页现有链路。
  const phoneViewerId = String(params.viewer || '').trim();
  const fromCharacterPhone = String(params.from || '').trim() === 'phone' && !!phoneViewerId;
  renderThreadSkeleton(container);
  const prefetchedDataPromise = trackPerfTask(
    'prefetchSnapshot',
    consumeRoutePrefetchData('chat/thread', { chatId }) || Promise.resolve(null),
  ).then((snapshot) => {
    if (snapshot?.prefetchTasks && typeof snapshot.prefetchTasks === 'object') {
      for (const [name, durationMs] of Object.entries(snapshot.prefetchTasks)) {
        perfTasks[`prefetch.${name}`] = Number(durationMs) || 0;
      }
    }
    return snapshot;
  });
  // 首屏消息和用户/会话/角色信息并行拉取，避免先画出「加载中/还没有消息」占位再跳到真实内容。
  const initialMessagesPromise = chatId
    ? prefetchedDataPromise.then((snapshot) => (
      snapshot?.messagesPage
      || listMessagesPageForChat(chatId, { limit: CHAT_THREAD_RENDER_BATCH, deferHeavyImages: true }).catch(() => null)
    ))
    : Promise.resolve(null);
  const initialUserPromise = trackPerfTask('user', prefetchedDataPromise.then((snapshot) => snapshot?.user || ensureDefaultUser()));
  const initialChatPromise = trackPerfTask('chat', prefetchedDataPromise.then((snapshot) => snapshot?.chat || (chatId ? getChat(chatId) : null)));
  const initialChatPrefsPromise = trackPerfTask('chatPrefs', prefetchedDataPromise.then((snapshot) => (
    snapshot?.chatPrefs || loadChatPrefsWithExpiredStatus(chatId)
  )));
  const initialTimezonePromise = trackPerfTask('timezone', initialUserPromise.then((row) => (
    getUserTimezone(row.id).catch(() => String(row?.timezone || '').trim())
  )));
  const [initialUser, , loadedChat, offlineSession, initialTimezone] = await Promise.all([
    initialUserPromise,
    trackPerfTask('displayRegex', primeDisplayRegex()),
    initialChatPromise,
    offlineChatId ? loadOfflineSession(offlineChatId).catch(() => null) : Promise.resolve(null),
    initialTimezonePromise,
  ]);
  markPerfPhase('userChat');
  // 路由可能在首批 IndexedDB 查询完成前已经离开；不要继续给已销毁页面注册全局监听。
  if (!container.isConnected) return;
  if (offlineSession?.status !== 'active' || !offlineSession.phoneSideTrip) {
    offlineChatId = '';
  }
  async function reconcileOfflinePresenceBar() {
    const targetId = String(offlineChatId || '').trim();
    if (!targetId) return false;
    let latest;
    try {
      latest = await loadOfflineSession(targetId);
    } catch (_) {
      return true;
    }
    if (latest?.status === 'active' && latest.phoneSideTrip) return true;
    if (offlineChatId !== targetId) return false;
    offlineChatId = '';
    container.querySelector('[data-return-offline]')?.remove();
    return false;
  }
  let user = initialUser;
  let currentUserName = getUserDisplayName(user);
  // 等档位世界时钟的权威时区进入内存后再画首屏顶栏，避免先按 users.timezone
  // 或设备时区闪出一套时间，AI 回合又按 timeSchedule 时区使用另一套时间。
  let userTimezoneForChat = initialTimezone || String(user?.timezone || '').trim();
  let chat = loadedChat;
  if (!chat) {
    container.className = 'page scrapbook-page';
    container.innerHTML = `<div class="chat-empty scrapbook-empty"><div class="chat-empty-text">会话不存在</div></div>`;
    return;
  }
  if (!chatBelongsToUserSlot(chat, user.id, { allowLegacyUnscoped: false })) {
    showToast('该会话属于另一个档位，已返回当前档位的聊天列表');
    navigate('chat', {}, true);
    return;
  }
  // 工作室借真实会话渲染 DOM。会话 CSS 必须参与预览：实装时它本来就位于
  // 全局美化之后；若预览将其排除，装饰伪元素的尺寸与定位会在发布后突然变化。
  // 会话壁纸图片仍单独隔离，避免旧素材遮住正在编辑的全局方案。
  let appearancePrefs = null;
  const sessionAppearanceIsActive = (chatRow = chat) => (
    isolateBeautifyPreview
    || isChatSessionAppearanceActive(
      chatRow,
      appearancePrefs?.chatSessionAppearanceGeneration,
    )
  );
  const resolveThreadAppearance = (chatRow = chat) => (
    sessionAppearanceIsActive(chatRow) ? getChatAppearance(chatRow) : getChatAppearance(null)
  );
  const resolveStoredThreadSessionWallpaper = (chatRow = chat) => (
    sessionAppearanceIsActive(chatRow)
      ? String(chatRow?.groupSettings?.wallpaper || '').trim()
      : ''
  );
  const resolveThreadSessionWallpaper = (chatRow = chat) => (
    isolateBeautifyPreview ? '' : resolveStoredThreadSessionWallpaper(chatRow)
  );
  const shellFrom = String(params.from || '').trim();
  const anonymousChat = isAnonymousChat(chat);
  const streamerSourced = isStreamerSourcedChat(chat);
  if (!anonymousChat && shellFrom === 'anon') {
    navigate('chat/thread', { chatId }, true);
    return;
  }
  const enteredViaValidShell = shellFrom === 'anon' || (streamerSourced && shellFrom === 'streamer');
  if (anonymousChat && !enteredViaValidShell) {
    if (streamerSourced) {
      showToast('请从主播空间进入这个聊天');
      navigate('anon/streamer/space', chat.metadata?.streamerChannelId ? { channelId: chat.metadata.streamerChannelId } : {}, true);
    } else {
      showToast('匿名会话请从匿名聊天室进入');
      navigate('chat', {}, true);
    }
    return;
  }

  let messages = [];
  let hasOlderMessages = false;
  let hasNewerMessages = false;
  let messagesLoading = true;
  let olderMessagesLoading = false;
  let visibleMessageLimit = CHAT_THREAD_RENDER_BATCH;
  let preserveScrollAfterOlderLoad = false;
  // 进页后持续钉底，直到用户主动上滑；避免表情/贴纸二次渲染把视图留在「加载更早」按钮处。
  let holdBottomUntilSettled = true;
  let suppressThreadScrollFlash = true;
  // 推进后键盘收起 / visualViewport 重排会短暂把 scrollTop 顶偏，短窗口内不要当成「用户上滑」。
  let streamPinGuardUntil = 0;
  let streamPinTimers = [];
  let messageViewportUserRevision = 0;
  let stableHistoryViewportState = null;
  let historyViewportCaptureTimer = 0;
  let composerFocused = false;
  let composerBlurTimer = 0;
  let composerCloudResyncTimer = 0;
  let composerDockRepairRaf = 0;
  let composerDockRepairTimers = [];
  let composerViewportRestoreRaf = 0;
  let composerViewportRestoreUntil = 0;
  let scrollToBottomRaf = 0;
  let messageRenderSeq = 0;
  let lastPaintSnapshot = null;
  let pendingMessagesRefreshOnResume = false;
  let userScrollingMessagesUntil = 0;
  let lazyMediaObserver = null;
  let bubbleRevealTimer = 0;
  let bubbleRevealPendingNodes = [];
  let avatarSingleClickTimer = 0;
  let pageDisposed = false;
  const pageLifetimeCleanups = [];
  const addPageLifetimeCleanup = (cleanup) => {
    if (typeof cleanup !== 'function') return;
    if (pageDisposed) {
      try { cleanup(); } catch (_) {}
      return;
    }
    pageLifetimeCleanups.push(cleanup);
  };
  const addPageLifetimeListener = (target, type, handler, options) => {
    target?.addEventListener?.(type, handler, options);
    addPageLifetimeCleanup(() => target?.removeEventListener?.(type, handler, options));
  };
  addPageLifetimeCleanup(() => {
    if (composerBlurTimer) window.clearTimeout(composerBlurTimer);
    composerBlurTimer = 0;
    if (composerCloudResyncTimer) window.clearTimeout(composerCloudResyncTimer);
    composerCloudResyncTimer = 0;
    if (historyViewportCaptureTimer) window.clearTimeout(historyViewportCaptureTimer);
    historyViewportCaptureTimer = 0;
    if (composerDockRepairRaf) cancelAnimationFrame(composerDockRepairRaf);
    composerDockRepairRaf = 0;
    composerDockRepairTimers.forEach((timer) => window.clearTimeout(timer));
    composerDockRepairTimers = [];
    if (composerViewportRestoreRaf) cancelAnimationFrame(composerViewportRestoreRaf);
    composerViewportRestoreRaf = 0;
    if (avatarSingleClickTimer) window.clearTimeout(avatarSingleClickTimer);
    avatarSingleClickTimer = 0;
    // 若恰好在避让输入后离开会话，不能随页面定时器一起丢掉云端回复恢复动作。
    if (composerCancelledCloudGeneration) {
      import('../core/background-scheduler.js')
        .then((mod) => mod.resyncAllChatSchedules?.(user.id))
        .catch(() => {});
    }
  });
  const onRouteDisposed = (event) => {
    if (event?.detail?.container !== container || pageDisposed) return;
    pageDisposed = true;
    while (pageLifetimeCleanups.length) {
      try { pageLifetimeCleanups.pop()(); } catch (_) {}
    }
    messages = [];
    try { lazyMediaObserver?.disconnect(); } catch (_) {}
    lazyMediaObserver = null;
  };
  window.addEventListener('marshmallow-route-disposed', onRouteDisposed);
  addPageLifetimeCleanup(() => {
    window.removeEventListener('marshmallow-route-disposed', onRouteDisposed);
  });
  const translationRepairInflight = new Set();
  // 补译只改 metadata.translation，当前气泡会在写库后立即局部更新。
  // 记录本页主动写入的消息，避免通用 store 广播在 220ms 后又整表重绘一次。
  const localTranslationWriteIds = new Map();
  const markLocalTranslationWrite = (messageId = '') => {
    const id = String(messageId || '').trim();
    if (id) localTranslationWriteIds.set(id, Date.now() + 10_000);
  };
  const consumeLocalTranslationWrite = (messageId = '') => {
    const id = String(messageId || '').trim();
    if (!id) return false;
    const expiresAt = Number(localTranslationWriteIds.get(id) || 0);
    localTranslationWriteIds.delete(id);
    return expiresAt > Date.now();
  };
  // IndexedDB 回读可能在一次本地发送/编辑/删除之前启动、之后才返回。
  // 长会话或大图片会放大这个窗口；若直接用旧页覆盖 messages，刚操作的气泡就会
  // 短暂消失/复活。记录短时本地变更，让旧回读只能前进、不能回滚画面。
  const localMessageMutations = new Map();
  let localMessageMutationRevision = 0;
  const pruneLocalMessageMutations = () => {
    const now = Date.now();
    for (const [id, mutation] of localMessageMutations) {
      if (Number(mutation?.expiresAt || 0) <= now) localMessageMutations.delete(id);
    }
  };
  const markLocalMessageMutation = (messageId, kind, message = null) => {
    const id = String(messageId || message?.id || '').trim();
    if (!id) return 0;
    pruneLocalMessageMutations();
    const revision = ++localMessageMutationRevision;
    localMessageMutations.set(id, {
      kind,
      message,
      revision,
      pending: true,
      expiresAt: Date.now() + 10_000,
    });
    return revision;
  };
  const settleLocalMessageMutation = (messageId, revision) => {
    const id = String(messageId || '').trim();
    const mutation = localMessageMutations.get(id);
    if (!mutation || Number(mutation.revision || 0) !== Number(revision || 0)) return;
    mutation.pending = false;
  };
  const hasLocalMessageMutation = (messageId = '') => {
    pruneLocalMessageMutations();
    return localMessageMutations.has(String(messageId || '').trim());
  };
  const overlayLocalMessageMutations = (rows = [], refreshStartedAtRevision = 0, pendingAtRefreshStart = new Set()) => {
    pruneLocalMessageMutations();
    const byId = new Map((Array.isArray(rows) ? rows : [])
      .filter(Boolean)
      .map((message) => [String(message.id || ''), message]));
    for (const [id, mutation] of localMessageMutations) {
      // 这次 DB 读取在本地操作之后才启动时，库里的同 id 记录已经是权威值；
      // 仅补回分页边界外的本地新增。读取更早启动时则必须完整覆盖旧快照。
      const staleRead = Number(mutation.revision || 0) > Number(refreshStartedAtRevision || 0)
        || pendingAtRefreshStart.has(id);
      if (mutation.kind === 'delete') {
        if (staleRead) byId.delete(id);
        continue;
      }
      if (mutation.message && (staleRead || !byId.has(id))) byId.set(id, mutation.message);
    }
    return [...byId.values()].sort(compareChatMessageChronology);
  };
  // 气泡「翻译」展开态只活在 DOM 上；后台写库 / 外观刷新会整表重绘并默认收起。
  // 会话内记住已展开的消息 id，不切出本页时重绘后恢复（主动点收起则忘掉）。
  const expandedTranslationMsgIds = new Set();
  const escapeMsgIdForSelector = (id = '') => (
    window.CSS?.escape
      ? window.CSS.escape(String(id || ''))
      : String(id || '').replace(/["\\\]]/g, '\\$&')
  );
  const restoreExpandedTranslations = (root) => {
    if (!root || !expandedTranslationMsgIds.size) return;
    for (const id of expandedTranslationMsgIds) {
      const safeId = escapeMsgIdForSelector(id);
      if (!safeId) continue;
      const row = root.querySelector(`[data-msg-id="${safeId}"]`);
      if (!row) continue;
      const btn = row.querySelector('.chat-bubble-translate-btn[data-translation-toggle]')
        || row.querySelector('[data-translation-toggle]');
      const wrap = btn?.nextElementSibling;
      if (!btn || !wrap) continue;
      if (!(wrap.classList.contains('chat-bubble-translation') || wrap.classList.contains('narration-translation'))) {
        continue;
      }
      wrap.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
    }
  };
  const patchMessageTranslationDom = (messageId = '', translation = '') => {
    const safeId = escapeMsgIdForSelector(messageId);
    const text = String(translation || '').trim();
    if (!safeId || !text) return;
    const row = container.querySelector(`[data-msg-id="${safeId}"]`);
    row?.querySelectorAll?.('.chat-bubble-translation-text, .voice-msg-translation')
      .forEach((node) => { node.textContent = text; });
  };
  const isGroup = chat.type === 'group';
  const userAbsentGroup = isGroup && !isUserPresentInChat(chat);
  const strangerChat = isStrangerInterceptChat(chat);
  if (strangerChat) {
    chat = await refreshStrangerThreadAccountSnapshots(chat);
    chat = await ensureStrangerChatAppearanceInherited(chat);
  }
  const messageUiLabelOptions = () => ({
    userName: currentUserName,
    isGroup,
    anonymous: anonymousChat,
  });
  const normalizeMsgForUi = (msg) => normalizeMessageForUi(msg, messageUiLabelOptions());
  // 手机视角下「对方」要相对手机主人算，否则角色私聊会把主人自己当成 partner/标题。
  const partnerId = !isGroup
    ? (chat.participants || []).find((p) => p && p !== 'user' && (!fromCharacterPhone || p !== phoneViewerId))
    : null;
  const initialOfflineParticipantIds = offlineChatId
    ? getActiveOfflineParticipantIds(offlineSession).map((id) => String(id || '').trim())
    : [];
  const canOfferOfflinePhoneTakeover = !!offlineChatId
    && !!partnerId
    && !initialOfflineParticipantIds.includes(String(partnerId || '').trim());
  let [characters, initialChatPrefs] = await Promise.all([
    trackPerfTask('characters', loadCharacterMap(chat, {
      userId: user.id,
      user,
      phoneOwnerId: fromCharacterPhone ? phoneViewerId : '',
    })),
    initialChatPrefsPromise,
  ]);
  let partner = partnerId ? characters[partnerId] || null : null;
  let title = await trackPerfTask('title', resolveTitle(chat, user, characters));
  markPerfPhase('charactersPrefs');
  if (fromCharacterPhone && !isGroup && !partner && partnerId && characters[partnerId]) {
    partner = characters[partnerId];
  }
  if (fromCharacterPhone && isGroup) {
    try {
      const {
        reconcilePhoneGroupDuplicateLightNpcs,
        hydratePhoneGroupLightNpcDisplayAliases,
      } = await import('../core/character-phone-messages.js');
      const reconciled = await reconcilePhoneGroupDuplicateLightNpcs(chat, {
        userId: user.id,
        ownerId: phoneViewerId,
      });
      if (reconciled?.chat) chat = reconciled.chat;
      const hydrated = await hydratePhoneGroupLightNpcDisplayAliases(chat, {
        userId: user.id,
        ownerId: phoneViewerId,
      });
      if (hydrated?.chat) chat = hydrated.chat;
      if (reconciled?.removed?.length || Object.keys(hydrated?.aliases || {}).length || Object.keys(reconciled?.aliases || {}).length) {
        characters = await loadCharacterMap(chat, {
          userId: user.id,
          user,
          phoneOwnerId: phoneViewerId,
        });
        Object.assign(characters, reconciled?.aliases || {}, hydrated?.aliases || {});
      }
    } catch (_) { /* 历史成员收敛失败不挡进页 */ }
  }
  let replyTarget = null;
  let toolsOpen = false;
  let aliasPickerOpen = false;
  let aliasPickerAccounts = { user: [], character: [] };
  let sendAsCharacterId = '';
  let phoneProxyMode = false;
  let selectionMode = false;
  let selectionPurpose = ''; // '' | 'capture' | 'guidance'
  let pendingSearchJumpId = '';
  const groupInviteActionInflight = new Set();
  let composerDraftText = String(params.draft || '').trim().slice(0, 1200);
  const pendingShoppingShareId = String(params.shoppingShare || '').trim().slice(0, 120);
  let pendingShoppingShareHandled = false;
  let composerDraftEditRevision = 0;
  let composerMentionSuggestions = [];
  let composerMentionRange = null;
  let composerMentionActiveIndex = 0;
  let composerMentionDrafts = [];
  let composerStickerSuggestions = [];
  let composerStickerSuggestionTimer = 0;
  let composerStickerSuggestionSeq = 0;
  let textMessagePrepareInFlight = false;
  // 真人感接话/追发：输入中（含语音条、文字图弹层、IME 拼写）不抢话；
  // 主输入框清空后再等一小会儿才放行，避免 APK 重绘瞬间读空误触发。
  // 静默窗口默认 2.5 秒；用户在真人感设置里开了「自定义无输入等待」后按其秒数。
  let composerImeComposing = false;
  let composerEmptySince = 0;
  let lastComposerActivityAt = 0;
  let composerKeyboardWasVisible = false;
  let chatError = null;
  const selectedSet = new Set();
  const selectionBoundNodes = new WeakSet();
  let isStreaming = false;
  const unsafeInterruptedGenerationTaskIds = new Set();
  let streamingPreviewFingerprint = '';
  let streamingPreviewRawText = '';
  let streamingPreviewTimer = 0;
  let streamingPreviewPaintedThisTurn = false;
  let streamingPreviewFirstPaintAt = 0;
  // 正式消息一耐久落库就会由事件提前绘制。它与 SSE 预览必须分开记录：
  // 前者可阻止 finally 再次整页刷新并打断逐条 reveal，后者只代表临时预览出现过。
  let persistedReplyPaintedThisTurn = false;
  let persistedReplyFirstPaintAt = 0;
  const persistedReplyPaintedIdsThisTurn = new Set();
  // 本轮只要进过后台，回前台后就不再把积压的 SSE 分片重演一遍。
  // 仍保留自然的“正在输入…”，等正文可落库时一次性换成完整气泡。
  let generationWasHiddenThisTurn = false;
  let headlessReplyVisible = false;
  // 后台占用开始时列表末尾的消息 id：本轮气泡一旦画出来（出现更新的角色消息），
  // 「正在输入」就该消失，不等 persist 收尾（总结/旁路/排期）跑完才清。
  let headlessBaselineMsgId = '';
  let headlessReplyRecoverySeq = 0;
  // 云端中继「正在输入」轮询的可见状态；提前声明避免 refreshMessages 读到 TDZ。
  let cloudTypingVisible = false;
  // 消息刚落地后的云端占位抑制窗：本地已生成、云端计划未对账时不再补「正在输入」。
  let cloudTypingHoldUntil = 0;
  let cloudTypingRefreshSeq = 0;
  let composerCloudGuardAt = 0;
  let composerCancelledCloudGeneration = false;
  // runAiReply / 粉丝群推进 / 手动停止都会短暂持有最终绘制权。这里必须计数，不能用
  // 一个共享 boolean：停止流程与原回合的 finally 会重叠，后结束的一方若直接写 false，
  // 会让 DB 广播在另一方仍收尾时抢进来重画整页。
  let localRoundPaintLeaseCount = 0;
  let localRoundPaintEpoch = 0;
  let pendingLocalPaintDbRefresh = false;
  function beginLocalRoundPaint() {
    localRoundPaintLeaseCount += 1;
    localRoundPaintEpoch += 1;
    return localRoundPaintEpoch;
  }
  function endLocalRoundPaint() {
    localRoundPaintLeaseCount = Math.max(0, localRoundPaintLeaseCount - 1);
    if (localRoundPaintLeaseCount || !pendingLocalPaintDbRefresh) return;
    pendingLocalPaintDbRefresh = false;
    const refreshAfterReveal = () => {
      if (localRoundOwnsPaint() || !container.isConnected || container.hidden || document.hidden) {
        pendingMessagesRefreshOnResume = true;
        return;
      }
      if (isBubbleRevealActive()) {
        messagesStoreRefreshTimer = window.setTimeout(refreshAfterReveal, BUBBLE_REVEAL_STEP_MS + 40);
        return;
      }
      void refreshThreadMessagesAfterForeground();
    };
    Promise.resolve().then(refreshAfterReveal);
  }
  function localRoundOwnsPaint() {
    return localRoundPaintLeaseCount > 0;
  }
  function isCurrentLocalRoundPaint(lease) {
    return lease === localRoundPaintEpoch;
  }
  let phoneCinematicRunning = false;
  let sideTripCatchChecking = false;
  let rerollInFlight = false;
  // 重 roll 的目标轮在数据库删除前先退出当前画面。单独维护隐藏键，避免慢速
  // 回读或 store 广播把已经乐观隐藏的旧气泡重新画回来。
  const rerollUiHiddenMessageIds = new Set();
  const rerollUiHiddenRoundIds = new Set();
  let abortController = null;
  let stopGestureHandledAt = 0;
  let stopGenerationPromise = null;
  const manualGenerationGate = createGenerationIntentGate();
  const controlGestureLatch = createControlGestureLatch();
  /** Count mid-stream drops in this thread; reset on any non-stream-error outcome. */
  let consecutiveStreamErrors = 0;
  let generationWatchdog = null;
  let generationLongWaitTimer = null;
  let generationStartedAt = 0;
  let generationLastProgressAt = 0;
  /** Stall window: no stream progress for this long (foreground) counts as stuck. */
  const GENERATION_WATCHDOG_MS = 120000;
  /** Long generations are not auto-aborted; after five minutes, suggest the existing stop action. */
  const GENERATION_LONG_WAIT_REMINDER_MS = 5 * 60000;
  /** Requests without progress signals get until this hard cap (api.js total timeout is 15 min). */
  const GENERATION_HARD_CAP_MS = 16 * 60000;
  let contextPrewarmRevision = 0;
  let contextPrewarmTimer = 0;
  let contextPrewarmInFlightKey = '';
  const contextPrewarmPrefix = `${chatId}|`;

  function currentAdvanceContextPrewarmKey() {
    const last = messages[messages.length - 1] || null;
    return `${contextPrewarmPrefix}${contextPrewarmRevision}|${messages.length}|${String(last?.id || '')}|${Number(last?.timestamp || 0)}`;
  }

  function invalidateAdvanceContextPrewarm({ preserveRecent = false } = {}) {
    contextPrewarmRevision += 1;
    if (preserveRecent) return;
    import('../core/context/build-chat-context.js')
      .then((mod) => mod.invalidateChatSystemPromptPrewarm?.(contextPrewarmPrefix))
      .catch(() => {});
  }

  async function prewarmAdvanceContext() {
    if (
      document.hidden
      || container.hidden
      || !container.isConnected
      || isStreaming
      || getChatStreamSession(chatId)
      || manualGenerationGate.current()
    ) return false;
    const cacheKey = currentAdvanceContextPrewarmKey();
    if (contextPrewarmInFlightKey === cacheKey) return false;
    contextPrewarmInFlightKey = cacheKey;
    try {
      const [mainConfig, apiOverride] = await Promise.all([
        getConfig().catch(() => ({})),
        resolveChatMainApiOverride(chatId).catch(() => null),
      ]);
      if (mainConfig?.contextPrewarmEnabled !== true) return false;
      const contextModule = await import('../core/context/build-chat-context.js');
      if (cacheKey !== currentAdvanceContextPrewarmKey() || document.hidden) return false;
      return await contextModule.prewarmChatSystemPrompt({
        chat,
        user,
        userId: user.id,
        messages,
        characters,
        contextDepth: chatPrefs?.contextDepth,
        guidanceMode: chatPrefs?.guidanceMode === true,
        presetMode: chatPrefs?.guidanceMode === true ? 'guidance' : undefined,
        phoneViewerId: fromCharacterPhone ? phoneViewerId : '',
        structureStrengthening: (apiOverride?.structureStrengthening ?? mainConfig?.structureStrengthening) === true,
        systemPromptCacheKey: cacheKey,
      });
    } catch (_) {
      return false;
    } finally {
      if (contextPrewarmInFlightKey === cacheKey) contextPrewarmInFlightKey = '';
    }
  }

  function scheduleAdvanceContextPrewarm(delayMs = 500) {
    if (contextPrewarmTimer) window.clearTimeout(contextPrewarmTimer);
    const delay = Math.max(0, Number(delayMs) || 0);
    contextPrewarmTimer = window.setTimeout(() => {
      contextPrewarmTimer = 0;
      const run = () => { void prewarmAdvanceContext(); };
      // 首屏和新消息的 0ms 预热是生成链路的必要准备，不再等最长 1.8s 的空闲回调。
      if (delay > 0 && typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(run, { timeout: 1800 });
      } else {
        run();
      }
    }, delay);
  }
  const observerLike = isObserverLikeChat(chat);
  const guidanceUsesChatScope = isGroup || observerLike;
  const guidanceScopeId = () => (
    guidanceUsesChatScope ? guidanceChatScopeId(chatId) : String(partnerId || '').trim()
  );
  const guidanceSubjectLabel = () => {
    if (isGroup) return `群聊「${String(chat.groupSettings?.name || title || '群聊').trim()}」`;
    if (observerLike) {
      const names = (chat.participants || [])
        .filter((id) => id && id !== 'user' && id !== 'system')
        .map((id) => resolveUiActorName(id, id));
      return names.length > 1 ? `${names.join('、')} 的会话` : (names[0] || title || '当前会话');
    }
    return resolveUiActorName(partnerId || '', partner?.name || '对方');
  };
  const canRunRealPersonScheduling = () => (
    !!partnerId
    && !hasActiveVoiceCall(messages)
    && canRunUserRealPersonScheduling(chat, { fromCharacterPhone, strangerChat })
  );
  let chatPrefs = initialChatPrefs;
  let headerCurrentContext = null;

  async function loadHeaderCurrentContext() {
    if (isGroup || observerLike || strangerChat || fromCharacterPhone || !partnerId) {
      return null;
    }
    const phone = await loadCharacterPhone(user.id, partnerId).catch(() => null);
    return collectCharacterPhoneCurrentContext({
      userId: user.id,
      characterId: partnerId,
      phone,
      character: partner,
      now: peekNowForUser(user.id) ?? Date.now(),
    }).catch(() => null);
  }

  async function refreshHeaderCurrentContext() {
    headerCurrentContext = await loadHeaderCurrentContext();
    return headerCurrentContext;
  }

  // Phone view title: peer real name / user display name — never user's remark for the character.
  function resolvePhoneViewTitle() {
    if (!fromCharacterPhone || isGroup) return title;
    const peerId = (chat.participants || []).find((p) => p && p !== phoneViewerId) || '';
    if (!peerId || peerId === 'user' || peerId === String(user?.id || '').trim()) {
      if (strangerChat) {
        const accountId = chat.metadata?.accountIdentityMap?.[principalKey('user', user.id)] || '';
        const snapshot = accountId ? chat.metadata?.accountSnapshots?.[accountId] : null;
        if (snapshot?.displayName) return snapshot.displayName;
      }
      return currentUserName || getUserDisplayName(user) || '用户';
    }
    const row = characters[peerId] || (peerId === partnerId ? partner : null);
    const storedAlias = chat.metadata?.phoneLightNpcAliases?.[peerId];
    return resolvePhoneSocialActorDisplayName(row, storedAlias) || '对方';
  }
  // 单聊「备注昵称」优先于角色名/角色备注昵称显示在顶栏标题上，与聊天详情页一致。
  // 「他的手机」视角例外：顶栏显示对方真名 / 用户名，不套用用户侧备注。
  if (!isGroup && !anonymousChat && !fromCharacterPhone && !observerLike) {
    const remark = String(chatPrefs?.remarkName || '').trim();
    if (remark) title = remark;
  }
  if (strangerChat && partnerId) {
    const visiblePartner = visibleIdentityFor(chat.metadata, principalKey('character', partnerId), partner || {});
    if (visiblePartner?.displayName) title = visiblePartner.displayName;
  }
  if (fromCharacterPhone && !isGroup) {
    title = resolvePhoneViewTitle();
  }
  const isInnerVoiceVisible = () => chatPrefs?.innerVoiceDisabled !== true && chatPrefs?.innerVoiceHidden !== true;
  const anonShell = anonymousChat && enteredViaValidShell;
  const anonEditorVariant = () => (anonShell || insChatChrome ? 'anon' : '');
  const anonSpaceProfile = anonShell ? await loadAnonymousSpaceUserProfile(user.id) : null;
  const actorSpaceProfiles = {};
  if (anonShell) {
    const actorIds = [...new Set((chat.participants || []).filter((p) => p && p !== 'user'))];
    await Promise.all(actorIds.map(async (pid) => {
      const st = await loadAnonymousSpaceState(user.id, pid);
      actorSpaceProfiles[pid] = normalizeAnonymousSpaceProfile(st.profile);
    }));
  }

  function frontStageUserName() {
    if (strangerChat) {
      const accountId = chat.metadata?.accountIdentityMap?.[principalKey('user', user.id)] || '';
      const snapshot = accountId ? chat.metadata?.accountSnapshots?.[accountId] : null;
      if (snapshot?.displayName) return snapshot.displayName;
    }
    if (anonymousChat) {
      const anon = String(
        getAnonymousDisplayProfile(chat, 'user', { currentUserName, spaceProfile: anonSpaceProfile })?.anonymousId || '',
      ).trim();
      if (anon && anon !== currentUserName) return anon;
      return '匿名网友';
    }
    return currentUserName;
  }

  function frontStageUserProfile() {
    if (strangerChat) {
      const accountId = chat.metadata?.accountIdentityMap?.[principalKey('user', user.id)] || '';
      const snapshot = accountId ? chat.metadata?.accountSnapshots?.[accountId] : null;
      if (snapshot) {
        const displayName = String(snapshot.displayName || '陌生账号').trim() || '陌生账号';
        return {
          ...user,
          name: displayName,
          displayName,
          avatar: String(snapshot.avatar || '').trim(),
          bio: String(snapshot.bio || '').trim(),
        };
      }
    }
    return user;
  }

  function frontStageCharacterProfiles() {
    if (!strangerChat) return characters;
    const output = { ...characters };
    for (const id of (chat.participants || []).filter((value) => value && value !== 'user')) {
      const accountId = chat.metadata?.accountIdentityMap?.[principalKey('character', id)] || '';
      const snapshot = accountId ? chat.metadata?.accountSnapshots?.[accountId] : null;
      if (!snapshot) continue;
      const displayName = String(snapshot.displayName || '陌生账号').trim() || '陌生账号';
      output[id] = {
        ...(output[id] || {}),
        id,
        name: displayName,
        realName: displayName,
        customNickname: '',
        avatar: String(snapshot.avatar || '').trim(),
      };
    }
    return output;
  }

  function resolveUiActorName(actorId = '', fallbackName = '') {
    const id = String(actorId || '').trim();
    if (!id) return String(fallbackName || '').trim();
    if (id === 'user') {
      if (anonymousChat || strangerChat) return frontStageUserName();
      return currentUserName || '我';
    }
    if (id === GUIDANCE_SENDER_ID) return '本体';
    if (anonymousChat) {
      const anon = getAnonymousDisplayProfile(chat, id, { currentUserName, spaceProfile: anonSpaceProfile })?.anonymousId;
      if (anon) return anon;
    }
    const row = characters[id] || (id === partnerId ? partner : null);
    if (strangerChat) {
      const identity = visibleIdentityFor(chat.metadata, principalKey('character', id), row || {});
      if (identity?.displayName) return identity.displayName;
    }
    // 手机视角：显示真名，不用会话备注 / 通讯录备注（备注可能是「爸爸」等称谓）
    if (fromCharacterPhone) {
      const phoneName = String(row?.realName || row?.name || '').trim();
      if (phoneName && !looksLikeRawParticipantId(phoneName)) return phoneName;
      const fb = String(fallbackName || '').trim();
      if (fb && fb !== id && !looksLikeRawParticipantId(fb)) return fb;
      return resolveActorDisplayLabel(fallbackName || id, {
        user,
        characters,
        memberCards: isGroup && !anonymousChat ? chat.groupSettings?.memberCards : {},
        partner,
        fallback: '联系人',
      });
    }
    const groupCard = isGroup && !anonymousChat
      ? String(chat.groupSettings?.memberCards?.[id] || '').trim()
      : '';
    const privateRemark = (!isGroup && !anonymousChat && id === partnerId)
      ? String(chatPrefs?.remarkName || '').trim()
      : '';
    const resolved = String(privateRemark || groupCard || row?.name || row?.customNickname || row?.realName || '').trim();
    if (resolved) return resolved;
    return resolveActorDisplayLabel(fallbackName || id, {
      user,
      characters,
      memberCards: isGroup && !anonymousChat ? chat.groupSettings?.memberCards : {},
      partner,
      fallback: '对方',
    });
  }

  function resolveReplySenderLabel(msg) {
    if (!msg) return '';
    return resolveUiActorName(msg.senderId, msg.senderName);
  }

  function currentReplyTargetLabel() {
    if (!replyTarget) return '';
    return resolveReplySenderLabel(replyTarget.raw)
      || resolveActorDisplayLabel(replyTarget.senderName || replyTarget.senderId, {
        user,
        characters,
        memberCards: isGroup && !anonymousChat ? chat.groupSettings?.memberCards : {},
        partner,
        fallback: '对方',
      });
  }

  appearancePrefs = await loadAppearancePrefs();
  let chatToolOrder = normalizeChatToolOrder(appearancePrefs.chatToolOrder);
  const chatPlatform = normalizeChatPlatform(appearancePrefs.chatPlatform);
  const wechatChatPlatform = chatPlatform === 'wechat';
  const qqChatPlatform = chatPlatform === 'qq';
  let chatAppearance = resolveThreadAppearance(chat);
  const activeAppearance = getActiveTheme(appearancePrefs);
  function resolvePlatformBubbleCssCompat(appr, active = activeAppearance) {
    const customTheme = active?.theme?.customTheme || {};
    return shouldUsePlatformBubbleCssCompat(chatPlatform, appr, [
      customTheme.css,
      customTheme.chatCss,
      customTheme.pageCss?.['chat-thread'],
    ]);
  }
  let platformBubbleCssCompat = resolvePlatformBubbleCssCompat(chatAppearance);
  const sessionPageCss = String(chatAppearance.customCss || '').trim();
  // QQ 平台壳发布前的整页 CSS 都是按统一旧 DOM 编写的。
  // 这类 CSS 在 QQ 下继续使用旧卡片 / composer 结构，否则选择器
  // 即使成功注入，也找不到被 QQ 重绘后的内部节点。
  // 明确写了 .chat-platform-qq 的新 CSS 视为已知道 QQ 结构，不降级。
  let qqLegacyCssCompat = qqChatPlatform
    && !!sessionPageCss
    && !/\.chat-platform-qq(?![\w-])/.test(sessionPageCss);
  const windowChatTheme = isWindowHomeTheme(activeAppearance.id, activeAppearance.theme);
  const seaChatTheme = isSeaHomeTheme(activeAppearance.id, activeAppearance.theme);
  // 手账 / 专辑过去以 scrapbook-page 作为用户 CSS 根；保留兼容类，但原皮仍统一由 --ins 驱动。
  const scrapbookCssCompat = !windowChatTheme && !seaChatTheme;
  const insChatChrome = !anonShell;
  // 匿名聊天保留紧凑输入壳；展开工具统一使用外部 Chat 的分页面板。
  const useAnonComposerMarkup = anonShell;
  // 海/窗恢复各自主屏体系原有的单行紧凑输入壳；QQ 只在 QQ 平台使用两行皮肤。
  // 匿名聊天也复用紧凑 composer，但工具面板仍保持匿名区自己的结构。
  let useCompactComposerMarkup = (anonShell || insChatChrome)
    && !wechatChatPlatform
    && (!qqChatPlatform || qqLegacyCssCompat);

  function nativeThreadTitle() {
    if (!wechatChatPlatform || !isGroup) return title;
    const memberCount = new Set((chat.participants || []).filter(Boolean)).size;
    return memberCount > 0 ? `${title}(${memberCount})` : title;
  }

  function buildWeChatTimeSuppression() {
    if (!wechatChatPlatform) return undefined;
    const suppressed = new Set();
    let previousTimestamp = 0;
    for (const message of messages) {
      const id = String(message?.id || '').trim();
      const timestamp = Number(new Date(message?.timestamp || 0)) || 0;
      if (!id || !timestamp) {
        if (id) suppressed.add(id);
        continue;
      }
      if (previousTimestamp > 0 && timestamp - previousTimestamp < 5 * 60 * 1000) {
        suppressed.add(id);
      }
      previousTimestamp = timestamp;
    }
    return suppressed;
  }

  function resolveChatWallpaperOverlayRgb(pageEl = container) {
    if (pageEl.classList.contains('chat-thread-page--sea')) return '233,238,243';
    if (pageEl.classList.contains('chat-thread-page--window')) return '248,248,247';
    return '251,246,240';
  }

  function syncChatWallpaperShell(pageEl = container, chatRow = chat) {
    const appr = resolveThreadAppearance(chatRow);
    const storedSessionWallpaper = resolveStoredThreadSessionWallpaper(chatRow);
    const sessionWallpaper = resolveThreadSessionWallpaper(chatRow);
    const globalWallpaper = String(activeAppearance.theme?.customTheme?.chatWallpaper || '').trim();
    // 工作室不渲染当前会话已保存的壁纸，避免把旧素材误当成新方案的一部分；
    // 但 has-chat-wallpaper 是会影响顶栏 / 工具栏级联的结构状态，必须与实机一致。
    // 当会话壁纸被隔离时也不能回落渲染全局壁纸，否则预览又会混入另一张图。
    const isolatedSessionWallpaper = isolateBeautifyPreview && !!storedSessionWallpaper;
    const wpUrl = isolatedSessionWallpaper ? '' : (sessionWallpaper || globalWallpaper);
    const opacity = sessionWallpaper
      ? appr.wallpaperOpacity
      : Number(activeAppearance.theme?.customTheme?.chatWallpaperOpacity || 100);
    const hasWp = !!wpUrl;
    if (hasWp) {
      applyChatThreadWallpaper(pageEl, wpUrl, opacity, resolveChatWallpaperOverlayRgb(pageEl));
    } else {
      clearChatThreadWallpaper(pageEl);
      if (isolatedSessionWallpaper) pageEl.classList.add('has-chat-wallpaper');
    }
    return hasWp || isolatedSessionWallpaper;
  }

  const chatSafeTopVisualProperties = [
    ['background-color', 'backgroundColor'],
    ['background-image', 'backgroundImage'],
    ['background-position', 'backgroundPosition'],
    ['background-size', 'backgroundSize'],
    ['background-repeat', 'backgroundRepeat'],
    ['background-blend-mode', 'backgroundBlendMode'],
    ['-webkit-backdrop-filter', 'webkitBackdropFilter'],
    ['backdrop-filter', 'backdropFilter'],
  ];
  let chatSafeTopSyncFrame = 0;

  function syncChatNavbarSafeTopFill() {
    const safeTop = container.querySelector(':scope > .chat-thread-safe-top');
    const navbar = container.querySelector(':scope > .chat-thread-navbar');
    if (!safeTop || !navbar) return;
    for (const [property] of chatSafeTopVisualProperties) safeTop.style.removeProperty(property);
    const style = window.getComputedStyle(navbar);
    const shouldFill = shouldFillChatNavbarSafeTop({
      pageRect: container.getBoundingClientRect(),
      navbarRect: navbar.getBoundingClientRect(),
      style,
    });
    safeTop.classList.toggle('chat-thread-safe-top--navbar-fill', shouldFill);
    if (!shouldFill) return;
    for (const [property, key] of chatSafeTopVisualProperties) {
      const value = String(style[key] || '').trim();
      if (value) safeTop.style.setProperty(property, value, 'important');
    }
  }

  function queueChatNavbarSafeTopFill() {
    if (chatSafeTopSyncFrame) window.cancelAnimationFrame(chatSafeTopSyncFrame);
    chatSafeTopSyncFrame = window.requestAnimationFrame(() => {
      chatSafeTopSyncFrame = 0;
      syncChatNavbarSafeTopFill();
    });
  }

  addPageLifetimeListener(window, 'resize', queueChatNavbarSafeTopFill, { passive: true });
  addPageLifetimeListener(document, 'marshmallow-chat-appearance-style-updated', queueChatNavbarSafeTopFill);
  addPageLifetimeCleanup(() => {
    if (chatSafeTopSyncFrame) window.cancelAnimationFrame(chatSafeTopSyncFrame);
    chatSafeTopSyncFrame = 0;
  });

  /** paint() 会 innerHTML 整页重写；先摘下壁纸层再挂回去，避免 <img> 重载造成有壁纸会话闪白。 */
  function detachChatWallpaperLayer(pageEl = container) {
    const layer = pageEl?.querySelector?.('.chat-thread-wallpaper-layer');
    if (!layer) return null;
    layer.remove();
    return layer;
  }

  function restoreChatWallpaperLayer(pageEl = container, layer = null) {
    if (!pageEl || !layer) return false;
    pageEl.insertBefore(layer, pageEl.firstChild);
    return true;
  }

  function applyThreadBubbleVars() {
    // 气泡取色只保留主题、本会话设置与自定义 CSS；旧档案里的全局色不再暗中覆盖会话。
    container.style.removeProperty('--user-bubble-bg');
    container.style.removeProperty('--role-bubble-bg');
    container.style.removeProperty('--chat-user-bubble-bg-default');
    container.style.removeProperty('--chat-role-bubble-bg-default');
    // 字色与背景色一样只由样式表中的公开变量控制，避免根节点内联变量
    // 压过后注入的整页 CSS / 气泡专用 CSS。
    container.style.removeProperty('--user-bubble-ink');
    container.style.removeProperty('--role-bubble-ink');
  }

  const wallpaperUrl = String(
    resolveStoredThreadSessionWallpaper(chat)
      || activeAppearance.theme?.customTheme?.chatWallpaper
      || '',
  ).trim();
  const hasWallpaper = !!wallpaperUrl;
  // 共享输入门禁用它把当前真实聚焦的输入框对应回具体会话。
  // 历史 localStorage 焦点仍可超时，但可见页面里的真实焦点/键盘必须一直避让。
  container.dataset.chatId = chatId;
  container.className = anonShell
    ? `page chat-thread-page chat-thread-page--anon${hasWallpaper ? ' has-chat-wallpaper' : ''}${toolsOpen ? ' has-chat-tools-open' : ''}`
    : [
      'page chat-thread-page',
      windowChatTheme ? 'chat-thread-page--window' : '',
      seaChatTheme ? 'chat-thread-page--sea' : '',
      scrapbookCssCompat ? 'scrapbook-page' : '',
      insChatChrome ? 'chat-thread-page--ins' : 'scrapbook-page',
      qqLegacyCssCompat ? 'chat-thread-page--qq-css-compat' : '',
      platformBubbleCssCompat ? 'chat-thread-page--bubble-css-compat' : '',
      hasWallpaper ? 'has-chat-wallpaper' : '',
      toolsOpen ? 'has-chat-tools-open' : '',
    ].filter(Boolean).join(' ');
  applyThreadBubbleVars(chatAppearance);
  syncChatWallpaperShell(container, chat);
  applyChatThreadAppearance(chatAppearance);

  async function refreshThreadUserProfile() {
    const freshUser = await ensureDefaultUser().catch(() => null);
    if (!freshUser) return user;
    user = freshUser;
    currentUserName = getUserDisplayName(user);
    userTimezoneForChat = await getUserTimezone(user.id)
      .catch(() => String(user?.timezone || '').trim());
    return user;
  }

  async function refreshThreadAppearanceShell({ forceMessageRepaint = false } = {}) {
    const latest = await getChat(chatId).catch(() => null);
    if (latest) chat = latest;
    const activeUser = await refreshThreadUserProfile();
    // 角色自主换头像会直接更新 characters 表。单聊以前会重读 partner，但群聊继续
    // 使用进页时构建的旧 characters 映射，导致主屏/角色手机已经换图，聊天气泡仍是旧头像。
    // 恢复页面、收到 characters 写入广播或重进会话时统一重载全部参与角色。
    const freshCharacters = await loadCharacterMap(chat, {
      userId: activeUser?.id || user.id,
      phoneOwnerId: fromCharacterPhone ? phoneViewerId : '',
    }).catch(() => null);
    if (freshCharacters) characters = freshCharacters;
    let activePartner = partner;
    if (partnerId) {
      const freshPartner = characters[partnerId]
        || await getRecord('characters', partnerId).catch(() => null);
      if (freshPartner) {
        activePartner = freshPartner;
        partner = freshPartner;
        characters[partnerId] = freshPartner;
      }
    }
    // 头像/昵称/备注可能在聊天详情页或通讯录被改过，恢复/刷新时把顶栏标题一起重算，
    // 否则要等下一次真正整页重渲染（如壁纸变更强制清缓存）才会显示新名字。
    chatPrefs = await loadChatPrefsWithExpiredStatus(chatId).catch(() => chatPrefs);
    title = await resolveTitle(chat, activeUser, characters).catch(() => title);
    if (!isGroup && !anonymousChat && !fromCharacterPhone) {
      const remark = String(chatPrefs?.remarkName || '').trim();
      if (remark) title = remark;
    }
    // 陌生/马甲窗：顶栏必须用前台身份名，不能被 resolveTitle 的本体名盖掉（详情返回会走这里）
    if (strangerChat && partnerId) {
      const visiblePartner = visibleIdentityFor(
        chat.metadata,
        principalKey('character', partnerId),
        activePartner || partner || {},
      );
      if (visiblePartner?.displayName) title = visiblePartner.displayName;
    }
    if (fromCharacterPhone && !isGroup) {
      title = resolvePhoneViewTitle();
    }
    const titleTextEl = container.querySelector('.navbar-title span');
    if (titleTextEl) titleTextEl.textContent = nativeThreadTitle();
    patchTitleDuoDom();
    // 状态/在线文案跟 prefs 走：后台追发改状态时 messages 写入会走到这里，
    // 不能只刷新气泡却留下「当前在线」。
    const stack = container.querySelector('.chat-thread-title-stack');
    if (stack && !wechatChatPlatform && !isGroup && !observerLike) {
      clearHeaderStatusDom(stack);
      const statusHtml = renderHeaderStatusHtml();
      if (statusHtml) stack.insertAdjacentHTML('beforeend', statusHtml);
    }
    const freshPrefs = await loadAppearancePrefs();
    appearancePrefs = freshPrefs;
    const nextChatToolOrder = normalizeChatToolOrder(freshPrefs.chatToolOrder);
    const chatToolOrderChanged = nextChatToolOrder.length !== chatToolOrder.length
      || nextChatToolOrder.some((id, index) => id !== chatToolOrder[index]);
    chatToolOrder = nextChatToolOrder;
    // Keep-Alive 页面可能在上面的异步读取期间再次被挂起；此时绝不能让旧会话
    // 改写全局聊天美化 style，否则会把当前会话重新染成上一页。
    if (!container.isConnected || container.hidden) return false;
    const freshActive = getActiveTheme(freshPrefs);
    const freshWindow = isWindowHomeTheme(freshActive.id, freshActive.theme);
    const freshSea = isSeaHomeTheme(freshActive.id, freshActive.theme);
    const freshScrapbookCssCompat = !freshWindow && !freshSea;
    const freshIns = !anonShell;
    const appr = resolveThreadAppearance(chat);
    const freshSessionPageCss = String(appr.customCss || '').trim();
    const freshQqLegacyCssCompat = qqChatPlatform
      && !!freshSessionPageCss
      && !/\.chat-platform-qq(?![\w-])/.test(freshSessionPageCss);
    const freshPlatformBubbleCssCompat = resolvePlatformBubbleCssCompat(appr, freshActive);
    const compatibilityStructureChanged = freshQqLegacyCssCompat !== qqLegacyCssCompat;
    chatAppearance = appr;
    qqLegacyCssCompat = freshQqLegacyCssCompat;
    platformBubbleCssCompat = freshPlatformBubbleCssCompat;
    useCompactComposerMarkup = (anonShell || freshIns)
      && !wechatChatPlatform
      && (!qqChatPlatform || qqLegacyCssCompat);
    const wpUrl = resolveStoredThreadSessionWallpaper(chat)
      || activeAppearance.theme?.customTheme?.chatWallpaper
      || '';
    const hasWp = !!String(wpUrl).trim();
    container.className = anonShell
      ? `page chat-thread-page chat-thread-page--anon${hasWp ? ' has-chat-wallpaper' : ''}${toolsOpen ? ' has-chat-tools-open' : ''}`
      : [
        'page chat-thread-page',
        freshWindow ? 'chat-thread-page--window' : '',
        freshSea ? 'chat-thread-page--sea' : '',
        freshScrapbookCssCompat ? 'scrapbook-page' : '',
        freshIns ? 'chat-thread-page--ins' : 'scrapbook-page',
        qqLegacyCssCompat ? 'chat-thread-page--qq-css-compat' : '',
        platformBubbleCssCompat ? 'chat-thread-page--bubble-css-compat' : '',
        hasWp ? 'has-chat-wallpaper' : '',
        toolsOpen ? 'has-chat-tools-open' : '',
      ].filter(Boolean).join(' ');
    applyThreadBubbleVars(appr, activeUser, activePartner);
    syncChatWallpaperShell(container, chat);
    applyChatThreadAppearance(appr);
    queueChatNavbarSafeTopFill();
    if (compatibilityStructureChanged) {
      paint();
      return true;
    }
    if (chatToolOrderChanged) {
      const currentSheet = container.querySelector('.chat-tools-sheet:not(.chat-tools-sheet--anon)');
      if (currentSheet) currentSheet.outerHTML = renderToolsSheet();
    }
    if (forceMessageRepaint) lastPaintSnapshot = null;
    refreshMessages();
    return true;
  }

  // 双 rAF：确保中间真的有一帧画面被提交，比单个 rAF（在下一次绘制之前触发，
  // 本身还是会挡那一帧）或 setTimeout(0)（部分 WebView 上会被节流）更可靠。
  function waitForNextPaint() {
    return new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
  }

  function isNearBottom(scroller, threshold = 12) {
    if (!scroller) return true;
    const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    return max - scroller.scrollTop < threshold;
  }

  function captureMessageViewportAnchor(main) {
    if (!main?.isConnected) return null;
    const rootRect = main.getBoundingClientRect();
    const nodes = main.querySelectorAll('[data-msg-id]');
    for (const node of nodes) {
      const id = String(node?.getAttribute?.('data-msg-id') || '').trim();
      if (!id) continue;
      const rect = node.getBoundingClientRect();
      if (rect.bottom <= rootRect.top + 1 || rect.top >= rootRect.bottom - 1) continue;
      return { id, offsetTop: rect.top - rootRect.top };
    }
    return null;
  }

  function restoreMessageViewportAnchor(main, anchor, fallbackScrollTop = null) {
    if (!main || !anchor?.id) {
      if (main && Number.isFinite(fallbackScrollTop)) main.scrollTop = fallbackScrollTop;
      return false;
    }
    const safeId = escapeMsgIdForSelector(anchor.id);
    const node = safeId ? main.querySelector(`[data-msg-id="${safeId}"]`) : null;
    if (!node) {
      if (Number.isFinite(fallbackScrollTop)) main.scrollTop = fallbackScrollTop;
      return false;
    }
    const rootTop = main.getBoundingClientRect().top;
    const nextOffsetTop = node.getBoundingClientRect().top - rootTop;
    main.scrollTop += nextOffsetTop - anchor.offsetTop;
    return true;
  }

  function captureHistoryViewportState(main) {
    if (!main?.isConnected || holdBottomUntilSettled || isNearBottom(main, 80)) return null;
    return {
      anchor: captureMessageViewportAnchor(main),
      scrollTop: main.scrollTop,
      userRevision: messageViewportUserRevision,
    };
  }

  function restoreHistoryViewportState(main, state) {
    if (!state || !main?.isConnected || holdBottomUntilSettled) return false;
    if (state.userRevision !== messageViewportUserRevision) return false;
    // 异步图片/卡片晚到时只能恢复仍然存在的消息锚点。渲染窗口已经变化、锚点被移除时，
    // 旧 scrollTop 只是过去某一刻的像素值，重新套用会把视口送回前面的历史记录。
    return restoreMessageViewportAnchor(main, state.anchor, null);
  }

  function stabilizeHistoryViewport(main, state) {
    if (!state || !main?.isConnected) return false;
    const restore = () => restoreHistoryViewportState(main, state);
    const restored = restore();
    requestAnimationFrame(() => {
      if (!restore()) return;
      requestAnimationFrame(restore);
    });
    return restored;
  }

  function rememberStableHistoryViewport(main = container.querySelector('.chat-thread-messages')) {
    stableHistoryViewportState = captureHistoryViewportState(main);
  }

  function scheduleStableHistoryViewportCapture(delayMs = 760) {
    if (historyViewportCaptureTimer) window.clearTimeout(historyViewportCaptureTimer);
    historyViewportCaptureTimer = window.setTimeout(() => {
      historyViewportCaptureTimer = 0;
      if (!container.isConnected || container.hidden) return;
      rememberStableHistoryViewport();
    }, Math.max(0, Number(delayMs) || 0));
  }

  /** 明确回到最新消息后，之前缓存的历史阅读锚点必须立即作废。 */
  function beginFollowingLatestMessages() {
    if (historyViewportCaptureTimer) window.clearTimeout(historyViewportCaptureTimer);
    historyViewportCaptureTimer = 0;
    stableHistoryViewportState = null;
    messageViewportUserRevision += 1;
    holdBottomUntilSettled = true;
  }

  /** 从收件箱/通讯录/系统通知等入口进会话：应直接落在最新消息，而不是恢复上次看到的位置。 */
  function shouldPinThreadToLatest(routeParams = {}, chatRow = chat, { includeUnread = true } = {}) {
    const entry = String(routeParams.entry || '').trim();
    if (entry === 'list' || entry === 'notify') return true;
    if (String(routeParams.focus || '').trim() === 'latest') return true;
    return includeUnread && Number(chatRow?.unread || 0) > 0;
  }

  // 「回到底部」悬浮键：往上翻看历史时出现，贴底附近自动收起。
  // main 的下边缘紧贴着输入区/工具面板/回复条这些高度会变的邻居（键盘弹起、
  // 多行输入、"+"面板展开都会改变它们的高度），按钮用 fixed 定位挂在视口上，
  // 得跟着 main 的实际下边缘动，不能写死一个 bottom 值。
  const CHAT_SCROLLBOTTOM_FAB_THRESHOLD = 160;
  const CHAT_SCROLLBOTTOM_FAB_GAP = 14;

  function positionScrollBottomFab() {
    const main = container.querySelector('.chat-thread-messages');
    const fab = container.querySelector('.chat-thread-scrollbottom-fab');
    if (!main || !fab) return;
    const rect = main.getBoundingClientRect();
    const bottom = Math.max(CHAT_SCROLLBOTTOM_FAB_GAP, window.innerHeight - rect.bottom + CHAT_SCROLLBOTTOM_FAB_GAP);
    fab.style.bottom = `${Math.round(bottom)}px`;
  }

  function updateScrollBottomFab() {
    const main = container.querySelector('.chat-thread-messages');
    const fab = container.querySelector('.chat-thread-scrollbottom-fab');
    if (!main || !fab) return;
    fab.classList.toggle('is-visible', !isNearBottom(main, CHAT_SCROLLBOTTOM_FAB_THRESHOLD));
  }

  // "+"工具面板收起的唯一入口：切到语音输入/选中某个工具/点击面板外/输入框重新聚焦时都要收，
  // 否则面板会带着 toolsOpen=true 的状态被 CSS 藏起来（聚焦输入框时强制 display:none），
  // 等输入框一失焦、CSS 屏蔽解除，面板就会没头没脑地弹出来。
  function closeToolsSheet() {
    container.classList.remove('has-chat-tools-open');
    if (!toolsOpen) {
      scheduleComposerDockGapRepair();
      return;
    }
    toolsOpen = false;
    container.querySelector('.chat-tools-sheet')?.classList.remove('is-open');
    container.querySelector('.chat-composer-more')?.classList.remove('is-open');
    scheduleComposerDockGapRepair();
  }

  function clearStreamPinTimers() {
    if (!streamPinTimers.length) return;
    streamPinTimers.forEach((id) => clearTimeout(id));
    streamPinTimers = [];
  }

  function cancelScrollToBottomRaf() {
    if (!scrollToBottomRaf) return;
    cancelAnimationFrame(scrollToBottomRaf);
    scrollToBottomRaf = 0;
  }

  /**
   * 新消息落地后，字体、主题装饰、心声卡等仍可能在后续帧改变消息区高度。
   * 只要用户没有主动上滑，就在这些布局完成后补钉到底部；用户一旦滑动，
   * releaseBottomHoldForUserScroll 会清掉同一组定时器，不会抢历史阅读位置。
   */
  function scheduleLatestFollowRepair(main = container.querySelector('.chat-thread-messages')) {
    if (!main?.isConnected || !holdBottomUntilSettled) return;
    clearStreamPinTimers();
    const pin = () => {
      if (!holdBottomUntilSettled || !main.isConnected) return;
      if (container.querySelector('.chat-thread-messages') !== main) return;
      main.scrollTop = main.scrollHeight;
    };
    requestAnimationFrame(pin);
    // 长回复的气泡揭示、心声渲染和图片解码可能跨越数秒。补钉窗口覆盖完整的
    // 收尾阶段；真实上滑会通过 releaseBottomHoldForUserScroll 立即取消它们。
    [80, 240, 520, 1000, 1800, 3000].forEach((ms) => {
      streamPinTimers.push(window.setTimeout(pin, ms));
    });
  }

  /**
   * 空回 / 断流等失败会在收尾时依次插入错误卡、移除输入占位并恢复操作区。
   * 这些相邻 flex 项的高度连续变化时，WebKit 偶尔会把长会话消息区夹到 scrollTop=0，
   * 正好露出最近一批消息顶部的「加载更早」按钮。只有本轮仍在跟随最新（用户没有
   * 主动上滑）时才重新钉底；并复用延迟补钉覆盖错误卡与输入区的后续布局帧。
   */
  function stabilizeFailedRoundAtLatest() {
    if (!chatError || !holdBottomUntilSettled) return false;
    const main = container.querySelector('.chat-thread-messages');
    if (!main?.isConnected) return false;
    main.scrollTop = main.scrollHeight;
    scheduleLatestFollowRepair(main);
    return true;
  }

  /** 用户主动上滑看历史：立刻停掉钉底 RAF / 补钉定时器，避免跟手势打架。 */
  function releaseBottomHoldForUserScroll() {
    holdBottomUntilSettled = false;
    messageViewportUserRevision += 1;
    scheduleStableHistoryViewportCapture();
    cancelScrollToBottomRaf();
    clearStreamPinTimers();
    releaseThreadScrollFlash();
  }

  /** 推进/重 roll 出「正在输入」时强制钉底，并在键盘收起后补钉几次。 */
  function pinThreadForActiveStream() {
    beginFollowingLatestMessages();
    streamPinGuardUntil = Date.now() + 700;
    const main = container.querySelector('.chat-thread-messages');
    if (!main) return;
    main.scrollTop = main.scrollHeight;
    scrollToBottom();
    scheduleLatestFollowRepair(main);
  }

  function scrollToBottom(onSettled) {
    const main = container.querySelector('.chat-thread-messages');
    if (!main) return;
    cancelScrollToBottomRaf();
    // 先同步钉底，避免首帧停在顶部闪一下「加载更早」。
    main.scrollTop = main.scrollHeight;
    let attempts = 0;
    const maxAttempts = 4;
    const finish = () => {
      scrollToBottomRaf = 0;
      onSettled?.();
    };
    const step = () => {
      if (!main.isConnected) {
        finish();
        return;
      }
      // 用户已经上滑看历史时，别再把视口拽回去。
      if (!holdBottomUntilSettled) {
        finish();
        return;
      }
      main.scrollTop = main.scrollHeight;
      attempts += 1;
      if (attempts < maxAttempts) {
        scrollToBottomRaf = requestAnimationFrame(step);
      } else {
        finish();
      }
    };
    scrollToBottomRaf = requestAnimationFrame(step);
  }

  function releaseThreadScrollFlash() {
    if (!suppressThreadScrollFlash) return;
    suppressThreadScrollFlash = false;
    container.querySelector('.chat-thread-messages')?.classList.remove('is-entry-settling');
  }

  function tryReleaseEntryFlash() {
    if (!suppressThreadScrollFlash) return;
    const main = container.querySelector('.chat-thread-messages');
    if (main) main.scrollTop = main.scrollHeight;
    releaseThreadScrollFlash();
  }

  function armThreadScrollFlash() {
    if (!suppressThreadScrollFlash || !holdBottomUntilSettled) return;
    container.querySelector('.chat-thread-messages')?.classList.add('is-entry-settling');
  }

  function scrollToMessage(msgId = '') {
    const id = String(msgId || '').trim();
    if (!id) return false;
    const main = container.querySelector('.chat-thread-messages');
    const safeId = window.CSS?.escape ? window.CSS.escape(id) : id.replace(/["\\\]]/g, '\\$&');
    const row = id
      ? (main?.querySelector(`.chat-msg-bubble[data-msg-id="${safeId}"]`)
        || main?.querySelector(`.chat-msg-card[data-msg-id="${safeId}"]`)
        || main?.querySelector(`.chat-msg-media[data-msg-id="${safeId}"]`)
        || main?.querySelector(`.chat-bubble-row[data-msg-id="${safeId}"]`))
      : null;
    if (!main || !row) return false;
    row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    row.classList.add('is-search-hit');
    window.setTimeout(() => row.classList.remove('is-search-hit'), 1600);
    return true;
  }

  function scheduleSearchJumpScroll(msgId = '') {
    const id = String(msgId || '').trim();
    if (!id) return;
    const attempt = (left = 5) => {
      if (scrollToMessage(id)) {
        showToast('已定位到该消息');
        return;
      }
      if (left <= 0) {
        showToast('未能定位到该消息');
        return;
      }
      requestAnimationFrame(() => attempt(left - 1));
    };
    requestAnimationFrame(() => attempt());
  }

  async function jumpToChatMessage(msgId = '', searchRow = null) {
    const targetId = String(msgId || '').trim();
    if (!targetId) return false;
    const target = searchRow?.id === targetId
      ? searchRow
      : await getRecord('messages', targetId).catch(() => null);
    if (!target) {
      showToast('找不到这条消息');
      return false;
    }
    const windowPage = await listMessagesAroundForChat(chatId, target, {
      beforeLimit: 30,
      afterLimit: 40,
      deferHeavyImages: true,
    });
    messages = windowPage.messages;
    hasOlderMessages = windowPage.hasOlder;
    hasNewerMessages = windowPage.hasNewer;
    if (!messages.some((m) => m.id === targetId)) {
      showToast('找不到这条消息');
      return false;
    }
    holdBottomUntilSettled = false;
    visibleMessageLimit = Math.max(CHAT_THREAD_RENDER_BATCH, messages.length);
    pendingSearchJumpId = targetId;
    refreshMessages(false);
    return true;
  }

  function getRenderableMessages() {
    const showGuidance = chatPrefs.guidanceMode === true;
    const visibleRows = showGuidance
      ? selectGuidanceDisplayMessages(messages, { startedAt: chatPrefs.guidanceModeStartedAt })
      : messages;
    const visible = visibleRows.filter((m) => {
      const messageId = String(m?.id || '');
      const roundId = String(m?.metadata?.aiRoundId || '');
      if (rerollUiHiddenMessageIds.has(messageId) || rerollUiHiddenRoundIds.has(roundId)) return false;
      if (isHiddenFromChatUi(m)) return false;
      // 兼容修复前已落库的协议尾标气泡：刷新后直接隐藏，不再继续外显。
      if (m?.type === 'text'
        && String(m?.content || '').trim()
        && !stripLeakedMarshmallowProtocolMarkers(m.content)) return false;
      // 退出指导模式后，指导气泡与用户指导发言都不再出现在聊天框。
      if (!showGuidance && isGuidanceMessage(m)) return false;
      return true;
    });
    const limit = Math.max(CHAT_THREAD_RENDER_BATCH, Number(visibleMessageLimit) || CHAT_THREAD_RENDER_BATCH);
    const hiddenCount = Math.max(0, visible.length - limit);
    const renderMessages = hiddenCount > 0 ? visible.slice(-limit) : visible;
    return { visible, renderMessages, hiddenCount };
  }

  function recallHash(input = '') {
    let h = 2166136261;
    const text = String(input || '');
    for (let i = 0; i < text.length; i += 1) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function recallActorName(id = '', sourceMsg = null) {
    const actorId = String(id || '').trim();
    if (actorId === 'user') return currentUserName || '我';
    return resolveUiActorName(actorId, sourceMsg?.senderName || actorId || '有人');
  }

  function recallMessageContent(msg = {}) {
    const copied = getMessageCopyText(msg);
    if (copied) return copied;
    const md = msg.metadata || {};
    if (msg.type === 'image') return md.caption || md.prompt || '[图片]';
    if (msg.type === 'sticker') return md.label || md.name || '[表情]';
    if (msg.type === 'voice') return md.text || md.transcript || '[语音]';
    if (msg.type === 'link') return md.title || msg.content || '[链接]';
    return String(msg.content || `[${msg.type || '消息'}]`).trim();
  }

  function buildRecallObservers(msg = {}) {
    const senderId = String(msg.senderId || '').trim();
    const letModelJudge = senderId === 'user';
    const ids = (chat.participants || [])
      .map((id) => String(id || '').trim())
      .filter((id) => id && id !== 'system' && id !== senderId);
    const rows = ids.map((id) => ({
      id,
      name: recallActorName(id),
      // user 撤回时始终把事件与原文交给模型，不由前端抽签代替人物判断。
      // 角色主动撤回仍保留原有确定性信息差，避免改变已有剧情结果。
      seen: letModelJudge
        ? null
        : (recallHash(`${msg.id}|${id}|recall`) % 100) < (isGroup ? 54 : 62),
    }));
    if (!letModelJudge && isGroup && rows.length > 1) {
      if (rows.every((r) => r.seen)) rows[rows.length - 1].seen = false;
      if (rows.every((r) => !r.seen)) rows[0].seen = true;
    }
    return rows;
  }

  function recallNoticeText(senderName) {
    const who = senderName === currentUserName ? '你' : senderName;
    return `${who}撤回了一条消息`;
  }

  async function recallMessage(msg) {
    if (!msg || msg.recalled || msg.deleted) return;
    const at = await getNowForUser(user.id);
    const senderName = recallActorName(msg.senderId, msg);
    const content = recallMessageContent(msg);
    // recallSeenBy 仅供提示词层判断角色是否看见，不在前端展示
    const observers = buildRecallObservers(msg);
    // 撤回提示落在原消息位置之后，而不是当前撤回时刻
    const noticeTs = Number(msg.timestamp || at) + 1;
    const notice = createMessage({
      chatId,
      senderId: 'system',
      senderName: '系统',
      type: 'system',
      content: recallNoticeText(senderName),
      timestamp: noticeTs,
      metadata: {
        recallNotice: true,
        recalledMessageId: msg.id,
        recalledSenderId: msg.senderId,
        recalledSenderName: senderName,
        recalledType: msg.type || 'text',
        recalledContent: content,
        recallSeenBy: observers,
        recalledMessageTimestamp: Number(msg.timestamp || 0),
        recalledAt: at,
      },
    });
    const next = {
      ...msg,
      recalled: true,
      metadata: {
        ...(msg.metadata || {}),
        recalledAt: at,
        recallNoticeId: notice.id,
        recallSeenBy: observers,
      },
    };
    await saveMessage(next);
    await saveMessage(notice);
    await updateChatPreview(chatId, previewFromMessage(notice), at);
    messages = messages
      .map((m) => (m.id === msg.id ? next : m))
      .concat(notice)
      .sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0));
    refreshMessages();
    showToast('已撤回');
  }

  function renderSearchResultItem(msg, query) {
    const normalized = normalizeMsgForUi(msg);
    const sender = recallActorName(normalized.senderId, normalized);
    const text = recallMessageContent(normalized).replace(/\s+/g, ' ').trim();
    const lower = text.toLowerCase();
    const needle = String(query || '').toLowerCase();
    const idx = needle ? lower.indexOf(needle) : -1;
    const start = idx >= 0 ? Math.max(0, idx - 18) : 0;
    const excerpt = text.slice(start, start + 72) || '[消息]';
    const prefix = start > 0 ? '…' : '';
    const suffix = start + 72 < text.length ? '…' : '';
    const time = normalized.timestamp ? new Date(normalized.timestamp).toLocaleString('zh-CN') : '';
    return `
      <button type="button" class="chat-search-result" data-search-msg-id="${esc(normalized.id)}">
        <span class="chat-search-result-head">
          <strong>${esc(sender)}</strong>
          <small>${esc(time)}</small>
        </span>
        <span class="chat-search-result-text">${esc(prefix + excerpt + suffix)}</span>
      </button>
    `;
  }

  async function openChatSearchModal() {
    const host = document.getElementById('modal-container');
    if (!host) return;
    const sheetClass = anonShell
      ? 'modal-sheet anon-modal-sheet chat-search-sheet'
      : 'modal-sheet scrapbook-card chat-search-sheet';
    host.classList.add('active');
    host.innerHTML = `
      <div class="modal-overlay chat-search-overlay" data-chat-search-overlay>
        <div class="${sheetClass}" role="dialog" aria-modal="true">
          <header class="modal-header">
            <h3>搜索聊天记录</h3>
            <button type="button" class="navbar-btn modal-close-btn" data-chat-search-close aria-label="关闭">${icon('back')}</button>
          </header>
          <div class="modal-body chat-search-body">
            <div class="chat-search-modes" role="tablist" aria-label="查找方式">
              <button type="button" class="chat-search-mode is-active" data-chat-search-mode="keyword" role="tab" aria-selected="true">关键词</button>
              <button type="button" class="chat-search-mode" data-chat-search-mode="date" role="tab" aria-selected="false">按日期</button>
            </div>
            <div data-chat-search-panel="keyword">
              <div class="chat-search-bar">
                <input type="search" class="form-input chat-search-input" placeholder="关键词" />
                <button type="button" class="btn btn-primary chat-search-run">搜索</button>
              </div>
              <div class="chat-search-results"><div class="chat-search-empty">输入关键词</div></div>
            </div>
            <div class="chat-search-calendar" data-chat-search-panel="date" hidden>
              <div class="chat-search-calendar-head">
                <button type="button" class="navbar-btn" data-chat-calendar-prev aria-label="上个月">‹</button>
                <strong data-chat-calendar-title></strong>
                <button type="button" class="navbar-btn" data-chat-calendar-next aria-label="下个月">›</button>
              </div>
              <div class="chat-search-weekdays" aria-hidden="true">
                <span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span><span>日</span>
              </div>
              <div class="chat-search-calendar-grid" data-chat-calendar-grid></div>
              <div class="chat-search-empty" data-chat-calendar-state>读取中…</div>
            </div>
          </div>
        </div>
      </div>
    `;
    const close = () => {
      host.classList.remove('active');
      host.innerHTML = '';
    };
    const input = host.querySelector('.chat-search-input');
    const results = host.querySelector('.chat-search-results');
    const calendarGrid = host.querySelector('[data-chat-calendar-grid]');
    const calendarState = host.querySelector('[data-chat-calendar-state]');
    const calendarTitle = host.querySelector('[data-chat-calendar-title]');
    const newestTimestamp = Number(messages[messages.length - 1]?.timestamp || Date.now());
    let calendarMonth = new Date(newestTimestamp);
    calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), 1);
    let calendarSeq = 0;
    let searchSeq = 0;

    const dateKey = (date) => {
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    };
    const renderCalendar = async () => {
      if (!calendarGrid || !calendarTitle || !calendarState) return;
      const seq = ++calendarSeq;
      calendarTitle.textContent = `${calendarMonth.getFullYear()}年${calendarMonth.getMonth() + 1}月`;
      calendarGrid.innerHTML = '';
      calendarState.hidden = false;
      calendarState.textContent = '读取中…';
      try {
        const activeDays = new Set(await listMessageDaysForChat(chatId, calendarMonth.getTime()));
        if (seq !== calendarSeq || !calendarGrid.isConnected) return;
        const first = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), 1);
        const total = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 0).getDate();
        const offset = (first.getDay() + 6) % 7;
        const cells = [];
        for (let i = 0; i < offset; i += 1) cells.push('<span class="chat-search-calendar-blank"></span>');
        for (let day = 1; day <= total; day += 1) {
          const date = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), day);
          const active = activeDays.has(dateKey(date));
          cells.push(`<button type="button" class="chat-search-calendar-day${active ? ' has-messages' : ''}" data-chat-calendar-day="${date.getTime()}" ${active ? '' : 'disabled'}><span>${day}</span></button>`);
        }
        calendarGrid.innerHTML = cells.join('');
        calendarState.hidden = activeDays.size > 0;
        calendarState.textContent = activeDays.size ? '' : '这个月没有聊天记录';
        calendarGrid.querySelectorAll('[data-chat-calendar-day]:not(:disabled)').forEach((button) => {
          button.addEventListener('click', async () => {
            const timestamp = Number(button.getAttribute('data-chat-calendar-day') || 0);
            button.disabled = true;
            const target = await findFirstMessageForChatDay(chatId, timestamp).catch(() => null);
            if (!target) {
              button.disabled = false;
              showToast('当天没有可定位的消息');
              return;
            }
            close();
            await jumpToChatMessage(target.id, target);
          });
        });
      } catch (_) {
        if (seq !== calendarSeq || !calendarState.isConnected) return;
        calendarState.hidden = false;
        calendarState.textContent = '日期读取失败，请重试';
      }
    };

    const setSearchMode = (mode) => {
      const next = mode === 'date' ? 'date' : 'keyword';
      host.querySelectorAll('[data-chat-search-mode]').forEach((button) => {
        const active = button.getAttribute('data-chat-search-mode') === next;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-selected', active ? 'true' : 'false');
      });
      host.querySelectorAll('[data-chat-search-panel]').forEach((panel) => {
        panel.hidden = panel.getAttribute('data-chat-search-panel') !== next;
      });
      if (next === 'date') renderCalendar();
      else input?.focus();
    };
    const run = async () => {
      const query = String(input?.value || '').trim();
      if (!results) return;
      if (!query) {
        results.innerHTML = '<div class="chat-search-empty">输入关键词</div>';
        return;
      }
      results.innerHTML = '<div class="chat-search-empty">搜索中…</div>';
      const seq = ++searchSeq;
      const q = query.toLowerCase();
      const rows = [];
      let beforeTimestamp = 0;
      try {
        for (let pageIndex = 0; pageIndex < 500 && rows.length < 80; pageIndex += 1) {
          const page = await listMessagesPageForChat(chatId, {
            limit: 160,
            ...(beforeTimestamp > 0 ? { beforeTimestamp } : {}),
            deferHeavyImages: true,
          });
          if (seq !== searchSeq || !results.isConnected) return;
          const pageRows = (page.messages || []).slice().reverse();
          for (const message of pageRows) {
            if (!message || isHiddenFromChatUi(message)) continue;
            if (!recallMessageContent(message).toLowerCase().includes(q)) continue;
            rows.push(message);
            if (rows.length >= 80) break;
          }
          if (!page.hasMore || !page.messages?.length) break;
          const oldestTimestamp = Number(page.messages[0]?.timestamp || 0);
          if (!oldestTimestamp || oldestTimestamp === beforeTimestamp) break;
          beforeTimestamp = oldestTimestamp;
          // 长会话搜索时主动让出一帧，避免扫描 IndexedDB 连续霸占主线程。
          await new Promise((resolve) => window.setTimeout(resolve, 0));
        }
      } catch (error) {
        if (seq !== searchSeq || !results.isConnected) return;
        results.innerHTML = '<div class="chat-search-empty">搜索失败，请重试</div>';
        return;
      }
      if (seq !== searchSeq || !results.isConnected) return;
      results.innerHTML = rows.length
        ? rows.map((m) => renderSearchResultItem(m, query)).join('')
        : '<div class="chat-search-empty">没有结果</div>';
      results.querySelectorAll('[data-search-msg-id]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const targetId = btn.getAttribute('data-search-msg-id') || '';
          const targetRow = rows.find((message) => message.id === targetId) || null;
          close();
          await jumpToChatMessage(targetId, targetRow);
        });
      });
    };
    host.querySelector('[data-chat-search-overlay]')?.addEventListener('click', close);
    host.querySelector('[data-chat-search-close]')?.addEventListener('click', close);
    host.querySelector('.chat-search-sheet')?.addEventListener('click', (e) => e.stopPropagation());
    host.querySelector('.chat-search-run')?.addEventListener('click', run);
    host.querySelectorAll('[data-chat-search-mode]').forEach((button) => {
      button.addEventListener('click', () => setSearchMode(button.getAttribute('data-chat-search-mode')));
    });
    host.querySelector('[data-chat-calendar-prev]')?.addEventListener('click', () => {
      calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1);
      renderCalendar();
    });
    host.querySelector('[data-chat-calendar-next]')?.addEventListener('click', () => {
      calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1);
      renderCalendar();
    });
    input?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') run();
    });
    input?.focus();
  }

  async function loadOlderMessages() {
    if (olderMessagesLoading) return;
    const oldestTs = Math.min(...messages.map((m) => Number(m.timestamp || 0)).filter((n) => Number.isFinite(n) && n > 0));
    if (!Number.isFinite(oldestTs)) {
      hasOlderMessages = false;
      refreshMessages();
      return;
    }
    olderMessagesLoading = true;
    // 进入加载态的这次重绘不应跳到底部：用户此刻停在顶部的「加载更早」按钮旁。
    preserveScrollAfterOlderLoad = true;
    refreshMessages();
    try {
      const page = await listMessagesPageForChat(chatId, {
        limit: CHAT_THREAD_RENDER_BATCH,
        beforeTimestamp: oldestTs,
        deferHeavyImages: true,
      });
      if (!page.messages.length) {
        hasOlderMessages = false;
        return;
      }
      if (isGroup) {
        const migration = await import('../core/lightweight-npc.js')
          .then((mod) => mod.migrateEphemeralNpcMessagesForChat(chat, page.messages, {
            userId: user?.id || '',
            phoneUserId: fromCharacterPhone ? user?.id : '',
            phoneOwnerId: fromCharacterPhone ? phoneViewerId : '',
          }))
          .catch(() => null);
        if (migration?.changed) {
          chat = migration.chat;
          page.messages = migration.messages;
          for (const row of migration.characters || []) characters[row.id] = row;
        }
      }
      const seen = new Set(messages.map((m) => m.id).filter(Boolean));
      messages = [...page.messages.filter((m) => !seen.has(m.id)), ...messages]
        .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
      hasOlderMessages = page.hasMore;
      visibleMessageLimit = Math.max(visibleMessageLimit + CHAT_THREAD_RENDER_BATCH, messages.length);
      preserveScrollAfterOlderLoad = true;
    } finally {
      olderMessagesLoading = false;
      refreshMessages();
    }
  }

  async function loadInitialMessages({ animateNewMessages = false, preserveLoadedHistory = false } = {}) {
    // 从 Keep-Alive 缓存恢复时消息列表已经在屏幕上，静默刷新即可，
    // 不要把已经画好的消息先清成「加载中」占位再刷回来（那一下就是恼人的跳动）。
    const hasExisting = messages.length > 0;
    const previousMessageIds = new Set(messages.map((message) => message?.id).filter(Boolean));
    const prevIds = messages.map((m) => m.id).join('|');
    const hadBubbles = !!container.querySelector('.chat-thread-messages')?.childElementCount;
    const refreshStartedAtMutationRevision = localMessageMutationRevision;
    const pendingMutationsAtRefreshStart = new Set(
      [...localMessageMutations.entries()]
        .filter(([, mutation]) => mutation?.pending)
        .map(([id]) => id),
    );
    if (!hasExisting) {
      messagesLoading = true;
      refreshMessages();
    }
    try {
      const page = await listMessagesPageForChat(chatId, {
        limit: CHAT_THREAD_RENDER_BATCH,
        deferHeavyImages: true,
      });
      if (isGroup) {
        const migration = await import('../core/lightweight-npc.js')
          .then((mod) => mod.migrateEphemeralNpcMessagesForChat(chat, page.messages, {
            userId: user?.id || '',
            phoneUserId: fromCharacterPhone ? user?.id : '',
            phoneOwnerId: fromCharacterPhone ? phoneViewerId : '',
          }))
          .catch(() => null);
        if (migration?.changed) {
          chat = migration.chat;
          page.messages = migration.messages;
          for (const row of migration.characters || []) characters[row.id] = row;
        }
      }
      const currentById = new Map(messages.map((message) => [message?.id, message]));
      const incoming = overlayLocalMessageMutations(
        page.messages.map((message) => mergeImageStateMonotonically(currentById.get(message?.id), message)),
        refreshStartedAtMutationRevision,
        pendingMutationsAtRefreshStart,
      );
      if (preserveLoadedHistory && hasExisting) {
        const incomingIds = new Set(incoming.map((message) => message?.id).filter(Boolean));
        const oldestIncomingTimestamp = incoming.reduce((oldest, message) => (
          Math.min(oldest, Number(message?.timestamp || Number.POSITIVE_INFINITY))
        ), Number.POSITIVE_INFINITY);
        // 只保留最新分页边界之前的已加载历史；边界内缺席的旧节点代表已删除，不能复活。
        const retainedHistory = Number.isFinite(oldestIncomingTimestamp)
          ? messages.filter((message) => (
            (!message?.id || !incomingIds.has(message.id))
            && Number(message?.timestamp || 0) < oldestIncomingTimestamp
          ))
          : [];
        const addedCount = incoming.reduce((count, message) => (
          count + (message?.id && !currentById.has(message.id) ? 1 : 0)
        ), 0);
        messages = [...retainedHistory, ...incoming]
          .sort((a, b) => Number(a?.timestamp || 0) - Number(b?.timestamp || 0));
        // 最新页追加消息时不能让渲染窗口从头部挤掉用户正在看的那几条历史。
        visibleMessageLimit = Math.max(visibleMessageLimit + addedCount, messages.length);
      } else {
        messages = incoming;
      }
      hasOlderMessages = page.hasMore;
    } finally {
      messagesLoading = false;
      const nextIds = messages.map((m) => m.id).join('|');
      // 消息列表没变且气泡已在 DOM 里：跳过整表重绘，避免已懒加载的图片被拆回占位再闪一轮。
      const unchanged = hasExisting && hadBubbles && prevIds === nextIds;
      if (!unchanged) {
        const newIds = animateNewMessages
          ? messages.map((message) => message?.id).filter((id) => id && !previousMessageIds.has(id))
          : [];
        refreshMessages(false, { revealIds: revealIdsForPaint(newIds) });
      } else {
        const main = container.querySelector('.chat-thread-messages');
        if (main) bindLazyMediaHydration(main);
      }
      refreshStaleLinkMessages();
      if ((isStreaming || getChatStreamSession(chatId)) && !streamingPreviewPaintedThisTurn) {
        setStreamingPlaceholderVisible(true, chatStreamPlaceholderText(getChatStreamSession(chatId)));
      }
    }
  }

  /** APK WebView 回前台后纹理偶发空白：对已有 src 但 naturalWidth=0 的表情/图片重绑一次。 */
  function recoverBlankChatMediaImages() {
    const main = container.querySelector('.chat-thread-messages');
    if (!main) return;
    main.querySelectorAll('.chat-sticker img, .chat-user-image-wrap img').forEach((img) => {
      if (!(img instanceof HTMLImageElement)) return;
      const src = String(img.getAttribute('src') || '').trim();
      if (!src || img.naturalWidth > 0) return;
      img.style.display = '';
      img.closest('.chat-sticker')?.classList.remove('is-broken');
      const hint = img.nextElementSibling;
      if (hint?.classList?.contains('chat-sticker-broken-hint')) hint.hidden = true;
      img.setAttribute('src', src);
    });
  }

  function shouldResolveStickerPool(renderMessages = []) {
    return renderMessages.some((m) => {
      if (m?.type !== 'sticker') return false;
      if (m?.metadata?.deferredSticker || m?.metadata?.deferredImage) {
        const stickerId = String(m?.metadata?.stickerId || '').trim();
        const packId = String(m?.metadata?.packId || '').trim();
        const packName = String(m?.metadata?.packName || '').trim();
        const stickerName = String(m?.metadata?.stickerName || m?.metadata?.sticker || '').trim();
        // 本地大图的消息副本会剥掉 data URL。只在有稳定 ID，或旧消息仍保留
        // 「分组 + 精确名称」时从本地库兜底，避免按模糊名称换成无关表情。
        return !!stickerId || (!!stickerName && (!!packId || !!packName));
      }
      // 只对「库里本来就没有图片地址」的表情走名称池解析。
      // 大图 data URL 首屏会被 defer 剥掉——那是 hydration/懒加载的事，不能按剥后状态去池子里瞎匹配，
      // 否则会把本地上传表情换成同名/无关的外链图，或永久停在「[表情]」。
      const metaUrl = String(m?.metadata?.url || '').trim();
      const content = String(m?.content || '').trim();
      return !/^(https?:\/\/|data:image\/)/i.test(metaUrl) && !/^(https?:\/\/|data:image\/)/i.test(content);
    });
  }

  function stickerSlotHtmlForPatch(imgUrl, name) {
    const label = String(name || '表情包').trim() || '表情包';
    return `<span class="chat-sticker-slot"><span class="chat-sticker">`
      + `<img src="${escAttr(imgUrl)}" alt="${esc(label)}" decoding="async" referrerpolicy="no-referrer" `
      + `onerror="this.style.display='none';var h=this.nextElementSibling;if(h){h.hidden=false;this.closest('.chat-sticker')?.classList.add('is-broken')}" />`
      + `<span class="chat-sticker-broken-hint" hidden>`
      + `<span class="chat-sticker-broken-name">${esc(label)}</span>`
      + `<span class="chat-sticker-broken-tip">未加载 · 外链图床可能需翻墙，建议上传或换图床</span>`
      + `</span></span></span>`;
  }

  /** 贴纸池解析后只改缺图节点，避免 innerHTML 全量替换把正在播的 GIF 拆掉后定格 */
  async function patchStickerSlotsInPlace(main, renderMessages, stickerResolver, resolveStickerBubbleImageUrl, seq) {
    if (!main || !stickerResolver || typeof resolveStickerBubbleImageUrl !== 'function') return 0;
    let patched = 0;
    for (const msg of renderMessages) {
      if (msg?.type !== 'sticker' || !msg.id) continue;
      const row = main.querySelector(`[data-msg-id="${escAttr(String(msg.id))}"]`);
      if (!row) continue;
      const display = deferHeavyMediaForDisplay(msg);
      const pool = typeof stickerResolver.poolForMessage === 'function'
        ? stickerResolver.poolForMessage(display)
        : (stickerResolver.full || null);
      const metaUrl = String(display.metadata?.url || '').trim();
      const content = String(display.content || '').trim();
      let imgUrl = resolveStickerBubbleImageUrl(display, pool)
        || (/^(https?:\/\/|data:image\/)/i.test(metaUrl) ? metaUrl : '')
        || (/^(https?:\/\/|data:image\/)/i.test(content) ? content : '');
      // 与 upgradeStickerImageUrl 一致：仅 https 页面才升协议，避免本地 http 预览把图床升坏
      if (/^http:\/\//i.test(imgUrl) && typeof location !== 'undefined' && location.protocol === 'https:') {
        imgUrl = `https://${imgUrl.slice(7)}`;
      }
      if (!imgUrl) continue;
      if (/^data:image\//i.test(imgUrl)) {
        // iOS 只允许可视区占位走 hydrateDeferredImagePlaceholder 逐张恢复。
        // 这里若遍历整个渲染窗口，会同时把多份 Base64 转成 Blob/位图，WebKit
        // 很容易在长会话中因瞬时内存峰值直接结束页面进程。
        if (IOS_WEBKIT_CHAT) continue;
        const { ensureStickerThumb } = await import('../core/sticker-thumb-cache.js');
        imgUrl = await ensureStickerThumb({
          id: String(display.metadata?.stickerId || `message-${msg.id}`).trim(),
          url: imgUrl,
        }).catch(() => null) || imgUrl;
        if (seq !== messageRenderSeq || !main.isConnected) return patched;
      }
      const name = String(display.metadata?.stickerName || display.metadata?.sticker || content || '表情包').trim();
      const existingImg = row.querySelector('.chat-sticker img');
      if (existingImg) {
        if ((existingImg.getAttribute('src') || '') !== imgUrl) {
          existingImg.setAttribute('src', imgUrl);
          patched += 1;
        }
        continue;
      }
      const deferred = row.querySelector('.chat-sticker-deferred, .chat-gen-image-placeholder.is-deferred');
      const tag = row.querySelector('.chat-bubble-tag');
      const target = deferred?.closest('.chat-sticker-slot')
        || deferred?.closest('.chat-sticker')
        || tag
        || row.querySelector('.chat-sticker-slot');
      if (!target) continue;
      const wrap = document.createElement('div');
      wrap.innerHTML = stickerSlotHtmlForPatch(imgUrl, name);
      const node = wrap.firstElementChild;
      if (!node) continue;
      target.replaceWith(node);
      patched += 1;
    }
    return patched;
  }

  function renderHeaderStatusHtml() {
    if (wechatChatPlatform) return '';
    if (isGroup || observerLike) return '';
    if (strangerChat && chat.metadata?.friendshipState !== 'accepted') {
      const strangerStatus = isUserAliasBlockedByCharacter(chat) ? '已被对方拉黑' : '还未添加为好友';
      return `
        <div class="chat-header-status" data-chat-live-status data-presence="offline">
          <span class="chat-header-presence-dot"></span>
          <span class="chat-header-status-text">${strangerStatus}</span>
        </div>
      `;
    }
    const headerStatus = resolveChatHeaderStatus(chatPrefs, headerCurrentContext);
    const presenceState = headerStatus.presenceState;
    const headerStatusText = headerStatus.text;
    const nowMs = peekNowForUser(user.id) ?? Date.now();
    const timezoneHint = buildTimezoneHeaderHint(
      chatPrefs,
      user,
      partner,
      nowMs,
      { userTimezone: userTimezoneForChat },
    );
    return `
      <div class="chat-header-status" data-chat-live-status data-presence="${esc(presenceState)}" data-header-status-detail title="点按查看完整状态">
        <span class="chat-header-presence-dot"></span>
        <span class="chat-header-status-text">${esc(headerStatusText)}</span>
      </div>
      ${timezoneHint ? `<div class="chat-header-timezone-hint">${esc(timezoneHint)}</div>` : ''}
    `;
  }

  function openHeaderStatusDetail() {
    const host = document.getElementById('modal-container');
    if (!host) return;
    const headerStatus = resolveChatHeaderStatus(chatPrefs, headerCurrentContext);
    const statusText = String(headerStatus?.text || '').trim() || '当前在线';
    const presenceState = String(headerStatus?.presenceState || 'online').trim() || 'online';
    const presenceLabel = {
      online: '在线',
      away: '暂离',
      busy: '忙碌',
      offline: '离线',
    }[presenceState] || '在线';
    const nowMs = peekNowForUser(user.id) ?? Date.now();
    const timezoneHint = buildTimezoneHeaderHint(
      chatPrefs,
      user,
      partner,
      nowMs,
      { userTimezone: userTimezoneForChat },
    );
    host.classList.add('active');
    host.innerHTML = `
      <div class="modal-overlay modal-sheet-center chat-header-status-detail-overlay" data-header-status-detail-close>
        <section class="modal-sheet scrapbook-card chat-header-status-detail-sheet" role="dialog" aria-modal="true" aria-labelledby="chat-header-status-detail-title">
          <header class="modal-header">
            <h3 id="chat-header-status-detail-title">当前状态</h3>
            <button type="button" class="navbar-btn modal-close-btn" data-header-status-detail-close aria-label="关闭">${icon('close')}</button>
          </header>
          <div class="chat-header-status-detail-body">
            <div class="chat-header-status-detail-presence" data-presence="${esc(presenceState)}">
              <span class="chat-header-presence-dot" aria-hidden="true"></span>
              <span>${esc(presenceLabel)}</span>
            </div>
            <p>${esc(statusText)}</p>
            ${timezoneHint ? `<small>${esc(timezoneHint)}</small>` : ''}
          </div>
        </section>
      </div>
    `;
    const onKeydown = (event) => {
      if (event.key === 'Escape') close();
    };
    const close = () => {
      document.removeEventListener('keydown', onKeydown);
      host.classList.remove('active');
      host.innerHTML = '';
    };
    const overlay = host.querySelector('.chat-header-status-detail-overlay');
    overlay?.addEventListener('click', close);
    host.querySelector('.chat-header-status-detail-sheet')?.addEventListener('click', (event) => event.stopPropagation());
    host.querySelector('button[data-header-status-detail-close]')?.addEventListener('click', close);
    document.addEventListener('keydown', onKeydown);
    host.querySelector('button[data-header-status-detail-close]')?.focus();
  }

  function clearHeaderStatusDom(stack) {
    // 手机视角/旁观提示也沿用 chat-header-status 的样式，不能把它们当作实时状态删掉。
    // 排除提示类的兜底选择器用于清理升级前已渲染、尚未带 data 标记的旧状态节点。
    stack.querySelectorAll(`
      [data-chat-live-status],
      .chat-header-status:not(.chat-header-phone-hint):not(.chat-header-observer-hint),
      .chat-header-timezone-hint
    `).forEach((node) => node.remove());
  }

  function patchHeaderStatusDom() {
    const stack = container.querySelector('.chat-thread-title-stack');
    if (!stack || isGroup || observerLike) return;
    clearHeaderStatusDom(stack);
    const html = renderHeaderStatusHtml();
    if (html) stack.insertAdjacentHTML('beforeend', html);
  }

  let headerStatusRefreshSeq = 0;
  async function refreshHeaderStatus() {
    const refreshSeq = ++headerStatusRefreshSeq;
    const [nextChatPrefs, nextHeaderContext, nextUserTimezone] = await Promise.all([
      loadChatPrefsWithExpiredStatus(chatId),
      loadHeaderCurrentContext(),
      getUserTimezone(user.id).catch(() => userTimezoneForChat),
    ]);
    if (refreshSeq !== headerStatusRefreshSeq || !container.isConnected) return;
    chatPrefs = nextChatPrefs;
    headerCurrentContext = nextHeaderContext;
    userTimezoneForChat = nextUserTimezone || userTimezoneForChat;
    patchHeaderStatusDom();
  }

  // 手机日程会在聊天停留期间跨入下一步骤；即使没有新消息，也要让顶栏尽快
  // 跟上 busy / 睡眠变化，避免回复门禁已经暂缓而页面仍显示“当前在线”。
  let headerStatusRefreshTimer = 0;
  if (!isGroup && !observerLike) {
    headerStatusRefreshTimer = window.setInterval(() => {
      if (document.hidden || !container.isConnected || container.hidden) return;
      refreshHeaderStatus().catch(() => {});
    }, 5_000);
    addPageLifetimeCleanup(() => {
      if (headerStatusRefreshTimer) window.clearInterval(headerStatusRefreshTimer);
      headerStatusRefreshTimer = 0;
    });
    const onCharacterStatusSourceUpdated = (event) => {
      const detail = event?.detail || {};
      if (String(detail.userId || '') !== String(user.id || '')) return;
      if (String(detail.characterId || '') !== String(partnerId || '')) return;
      void refreshHeaderStatus().catch(() => {});
    };
    addPageLifetimeListener(window, CHARACTER_PHONE_UPDATED_EVENT, onCharacterStatusSourceUpdated);
    addPageLifetimeListener(window, CHARACTER_LIVE_STATE_UPDATED_EVENT, onCharacterStatusSourceUpdated);
  }

  function renderActiveEventBanner() {
    const ev = getActiveEvent(chat);
    if (!ev?.text || !isActiveEventUserVisible(ev)) return '';
    return `
      <div class="chat-active-event-banner scrapbook-panel">
        <div class="chat-active-event-label">特殊事件进行中</div>
        <p>${esc(ev.text)}</p>
        <button type="button" class="btn btn-soft btn-sm" data-clear-event>清除事件</button>
      </div>
    `;
  }

  function renderGuidanceBanner() {
    if (anonShell || chatPrefs.guidanceMode !== true) return '';
    return `
      <div class="chat-guidance-banner">
        <div class="chat-guidance-banner-label">指导模式</div>
        <p>正在与本体讨论扮演问题 · 协议与人设续写已暂停</p>
        <div class="chat-guidance-banner-actions">
          <button type="button" class="btn btn-soft btn-sm" data-act="guidance-expert">专家会诊 <small>测试中</small></button>
          <button type="button" class="btn btn-soft btn-sm" data-act="guidance-exit">退出</button>
        </div>
      </div>
    `;
  }

  function latestRoleplayAiSample() {
    const eligible = messages.filter((message) => {
      if (!message || message.deleted || message.recalled || isGuidanceMessage(message)) return false;
      if (message.senderId === 'user' || message.senderId === 'system') return false;
      return !!String(getMessageCopyText(message) || '').trim();
    });
    const latest = eligible[eligible.length - 1];
    if (!latest) return null;
    const roundId = String(latest.metadata?.aiRoundId || '').trim();
    const rows = roundId
      ? eligible.filter((message) => String(message.metadata?.aiRoundId || '').trim() === roundId)
      : [latest];
    return {
      latest,
      text: rows.map((message) => String(getMessageCopyText(message) || '').trim()).filter(Boolean).join('\n\n'),
    };
  }

  function formatExpertConsultationGuidance(consultation, { preserveFlavor, introduceFlavor, consultantLabel } = {}) {
    return [
      '【专家会诊 · 测试中】',
      consultantLabel ? `会诊档位：${consultantLabel}` : '',
      `希望保留：${preserveFlavor}`,
      `希望引入：${introduceFlavor}`,
      '',
      `诊断：${consultation.diagnosis}`,
      '',
      `保留清单：\n${consultation.preserve.map((item) => `- ${item}`).join('\n')}`,
      '',
      `本次已修复：\n${consultation.repair.map((item) => `- ${item}`).join('\n')}`,
      '',
      '【专家直接改写版本】',
      consultation.rewrite,
      '',
      '这版由所选专家在同一次调用中直接完成，可以继续在指导模式里讨论。',
    ].filter((line) => line !== '').join('\n');
  }

  function expertContextMessageText(message = {}) {
    if (typeof message.content === 'string') return message.content.trim();
    if (!Array.isArray(message.content)) return String(message.content || '').trim();
    return message.content
      .map((part) => (typeof part === 'string' ? part : String(part?.text || part?.content || '')))
      .filter(Boolean)
      .join('\n')
      .trim();
  }

  async function buildChatExpertReferenceContext() {
    const { buildChatContext } = await import('../core/context/build-chat-context.js');
    const built = await buildChatContext({
      chat,
      chatId,
      user,
      userId: user.id,
      messages,
      characters,
      contextDepth: chatPrefs?.contextDepth,
      sceneDirective: '[专家会诊只读上下文] 仅整理这次会诊所需的既有事实，不续写、不推进剧情。',
      guidanceMode: true,
      // 保持“指导态不扮演”，但仍读取普通线上实际启用的文风/功能预设，
      // 否则 consultant 只知道人物事实，不知道原模型本来被要求写成什么味道。
      presetMode: 'online',
    });
    return (built.messages || [])
      .map((message) => {
        const body = expertContextMessageText(message);
        if (!body) return '';
        const role = message.role === 'system'
          ? '设定、世界书、预设与记忆'
          : (message.role === 'assistant' ? '角色与既有回复' : '用户与指导讨论');
        return `【${role}】\n${body}`;
      })
      .filter(Boolean)
      .join('\n\n');
  }

  async function openChatExpertConsultationSheet() {
    if (chatPrefs.guidanceMode !== true) {
      showToast('请先进入指导模式');
      return;
    }
    const sample = latestRoleplayAiSample();
    if (!sample?.text) {
      showToast('还没有可会诊的正常剧情回复');
      return;
    }
    const [mainPresets, scenePresets, flavorPresets] = await Promise.all([
      listApiSectionPresetOptions('main').catch(() => []),
      listApiSectionPresetOptions('scene').catch(() => []),
      listExpertConsultationPresets().catch(() => []),
    ]);
    const choices = [
      ...mainPresets.map((row) => ({ ...row, section: 'main', group: '聊天模型' })),
      ...scenePresets.map((row) => ({ ...row, section: 'scene', group: '场景叙事' })),
    ];
    if (!choices.length) {
      showToast('请先在 API 管理中保存至少一个聊天模型或场景叙事档位');
      return;
    }
    const host = document.getElementById('modal-container');
    if (!host) return;
    host.classList.add('active');
    const sheetClass = anonEditorVariant() === 'anon'
      ? 'modal-sheet anon-modal-sheet chat-expert-consultation-sheet'
      : 'modal-sheet scrapbook-card chat-expert-consultation-sheet';
    host.innerHTML = `
      <div class="modal-overlay" data-chat-expert-overlay>
        <div class="${sheetClass}" role="dialog" aria-modal="true" aria-labelledby="chat-expert-title">
          <header class="modal-header">
            <h3 id="chat-expert-title">专家会诊 <small>测试中</small></h3>
            <button type="button" class="navbar-btn modal-close-btn" data-chat-expert-close aria-label="关闭">${icon('back')}</button>
          </header>
          <div class="modal-body chat-expert-consultation-body">
            <label><span class="api-field-label">会诊方案</span>
              <select class="form-input" data-chat-expert-flavor-preset>
                <option value="">临时填写</option>
                ${flavorPresets.map((row) => `<option value="${esc(row.id)}">${esc(row.name)}</option>`).join('')}
              </select>
            </label>
            <label><span class="api-field-label">会诊模型档位</span>
              <select class="form-input" data-chat-expert-preset>
                ${choices.map((row) => `<option value="${esc(`${row.section}:${row.id}`)}">${esc(row.group)} · ${esc(row.name)}${row.model ? ` · ${esc(row.model)}` : ''}</option>`).join('')}
              </select>
            </label>
            <label><span class="api-field-label">希望保留当前稿的什么</span>
              <textarea class="form-input" rows="3" maxlength="500" data-chat-expert-preserve placeholder="例如：Gemini 的剧情推进、情感浓度和具体生活信息"></textarea>
            </label>
            <label><span class="api-field-label">希望从会诊模型引入什么</span>
              <textarea class="form-input" rows="3" maxlength="500" data-chat-expert-introduce placeholder="例如：Claude 的克制、细腻心理和动作连贯性"></textarea>
            </label>
            <div class="chat-guidance-banner-actions">
              <button type="button" class="btn btn-soft btn-sm" data-chat-expert-flavor-save>保存为方案</button>
              <button type="button" class="btn btn-soft btn-sm" data-chat-expert-flavor-delete>删除方案</button>
            </div>
            <p class="guidance-mode-sheet-status" data-chat-expert-status>所选专家会在一次调用中直接写出替代版本，并留在指导对话里。</p>
            <button type="button" class="btn btn-primary" data-chat-expert-run>让专家直接写一版</button>
          </div>
        </div>
      </div>`;
    const close = () => {
      host.classList.remove('active');
      host.innerHTML = '';
    };
    host.querySelector('[data-chat-expert-overlay]')?.addEventListener('click', close);
    host.querySelector('[data-chat-expert-close]')?.addEventListener('click', close);
    host.querySelector('.chat-expert-consultation-sheet')?.addEventListener('click', (event) => event.stopPropagation());
    const flavorSelect = host.querySelector('[data-chat-expert-flavor-preset]');
    flavorSelect?.addEventListener('change', () => {
      const preset = flavorPresets.find((row) => row.id === flavorSelect.value);
      if (!preset) return;
      host.querySelector('[data-chat-expert-preserve]').value = preset.preserveFlavor;
      host.querySelector('[data-chat-expert-introduce]').value = preset.introduceFlavor;
      const apiValue = `${preset.apiSection}:${preset.apiPresetId}`;
      if (choices.some((row) => `${row.section}:${row.id}` === apiValue)) {
        host.querySelector('[data-chat-expert-preset]').value = apiValue;
      }
    });
    host.querySelector('[data-chat-expert-flavor-save]')?.addEventListener('click', async () => {
      const preserveFlavor = String(host.querySelector('[data-chat-expert-preserve]')?.value || '').trim();
      const introduceFlavor = String(host.querySelector('[data-chat-expert-introduce]')?.value || '').trim();
      const name = String(window.prompt('给这套会诊方案起个名字', '') || '').trim();
      if (!name) return;
      const selected = String(host.querySelector('[data-chat-expert-preset]')?.value || '');
      const splitAt = selected.indexOf(':');
      try {
        await saveExpertConsultationPreset({
          name,
          preserveFlavor,
          introduceFlavor,
          apiSection: selected.slice(0, splitAt),
          apiPresetId: selected.slice(splitAt + 1),
        });
        showToast('会诊方案已保存，下次可直接选择');
      } catch (error) {
        showToast(error?.message || '保存失败');
      }
    });
    host.querySelector('[data-chat-expert-flavor-delete]')?.addEventListener('click', async () => {
      const id = String(flavorSelect?.value || '');
      if (!id) return;
      await deleteExpertConsultationPreset(id);
      [...flavorSelect.options].find((option) => option.value === id)?.remove();
      flavorSelect.value = '';
      showToast('会诊方案已删除');
    });
    host.querySelector('[data-chat-expert-run]')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      const status = host.querySelector('[data-chat-expert-status]');
      const preserveFlavor = String(host.querySelector('[data-chat-expert-preserve]')?.value || '').trim();
      const introduceFlavor = String(host.querySelector('[data-chat-expert-introduce]')?.value || '').trim();
      if (!preserveFlavor || !introduceFlavor) {
        if (status) status.textContent = '请把两边想要的特点都写清楚，避免模型自行套品牌刻板印象。';
        return;
      }
      const selected = String(host.querySelector('[data-chat-expert-preset]')?.value || '');
      const splitAt = selected.indexOf(':');
      const section = selected.slice(0, splitAt);
      const presetId = selected.slice(splitAt + 1);
      const choice = choices.find((row) => row.section === section && row.id === presetId);
      const consultantLabel = `${choice?.name || '会诊档位'}${choice?.model ? ` / ${choice.model}` : ''}`;
      button.disabled = true;
      host.querySelectorAll('select, textarea').forEach((el) => { el.disabled = true; });
      if (status) status.textContent = '专家正在阅读上下文并直接改写…';
      try {
        const [configOverride, referenceContext] = await Promise.all([
          resolveApiSectionPresetConfig(section, presetId),
          buildChatExpertReferenceContext(),
        ]);
        const consultation = await runNarrativeExpertConsultation({
          sampleText: sample.text,
          referenceContext,
          preserveFlavor,
          introduceFlavor,
          consultantLabel,
          configOverride,
          onProgress: () => { if (status) status.textContent = '专家正在写替代版本…'; },
        });
        const now = peekNowForUser(user.id) ?? await getNowForUser(user.id);
        const message = createMessage({
          chatId,
          senderId: GUIDANCE_SENDER_ID,
          senderName: '专家会诊',
          type: 'text',
          content: formatExpertConsultationGuidance(consultation, {
            preserveFlavor,
            introduceFlavor,
            consultantLabel,
          }),
          timestamp: now,
          metadata: {
            guidanceMode: true,
            expertConsultation: true,
            expertConsultationSourceMessageId: sample.latest.id,
            consultantLabel,
            preserveFlavor,
            introduceFlavor,
          },
        });
        await saveMessage(message);
        messages.push(message);
        close();
        refreshMessages();
        scrollToBottom();
        showToast('专家直接改写版本已加入指导对话');
      } catch (error) {
        if (status) status.textContent = `会诊未完成：${error?.message || error}`;
        button.disabled = false;
        host.querySelectorAll('select, textarea').forEach((el) => { el.disabled = false; });
      }
    });
  }

  function formatErrorTime(ts = Date.now()) {
    return new Date(Number(ts) || Date.now()).toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  function buildChatErrorFromResult(result = {}, fallback = '生成失败', operation = '聊天生成') {
    const error = normalizeGenerationError({
      scope: '聊天 / AI 回复',
      operation,
      title: result.title,
      message: result.error || fallback,
      error: result.error || fallback,
      reason: result.reason,
      rawText: result.rawText,
      responseText: result.responseText,
      status: result.status,
      detail: result.detail,
      finishReason: result.finishReason,
      upstreamMeta: result.upstreamMeta,
      upstreamResponse: result.upstreamResponse,
      retried: result.retried,
      errors: result.errors,
      rejected: result.rejected,
      parseErrors: result.parseErrors,
      refusalProvider: result.refusalProvider,
      refusalKind: result.refusalKind,
      transportError: result.transportError,
      usedUrl: result.usedUrl,
      correlationId: result.correlationId,
      requestAttempts: result.requestAttempts,
      requestModel: result.requestModel,
      requestStream: result.requestStream,
      abortReason: result.abortReason,
      streamStats: result.streamStats,
      emptyKind: result.emptyKind,
      requestElapsedMs: result.requestElapsedMs,
      at: Date.now(),
    });
    recordLastGenerationError(error);
    return error;
  }

  function buildChatErrorFromException(err, operation = '聊天生成') {
    return generationErrorFromCatch(err, {
      scope: '聊天 / AI 回复',
      operation,
      at: Date.now(),
    });
  }

  function canSaveErrorRawAsPlainMessage() {
    if (!chatError) return false;
    if (!['protocol-plain-text', 'no-marshmallow-protocol'].includes(String(chatError.reason || ''))) return false;
    return !!extractPlainTextFromErrorRaw();
  }

  function extractPlainTextFromErrorRaw() {
    const raw = String(chatError?.rawText || '').trim();
    if (!raw) return '';
    return stripLeakedMarshmallowProtocolMarkers(stripThinkingBlocks(raw));
  }

  /** 掉格式原文只在用户逐条确认后落库，绝不能把整段响应自动当作角色正文。 */
  async function chooseErrorRawBubblesAndSave() {
    const text = extractPlainTextFromErrorRaw();
    if (!text) {
      showToast('没有可落库的模型原文');
      return;
    }
    const picked = await openPlainTextBubblePickerModal({
      parts: splitPlainTextFallbackBubbles(text),
    });
    if (!picked?.length) return;
    const senderId = partnerId || (chat.participants || []).find((p) => p && p !== 'user') || 'ai';
    const senderChar = characters[senderId];
    const baseTimestamp = await getNowForUser(user.id);
    const acceptedMessages = picked.map((content, index, list) => createMessage({
      chatId,
      senderId,
      senderName: String(senderChar?.customNickname || senderChar?.name || senderId),
      type: 'text',
      content,
      timestamp: baseTimestamp + index * 1000,
      metadata: {
        aiGenerated: true,
        plainTextFallback: true,
        manuallyAcceptedPlainText: true,
        fallbackPartIndex: index,
        fallbackPartCount: list.length,
      },
    }));
    await saveMessages(acceptedMessages);
    const lastMessage = acceptedMessages[acceptedMessages.length - 1];
    await updateChatPreview(chatId, previewFromMessage(lastMessage), lastMessage.timestamp);
    messages = messages.concat(acceptedMessages).sort(compareChatMessageChronology);
    clearChatError();
    refreshMessages();
    showToast(`已填入 ${acceptedMessages.length} 条气泡`);
  }

  function renderChatErrorPanel() {
    if (!chatError) return '';
    const side = String(chatError.side || '').trim();
    const sideLabel = String(chatError.sideLabel || '').trim();
    const original = String(
      chatError.originalText
      || chatError.responseText
      || chatError.rawText
      || '',
    ).trim();
    const originalKind = String(chatError.originalKind || (chatError.responseText ? 'api' : (chatError.rawText ? 'model' : ''))).trim();
    const refusalProvider = String(chatError.refusalProvider || '').trim().toLowerCase();
    const originalLabel = originalKind === 'api'
      ? '接口原文'
      : (originalKind === 'upstream'
        ? (refusalProvider === 'google' ? 'Google / Gemini 拦截原文' : '上游拦截原文')
        : (originalKind === 'model' ? '模型原文' : '返回原文'));
    const message = String(chatError.message || '').trim();
    // 主文案若正好就是原文，也放进带明确标签的原文块，避免一段技术 JSON
    // 看起来像 App 自己给出的笼统报错。
    const messageIsOriginal = !!(original && message === original);
    const showOriginalBlock = !!original;
    const upstream = String(chatError.upstreamResponse || '').trim();
    const showUpstream = !!(upstream && upstream !== original);
    const reasoning = String(
      chatError.reasoningText
      || chatError.upstreamMeta?.reasoningText
      || '',
    ).trim();
    const modelOutputNotice = side === 'model' && !chatError.status;
    return `
      <section class="chat-error-card scrapbook-panel${side ? ` chat-error-card--${esc(side)}` : ''}" data-chat-error-card>
        <div class="chat-error-card-head">
          <div class="chat-error-card-titles">
            ${sideLabel ? `<span class="chat-error-side chat-error-side--${esc(side || 'unknown')}">${esc(sideLabel)}</span>` : ''}
            <strong>${esc(chatError.title || '生成失败')}</strong>
          </div>
          <button type="button" class="chat-error-close" data-chat-error-close aria-label="关闭">${icon('close')}</button>
        </div>
        ${messageIsOriginal ? '' : `<p>${esc(message || '没有拿到回复')}</p>`}
        ${showOriginalBlock ? `<div class="chat-error-original-label">${esc(originalLabel)}</div><pre class="chat-error-original">${esc(original)}</pre>` : ''}
        ${showUpstream ? `<div class="chat-error-original-label">上游返回</div><pre class="chat-error-original">${esc(upstream)}</pre>` : ''}
        ${reasoning ? (modelOutputNotice
          ? `<details class="chat-model-reasoning"><summary>查看本次思维链</summary><pre class="chat-error-original">${esc(reasoning)}</pre></details>`
          : `<div class="chat-error-original-label">推理原文</div><pre class="chat-error-original">${esc(reasoning)}</pre>`)
          : ''}
        <div class="chat-error-card-foot">
          <span>${esc(formatErrorTime(chatError.at))}${chatError.status ? ` · HTTP ${esc(chatError.status)}` : ''}</span>
          <div class="chat-error-card-actions">
            ${canSaveErrorRawAsPlainMessage() ? '<button type="button" class="chat-error-plain-save" data-chat-error-plain-save>选择气泡填入</button>' : ''}
            ${modelOutputNotice ? '' : '<button type="button" class="chat-error-support" data-chat-error-support>让芥末自查</button>'}
            <button type="button" class="chat-error-detail" data-chat-error-detail>${modelOutputNotice ? '查看模型返回' : '查看详情排查'}</button>
            ${modelOutputNotice ? '' : '<button type="button" class="chat-error-copy" data-chat-error-copy>复制报错</button>'}
          </div>
        </div>
      </section>
    `;
  }

  let sparkStatsCache = null;

  function renderHeaderSparkHtml() {
    if (isGroup || observerLike) return '';
    if (chatPrefs.showChatSpark !== true) return '';
    const stats = sparkStatsCache;
    if (!stats || stats.activeDays < 2) return '';
    return `<span class="chat-title-spark" title="连续 ${stats.streak} 天 · 累计 ${stats.activeDays} 天">🔥</span>`;
  }

  function refreshHeaderSpark() {
    if (isGroup || observerLike) return;
    const titleEl = container.querySelector('.navbar-title');
    if (!titleEl) return;
    const html = renderHeaderSparkHtml();
    const existing = titleEl.querySelector('.chat-title-spark');
    if (existing) {
      if (html) existing.outerHTML = html;
      else existing.remove();
      return;
    }
    if (html) titleEl.insertAdjacentHTML('beforeend', html);
  }

  function noteSparkMessage(message) {
    if (isGroup || observerLike || chatPrefs.showChatSpark !== true || !message) return;
    void lightChatSparkDayFromMessage(message).then((stats) => {
      if (!stats || !container.isConnected) return;
      sparkStatsCache = stats;
      refreshHeaderSpark();
    }).catch(() => {});
  }

  async function loadSparkStats() {
    if (isGroup || observerLike || chatPrefs.showChatSpark !== true) return;
    try {
      sparkStatsCache = await computeSparkStatsForChat(chatId);
      refreshHeaderSpark();
    } catch (_) {}
  }

  let sparkStatsIdleHandle = 0;
  let sparkStatsFallbackTimer = 0;

  function scheduleSparkStatsLoad() {
    if (isGroup || observerLike || chatPrefs.showChatSpark !== true) return;
    const run = () => {
      sparkStatsIdleHandle = 0;
      sparkStatsFallbackTimer = 0;
      if (!container.isConnected || container.hidden) return;
      void loadSparkStats();
    };
    if (typeof window.requestIdleCallback === 'function') {
      sparkStatsIdleHandle = window.requestIdleCallback(run, { timeout: 1200 });
    } else {
      sparkStatsFallbackTimer = window.setTimeout(run, 320);
    }
  }

  addPageLifetimeCleanup(() => {
    if (sparkStatsIdleHandle && typeof window.cancelIdleCallback === 'function') {
      window.cancelIdleCallback(sparkStatsIdleHandle);
    }
    if (sparkStatsFallbackTimer) window.clearTimeout(sparkStatsFallbackTimer);
    sparkStatsIdleHandle = 0;
    sparkStatsFallbackTimer = 0;
  });

  function refreshChatErrorPanel() {
    const existing = container.querySelector('[data-chat-error-card]');
    const html = renderChatErrorPanel();
    if (existing) {
      if (html) existing.outerHTML = html;
      else existing.remove();
      return;
    }
    if (!html) return;
    const anchor = container.querySelector('.chat-thread-messages');
    anchor?.insertAdjacentHTML('beforebegin', html);
  }

  function setChatError(error) {
    chatError = error || null;
    refreshChatErrorPanel();
  }

  function clearChatError() {
    if (!chatError) return;
    chatError = null;
    dismissGenerationErrorReport();
    refreshChatErrorPanel();
  }

  function renderSelectionBar() {
    if (!selectionMode) return '';
    const count = selectedSet.size;
    if (selectionPurpose === 'guidance-exit') {
      return `
      <div class="chat-selection-bar${useAnonComposerMarkup ? '' : ' scrapbook-panel'}">
        <span class="chat-selection-count">退出指导 · 已选 ${count} 条</span>
        <div class="chat-selection-actions">
          <button type="button" class="btn btn-primary btn-sm" data-act="guidance-exit-scope" ${count ? '' : 'disabled'}>选择用途</button>
          <button type="button" class="btn btn-outline btn-sm" data-act="guidance-exit-skip">不保存退出</button>
          <button type="button" class="btn btn-soft btn-sm" data-act="guidance-exit-cancel">取消</button>
        </div>
      </div>`;
    }
    return `
      <div class="chat-selection-bar${useAnonComposerMarkup ? '' : ' scrapbook-panel'}">
        <span class="chat-selection-count">已选 ${count} 条</span>
        <div class="chat-selection-actions">
          <button type="button" class="btn btn-outline btn-sm" data-act="favorite" ${count ? '' : 'disabled'}>收藏</button>
          ${isAnonymousChat(chat) ? '' : `<button type="button" class="btn btn-outline btn-sm" data-act="share-moments" ${count ? '' : 'disabled'}>晒到朋友圈</button>`}
          <button type="button" class="btn btn-outline btn-sm" data-act="merge-forward" ${count ? '' : 'disabled'}>发给别人</button>
          <button type="button" class="btn btn-primary btn-sm" data-act="long-image" ${count ? '' : 'disabled'}>导出长图</button>
          <button type="button" class="btn btn-sm is-danger" data-act="select-delete" ${count ? '' : 'disabled'}>删除</button>
          <button type="button" class="btn btn-soft btn-sm" data-act="select-done">完成</button>
        </div>
      </div>`;
  }

  function renderGroupInfoCards() {
    if (!isGroup) return '';
    const gs = chat.groupSettings || {};
    const announcement = String(gs.announcement || '').trim();
    const todos = (Array.isArray(gs.todos) ? gs.todos : [])
      .filter((item) => item && String(item.text || '').trim())
      .slice(0, 10);
    const showAnnouncement = !!announcement && !isGroupInfoDismissed('announcement');
    const showTodos = !!todos.length && !isGroupInfoDismissed('todos');
    if (!showAnnouncement && !showTodos) return '';
    return `
      <section class="chat-group-info-cards">
        ${showAnnouncement ? `
          <article class="chat-group-info-card scrapbook-panel">
            <div class="chat-group-info-card-head">
              <strong>群公告</strong>
              <button type="button" class="chat-group-info-close" data-group-info-dismiss="announcement" aria-label="关闭群公告">${icon('close')}</button>
            </div>
            <p>${esc(announcement)}</p>
          </article>
        ` : ''}
        ${showTodos ? `
          <article class="chat-group-info-card scrapbook-panel">
            <div class="chat-group-info-card-head">
              <strong>群待办</strong>
              <button type="button" class="chat-group-info-close" data-group-info-dismiss="todos" aria-label="关闭群待办">${icon('close')}</button>
            </div>
            <div class="chat-group-todo-list">
              ${todos.map((item) => `
                <button type="button" class="chat-group-todo-item ${item.done ? 'is-done' : ''}" data-group-todo-toggle="${esc(item.id)}" aria-pressed="${item.done ? 'true' : 'false'}">
                  <span class="chat-group-todo-box">${item.done ? icon('check') : ''}</span>
                  <span>${esc(item.text)}</span>
                </button>
              `).join('')}
            </div>
          </article>
        ` : ''}
      </section>
    `;
  }

  function groupInfoSignature(kind = '') {
    const gs = chat.groupSettings || {};
    if (kind === 'announcement') return String(gs.announcement || '').trim();
    if (kind === 'todos') {
      return (Array.isArray(gs.todos) ? gs.todos : [])
        .filter((item) => item && String(item.text || '').trim())
        .map((item) => `${item.id || ''}:${item.text || ''}:${item.done ? 1 : 0}`)
        .join('|');
    }
    return '';
  }

  function isGroupInfoDismissed(kind = '') {
    const dismissed = chatPrefs.dismissedGroupInfoCards && typeof chatPrefs.dismissedGroupInfoCards === 'object'
      ? chatPrefs.dismissedGroupInfoCards
      : {};
    const sig = groupInfoSignature(kind);
    return !!sig && String(dismissed[kind] || '') === sig;
  }

  // 发送键三态合一：生成中是「停止」（红色）；没在生成时，输入框有字是「发送」，没字是「推进」。
  // 手机视角暂锁输入：只保留推进/停止。
  function hasActiveGenerationControl() {
    const streamSession = getChatStreamSession(chatId);
    return isStreaming
      || !!(streamSession && !streamSession.abortController?.signal?.aborted)
      || !!abortController
      || !!manualGenerationGate.current()
      || (headlessReplyVisible && isHeadlessChatReplyTyping(chatId))
      || cloudTypingVisible;
  }

  function isPhoneInputLocked() {
    return fromCharacterPhone
      && chatPrefs.guidanceMode !== true
      && phoneProxyMode !== true;
  }

  function isObserverInputLocked() {
    return observerLike
      && !fromCharacterPhone
      && chatPrefs.guidanceMode !== true;
  }

  function isComposerInputLocked() {
    return isPhoneInputLocked() || isObserverInputLocked();
  }

  function composerSendButtonState() {
    if (hasActiveGenerationControl()) {
      return { mode: 'stop', iconHtml: icon('stop'), label: '停止' };
    }
    if (isComposerInputLocked()) {
      return { mode: 'advance', iconHtml: icon('advance'), label: '推进' };
    }
    const hasText = !!String(composerDraftText || '').trim();
    return hasText
      ? { mode: 'send', iconHtml: icon('send'), label: '发送' }
      : { mode: 'advance', iconHtml: icon('advance'), label: '推进' };
  }
  function currentComposerSenderId() {
    if (fromCharacterPhone && phoneProxyMode) return String(phoneViewerId || '').trim();
    return String(sendAsCharacterId || 'user').trim() || 'user';
  }

  function composerMentionCandidates(query = '') {
    if (!isGroup || isStreaming || isComposerInputLocked()) return [];
    const senderId = currentComposerSenderId();
    const needle = String(query || '').trim().toLocaleLowerCase();
    const visibleCharacters = frontStageCharacterProfiles();
    return (chat.participants || [])
      .map((id) => String(id || '').trim())
      .filter((id) => id && id !== senderId && id !== 'system' && id !== GUIDANCE_SENDER_ID)
      .map((actorId) => ({
        actorId,
        label: resolveUiActorName(actorId, actorId),
        avatarHtml: characterAvatarHtml(
          actorId === 'user' ? frontStageUserProfile() : (visibleCharacters[actorId] || characters[actorId] || {}),
          { className: 'chat-composer-mention-avatar' },
        ),
      }))
      .filter((item) => item.label && (!needle || item.label.toLocaleLowerCase().includes(needle)))
      .slice(0, 12);
  }

  function renderComposerMentionSuggestions() {
    if (!composerMentionSuggestions.length) return '';
    return `<div class="chat-composer-mention-suggestions" role="listbox" aria-label="选择要提及的群成员">
      ${composerMentionSuggestions.map((item, index) => `<button type="button" class="chat-composer-mention-item${index === composerMentionActiveIndex ? ' is-active' : ''}" data-composer-mention-id="${esc(item.actorId)}" role="option" aria-selected="${index === composerMentionActiveIndex ? 'true' : 'false'}">${item.avatarHtml}<span>@${esc(item.label)}</span></button>`).join('')}
    </div>`;
  }

  function paintComposerMentionSuggestions() {
    const footer = container.querySelector('.chat-thread-composer');
    if (!footer) return;
    footer.querySelector('.chat-composer-mention-suggestions')?.remove();
    if (!composerMentionSuggestions.length) return;
    footer.insertAdjacentHTML('afterbegin', renderComposerMentionSuggestions());
  }

  function clearComposerMentionSuggestions() {
    composerMentionSuggestions = [];
    composerMentionRange = null;
    composerMentionActiveIndex = 0;
    container.querySelector('.chat-composer-mention-suggestions')?.remove();
  }

  function updateComposerMentionSuggestions(inputEl) {
    if (!inputEl || composerImeComposing || !isGroup) {
      clearComposerMentionSuggestions();
      return;
    }
    const range = findComposerMentionQuery(inputEl.value || '', inputEl.selectionStart);
    if (!range) {
      clearComposerMentionSuggestions();
      return;
    }
    const candidates = composerMentionCandidates(range.query);
    composerMentionRange = range;
    composerMentionSuggestions = candidates;
    composerMentionActiveIndex = Math.min(composerMentionActiveIndex, Math.max(0, candidates.length - 1));
    if (candidates.length) clearComposerStickerSuggestions();
    paintComposerMentionSuggestions();
  }

  function selectComposerMention(actorId = '') {
    const inputEl = container.querySelector('.chat-composer-input');
    const item = composerMentionSuggestions.find((candidate) => candidate.actorId === actorId);
    if (!inputEl || !item || !composerMentionRange) return false;
    const inserted = insertComposerMention(inputEl.value || '', composerMentionRange, item);
    if (!inserted) return false;
    inputEl.value = inserted.text;
    resizeComposerInput(inputEl);
    composerMentionDrafts.push(inserted.mention);
    noteComposerDraft(inserted.text);
    clearComposerMentionSuggestions();
    syncComposerSendButton();
    requestAnimationFrame(() => {
      try {
        inputEl.focus({ preventScroll: true });
      } catch (_) {
        inputEl.focus();
      }
      inputEl.selectionStart = inputEl.selectionEnd = inserted.cursor;
    });
    return true;
  }

  function renderComposerStickerSuggestions() {
    if (!composerStickerSuggestions.length) return '';
    return `<div class="chat-composer-sticker-suggestions" role="listbox" aria-label="匹配的表情包">
      ${composerStickerSuggestions.map((sticker, idx) => `
        <button type="button" class="chat-composer-sticker-suggestion" data-sticker-suggestion="${idx}" role="option" aria-label="发送表情 ${escAttr(sticker.name)}">
          <img src="${escAttr(sticker.displayUrl || sticker.url)}" alt="${escAttr(sticker.name)}" loading="lazy" decoding="async" referrerpolicy="no-referrer" />
          <span>${esc(sticker.name)}</span>
        </button>`).join('')}
    </div>`;
  }

  function paintComposerStickerSuggestions() {
    const footer = container.querySelector('.chat-thread-composer');
    if (!footer) return;
    footer.querySelector('.chat-composer-sticker-suggestions')?.remove();
    if (!composerStickerSuggestions.length) return;
    footer.insertAdjacentHTML('afterbegin', renderComposerStickerSuggestions());
  }

  function clearComposerStickerSuggestions() {
    composerStickerSuggestionSeq += 1;
    window.clearTimeout(composerStickerSuggestionTimer);
    composerStickerSuggestions = [];
    container.querySelector('.chat-composer-sticker-suggestions')?.remove();
  }

  function scheduleComposerStickerSuggestions(value) {
    const query = String(value || '').trim();
    window.clearTimeout(composerStickerSuggestionTimer);
    if (!query || query.length > 40 || fromCharacterPhone || isStreaming) {
      clearComposerStickerSuggestions();
      return;
    }
    const seq = ++composerStickerSuggestionSeq;
    composerStickerSuggestionTimer = window.setTimeout(async () => {
      try {
        const matches = await findChatStickerChoices(query, { limit: 6 });
        if (seq !== composerStickerSuggestionSeq) return;
        const { upgradeStickerImageUrl } = await import('../core/sticker-store.js');
        composerStickerSuggestions = matches.map((sticker) => ({
          ...sticker,
          displayUrl: upgradeStickerImageUrl(sticker.url),
        }));
        paintComposerStickerSuggestions();
      } catch (_) {
        if (seq === composerStickerSuggestionSeq) clearComposerStickerSuggestions();
      }
    }, 90);
  }

  function applyComposerSendButtonState(btn, state) {
    if (!btn) return;
    const prevMode = btn.dataset.sendMode || '';
    if (prevMode === state.mode) return;
    btn.dataset.sendMode = state.mode;
    btn.classList.toggle('is-advance-mode', state.mode === 'advance');
    btn.classList.toggle('is-stop-mode', state.mode === 'stop');
    btn.setAttribute('aria-label', state.label);
    // 海/窗与匿名壳保留原有圆形图标键；手账主题使用文字发送键。
    btn.innerHTML = useCompactComposerMarkup ? state.iconHtml : `<span>${esc(state.label)}</span>`;
  }

  function applyWechatFlowControlState(btn, state) {
    if (!btn || !wechatChatPlatform) return;
    const stopping = state.mode === 'stop';
    const action = stopping ? 'stop' : 'advance';
    const label = stopping ? '停止生成' : (isGroup ? '让聊天继续' : '听 TA 继续说');
    btn.dataset.act = action;
    btn.disabled = false;
    btn.classList.toggle('is-stop-mode', stopping);
    btn.setAttribute('aria-label', label);
    btn.setAttribute('title', label);
  }

  function syncComposerSendButton() {
    const state = composerSendButtonState();
    applyComposerSendButtonState(container.querySelector('.chat-composer-send'), state);
    applyWechatFlowControlState(container.querySelector('[data-wechat-flow-control]'), state);
    const wechatMoreBtn = container.querySelector('.chat-thread-composer--wechat .chat-composer-more');
    if (wechatMoreBtn) wechatMoreBtn.disabled = state.mode === 'stop';
  }

  function renderComposerFooter() {
    const sendState = composerSendButtonState();
    const sendModeClass = sendState.mode === 'advance' ? ' is-advance-mode' : sendState.mode === 'stop' ? ' is-stop-mode' : '';
    // 手机视角与旁观模式都复用普通聊天输入栏，只锁住不允许发送的入口。
    const phoneInputLocked = isPhoneInputLocked();
    const observerInputLocked = isObserverInputLocked();
    const composerInputLocked = phoneInputLocked || observerInputLocked;
    const phoneProxyActive = fromCharacterPhone && phoneProxyMode && chatPrefs.guidanceMode !== true;
    const phoneModeClass = phoneProxyActive ? ' is-phone-proxy-mode' : '';
    const observerModeClass = observerInputLocked ? ' is-observer-input-locked' : '';
    const generationControlActive = hasActiveGenerationControl();
    const inputDisabledAttr = composerInputLocked || generationControlActive ? 'disabled' : '';
    const mediaDisabledAttr = fromCharacterPhone || observerInputLocked || generationControlActive ? 'disabled' : '';
    const inputPlaceholder = chatPrefs.guidanceMode === true
      ? '描述要调整的扮演问题…'
      : (composerInputLocked
        ? (observerInputLocked ? '旁观模式 · 点推进继续' : '输入已锁定')
        : (phoneProxyActive
          ? `以${resolveUiActorName(phoneViewerId, 'TA')}的身份代发…`
          : (useCompactComposerMarkup ? '写点什么…' : '')));
    const transcribeInlineBtn = `<button type="button" class="chat-anon-inline-btn" data-transcribe aria-label="语音" ${mediaDisabledAttr}>${icon('voice')}</button>`;
    if (wechatChatPlatform && !anonShell) {
      const flowAction = sendState.mode === 'stop' ? 'stop' : 'advance';
      const flowLabel = sendState.mode === 'stop' ? '停止生成' : (isGroup ? '让聊天继续' : '听 TA 继续说');
      return `
      <footer class="chat-thread-composer chat-thread-composer--wechat${phoneInputLocked ? ' is-phone-input-locked' : ''}${observerModeClass}${phoneModeClass}">
        ${renderComposerMentionSuggestions()}
        ${renderComposerStickerSuggestions()}
        <button type="button" class="wechat-composer-btn wechat-composer-voice${sendState.mode === 'stop' ? ' is-stop-mode' : ''}" data-wechat-flow-control data-act="${flowAction}" aria-label="${flowLabel}" title="${flowLabel}">${wechatGlyph('voice-input')}</button>
        <div class="wechat-composer-input-shell">
          <textarea class="chat-composer-input" rows="1" placeholder="${esc(inputPlaceholder)}" ${inputDisabledAttr} ${composerInputLocked ? 'readonly' : ''}>${esc(composerInputLocked ? '' : composerDraftText)}</textarea>
          <button type="button" class="wechat-composer-inline-mic" data-transcribe aria-label="语音转文字" ${mediaDisabledAttr}>${wechatGlyph('mic')}</button>
        </div>
        <button type="button" class="wechat-composer-btn" data-stickers aria-label="表情" ${mediaDisabledAttr}>${wechatGlyph('emoji')}</button>
        <button type="button" class="wechat-composer-btn chat-composer-more${toolsOpen ? ' is-open' : ''}" data-tools aria-label="更多内容" ${generationControlActive ? 'disabled' : ''}>${wechatGlyph('plus')}</button>
        <button type="button" class="chat-composer-send wechat-composer-send${sendModeClass}" aria-label="${sendState.label}"><span>${esc(sendState.label)}</span></button>
      </footer>`;
    }
    if (qqChatPlatform && !qqLegacyCssCompat && !anonShell) {
      return `
      <footer class="chat-thread-composer chat-thread-composer--qq${phoneInputLocked ? ' is-phone-input-locked' : ''}${observerModeClass}${phoneModeClass}">
        ${renderComposerMentionSuggestions()}
        ${renderComposerStickerSuggestions()}
        <div class="chat-composer-input-row">
          <textarea class="chat-composer-input" rows="1" placeholder="${esc(inputPlaceholder)}" ${inputDisabledAttr} ${composerInputLocked ? 'readonly' : ''}>${esc(composerInputLocked ? '' : composerDraftText)}</textarea>
          <button type="button" class="chat-composer-send${sendModeClass}" aria-label="${sendState.label}"><span>${esc(sendState.label)}</span></button>
        </div>
        <div class="chat-composer-strip chat-composer-side chat-composer-strip--qq">
          <button type="button" class="chat-composer-btn" data-transcribe aria-label="语音" ${mediaDisabledAttr}>${icon('voice')}</button>
          <button type="button" class="chat-composer-btn" data-pick-image aria-label="相册" ${mediaDisabledAttr}>${icon('image')}</button>
          <button type="button" class="chat-composer-btn" data-act="reroll" aria-label="重 roll" ${generationControlActive ? 'disabled' : ''}>${icon('reroll')}</button>
          <button type="button" class="chat-composer-btn" data-tool="video-call" aria-label="视频通话" ${mediaDisabledAttr}>${icon('videoCallSolid')}</button>
          <button type="button" class="chat-composer-btn" data-stickers aria-label="表情" ${mediaDisabledAttr}>${icon('sticker')}</button>
          <button type="button" class="chat-composer-btn chat-composer-more${toolsOpen ? ' is-open' : ''}" data-tools aria-label="更多内容">${icon('plusCircle')}</button>
        </div>
      </footer>`;
    }
    if (useCompactComposerMarkup) {
      return `
      <footer class="chat-thread-composer chat-thread-composer--anon${phoneInputLocked ? ' is-phone-input-locked' : ''}${observerModeClass}${phoneModeClass}">
        ${renderComposerMentionSuggestions()}
        ${renderComposerStickerSuggestions()}
        <button type="button" class="chat-anon-icon-btn" data-tools aria-label="更多内容">${icon('plus')}</button>
        <div class="chat-anon-input-shell">
          <button type="button" class="chat-anon-inline-btn" data-stickers aria-label="表情" ${mediaDisabledAttr}>${icon('sticker')}</button>
          <textarea class="chat-composer-input" rows="1" placeholder="${esc(inputPlaceholder)}" ${inputDisabledAttr} ${composerInputLocked ? 'readonly' : ''}>${esc(composerInputLocked ? '' : composerDraftText)}</textarea>
          <button type="button" class="chat-anon-inline-btn" data-pick-image aria-label="图片" ${mediaDisabledAttr}>${icon('image')}</button>
          ${transcribeInlineBtn}
        </div>
        <button type="button" class="chat-composer-send chat-anon-send${sendModeClass}" aria-label="${sendState.label}">${sendState.iconHtml}</button>
      </footer>`;
    }
    // 手账主题保留两行输入结构。
    return `
      <footer class="chat-thread-composer${phoneInputLocked ? ' is-phone-input-locked' : ''}${observerModeClass}${phoneModeClass}">
        ${renderComposerMentionSuggestions()}
        ${renderComposerStickerSuggestions()}
        <div class="chat-composer-input-row">
          <textarea class="chat-composer-input" rows="1" placeholder="${esc(inputPlaceholder)}" ${inputDisabledAttr} ${composerInputLocked ? 'readonly' : ''}>${esc(composerInputLocked ? '' : composerDraftText)}</textarea>
          <button type="button" class="chat-composer-send${sendModeClass}" aria-label="${sendState.label}"><span>${esc(sendState.label)}</span></button>
        </div>
        <div class="chat-composer-strip chat-composer-side">
          <button type="button" class="chat-composer-btn" data-transcribe aria-label="语音" ${mediaDisabledAttr}>${icon('voice')}</button>
          <button type="button" class="chat-composer-btn" data-pick-image aria-label="图片" ${mediaDisabledAttr}>${icon('image')}</button>
          <button type="button" class="chat-composer-btn" data-stickers aria-label="表情包" ${mediaDisabledAttr}>${icon('sticker')}</button>
          <span class="chat-composer-strip-spacer"></span>
          <button type="button" class="chat-composer-btn chat-composer-more${toolsOpen ? ' is-open' : ''}" data-tools aria-label="更多内容">${icon('plus')}</button>
        </div>
      </footer>
    `;
  }

  function renderAnonToolsSheet() {
    // 消息类快捷工具（发图/语音/红包等）在生成中禁用，跟以前「+」整体禁用时效果一致；
    // 剧情/长截图/代发等非发送类操作不受影响，生成中也能用。
    const item = (tool, label, ic) => `<button type="button" class="chat-anon-tool" data-tool="${tool}" ${isStreaming ? 'disabled' : ''}>${icon(ic || tool)}<span>${label}</span></button>`;
    const act = (actName, label, ic, disabled) => `<button type="button" class="chat-anon-tool" data-act="${actName}" ${disabled ? 'disabled' : ''}>${icon(ic)}<span>${label}</span></button>`;
    if (fromCharacterPhone) {
      return `
      <div class="chat-tools-sheet chat-tools-sheet--anon ${toolsOpen ? 'is-open' : ''}">
        <div class="chat-anon-tools-grid">
          ${act('phone-proxy', phoneProxyMode ? '退出代发' : '代发消息', 'roleSay', isStreaming)}
          ${act('reroll', '重 roll', 'reroll', isStreaming)}
          ${act('plot', '剧情', 'settings')}
          ${act('offline-ff', '线下小剧场', 'chevronsRight')}
          ${act('scroll-capture', '长截图', 'screenshot')}
          ${act('debug-raw', '上轮原文', 'message')}
        </div>
      </div>`;
    }
    if (isObserverInputLocked()) {
      return `
      <div class="chat-tools-sheet chat-tools-sheet--anon ${toolsOpen ? 'is-open' : ''}">
        <div class="chat-anon-tools-grid">
          ${act('reroll', '重 roll', 'reroll', isStreaming)}
          ${act('plot', '剧情', 'settings')}
          ${act('scroll-capture', '长截图', 'screenshot')}
          ${act('gacha', '扭蛋', 'gacha')}
          ${act('narrator', '旁白', 'edit')}
          ${act('gap-fill', '闲聊补充', 'gapFill')}
          ${act('debug-raw', '上轮原文', 'message')}
          ${isGroup ? act('description', '会话描述', 'settings') : ''}
        </div>
      </div>`;
    }
    return `
      <div class="chat-tools-sheet chat-tools-sheet--anon ${toolsOpen ? 'is-open' : ''}">
        <div class="chat-anon-tools-grid">
          ${act('reroll', '重roll', 'reroll', isStreaming)}
          ${act('plot', '剧情', 'settings')}
          ${!isGroup && !anonShell ? act('aliases', '马甲', 'roleSay') : ''}
          ${item('search', '搜索')}
          ${canOfferOfflinePhoneTakeover ? item('phone-takeover', '请 TA 代回', 'smartphone') : ''}
          ${item('image', '图片')}
          ${item('draw', '生图', 'sparkle')}
          ${item('voice-call', '通话', qqChatPlatform ? 'voiceCallSolid' : 'voiceCall')}
          ${item('video-call', '视频', qqChatPlatform ? 'videoCallSolid' : 'videoCall')}
          ${item('textimg', '文字图')}
          ${item('location', '位置', 'pin')}
          ${item('link', '链接')}
          ${item('redpacket', '红包')}
          ${item('transfer', '转账')}
          ${item('ordershare', '购物', 'ordershare')}
          ${isGroup ? item('vote', '投票') : ''}
          ${item('dice', '骰子')}
          ${act('scroll-capture', '长截图', 'screenshot')}
          ${act('gacha', '扭蛋', 'gacha')}
          ${!userAbsentGroup ? act('rolesay', sendAsCharacterId ? '取消代发' : '代发', 'roleSay') : ''}
          ${act('narrator', '旁白', 'edit')}
          ${act('gap-fill', '闲聊补充', 'gapFill')}
          ${!anonShell ? act('guidance', '指导', 'book') : ''}
          ${!anonShell ? act('offline-ff', '线下小剧场', 'chevronsRight') : ''}
          ${!anonShell ? act('enter-offline', userAbsentGroup ? '进入旁观线下' : '直接进线下', 'zap') : ''}
          ${!isGroup && !anonShell ? act('invite-offline', '约 TA 线下', 'pin') : ''}
          ${act('debug-raw', '上轮原文', 'message')}
          ${isGroup ? act('description', '会话描述', 'settings') : ''}
        </div>
      </div>`;
  }

  function renderToolsSheet() {
    // 消息类快捷工具（发图/语音/红包等）在生成中禁用，跟以前「+」整体禁用时效果一致；
    // 剧情/长截图/代发等非发送类操作不受影响，生成中也能用。
    const toolDisabled = isStreaming ? 'disabled' : '';
    const act = (actName, label, ic, disabled, badge = '') => ({
      id: `act:${actName}`,
      label,
      iconName: ic,
      html: `<button type="button" class="chat-tool-item" data-act="${actName}" data-tool-order-id="act:${actName}" aria-label="${label}${badge ? `（${badge}）` : ''}" ${disabled ? 'disabled' : ''}>${icon(ic)}<span class="chat-tool-label">${label}${badge ? `<small class="chat-tool-beta">${badge}</small>` : ''}</span></button>`,
    });
    const item = (tool, label, ic) => ({
      id: `tool:${tool}`,
      label,
      iconName: ic || tool,
      html: `<button type="button" class="chat-tool-item" data-tool="${tool}" data-tool-order-id="tool:${tool}" ${toolDisabled}>${icon(ic || tool)}<span class="chat-tool-label">${label}</span></button>`,
    });
    const tools = (fromCharacterPhone ? [
      act('phone-proxy', phoneProxyMode ? '退出代发' : '代发消息', 'roleSay', isStreaming),
      act('reroll', '重roll', 'reroll', isStreaming),
      act('plot', '剧情', 'settings'),
      act('offline-ff', '线下小剧场', 'chevronsRight'),
      act('scroll-capture', '长截图', 'screenshot'),
      act('debug-raw', '上一轮原文', 'message'),
    ] : isObserverInputLocked() ? [
      act('reroll', '重roll', 'reroll', isStreaming),
      act('plot', '剧情', 'settings'),
      act('scroll-capture', '长截图', 'screenshot'),
      act('gacha', '扭蛋机', 'gacha'),
      act('narrator', '插入旁白', 'edit'),
      act('gap-fill', '闲聊补充', 'gapFill'),
      !anonShell ? act('guidance', '指导', 'book') : '',
      !anonShell ? act('offline-ff', '线下小剧场', 'chevronsRight') : '',
      !anonShell ? act('enter-offline', userAbsentGroup ? '进入旁观线下' : '直接进线下', 'zap') : '',
      act('debug-raw', '上一轮原文', 'message'),
      isGroup ? act('description', '会话描述', 'settings') : '',
    ] : [
      act('reroll', '重roll', 'reroll', isStreaming),
      act('plot', '剧情', 'settings'),
      !isGroup && !anonShell ? act('interaction', '互动', 'sparkle', isStreaming, '测试中') : '',
      !isGroup && !anonShell ? act('aliases', '马甲', 'roleSay') : '',
      item('search', '搜索'),
      canOfferOfflinePhoneTakeover ? item('phone-takeover', '请 TA 代回', 'smartphone') : '',
      item('image', '图片'),
      item('draw', '生图', 'sparkle'),
      item('voice-call', '通话', qqChatPlatform ? 'voiceCallSolid' : 'voiceCall'),
      item('video-call', '视频', qqChatPlatform ? 'videoCallSolid' : 'videoCall'),
      item('textimg', '文字图'),
      item('location', '位置', 'pin'),
      item('link', '链接'),
      item('redpacket', '红包'),
      item('transfer', '转账'),
      item('ordershare', '购物分享', 'ordershare'),
      isGroup ? item('vote', '投票') : '',
      item('dice', '骰子'),
      act('scroll-capture', '长截图', 'screenshot'),
      act('gacha', '扭蛋机', 'gacha'),
      !userAbsentGroup ? act('rolesay', sendAsCharacterId ? '取消代发' : '代发角色', 'roleSay') : '',
      act('narrator', '插入旁白', 'edit'),
      act('gap-fill', '闲聊补充', 'gapFill'),
      !anonShell ? act('guidance', '指导', 'book') : '',
      !anonShell ? act('offline-ff', '线下小剧场', 'chevronsRight') : '',
      !anonShell ? act('enter-offline', userAbsentGroup ? '进入旁观线下' : '直接进线下', 'zap') : '',
      !isGroup && !anonShell ? act('invite-offline', '约 TA 线下', 'pin') : '',
      act('debug-raw', '上一轮原文', 'message'),
      isGroup ? act('description', '会话描述', 'settings') : '',
    ]).filter(Boolean);
    let orderedTools = sortChatToolbarItems(tools, chatToolOrder);
    // 每页严格按 4×2 连续填满；条件工具被隐藏后，后续项立即向前补位，
    // 不再为了均分总页数而让每一页都留下空槽。
    const PAGE_SIZE = 8;
    const pages = paginateChatToolbarItems(orderedTools, PAGE_SIZE);
    return `
      <div class="chat-tools-sheet ${toolsOpen ? 'is-open' : ''}">
        <div class="chat-tools-pager" data-tools-pager>
          ${pages.map((page) => `<div class="chat-tools-page">${page.map((tool) => tool.html).join('')}</div>`).join('')}
        </div>
        ${pages.length > 1 ? `<div class="chat-tools-dots" data-tools-dots>${pages.map((_, i) => `<i${i === 0 ? ' class="is-on"' : ''}></i>`).join('')}</div>` : ''}
        <button type="button" class="chat-tools-order-trigger" data-tools-order>${icon('settings')}<span>调整顺序</span></button>
      </div>`;
  }

  function openToolsOrderEditor() {
    const visibleButtons = Array.from(container.querySelectorAll('.chat-tools-pager .chat-tool-item[data-tool-order-id]'));
    const visibleItems = visibleButtons.map((button) => ({
      id: button.getAttribute('data-tool-order-id') || '',
      label: button.getAttribute('aria-label')?.replace(/（测试中）$/, '')
        || button.querySelector('.chat-tool-label')?.textContent?.trim()
        || '',
      iconHtml: button.querySelector('.svg-icon')?.outerHTML || '',
    })).filter((item) => item.id && item.label);
    const visibleIds = new Set(visibleItems.map((item) => item.id));
    const defaultIds = CHAT_TOOL_DEFAULT_ORDER.filter((id) => visibleIds.has(id));
    openChatToolbarOrderModal({
      items: visibleItems,
      defaultIds,
      onSave: async (nextVisibleOrder) => {
        chatToolOrder = mergeVisibleChatToolOrder(chatToolOrder, nextVisibleOrder);
        const latestPrefs = await loadAppearancePrefs();
        const saved = await saveAppearancePrefs({ ...latestPrefs, chatToolOrder });
        chatToolOrder = normalizeChatToolOrder(saved.chatToolOrder);
        const currentSheet = container.querySelector('.chat-tools-sheet:not(.chat-tools-sheet--anon)');
        if (currentSheet) currentSheet.outerHTML = renderToolsSheet();
        showToast('工具顺序已保存');
      },
      onError: (error) => showToast(error?.message || '保存失败'),
    });
  }

  let interactionPlanInFlight = false;
  let interactionOpeningSessionId = '';

  function interactionCharacter() {
    return characters[partnerId] || partner || null;
  }

  async function saveInteractionSession(session) {
    chatPrefs = await patchChatPrefs(chatId, {
      interactionSession: session || null,
    });
    if (session) {
      const { cancelPendingActions } = await import('../core/chat/pending-actions.js');
      await cancelPendingActions(user.id, (action) => (
        action.kind === 'interaction_invite'
        && action.chatId === chatId
        && action.characterId === partnerId
      ));
    }
    return normalizeChatInteractionSession(chatPrefs.interactionSession);
  }

  async function prepareChatInteractionDraft({
    kind = 'arrange',
    template = null,
    currentPlan = null,
    revisionRequest = '',
  } = {}) {
    if (interactionPlanInFlight) throw new Error('TA 还在调整上一版草案');
    if (isStreaming || getChatStreamSession(chatId)) throw new Error('请等当前回复结束后再筹划互动');
    const character = interactionCharacter();
    if (!character || isGroup || anonShell || fromCharacterPhone) {
      throw new Error('当前会话暂不支持互动筹划');
    }
    interactionPlanInFlight = true;
    try {
      return await planChatInteraction({
        chatId,
        chat,
        character,
        characters,
        user,
        messages,
        contextDepth: chatPrefs.contextDepth,
        template,
        currentPlan,
        revisionRequest,
        forcePropose: true,
        initiator: revisionRequest ? 'user-revision' : 'user',
      });
    } catch (error) {
      showGenerationErrorReport(generationErrorFromCatch(error, {
        scope: '聊天 / 互动筹划',
        operation: '让 TA 安排',
        title: '互动筹划失败',
        rawText: error?.rawText || error?.rawResponse || '',
      }));
      throw error;
    } finally {
      interactionPlanInFlight = false;
    }
  }

  function compactInteractionTemplate(template = null) {
    if (!template) return null;
    return {
      id: String(template.id || '').trim(),
      kind: String(template.kind || '').trim(),
      name: String(template.name || '').trim(),
      summary: String(template.summary || '').trim(),
      brief: String(template.brief || '').trim(),
      builtin: template.builtin === true,
    };
  }

  async function deliverChatInteractionOpening({
    kind = 'arrange',
    template = null,
    plan = {},
    mode = 'negotiate',
  } = {}) {
    if (isStreaming || getChatStreamSession(chatId)) throw new Error('请等当前回复结束后再开始互动');
    const confirmedPlan = normalizeChatInteractionPlan(plan, { forcePropose: true });
    if (!confirmedPlan.title || !confirmedPlan.summary || !confirmedPlan.proposal) {
      throw new Error('互动草案还不完整');
    }
    const blackbox = mode === 'blackbox';
    const session = createChatInteractionSession(confirmedPlan, {
      source: blackbox ? 'manual-blackbox' : (kind === 'template' ? 'template' : 'manual-arrange'),
      template,
    });
    const recoveryDraft = {
      mode: blackbox ? 'blackbox' : 'negotiate',
      kind,
      template: compactInteractionTemplate(template),
      plan: confirmedPlan,
      openingSessionId: session.id,
      failedAt: 0,
    };
    await saveInteractionSession(session);
    chatPrefs = await patchChatPrefs(chatId, { interactionDraft: recoveryDraft });
    interactionOpeningSessionId = session.id;
    window.setTimeout(() => {
      Promise.resolve(runAiReply('advance', { manualRequest: true }))
        .then(async (outcome) => {
          const result = outcome?.result;
          const delivered = result?.ok === true && !result?.busyGate && !result?.silentBusy;
          if (delivered) {
            interactionOpeningSessionId = '';
            chatPrefs = await patchChatPrefs(chatId, { interactionDraft: null });
            return;
          }
          const active = normalizeChatInteractionSession(chatPrefs.interactionSession);
          if (active?.id !== session.id) return;
          chatPrefs = await patchChatPrefs(chatId, {
            interactionSession: null,
            interactionDraft: {
              ...recoveryDraft,
              failedAt: Date.now(),
            },
          });
          interactionOpeningSessionId = '';
          showToast('互动没有成功开场，预案已保留在互动里', 5000);
        })
        .catch(async (error) => {
          const active = normalizeChatInteractionSession(chatPrefs.interactionSession);
          if (active?.id === session.id) {
            chatPrefs = await patchChatPrefs(chatId, {
              interactionSession: null,
              interactionDraft: {
                ...recoveryDraft,
                failedAt: Date.now(),
              },
            });
          }
          interactionOpeningSessionId = '';
          showGenerationErrorReport(generationErrorFromCatch(error, {
            scope: '聊天 / 互动开场',
            operation: '开始互动',
            title: '互动开场失败',
            rawText: error?.rawText || error?.rawResponse || '',
          }));
          showToast('互动没有成功开场，预案已保留在互动里', 5000);
        });
    }, 0);
  }

  async function confirmChatInteractionDraft({ kind = 'arrange', template = null, plan = {} } = {}) {
    return deliverChatInteractionOpening({ kind, template, plan, mode: 'negotiate' });
  }

  async function startBlackboxChatInteraction({ template = null, plan = null } = {}) {
    showToast(plan ? '正在重新开场…' : 'TA 正在准备…', 2200);
    const hiddenPlan = plan || await prepareChatInteractionDraft({
      kind: template ? 'template' : 'blackbox',
      template,
    });
    return deliverChatInteractionOpening({
      kind: template ? 'template' : 'blackbox',
      template,
      plan: hiddenPlan,
      mode: 'blackbox',
    });
  }

  async function openChatInteractionLibrary() {
    if (isGroup || anonShell || fromCharacterPhone) {
      showToast('当前会话暂不支持互动筹划');
      return;
    }
    const { openChatInteractionsModal } = await import('../components/chat-interactions-modal.js');
    await openChatInteractionsModal({
      userId: user.id,
      characterName: resolveUiActorName(partnerId, partner?.name || 'TA'),
      proactiveEnabled: chatPrefs.interactionProactiveEnabled === true,
      session: chatPrefs.interactionSession,
      pendingDraft: chatPrefs.interactionDraft,
      onToggleProactive: async (enabled) => {
        chatPrefs = await patchChatPrefs(chatId, {
          interactionProactiveEnabled: enabled === true,
        });
        if (!enabled) {
          const { cancelPendingActions } = await import('../core/chat/pending-actions.js');
          await cancelPendingActions(user.id, (action) => (
            action.kind === 'interaction_invite'
            && action.chatId === chatId
            && action.characterId === partnerId
          ));
        }
        showToast(enabled ? '已允许 TA 安排主动互动' : '已关闭主动互动');
      },
      onPrepare: prepareChatInteractionDraft,
      onConfirm: confirmChatInteractionDraft,
      onBlackbox: startBlackboxChatInteraction,
      onDiscardDraft: async () => {
        chatPrefs = await patchChatPrefs(chatId, { interactionDraft: null });
      },
      onEnd: async () => {
        await saveInteractionSession(null);
        showToast('这次互动已结束');
      },
      onError: (error) => showToast(error?.message || '操作失败'),
    });
  }

  async function prepareChatInteractionDirective({
    mode = 'advance',
    realPersonChase = false,
  } = {}) {
    if (isGroup || anonShell || fromCharacterPhone || chatPrefs.guidanceMode === true) return null;
    if (mode !== 'advance' || realPersonChase) return null;
    let session = normalizeChatInteractionSession(chatPrefs.interactionSession);
    if (!session && chatPrefs.interactionSession) {
      chatPrefs = await patchChatPrefs(chatId, { interactionSession: null });
    }
    if (session) {
      const recovery = chatPrefs.interactionDraft;
      if (
        session.openingPending === true
        && recovery?.openingSessionId === session.id
        && interactionOpeningSessionId !== session.id
      ) {
        chatPrefs = await patchChatPrefs(chatId, { interactionSession: null });
        return null;
      }
      return {
        sessionId: session.id,
        opening: session.openingPending === true,
        text: buildChatInteractionDirective(session, { opening: session.openingPending === true }),
      };
    }
    return null;
  }

  function renderComposer() {
    const replyPanel = useAnonComposerMarkup ? 'chat-reply-bar' : 'chat-reply-bar scrapbook-panel';
    return `
      ${replyTarget ? `
        <div class="${replyPanel}">
          <span>回复 ${esc(currentReplyTargetLabel())}：${esc(replyTarget.preview || '')}</span>
          <button type="button" class="chat-reply-cancel" data-cancel-reply aria-label="取消回复">${icon('close')}</button>
        </div>
      ` : ''}
      ${renderSelectionBar()}
      ${renderComposerFooter()}
      ${renderToolsSheet()}
      <input type="file" class="chat-image-input" accept="image/*" hidden />
    `;
  }

  function buildAnonymousProfiles() {
    const map = {};
    if (!isAnonymousChat(chat)) return map;
    const ids = new Set((chat.participants || []).filter(Boolean));
    // 告解室换人后，历史消息的 senderId 不在当前 participants 里；
    // 把曾经写过 identity 的 actor 也补上，避免他的旧消息头像被新来客顶掉。
    if (isCyberConfessionChat(chat)) {
      const idMap = chat.groupSettings?.anonymousIdentities
        || chat.anonymousPrivateConfig?.identities
        || {};
      for (const aid of Object.keys(idMap)) if (aid) ids.add(aid);
    }
    for (const pid of ids) {
      const profile = getAnonymousDisplayProfile(chat, pid, {
        currentUserName,
        spaceProfile: anonSpaceProfile,
        actorSpaceProfiles,
      });
      if (profile) map[pid] = profile;
    }
    return map;
  }

  function setReplyTo(msg) {
    if (!msg || msg.senderId === 'system' || msg.recalled) return;
    const normalized = normalizeMsgForUi(msg);
    replyTarget = {
      raw: msg,
      senderName: resolveReplySenderLabel(msg),
      preview: getReplyContentPreview(normalized).slice(0, 60),
    };
    refreshReplyBar();
    window.requestAnimationFrame(() => {
      container.querySelector('.chat-composer-input')?.focus();
    });
  }

  async function syncGeneratingImageMessagesFromDb() {
    const pending = messages.filter((m) => m?.id && m?.metadata?.generatingImage);
    if (!pending.length) return false;
    let changed = false;
    await Promise.all(pending.map(async (m) => {
      // IndexedDB 读取是异步的：读到旧的「生成中」快照后，重 roll 可能已经完成并把
      // 本地列表替换成真图。不能让这次迟到的轮询再把真图写回「卡住 / 重 roll」占位。
      const snapshot = [
        String(m.content || ''),
        String(m.metadata?.url || ''),
        !!m.metadata?.generatingImage,
        !!m.metadata?.generationFailed,
        String(m.metadata?.generationError || ''),
        String(m.metadata?.generationStage || ''),
        Number(m.metadata?.generationStartedAt || 0),
      ].join('\u0001');
      if (isGenImageStuck(m)) {
        await recoverInterruptedGeneratedImageMessage(m.id).catch(() => null);
      }
      const fresh = await getRecord('messages', m.id).catch(() => null);
      if (!fresh) return;
      const idx = messages.findIndex((x) => x.id === m.id);
      if (idx < 0) return;
      const prev = messages[idx];
      const current = [
        String(prev.content || ''),
        String(prev.metadata?.url || ''),
        !!prev.metadata?.generatingImage,
        !!prev.metadata?.generationFailed,
        String(prev.metadata?.generationError || ''),
        String(prev.metadata?.generationStage || ''),
        Number(prev.metadata?.generationStartedAt || 0),
      ].join('\u0001');
      if (current !== snapshot) return;
      const prevGen = !!prev?.metadata?.generatingImage;
      const nextGen = !!fresh?.metadata?.generatingImage;
      const prevFail = !!prev?.metadata?.generationFailed;
      const nextFail = !!fresh?.metadata?.generationFailed;
      const prevContent = String(prev?.content || '');
      const nextContent = String(fresh?.content || '');
      const prevStage = String(prev?.metadata?.generationStage || '');
      const nextStage = String(fresh?.metadata?.generationStage || '');
      const prevStuck = isGenImageStuck(prev);
      const nextStuck = isGenImageStuck(fresh);
      if (
        prevGen === nextGen
        && prevFail === nextFail
        && prevContent === nextContent
        && prevStage === nextStage
        && prevStuck === nextStuck
      ) return;
      messages[idx] = mergeImageStateMonotonically(prev, fresh);
      changed = true;
    }));
    if (changed) lastPaintSnapshot = null;
    return changed;
  }

  function scheduleGenImageStatusRefresh() {
    if (container._genImageStatusTimer) {
      clearTimeout(container._genImageStatusTimer);
      container._genImageStatusTimer = null;
    }
    const hasGenerating = messages.some((m) => m?.metadata?.generatingImage);
    if (!hasGenerating || !container.isConnected) return;
    // 生图在后台跑，占位气泡只活在内存里；必须回读 IndexedDB，
    // 否则界面会一直停在「生成中 / 卡住」，退出重进才能看到图。
    // 注意：只有真正变了才整表重绘——之前「还在生成中就每 2.5s refresh」会重启转圈动画，看起来像半透明图一直闪。
    container._genImageStatusTimer = setTimeout(() => {
      container._genImageStatusTimer = null;
      if (!container.isConnected) return;
      void (async () => {
        const changed = await syncGeneratingImageMessagesFromDb();
        if (!container.isConnected) return;
        if (changed) refreshMessages();
        else if (messages.some((m) => m?.metadata?.generatingImage)) scheduleGenImageStatusRefresh();
      })();
    }, 2500);
  }

  function markLocalImageGenerating(msgId, patch = {}) {
    const idx = messages.findIndex((m) => m?.id === msgId);
    if (idx < 0) return;
    const cur = messages[idx];
    messages[idx] = {
      ...cur,
      content: '',
      metadata: {
        ...(cur.metadata || {}),
        generatingImage: true,
        generationFailed: false,
        generationError: '',
        generationErrorCode: '',
        generationErrorElapsedMs: 0,
        generationErrorTarget: '',
        generationResultUnknown: false,
        generationRetryUnsafe: false,
        generationFailedAt: 0,
        generationStartedAt: Date.now(),
        ...patch,
      },
    };
    lastPaintSnapshot = null;
    refreshMessages();
    scheduleGenImageStatusRefresh();
  }

  async function refreshGeneratedImageMessageFromDb(msgId) {
    const id = String(msgId || '').trim();
    if (!id) return null;
    const fresh = await getRecord('messages', id).catch(() => null);
    if (!fresh || String(fresh.chatId || '') !== String(chatId) || fresh.type !== 'image') {
      messages = await listThreadMessages();
      lastPaintSnapshot = null;
      refreshMessages();
      return null;
    }

    const idx = messages.findIndex((message) => String(message?.id || '') === id);
    const display = deferHeavyMediaForDisplay(fresh);
    if (idx >= 0) {
      messages[idx] = display;
    } else {
      messages = [...messages, display]
        .sort((a, b) => Number(a?.timestamp || 0) - Number(b?.timestamp || 0));
    }

    // 重 roll 后消息 id 不变，但媒体内容已经换版。先强制重画这一版占位，
    // 再只为当前图片立即取回完整内容，不等观察器轮询，也不重扫整段会话。
    lastPaintSnapshot = null;
    refreshMessages();
    const main = container.querySelector('.chat-thread-messages');
    const safeId = escapeMsgIdForSelector(id);
    const row = safeId ? main?.querySelector(`[data-msg-id="${safeId}"]`) : null;
    const placeholder = row?.querySelector('.chat-gen-image-placeholder.is-deferred');
    if (placeholder) await hydrateDeferredImagePlaceholder(placeholder).catch(() => false);
    return fresh;
  }

  async function rerollGenImageFromUi(msg, rerollOptions = {}) {
    if (!msg?.id) throw new Error('消息不存在');
    // 立刻切到「正在生成」占位，不要等整次 API 跑完才换画面。
    markLocalImageGenerating(msg.id, {
      prompt: String(rerollOptions.promptOverride || msg.metadata?.prompt || '').trim() || msg.metadata?.prompt,
    });
    try {
      const url = await rerollGeneratedImageMessage(msg.id, {
        user: frontStageUserProfile(),
        characters: frontStageCharacterProfiles(),
        ...rerollOptions,
      });
      await refreshGeneratedImageMessageFromDb(msg.id);
      return url;
    } catch (err) {
      await refreshGeneratedImageMessageFromDb(msg.id);
      throw err;
    }
  }

  function isImageGenerationResultUnknown(msg) {
    const metadata = msg?.metadata || {};
    if (metadata.generationResultUnknown === true || metadata.generationRetryUnsafe === true) return true;
    return /等待约\s*\d+\s*秒后失败|请求(?:很)?可能已经到达服务端|结果未知|可能仍在服务端处理/i
      .test(String(metadata.generationError || ''));
  }

  function confirmUnknownImageReplay(msg) {
    if (!isImageGenerationResultUnknown(msg)) return true;
    return window.confirm(
      '上一笔生图在等待结果时断线，服务端可能已经生成并计费。\n\n'
      + '请先检查中转或服务端的生成记录；确认没有结果后，再继续重新生成。\n\n'
      + '仍要发起一笔新的生图请求吗？',
    );
  }

  function chatStreamPlaceholderText(session = null) {
    // 准备、提交和等待响应都是同一个“角色正在输入”状态。内部传输阶段不应
    // 变成聊天气泡文案，更不应要求用户为了实现细节一直停留前台。
    void session;
    return '正在输入…';
  }

  function setStreamingPlaceholderVisible(show = true, text = '正在输入…') {
    const main = container.querySelector('.chat-thread-messages');
    if (!main || messagesLoading) return;
    const existing = main.querySelector('[data-stream-placeholder]');
    if (!show) {
      const liveStream = getChatStreamSession(chatId);
      const stillTyping = (
        !!(liveStream && !liveStream.abortController?.signal?.aborted)
        || (headlessReplyVisible && isHeadlessChatReplyTyping(chatId))
        || cloudTypingVisible
      );
      if (stillTyping) return;
      clearStreamingMessagePreview(main);
      existing?.remove();
      return;
    }
    if (existing) {
      const label = String(text || '正在输入…');
      const indicator = existing.querySelector('.chat-typing-indicator');
      const textNode = existing.querySelector('.chat-typing-label');
      if (indicator) indicator.setAttribute('aria-label', label);
      if (textNode) textNode.textContent = label.replace(/…+$/, '');
      if (holdBottomUntilSettled) pinThreadForActiveStream();
      return;
    }
    const shouldFollowStream = holdBottomUntilSettled || isNearBottom(main, 80);
    const visibleCharacters = frontStageCharacterProfiles();
    main.insertAdjacentHTML('beforeend', renderStreamingPlaceholder(String(text || '正在输入…'), {
      user: frontStageUserProfile(),
      partner: partnerId ? (visibleCharacters[partnerId] || partner) : partner,
      characters: visibleCharacters,
      partnerId: streamPlaceholderActorId(),
      anonymousProfiles: buildAnonymousProfiles(),
    }));
    if (shouldFollowStream) pinThreadForActiveStream();
    else updateScrollBottomFab();
  }

  function clearStreamingMessagePreview(main = container.querySelector('.chat-thread-messages')) {
    if (streamingPreviewTimer) {
      clearTimeout(streamingPreviewTimer);
      streamingPreviewTimer = 0;
    }
    streamingPreviewRawText = '';
    streamingPreviewFingerprint = '';
    main?.querySelectorAll?.('[data-stream-preview]')?.forEach((node) => node.remove());
  }

  function streamPreviewActorId(event = {}) {
    return String(event.from || event.actor || event.senderId || '').trim();
  }

  function streamPreviewBody(event = {}) {
    return String(event.body || event.text || event.content || '').trim();
  }

  function paintStreamingMessagePreview(rawText = '') {
    const main = container.querySelector('.chat-thread-messages');
    if (!main || messagesLoading || !isStreaming || document.hidden || generationWasHiddenThisTurn) return;
    const events = extractMarshmallowStreamPreviewEvents(rawText, {
      chat,
      messages,
      characters,
      currentUserName,
    });
    if (!events.length) return;
    const fingerprint = events.map((event) => (
      `${event.t}|${streamPreviewActorId(event)}|${streamPreviewBody(event)}`
    )).join('\n');
    if (!fingerprint || fingerprint === streamingPreviewFingerprint) return;

    const baseTs = Date.now();
    const previewMessages = events.map((event, index) => {
      const narration = event.t === 'narration';
      const senderId = narration ? 'system' : streamPreviewActorId(event);
      return {
        id: `stream-preview-${index}-${String(event.sourceIndex || index + 1)}`,
        chatId,
        senderId,
        senderName: narration ? '旁白' : resolveUiActorName(senderId, senderId),
        type: narration ? 'system' : 'text',
        content: streamPreviewBody(event),
        timestamp: baseTs + index,
        metadata: {
          aiGenerated: true,
          streamPreview: true,
          narratorBeat: narration,
        },
      };
    }).filter((message) => message.content && (message.senderId || message.type === 'system'));
    if (!previewMessages.length) return;

    const html = renderMessagesHtml(previewMessages, {
      ...buildMessageRenderOptions(buildAnonymousProfiles(), null),
      suppressInitialTimeDivider: true,
    });
    if (!html) return;
    const template = document.createElement('template');
    template.innerHTML = html;
    [...template.content.children].forEach((node) => {
      node.setAttribute('data-stream-preview', '');
      node.classList.add('is-stream-preview');
    });
    const shouldFollowStream = holdBottomUntilSettled || isNearBottom(main, 80);
    main.querySelectorAll('[data-stream-preview]').forEach((node) => node.remove());
    const placeholder = main.querySelector('[data-stream-placeholder]');
    main.insertBefore(template.content, placeholder || null);
    streamingPreviewFingerprint = fingerprint;
    streamingPreviewPaintedThisTurn = true;
    if (!streamingPreviewFirstPaintAt) streamingPreviewFirstPaintAt = Date.now();
    if (shouldFollowStream) pinThreadForActiveStream();
    else updateScrollBottomFab();
  }

  function scheduleStreamingMessagePreview(rawText = '') {
    if (document.hidden || generationWasHiddenThisTurn) return;
    const next = String(rawText || '');
    if (!next || next.length < streamingPreviewRawText.length) return;
    streamingPreviewRawText = next;
    if (streamingPreviewTimer) return;
    // 解析完整对象是随累计文本增长的工作；限制到约每帧动画 6～8 次，避免
    // 高频 SSE 小片段反过来占满低端 Android 的主线程。
    streamingPreviewTimer = setTimeout(() => {
      streamingPreviewTimer = 0;
      paintStreamingMessagePreview(streamingPreviewRawText);
    }, 120);
  }

  // 手机主人视角下「正在输入」放左侧时，头像必须是对方/其他成员，不能落到主人自己头上。
  function streamPlaceholderActorId() {
    if (!fromCharacterPhone) return partnerId;
    return (chat.participants || []).find((p) => p && p !== 'user' && p !== phoneViewerId) || partnerId;
  }

  function openGenImagePromptEditor(msg) {
    const currentPrompt = String(msg?.metadata?.prompt || '').trim();
    if (!currentPrompt) return;
    openTextEditorModal({
      title: '编辑生图提示词',
      value: currentPrompt,
      placeholder: '英文提示词；保存后用新提示词重新生成这张图',
      confirmLabel: '重新生成',
      variant: isAnonymousChat(chat) ? 'anon' : '',
      onSave: async (next) => {
        const prompt = String(next || '').trim();
        if (!prompt) { showToast('提示词不能为空'); return; }
        if (!confirmUnknownImageReplay(msg)) return;
        try {
          await rerollGenImageFromUi(msg, { promptOverride: prompt, forceRegenerate: true });
          showToast('图片已更新');
        } catch (err) {
          messages = await listThreadMessages();
          refreshMessages();
          showToast(`生图失败：${String(err?.message || err).slice(0, 80)}`);
        }
      },
    });
  }

  async function loadFullImageMessage(msg) {
    if (!msg?.metadata?.deferredImage) return msg;
    const fresh = await getRecord('messages', msg.id);
    if (!fresh || fresh.type !== 'image') return msg;
    return fresh;
  }

  function buildMessageRenderOptions(anonymousProfiles, stickerResolver = null) {
    const appr = resolveThreadAppearance(chat);
    const visibleCharacters = frontStageCharacterProfiles();
    return {
      chat,
      isGroup,
      viewerId: fromCharacterPhone ? phoneViewerId : 'user',
      characters: visibleCharacters,
      anonymous: anonymousChat,
      insCard: insChatChrome,
      chatPlatform: qqLegacyCssCompat ? 'current' : chatPlatform,
      chatBlockedByUser: getChatBlockedState(chat, chatPrefs).blocked,
      groupConsecutive: !wechatChatPlatform && !anonymousChat && !!appr.bubbleGrouping,
      selectionMode,
      selectedSet,
      anonymousProfiles,
      memberCards: chat.groupSettings?.memberCards || {},
      memberTitles: chat.groupSettings?.titles || {},
      user: frontStageUserProfile(),
      partner: partnerId ? (visibleCharacters[partnerId] || partner) : partner,
      sessionBubbleOther: appr.bubbleOther || '',
      resolveReplySenderLabel,
      stickerPool: stickerResolver?.full || null,
      stickerPoolForMessage: stickerResolver ? (msg) => stickerResolver.poolForMessage(msg) : null,
      deferStickers: true,
      voicePerformanceModeEnabled: chatPrefs?.voicePerformanceMode === true,
      voicePerformanceContinuousEnabled: chatPrefs?.voicePerformanceContinuous === true,
      messageTimestampMode: chatPrefs?.messageTimestampMode === 'each' ? 'each' : 'last',
      suppressTimeIds: buildWeChatTimeSuppression(),
    };
  }

  function buildStreamPlaceholderHtml(anonymousProfiles) {
    const visibleCharacters = frontStageCharacterProfiles();
    return renderStreamingPlaceholder('正在输入…', {
      user: frontStageUserProfile(),
      partner: partnerId ? (visibleCharacters[partnerId] || partner) : partner,
      characters: visibleCharacters,
      partnerId: streamPlaceholderActorId(),
      anonymousProfiles,
    });
  }

  async function resolveMessageImageSrc(msgId = '') {
    const id = String(msgId || '').trim();
    if (!id) return '';
    let msg = messages.find((m) => m.id === id);
    if (!msg) return '';
    let content = String(msg.content || '').trim();
    let metaUrl = String(msg.metadata?.url || '').trim();
    if (/^data:image\//i.test(content) || /^https?:\/\//i.test(content)) return content;
    if (/^data:image\//i.test(metaUrl) || /^https?:\/\//i.test(metaUrl)) return metaUrl;
    if (msg.metadata?.deferredImage || msg.metadata?.deferredSticker) {
      const fresh = await getRecord('messages', id).catch(() => null);
      if (fresh && (fresh.type === 'image' || fresh.type === 'sticker')) {
        content = String(fresh.content || '').trim();
        metaUrl = String(fresh.metadata?.url || '').trim();
        if (/^data:image\//i.test(content) || /^https?:\/\//i.test(content)) return content;
        if (/^data:image\//i.test(metaUrl) || /^https?:\/\//i.test(metaUrl)) return metaUrl;
      }
    }
    return content || metaUrl;
  }

  // 占位图換成真图 / 表情包图这类异步落地的媒体，加载完成前后常有明显的高度差
  // （占位是估的固定尺寸，真图按实际比例渲染）。如果这时候视图本来就该钉在底部，
  // 图片一加载完，底部往上顶出一截，视觉上就变成"进页/切回来发现没在最新消息"——
  // 尤其生图，第一次进页时占位图正好在可视区、还没下载完，整个"钉底"窗口早就
  // 结束了。这里给还没加载完的 <img> 补一个 load/error 兜底：只要 holdBottomUntilSettled
  // 这个"进页后持续钉底"的开关还没被用户主动上滑关掉，加载完就把视图重新拉回底部；
  // 用户已经手动看历史时（开关已关）完全不触碰，不会把正在翻看的人猛地拽下去。
  function stickBottomOnLateImageLoad(img) {
    if (!img || img.tagName !== 'IMG' || img.dataset.stickBound === '1') return;
    img.dataset.stickBound = '1';
    if (img.complete) return;
    const onSettle = () => {
      if (isBubbleRevealActive()) return;
      const main = container.querySelector('.chat-thread-messages');
      if (!main) return;
      if (holdBottomUntilSettled) main.scrollTop = main.scrollHeight;
      else restoreHistoryViewportState(main, stableHistoryViewportState);
    };
    img.addEventListener('load', onSettle, { once: true });
    img.addEventListener('error', onSettle, { once: true });
  }

  function bindPendingImageStick(scopeEl) {
    scopeEl?.querySelectorAll?.('img')?.forEach(stickBottomOnLateImageLoad);
  }

  const CHAT_MEDIA_QUARANTINE_KEY = '__mm_chat_media_decode_quarantine__';
  const LAST_INTERRUPTED_RISK_KEY = '__mm_last_interrupted_risky_activity__';

  function readQuarantinedChatMedia(msgId) {
    if (!IOS_WEBKIT_CHAT || !msgId) return null;
    const candidates = [];
    try {
      candidates.push(JSON.parse(localStorage.getItem(CHAT_MEDIA_QUARANTINE_KEY) || 'null'));
      candidates.push(JSON.parse(localStorage.getItem(LAST_INTERRUPTED_RISK_KEY) || 'null'));
    } catch (_) {}
    const now = Date.now();
    return candidates.find((entry) => {
      if (!entry || entry.label !== 'chat-media-decode') return false;
      const detail = entry.detail && typeof entry.detail === 'object' ? entry.detail : {};
      const detectedAt = Number(entry.detectedAt || entry.startedAt || 0);
      return String(detail.chatId || '') === String(chatId)
        && String(detail.messageId || '') === String(msgId)
        && detectedAt > 0
        && now - detectedAt < 30 * 24 * 60 * 60 * 1000;
    }) || null;
  }

  function clearQuarantinedChatMedia(msgId) {
    [CHAT_MEDIA_QUARANTINE_KEY, LAST_INTERRUPTED_RISK_KEY].forEach((key) => {
      try {
        const entry = JSON.parse(localStorage.getItem(key) || 'null');
        const detail = entry?.detail && typeof entry.detail === 'object' ? entry.detail : {};
        if (entry?.label === 'chat-media-decode'
          && String(detail.chatId || '') === String(chatId)
          && String(detail.messageId || '') === String(msgId)) {
          localStorage.removeItem(key);
        }
      } catch (_) {}
    });
  }

  async function hydrateDeferredImagePlaceholder(placeholderEl) {
    const row = placeholderEl?.closest?.('[data-msg-id]');
    const msgId = row?.getAttribute?.('data-msg-id') || '';
    if (!msgId || !placeholderEl?.isConnected) return false;
    const slot = placeholderEl.closest('.chat-sticker');
    if (!slot) return false;
    const msg = messages.find((m) => m.id === msgId);
    const isSticker = msg?.type === 'sticker' || placeholderEl.classList.contains('chat-sticker-deferred');
    if (placeholderEl.dataset.mediaUserRetry !== '1' && readQuarantinedChatMedia(msgId)) {
      const hint = placeholderEl.querySelector('.chat-gen-image-hint');
      if (hint) hint.textContent = '为避免再次闪退，点一下加载';
      placeholderEl.setAttribute('role', 'button');
      placeholderEl.setAttribute('tabindex', '0');
      placeholderEl.dataset.mediaQuarantined = '1';
      return true;
    }
    const riskToken = globalThis.__mm_mark_risky_activity__?.('chat-media-decode', {
      chatId,
      messageId: msgId,
      type: isSticker ? 'sticker' : 'image',
    });
    let clearOnImageSettle = false;
    try {
      let src = await resolveMessageImageSrc(msgId);
      if (!src && isSticker) {
        const { resolveStickerMessageImageFromLibrary } = await import('../core/chat/sticker-resolve.js');
        src = await resolveStickerMessageImageFromLibrary(msg).catch(() => '');
      }
      if (!src || !placeholderEl.isConnected) return false;
      const main = container.querySelector('.chat-thread-messages');
      const historyViewportState = captureHistoryViewportState(main);
      if (isSticker) {
        const label = String(msg?.metadata?.stickerName || msg?.metadata?.sticker || msg?.content || '表情包').trim() || '表情包';
        let displaySrc = src;
        if (/^data:image\//i.test(src)) {
          const { ensureStickerThumb } = await import('../core/sticker-thumb-cache.js');
          displaySrc = await ensureStickerThumb({
            id: `message-${msgId}`,
            url: src,
          }, {
            // iOS 聊天页只做 Base64 -> Blob 的轻量显示转换；缩略图生成留给
            // 表情管理页，避免显示一张图时同时持有原串、位图和 Canvas。
            generateThumb: !IOS_WEBKIT_CHAT,
          }).catch(() => null) || src;
        }
        if (!placeholderEl.isConnected) return false;
        slot.innerHTML = `<img src="${escAttr(displaySrc)}" alt="${esc(label)}" decoding="async" referrerpolicy="no-referrer" onerror="this.style.display='none';var h=this.nextElementSibling;if(h){h.hidden=false;this.closest('.chat-sticker')?.classList.add('is-broken')}" /><span class="chat-sticker-broken-hint" hidden><span class="chat-sticker-broken-name">${esc(label)}</span><span class="chat-sticker-broken-tip">未加载 · 建议重新上传或换图床</span></span>`;
      } else {
        slot.innerHTML = `<img src="${escAttr(src)}" alt="图片" loading="lazy" decoding="async" onerror="this.style.display='none';this.nextElementSibling&&(this.nextElementSibling.style.display='flex')" /><span class="chat-image-broken-hint">图片已失效 · 点开重 roll</span>`;
      }
      if (historyViewportState) {
        stableHistoryViewportState = historyViewportState;
        requestAnimationFrame(() => restoreHistoryViewportState(main, historyViewportState));
      }
      const image = slot.querySelector('img');
      if (image) {
        clearOnImageSettle = true;
        const clearRisk = () => {
          if (riskToken) globalThis.__mm_clear_risky_activity__?.(riskToken);
          clearQuarantinedChatMedia(msgId);
        };
        image.addEventListener('load', clearRisk, { once: true });
        image.addEventListener('error', clearRisk, { once: true });
        if (image.complete) clearRisk();
        window.setTimeout(clearRisk, 15000);
      }
      bindPendingImageStick(slot);
      return true;
    } finally {
      if (!clearOnImageSettle && riskToken) globalThis.__mm_clear_risky_activity__?.(riskToken);
    }
  }

  const deferredMediaHydrateRetryDelays = [180, 720, 1800];

  function beginDeferredMediaHydration(placeholderEl) {
    if (!placeholderEl?.isConnected || placeholderEl.dataset.mediaHydrating === '1') return;
    placeholderEl.dataset.mediaHydrating = '1';
    void hydrateDeferredImagePlaceholder(placeholderEl)
      .catch(() => false)
      .then((hydrated) => {
        if (hydrated || !placeholderEl.isConnected) {
          lazyMediaObserver?.unobserve?.(placeholderEl);
          return;
        }
        const attempt = Math.max(0, Number(placeholderEl.dataset.mediaHydrateAttempt || 0) || 0);
        if (attempt >= deferredMediaHydrateRetryDelays.length) {
          const hint = placeholderEl.querySelector('.chat-gen-image-hint');
          if (hint) hint.textContent = '点一下重试';
          placeholderEl.setAttribute('role', 'button');
          placeholderEl.setAttribute('tabindex', '0');
          return;
        }
        placeholderEl.dataset.mediaHydrateAttempt = String(attempt + 1);
        window.setTimeout(() => beginDeferredMediaHydration(placeholderEl), deferredMediaHydrateRetryDelays[attempt]);
      })
      .finally(() => {
        if (placeholderEl?.dataset) delete placeholderEl.dataset.mediaHydrating;
      });
  }

  function isDeferredMediaNearViewport(placeholderEl, main) {
    if (!placeholderEl?.isConnected || !main?.isConnected) return false;
    const targetRect = placeholderEl.getBoundingClientRect();
    const rootRect = main.getBoundingClientRect();
    return targetRect.bottom >= rootRect.top - 160 && targetRect.top <= rootRect.bottom + 160;
  }

  function bindLazyMediaHydration(main) {
    if (!main) return;
    bindPendingImageStick(main);
    const targets = Array.from(main.querySelectorAll('.chat-gen-image-placeholder.is-deferred'));
    targets.forEach((el) => {
      if (el.dataset.mediaRetryBound === '1') return;
      el.dataset.mediaRetryBound = '1';
      const retry = () => {
        el.dataset.mediaUserRetry = '1';
        delete el.dataset.mediaQuarantined;
        el.dataset.mediaHydrateAttempt = '0';
        const hint = el.querySelector('.chat-gen-image-hint');
        if (hint) hint.textContent = '加载中…';
        beginDeferredMediaHydration(el);
      };
      el.addEventListener('click', retry);
      el.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        retry();
      });
    });
    if (typeof IntersectionObserver !== 'function') {
      targets.filter((el) => isDeferredMediaNearViewport(el, main)).forEach(beginDeferredMediaHydration);
      return;
    }
    lazyMediaObserver?.disconnect?.();
    lazyMediaObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        beginDeferredMediaHydration(entry.target);
      });
    }, { root: main, rootMargin: '160px 0px' });
    targets.forEach((el) => {
      lazyMediaObserver.observe(el);
      // 当前可见的表情不等观察器下一拍，避免快速重绘/前后台切换时错过首次回调。
      if (isDeferredMediaNearViewport(el, main)) beginDeferredMediaHydration(el);
    });
  }

  function tryIncrementalStreamPaint(main, {
    renderMessages,
    hiddenCount,
    shouldShowStream,
    anonymousProfiles,
    preserveScrollTop,
    preOlderScroll,
    seq,
  }) {
    const snap = lastPaintSnapshot;
    if (!snap || selectionMode || preserveScrollTop != null || preOlderScroll || pendingSearchJumpId) return false;
    const messageIds = renderMessages.map((m) => m.id);
    if (snap.hiddenCount !== hiddenCount) return false;
    if (snap.messageIds.join('\n') !== messageIds.join('\n')) return false;
    if (snap.shouldShowStream === shouldShowStream) return false;
    main.querySelector('[data-stream-placeholder]')?.remove();
    if (shouldShowStream) {
      const shouldFollowStream = holdBottomUntilSettled || isNearBottom(main, 80);
      main.insertAdjacentHTML('beforeend', buildStreamPlaceholderHtml(anonymousProfiles));
      // 手动推进已显式开启 hold；后台输入占位则只在用户原本贴底时跟随。
      if (shouldFollowStream) pinThreadForActiveStream();
      else updateScrollBottomFab();
    } else if (holdBottomUntilSettled || isNearBottom(main, CHAT_SCROLLBOTTOM_FAB_THRESHOLD)) {
      main.scrollTop = main.scrollHeight;
    }
    lastPaintSnapshot = {
      ...snap,
      shouldShowStream,
    };
    requestAnimationFrame(() => {
      if (!main.isConnected || container.querySelector('.chat-thread-messages') !== main) return;
      bindBubbleMenus();
      bindSystemHintMenus();
      bindLazyMediaHydration(main);
    });
    return true;
  }

  // 完整兜底渲染也不再先摘空整个消息区。以顶层消息组包含的 message id 作为 key：
  // 未变化的组直接保留原节点（包括已解码图片、GIF 播放进度和事件状态），只插入、替换
  // 或移除真正变化的组。连续气泡的分组边界变化时 key 会变化，因此只重建受影响的组。
  const messageGroupPaintMarkup = new WeakMap();

  function messagePaintNodeKey(node) {
    if (!(node instanceof Element)) return '';
    if (node.matches('[data-stream-placeholder]')) return 'stream-placeholder';
    if (node.matches('[data-load-older]')) return 'load-older';
    if (node.matches('[data-return-latest]')) return 'return-latest';
    const ids = [];
    const ownId = String(node.getAttribute('data-msg-id') || '').trim();
    if (ownId) ids.push(ownId);
    node.querySelectorAll('[data-msg-id]').forEach((child) => {
      const id = String(child.getAttribute('data-msg-id') || '').trim();
      if (id && !ids.includes(id)) ids.push(id);
    });
    return ids.length ? `messages:${ids.join('\u0001')}` : '';
  }

  function reconcileMessagePaint(main, fragment, { retainStreamPlaceholder = false } = {}) {
    const desired = [...fragment.children];
    // 回复已经落库但还要等下一帧逐条揭示时，保留当前「正在输入」节点。
    // 若此处先把它摘掉，隐藏中的新气泡又不占高度，WebKit 会在两帧之间把
    // scrollTop 夹回旧消息；首条气泡出现后再钉底，就形成肉眼可见的来回跳。
    const retainedStreamPlaceholder = retainStreamPlaceholder
      ? main.querySelector('[data-stream-placeholder]')
      : null;
    if (retainedStreamPlaceholder && !desired.some((node) => messagePaintNodeKey(node) === 'stream-placeholder')) {
      desired.push(retainedStreamPlaceholder);
    }
    const reusable = new Map();
    [...main.children].forEach((node) => {
      const key = messagePaintNodeKey(node);
      if (!key) return;
      const list = reusable.get(key) || [];
      list.push(node);
      reusable.set(key, list);
    });

    const finalNodes = desired.map((nextNode) => {
      const key = messagePaintNodeKey(nextNode);
      const candidates = key ? reusable.get(key) : null;
      const previous = candidates?.shift?.() || null;
      const nextMarkup = nextNode.outerHTML;
      if (previous && messageGroupPaintMarkup.get(previous) === nextMarkup) return previous;
      messageGroupPaintMarkup.set(nextNode, nextMarkup);
      return nextNode;
    });
    const keep = new Set(finalNodes);
    let cursor = main.firstElementChild;
    finalNodes.forEach((node) => {
      if (node === cursor) {
        cursor = cursor.nextElementSibling;
        return;
      }
      main.insertBefore(node, cursor);
    });
    [...main.children].forEach((node) => {
      if (!keep.has(node)) node.remove();
    });
    // 旧 innerHTML 会留下格式化空白文本； keyed paint 不需要这些节点。
    [...main.childNodes].forEach((node) => {
      if (node.nodeType === Node.TEXT_NODE && !String(node.textContent || '').trim()) node.remove();
    });
  }

  const inlineInnerVoiceScope = `iv-${Array.from(String(chatId || 'chat')).reduce((hash, ch) => (
    Math.imul(hash ^ ch.charCodeAt(0), 16777619) >>> 0
  ), 2166136261).toString(36)}`;
  const inlineInnerVoiceStyleId = `chat-inline-inner-voice-css-${inlineInnerVoiceScope}`;
  addPageLifetimeCleanup(() => document.getElementById(inlineInnerVoiceStyleId)?.remove());

  function currentInnerVoiceCard() {
    return getInnerVoiceCard(chat, (windowChatTheme || seaChatTheme) ? 'ins' : 'diary');
  }

  // 消息内心声是弹层的紧凑独立容器，过去只吃 inlineCss，导致同一套心声方案
  // 的 css（固定以 #char-state-popover 为作用域）在这里完全失效。只桥接明确
  // 指向弹层内部的规则；遮罩本身、定位等根节点规则不带过来，以免改变消息流布局。
  function bridgePopoverCssToInline(css = '') {
    return String(css || '').replace(/([^{}]+)\{([^{}]*)\}/g, (_rule, rawSelectors, declarations) => {
      const selectors = String(rawSelectors || '').split(',').map((rawSelector) => {
        let selector = String(rawSelector || '').trim();
        if (!selector.startsWith('#char-state-popover')) return '';
        const rootMatch = selector.match(/^#char-state-popover(?:\.csp-[\w-]+)*/);
        if (!rootMatch || !/\s/.test(selector.slice(rootMatch[0].length))) return '';
        selector = `.chat-inline-inner-voice-host${selector.slice(rootMatch[0].length)}`;
        return selector
          .replace(/\.char-state-card\b/g, '.chat-inline-inner-voice')
          .replace(/\.char-state-header-title\b/g, '.chat-inline-inner-voice-name')
          .replace(/\.char-state-header\b/g, '.chat-inline-inner-voice-head')
          .replace(/\.char-state-popover-body\b/g, '.chat-inline-inner-voice-body');
      }).filter(Boolean);
      return selectors.length ? `${selectors.join(',')}{${declarations}}` : '';
    });
  }

  function syncInlineInnerVoiceCss() {
    let style = document.getElementById(inlineInnerVoiceStyleId);
    const card = currentInnerVoiceCard();
    const css = card.inlineEnabled
      ? [String(card.inlineCss || '').trim(), bridgePopoverCssToInline(card.css)].filter(Boolean).join('\n')
      : '';
    if (!css) {
      style?.remove();
      return;
    }
    if (!style) {
      style = document.createElement('style');
      style.id = inlineInnerVoiceStyleId;
      document.head.appendChild(style);
    }
    const scopedSelector = `.chat-inline-inner-voice-host[data-inline-voice-scope="${inlineInnerVoiceScope}"]`;
    style.textContent = css.replace(/\.chat-inline-inner-voice-host/g, scopedSelector);
  }

  function inlineInnerVoiceBodyHtml(snapshot, card) {
    if (card.templateHtml) {
      return `<div class="chat-inline-inner-voice-template">${renderInnerVoiceBodyTemplate(card.templateHtml, snapshot)}</div>`;
    }
    const inner = String(snapshot?.inner || '').trim();
    const customRows = Object.entries(snapshot?.custom && typeof snapshot.custom === 'object' ? snapshot.custom : {})
      .filter(([key, value]) => String(key || '').trim() && String(value || '').trim())
      .map(([key, value]) => `
        <div class="chat-inline-inner-voice-custom-row" data-state-key="${escAttr(key)}">
          <span class="chat-inline-inner-voice-custom-key">${esc(key)}</span>
          <span class="chat-inline-inner-voice-custom-value">${esc(value)}</span>
        </div>`).join('');
    return `${inner ? `<div class="chat-inline-inner-voice-text">${esc(inner)}</div>` : ''}${customRows ? `<div class="chat-inline-inner-voice-custom">${customRows}</div>` : ''}`;
  }

  function findInlineInnerVoiceTarget(main, messageId) {
    const safeId = escapeMsgIdForSelector(messageId);
    if (!safeId) return null;
    return main.querySelector(`.chat-msg-bubble[data-msg-id="${safeId}"]`)
      || main.querySelector(`.chat-msg-card[data-msg-id="${safeId}"]`)
      || main.querySelector(`.chat-msg-media[data-msg-id="${safeId}"]`)
      || main.querySelector(`.chat-bubble-row[data-msg-id="${safeId}"]`)
      || main.querySelector(`[data-msg-id="${safeId}"]`);
  }

  async function hydrateInlineInnerVoices(main, renderMessages, seq) {
    syncInlineInnerVoiceCss();
    const existing = [...main.querySelectorAll('.chat-inline-inner-voice-host')];
    const card = currentInnerVoiceCard();
    if (!card.inlineEnabled || !isInnerVoiceVisible()) {
      const historyViewportState = captureHistoryViewportState(main);
      existing.forEach((node) => node.remove());
      restoreHistoryViewportState(main, historyViewportState);
      return;
    }

    const lastMessageByRound = new Map();
    (renderMessages || []).forEach((message) => {
      const characterId = String(message?.senderId || '').trim();
      const aiRoundId = String(message?.metadata?.aiRoundId || '').trim();
      if (!message?.id || !characterId || !aiRoundId) return;
      if (characterId === 'user' || characterId === 'system' || characterId === GUIDANCE_SENDER_ID) return;
      lastMessageByRound.set(`${characterId}\u0000${aiRoundId}`, message);
    });
    if (!lastMessageByRound.size) {
      const historyViewportState = captureHistoryViewportState(main);
      existing.forEach((node) => node.remove());
      restoreHistoryViewportState(main, historyViewportState);
      return;
    }

      const characterIds = [...new Set([...lastMessageByRound.keys()].map((key) => key.split('\u0000')[0]))];
      const allowLegacyUnscopedState = await canReadLegacyUnscopedChatState(chatId, user?.id || '');
      const histories = await Promise.all(characterIds.map(async (characterId) => ({
        characterId,
        rows: await loadChatCharStateHistory(chatId, characterId, {
          userId: user?.id || '',
          allowLegacyUnscoped: allowLegacyUnscopedState,
        }).catch(() => []),
    })));
    if (seq !== messageRenderSeq || !main.isConnected || container.querySelector('.chat-thread-messages') !== main) return;

    const wasAtBottom = isNearBottom(main, 80);
    const historyViewportState = wasAtBottom ? null : captureHistoryViewportState(main);
    existing.forEach((node) => node.remove());
    histories.forEach(({ characterId, rows }) => {
      (rows || []).forEach((snapshot) => {
        const aiRoundId = String(snapshot?.aiRoundId || '').trim();
        const message = lastMessageByRound.get(`${characterId}\u0000${aiRoundId}`);
        if (!message) return;
        const target = findInlineInnerVoiceTarget(main, message.id);
        if (!target || target.classList.contains('is-reveal-pending')) return;
        const body = inlineInnerVoiceBodyHtml(snapshot, card);
        if (!body.trim()) return;

        const host = document.createElement('aside');
        host.className = 'chat-inline-inner-voice-host';
        host.dataset.inlineVoiceScope = inlineInnerVoiceScope;
        host.dataset.characterId = characterId;
        host.dataset.aiRoundId = aiRoundId;
        host.innerHTML = `
          <div class="chat-inline-inner-voice">
            <div class="chat-inline-inner-voice-head">
              <span class="chat-inline-inner-voice-name">${esc(snapshot?.name || message.senderName || characterId)}</span>
              <span class="chat-inline-inner-voice-label">${esc(resolveInnerVoiceLabel(card.labels, 'titleSuffix'))}</span>
              <button type="button" class="chat-inline-inner-voice-open" data-inline-inner-voice-open data-character-id="${escAttr(characterId)}" data-character-name="${escAttr(snapshot?.name || message.senderName || '')}">完整</button>
            </div>
            <div class="chat-inline-inner-voice-body">${body}</div>
          </div>`;

        if (target.matches('.chat-msg-bubble, .chat-msg-card, .chat-msg-media')) {
          target.insertAdjacentElement('afterend', host);
          return;
        }
        const bubbleCol = [...target.children].find((child) => child.classList?.contains('chat-bubble-col'))
          || target.querySelector('.chat-bubble-col');
        if (bubbleCol) bubbleCol.appendChild(host);
        else target.insertAdjacentElement('afterend', host);
      });
    });
    if (wasAtBottom && !isBubbleRevealActive()) main.scrollTop = main.scrollHeight;
    else restoreHistoryViewportState(main, historyViewportState);
  }

  // 发送/追加消息的快速路径：可见列表只是在尾部多了几条常规气泡时，直接把新气泡
  // insertAdjacentHTML 进列表尾部。长会话里「点发送卡一下」的大头就是整表 innerHTML
  // 重建（上百行气泡的字符串拼接 + DOM 解析 + 排版），这里把它整个跳过。
  const INCREMENTAL_APPEND_MESSAGE_TYPES = new Set(['text', 'system', 'voice', 'image', 'sticker']);
  function tryIncrementalAppendPaint(main, {
    renderMessages,
    shouldShowStream,
    anonymousProfiles,
    preserveScrollTop,
    preOlderScroll,
    seq,
    revealIds,
  }) {
    const snap = lastPaintSnapshot;
    if (!snap || selectionMode || preserveScrollTop != null || preOlderScroll || pendingSearchJumpId) return false;
    // 新消息落地后仍需保留「正在输入」时，顺序关系较复杂，交给整体重绘。
    // 回复收尾从 true → false 时则可安全摘掉旧占位，再把结果追加到尾部。
    if (shouldShowStream) return false;
    const ids = renderMessages.map((m) => m.id);
    const prevIds = snap.messageIds;
    if (!ids.length || !prevIds.length) return false;
    const prevIdSet = new Set(prevIds);
    let appendCount = 0;
    while (appendCount < ids.length && !prevIdSet.has(ids[ids.length - 1 - appendCount])) appendCount += 1;
    if (!appendCount || appendCount > CHAT_THREAD_RENDER_BATCH || appendCount >= ids.length) return false;
    // 除了尾部新增，剩余部分必须正好是已渲染窗口的后缀。窗口超过渲染上限时会从头部
    // 滑出几条，DOM 里多留着那几条旧行没关系——等价于用户多加载了一点历史。
    const keptLen = ids.length - appendCount;
    const offset = prevIds.length - keptLen;
    if (offset < 0) return false;
    for (let i = 0; i < keptLen; i += 1) {
      if (ids[i] !== prevIds[offset + i]) return false;
    }
    const appended = renderMessages.slice(keptLen);
    // 常见回复里的旁白、语音、图片和表情都能沿用消息区事件委托，直接追加即可。
    // 红包、投票、邀约等交互卡仍交给整体重绘，避免漏掉它们各自的按钮绑定。
    if (!appended.every((m) => m && INCREMENTAL_APPEND_MESSAGE_TYPES.has(String(m.type || 'text')))) return false;
    const renderOptions = buildMessageRenderOptions(anonymousProfiles, null);
    const html = renderAppendedMessagesHtml(appended, {
      prevMessages: renderMessages.slice(0, keptLen),
      options: renderOptions,
    });
    if (html == null) return false;
    const wasAtBottom = isNearBottom(main);
    const retainedStreamPlaceholder = snap.shouldShowStream
      ? main.querySelector('[data-stream-placeholder]')
      : null;
    let preparedReveal = null;
    if (html && revealIds?.length) {
      cancelBubbleReveal();
      const template = document.createElement('template');
      template.innerHTML = html;
      preparedReveal = markBubbleRevealPending(template.content, revealIds);
      // 先把隐藏回复插在占位之前；占位由首条回复揭示时同步移除，期间列表高度不塌。
      main.insertBefore(template.content, retainedStreamPlaceholder);
    } else if (html) {
      if (retainedStreamPlaceholder) retainedStreamPlaceholder.insertAdjacentHTML('beforebegin', html);
      else main.insertAdjacentHTML('beforeend', html);
    }
    if (!revealIds?.length) retainedStreamPlaceholder?.remove();
    // AI 回复也走增量追加：节点先在离屏 fragment 进入 pending，再挂到列表尾部；
    // 浏览器没有机会先画出完整回复，随后仍由原逐条揭示队列控制节奏。
    // 过去 revealIds 会强制整表 innerHTML，iOS WebKit 在旧列表被摘空的那一帧
    // 容易闪白或露出壁纸，这正是「回复快出现时闪一下」的主要来源。
    if (revealIds?.length) startBubbleReveal(main, revealIds, seq, preparedReveal);
    void hydrateInlineInnerVoices(main, renderMessages, seq);
    if ((holdBottomUntilSettled || wasAtBottom) && !isBubbleRevealActive()) {
      main.scrollTop = main.scrollHeight;
      scheduleLatestFollowRepair(main);
    }
    if (offset > 0) {
      // DOM 实际保留的行数比滑动窗口多 offset 条，把上限同步放大，
      // 让下一次 getRenderableMessages 的窗口和 DOM 继续对得上，快速路径不断档。
      visibleMessageLimit = Math.max(visibleMessageLimit, prevIds.length + appendCount);
    }
    lastPaintSnapshot = {
      ...snap,
      messageIds: [...prevIds, ...appended.map((m) => m.id)],
      shouldShowStream,
    };
    requestAnimationFrame(() => {
      if (!main.isConnected || container.querySelector('.chat-thread-messages') !== main) return;
      bindBubbleMenus();
      bindSystemHintMenus();
      bindVoiceBubbleInteractions(container, () => messages, {
        onRefresh: () => refreshMessages(),
        captureViewport: () => captureHistoryViewportState(main),
        restoreViewport: (state) => stabilizeHistoryViewport(main, state),
      });
      bindLazyMediaHydration(main);
    });
    return true;
  }

  // AI 一轮回复往往解析出好几条气泡，落库前已经整轮解析完了（不逐条拆开这个环节）；
  // 这里只是画出来的时候让它们一条一条显形，纯展示效果。
  // 旁白 / 图片 / 卡片必须与文字同一队列，否则会先整段落在屏幕上，再对文字「假装流式」。
  function isRevealEligibleMessage(msg) {
    return !!msg?.id;
  }

  function findBubbleRevealTarget(main, id) {
    const safeId = escAttr(String(id || ''));
    if (!safeId) return null;
    // 连续气泡合并成一组时，组内每条消息都各自有一个内层节点带这个 id；
    // 优先找内层节点，不然会连累同组里还没轮到的其它气泡一起显形。
    return main.querySelector(`.chat-msg-bubble[data-msg-id="${safeId}"]`)
      || main.querySelector(`.chat-bubble-row[data-msg-id="${safeId}"]`)
      || main.querySelector(`.chat-narration-row[data-msg-id="${safeId}"]`)
      || main.querySelector(`.system-hint-row[data-msg-id="${safeId}"]`)
      || main.querySelector(`.story-card-row[data-msg-id="${safeId}"]`)
      || main.querySelector(`[data-msg-id="${safeId}"]`);
  }

  function markBubbleRevealPending(root, ids = []) {
    const nodes = [];
    ids.forEach((id) => {
      if (!isRevealEligibleMessage(messages.find((message) => message.id === id))) return;
      const el = findBubbleRevealTarget(root, id);
      if (!el) return;
      el.classList.add('is-reveal-pending');
      nodes.push(el);
    });
    const revealShells = [...new Set(nodes.map((el) => (
      el.closest('.chat-bubble-row.is-stack-group, .chat-msg-group')
    )).filter(Boolean))];
    revealShells.forEach((shell) => {
      const items = [...shell.querySelectorAll('.chat-msg-bubble[data-msg-id], .chat-msg-card[data-msg-id], .chat-msg-media[data-msg-id]')];
      if (items.length && items.every((item) => item.classList.contains('is-reveal-pending'))) {
        shell.classList.add('is-reveal-shell-pending');
      }
    });
    return { nodes, revealShells };
  }

  function bindReinsertedBubbleRow(el) {
    if (el?.classList?.contains('chat-bubble-row') || el?.classList?.contains('chat-msg-bubble')) {
      bindBubbleMenuRow(el);
    }
  }

  function cancelBubbleReveal({ settle = true } = {}) {
    if (bubbleRevealTimer) {
      clearTimeout(bubbleRevealTimer);
      cancelAnimationFrame(bubbleRevealTimer);
      bubbleRevealTimer = 0;
    }
    if (settle && bubbleRevealPendingNodes.length) {
      // 同一个合并气泡节点可能被多个消息 id 命中；去重后一次性解除隐藏。
      [...new Set(bubbleRevealPendingNodes)].forEach((el) => {
        el.classList?.remove?.('is-reveal-pending');
      });
      container.querySelectorAll('.is-reveal-shell-pending').forEach((el) => {
        el.classList.remove('is-reveal-shell-pending');
      });
    }
    bubbleRevealPendingNodes = [];
  }

  function isBubbleRevealActive() {
    return !!bubbleRevealTimer || bubbleRevealPendingNodes.length > 0;
  }

  const BUBBLE_REVEAL_STEP_MS = 280;
  const BUBBLE_REVEAL_STAGGER_CAP = 8;

  // 新消息挂进页面前先在离屏 DOM 打上 pending，再按顺序揭开。
  // 不能先完整露出来再摘节点「重演」——那会闪成「一股脑全部显示，再假装流式」。
  function startBubbleReveal(main, ids, seq, prepared = null) {
    if (!prepared) cancelBubbleReveal();
    if (!ids?.length) return;
    const { nodes = [], revealShells = [] } = prepared || markBubbleRevealPending(main, ids);
    const retainedStreamPlaceholder = main.querySelector('[data-stream-placeholder]');
    if (!nodes.length) {
      retainedStreamPlaceholder?.remove();
      return;
    }
    bubbleRevealPendingNodes = nodes;
    const pinRevealNode = (el) => {
      if (!holdBottomUntilSettled || !el?.isConnected) return;
      const mainRect = main.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      const overflow = elRect.bottom - (mainRect.bottom - 12);
      // 整表兜底重绘后 WebKit 可能把 scrollTop 保留在隐形队列的末尾；此时
      // overflow 为负，也必须向上拉回当前待揭示气泡，不能让用户先看到一屏空白。
      if (Math.abs(overflow) > 1) main.scrollTop += overflow;
    };
    const settleAll = () => {
      nodes.forEach((el) => el.classList.remove('is-reveal-pending'));
      retainedStreamPlaceholder?.remove();
      revealShells.forEach((el) => el.classList.remove('is-reveal-shell-pending'));
      nodes.forEach((el) => bindReinsertedBubbleRow(el));
      bubbleRevealPendingNodes = [];
      void hydrateInlineInnerVoices(main, getRenderableMessages().renderMessages, seq)
        .finally(() => scheduleLatestFollowRepair(main));
      scheduleLatestFollowRepair(main);
    };
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    if (reduceMotion) {
      settleAll();
      if (holdBottomUntilSettled || isNearBottom(main, 80)) {
        main.scrollTop = main.scrollHeight;
      }
      return;
    }
    // 逐条揭开默认钉底，保持「从底下顶上来」；用户一旦上滑看历史就停钉，别把人拽回去。
    // 「正在输入」期间若用户已经主动离开底部，回复落地时也要继承这个选择；
    // 不能重新把 hold 打开，否则会在占位消失、首条气泡出现时突然抖回底部。
    holdBottomUntilSettled = holdBottomUntilSettled || isNearBottom(main, 80);
    // 未轮到的回复不再占据列表高度。先同步停在“现有可见内容”的底部，
    // 避免整表兜底重绘把 scrollTop 留在顶部；首条下一帧加入布局后再按真实几何贴底。
    if (holdBottomUntilSettled) main.scrollTop = main.scrollHeight;
    let i = 0;
    const step = () => {
      bubbleRevealTimer = 0;
      if (seq !== messageRenderSeq || !main.isConnected) {
        // 被打断时把还没揭开的气泡直接补全，不能真的把内容漏掉。
        nodes.slice(i).forEach((el) => el.classList.remove('is-reveal-pending'));
        retainedStreamPlaceholder?.remove();
        revealShells.forEach((el) => el.classList.remove('is-reveal-shell-pending'));
        nodes.slice(i).forEach((el) => bindReinsertedBubbleRow(el));
        bubbleRevealPendingNodes = [];
        if (holdBottomUntilSettled) main.scrollTop = main.scrollHeight;
        void hydrateInlineInnerVoices(main, getRenderableMessages().renderMessages, seq)
          .finally(() => scheduleLatestFollowRepair(main));
        scheduleLatestFollowRepair(main);
        return;
      }
      const el = nodes[i];
      el.closest('.is-reveal-shell-pending')?.classList.remove('is-reveal-shell-pending');
      el.classList.remove('is-reveal-pending');
      // 新气泡先进入布局，再在同一帧移除「正在输入」，滚动容器高度不会经历空档。
      if (i === 0) retainedStreamPlaceholder?.remove();
      el.classList.add('is-reveal-in');
      const clearRevealClass = () => el.classList.remove('is-reveal-in');
      el.addEventListener('animationend', clearRevealClass, { once: true });
      setTimeout(clearRevealClass, 400);
      bindReinsertedBubbleRow(el);
      pinRevealNode(el);
      i += 1;
      if (i >= nodes.length) {
        bubbleRevealPendingNodes = [];
        if (holdBottomUntilSettled) main.scrollTop = main.scrollHeight;
        void hydrateInlineInnerVoices(main, getRenderableMessages().renderMessages, seq)
          .finally(() => scheduleLatestFollowRepair(main));
        scheduleLatestFollowRepair(main);
        return;
      }
      const delay = i <= BUBBLE_REVEAL_STAGGER_CAP ? BUBBLE_REVEAL_STEP_MS : 0;
      bubbleRevealTimer = setTimeout(step, delay);
    };
    // 首条下一帧立即出现；后续气泡再按间隔展开。避免回复已经落库却先留一屏
    // 隐形占位 280ms，让长会话看起来像卡住或被清成空白页。
    bubbleRevealTimer = requestAnimationFrame(step);
  }

  function genImageLightboxStatus(msg) {
    if (!msg?.metadata?.generatingImage) {
      if (msg?.metadata?.generationFailed) {
        const metadata = msg.metadata || {};
        const error = String(metadata.generationError || '图片生成失败').trim() || '图片生成失败';
        if (metadata.generationStage === 'persist_failed' && String(metadata.generationRemoteUrl || '').trim()) {
          const diagnostic = metadata.generationPersistDiagnostics || {};
          const detail = String(diagnostic.proxy || diagnostic.direct || diagnostic.native || '').trim();
          return '图片已经生成，返回结果已保留，但下载保存失败。\n'
            + '点“重 roll”会先重试下载，不会重新生图。'
            + (detail ? `\n诊断：${detail}` : '');
        }
        if (isImageGenerationResultUnknown(msg)) {
          const storedSeconds = Math.max(0, Math.round(Number(metadata.generationErrorElapsedMs || 0) / 1000));
          const legacySeconds = Number(error.match(/等待约\s*(\d+)\s*秒后失败/i)?.[1] || 0);
          const seconds = storedSeconds || legacySeconds;
          const target = String(metadata.generationErrorTarget || '').trim();
          return `传输在等待生成或接收结果时中断${seconds ? `（约 ${seconds} 秒）` : ''}。`
            + `服务端结果未知，请先检查生成记录；确认未生成后再重 roll。`
            + (target ? `\n目标：${target}` : '');
        }
        return error.slice(0, 360);
      }
      return '';
    }
    if (msg.metadata?.generationStage === 'persisting') {
      return '图片已经生成，正在下载并保存到本机。请稍候，不要重复生成。';
    }
    return isGenImageStuck(msg)
      ? '上次生成任务已经中断，正在确认是否有可恢复的结果…'
      : '正在生成图片…';
  }

  async function openGenImageLightbox(msg) {
    if (!msg || msg.type !== 'image') return;
    const fullMsg = await loadFullImageMessage(msg);
    const src = String(fullMsg.content || fullMsg.metadata?.url || '').trim();
    const canReroll = canRerollGeneratedImage(fullMsg);
    const status = genImageLightboxStatus(fullMsg);
    openImageLightbox(src, {
      statusMessage: status,
      confirmReroll: isImageGenerationResultUnknown(fullMsg)
        ? () => confirmUnknownImageReplay(fullMsg)
        : undefined,
      onReroll: canReroll
        ? async ({ setStatus, clearImage } = {}) => {
          try {
            clearImage?.();
            setStatus?.('正在重新生成…');
            const url = await rerollGenImageFromUi(fullMsg);
            showToast('图片已更新');
            return url;
          } catch (err) {
            messages = await listThreadMessages();
            refreshMessages();
            showToast(`生图失败：${String(err?.message || err).slice(0, 80)}`);
            throw err;
          }
        }
        : undefined,
      onEditPrompt: canReroll ? () => openGenImagePromptEditor(fullMsg) : undefined,
    });
  }

  // 后台回合是否已把本轮气泡写进列表：基线之后出现了新的角色可见消息。
  // persist 收尾可能还要几秒，但气泡不会再多了，「正在输入」不该吊在气泡后面。
  function headlessRoundBubblesPainted() {
    const list = Array.isArray(messages) ? messages : [];
    if (!headlessBaselineMsgId) {
      return list.some((m) => isCharacterConversationMessage(m));
    }
    const idx = list.findIndex((m) => m?.id === headlessBaselineMsgId);
    if (idx < 0) return false;
    return list.slice(idx + 1).some((m) => isCharacterConversationMessage(m));
  }

  // 「正在输入」占位是否应该存在：本地流式之外，后台 headless 生成与云端生成
  // 也算数——否则用户发消息、翻译展开等任何一次重绘都会把后台回合的占位抹掉。
  function backgroundTypingActive() {
    if (headlessReplyVisible && !headlessRoundBubblesPainted()) return true;
    return cloudTypingVisible;
  }

  function refreshMessages(showStream = false, { revealIds = null } = {}) {
    // Keep-Alive 挂起时页面已 hidden 且从 document 摘下。WebKit 对 detached/hidden DOM
    // 的 innerHTML 更新可能保留旧合成层，恢复后先显示上一帧；这里只更新内存数据，
    // 等 route-activated 恢复入树后再强制完整重绘。
    if (container.hidden || !container.isConnected) {
      pendingMessagesRefreshOnResume = true;
      lastPaintSnapshot = null;
      return;
    }
    pendingMessagesRefreshOnResume = false;
    const main = container.querySelector('.chat-thread-messages');
    if (!main) return;
    // 右滑回复使用消息区事件委托，绑定成本很低，必须在所有提前返回分支之前落实。
    // 首屏完整绘制后的 rAF 可能被紧接着的流式/异步刷新推进 seq 而作废；如果最终
    // 刷新又命中增量分支，旧写法就再也不会补绑，表现为整页右滑失效，重进才恢复。
    bindBubbleSwipeReply(main, {
      isDisabled: () => selectionMode || isStreaming || observerLike,
      onReply: (msgId) => {
        const msg = messages.find((m) => m.id === msgId);
        if (msg) setReplyTo(msg);
      },
    });
    cancelBubbleReveal();
    const activeStream = getChatStreamSession(chatId);
    const shouldShowLocalStream = !streamingPreviewPaintedThisTurn && (
      showStream
      || isStreaming
      || !!(activeStream && !activeStream.abortController?.signal?.aborted)
    );
    const shouldShowStream = shouldShowLocalStream || backgroundTypingActive();
    const seq = ++messageRenderSeq;
    const preserveScrollTop = selectionMode ? main.scrollTop : null;
    const { visible, renderMessages, hiddenCount } = getRenderableMessages();
    if (messagesLoading) {
      lastPaintSnapshot = null;
      main.innerHTML = `
        <div class="chat-empty scrapbook-empty">
          ${emptyIllustration('message')}
          <div class="chat-empty-text">加载中</div>
        </div>
      `;
      syncChatWallpaperShell(container, chat);
      updateScrollBottomFab();
      return;
    }
    if (!visible.length && !shouldShowStream) {
      lastPaintSnapshot = null;
      main.innerHTML = `
        <div class="chat-empty scrapbook-empty">
          ${emptyIllustration('message')}
          <div class="chat-empty-text">还没有消息</div>
          <div class="chat-empty-hint">发送消息后，点「推进」让角色回应</div>
          ${hasOlderMessages ? `<button type="button" class="chat-load-older" data-load-older>加载更早的 ${CHAT_THREAD_RENDER_BATCH} 条</button>` : ''}
        </div>
      `;
      main.querySelector('[data-load-older]')?.addEventListener('click', () => void loadOlderMessages());
      syncChatWallpaperShell(container, chat);
      updateScrollBottomFab();
      return;
    }
    const preOlderScroll = preserveScrollAfterOlderLoad
      ? { h: main.scrollHeight, t: main.scrollTop }
      : null;
    preserveScrollAfterOlderLoad = false;
    const anonymousProfiles = buildAnonymousProfiles();

    // 常规气泡追加（包括带逐条揭示的 AI 回复）走快速路径，整个函数到此为止：
    // 不整表重绘，也不需要贴纸池那趟异步补渲染。揭示节点会在同一任务内先隐藏，
    // 不会先完整露出一帧。
    if (tryIncrementalAppendPaint(main, {
      renderMessages,
      shouldShowStream,
      anonymousProfiles,
      preserveScrollTop,
      preOlderScroll,
      seq,
      revealIds,
    })) {
      return;
    }

    const paintMessages = (stickerResolver = null, { hydrate = false } = {}) => {
      if (seq !== messageRenderSeq) return;
      // 悬浮「回底」键用 160px 判近底；钉底判断若仍用 12px，会在「看起来已在底」时
      // 不跟滚，「正在输入」只露半截。开推/流式占位时再放宽一档。
      const wasAtBottom = isNearBottom(main, shouldShowStream ? CHAT_SCROLLBOTTOM_FAB_THRESHOLD : 80);
      // innerHTML 整体替换会把 main.scrollTop 直接清零（旧内容先被摘空，浏览器不会
      // 记得换新内容前的位置）；下面「保持原位」分支如果换完再读 main.scrollTop 只会
      // 读到这个被清零后的 0，必须在替换前把原始值存下来。
      const scrollTopBeforeRepaint = main.scrollTop;
      // 贴纸池解析这类「hydrate:true」的静默补渲染，是在首次画完之后异步另起一个
      // task 才跑到这里的；如果沿用外层 refreshMessages 调用时那一刻算出来的
      // stickToBottom，很容易读到过期状态（比如那之后 holdBottomUntilSettled
      // 已经翻掉，或者用户已经在中途划走了），把视图错误地钉在别处或干脆停在
      // innerHTML 替换后被浏览器重置的顶部。这里改成每次画之前当场重新判断。
      const stickToBottom = !pendingSearchJumpId && (holdBottomUntilSettled
        || (preOlderScroll == null && preserveScrollTop == null && wasAtBottom));
      // 长会话的可见窗口会随新消息滑动；若用户确实在看历史，必须按屏幕上的消息
      // 恢复位置。只保留旧 scrollTop 像素值，会在窗口换页或气泡高度变化后落到更早记录。
      const viewportState = !stickToBottom && preOlderScroll == null && preserveScrollTop == null
        ? captureHistoryViewportState(main)
        : null;
      if (!hydrate && !(revealIds && revealIds.length) && tryIncrementalStreamPaint(main, {
        renderMessages,
        hiddenCount,
        shouldShowStream,
        anonymousProfiles,
        preserveScrollTop,
        preOlderScroll,
        seq,
      })) {
        return;
      }
      // 大图与贴纸始终只在进入可视区域时读取。不能因为首屏已经稳定，就把当前
      // 消息数组里的所有 data URL 一次性塞回 DOM；iOS WebKit 会同时保留字符串与
      // 解码位图，媒体较多的会话可能因此直接结束页面进程。
      const displayMessages = renderMessages.map((m) => deferHeavyMediaForDisplay(m));
      const renderOptions = buildMessageRenderOptions(anonymousProfiles, stickerResolver);
      const olderButton = (hasOlderMessages || hiddenCount > 0)
        ? `<button type="button" class="chat-load-older ${olderMessagesLoading ? 'is-loading' : ''}" data-load-older ${olderMessagesLoading ? 'disabled' : ''}>${olderMessagesLoading ? '加载中…' : `加载更早的 ${hasOlderMessages ? CHAT_THREAD_RENDER_BATCH : Math.min(CHAT_THREAD_RENDER_BATCH, hiddenCount)} 条`}</button>`
        : '';
      const latestButton = hasNewerMessages
        ? '<button type="button" class="chat-load-older chat-return-latest" data-return-latest>回到最新消息</button>'
        : '';
      const nextHtml = olderButton + renderMessagesHtml(displayMessages, renderOptions)
        + latestButton
        + (shouldShowStream ? buildStreamPlaceholderHtml(anonymousProfiles) : '');
      let preparedReveal = null;
      if (!hydrate && revealIds && revealIds.length) {
        // 新回复先在离屏 fragment 上进入 pending 状态，再一次性挂进页面。
        // WebKit 即使在大段 innerHTML 解析期间提交合成帧，也看不到完整回复抢先闪现。
        cancelBubbleReveal();
        const template = document.createElement('template');
        template.innerHTML = nextHtml;
        preparedReveal = markBubbleRevealPending(template.content, revealIds);
        reconcileMessagePaint(main, template.content, { retainStreamPlaceholder: true });
      } else {
        const template = document.createElement('template');
        template.innerHTML = nextHtml;
        reconcileMessagePaint(main, template.content);
      }
      // 这些是真正承载业务动作的按钮，必须在 DOM 落地的同一任务里挂好。
      // 若延后到下一帧，「正在输入」恰好结束时的增量刷新会推进 messageRenderSeq，
      // 旧回调随即被判过期，卡片虽然可见却永远没有 click 监听。
      bindRenderedCardInteractions();
      // 落库早就是整轮一次性写完的；innerHTML 后立刻把本轮新消息藏住再按序揭开，
      // 避免先完整露出、再被其它逻辑二次刷新成「假装流式」。
      if (!hydrate && revealIds && revealIds.length) {
        startBubbleReveal(main, revealIds, seq, preparedReveal);
      }
      const htmlExtensionSnapshots = {};
      renderMessages.forEach((message) => {
        if (message?.type === 'htmlWidget' && message.id && message.metadata?.htmlExtension) {
          htmlExtensionSnapshots[String(message.id)] = {
            ...message.metadata.htmlExtension,
            name: message.senderName || message.metadata.htmlExtension.name,
          };
        }
      });
      hydrateHtmlExtensionHosts(main, htmlExtensionSnapshots, {
        onOpenLink: (url, linkOptions) => openLinkPreview(url, linkOptions),
      });
      void hydrateInlineInnerVoices(main, renderMessages, seq);
      restoreExpandedTranslations(main);
      if (
        stickToBottom
        && preOlderScroll == null
        && preserveScrollTop == null
        && !isBubbleRevealActive()
      ) {
        main.scrollTop = main.scrollHeight;
        scheduleLatestFollowRepair(main);
      }
      main.querySelector('[data-load-older]')?.addEventListener('click', () => {
        if (hasOlderMessages) {
          void loadOlderMessages();
          return;
        }
        visibleMessageLimit += CHAT_THREAD_RENDER_BATCH;
        preserveScrollAfterOlderLoad = true;
        refreshMessages(shouldShowStream);
      });
      main.querySelector('[data-return-latest]')?.addEventListener('click', async () => {
        const page = await listMessagesPageForChat(chatId, {
          limit: CHAT_THREAD_RENDER_BATCH,
          deferHeavyImages: true,
        });
        messages = page.messages;
        hasOlderMessages = page.hasMore;
        hasNewerMessages = false;
        visibleMessageLimit = CHAT_THREAD_RENDER_BATCH;
        beginFollowingLatestMessages();
        refreshMessages(false);
      });
      // bind* 这一串只是给已经画好的气泡/卡片挂事件监听，不影响这一帧的布局和滚动位置；
      // 长会话时这一串要对上百个节点各自 querySelectorAll + addEventListener，跟 innerHTML
      // 替换挤在同一个同步任务里，会让"点发送/推进"到真正看见气泡/正在输入之间感觉卡一拍。
      // 挪到下一帧再挂，先把这次已经算好的内容和滚动位置画出来。
      requestAnimationFrame(() => {
        // 后一轮刷新即使只改了流式占位，也不能把本轮交互补绑永久取消。
        // 只核验消息区仍是当前节点；具体气泡用幂等标记避免重复监听。
        if (!main.isConnected || container.querySelector('.chat-thread-messages') !== main) return;
        bindBubbleMenus();
        bindSystemHintMenus();
        // 事件委托挂在 container：逐条冒泡会短暂摘掉语音节点，按节点绑会漏挂，返回重进才恢复。
        bindVoiceBubbleInteractions(container, () => messages, {
          onRefresh: () => refreshMessages(),
          captureViewport: () => captureHistoryViewportState(main),
          restoreViewport: (state) => stabilizeHistoryViewport(main, state),
        });
        bindSelectionHandlers();
        bindLazyMediaHydration(main);
      });
      lastPaintSnapshot = {
        messageIds: renderMessages.map((m) => m.id),
        hiddenCount,
        shouldShowStream,
      };
      refreshHeaderSpark();
      if (pendingSearchJumpId && !hydrate) {
        const jumpId = pendingSearchJumpId;
        pendingSearchJumpId = '';
        scheduleSearchJumpScroll(jumpId);
      } else if (preOlderScroll && !hydrate) {
        // 取消可能还在运行的「钉到底部」RAF，否则它会把刚恢复的位置又拉回底部。
        if (scrollToBottomRaf) {
          cancelAnimationFrame(scrollToBottomRaf);
          scrollToBottomRaf = 0;
        }
        main.scrollTop = preOlderScroll.t + (main.scrollHeight - preOlderScroll.h);
      } else if (preserveScrollTop != null) {
        main.scrollTop = preserveScrollTop;
      } else if ((stickToBottom || wasAtBottom) && isBubbleRevealActive()) {
        // 待揭示节点不参与布局；同步停在当前可见内容底部，首条揭示时再按真实高度上推。
        main.scrollTop = main.scrollHeight;
        releaseThreadScrollFlash();
      } else if (stickToBottom || wasAtBottom) {
        // 同步钉底后再放开 settling：同一帧内完成，减少「先空一下再出气泡」。
        main.scrollTop = main.scrollHeight;
        if (suppressThreadScrollFlash && holdBottomUntilSettled) armThreadScrollFlash();
        if (shouldShowStream) {
          pinThreadForActiveStream();
        } else {
          scrollToBottom(() => {
            tryReleaseEntryFlash();
          });
        }
        // 双 rAF 后再兜一次，图片尚未撑开高度时也能尽快揭开。
        requestAnimationFrame(() => {
          requestAnimationFrame(() => tryReleaseEntryFlash());
        });
      } else {
        // 只有原本就在底部时才跟着钉底；历史阅读位置优先锚定可见消息，找不到锚点
        // 才退回旧像素值。这样渲染窗口滑动、心声/图片补高度都不会跳到更早记录。
        if (!stabilizeHistoryViewport(main, viewportState)) {
          restoreMessageViewportAnchor(main, viewportState?.anchor, scrollTopBeforeRepaint);
        }
      }
      scheduleGenImageStatusRefresh();
      syncChatWallpaperShell(container, chat);
      // scrollTop 数值没变时浏览器不会派发 scroll 事件（比如内容变高但保持原有像素值），
      // 单靠监听 scroll 会让按钮显隐状态滞后一拍，这里每次重绘后主动校正一次。
      positionScrollBottomFab();
      updateScrollBottomFab();
    };

    paintMessages(null);

    if (shouldResolveStickerPool(renderMessages)) {
      void (async () => {
        const {
          buildStickerPoolResolverForMessages,
          resolveStickerBubbleImageUrl,
        } = await import('../core/chat/sticker-resolve.js');
        const stickerResolver = await buildStickerPoolResolverForMessages(renderMessages);
        if (seq !== messageRenderSeq || !main.isConnected) return;
        await patchStickerSlotsInPlace(
          main,
          renderMessages,
          stickerResolver,
          resolveStickerBubbleImageUrl,
          seq,
        );
        // 增量补图后仍有「[表情]」占位才整表重绘一次（兜底）；已有 <img> 的动图不会被拆掉
        const stillPlaceholder = !!main.querySelector('.chat-bubble-tag')
          && renderMessages.some((m) => m?.type === 'sticker');
        if (stillPlaceholder) {
          paintMessages(stickerResolver, { hydrate: true });
        }
      })().catch((error) => {
        // 贴纸补图是静默增强，失败不能升级成全局 unhandledrejection，
        // 更不能让同一会话的刷新循环不断积累错误。
        console.warn('[chat-sticker-patch] skipped', error);
      });
    }
  }

  function bindOfflineJoinIntentCards() {
    const main = container.querySelector('.chat-thread-messages');
    if (!main || main.dataset.offlineJoinActionsBound === '1') return;
    main.dataset.offlineJoinActionsBound = '1';
    // 消息区会在流式揭示、贴纸补图和页面恢复时反复重写 innerHTML。
    // 监听挂在稳定的消息容器上，避免卡片节点被替换后只剩按钮外观却没有 click。
    main.addEventListener('click', async (event) => {
      const button = event.target?.closest?.('[data-offline-join-action]');
      if (!button || !main.contains(button)) return;
      const card = button.closest('[data-offline-join-job]');
      if (!card || card.dataset.offlineJoinBusy === '1') return;
      event.preventDefault();
      event.stopPropagation();
      const row = card.closest('[data-msg-id]');
      const msgId = String(row?.getAttribute('data-msg-id') || '');
      const message = messages.find((item) => String(item.id) === msgId);
      const jobId = String(card.getAttribute('data-offline-join-job') || '');
      const action = String(button.getAttribute('data-offline-join-action') || '');
      if (!message || !['accept', 'reject', 'later'].includes(action)) {
        showToast('这条加入请求已失效');
        return;
      }
      card.dataset.offlineJoinBusy = '1';
      card.setAttribute('aria-busy', 'true');
      card.querySelectorAll('button').forEach((item) => { item.disabled = true; });
      try {
        // 旧消息或清理后的任务可能已经找不到 job；消息自身仍有现场和角色字段时照常处理。
        const job = jobId ? await getOfflinePhoneCinematicJob(jobId) : null;
        const offlineSessionChatId = String(message.metadata?.offlineSessionChatId || job?.offlineChatId || '');
        const characterId = String(message.metadata?.offlineJoinCharacterId || job?.senderCharacterId || '');
        const characterName = String(message.metadata?.offlineJoinCharacterName || job?.senderName || 'TA');
        if (action === 'accept') {
          const offlineSession = await loadOfflineSession(offlineSessionChatId);
          if (!offlineSession || offlineSession.status !== 'active') throw new Error('这场线下已经结束');
          const offlineChat = await getChat(offlineSessionChatId);
          await joinOfflineParticipant({
            session: offlineSession,
            chat: offlineChat,
            characterId,
            source: 'phone_join_intent',
            text: `你同意了${characterName}加入现场，${characterName}随后赶来汇合。`,
          });
        } else if (action === 'reject') {
          const offlineSession = await loadOfflineSession(offlineSessionChatId);
          if (offlineSession?.status === 'active') {
            const offlineChat = await getChat(offlineSessionChatId);
            await withdrawOfflineParticipantInvite({
              session: offlineSession,
              chat: offlineChat,
              characterId,
              source: 'phone_join_rejected',
              text: `你看见了${characterName}想加入现场的消息，但这次没有叫 TA 过来。`,
            });
          }
        }
        const decision = action === 'accept' ? 'accepted' : (action === 'reject' ? 'rejected' : 'later');
        message.metadata = { ...(message.metadata || {}), offlineJoinDecision: decision };
        const writes = [saveMessage(message)];
        if (jobId) {
          writes.push(updateOfflinePhoneCinematicJob(jobId, {
            joinDecision: decision,
            joinDecisionAt: Date.now(),
          }));
        }
        await Promise.all(writes);
        messages = messages.map((item) => (item.id === message.id ? { ...item, metadata: message.metadata } : item));
        refreshMessages();
        showToast(action === 'accept' ? `${characterName}会来现场` : (action === 'reject' ? '已拒绝' : '已留到稍后处理'));
      } catch (err) {
        showToast(`失败：${err?.message || err}`);
        if (card.isConnected) {
          card.querySelectorAll('button').forEach((item) => { item.disabled = false; });
        }
      } finally {
        if (card.isConnected) {
          delete card.dataset.offlineJoinBusy;
          card.removeAttribute('aria-busy');
        }
      }
    });
  }

  function bindOfflineInviteCards() {
    container.querySelectorAll('[data-card-type="offline-invite"]').forEach((card) => {
      const row = card.closest('[data-msg-id]');
      const msgId = row?.getAttribute('data-msg-id');
      const msg = messages.find((m) => m.id === msgId);
      if (!msg) return;
      const isGroupInvite = msg.metadata?.isGroupInvite === true && isGroup;
      // 邀约真正「成立」（用户接受/进入）的这一刻，顶掉角色当天日程里那个时间段原有的安排，
      // 而不是只当一句聊天记录软提示；解析不出具体日期就跳过，不硬造安排。
      const applyScheduleOverride = async () => {
        const scheduleCharId = isGroupInvite
          ? String(msg.metadata?.initiatorId || msg.senderId || partnerId || '').trim()
          : partnerId;
        if (!scheduleCharId || msg.metadata?.scheduleApplied) return;
        const at = await getNowForUser(user.id).catch(() => Date.now());
        const plan = await applyOfflineInviteScheduleFromMessage({
          userId: user.id,
          characterId: scheduleCharId,
          message: msg,
          nowTs: at,
        }).catch(() => null);
        if (!plan) return;
        msg.metadata = { ...(msg.metadata || {}), scheduleApplied: true };
        await saveMessage(msg).catch(() => {});
        messages = messages.map((m) => (m.id === msgId ? { ...m, metadata: msg.metadata } : m));
      };
      const enterOffline = async () => {
        try {
          const existingSession = await loadOfflineSession(chatId).catch(() => null);
          const existingInviteId = String(existingSession?.originSeed?.inviteMessageId || '').trim();
          const currentInviteId = String(msg?.id || '').trim();
          const resumesCurrentInvite = !!existingSession
            && !!existingInviteId
            && existingInviteId === currentInviteId;
          const preservesProgress = offlineSessionHasProgress(existingSession);
          let experienceMode = existingSession?.scene?.experienceMode || '';
          if (!resumesCurrentInvite && !preservesProgress) {
            experienceMode = await chooseOfflineExperienceMode({
              allowAudio: !isGroupInvite,
              title: '这次怎样见面？',
            });
            if (!experienceMode) return;
          }
          applyScheduleOverride();
          const result = await ensureOfflineSessionFromInvite({
            chatId,
            userId: user.id,
            inviteMessage: msg,
            experienceMode,
          });
          if (result.fulfilled) {
            if (result.archiveId) {
              navigate('offline/archive', { id: result.archiveId });
              return;
            }
            showToast('这次见面已经结束了');
            return;
          }
          if (result.blockedByExisting) {
            showToast('这段对话还有未收纳的线下，已打开现有进度');
            navigate('offline', { chatId });
            return;
          }
          navigate('offline', result.justStarted ? { chatId, justStarted: '1' } : { chatId });
        } catch (err) {
          showToast(`失败：${err?.message || err}`);
        }
      };
      const patchStatus = async (status, extra = {}) => {
        msg.metadata = { ...(msg.metadata || {}), status, ...extra };
        await saveMessage(msg);
        messages = messages.map((m) => (m.id === msgId ? { ...m, metadata: msg.metadata } : m));
      };
      /**
       * 邀约撞车：用户正在别的聊天里进行未收纳线下时，别的角色又发来邀约。
       * 不走普通接受流程，改为「婉拒 / 引入本次约会」二选一。返回 true 表示已接管。
       */
      const maybeHandleInviteCollision = async () => {
        if (!msg.metadata?.inviteFrom || msg.metadata.inviteFrom !== 'character') return false;
        if (isGroupInvite) return false;
        const other = await findActiveOfflineSessionForUser(user.id, { excludeChatId: chatId }).catch(() => null);
        if (!other) return false;
        const otherPartnerId = (other.chat?.participants || []).find((id) => id && id !== 'user') || '';
        const otherPartner = otherPartnerId ? await getRecord('characters', otherPartnerId).catch(() => null) : null;
        const otherLabel = other.chat?.groupSettings?.name
          || otherPartner?.customNickname || otherPartner?.name
          || '另一场线下';
        const host = document.getElementById('modal-container');
        if (!host) return false;
        const choice = await new Promise((resolve) => {
          const done = (v) => { host.classList.remove('active'); host.innerHTML = ''; resolve(v); };
          host.classList.add('active');
          host.innerHTML = `
            <div class="modal-overlay modal-sheet-center" data-collision-overlay>
              <div class="modal-sheet scrapbook-card" role="dialog" aria-modal="true" aria-label="邀约撞车">
                <header class="modal-header"><h3>你此刻正在线下</h3></header>
                <div class="modal-body off-settle-body">
                  <p class="off-settle-hint">你还在和「${esc(otherLabel)}」的线下里（未收纳）。这份邀约怎么处理？</p>
                  <div class="off-settle-actions" style="flex-direction:column;align-items:stretch;">
                    <button type="button" class="btn btn-primary" data-collision="merge">把 TA 叫来现场汇合</button>
                    <button type="button" class="btn btn-outline" data-collision="decline">婉拒（我在外面有安排）</button>
                    <button type="button" class="btn btn-soft" data-collision="cancel">先不处理</button>
                  </div>
                </div>
              </div>
            </div>`;
          host.querySelector('[data-collision-overlay]')?.addEventListener('click', (e) => {
            if (e.target === host.querySelector('[data-collision-overlay]')) done('cancel');
          });
          host.querySelectorAll('[data-collision]').forEach((b) => {
            b.addEventListener('click', () => done(b.getAttribute('data-collision')));
          });
        });
        if (choice === 'cancel') return true;
        try {
          if (choice === 'decline') {
            showToast('正在替你婉拒…');
            await declineInviteDueToOffline({ user, chat, inviteMessage: msg, activeOffline: other });
            messages = await listThreadMessages();
            refreshMessages();
            showToast('已婉拒，TA 知道你在忙了');
          } else if (choice === 'merge') {
            const result = await mergeInviteIntoOffline({ user, inviteMessage: msg, activeOffline: other });
            messages = messages.map((m) => (m.id === msgId ? { ...m, metadata: msg.metadata } : m));
            refreshMessages();
            showToast(`已把 ${result.senderName} 引入当前线下`);
            navigate('offline', { chatId: result.offlineChatId });
          }
        } catch (err) {
          showToast(`失败：${err?.message || err}`);
        }
        return true;
      };
      const resolveGroupInvite = async (userAccepted, declineReason = '') => {
        if (msg.metadata?.status === 'resolving' || msg.metadata?.status === 'accepted' || msg.metadata?.status === 'others_went') return;
        if (groupInviteActionInflight.has(msgId)) return;
        groupInviteActionInflight.add(msgId);
        card.setAttribute('aria-busy', 'true');
        const actionButton = card.querySelector(userAccepted ? '.offline-invite-accept' : '.offline-invite-decline');
        card.querySelectorAll('button').forEach((button) => { button.disabled = true; });
        if (actionButton) actionButton.textContent = userAccepted ? '正在确认…' : '正在发送…';
        try {
          await patchStatus('resolving', {
            userAttending: userAccepted,
            declineReason: userAccepted ? '' : String(declineReason || '').trim(),
          });
          refreshMessages();
          const result = await resolveGroupOfflineInviteResponse({
            chat,
            user,
            userId: user.id,
            inviteMessage: msg,
            userAccepted,
            declineReason,
            messages,
          });
          const attendingOthers = (result.attendees || []).filter((a) => a.attending && a.id !== 'user');
          let storyCardId = '';
          if (!userAccepted && result.storyCard && attendingOthers.length) {
            const storyMsg = await saveGroupInviteStoryCard({
              chat,
              userId: user.id,
              storyCard: result.storyCard,
              inviteMessage: msg,
              attendeeIds: attendingOthers.map((a) => a.id).filter((id) => id !== 'user'),
            });
            storyCardId = storyMsg?.id || '';
          }
          const nextStatus = userAccepted
            ? 'accepted'
            : (attendingOthers.length ? 'others_went' : 'declined');
          await patchStatus(nextStatus, {
            userAttending: userAccepted,
            declineReason: userAccepted ? '' : String(declineReason || '').trim(),
            groupResponses: result.attendees || [],
            storyCardId,
          });
          refreshMessages();
          if (userAccepted) {
            window.setTimeout(() => { enterOffline(); }, 900);
          } else if (storyCardId) {
            showToast('他们去了，小剧场已更新');
          } else {
            showToast('这次没人成行了');
          }
        } catch (err) {
          await patchStatus('pending', {
            userAttending: undefined,
            declineReason: '',
          }).catch(() => {});
          refreshMessages();
          showToast(`失败：${err?.message || err}`);
        } finally {
          groupInviteActionInflight.delete(msgId);
          if (card.isConnected) {
            card.removeAttribute('aria-busy');
            card.querySelectorAll('button').forEach((button) => { button.disabled = false; });
            if (actionButton) actionButton.textContent = userAccepted ? '赴约' : '婉拒';
          }
        }
      };
      card.querySelector('.offline-invite-enter')?.addEventListener('click', (e) => {
        e.stopPropagation();
        enterOffline();
      });
      card.querySelector('.offline-invite-accept')?.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (isGroupInvite) {
          await resolveGroupInvite(true, '');
          return;
        }
        if (await maybeHandleInviteCollision()) return;
        await patchStatus('accepted');
        enterOffline();
      });
      card.querySelector('.offline-invite-shelve')?.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (isGroupInvite) return;
        await patchStatus('shelved');
        refreshMessages();
        showToast('先搁置了，想好了再回 TA');
      });
      card.querySelector('.offline-invite-decline')?.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (isGroupInvite) {
          openTextEditorModal({
            title: '婉拒这次邀约',
            placeholder: '可以说为什么去不了（可选）',
            multiline: true,
            confirmLabel: '发送婉拒',
            onSave: async (reason) => {
              await resolveGroupInvite(false, reason);
            },
          });
          return;
        }
        await patchStatus('declined');
        refreshMessages();
        showToast('已婉拒这次邀约');
      });
    });
  }

  function bindRenderedCardInteractions() {
    bindStoryCardInteractions();
    bindCardInteractions();
    bindOfflineJoinIntentCards();
    bindOfflineInviteCards();
    bindVoteCards();
    bindNpcCardCards();
    bindGroupInviteUserCards();
  }

  function bindCardInteractions() {
    container.querySelectorAll('[data-order-share-image]').forEach((image) => {
      image.addEventListener('error', () => image.remove(), { once: true });
    });
    container.querySelectorAll('[data-card-type]:not([data-card-type="story-card"]):not([data-card-type="offline-invite"]):not([data-card-type="npc-card"])').forEach((card) => {
      const row = card.closest('[data-msg-id]');
      const msgId = String(row?.getAttribute('data-msg-id') || '');
      // 旧备份里少量消息 id 是数字；写进 data-msg-id 后一定会变成字符串。
      // 这里若做严格类型比较，卡片能正常显示，却不会挂上 click——电脑端旧存档
      // 最容易表现为红包、转账、位置等功能卡“看得见但点不开”。
      let msg = messages.find((m) => String(m?.id || '') === msgId);
      if (!msg) return;
      if (msg.type === 'voice') return;
      if (msg.type === 'link') {
        const internalLink = resolveChatInternalLink(msg);
        if (internalLink) {
          const openInternalLink = (e) => {
            if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
            e.preventDefault();
            e.stopPropagation();
            navigate(internalLink.path, internalLink.params);
          };
          card.addEventListener('click', openInternalLink);
          card.addEventListener('keydown', openInternalLink);
          return;
        }
        if (card.matches('[data-link-preview="1"]')) {
          if (card.dataset.linkInteractionBound === '1') return;
          card.dataset.linkInteractionBound = '1';
          const detailAction = card.querySelector('[data-link-read-detail="1"]');
          const readDetail = (e) => {
            if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
            e.preventDefault();
            e.stopPropagation();
            void readTaobaoLinkDetailWithRole(msg, detailAction);
          };
          detailAction?.addEventListener('click', readDetail);
          detailAction?.addEventListener('keydown', readDetail);
          card.addEventListener('click', (e) => {
            if (e.target?.closest?.('[data-link-read-detail="1"]')) return;
            e.preventDefault();
            e.stopPropagation();
            const href = card.getAttribute('href') || msg.metadata?.url || msg.content || '';
            if (href) openLinkPreview(href, { title: msg.metadata?.title || '链接预览' });
          });
          return;
        }
        if (card.matches('[data-link-open="1"]')) return;
      }
      card.addEventListener('click', async (e) => {
        if (msg.type === 'orderShare' && msg.metadata?.mcpCheckout === true && msg.metadata?.shoppingOrderId) {
          e.preventDefault();
          e.stopPropagation();
          const route = String(msg.metadata?.shoppingRoute || '').trim()
            || ({ 'mcd-cn': 'shopping/mcd', 'luckin-cn': 'shopping/luckin', 'meituan-cn': 'shopping/meituan' }[msg.metadata?.shoppingProviderId] || 'shopping');
          navigate(route, { order: msg.metadata.shoppingOrderId, from: 'chat', chatId });
          return;
        }
        if (msg.type === 'radioEpisode') {
          e.preventDefault();
          e.stopPropagation();
          const episodeId = String(msg.metadata?.radioEpisodeId || '').trim();
          if (episodeId) navigate('radio', { id: episodeId, from: 'chat', chatId });
          return;
        }
        if (msg.type === 'voiceCall') {
          e.preventDefault();
          e.stopPropagation();
          const state = normalizeVoiceCallState(msg.metadata?.callState || msg.metadata?.state || '');
          if (e.target.closest('.voice-call-decline')) {
            const liveCall = findLiveVoiceCallController(msg);
            if (liveCall) {
              if (state === 'incoming') await liveCall.declineCall?.();
              else await liveCall.endCall?.();
              return;
            }
            const callState = state === 'outgoing'
              ? 'cancelled'
              : (state === 'active' ? 'ended' : 'declined');
            const updated = await updateVoiceCallMessage(msg, { callState, state: callState });
            await saveVoiceCallRecordForMessage(updated, { callState });
            refreshMessages();
            return;
          }
          if (e.target.closest('.voice-call-end')) {
            const liveCall = findLiveVoiceCallController(msg);
            if (liveCall) {
              await liveCall.endCall?.();
              return;
            }
            const updated = await updateVoiceCallMessage(msg, { callState: 'ended', state: 'ended' });
            await saveVoiceCallRecordForMessage(updated, { callState: 'ended' });
            refreshMessages();
            return;
          }
          if (e.target.closest('.voice-call-answer')) {
            cancelVoiceMessagePlayback();
            await openVoiceCallFromMessage(msg, {
              answerNow: state !== 'outgoing',
              gestureToken: captureMediaGesture(e),
            });
            return;
          }
          if (state === 'incoming' || state === 'outgoing' || state === 'active') {
            cancelVoiceMessagePlayback();
            await openVoiceCallFromMessage(msg, {
              answerNow: state === 'active',
              gestureToken: captureMediaGesture(e),
            });
            return;
          }
          openVoiceCallRecordModal(msg.metadata?.voiceCallRecord || buildVoiceCallRecord(msg, {
            callState: state,
            duration: msg.metadata?.duration || '',
          }));
          return;
        }
        if (msg.type === 'redpacket') {
          const [persisted, allMessages] = await Promise.all([
            getRecord('messages', msg.id).catch(() => null),
            listMessagesForChat(chatId, 0).catch(() => messages),
          ]);
          const reconciled = reconcileRedPacketClaimNotices(
            persisted?.type === 'redpacket' ? persisted : msg,
            allMessages,
          );
          msg = reconciled.message;
          if (reconciled.changed) await saveMessage(msg);
          messages = messages.map((item) => (String(item?.id || '') === String(msg.id) ? msg : item));
        }
        openChatCardModal(msg, {
          currentUserId: user.id || 'user',
          variant: anonEditorVariant(),
          resolveDisplayName: (id) => recallActorName(id),
          onMetadataUpdate: async (next) => {
            const nextMeta = next?.metadata && typeof next.metadata === 'object'
              ? next.metadata
              : (next && typeof next === 'object' ? next : null);
            if (!nextMeta) return;
            msg.metadata = { ...nextMeta };
            await saveMessage(msg);
            messages = messages.map((m) => (m.id === msg.id ? { ...m, metadata: msg.metadata } : m));
            // 合并聊天记录里的语音首次生成缓存时，只需把子消息快照落库。
            // 父卡片外观没有变化；整表重绘会让旧消息窗口丢失滚动锚点。
            if (msg.type !== 'chatBundle' && msg.type !== 'mergeForward') refreshMessages();
          },
          onTransferSettled: async (transfer, state) => {
            if (state !== 'accepted') return;
            const receipt = createTransferReceiptMessage(transfer, {
              actorId: 'user',
              actorName: user.name || '我',
              timestamp: await getNowForUser(user.id),
            });
            if (receipt) await persistUserMessage(receipt);
          },
          onSystemEvent: async (text, meta = {}) => {
            const sys = createMessage({
              chatId,
              senderId: 'system',
              senderName: '系统',
              type: 'system',
              content: String(text || '').trim(),
              timestamp: await getNowForUser(user.id),
              metadata: { ...(meta || {}), sourceFinanceMessageId: msg.id },
            });
            await persistUserMessage(sys);
          },
        });
      });
    });
  }

  function bindNpcCardCards() {
    container.querySelectorAll('[data-card-type="npc-card"]').forEach((card) => {
      const row = card.closest('[data-msg-id]');
      const msgId = row?.getAttribute('data-msg-id');
      const msg = messages.find((m) => m.id === msgId);
      if (!msg) return;
      card.querySelector('.npc-card-add')?.addEventListener('click', async (e) => {
        e.stopPropagation();
        const md = msg.metadata || {};
        const npcName = String(md.npcName || msg.content || '').trim();
        if (!npcName) return;
        const revealActorId = String(md.anonymousRevealActorId || '').trim();
        if (revealActorId) {
          if (!window.confirm(`接受「${npcName}」的相认，并把 TA 加入通讯录？\n\n匿名聊天会保留，之后会新建普通聊天窗口。`)) return;
          try {
            const { acceptAnonymousReveal } = await import('../core/anonymous-reveal.js');
            const result = await acceptAnonymousReveal({
              userId: user.id,
              actorId: revealActorId,
              sourceChatId: chat.id,
              name: npcName,
              bio: String(md.npcBio || '').trim(),
            });
            msg.metadata = { ...md, addedContactId: result.character.id, anonymousRevealAccepted: true };
            await saveMessage(msg);
            messages = messages.map((m) => (m.id === msg.id ? { ...m, metadata: msg.metadata } : m));
            refreshMessages();
            showToast(`已和「${result.character.name}」相认`);
            return;
          } catch (err) {
            showToast(`相认失败：${err?.message || err}`);
            return;
          }
        }
        const bioLine = md.npcBio ? `\n${md.npcBio}` : '';
        if (!window.confirm(`把「${npcName}」加入通讯录？${bioLine}\n\n加入后会成为常驻角色，可以正常聊天、参与秘密基地。`)) return;
        try {
          const { saveCharacter } = await import('../core/character-store.js');
          const { resolveCharacterGroupId } = await import('../core/contact-groups.js');
          const referrer = characters[msg.senderId] || null;
          const groupId = referrer ? resolveCharacterGroupId(referrer) : 'default';
          const relation = String(md.relation || '').trim();
          const created = await saveCharacter({
            name: npcName,
            notes: String(md.npcBio || '').trim(),
            groupId,
            roleTier: 'npc',
            relationships: referrer ? { [referrer.id]: relation || '朋友' } : {},
          });
          if (referrer) {
            const nextReferrer = {
              ...referrer,
              relationships: { ...(referrer.relationships || {}), [created.id]: relation || '朋友' },
            };
            await saveCharacter(nextReferrer);
            characters[referrer.id] = nextReferrer;
          }
          characters[created.id] = created;
          msg.metadata = { ...md, addedContactId: created.id };
          await saveMessage(msg);
          messages = messages.map((m) => (m.id === msg.id ? { ...m, metadata: msg.metadata } : m));
          refreshMessages();
          showToast(`已把「${npcName}」加入通讯录`);
        } catch (err) {
          showToast(`加入失败：${err?.message || err}`);
        }
      });
      card.querySelector('.npc-card-view')?.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = e.currentTarget.getAttribute('data-contact-id');
        if (id) navigate('contacts/card', { id });
      });
    });
  }

  function bindGroupInviteUserCards() {
    container.querySelectorAll('[data-card-type="group-invite"]').forEach((card) => {
      const row = card.closest('[data-msg-id]');
      const msgId = row?.getAttribute('data-msg-id');
      const msg = messages.find((m) => m.id === msgId);
      if (!msg) return;
      const patchStatus = async (status) => {
        msg.metadata = { ...(msg.metadata || {}), status, resolvedAt: Date.now() };
        await saveMessage(msg);
        messages = messages.map((m) => (m.id === msgId ? { ...m, metadata: msg.metadata } : m));
      };
      card.querySelector('.group-invite-accept')?.addEventListener('click', async (e) => {
        e.stopPropagation();
        const button = e.currentTarget;
        if (button.disabled) return;
        button.disabled = true;
        try {
          const joined = await promoteBackstageChatToGroup(chatId, {
            userName: currentUserName,
            source: 'invite-card',
          });
          if (!joined?.participants?.includes('user')) throw new Error('加入群聊失败');
          // 入群动作已在存储层统一结清待处理邀请；这里同步当前页面内存，避免跳转前短暂回闪。
          msg.metadata = { ...(msg.metadata || {}), status: 'accepted', resolvedAt: Date.now() };
          messages = messages.map((m) => (m.id === msgId ? { ...m, metadata: msg.metadata } : m));
          showToast('已加入群聊');
          // observerLike / isGroup 等页面状态是进入这个会话时算好的常量，转正后要整页重新
          // 拉取 chat 再渲染才能正确显示输入框——用 replace 导航强制重新走一次 render()；
          // navigate 同步触发的挂起会把转正前的旧页面实例存回 Keep-Alive 缓存，
          // 必须紧接着清掉，否则下次回到这个会话又会翻出那份没有输入框的旧状态。
          navigate('chat/thread', {
            chatId,
            ...(fromCharacterPhone ? { viewer: phoneViewerId, from: 'phone' } : {}),
          }, true);
          invalidateKeepAlive('chat/thread', { chatId });
        } catch (err) {
          button.disabled = false;
          showToast(`加入失败：${err?.message || err}`);
        }
      });
      card.querySelector('.group-invite-decline')?.addEventListener('click', async (e) => {
        e.stopPropagation();
        await patchStatus('declined');
        const notice = createMessage({
          chatId,
          senderId: 'system',
          type: 'system',
          content: '你暂时没有加入这个群聊',
          timestamp: await getNowForUser(user.id),
          metadata: { groupInviteUserId: msg.id, groupInviteResolution: 'declined' },
        });
        await saveMessage(notice);
        await updateChatPreview(chatId, previewFromMessage(notice), notice.timestamp);
        messages = [...messages, notice];
        refreshMessages();
        showToast('这次先不加入了');
      });
    });
  }

  function bindVoteCards() {
    container.querySelectorAll('.vote-card-opt[data-vote-idx]').forEach((opt) => {
      opt.addEventListener('click', async (e) => {
        e.stopPropagation();
        const row = opt.closest('[data-msg-id]');
        const msgId = row?.getAttribute('data-msg-id');
        const msg = messages.find((m) => m.id === msgId);
        if (!msg || msg.metadata?.voteClosed) return;
        const idx = Number(opt.getAttribute('data-vote-idx'));
        const opts = msg.metadata?.voteOptions || [];
        const key = String(opts[idx] ?? idx);
        const counts = { ...(msg.metadata?.voteCounts || {}) };
        const voters = { ...(msg.metadata?.voteVoters || {}) };
        const previous = String(voters.user || '');
        if (previous === key) return;
        if (previous && Number(counts[previous]) > 0) {
          counts[previous] = Math.max(0, Number(counts[previous]) - 1);
        }
        counts[key] = (Number(counts[key]) || 0) + 1;
        voters.user = key;
        msg.metadata = { ...(msg.metadata || {}), voteCounts: counts, voteVoters: voters };
        await saveMessage(msg);
        messages = messages.map((m) => (m.id === msg.id ? { ...m, metadata: msg.metadata } : m));
        refreshMessages();
      });
    });
  }

  function syncSelectionDom() {
    const main = container.querySelector('.chat-thread-messages');
    if (!main) return;
    main.querySelectorAll('[data-msg-id]').forEach((row) => {
      const checkbox = [...row.children].find((child) => child.classList?.contains('chat-bubble-select'));
      if (!checkbox) return;
      const id = String(row.getAttribute('data-msg-id') || '');
      const selected = selectionMode && selectedSet.has(id);
      row.classList.toggle('is-selectable', selectionMode);
      row.classList.toggle('is-selected', selected);
      checkbox.hidden = !selectionMode;
      checkbox.checked = selected;
    });
  }

  function refreshSelectionUi() {
    refreshActionArea();
    syncSelectionDom();
    bindSelectionHandlers();
  }

  function bindSelectionHandlers() {
    if (!selectionMode) return;
    container.querySelectorAll(
      '.chat-bubble-row.is-selectable, .chat-msg-bubble.is-selectable, .chat-msg-card.is-selectable, .chat-msg-media.is-selectable, .chat-narration-row.is-selectable, .system-hint-row.is-selectable',
    ).forEach((row) => {
      if (selectionBoundNodes.has(row)) return;
      selectionBoundNodes.add(row);
      const toggleId = (id) => {
        if (!id) return;
        if (selectionPurpose === 'guidance-exit') {
          const msg = messages.find((m) => m.id === id);
          if (!msg || !isGuidanceMessage(msg)) {
            showToast('退出指导时只能勾选指导相关气泡');
            return;
          }
        }
        if (selectedSet.has(id)) selectedSet.delete(id);
        else selectedSet.add(id);
        syncSelectionDom();
        refreshActionArea();
      };
      const checkbox = row.querySelector('.chat-bubble-select');
      checkbox?.addEventListener('change', (e) => {
        e.stopPropagation();
        const id = row.getAttribute('data-msg-id');
        if (!id) return;
        if (selectionPurpose === 'guidance-exit') {
          const msg = messages.find((m) => m.id === id);
          if (!msg || !isGuidanceMessage(msg)) {
            checkbox.checked = false;
            showToast('退出指导时只能勾选指导相关气泡');
            return;
          }
        }
        if (checkbox.checked) selectedSet.add(id);
        else selectedSet.delete(id);
        syncSelectionDom();
        refreshActionArea();
      });
      row.addEventListener('click', (e) => {
        if (e.target.closest('.chat-bubble-select')) return;
        toggleId(row.getAttribute('data-msg-id'));
      });
    });
  }

  function refreshReplyBar() {
    const existing = container.querySelector('.chat-reply-bar');
    if (!replyTarget) {
      existing?.remove();
      return;
    }
    const html = `
      <div class="chat-reply-bar scrapbook-panel">
        <span>回复 ${esc(currentReplyTargetLabel())}：${esc(replyTarget.preview || '')}</span>
        <button type="button" class="chat-reply-cancel" data-cancel-reply aria-label="取消回复">${icon('close')}</button>
      </div>
    `;
    if (existing) {
      existing.outerHTML = html;
      return;
    }
    const anchor = container.querySelector('.chat-selection-bar')
      || container.querySelector('.chat-thread-composer');
    anchor?.insertAdjacentHTML('beforebegin', html);
  }

  // 顶栏装饰用的双头像（对方+我）：默认 display:none，供消息界面自定义 CSS / 内置美化预设开启使用
  function renderTitleDuoHtml() {
    if (isGroup || anonymousChat || !partner) return '';
    const themProfile = strangerChat
      ? (visibleIdentityFor(chat.metadata, principalKey('character', partnerId), partner) || partner)
      : partner;
    const meProfile = frontStageUserProfile();
    const them = characterAvatarHtml(themProfile, { className: 'chat-title-duo-img' });
    const me = characterAvatarHtml(meProfile, { className: 'chat-title-duo-img' });
    return `<span class="chat-title-duo" aria-hidden="true"><span class="chat-title-duo-avatar is-them">${them}</span><span class="chat-title-duo-avatar is-user">${me}</span></span>`;
  }

  function patchTitleDuoDom() {
    if (wechatChatPlatform) return;
    const titleButton = container.querySelector('.chat-thread-title-btn');
    if (!titleButton) return;
    const current = titleButton.querySelector('.chat-title-duo');
    const nextHtml = renderTitleDuoHtml();
    if (!nextHtml) {
      current?.remove();
      return;
    }
    if (current) current.outerHTML = nextHtml;
    else titleButton.insertAdjacentHTML('afterbegin', nextHtml);
  }

  function renderStrangerActions() {
    if (!strangerChat || fromCharacterPhone) return '';
    const state = String(chat.metadata?.friendshipState || 'stranger');
    const userKey = principalKey('user', user.id);
    const charKey = principalKey('character', partnerId);
    const userUsesAlias = !!chat.metadata?.accountIdentityMap?.[userKey];
    const subjectKey = userUsesAlias ? userKey : charKey;
    const revealState = String(chat.metadata?.identityReveal?.[subjectKey]?.state || 'hidden');
    const blockedByCharacter = isUserAliasBlockedByCharacter(chat);
    const characterRequestedFriend = state === 'requested'
      && String(chat.metadata?.friendshipDecision || '') === 'request'
      && String(chat.metadata?.friendshipDecisionBy || '').startsWith('character:');
    const contactApplication = chat.metadata?.contactApplication || null;
    const outgoingContactRequest = !!contactApplication && state === 'requested';
    const applicationResponseState = String(contactApplication?.responseState || 'queued');
    let stateLabel = '陌生人';
    if (state === 'accepted') stateLabel = '已添加好友';
    else if (blockedByCharacter) stateLabel = '已被对方拉黑';
    else if (state === 'blocked') stateLabel = '已拦截';
    else if (outgoingContactRequest && applicationResponseState === 'running') stateLabel = '好友申请已发送 · 正在等待回应';
    else if (outgoingContactRequest && applicationResponseState === 'failed') stateLabel = '暂时没收到对方回应';
    else if (outgoingContactRequest) stateLabel = '好友申请已发送 · 等待对方回应';
    else if (contactApplication?.status === 'declined') stateLabel = '对方暂未通过好友申请';
    else if (userUsesAlias && state === 'requested') {
      stateLabel = characterRequestedFriend ? '对方发来好友申请' : '好友申请已发送';
    }
    let friendAction = '';
    if (!contactApplication && !blockedByCharacter && state !== 'accepted' && state !== 'blocked') {
      friendAction = userUsesAlias
        ? (state === 'requested'
          ? (characterRequestedFriend
            ? '<button type="button" data-stranger-friend="accepted">通过好友申请</button>'
            : '')
          : '<button type="button" data-stranger-friend="requested">发送好友申请</button>')
        : '<button type="button" data-stranger-friend="accepted">添加好友</button>';
    }
    if (outgoingContactRequest && applicationResponseState === 'failed') {
      friendAction = '<button type="button" data-contact-application-retry>重新询问</button>';
    }
    return `
      <div class="chat-stranger-actions">
        <span>${stateLabel}</span>
        ${friendAction}
        ${partnerId ? '<button type="button" data-stranger-translation-settings>翻译设置</button>' : ''}
        ${!blockedByCharacter && state !== 'blocked' ? '<button type="button" data-stranger-friend="blocked">拦截</button>' : ''}
        ${!blockedByCharacter && state === 'blocked' ? '<button type="button" data-stranger-friend="intercepted">解除拦截</button>' : ''}
        ${!blockedByCharacter && revealState !== 'revealed' ? `<button type="button" data-stranger-reveal="${esc(subjectKey)}">${userUsesAlias ? '公开身份' : '标记已识破'}</button>` : ''}
      </div>
    `;
  }

  function renderAliasPicker() {
    if (!aliasPickerOpen || isGroup || !partnerId) return '';
    const renderRows = (rows, ownerType) => rows.length
      ? rows.map((account) => `
        <button type="button" class="chat-alias-picker-row" data-alias-open="${esc(account.id)}" data-alias-owner="${ownerType}">
          <span class="chat-alias-picker-avatar">${account.avatar ? `<img src="${esc(account.avatar)}" alt="" />` : esc((account.displayName || '?').slice(0, 1))}</span>
          <span><strong>${esc(account.displayName)}</strong>${account.bio ? `<small>${esc(account.bio)}</small>` : ''}</span>
        </button>`).join('')
      : '<div class="chat-alias-picker-empty">还没有</div>';
    return `
      <div class="modal-overlay chat-alias-picker-overlay" data-alias-picker-close>
        <section class="chat-alias-picker" role="dialog" aria-modal="true" aria-label="选择马甲">
          <header><h3>选择马甲</h3><button type="button" data-alias-picker-close aria-label="关闭">${icon('close')}</button></header>
          <div class="chat-alias-picker-section"><span>我的马甲</span>${renderRows(aliasPickerAccounts.user, 'user')}</div>
          <div class="chat-alias-picker-section"><span>TA 的马甲</span>${renderRows(aliasPickerAccounts.character, 'character')}</div>
          <button type="button" class="btn btn-outline chat-alias-picker-manage" data-alias-manage>管理马甲</button>
        </section>
      </div>`;
  }

  function paint() {
    const wantWallpaper = !!String(
      resolveStoredThreadSessionWallpaper(chat)
      || activeAppearance.theme?.customTheme?.chatWallpaper
      || '',
    ).trim();
    // 若容器上已有壁纸层，先确保 src 就绪再整页重写，随后原层挂回——同一张图不重新解码。
    if (wantWallpaper) syncChatWallpaperShell(container, chat);
    const preservedWallpaper = wantWallpaper ? detachChatWallpaperLayer(container) : null;
    container.innerHTML = `
      <div class="chat-thread-safe-top" aria-hidden="true"></div>
      <header class="navbar chat-thread-navbar chat-thread-navbar--with-status">
        <button type="button" class="navbar-btn" data-back aria-label="返回">${wechatChatPlatform ? wechatGlyph('back') : icon('back')}</button>
        <button type="button" class="chat-thread-title-btn" data-open-settings>
          ${wechatChatPlatform ? '' : renderTitleDuoHtml()}
          <div class="chat-thread-title-stack">
            <h1 class="navbar-title"><span>${esc(nativeThreadTitle())}</span>${wechatChatPlatform ? '' : renderHeaderSparkHtml()}</h1>
            ${!wechatChatPlatform && fromCharacterPhone ? `<div class="chat-header-status chat-header-phone-hint">${esc(resolveUiActorName(phoneViewerId, 'TA'))} 的手机视角</div>` : ''}
            ${!wechatChatPlatform && observerLike && !fromCharacterPhone ? `<div class="chat-header-status chat-header-observer-hint">${esc(
    userAbsentGroup
      ? '旁观群聊 · 你不在场'
      : ((chat.participants || []).includes('user')
        ? '旁观模式 · 不会代你发言'
        : '角色私聊 · 用户不在场'),
  )}</div>` : ''}
            ${wechatChatPlatform ? '' : renderHeaderStatusHtml()}
          </div>
        </button>
        <button type="button" class="navbar-btn" data-open-settings aria-label="聊天设定">${wechatChatPlatform ? wechatGlyph('more') : icon('menu')}</button>
        <button type="button" class="navbar-btn chat-scroll-capture-exit" data-act="scroll-capture-exit" aria-label="退出长截图模式">${icon('close')}</button>
      </header>
      ${offlineChatId ? `
        <button type="button" class="chat-offline-return chat-offline-return--thread" data-return-offline>
          <span class="chat-offline-return-dot" aria-hidden="true"></span>
          <span>正在线下 · 手机插曲中</span>
          <strong>返回现场</strong>
        </button>` : ''}
      ${renderActiveEventBanner()}
      ${renderGuidanceBanner()}
      ${renderChatErrorPanel()}
      ${renderStrangerActions()}
      ${renderGroupInfoCards()}
      <main class="chat-thread-messages scrapbook-scroll${suppressThreadScrollFlash && holdBottomUntilSettled ? ' is-entry-settling' : ''}"></main>
      <button type="button" class="chat-thread-scrollbottom-fab" data-scroll-bottom aria-label="回到最新消息">${icon('chevronDown')}</button>
      ${renderComposer()}
      ${renderAliasPicker()}
    `;
    restoreChatWallpaperLayer(container, preservedWallpaper);
    // innerHTML 已换成新的消息区节点；无论壁纸层是否复用，都重新落实透明背景与图片显隐兜底。
    syncChatWallpaperShell(container, chat);
    syncChatNavbarSafeTopFill();
    queueChatNavbarSafeTopFill();
    scheduleComposerDockGapSettle();
    bind();
    bindMessagesScrollHold();
    resizeComposerInput();
    refreshMessages();
    // 兜底：正常路径应该由 refreshMessages 内部钉底完成后自己摘掉
    // is-entry-settling；如果那条路径没触发，短延迟强制放开，避免「空一下」拖太久。
    window.setTimeout(() => tryReleaseEntryFlash(), 220);
  }

  function refreshActionArea() {
    container.classList.toggle('is-selection-mode', selectionMode);
    const sel = container.querySelector('.chat-selection-bar');
    const selHtml = renderSelectionBar();
    if (sel) {
      sel.outerHTML = selHtml || '';
    } else if (selHtml) {
      const anchor = container.querySelector('.chat-thread-composer');
      anchor?.insertAdjacentHTML('beforebegin', selHtml);
    }
    // 后台任务可能在当前页面被 Keep-Alive 挂起时开始/结束；
    // 依据统一生成状态恢复发送键，不能只依赖本页的 isStreaming 快照。
    syncComposerSendButton();
  }

  function captureComposerDraft() {
    const inputEl = container.querySelector('.chat-composer-input');
    if (inputEl) noteComposerDraft(inputEl.value || '');
  }

  function resizeComposerInput(
    inputEl = container.querySelector('.chat-composer-input'),
    { preserveMessagesViewport = false } = {},
  ) {
    if (!inputEl?.isConnected) return;
    const messagesEl = preserveMessagesViewport
      ? container.querySelector('.chat-thread-messages')
      : null;
    const preservedScrollTop = messagesEl?.scrollTop;
    const preservedUserRevision = messageViewportUserRevision;
    if (messagesEl) composerViewportRestoreUntil = Date.now() + 120;
    inputEl.style.height = 'auto';
    const computed = window.getComputedStyle(inputEl);
    const minHeight = Number.parseFloat(computed.minHeight) || 40;
    const maxHeight = Number.parseFloat(computed.maxHeight) || 132;
    const borderHeight = (Number.parseFloat(computed.borderTopWidth) || 0)
      + (Number.parseFloat(computed.borderBottomWidth) || 0);
    const wantedHeight = Math.ceil(inputEl.scrollHeight + borderHeight);
    const nextHeight = Math.max(minHeight, Math.min(maxHeight, wantedHeight));
    inputEl.style.height = `${nextHeight}px`;
    inputEl.style.overflowY = wantedHeight > maxHeight + 1 ? 'auto' : 'hidden';
    if (messagesEl && Number.isFinite(preservedScrollTop)) {
      // textarea 每次输入都要临时回到 auto 才能重新测量 scrollHeight。部分 Android
      // WebView 会在这两次同步高度写入之间启用滚动锚定，即使最终仍是同样两行，
      // 也会把上方气泡 / 旁白抬高或放低。输入测量只恢复消息区原像素位置；真正的
      // 键盘视口变化仍由下方 ResizeObserver 单独跟随。
      messagesEl.scrollTop = preservedScrollTop;
      if (composerViewportRestoreRaf) cancelAnimationFrame(composerViewportRestoreRaf);
      composerViewportRestoreRaf = requestAnimationFrame(() => {
        composerViewportRestoreRaf = 0;
        if (!messagesEl.isConnected || messageViewportUserRevision !== preservedUserRevision) return;
        messagesEl.scrollTop = preservedScrollTop;
      });
    }
    scheduleComposerDockGapRepair();
  }

  function noteComposerDraft(text) {
    composerDraftText = String(text || '');
    lastComposerActivityAt = Date.now();
    markChatComposerDraft(chatId, !!composerDraftText.trim(), lastComposerActivityAt);
    if (composerFocused || composerDraftText.trim()) {
      markChatComposerActive(chatId, { hasDraft: !!composerDraftText.trim() });
      interruptBackgroundGenerationForComposer();
    }
    if (composerDraftText.trim()) composerEmptySince = 0;
    else if (!composerEmptySince) composerEmptySince = Date.now();
  }

  function noteComposerActivity() {
    lastComposerActivityAt = Date.now();
  }

  function scheduleComposerCloudResync(delayMs = 1000) {
    if (!composerCancelledCloudGeneration || pageDisposed) return;
    if (composerCloudResyncTimer) window.clearTimeout(composerCloudResyncTimer);
    composerCloudResyncTimer = window.setTimeout(async () => {
      composerCloudResyncTimer = 0;
      if (!composerCancelledCloudGeneration || pageDisposed) return;
      const composeBlock = getRealPersonComposeBlock();
      if (composeBlock.blocked) {
        scheduleComposerCloudResync(Math.max(1000, composeBlock.retryMs || 1500));
        return;
      }
      try {
        const mod = await import('../core/background-scheduler.js');
        await mod.resyncAllChatSchedules?.(user.id);
        composerCancelledCloudGeneration = false;
      } catch (_) {
        scheduleComposerCloudResync(3000);
      }
    }, Math.max(100, Number(delayMs) || 1000));
  }

  function interruptBackgroundGenerationForComposer() {
    if (isHeadlessChatReplyTyping(chatId)) {
      abortHeadlessChatReply(chatId, 'composer-active');
    }
    if (cloudTypingVisible) {
      import('../core/cloud-background-coordinator.js')
        .then((mod) => mod.cancelCloudChatGeneration?.(chatId, 'composer-active'))
        .then(() => {
          composerCancelledCloudGeneration = true;
          scheduleComposerCloudResync(realPersonComposeSettleMs() + 100);
        })
        .catch(() => {});
      cloudTypingVisible = false;
      setStreamingPlaceholderVisible(false);
      setBusy(false);
      return;
    }
    const now = Date.now();
    if (now - composerCloudGuardAt < 3000) return;
    composerCloudGuardAt = now;
    import('../core/cloud-background-coordinator.js')
      .then(async (mod) => {
        const hint = await mod.getCloudChatTypingHint?.(chatId);
        if (hint?.typing === true) {
          await mod.cancelCloudChatGeneration?.(chatId, 'composer-active');
          composerCancelledCloudGeneration = true;
          scheduleComposerCloudResync(realPersonComposeSettleMs() + 100);
        }
      })
      .catch(() => {});
  }

  function isAuxiliaryComposeOpen() {
    const host = document.getElementById('modal-container');
    if (!host?.classList.contains('active')) return false;
    // 语音条弹层、文字图/位置/链接等文字编辑器、语音消息编辑、表情包选择器
    return !!host.querySelector(
      '.chat-voice-sheet, .text-editor-sheet, .voice-message-sheet, .chat-sticker-picker-sheet',
    );
  }

  function isSoftKeyboardVisible() {
    return Number(window.__marshmallowViewportKeyboardInset || 0) >= 80
      || document.documentElement.classList.contains('keyboard-visible');
  }

  function clearComposerDockGapRepair() {
    const footer = container.querySelector('.chat-thread-composer[data-dock-gap-repair]');
    if (!footer) return;
    footer.style.removeProperty('translate');
    delete footer.dataset.dockGapRepair;
    delete footer.dataset.dockGapOffset;
  }

  /**
   * 个别 WebView / 美化 CSS 会把 composer 当作 fixed 元素再次按键盘 inset 上移，
   * 或在工具面板打开后仍保留原来的 bottom 偏移。不要按 UA 改整页高度：只在当前
   * composer 与真实相邻边界之间已经出现可测空隙时，补偿这一次实际差值。
   */
  function repairComposerDockGap() {
    composerDockRepairRaf = 0;
    if (!container.isConnected || container.hidden || document.hidden) return;
    const footer = container.querySelector('.chat-thread-composer');
    if (!footer) return;

    const openTools = container.querySelector('.chat-tools-sheet.is-open');
    let targetBottom = null;
    if (toolsOpen && openTools) {
      targetBottom = openTools.getBoundingClientRect().top;
    } else {
      const input = footer.querySelector('.chat-composer-input');
      const ownsKeyboard = composerFocused || document.activeElement === input;
      if (ownsKeyboard && isSoftKeyboardVisible()) {
        const viewport = window.visualViewport;
        targetBottom = viewport
          ? Number(viewport.offsetTop || 0) + Number(viewport.height || 0)
          : container.getBoundingClientRect().bottom;
      }
    }

    if (!Number.isFinite(targetBottom)) {
      clearComposerDockGapRepair();
      return;
    }

    const appliedOffset = Number(footer.dataset.dockGapOffset || 0) || 0;
    const baselineBottom = footer.getBoundingClientRect().bottom - appliedOffset;
    const measuredGap = targetBottom - baselineBottom;
    const visibleHeight = Number(window.visualViewport?.height || container.clientHeight || window.innerHeight || 0);
    const maxRepair = Math.min(240, Math.max(48, visibleHeight * 0.42));
    if (measuredGap <= 10 || measuredGap > maxRepair) {
      clearComposerDockGapRepair();
      return;
    }

    const nextOffset = Math.round(measuredGap);
    footer.dataset.dockGapRepair = 'true';
    footer.dataset.dockGapOffset = String(nextOffset);
    // translate 是独立变换属性，不覆盖用户美化已有的 transform；只作用于这一根输入栏。
    footer.style.setProperty('translate', `0 ${nextOffset}px`, 'important');
  }

  function scheduleComposerDockGapRepair() {
    if (composerDockRepairRaf) return;
    composerDockRepairRaf = requestAnimationFrame(repairComposerDockGap);
  }

  function scheduleComposerDockGapSettle() {
    composerDockRepairTimers.forEach((timer) => window.clearTimeout(timer));
    composerDockRepairTimers = [0, 80, 180, 320, 520].map((delay) => window.setTimeout(
      scheduleComposerDockGapRepair,
      delay,
    ));
  }

  /**
   * 真人感是否应暂缓接话/追发。
   * 有草稿、IME 拼写中、语音条/文字图打开、输入框仍聚焦、刚清空还没过静默窗口
   * → 一律挡住并稍后重试。
   */
  function getRealPersonComposeBlock() {
    if (composerImeComposing) {
      return { blocked: true, retryMs: 800, reason: 'ime' };
    }
    if (isAuxiliaryComposeOpen()) {
      return { blocked: true, retryMs: 1200, reason: 'aux-ui' };
    }
    const inputEl = container.querySelector('.chat-composer-input');
    // 同时看 DOM 与草稿缓存：APK 重绘 footer 时 textarea 可能短暂消失，value 会读成空。
    const draft = String(inputEl?.value || composerDraftText || '').trim();
    if (draft) {
      return { blocked: true, retryMs: 1500, reason: 'draft' };
    }
    const settleMs = realPersonComposeSettleMs();
    const liveKeyboard = isSoftKeyboardVisible();
    // Android 按返回键收起软键盘时 textarea 常常继续保持 activeElement，也不会触发
    // focusout；composerFocused 因而不能作为永久硬门禁。键盘确实可见时继续避让，
    // 键盘已收起则只按最近输入活动与空框静默窗口等待，之后恢复自动接话。
    if (liveKeyboard) {
      composerKeyboardWasVisible = true;
      return {
        blocked: true,
        retryMs: 600,
        reason: 'keyboard-visible',
      };
    }
    const focused = composerFocused
      || isChatComposerActive(chatId)
      || document.activeElement === inputEl;
    // 焦点只在最近确有操作时作为门禁，避免 Android 收键盘后的残留焦点吞掉回复。
    if (focused && lastComposerActivityAt > 0) {
      const waited = Date.now() - lastComposerActivityAt;
      if (waited < settleMs) {
        return {
          blocked: true,
          retryMs: Math.max(200, settleMs - waited + 50),
          reason: 'recent-activity',
        };
      }
    }
    if (composerEmptySince > 0) {
      const waited = Date.now() - composerEmptySince;
      if (waited < settleMs) {
        return { blocked: true, retryMs: Math.max(200, settleMs - waited + 50), reason: 'settle' };
      }
    }
    return { blocked: false, retryMs: 0, reason: '' };
  }

  function setComposerFocusState(focused) {
    composerFocused = !!focused;
    container.classList.toggle('is-composer-focused', composerFocused);
    if (composerFocused) {
      markUserActivity();
      noteComposerActivity();
      markChatComposerActive(chatId, { hasDraft: !!String(composerDraftText || '').trim() });
      interruptBackgroundGenerationForComposer();
      closeToolsSheet();
    } else {
      // 停止点输入：闲置续聊计时从这里开始（不是从发消息时刻算）。
      markChatComposerIdle(chatId);
      if (composerCancelledCloudGeneration) {
        scheduleComposerCloudResync(100);
      }
      if (!String(composerDraftText || '').trim() && !composerEmptySince) {
        composerEmptySince = Date.now();
      }
    }
    scheduleComposerDockGapSettle();
  }

  function refreshComposerFooter({ focus = false } = {}) {
    captureComposerDraft();
    const footer = container.querySelector('.chat-thread-composer');
    if (footer) footer.outerHTML = renderComposerFooter();
    resizeComposerInput();
    scheduleComposerDockGapRepair();
    if (focus) {
      requestAnimationFrame(() => {
        const inputEl = container.querySelector('.chat-composer-input');
        if (!inputEl) return;
        try {
          inputEl.focus({ preventScroll: true });
        } catch (_) {
          inputEl.focus();
        }
        inputEl.selectionStart = inputEl.selectionEnd = inputEl.value.length;
      });
    }
  }

  function setComposerText(text, { focus = false } = {}) {
    noteComposerDraft(text);
    const inputEl = container.querySelector('.chat-composer-input');
    if (inputEl) {
      inputEl.value = composerDraftText;
      resizeComposerInput(inputEl);
    }
    if (focus) {
      requestAnimationFrame(() => {
        const nextInput = container.querySelector('.chat-composer-input');
        if (!nextInput) return;
        try {
          nextInput.focus({ preventScroll: true });
        } catch (_) {
          nextInput.focus();
        }
        nextInput.selectionStart = nextInput.selectionEnd = nextInput.value.length;
      });
    }
  }

  function clearSentComposerDraft(draftValue, editRevisionAtSend, inputAtSend = null) {
    // persistUserMessage 会刷新消息与 footer；此时 inputAtSend 可能已经脱离 DOM。
    // 必须重新获取当前 textarea，否则只清掉旧节点，屏幕上的新节点仍显示已发送文本。
    const liveInput = container.querySelector('.chat-composer-input');
    const liveValue = String(liveInput ? liveInput.value : composerDraftText);
    if (composerDraftEditRevision !== editRevisionAtSend || liveValue !== draftValue) return false;
    setComposerText('');
    if (inputAtSend && inputAtSend !== liveInput) inputAtSend.value = '';
    composerMentionDrafts = [];
    clearComposerMentionSuggestions();
    clearComposerStickerSuggestions();
    syncComposerSendButton();
    return true;
  }

  function restoreSentComposerDraftAfterFailure(
    draftValue,
    editRevisionAtSend,
    mentionDraftsAtSend = [],
  ) {
    const liveInput = container.querySelector('.chat-composer-input');
    const liveValue = String(liveInput ? liveInput.value : composerDraftText);
    // 清空之后用户可能已经开始写下一条，甚至又删空了。只看当前 value 会把
    // 旧消息覆盖回去，必须连同输入修订号一起确认这期间完全没有编辑。
    if (composerDraftEditRevision !== editRevisionAtSend
      || liveValue
      || String(composerDraftText || '')) return false;
    composerMentionDrafts = Array.isArray(mentionDraftsAtSend)
      ? mentionDraftsAtSend.map((item) => ({ ...item }))
      : [];
    setComposerText(draftValue);
    syncComposerSendButton();
    return true;
  }

  function setBusy(busy) {
    isStreaming = busy;
    const controlsBusy = busy || !!manualGenerationGate.current();
    if (controlsBusy) clearComposerStickerSuggestions();
    if (!busy) clearStreamPinTimers();
    container.querySelectorAll('[data-act="advance"], [data-act="reroll"]').forEach((btn) => {
      btn.disabled = controlsBusy;
    });
    container.querySelectorAll('[data-act="stop"]').forEach((btn) => {
      btn.disabled = !controlsBusy;
    });
    const inputEl = container.querySelector('.chat-composer-input');
    if (inputEl) {
      inputEl.setAttribute('aria-busy', controlsBusy ? 'true' : 'false');
      // Footer may have been rendered while a generation was active. Keep-Alive and
      // older Android WebViews then retain the real disabled attribute even after
      // the send button returns to normal, leaving a visible textarea with no caret.
      inputEl.disabled = isComposerInputLocked() || controlsBusy;
      inputEl.readOnly = isComposerInputLocked();
    }
    container.querySelectorAll('[data-stickers], [data-pick-image], [data-transcribe]').forEach((btn) => {
      btn.disabled = fromCharacterPhone || isObserverInputLocked() || controlsBusy;
    });
    const sendBtn = container.querySelector('.chat-composer-send');
    applyComposerSendButtonState(sendBtn, composerSendButtonState());
    refreshActionArea();
    container.querySelectorAll('[data-transcribe]').forEach((btn) => {
      btn.disabled = fromCharacterPhone || isObserverInputLocked() || controlsBusy;
    });
  }

  function wasStopGestureHandledRecently() {
    return Date.now() - stopGestureHandledAt < 700;
  }

  function tryHandleStopGesture(event, intendedAction = '') {
    const sendBtn = event?.target?.closest?.('.chat-composer-send');
    const actionBtn = sendBtn ? null : event?.target?.closest?.('[data-act="stop"]');
    const targetBtn = sendBtn || actionBtn;
    if (!targetBtn || targetBtn.disabled || !container.contains(targetBtn)) return false;
    const wantsStop = intendedAction
      ? intendedAction === 'stop'
      : (actionBtn || composerSendButtonState().mode === 'stop');
    if (!wantsStop) return false;
    event.preventDefault?.();
    if (wasStopGestureHandledRecently()) return true;
    stopGestureHandledAt = Date.now();
    stopCurrentGeneration().catch(() => {});
    return true;
  }

  function clearGenerationWatchdog() {
    if (generationWatchdog) {
      clearTimeout(generationWatchdog);
      generationWatchdog = null;
    }
    generationStartedAt = 0;
    generationLastProgressAt = 0;
  }

  function clearGenerationLongWaitReminder() {
    if (generationLongWaitTimer) {
      clearTimeout(generationLongWaitTimer);
      generationLongWaitTimer = null;
    }
  }

  function maybeShowGenerationLongWaitReminder() {
    clearGenerationLongWaitReminder();
    const session = getChatStreamSession(chatId);
    if (!session || session.abortController?.signal?.aborted || session.longWaitReminderShown) return;
    // 只从模型请求真正发出后计时。点推进后的本地上下文构建可能被后台冻结，
    // 不能因此误报“生成已等待五分钟”。
    const requestStartedAt = Number(session.requestStartedAt || 0);
    if (!requestStartedAt) return;
    const elapsedMs = Math.max(0, Date.now() - requestStartedAt);
    if (elapsedMs < GENERATION_LONG_WAIT_REMINDER_MS) {
      generationLongWaitTimer = setTimeout(
        maybeShowGenerationLongWaitReminder,
        GENERATION_LONG_WAIT_REMINDER_MS - elapsedMs,
      );
      return;
    }
    // 后台 Toast 看不到；回到本会话时由 visibilitychange 再提醒一次。
    if (document.hidden || container.hidden || !container.isConnected) return;
    session.longWaitReminderShown = true;
    showToast('这次生成已等待超过 5 分钟，建议点停止终止本次任务，检查线路后再重试', 8000);
  }

  function armGenerationLongWaitReminder() {
    clearGenerationLongWaitReminder();
    maybeShowGenerationLongWaitReminder();
  }

  /** Called on each stream chunk so the watchdog measures stall, not total duration. */
  function noteGenerationProgress() {
    generationLastProgressAt = Date.now();
  }

  function armGenerationWatchdog() {
    if (generationWatchdog) {
      clearTimeout(generationWatchdog);
      generationWatchdog = null;
    }
    if (!getChatStreamSession(chatId)) {
      generationStartedAt = 0;
      generationLastProgressAt = 0;
      return;
    }
    if (!generationStartedAt) generationStartedAt = Date.now();
    generationWatchdog = setTimeout(() => {
      generationWatchdog = null;
      if (!getChatStreamSession(chatId)) return;
      // 页面在后台时不要掐断：iOS 会冻结计时器，回前台时可能瞬间触发旧超时，
      // 把本来还能跑完的请求杀掉。只在前台可见时解除卡住。
      if (document.hidden || container.hidden || !container.isConnected) {
        armGenerationWatchdog();
        return;
      }
      const now = Date.now();
      // 有流式进展：只要最近还在吐字就继续等（慢模型正常输出不该被掐）。
      if (generationLastProgressAt && now - generationLastProgressAt < GENERATION_WATCHDOG_MS) {
        armGenerationWatchdog();
        return;
      }
      // 无进展信号（非流式请求整程无 chunk）：交给 API 层超时兜底，
      // 只在超过硬上限仍未结束时才强制解除，避免 120 秒误杀慢生成。
      if (!generationLastProgressAt && now - generationStartedAt < GENERATION_HARD_CAP_MS) {
        armGenerationWatchdog();
        return;
      }
      import('../core/debug-log.js').then(({ appendDebugEvent }) => appendDebugEvent({
        type: 'generation_watchdog_stop',
        level: 'warn',
        message: '前台生成长时间无进展，watchdog 强制解除（非用户手动停止）',
        context: {
          chatId,
          elapsedMs: now - generationStartedAt,
          hadProgress: generationLastProgressAt > 0,
          idleMs: generationLastProgressAt ? now - generationLastProgressAt : null,
        },
      })).catch(() => {});
      stopCurrentGeneration({ silent: true, abortReason: 'watchdog' }).then(() => {
        showToast('生成长时间无进展，已解除卡住状态，可重试', 3500);
      }).catch(() => {});
    }, GENERATION_WATCHDOG_MS);
  }

  let generationHiddenAt = 0;
  let chatHiddenAt = 0;
  let messagesStoreRefreshTimer = 0;
  let foregroundMessageRefreshSeq = 0;

  function recordGenerationBackgroundResume(streamSession, hiddenStartedAt) {
    const resumedAt = Date.now();
    const requestStartedAt = Number(streamSession?.requestStartedAt || 0);
    // 会话在本地上下文构建前就会登记，用于防重入和显示停止按钮。
    // 只有请求已经真正发出时，才能记为“后台生成仍在进行”。
    const requestHiddenMs = requestStartedAt
      ? Math.max(0, resumedAt - Math.max(requestStartedAt, hiddenStartedAt))
      : 0;
    if (requestHiddenMs <= 30000) return;
    import('../core/debug-log.js').then(({ appendDebugEvent }) => appendDebugEvent({
      type: 'generation_background_resume',
      level: 'info',
      message: `模型请求期间页面在后台 ${Math.round(requestHiddenMs / 1000)} 秒后回到前台，请求仍在进行`,
      context: { chatId, hiddenMs: requestHiddenMs, requestStartedAt },
    })).catch(() => {});
    // APK 请求期间挂着“正在生成回复”前台服务护网，只提醒网页版。
    import('../core/native-http.js').then(({ isNativeAppShell }) => {
      if (isNativeAppShell()) return;
      const session = getChatStreamSession(chatId);
      if (!session || session.backgroundResumeToastShown) return;
      session.backgroundResumeToastShown = true;
      showToast('后台期间系统可能暂停网络；生成任务仍在进行，若长时间无结果可停止后重试', 5000);
    }).catch(() => {});
  }

  /** 从后台回到当前会话时，强制从 DB 拉最新一页，避免 Keep-Alive 仍显示离开前的旧列表。 */
  async function refreshThreadMessagesAfterForeground({ forcePin = false, animateNewMessages = false } = {}) {
    if (!container.isConnected || container.hidden) return;
    // 本页回合会在 finally 中用准确的 newMessageIds 完成唯一一次最终绘制。
    // 若落库广播/前台恢复在此期间抢先刷新，会先把整轮气泡完整画出，
    // 随后最终绘制再藏回去逐条揭示，形成「全出现 → 消失 → 再流式」。
    if (localRoundOwnsPaint()) {
      pendingMessagesRefreshOnResume = true;
      return;
    }
    // 即使本会话正在流式生成，也必须合并已落库气泡。后台回合可能已写完并弹了通知，
    // 若这里直接 return，Keep-Alive 会一直停在「还没有消息」或离开前的旧列表。
    const seq = ++foregroundMessageRefreshSeq;
    const main = container.querySelector('.chat-thread-messages');
    const historyViewportState = captureHistoryViewportState(main);
    // 待同步只表示数据变了，不代表用户想回到底部；用户已经上翻时不能抢滚动位置。
    let pin = (forcePin && holdBottomUntilSettled) || isNearBottom(main, 100);
    try {
      const freshChat = await getChat(chatId).catch(() => null);
      if (seq !== foregroundMessageRefreshSeq) return;
      if (freshChat) {
        chat = freshChat;
        if (holdBottomUntilSettled && Number(freshChat.unread || 0) > 0) pin = true;
      }
    } catch (_) {}
    await loadInitialMessages({
      animateNewMessages,
      preserveLoadedHistory: !!historyViewportState,
    });
    if (seq !== foregroundMessageRefreshSeq || !container.isConnected || container.hidden) return;
    await refreshHeaderStatus().catch(() => {});
    // await 期间本地回合可能已经结束；必须读实时状态，不能把开始时的旧快照
    // 在结束后重新画成「正在输入」。后台 headless / 云端生成中也要补占位，
    // 否则落库广播触发的这次刷新会把后台回合的「正在输入」吃掉。
    if (getChatStreamSession(chatId) || isStreaming || backgroundTypingActive()) {
      setStreamingPlaceholderVisible(true, chatStreamPlaceholderText(getChatStreamSession(chatId)));
    }
    if (pin) {
      beginFollowingLatestMessages();
      const nextMain = container.querySelector('.chat-thread-messages');
      if (nextMain) nextMain.scrollTop = nextMain.scrollHeight;
      scrollToBottom();
    } else {
      stabilizeHistoryViewport(container.querySelector('.chat-thread-messages'), historyViewportState);
    }
    await clearChatUnread(chatId).catch(() => {});
    pendingMessagesRefreshOnResume = false;
    scheduleAdvanceContextPrewarm(700);
  }

  function onChatStreamVisibilityChange() {
    const streamSession = getChatStreamSession(chatId);
    if (document.hidden) {
      chatHiddenAt = Date.now();
      // 退到后台等同停止输入：闲置续聊从此刻起算。
      setComposerFocusState(false);
      // 从点击到 stream session 登记之间仍有少量本地读取。用户若正好在
      // 这个窗口切后台，也应标记为“后台轮次”，不能只认已发请求的 session。
      if (streamSession || localRoundOwnsPaint() || isStreaming) {
        generationWasHiddenThisTurn = true;
        clearStreamingMessagePreview();
        streamingPreviewPaintedThisTurn = false;
      }
      if (streamSession) {
        // 切后台：暂停前台卡住计时，并再拉一把保活，尽量让请求继续。
        generationHiddenAt = Date.now();
        clearGenerationWatchdog();
        ensureKeepAliveDuringActiveGeneration().catch(() => {});
      }
      return;
    }
    const chatHiddenMs = chatHiddenAt ? Math.max(0, Date.now() - chatHiddenAt) : 0;
    chatHiddenAt = 0;
    if (streamSession) {
      if (generationHiddenAt) {
        const hiddenStartedAt = generationHiddenAt;
        generationHiddenAt = 0;
        // Long background stretches are the usual suspect for dropped streams;
        // record how long we were hidden so reports can correlate.
        recordGenerationBackgroundResume(streamSession, hiddenStartedAt);
      }
      armGenerationWatchdog();
      maybeShowGenerationLongWaitReminder();
    }
    // 点通知唤起、或从桌面切回时：若仍停在这个会话页，也要主动同步最新消息。
    if (container.isConnected && !container.hidden) {
      reconcileGenerationUiAfterResume();
      // iOS 短暂切后台时可能不重读消息，但公开状态和手机日程仍可能已经变化。
      void refreshHeaderStatus().catch(() => {});
      const shouldRefreshMessages = !IOS_WEBKIT_CHAT
        || chatHiddenMs >= IOS_FOREGROUND_DB_REFRESH_MIN_HIDDEN_MS
        || pendingMessagesRefreshOnResume
        || !!streamSession
        || backgroundTypingActive();
      // iOS 短暂切到别的 App 再回来时，页面、消息与媒体都仍在内存，不要无条件
      // 重读 IndexedDB。它既会增加存储进程复活压力，也可能触发不必要的合成层刷新。
      if (shouldRefreshMessages) {
        void refreshThreadMessagesAfterForeground();
        recoverMissedRealPersonAutoReply();
      }
    }
  }

  function shouldAnimateNewBubbles() {
    // 用户正盯着这个会话时才逐条冒出；后台 / 其它页生成完应直接落好，回来就能看完整结果。
    if (generationWasHiddenThisTurn) return false;
    if (typeof document !== 'undefined' && document.hidden) return false;
    if (!container.isConnected || container.hidden) return false;
    return isViewingChatThread(chatId);
  }

  function revealIdsForPaint(ids = []) {
    const requested = new Set(Array.isArray(ids) ? ids.filter(Boolean) : []);
    // 逐条冒出只属于本轮 AI 回复。用户气泡、系统提示以及后台同步进来的旧消息
    // 即使恰好被判定为“新 id”，也绝不能重新播放进入动画。
    const list = messages
      .filter((message) => (
        requested.has(message?.id)
        && isCharacterConversationMessage(message)
        && message?.senderId !== 'user'
        && message?.senderId !== 'system'
        && message?.senderId !== GUIDANCE_SENDER_ID
      ))
      .map((message) => message.id);
    if (!list.length || !shouldAnimateNewBubbles()) return null;
    return list;
  }

  async function notifyManualGenerationIfAwayFromChat(result = {}) {
    if (!result?.ok) return;
    if (!shouldNotifyForBackgroundReason('manual-generation', chatId)) return;
    const info = await resolveChatNotifyCharacterInfo(chat).catch(() => ({ name: 'TA', avatar: '' }));
    if (isGroupChatForNotify(chat)) {
      await notifyGroupChatMessageIfEnabled({
        groupName: info.name,
        chatId,
        tag: `manual-chat-${chatId}`,
        requireHidden: false,
        avatar: info.avatar,
      }).catch(() => {});
      return;
    }
    await notifyCharacterSentMessageIfEnabled({
      characterName: info.name,
      chatId,
      tag: `manual-chat-${chatId}`,
      messages: result.messages,
      requireHidden: false,
      avatar: info.avatar,
    }).catch(() => {});
  }

  function stopCurrentGeneration(options = {}) {
    if (stopGenerationPromise) return stopGenerationPromise;
    stopGenerationPromise = performStopCurrentGeneration(options).finally(() => {
      stopGenerationPromise = null;
    });
    return stopGenerationPromise;
  }

  async function performStopCurrentGeneration({ silent = false, abortReason = 'user' } = {}) {
    clearGenerationWatchdog();
    clearGenerationLongWaitReminder();
    const paintLease = beginLocalRoundPaint();

    // 停止必须先切断正在运行的请求，再做任何 IndexedDB / 待办清理。
    // pending-actions 执行器会在整次模型请求期间持有用户级 mutation lock；
    // 若先等待待办取消，停止按钮就会反过来等待那次请求自己结束。
    const active = getChatStreamSession(chatId);
    const stoppedCloud = cloudTypingVisible;
    const pendingIntent = manualGenerationGate.cancel(abortReason);
    const controller = active?.abortController || abortController || pendingIntent?.controller;
    if (abortReason === 'user') {
      // pending-actions 一次会领取最多 3 条并持锁逐个执行。先同步立撤销闸门，
      // 否则异步删库要等当前批次释放锁，第 2、3 条会在此之前马上接力生成。
      requestPendingChatActionCancellation(user.id, chatId);
    }
    abortHeadlessChatReply(chatId, abortReason);
    try {
      if (controller?.signal) controller.signal.marshmallowAbortReason = abortReason;
      controller?.abort?.();
    } catch (_) {}
    abortChatStream(chatId);
    // 先结束会话，让订阅回调在 isStreaming 仍为 true 时移除「正在输入」占位。
    // 若先 setBusy(false)，回调会被 `if (!isStreaming) return` 短路，直到下次重绘才消失。
    endChatStreamSession(chatId);
    cloudTypingVisible = false;
    setStreamingPlaceholderVisible(false);
    if (!isHeadlessChatReplyRunning(chatId)) {
      headlessReplyVisible = false;
      headlessBaselineMsgId = '';
    }
    setBusy(false);
    abortController = null;
    refreshActionArea();

    if (abortReason === 'user') {
      // 手动终止优先级最高：即使此前刚因输入避让排了恢复计时，也不得把当前锚点排回来。
      composerCancelledCloudGeneration = false;
      if (composerCloudResyncTimer) window.clearTimeout(composerCloudResyncTimer);
      composerCloudResyncTimer = 0;
      cancelRealPersonAutoReply();
      cancelRealPersonChase();
      autoReplyMissedWhileHidden = false;
      chaseMissedWhileHidden = false;
      const stoppedAnchor = getLastVisibleConversationMessage(messages);
      suppressIdleContinueForCurrentAnchor(chatId, messages);
      if (stoppedAnchor) {
        void patchChatPrefs(chatId, {
          automaticGenerationStoppedAnchor: {
            messageId: String(stoppedAnchor.id || ''),
            messageTimestamp: Number(stoppedAnchor.timestamp || 0) || 0,
            stoppedAt: Date.now(),
          },
        }).catch(() => {});
      }
      void import('../core/chat/pending-actions.js')
        .then(({ cancelPendingActions }) => cancelPendingActions(user.id, (action) => (
          action.chatId === chatId
        )))
        .catch(() => {});
      void import('../core/chat/real-person-chase-beat.js')
        .then((mod) => mod.cancelChaseBeatsForChat(user.id, chatId))
        .catch(() => {});
    }
    if (stoppedCloud || abortReason === 'user') {
      // 本地已经先结束交互；云端取消只做异步善后，不能阻塞按钮反馈。
      // 用户停止本地流时再查一次真实云端运行态：撤掉被本地流遮住的排队/运行任务，
      // 但保留尚未到点的下一次正常自动计划。
      void import('../core/cloud-background-coordinator.js')
        .then(async (mod) => {
          if (!stoppedCloud) {
            const hint = await mod.getCloudChatTypingHint?.(chatId).catch(() => null);
            if (hint?.typing !== true) return;
          }
          await mod.cancelCloudChatGeneration?.(chatId, abortReason);
        })
        .catch(() => {});
      // 用户亲手停止时不能 1.5 秒后把同一锚点重新排回云端；
      // 新消息会产生新锚点，并由正常发送链路重新同步。
      if (abortReason !== 'user') {
        window.setTimeout(() => {
          import('../core/background-scheduler.js')
            .then((mod) => mod.resyncAllChatSchedules?.(user.id))
            .catch(() => {});
        }, 1500);
      }
    }
    // 反馈不等待聊天预览重算或消息重读。
    if (!silent) showToast('已停止生成', 2500);
    try {
      await recalcChatPreview(chatId);
      messages = await listThreadMessages();
      if (isCurrentLocalRoundPaint(paintLease)) refreshMessages();
    } catch (_) {
      if (isCurrentLocalRoundPaint(paintLease)) refreshMessages();
    } finally {
      endLocalRoundPaint();
    }
  }

  // —— 真人感自动接话：在线且不忙时，用户发完消息并停止输入，
  // 按「无输入等待」（默认 2.5 秒）直接接话。回复频率只调节追发/主动消息；
  // 忙碌或离线则由到点后的门禁决定静默、假自动回复或被连发气泡叫回来。
  // runAiReply 期间输入框本来就会锁住，正好呈现「对方正在输入」的体感。
  let autoReplyTimer = null;
  let autoReplyDeadline = 0;
  let autoReplyPresenceFast = false;
  let autoReplyMissedWhileHidden = false;
  let autoReplyScheduleSeq = 0;
  // 追发（已读不回连续调用）：同一段沉默里最多追 2 次，用户一说话就重置。
  let chaseTimer = null;
  let chaseDueAt = 0;
  let chaseCount = 0;
  let chaseMissedWhileHidden = false;
  let chaseComposeDeadline = 0;
  let foregroundChaseGenerationLockHeld = false;
  let realPersonPolicyCache = {
    at: 0,
    enabled: false,
    proactiveEnabled: false,
    allowHardOffline: false,
    frequencyPreset: 'normal',
    idleReplyFloorMs: 2500,
    muteHours: null,
  };

  async function loadRealPersonReplyPolicy() {
    const now = Date.now();
    if (now - realPersonPolicyCache.at < 30_000) return realPersonPolicyCache;
    try {
      const {
        loadResolvedCharacterAutonomyPolicy,
        resolveRealPersonIdleReplyFloorMs,
      } = await import('../core/character-autonomy-settings.js');
      const policy = await loadResolvedCharacterAutonomyPolicy(user.id, partnerId, chatId);
      realPersonPolicyCache = {
        at: now,
        enabled: policy?.realPersonMode?.enabled === true,
        proactiveEnabled: policy?.totalEnabled === true,
        allowHardOffline: policy?.realPersonMode?.allowHardOffline === true,
        frequencyPreset: String(policy?.realPersonMode?.frequencyPreset || 'normal'),
        idleReplyFloorMs: resolveRealPersonIdleReplyFloorMs(policy?.realPersonMode),
        muteHours: policy?.muteHours || null,
      };
    } catch (_) {
      realPersonPolicyCache = {
        at: now,
        enabled: false,
        proactiveEnabled: false,
        allowHardOffline: false,
        frequencyPreset: 'normal',
        idleReplyFloorMs: 2500,
        muteHours: null,
      };
    }
    return realPersonPolicyCache;
  }

  async function loadConfirmedRealPersonReplyPolicy() {
    if (!partnerId) throw new Error('真人感回复角色不可用');
    const {
      characterAutonomySettingsKey,
      loadResolvedCharacterAutonomyPolicy,
      resolveCharacterAutonomyPolicy,
      resolveRealPersonIdleReplyFloorMs,
    } = await import('../core/character-autonomy-settings.js');
    const settingsKey = characterAutonomySettingsKey(user.id, partnerId);
    let row = await get(settingsKey);
    if (!row?.value || typeof row.value !== 'object') {
      // 允许旧数据迁移一次，但容错加载器给出的默认值不能当成“用户明确关闭”。
      // 迁移后必须从业务主库严格重读到设置行，任何未知状态都保留 outbox。
      await loadResolvedCharacterAutonomyPolicy(user.id, partnerId, chatId);
      row = await get(settingsKey);
    }
    if (!row?.value || typeof row.value !== 'object') {
      throw new Error('真人感回复设置尚未耐久确认');
    }
    const policy = resolveCharacterAutonomyPolicy(row.value, chatId);
    return {
      enabled: policy?.realPersonMode?.enabled === true,
      idleReplyFloorMs: resolveRealPersonIdleReplyFloorMs(policy?.realPersonMode),
    };
  }

  function realPersonComposeSettleMs() {
    const cached = Number(realPersonPolicyCache?.idleReplyFloorMs || 0);
    return cached > 0 ? cached : 2500;
  }

  function cancelRealPersonAutoReply() {
    // 同时废弃仍在读取策略/状态/待办的旧排程，避免快速连发时旧气泡的异步结果
    // 反过来覆盖最新气泡的 2.5 秒计时器。
    autoReplyScheduleSeq += 1;
    if (autoReplyTimer) {
      clearTimeout(autoReplyTimer);
      autoReplyTimer = null;
    }
  }

  function retryRealPersonAutoReply(delayMs = 1500) {
    if (autoReplyTimer || !container.isConnected || !getUnansweredRealUserMessage(messages)) return;
    autoReplyTimer = setTimeout(
      () => { void attemptRealPersonAutoReply(); },
      Math.max(500, Number(delayMs) || 1500),
    );
  }

  function handleComposerKeyboardViewportChange(event) {
    const detailVisible = event?.detail && typeof event.detail.keyboardVisible === 'boolean'
      ? event.detail.keyboardVisible
      : isSoftKeyboardVisible();
    scheduleComposerDockGapRepair();
    if (!container.isConnected || container.hidden || document.hidden) {
      composerKeyboardWasVisible = detailVisible;
      return;
    }
    if (detailVisible) {
      composerKeyboardWasVisible = true;
      return;
    }
    if (!composerKeyboardWasVisible) return;
    composerKeyboardWasVisible = false;

    // blur 会在键盘退场动画开始时触发，不能拿它当“已经收起”。这里只接受 viewport
    // 从可见到不可见的真实跃迁，并从这一刻重新给足完整的无输入等待。
    const now = Date.now();
    const draft = String(
      container.querySelector('.chat-composer-input')?.value || composerDraftText || '',
    ).trim();
    composerFocused = false;
    container.classList.remove('is-composer-focused');
    lastComposerActivityAt = now;
    composerEmptySince = draft ? 0 : now;
    markChatComposerKeyboardDismissed(chatId, now);
    markChatComposerDraft(chatId, !!draft, now);

    if (draft || !getUnansweredRealUserMessage(messages)) return;
    const settleMs = realPersonComposeSettleMs();
    autoReplyDeadline = Math.max(autoReplyDeadline, now + settleMs + 120_000);
    if (autoReplyTimer) window.clearTimeout(autoReplyTimer);
    autoReplyTimer = window.setTimeout(
      () => { void attemptRealPersonAutoReply(); },
      settleMs + 50,
    );
    if (composerCancelledCloudGeneration) {
      scheduleComposerCloudResync(settleMs + 100);
    }
  }

  addPageLifetimeListener(window, 'marshmallow-viewport-change', handleComposerKeyboardViewportChange);

  function cancelRealPersonChase() {
    if (chaseTimer) {
      clearTimeout(chaseTimer);
      chaseTimer = null;
    }
    chaseDueAt = 0;
  }

  async function isRealPersonReplyEnabledNow() {
    try {
      const { loadResolvedCharacterAutonomyPolicy } = await import('../core/character-autonomy-settings.js');
      const policy = await loadResolvedCharacterAutonomyPolicy(user.id, partnerId, chatId);
      return policy?.realPersonMode?.enabled === true;
    } catch (_) {
      // 执行权限无法确认时保守停下，不能把读取失败当成真人感已开启。
      return false;
    }
  }

  async function scheduleLifeGlimpseAfterWait(message, waitingReason = '') {
    const anchorMessageId = String(message?.id || '').trim();
    const anchorTimestamp = Number(message?.timestamp || 0);
    if (!anchorMessageId || !anchorTimestamp) return null;
    const [pending, life, pacingNow] = await Promise.all([
      import('../core/chat/pending-actions.js'),
      import('../core/chat/life-glimpse.js'),
      getPacingNowForUser(user.id),
    ]);
    if (!life.isLifeGlimpseWaitReason(waitingReason)) return null;
    const dueAt = pacingNow + life.LIFE_GLIMPSE_WAIT_DELAY_MS;
    const replyDeferredUntil = /offline|sleep/i.test(waitingReason)
      ? pacingNow + 5 * 60_000
      : pacingNow + 60_000;
    return pending.upsertLifeGlimpseAction({
      userId: user.id,
      characterId: partnerId,
      chatId,
      dueAt,
      createdAt: pacingNow,
      expiresAt: dueAt + 3 * 60 * 60_000,
      dedupeKey: `life-glimpse:${chatId}:${anchorMessageId}`,
      payload: {
        anchorMessageId,
        anchorTimestamp,
        waitingReason,
        replyDeferredUntil,
      },
    });
  }

  async function attemptRealPersonAutoReply() {
    autoReplyTimer = null;
    if (!canRunRealPersonScheduling()) {
      autoReplyMissedWhileHidden = false;
      return;
    }
    // 排程与真正执行之间，用户可能关闭真人感，或页面可能恢复出旧计时器。
    // 每次 API 调用前重读持久化策略；未明确开启时清掉本窗残留接话票。
    if (!await isRealPersonReplyEnabledNow()) {
      autoReplyMissedWhileHidden = false;
      try {
        const { cancelPendingActions } = await import('../core/chat/pending-actions.js');
        await cancelPendingActions(user.id, (action) => (
          action.kind === 'real_person_reply'
          && action.chatId === chatId
          && action.characterId === partnerId
        ));
      } catch (_) {}
      return;
    }
    // 待回复已持久化；浏览器后台未冻结时可离页执行，冻结时由调度器在恢复后补跑。
    if (isStreaming || isChatStreamPendingAnywhere(chatId) || phoneCinematicRunning) {
      // 到点时恰好撞上另一轮生成并不等于这条用户消息已经被回复。
      // 旧逻辑直接 return 后不会再武装定时器，形成只在竞态用户身上出现的永久沉默。
      retryRealPersonAutoReply();
      return;
    }
    const composeBlock = getRealPersonComposeBlock();
    if (composeBlock.blocked) {
      // 用户还在输入（主框/语音条/文字图/IME）：等他们发完或清空静默几秒后再接；超时放弃。
      if (Date.now() < autoReplyDeadline) {
        autoReplyTimer = setTimeout(
          () => { void attemptRealPersonAutoReply(); },
          composeBlock.retryMs || 1500,
        );
      }
      return;
    }
    // 期间用户手动推进过、或 AI 已经回了：别再补一轮。
    const unanswered = getUnansweredRealUserMessage(messages);
    if (!unanswered) return;
    const replyIdentity = ensureMessageReplyGenerationIdentity(unanswered);
    // 完全下线是硬静默：不吃连发突破，也不弹系统自动回复。到 AI 自己选的扫一眼节点时，
    // 只允许后台生活动作，代码会强制丢掉当前私聊的所有可见气泡。
    try {
      const { isHardOfflineActiveForChat, maybeRunHardOfflinePeek } = await import('../core/chat/real-person-hard-offline.js');
      const hardOffline = await isHardOfflineActiveForChat(user.id, chat);
      if (hardOffline) {
        await maybeRunHardOfflinePeek(chat, user, { now: Date.now() }).catch(() => {});
        return;
      }
    } catch (_) { /* 完全下线状态读不到时沿用普通真人感接话 */ }
    // 睡眠/勿扰门禁必须发生在 setBusy / beginChatStreamSession 之前，也必须先于
    // next_reply_delay 的定点等待：角色常会同轮登记「稍后回」和 auto_reply，
    // 系统留言应先弹出挡刀，真实回复仍留给原定点。
    // 旧链路等 runAiReply 深处才判断，虽然最终可能静默，界面和 API 侧已经先进入“正在输入”。
    try {
      const [{ maybeHandleBusyAutoReply }, { loadChatPrefsWithExpiredStatus }] = await Promise.all([
        import('../core/character-phone-proactive.js'),
        import('../core/status-ttl.js'),
      ]);
      const busyGate = await maybeHandleBusyAutoReply({
        chat,
        user,
        messages,
        chatPrefs: await loadChatPrefsWithExpiredStatus(chatId),
        // 状态/日程读取期间用户可能已经开始下一段输入；系统留言真正落库前
        // 必须再看一次实时输入态，不能沿用调用前的空框快照。
        deliveryGuard: () => !getRealPersonComposeBlock().blocked,
      });
      if (busyGate?.handled) {
        // 系统挡刀、睡眠静默或当前步骤忙碌都不等于角色已经真实回复。
        // 保留同一条用户消息的持久化待办，并在前台继续轻量复查；状态一松动就能冒出输入态。
        await scheduleLifeGlimpseAfterWait(unanswered, String(busyGate.reason || '')).catch(() => null);
        messages = await listThreadMessages();
        refreshMessages();
        retryRealPersonAutoReply(/offline|sleep/i.test(String(busyGate.reason || '')) ? 5 * 60_000 : 60_000);
        return;
      }
    } catch (_) { /* 预检失败时仍由 runAiReply 内的同一门禁兜底 */ }
    // next_reply_delay 是角色说完后的主动续聊计划，不是对下一条用户消息的禁言锁。
    // 在线且没有被上面的忙碌/离线门禁挡住时，新用户消息应按无输入等待正常接话；
    // 旧主动计划已经被这条新消息抢先承接，取消即可，不能要求用户连发多条才能回复。
    try {
      const { listPendingActions, cancelPendingActions } = await import('../core/chat/pending-actions.js');
      const nowTs = Date.now();
      const hasOwnPlan = (await listPendingActions(user.id)).some((action) => (
        action.kind === 'delayed_reply'
        && action.chatId === chatId
        && Number(action.expiresAt || 0) > nowTs
      ));
      if (hasOwnPlan) {
        await cancelPendingActions(user.id, (action) => (
          action.kind === 'delayed_reply' && action.chatId === chatId
        ));
        // 云端镜像按本地待办全量对齐：定点已取消，同步清掉对应 chat-delay 计划。
        import('../core/cloud-background-coordinator.js')
          .then((mod) => mod.syncCloudDelayedReplySchedules?.(null, { force: true }))
          .catch(() => {});
      }
    } catch (_) { /* 待办读不到时照常接话 */ }
    if (autoReplyPresenceFast) {
      // 守屏额度只限制「秒回」的次数，不限制自动接话本身。
      await consumePresenceGrab(user.id, chatId).catch(() => false);
    }
    if (isStreaming || isChatStreamPendingAnywhere(chatId)) {
      retryRealPersonAutoReply();
      return;
    }
    if (getRealPersonComposeBlock().blocked) {
      if (Date.now() < autoReplyDeadline) {
        autoReplyTimer = setTimeout(() => { void attemptRealPersonAutoReply(); }, 1200);
      }
      return;
    }
    // 用户正停留在当前会话时走前台流式回合：立即展示「正在输入」，
    // 并复用真人感闲聊场景词。持久化待办保留作并发/崩溃兜底；下一次扫描
    // 会因用户消息已被接住而自动消费，不会重复生成。
    if (
      !document.hidden
      && !container.hidden
      && container.isConnected
      && isViewingChatThread(chatId)
    ) {
      const anchorId = String(unanswered.id || '').trim();
      const anchorTimestamp = Number(unanswered.timestamp || 0);
      let existingGenerationTask = null;
      try {
        existingGenerationTask = await getGenerationTaskStrict(replyIdentity.taskId);
      } catch (_) {
        // 账本暂不可读时不把它当作 missing；保留原票，稍后前台再核验。
        retryRealPersonAutoReply(5000);
        return;
      }
      if (existingGenerationTask && !isGenerationTaskSafePreDispatch(existingGenerationTask)) {
        // 这个身份已经越过 dispatch 边界或结果未知。前台计时器不得把同一票据
        // 再喂给 runAiReply；保守消费自动票，是否新开一轮交给用户明确推进。
        try {
          const { cancelPendingActions } = await import('../core/chat/pending-actions.js');
          await cancelPendingActions(user.id, (action) => (
            action.kind === 'real_person_reply'
            && action.chatId === chatId
            && String(action.payload?.anchorMessageId || '') === anchorId
            && Number(action.payload?.anchorTimestamp || 0) === anchorTimestamp
          ));
        } catch (_) {}
        return;
      }
      const autoReplyRun = await runAiReply('advance', {
        realPersonChatter: true,
        generationTaskId: replyIdentity.taskId,
        generationIdempotencyKey: replyIdentity.idempotencyKey,
        generationAiRoundId: replyIdentity.aiRoundId,
      });
      messages = await listThreadMessages();
      if (!getUnansweredRealUserMessage(messages) || autoReplyRun?.modelRequestAttempted === true) {
        // 前台已经接住，或本轮已经真正发出过模型请求时，立即消费同锚点后台票。
        // 后者即使空回、断流或校验失败也不能再自动调用；是否重试交给用户决定。
        try {
          const { cancelPendingActions } = await import('../core/chat/pending-actions.js');
          await cancelPendingActions(user.id, (action) => (
            action.kind === 'real_person_reply'
            && action.chatId === chatId
            && String(action.payload?.anchorMessageId || '') === anchorId
            && Number(action.payload?.anchorTimestamp || 0) === anchorTimestamp
          ));
        } catch (_) { /* 执行时的已回复校验仍是最终兜底 */ }
      } else {
        // 只允许在请求尚未发出（输入占用、执行锁碰撞等）时重新检查。
        retryRealPersonAutoReply(3000);
      }
      return;
    }
    try {
      const { runPendingChatActions } = await import('../core/chat/pending-actions.js');
      const result = await runPendingChatActions(
        user,
        await getPacingNowForUser(user.id),
        'real-person-reply-timer',
      );
      // 另一条后台任务恰好持有用户级执行锁时，本次扫描会返回 in-flight。
      // 旧逻辑在这里直接丢掉本页唯一的定时器，之后只能碰运气等后台分钟扫描。
      // 页面仍在等待同一条用户消息时短暂重试，保证前台链路不会因一次竞态永久熄火。
      if (
        result?.reason === 'in-flight'
        && getUnansweredRealUserMessage(messages)
        && container.isConnected
      ) {
        retryRealPersonAutoReply();
        return;
      }
      // 顶层 ok 只表示待办扫描完成；具体 real_person_reply 仍可能因输入占用、
      // 临时门禁或生成竞态被延期。旧逻辑会在这里丢掉前台唯一计时器，只能等
      // 分钟级后台扫描。重新读取真实消息，仍未接住就按当前状态恢复秒级排程。
      messages = await listThreadMessages();
      const stillUnanswered = getUnansweredRealUserMessage(messages);
      if (stillUnanswered && container.isConnected) {
        const actionResult = (Array.isArray(result?.results) ? result.results : []).find((row) => (
          row?.kind === 'real_person_reply' && String(row?.chatId || '') === String(chatId)
        ));
        const retryReason = String(actionResult?.reason || '');
        if (actionResult?.modelRequestAttempted === true) {
          // 已调用过模型的失败待办已经由执行器终止；不再恢复前台计时器。
        } else if (/hard-offline|soft-offline|schedule-busy|active-offline-session/.test(retryReason)) {
          retryRealPersonAutoReply(/hard-offline|soft-offline/.test(retryReason) ? 5 * 60_000 : 60_000);
        } else if (retryReason === 'compose-active') {
          retryRealPersonAutoReply(1500);
        } else {
          void scheduleRealPersonAutoReply();
        }
      }
    } catch (_) {
      if (!document.hidden && !container.hidden) retryRealPersonAutoReply(3000);
      else autoReplyMissedWhileHidden = true;
    }
  }

  function recoverMissedRealPersonAutoReply() {
    if (!canRunRealPersonScheduling()) {
      autoReplyMissedWhileHidden = false;
      chaseMissedWhileHidden = false;
      cancelRealPersonAutoReply();
      cancelRealPersonChase();
      return;
    }
    if (autoReplyMissedWhileHidden) {
      autoReplyMissedWhileHidden = false;
      // 错过的接话早就到点了：回前台后几秒内补上，不再重新等一整段延迟。
      cancelRealPersonAutoReply();
      autoReplyDeadline = Date.now() + 120_000;
      autoReplyPresenceFast = false;
      autoReplyTimer = setTimeout(() => { void attemptRealPersonAutoReply(); }, 2000 + Math.random() * 3000);
    }
    recoverMissedRealPersonChase();
  }

  // 切后台时错过的追发：回前台后若 TA 那条消息还新鲜、用户仍没回，几秒内补上。
  function recoverMissedRealPersonChase() {
    if (!canRunRealPersonScheduling()) {
      chaseMissedWhileHidden = false;
      cancelRealPersonChase();
      return;
    }
    if (!chaseMissedWhileHidden) return;
    chaseMissedWhileHidden = false;
    const lastVisible = getLastVisibleConversationMessage(messages);
    if (!lastVisible || !isCharacterConversationMessage(lastVisible)) return;
    const ageMs = Date.now() - messageRealCreatedAt(lastVisible);
    if (ageMs < 0 || ageMs > 30 * 60 * 1000) return;
    if (chaseTimer) clearTimeout(chaseTimer);
    const remaining = Math.max(0, Number(chaseDueAt || 0) - Date.now());
    const delay = remaining > 0 ? remaining : 4000 + Math.random() * 6000;
    chaseTimer = setTimeout(() => { void attemptRealPersonChase(); }, delay);
  }

  async function scheduleRealPersonAutoReply() {
    cancelRealPersonAutoReply();
    const scheduleSeq = autoReplyScheduleSeq;
    if (!canRunRealPersonScheduling()) return;
    if (chatPrefs.guidanceMode === true) return;
    // 用户开口了：这段沉默结束，追发计数清零、待触发的追发作废（含后台追发拍）。
    cancelRealPersonChase();
    chaseCount = 0;
    chaseMissedWhileHidden = false;
    import('../core/chat/real-person-chase-beat.js')
      .then((mod) => mod.cancelChaseBeatsForChat(user.id, chatId))
      .catch(() => {});
    const unanswered = getUnansweredRealUserMessage(messages);
    if (!unanswered) return;
    const replyIdentityWasMissing = !String(unanswered.metadata?.generationTaskId || '').trim()
      || !String(unanswered.metadata?.generationIdempotencyKey || '').trim()
      || !String(unanswered.metadata?.generationAiRoundId || '').trim();
    const replyGenerationPayload = buildReplyGenerationPayload(unanswered);
    try {
      const freshPrefs = await loadChatPrefsFresh(chatId);
      if (isAutomaticGenerationAnchorStopped(freshPrefs, unanswered)) return;
    } catch (_) {}
    if (replyIdentityWasMissing) {
      await saveMessage(unanswered).catch((error) => {
        import('../core/debug-log.js').then(({ appendDebugEvent }) => appendDebugEvent({
          type: 'real_person_reply_identity_backfill_failed',
          level: 'warn',
          message: '旧用户消息的回复身份补写失败，本次票据仍沿用当前稳定身份',
          context: { chatId, messageId: String(unanswered.id || ''), error: String(error?.message || error || '') },
        })).catch(() => {});
      });
    }
    const policy = await loadRealPersonReplyPolicy();
    if (scheduleSeq !== autoReplyScheduleSeq) return;
    if (!policy.enabled || !container.isConnected) return;
    // 待办到期属于现实节奏，不应跟随剧情世界钟冻结。时间债追平期间
    // getNowForUser 会停在剧情锚点，若用它排票和验票，本页定时器到点后
    // 待办仍会被判定为“未到期”，真人感接话就永久没有正在输入。
    const pacingNow = await getPacingNowForUser(user.id);
    const proactiveModule = await import('../core/character-phone-proactive.js').catch(() => ({}));
    const [watch, schedulePacing, liveStatusPrefs] = await Promise.all([
      loadPresenceWatch(user.id, chatId).catch(() => null),
      Promise.resolve(proactiveModule)
        .then((mod) => mod.resolveCharacterReplySchedulePacing?.(
          user.id,
          partnerId,
          pacingNow,
          { chatId },
        ))
        .catch(() => ({ busy: false, activity: '' })),
      loadChatPrefsWithExpiredStatus(chatId).catch(() => chatPrefs),
    ]);
    if (scheduleSeq !== autoReplyScheduleSeq) return;
    const visibleStatusBusy = String(liveStatusPrefs?.presenceState || 'online') !== 'online'
      || proactiveModule.isBusyLikeStatusText?.(liveStatusPrefs?.statusText) === true;
    const replyAvailabilityBusy = schedulePacing?.activeConversation === true
      ? false
      : (schedulePacing?.busy === true || visibleStatusBusy);
    autoReplyMissedWhileHidden = false;
    autoReplyPresenceFast = !!watch;
    const delay = computeRealPersonReplyDelayMs({
      minDelayMs: policy.idleReplyFloorMs,
    });
    autoReplyDeadline = Date.now() + delay + 120_000;
    const dueAt = pacingNow + delay;
    try {
      const { upsertRealPersonReplyAction } = await import('../core/chat/pending-actions.js');
      const anchorId = String(unanswered.id || '').trim();
      const anchorTimestamp = Number(unanswered.timestamp || 0);
      const upserted = await upsertRealPersonReplyAction({
        userId: user.id,
        characterId: partnerId,
        chatId,
        dueAt,
        createdAt: pacingNow,
        expiresAt: dueAt + 3 * 60 * 60 * 1000,
        dedupeKey: `real-person-reply:${chatId}:${anchorId || anchorTimestamp}`,
        payload: {
          anchorMessageId: anchorId,
          anchorTimestamp,
          ...replyGenerationPayload,
          presenceFast: !!watch,
          scheduleBusy: replyAvailabilityBusy,
          scheduleActivity: schedulePacing?.activity || '',
          composeSettleMs: policy.idleReplyFloorMs,
        },
      });
      if (scheduleSeq !== autoReplyScheduleSeq) return;
      if (!upserted?.ok || !upserted?.action?.id || upserted.newer === true) return;
      const action = upserted.action;
      // 后台可能因输入占用或忙碌门禁把同一待办延期数分钟；前台在线时不继承旧延期。
      const remaining = Math.max(0, Math.min(Number(action?.dueAt || dueAt), dueAt) - pacingNow);
      autoReplyTimer = setTimeout(() => { void attemptRealPersonAutoReply(); }, remaining);
    } catch (_) {
      // IndexedDB 暂不可用时保留本页定时器；恢复后会重新尝试持久化。
      autoReplyTimer = setTimeout(() => { void attemptRealPersonAutoReply(); }, delay);
    }
  }

  async function persistRealPersonReplyTicket(message) {
    if (!isRealUserMessage(message)) return null;
    const replyGenerationPayload = buildReplyGenerationPayload(message);
    const anchorId = String(message.id || '').trim();
    const anchorTimestamp = Number(message.timestamp || 0);
    if (!anchorId || !anchorTimestamp) return null;
    const policy = await loadConfirmedRealPersonReplyPolicy();
    if (!policy.enabled) {
      const resolvedAt = Date.now();
      message.metadata = {
        ...(message.metadata || {}),
        replyIntentState: 'disabled',
        replyIntentCompletedAt: resolvedAt,
        replyIntentDisabledAt: resolvedAt,
      };
      await saveMessage(message);
      return { ok: true, skipped: true, reason: 'policy-disabled', replyIntentConfirmed: true };
    }
    const pacingNow = await getPacingNowForUser(user.id);
    const delay = computeRealPersonReplyDelayMs({
      minDelayMs: policy.idleReplyFloorMs,
    });
    const { upsertRealPersonReplyAction } = await import('../core/chat/pending-actions.js');
    const result = await upsertRealPersonReplyAction({
      userId: user.id,
      characterId: partnerId,
      chatId,
      dueAt: pacingNow + delay,
      createdAt: pacingNow,
      expiresAt: pacingNow + delay + 3 * 60 * 60 * 1000,
      dedupeKey: `real-person-reply:${chatId}:${anchorId}`,
      payload: {
        anchorMessageId: anchorId,
        anchorTimestamp,
        ...replyGenerationPayload,
        composeSettleMs: policy.idleReplyFloorMs,
      },
    });
    if (!result?.ok || !result?.action?.id) {
      throw new Error(String(result?.reason || '真人感回复票据写入失败'));
    }
    const persistedPayload = result.action.payload || {};
    const ticketMatches = String(result.action.chatId || '') === String(chatId)
      && String(persistedPayload.anchorMessageId || '') === anchorId
      && Number(persistedPayload.anchorTimestamp || 0) === anchorTimestamp
      && String(persistedPayload.generationTaskId || '') === replyGenerationPayload.generationTaskId
      && String(persistedPayload.generationIdempotencyKey || '') === replyGenerationPayload.generationIdempotencyKey
      && String(persistedPayload.generationAiRoundId || '') === replyGenerationPayload.generationAiRoundId;
    if (!ticketMatches) {
      throw new Error('真人感回复票据身份冲突');
    }
    const resolvedAt = Date.now();
    message.metadata = {
      ...(message.metadata || {}),
      replyIntentState: 'scheduled',
      replyIntentScheduledAt: resolvedAt,
      replyIntentCompletedAt: resolvedAt,
      replyIntentActionId: String(result?.action?.id || ''),
    };
    await saveMessage(message);
    return { ...result, replyIntentConfirmed: true };
  }

  // —— 追发：只有本轮明确留下未完成话题，用户没回时，角色才可再开一枪。
  // presence、问句与热聊只调延迟，不再单独制造追发资格；同一段沉默仍遵守拍数与静音门禁。
  function lastAiSegmentEndsWithQuestion() {
    const list = messages.filter((m) => isRealUserMessage(m) || isCharacterConversationMessage(m));
    let i = list.length - 1;
    if (i < 0 || isRealUserMessage(list[i])) return false;
    for (; i >= 0; i -= 1) {
      const m = list[i];
      if (isRealUserMessage(m)) break;
      if (m.type && m.type !== 'text') continue;
      const body = String(m.metadata?.text || m.content || '').trim();
      if (/[？?]\s*$/.test(body)) return true;
    }
    return false;
  }

  async function resolveForegroundChaseThreadEligibility(sourceMessages = messages) {
    try {
      const { resolveStoredChaseBeatThreadEligibility } = await import('../core/chat/real-person-chase-beat.js');
      return resolveStoredChaseBeatThreadEligibility({
        userId: user.id,
        chatId,
        messages: sourceMessages,
        characterId: partnerId,
      });
    } catch (_) {
      // 资格读不到时保守不追；不能退回到“只看问号就调用一次模型”。
      return { eligible: false, source: 'unavailable' };
    }
  }

  function isSameForegroundChaseAnchor(expected, actual) {
    if (!expected || !actual) return false;
    const expectedId = String(expected.id || '').trim();
    const actualId = String(actual.id || '').trim();
    if (expectedId && actualId) return expectedId === actualId;
    return String(expected.senderId || '') === String(actual.senderId || '')
      && Number(expected.timestamp || 0) === Number(actual.timestamp || 0);
  }

  async function reloadForegroundChaseAnchor(expected) {
    const freshMessages = await listThreadMessages().catch(() => null);
    if (!Array.isArray(freshMessages)) return { ok: false, reason: 'messages-unavailable' };
    const freshLastVisible = getLastVisibleConversationMessage(freshMessages);
    if (
      !freshLastVisible
      || !isCharacterConversationMessage(freshLastVisible)
      || !isSameForegroundChaseAnchor(expected, freshLastVisible)
    ) {
      return { ok: false, reason: 'chase-anchor-changed' };
    }
    const threadEligibility = await resolveForegroundChaseThreadEligibility(freshMessages);
    if (!threadEligibility.eligible) return { ok: false, reason: 'no-open-thread' };
    return { ok: true, messages: freshMessages, lastVisible: freshLastVisible };
  }

  async function scheduleNextForegroundChaseAfterCommittedAttempt() {
    const chaseBeat = await import('../core/chat/real-person-chase-beat.js');
    const [freshPrefs, latestMessages, latestChat, pacingNow] = await Promise.all([
      loadChatPrefsWithExpiredStatus(chatId, { fresh: true }),
      listThreadMessages(),
      getChat(chatId),
      getPacingNowForUser(user.id),
    ]);
    await chaseBeat.maybeScheduleChaseBeatAfterRound({
      chat: latestChat || chat,
      userId: user.id,
      prefs: freshPrefs,
      priorMessages: latestMessages,
      savedMessages: [],
      reason: 'real-person-chase-foreground',
      realPersonChase: true,
      chaseBeatAlreadyCredited: true,
      now: pacingNow,
    });
    await scheduleRealPersonChase();
  }

  async function scheduleRealPersonChase() {
    if (!canRunRealPersonScheduling()) return;
    if (chatPrefs.guidanceMode === true) return;
    const policy = await loadRealPersonReplyPolicy();
    if (!policy.enabled || !policy.proactiveEnabled || !container.isConnected) return;
    if (policy.allowHardOffline) {
      try {
        const { isHardOfflineActiveForChat } = await import('../core/chat/real-person-hard-offline.js');
        if (await isHardOfflineActiveForChat(user.id, chat)) return;
      } catch (_) { /* 状态读不到时仍允许排程，attempt/headless 会再拦 */ }
    }
    // 人就在线下对面：不排追发定时器（与日程主动等一致）。
    try {
      const { isCharacterBusyInOfflineSession } = await import('../core/character-phone-proactive.js');
      if (await isCharacterBusyInOfflineSession(user.id, partnerId)) return;
    } catch (_) { /* 线下态读不到时仍允许排程，attempt 时再拦一次 */ }
    const lastVisible = getLastVisibleConversationMessage(messages);
    if (!lastVisible || !isCharacterConversationMessage(lastVisible)) return;
    const threadEligibility = await resolveForegroundChaseThreadEligibility();
    if (!threadEligibility.eligible) {
      cancelRealPersonChase();
      return;
    }
    const watch = await loadPresenceWatch(user.id, chatId).catch(() => null);
    const visibleForCadence = messages.filter((m) => (
      isRealUserMessage(m) || isCharacterConversationMessage(m)
    ));
    // 等待情绪与最短间隔从最新 prefs 里读：本轮 persist 刚写完 wait_mood，
    // 页面缓存的 chatPrefs 可能还没刷新。
    let freshPrefs = chatPrefs;
    try {
      freshPrefs = await loadChatPrefsFresh(chatId);
    } catch (_) { /* 读不到时沿用页面缓存 */ }
    if (isAutomaticGenerationAnchorStopped(freshPrefs, lastVisible)) return;
    const lastUserTs = [...messages].reverse().find(isRealUserMessage)?.timestamp || 0;
    const configuredMax = (() => {
      const n = Math.trunc(Number(freshPrefs?.chaseBeatMaxRounds));
      return Number.isFinite(n)
        ? Math.max(0, Math.min(REAL_PERSON_MAX_CHASES_PER_SILENCE, n))
        : REAL_PERSON_MAX_CHASES_PER_SILENCE;
    })();
    if (configuredMax <= 0) {
      cancelRealPersonChase();
      return;
    }
    try {
      const { resolveChaseBeatDone, resolveChaseBeatMaxRounds } = await import('../core/chat/real-person-chase-beat.js');
      const maxBeats = resolveChaseBeatMaxRounds(freshPrefs);
      chaseCount = Math.max(chaseCount, resolveChaseBeatDone(freshPrefs, Number(lastUserTs) || 0));
      const foregroundMax = Math.min(maxBeats, REAL_PERSON_MAX_CHASES_PER_SILENCE);
      if (foregroundMax <= 0 || chaseCount >= foregroundMax) {
        cancelRealPersonChase();
        return;
      }
    } catch (_) { /* 模块读不到时仍由后台待办和执行时门禁兜底 */ }
    const delay = computeRealPersonChaseDelayMs({
      presenceActive: !!watch,
      rapidExchange: detectRapidExchange(visibleForCadence),
      endsWithQuestion: lastAiSegmentEndsWithQuestion(),
      chaseCount,
      maxChases: configuredMax,
      frequencyPreset: policy.frequencyPreset,
      waitMood: resolveActiveWaitMood(freshPrefs, Number(lastUserTs) || 0),
      minIntervalMs: resolveChaseMinIntervalMs(freshPrefs),
    });
    if (!delay) return;
    cancelRealPersonChase();
    // 给「用户正在输入」留足重试窗口：到点后若还在输入，最长再等两分钟。
    chaseComposeDeadline = Date.now() + delay + 120_000;
    chaseDueAt = Date.now() + delay;
    chaseTimer = setTimeout(() => { void attemptRealPersonChase(); }, delay);
  }

  async function attemptRealPersonChase() {
    chaseTimer = null;
    if (!foregroundChaseGenerationLockHeld) {
      try {
        const { withRealPersonChaseGenerationLock } = await import('../core/chat/real-person-chase-beat.js');
        const claim = await withRealPersonChaseGenerationLock({
          userId: user.id,
          chatId,
          characterId: partnerId,
        }, async () => {
          foregroundChaseGenerationLockHeld = true;
          try {
            return await attemptRealPersonChase();
          } finally {
            foregroundChaseGenerationLockHeld = false;
          }
        });
        if (!claim?.acquired && Date.now() < chaseComposeDeadline) {
          chaseTimer = setTimeout(() => { void attemptRealPersonChase(); }, 1500);
        }
        return claim?.value;
      } catch (_) {
        // 跨标签页锁初始化失败时保守停下；下一次页面恢复会按落库锚点重新排程。
        return;
      }
    }
    if (!canRunRealPersonScheduling()) {
      chaseMissedWhileHidden = false;
      return;
    }
    if (!container.isConnected || container.hidden || document.visibilityState === 'hidden') {
      // 页面切走了先记账：回前台时若这条消息还新鲜，就补上这次追发。
      chaseMissedWhileHidden = true;
      return;
    }
    if (isStreaming || getChatStreamSession(chatId) || phoneCinematicRunning) return;
    const policy = await loadRealPersonReplyPolicy();
    if (!policy.enabled || !policy.proactiveEnabled) return;
    // 用户已经回话（常规接话流程接管）或正在输入：不追；输入中稍后重试。
    const lastVisible = getLastVisibleConversationMessage(messages);
    if (!lastVisible || !isCharacterConversationMessage(lastVisible)) return;
    const threadEligibility = await resolveForegroundChaseThreadEligibility();
    if (!threadEligibility.eligible) {
      cancelRealPersonChase();
      chaseMissedWhileHidden = false;
      return;
    }
    // 切页恢复、Keep-Alive 复挂和旧页面定时器都必须重新核验硬下限。
    // 未到点只等待剩余时间，不能把“错过一次”改写成进页面后几秒追发。
    try {
      const latestPrefs = await loadChatPrefsWithExpiredStatus(chatId, { fresh: true });
      if (String(latestPrefs?.presenceState || 'online') !== 'online') return;
      const { resolveChaseBeatDone, resolveChaseBeatMaxRounds } = await import('../core/chat/real-person-chase-beat.js');
      const lastUserTs = [...messages].reverse().find(isRealUserMessage)?.timestamp || 0;
      const maxBeats = resolveChaseBeatMaxRounds(latestPrefs);
      chaseCount = Math.max(chaseCount, resolveChaseBeatDone(latestPrefs, Number(lastUserTs) || 0));
      if (maxBeats <= 0 || chaseCount >= Math.min(maxBeats, REAL_PERSON_MAX_CHASES_PER_SILENCE)) return;
      const minIntervalMs = resolveChaseMinIntervalMs(latestPrefs);
      const earliestAt = messageRealCreatedAt(lastVisible) + minIntervalMs;
      if (minIntervalMs > 0 && Date.now() < earliestAt) {
        const remaining = Math.max(1000, earliestAt - Date.now());
        chaseDueAt = earliestAt;
        chaseComposeDeadline = Math.max(chaseComposeDeadline, earliestAt + 120_000);
        chaseTimer = setTimeout(() => { void attemptRealPersonChase(); }, remaining);
        return;
      }
    } catch (_) { /* prefs 读不到时仍由调度时的 dueAt 与统一主动账本兜底 */ }
    chaseDueAt = 0;
    const composeBlock = getRealPersonComposeBlock();
    if (composeBlock.blocked) {
      if (Date.now() < chaseComposeDeadline) {
        chaseTimer = setTimeout(
          () => { void attemptRealPersonChase(); },
          composeBlock.retryMs || 1500,
        );
      }
      return;
    }
    try {
      const { isAutonomyMuteHourActive } = await import('../core/character-autonomy-settings.js');
      if (isAutonomyMuteHourActive(
        { muteHours: policy.muteHours },
        await getNowForUser(user.id),
      )) return;
    } catch (_) { /* 静音判定失败时保守放行 */ }
    // 公开短句不参与回复门禁；在线态、当前场景、日程与线下现实统一判断。
    try {
      const realityBlock = await import('../core/character-phone-proactive.js')
        .then(async (mod) => mod.resolveCharacterAutonomousMessageBlock?.(
          user.id,
          partnerId,
          chatId,
          await getNowForUser(user.id),
        ))
        .catch(() => null);
      if (realityBlock?.blocked) return;
    } catch (_) { /* 状态读取失败时仍由后台追发执行器二次兜底 */ }
    // 人就在线下对面：禁止追发（你发消息后的接话不拦）。
    try {
      const { isCharacterBusyInOfflineSession } = await import('../core/character-phone-proactive.js');
      if (await isCharacterBusyInOfflineSession(user.id, partnerId)) return;
    } catch (_) { /* 线下态读不到时保守放行 */ }
    // TA 登记过「稍后回来」：到点会有延时回复接上，追发不抢跑、不双发。
    try {
      const { listPendingActions } = await import('../core/chat/pending-actions.js');
      const now = await getPacingNowForUser(user.id);
      const hasOwnPlan = (await listPendingActions(user.id)).some((action) => (
        action.kind === 'delayed_reply'
        && action.chatId === chatId
        && Number(action.expiresAt || 0) > now
      ));
      if (hasOwnPlan) return;
    } catch (_) { /* 待办读不到时照常追 */ }
    // 上面的现实门禁包含多次异步读取；期间其它标签页可能已经发言。
    // 先从 DB 重验同一角色锚点，避免拿页面缓存里的旧 messages 继续消耗预算。
    const freshAnchorBeforeBudget = await reloadForegroundChaseAnchor(lastVisible);
    if (!freshAnchorBeforeBudget.ok) return;
    messages = freshAnchorBeforeBudget.messages;
    // 兼容入口只检查真人感模式仍开启，不再按每日调用次数截停。
    try {
      const { consumeCharacterApiBudget } = await import('../core/character-api-budget.js');
      const budget = await consumeCharacterApiBudget({
        userId: user.id,
        characterId: partnerId,
        category: 'background_reply',
        chatId,
      });
      if (!budget?.ok) return;
    } catch (_) { return; }
    if (isStreaming || getChatStreamSession(chatId) || !container.isConnected) return;
    // 前台追发与后台追发、日程主动、主动分享共用同一本最小间隔账。
    // 以前前台定时器会绕过这本账，导致用户停留在聊天页时仍可能和其它主动消息撞车。
    let proactiveReservation = null;
    try {
      const { reserveProactiveDelivery } = await import('../core/character-proactive-usage.js');
      proactiveReservation = await reserveProactiveDelivery({
        userId: user.id,
        characterId: partnerId,
        chatId,
        channel: 'chase-foreground',
        reason: 'real-person-chase-foreground',
        idempotencyKey: `chase-foreground:${chatId}:${lastVisible.id || lastVisible.timestamp}:${chaseCount}`,
      });
      if (!proactiveReservation?.ok) {
        if (proactiveReservation?.reason === 'cooldown' && Number(proactiveReservation.retryAt || 0) > Date.now()) {
          const retryDelay = Math.max(1000, Number(proactiveReservation.retryAt) - Date.now());
          chaseComposeDeadline = Math.max(chaseComposeDeadline, Date.now() + retryDelay + 120_000);
          chaseDueAt = Date.now() + retryDelay;
          chaseTimer = setTimeout(() => { void attemptRealPersonChase(); }, retryDelay);
        }
        return;
      }
    } catch (_) {
      // 节流账本不可用时保守停下，不能退回到无间隔追发。
      return;
    }
    const chaseBeatIndex = chaseCount;
    const chaseAnchorTs = Number([...messages].reverse().find(isRealUserMessage)?.timestamp || 0) || 0;
    const chaseGenerationActionId = `chase-foreground:${chatId}:${chaseAnchorTs}:${chaseBeatIndex}`;
    let beforeChaseMessageIds = new Set(messages.map((message) => String(message?.id || '')));
    let chaseRun = null;
    let chaseBeatTools = null;
    let chaseGenerationClaimed = false;
    let chaseRequestNotStarted = false;
    let chaseModelRequestAttempted = false;
    let chaseRoundSucceeded = false;
    let chaseAttemptCommitted = false;
    let chaseSettlementReason = 'generation-not-attempted';
    try {
      // 额度预留也会异步读写；真正进生成前再从 DB 重验一次，并拒绝已经被后台消费的旧拍。
      const freshAnchorBeforeRequest = await reloadForegroundChaseAnchor(lastVisible);
      if (!freshAnchorBeforeRequest.ok) {
        chaseSettlementReason = freshAnchorBeforeRequest.reason;
        return;
      }
      messages = freshAnchorBeforeRequest.messages;
      const latestPrefs = await loadChatPrefsWithExpiredStatus(chatId, { fresh: true });
      chaseBeatTools = await import('../core/chat/real-person-chase-beat.js');
      const { resolveChaseBeatDone, resolveChaseBeatMaxRounds } = chaseBeatTools;
      const freshDone = resolveChaseBeatDone(latestPrefs, chaseAnchorTs);
      const freshMax = Math.min(resolveChaseBeatMaxRounds(latestPrefs), REAL_PERSON_MAX_CHASES_PER_SILENCE);
      if (chaseBeatIndex < freshDone) {
        chaseCount = Math.max(chaseCount, freshDone);
        chaseSettlementReason = 'beat-already-attempted';
        return;
      }
      if (freshMax <= 0 || chaseBeatIndex >= freshMax) {
        chaseSettlementReason = 'chase-limit-reduced';
        return;
      }
      // Web Lock 是前台快速门禁；落库 claim 用于不支持 navigator.locks 的 WebView/PWA，
      // 也防止前后台两个 realm 同时在旧 done 上各发一次付费请求。
      const generationClaim = await chaseBeatTools.claimRealPersonBeatGeneration({
        chatId,
        kind: 'chase_beat',
        anchorTs: chaseAnchorTs,
        index: chaseBeatIndex,
        actionId: chaseGenerationActionId,
      });
      if (!generationClaim.acquired) {
        chaseSettlementReason = generationClaim.reason || 'beat-generation-claimed';
        return;
      }
      chaseGenerationClaimed = true;
      beforeChaseMessageIds = new Set(messages.map((message) => String(message?.id || '')));
      chaseRun = await runAiReply('advance', {
        realPersonChase: true,
        onModelRequestAttempted: () => { chaseModelRequestAttempted = true; },
        // 追发可能已经过了计时与额度预留，用户却恰好在模型生成期间关闭主动消息。
        // 这里必须在 ai-round 真正落库前重读总开关；不能只依赖 30 秒页面策略缓存。
        deliveryGuard: async () => {
          try {
            const liveAnchor = await reloadForegroundChaseAnchor(lastVisible);
            if (!liveAnchor.ok) return { ok: false, reason: liveAnchor.reason };
            const { loadResolvedCharacterAutonomyPolicy } = await import('../core/character-autonomy-settings.js');
            const latestPolicy = await loadResolvedCharacterAutonomyPolicy(user.id, partnerId, chatId);
            return latestPolicy?.totalEnabled === true
              ? { ok: true }
              : { ok: false, reason: 'proactive-disabled' };
          } catch (_) {
            // 主动消息读取不到最新权限时宁可丢掉本轮，不能带着旧授权继续落库。
            return { ok: false, reason: 'proactive-policy-unavailable' };
          }
        },
      });
      chaseModelRequestAttempted = chaseModelRequestAttempted || chaseRun?.modelRequestAttempted === true;
      chaseRequestNotStarted = chaseRun?.modelRequestAttempted === false
        || chaseRun?.result?.modelRequestAttempted === false;
      chaseRoundSucceeded = chaseRun?.result?.ok === true;
      chaseSettlementReason = String(chaseRun?.result?.reason || '')
        || (chaseRoundSucceeded ? 'empty-visible' : 'generation-failed');
    } catch (error) {
      chaseModelRequestAttempted = chaseModelRequestAttempted || error?.modelRequestAttempted === true;
      chaseRequestNotStarted = error?.requestNotStarted === true || error?.modelRequestAttempted === false;
      chaseSettlementReason = String(error?.message || error || 'generation-failed');
    } finally {
      const resultMessages = Array.isArray(chaseRun?.result?.messages)
        ? chaseRun.result.messages
        : [];
      const sentCount = resultMessages.length
        ? resultMessages.filter(isCharacterConversationMessage).length
        : messages.filter((message) => (
          isCharacterConversationMessage(message)
          && !beforeChaseMessageIds.has(String(message?.id || ''))
        )).length;
      if (chaseModelRequestAttempted) {
        // 一次真正发出的模型请求就是一拍；0 气泡、状态-only 与失败都不能回退后自动再计费。
        try {
          const latestMessages = await listThreadMessages();
          const latestAnchorTs = Number([...latestMessages].reverse().find(isRealUserMessage)?.timestamp || 0) || 0;
          if (latestAnchorTs === chaseAnchorTs) {
            chaseBeatTools ||= await import('../core/chat/real-person-chase-beat.js');
            const committed = await chaseBeatTools.commitRealPersonBeatGenerationAttempt({
              chatId,
              kind: 'chase_beat',
              anchorTs: chaseAnchorTs,
              index: chaseBeatIndex,
              actionId: chaseGenerationActionId,
            });
            const done = committed.done;
            chaseCount = Math.max(chaseCount, done);
            chaseAttemptCommitted = committed.committed === true && done > chaseBeatIndex;
          }
        } catch (_) { /* 记账失败不阻塞已经完成的模型请求，也绝不在本次定时器里重试 */ }
      } else if (chaseGenerationClaimed && chaseRequestNotStarted) {
        // 只有上游明确证明请求尚未派发时才释放；网络结果不明则保留 claim，
        // 宁可放弃这一拍也不自动二次计费。
        try {
          chaseBeatTools ||= await import('../core/chat/real-person-chase-beat.js');
          await chaseBeatTools.releaseRealPersonBeatGenerationClaim({
            chatId,
            kind: 'chase_beat',
            anchorTs: chaseAnchorTs,
            index: chaseBeatIndex,
            actionId: chaseGenerationActionId,
          });
        } catch (_) {}
      }
      if (proactiveReservation?.ok) {
        try {
          const { settleProactiveDelivery } = await import('../core/character-proactive-usage.js');
          await settleProactiveDelivery({
            userId: user.id,
            characterId: partnerId,
            reservationId: proactiveReservation.reservationId,
            ok: sentCount > 0,
            skipped: sentCount <= 0 && (!chaseModelRequestAttempted || chaseRoundSucceeded),
            reason: sentCount > 0
              ? 'sent'
              : (chaseRoundSucceeded ? 'empty-visible' : chaseSettlementReason),
            messageCount: sentCount,
          });
        } catch (_) {}
      }
    }
    // realPersonChase 回合不走 runAiReply / ai-round 的通用自排；只有成功且 done 已写回后才排下一拍。
    if (chaseModelRequestAttempted && chaseRoundSucceeded && chaseAttemptCommitted) {
      await scheduleNextForegroundChaseAfterCommittedAttempt().catch(() => {});
    }
  }

  // 刷新/重开页面后重建真人感调度：定时器不跨页面存活，但开放线头与节奏信息
  // 都能从落库状态重建，据此把仍然有资格的定时器排回去。
  function recoverRealPersonSchedulingAfterLoad() {
    if (!canRunRealPersonScheduling()) return;
    const lastVisible = getLastVisibleConversationMessage(messages);
    if (!lastVisible) return;
    // 只救半小时内的现场：更久的悬空消息留给闲置续聊/云端补跑，
    // 避免翻旧记录时 TA 突然插话或追问几小时前的问题。
    const ageMs = Date.now() - messageRealCreatedAt(lastVisible);
    if (ageMs < 0 || ageMs > 30 * 60 * 1000) return;
    if (getUnansweredRealUserMessage(messages)) {
      void scheduleRealPersonAutoReply();
    } else if (isCharacterConversationMessage(lastVisible)) {
      // TA 说完你没回就刷新：追发扳机可从落库状态重建（追发计数除外，
      // 刷新后重新从 0 起算，代价可接受）。
      void scheduleRealPersonChase();
    }
  }

  const provisionalReplyIntentTimestamps = new WeakSet();

  function shouldStageReplyIntentOutbox(message) {
    return !!partnerId && !isGroup && isRealUserMessage(message);
  }

  function stageMessageReplyIntentOutbox(message) {
    if (!shouldStageReplyIntentOutbox(message)) return false;
    const accountId = strangerChat
      ? String(chat.metadata?.accountIdentityMap?.[principalKey('user', user.id)] || '').trim()
      : '';
    if (accountId && isUserAliasBlockedByCharacter(chat)) {
      message.metadata = {
        ...(message.metadata || {}),
        deliveryBlockedByCharacter: true,
        deliveryStatus: 'rejected',
        deliveryRejectedAt: Number(message?.metadata?.deliveryRejectedAt || 0) || Date.now(),
        deliveryRejectedReason: 'blocked-by-character-alias',
        replyIntentState: 'blocked',
        replyIntentCompletedAt: Number(message?.metadata?.replyIntentCompletedAt || 0) || Date.now(),
        replyIntentBlockedAt: Number(message?.metadata?.replyIntentBlockedAt || 0) || Date.now(),
      };
    }
    const identity = ensureMessageReplyGenerationIdentity(message);
    const requiresReply = message?.metadata?.deliveryBlockedByCharacter !== true
      && String(message?.metadata?.deliveryStatus || '').trim() !== 'rejected';
    const staged = stageReplyIntentOutbox({
      userId: user.id,
      chatId,
      characterId: partnerId,
      message,
      requiresReply,
    });
    // shadow outbox 只用于页面被系统杀掉时补回尚未落库的消息。它属于增强能力，
    // localStorage 满额、被禁用或旧票未清理时都不能反过来阻止正常前台发送。
    return staged === true && !!identity;
  }

  function completeMessageReplyIntentOutbox(message) {
    if (!shouldStageReplyIntentOutbox(message)) return true;
    return completeReplyIntentOutbox(message?.id, {
      userId: user.id,
      chatId,
      generationTaskId: message?.metadata?.generationTaskId,
    });
  }

  async function persistUserMessage(message) {
    const userAccountId = strangerChat
      ? String(chat.metadata?.accountIdentityMap?.[principalKey('user', user.id)] || '').trim()
      : '';
    const rejectedByCharacter = message?.senderId === 'user'
      && !!userAccountId
      && isUserAliasBlockedByCharacter(chat);
    if (rejectedByCharacter) {
      message.metadata = {
        ...(message.metadata || {}),
        deliveryBlockedByCharacter: true,
        deliveryStatus: 'rejected',
        deliveryRejectedAt: Number(message?.metadata?.deliveryRejectedAt || 0) || Date.now(),
        deliveryRejectedReason: 'blocked-by-character-alias',
        replyIntentState: 'blocked',
        replyIntentCompletedAt: Number(message?.metadata?.replyIntentCompletedAt || 0) || Date.now(),
        replyIntentBlockedAt: Number(message?.metadata?.replyIntentBlockedAt || 0) || Date.now(),
      };
    }
    // 真用户消息自身就是下一次回复意图的耐久锚点。票据写入失败、页面被杀或
    // 后台恢复时，都从这三个字段复用同一轮身份，而不是重新抽一套 task/round。
    ensureMessageReplyGenerationIdentity(message);
    // async 函数会在第一个 await 前同步尝试写 localStorage shadow；失败时仍继续
    // 正常落 messages 表，只是放弃“恰好在首个 await 前被杀”这一极窄恢复能力。
    const replyIntentOutboxStaged = stageMessageReplyIntentOutbox(message);
    // 手动把虚拟时间调早后，当前窗口可能还挂着更晚的旧尾段。若直接走单调时间保护，
    // 新气泡会继续显示旧窗口的未来钟点，看起来像只有这个角色不跟随虚拟时间。
    // 先把尾段整体平移到当前世界钟，保留先后与内部间隔，再提交本轮消息。
    const currentWorldNow = await getNowForUser(user.id).catch(() => Number(message?.timestamp || 0));
    if (provisionalReplyIntentTimestamps.has(message) && currentWorldNow > 0) {
      message.timestamp = currentWorldNow;
      provisionalReplyIntentTimestamps.delete(message);
    }
    const timeRepair = currentWorldNow > 0
      ? await repairChatFutureTimestampDrift(chatId, user.id, {
        knownMessages: messages,
        worldNow: currentWorldNow,
        allowVirtualRollback: true,
      }).catch(() => ({ repaired: false }))
      : { repaired: false };
    if (timeRepair.repaired) {
      // 时间回拨修复只改变异常尾段。发送动作本就会回到最新对话，不需要把已加载
      // 的三万条历史重新塞进页面内存；有界尾页足够完成单调时间保护与后续绘制。
      messages = await listThreadMessages().catch(() => messages);
      invalidateAdvanceContextPrewarm();
    }
    const placement = message?.senderId === 'user' && !message?.metadata?.userComposedAsCharacter ? 1 : 2;
    const regexContext = {
      surface: 'chat',
      placement,
      depth: 0,
      macros: {
        user: frontStageUserName(),
        char: message?.senderName || title || '角色',
      },
    };
    if (message?.type === 'text' && typeof message.content === 'string') {
      message.content = applyPermanentRegex(message.content, regexContext);
    }
    if (typeof message?.metadata?.text === 'string') {
      message.metadata = {
        ...message.metadata,
        text: applyPermanentRegex(message.metadata.text, regexContext),
      };
    }
    // 先把气泡画出来再落库：之前是等两次串行的 IndexedDB 写完才出现气泡，
    // 输入框已经清空但消息迟迟不出来，就是「点发送卡一下」的直接原因。
    // updateChatPreview 只改会话的预览/时间戳，不依赖 messages 表已经落库，
    // 两个写入天生互不依赖，改成并行也能再省一次串行等待。
    // 后台真人感/云端回复可能已经落库，但本页的写入广播尚未来得及完成绘制。
    // 只拿内存列表做单调保护会让这条用户消息获得更早的时间戳：当前页面因乐观
    // append 看着仍在末尾，重进后按数据库时间排序却会跳到刚才的角色回复上方。
    const latestStoredMessages = await listMessagesForChat(chatId, 1).catch(() => []);
    const liveChronologyMessages = latestStoredMessages.length
      ? [...messages, latestStoredMessages[latestStoredMessages.length - 1]]
      : messages;
    message.timestamp = clampLiveMessageTimestamp(liveChronologyMessages, message.timestamp);
    ensureMessageReplyGenerationIdentity(message);
    // 世界钟修复或单调时间保护可能改过 timestamp；在 messages 表写入前，用同一
    // messageId 覆盖 shadow snapshot，保证恢复锚点与最终落库值完全一致。
    if (replyIntentOutboxStaged) stageMessageReplyIntentOutbox(message);
    // 发送是一次明确的“回到最新对话”操作。长会话里用户只要曾上翻过，
    // hold 会被释放；若这里不重新接管，新气泡撑高列表后会继续恢复旧锚点，
    // 表现成发送/生成后卡在以前的聊天记录。
    beginFollowingLatestMessages();
    const localMutationRevision = markLocalMessageMutation(message.id, 'upsert', message);
    messages = [...messages, message];
    refreshMessages();
    noteSparkMessage(message);
    const durableMessageWrite = saveMessage(message);
    const previewWrite = updateChatPreview(
      chatId,
      previewFromMessage(message),
      message.timestamp,
    ).catch(() => null);
    // 草稿清理只认 messages 表的耐久写入；预览失败不能把“消息已保存”伪装成
    // 整次发送失败，否则用户再次点击会生成第二条同内容消息。
    try {
      await durableMessageWrite;
    } catch (error) {
      // 乐观气泡没有落库时必须回滚；否则输入仍保留、气泡却看似已发送，用户
      // 再点一次会得到两条本地消息，shadow 恢复还可能把第一条重新补回来。
      messages = messages.filter((item) => String(item?.id || '') !== String(message.id || ''));
      settleLocalMessageMutation(message.id, localMutationRevision);
      refreshMessages();
      void recalcChatPreview(chatId).catch(() => {});
      completeMessageReplyIntentOutbox(message);
      throw error;
    }
    await advanceVirtualTimeForMessages(user.id, [message.timestamp]).catch(() => null);
    await previewWrite;
    settleLocalMessageMutation(message.id, localMutationRevision);
    // 消息耐久即视为发送成功。真人感票据与 outbox 收尾属于后台增强能力，不能继续
    // 占着输入框和发送锁等待同用户的待办锁，更不能让一轮长生成拖住下一条消息。
    const shouldScheduleRealPersonReply = !rejectedByCharacter;
    if (shouldScheduleRealPersonReply) {
      void (async () => {
        const ticketResult = await persistRealPersonReplyTicket(message).catch((error) => {
          import('../core/debug-log.js').then(({ appendDebugEvent }) => appendDebugEvent({
            type: 'real_person_reply_ticket_persist_failed',
            level: 'warn',
            message: '用户消息已保存，但真人感回复票据写入失败；后续将从消息回复身份重建',
            context: {
              chatId,
              messageId: String(message?.id || ''),
              generationTaskId: String(message?.metadata?.generationTaskId || ''),
              error: String(error?.message || error || ''),
            },
          })).catch(() => {});
          return null;
        });
        if (replyIntentOutboxStaged && ticketResult?.replyIntentConfirmed === true) {
          completeMessageReplyIntentOutbox(message);
        }
        // 票据失败时本页计时器仍会重试；页面被杀则保留 shadow 给启动恢复器。
        await scheduleRealPersonAutoReply();
      })().catch(() => {});
    } else if (rejectedByCharacter) {
      // 拒收状态已经随上面的 messages 写入一并耐久，恢复 shadow 只需补消息，不得排回复。
      if (replyIntentOutboxStaged) completeMessageReplyIntentOutbox(message);
    }
    // 消息落库后立即准备下一轮上下文。用户再点推进时若尚未完成，
    // buildChatSystemPrompt 会复用这个正在进行的单任务，不重复读取角色卡与记忆。
    scheduleAdvanceContextPrewarm(0);
    if (userAccountId && message?.senderId === 'user') {
      if (rejectedByCharacter) {
        const latest = await getChat(chatId).catch(() => null);
        if (latest) {
          latest.metadata = {
            ...latest.metadata,
            blockedDeliveryAttempts: Math.max(0, Number(latest.metadata?.blockedDeliveryAttempts) || 0) + 1,
          };
          await saveChat(latest);
          chat = latest;
          await recordUserAliasContactFact({
            userId: user.id,
            chatId,
            accountId: userAccountId,
            aliasName: frontStageUserName(),
            characterId: partnerId,
            blocked: true,
            blockedAttemptCount: latest.metadata.blockedDeliveryAttempts,
            blockReason: latest.metadata.friendshipBlockedReason,
          }).catch(() => null);
        }
      } else {
        await recordUserAliasContactFact({
          userId: user.id,
          chatId,
          accountId: userAccountId,
          aliasName: frontStageUserName(),
          characterId: partnerId,
          messageId: message.id,
          messageText: message.metadata?.text || message.content,
        }).catch(() => null);
      }
    }
  }

  async function persistCinematicCounterpart(job, contents = []) {
    const result = [];
    let ts = Math.max(
      Number(messages[messages.length - 1]?.timestamp || 0) + 900,
      peekNowForUser(user.id) ?? await getNowForUser(user.id),
    );
    for (let index = 0; index < contents.length; index += 1) {
      const content = contents[index];
      const text = String(content || '').trim();
      if (!text) continue;
      const message = createMessage({
        chatId,
        senderId: job.senderCharacterId || partnerId || '',
        senderName: job.senderName || title || '对方',
        type: 'text',
        content: text,
        timestamp: ts,
        metadata: {
          offlinePhoneCinematicJobId: job.id,
          offlinePhoneCinematicCounterpart: true,
          ...(index === contents.length - 1 && ['ask_join', 'coming'].includes(job.joinIntent) ? {
            offlineJoinIntent: job.joinIntent,
            offlineJoinMessage: job.joinMessage || text,
            offlineJoinDecision: job.joinDecision || 'pending',
            offlineJoinCharacterId: job.senderCharacterId || partnerId || '',
            offlineJoinCharacterName: job.senderName || title || 'TA',
            offlineSessionChatId: job.offlineChatId,
          } : {}),
        },
      });
      const localMutationRevision = markLocalMessageMutation(message.id, 'upsert', message);
      messages = [...messages, message];
      refreshMessages();
      noteSparkMessage(message);
      await Promise.all([
        saveMessage(message),
        updateChatPreview(chatId, previewFromMessage(message), message.timestamp),
      ]);
      settleLocalMessageMutation(message.id, localMutationRevision);
      result.push(message);
      ts += 1100;
      if (contents.length > 1) await cinematicSleep(380);
    }
    return result;
  }

  const cinematicSleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

  async function playOfflinePhoneCinematic(jobId) {
    if (!jobId || phoneCinematicRunning || isStreaming) return false;
    let job = await getOfflinePhoneCinematicJob(jobId);
    if (!job || job.targetChatId !== chatId || job.status === 'completed') return false;
    // 同行代答是普通主私聊的显式玩法；旧任务或异常路由不能把它带进陌生/马甲窗。
    if (strangerChat) {
      await updateOfflinePhoneCinematicJob(job.id, {
        status: 'failed',
        error: 'stranger-thread-user-impersonation-blocked',
      }).catch(() => {});
      return false;
    }
    phoneCinematicRunning = true;
    container.classList.add('is-phone-cinematic');
    const cue = document.createElement('div');
    cue.className = 'chat-phone-cinematic-cue';
    cue.innerHTML = `<span>${icon('smartphone')}</span><strong>${job.proxyName || 'TA'}接过了手机</strong>`;
    container.appendChild(cue);
    let replyMessage = messages.find((m) => String(m.metadata?.offlinePhoneCinematicJobId || '') === job.id) || null;
    try {
      if (!replyMessage && (job.status === 'queued' || job.status === 'typing')) {
        await updateOfflinePhoneCinematicJob(job.id, { status: 'typing', typingAt: Date.now() });
        await cinematicSleep(520);
        const chars = [...String(job.replyText || '')];
        for (let i = 0; i < chars.length; i += 1) {
          setComposerText(chars.slice(0, i + 1).join(''));
          if (i === 0) refreshComposerFooter();
          await cinematicSleep(42 + Math.round(Math.random() * 38));
        }
        // 最后一帧显式落成完整文案并稍作停留，避免低帧率设备还没绘制末尾就进入发送态。
        setComposerText(String(job.replyText || ''));
        await cinematicSleep(620);
        const input = container.querySelector('.chat-composer-input');
        if (input) {
          input.value = '';
          resizeComposerInput(input);
        }
        noteComposerDraft('');
        syncComposerSendButton();
        const ts = peekNowForUser(user.id) ?? await getNowForUser(user.id);
        replyMessage = createMessage({
          chatId,
          senderId: 'user',
          senderName: frontStageUserName(),
          type: 'text',
          content: job.replyText,
          timestamp: ts,
          metadata: {
            offlineAutoReply: true,
            autoReplyMode: 'companion',
            autoReplyLabel: `由${job.proxyName || 'TA'}代回`,
            proxyCharacterId: job.proxyCharacterId,
            proxyCharacterName: job.proxyName,
            offlineSessionChatId: job.offlineChatId,
            offlinePhoneCinematicJobId: job.id,
            offlinePhoneCinematicChannel: job.channel,
          },
        });
        await persistUserMessage(replyMessage);
        job = await updateOfflinePhoneCinematicJob(job.id, {
          status: 'sent',
          replyMessageId: replyMessage.id,
          sentAt: Date.now(),
        });
      }
      cue.classList.add('is-sent');
      cue.querySelector('strong').textContent = '对方正在输入…';
      await updateOfflinePhoneCinematicJob(job.id, { status: 'counterpartTyping' });
      let counterpartMessages = [];
      if (Array.isArray(job.counterpartReplies) && job.counterpartReplies.length) {
        await cinematicSleep(650 + Math.round(Math.random() * 500));
        counterpartMessages = await persistCinematicCounterpart(job, job.counterpartReplies);
      } else {
        // 兼容改版前已经排队但尚未播放的旧任务。
        const beforeIds = new Set(messages.map((m) => m.id));
        await runAiReply('advance', { sceneDirectiveOverride: job.sceneDirective });
        counterpartMessages = messages.filter((m) => !beforeIds.has(m.id) && m.senderId !== 'user');
      }
      await syncOfflineChatContinuityMemory({
        user,
        chat,
        senderCharacterId: job.senderCharacterId || partnerId || '',
        incomingMessages: messages.filter((message) => (job.incomingMessageIds || []).includes(message.id)),
        replyMessage,
        counterpartMessages,
        timestamp: replyMessage.timestamp,
      }).catch((err) => console.warn('[offline-phone-cinematic] continuity memory failed', err));
      await completeOfflinePhoneCinematicJob(job.id, { replyMessage, counterpartMessages });
      cue.querySelector('strong').textContent = '消息已经送达';
      await cinematicSleep(700);
      cue.remove();
      return true;
    } catch (err) {
      console.warn('[offline-phone-cinematic] playback failed', err);
      await updateOfflinePhoneCinematicJob(job.id, {
        status: replyMessage ? 'sent' : 'failed',
        error: String(err?.message || err || 'unknown').slice(0, 180),
      }).catch(() => {});
      cue.querySelector('strong').textContent = replyMessage ? '消息已代回' : '手机又回到了你手里';
      await cinematicSleep(700);
      cue.remove();
      return false;
    } finally {
      setComposerText('');
      phoneCinematicRunning = false;
      container.classList.remove('is-phone-cinematic');
    }
  }

  async function maybeStartSideTripCaught({ force = false, notify = false } = {}) {
    if (!offlineChatId || sideTripCatchChecking || phoneCinematicRunning || isStreaming) {
      if (notify) showToast('当前暂时不能发起代回');
      return false;
    }
    sideTripCatchChecking = true;
    try {
      const session = await loadOfflineSession(offlineChatId).catch(() => null);
      if (!session?.phoneSideTrip || session.status !== 'active') {
        if (notify) showToast('这次手机插曲已经结束');
        return false;
      }
      const activeOfflineChat = await getChat(offlineChatId).catch(() => null);
      const globalSettings = await loadOfflineAutoReplySettings(user.id);
      const config = resolveOfflineAutoReplyConfig(session, globalSettings);
      if (config.mode !== 'companion' || !config.sideTripCaught?.enabled) {
        if (notify) showToast('先在线下「消息与代答」里开启同行代答和掏手机被注意');
        return false;
      }
      const activeOfflineIds = getActiveOfflineParticipantIds(session, activeOfflineChat);
      const configuredProxyId = String(config.proxyCharacterId || '');
      const proxyId = activeOfflineIds.includes(configuredProxyId)
        ? configuredProxyId
        : (activeOfflineIds[0] || '');
      if (!canRunOfflineSideTripTakeover({
        activeParticipantIds: activeOfflineIds,
        proxyCharacterId: proxyId,
        targetCharacterId: partnerId,
      })) {
        if (notify) showToast('当前就是现场角色自己的聊天，不能让 TA 代回自己');
        return false;
      }
      const proxyCharacter = proxyId ? await getRecord('characters', proxyId) : null;
      if (!proxyCharacter) {
        if (notify) showToast('现场还没有可以代回的角色');
        return false;
      }
      const roll = await rollOfflinePhoneCinematic({
        userId: user.id,
        offlineChatId,
        channel: 'sideTripCaught',
        frequency: config.sideTripCaught.frequency,
        force,
      });
      if (!roll.hit) return false;
      const recent = messages.filter((m) => !m.deleted && !m.recalled).slice(-8);
      const senderName = title || partner?.name || '对方';
      const recentLines = recent.map((m) => {
        const who = m.senderId === 'user' ? frontStageUserName() : (m.senderName || senderName);
        return `${who}：${String(m.content || '').replace(/\s+/g, ' ').slice(0, 120)}`;
      });
      const exchange = await generatePhoneCinematicExchange({
        user,
        session,
        proxyCharacter,
        senderCharacter: partner,
        senderName,
        recentLines,
        channel: 'sideTripCaught',
      });
      if (!exchange || isStreaming) {
        if (notify) showToast('这次代回没有生成完整内容，请稍后再试');
        return false;
      }
      const proxyName = proxyCharacter.customNickname || proxyCharacter.name || 'TA';
      const joinIntent = activeOfflineIds.includes(String(partnerId || '')) ? 'none' : exchange.joinIntent;
      const job = await createOfflinePhoneCinematicJob({
        channel: 'sideTripCaught',
        userId: user.id,
        offlineChatId,
        targetChatId: chatId,
        senderCharacterId: partnerId || '',
        senderName,
        proxyCharacterId: proxyId,
        proxyName,
        replyText: exchange.replyText,
        counterpartReplies: exchange.counterpartReplies,
        joinIntent,
        joinMessage: joinIntent === 'none' ? '' : exchange.joinMessage,
        incomingCount: recent.filter((m) => m.senderId !== 'user').length,
        incomingMessageIds: recent.map((m) => m.id),
        incomingLines: recentLines,
      });
      if (joinIntent !== 'none') {
        await inviteOfflineParticipant({
          session,
          chat: activeOfflineChat,
          characterId: partnerId || '',
          source: 'phone_join_intent',
          text: `${senderName}在消息里提到想来现场，等你决定。`,
        });
      }
      await cinematicSleep(600);
      return await playOfflinePhoneCinematic(job.id);
    } finally {
      sideTripCatchChecking = false;
    }
  }

  function refreshGroupInfoCards() {
    const existing = container.querySelector('.chat-group-info-cards');
    const html = renderGroupInfoCards();
    if (existing) {
      if (html) existing.outerHTML = html;
      else existing.remove();
      return;
    }
    if (!html) return;
    const anchor = container.querySelector('.chat-thread-messages');
    anchor?.insertAdjacentHTML('beforebegin', html);
  }

  async function toggleGroupTodoFromThread(todoIdValue) {
    const id = String(todoIdValue || '').trim();
    if (!id || !isGroup) return;
    const todos = (Array.isArray(chat.groupSettings?.todos) ? chat.groupSettings.todos : []).map((item) => {
      if (String(item?.id || '') !== id) return item;
      return { ...item, done: !item.done, updatedAt: Date.now() };
    });
    chat.groupSettings = { ...(chat.groupSettings || {}), todos };
    await saveChat(chat);
    refreshGroupInfoCards();
    showToast('群待办已更新');
  }

  async function dismissGroupInfoCard(kind = '') {
    const k = String(kind || '').trim();
    if (!k || !isGroup) return;
    const sig = groupInfoSignature(k);
    if (!sig) return;
    chatPrefs = await patchChatPrefs(chatId, {
      dismissedGroupInfoCards: {
        ...(chatPrefs.dismissedGroupInfoCards || {}),
        [k]: sig,
      },
    });
    refreshGroupInfoCards();
  }

  function actorDisplayName(actorId = '', fallback = '') {
    return resolveUiActorName(actorId, fallback);
  }

  async function openPokeActionModal(targetMsg = null) {
    const targetId = String(targetMsg?.senderId || '').trim();
    if (!targetId || targetId === 'user' || targetId === 'system') return;
    const anonProfiles = buildAnonymousProfiles();
    const userAnonName = anonProfiles.user?.anonymousId || currentUserName || '我';
    const targetAnonName = anonProfiles[targetId]?.anonymousId
      || getAnonymousDisplayProfile(chat, targetId, { currentUserName, spaceProfile: anonSpaceProfile, actorSpaceProfiles })?.anonymousId
      || actorDisplayName(targetId, targetMsg?.senderName);
    const defaultText = `${userAnonName} 拍了拍 ${targetAnonName}`;
    openTextEditorModal({
      title: '拍一拍',
      value: defaultText,
      placeholder: `${userAnonName} 拍了拍 ${targetAnonName}，也可以改成戳了戳、拽了拽、摸了摸空钱包……`,
      multiline: false,
      confirmLabel: '发送',
      variant: anonEditorVariant(),
      onSave: async (text) => {
        const body = String(text || '').trim() || defaultText;
        const prefix = isGroup ? '群聊动作' : '聊天动作';
        const ts = await getNowForUser(user.id);
        const msg = createMessage({
          chatId,
          senderId: 'system',
          senderName: prefix,
          type: 'chatAction',
          content: `[${prefix}] ${body}`,
          timestamp: ts,
          metadata: {
            chatAction: 'poke',
            actionKind: prefix,
            actionActorId: 'user',
            actionActorName: userAnonName,
            actionTargetId: targetId,
            actionTargetName: targetAnonName,
            actionText: body,
          },
        });
        await persistUserMessage(msg);
        showToast(isGroup ? '已发送群聊动作' : '已发送聊天动作');
      },
    });
  }

  const linkEnhanceInflight = new Map();
  const staleLinkRefreshDone = new Set();
  const linkDetailReadInflight = new Set();
  let linkEnhanceQueue = Promise.resolve();
  let lastLinkEnhanceErrorToastAt = 0;

  function showLinkEnhanceErrorToast(message = '') {
    const text = String(message || '链接解析失败').slice(0, 120);
    const now = Date.now();
    if (now - lastLinkEnhanceErrorToastAt < 8000) return;
    lastLinkEnhanceErrorToastAt = now;
    showToast(text, 4500);
  }

  function enqueueLinkEnhance(task) {
    const run = linkEnhanceQueue.then(() => task(), () => task());
    linkEnhanceQueue = run.catch(() => {});
    return run;
  }

  function pickReplyOnlyMetadata(metadata = {}) {
    const md = metadata && typeof metadata === 'object' ? metadata : {};
    const picked = {};
    [
      'replyToMsgId', 'replyToId', 'replyPreview', 'replySenderId', 'replySenderName',
      'replyContent', 'replyType', 'quoteMsgId',
    ].forEach((key) => {
      if (md[key] != null && md[key] !== '') picked[key] = md[key];
    });
    return picked;
  }

  async function enhanceSentLinkMessage(message, linkShare, options = {}) {
    if (!message?.id || !linkShare?.url) return;
    const socialCfg = await loadSocialLinkConfig().catch(() => null);
    const targetUrl = normalizeLinkUrl(linkShare.url) || String(linkShare.url || '').trim();
    const needsEnhanceQueue = shouldAwaitLinkEnhanceQueue(targetUrl, socialCfg);
    // 本地分享摘要已经随 pending 卡片立即显示，不需要让后台深度解析并发抢跑。
    // 社媒链接统一串行，避免 iOS 主线程繁忙/页面挂起时多次解析完成顺序反转。
    return needsEnhanceQueue
      ? enqueueLinkEnhance(() => runEnhanceSentLinkMessage(message, linkShare, options))
      : runEnhanceSentLinkMessage(message, linkShare, options);
  }

  async function runEnhanceSentLinkMessage(message, linkShare, options = {}) {
    const messageId = message.id;
    const targetUrl = normalizeLinkUrl(linkShare.url) || String(linkShare.url || '').trim();
    const shareText = String(linkShare.rawText || message.metadata?.shareText || targetUrl).trim() || targetUrl;
    const enhanceToken = options.keepToken && message.metadata?.linkEnhanceToken
      ? message.metadata.linkEnhanceToken
      : createLinkEnhanceToken();
    linkEnhanceInflight.set(messageId, { token: enhanceToken, url: targetUrl, startedAt: Date.now() });
    try {
      const seedMd = message.metadata || {};
      const linkMeta = await enhanceLinkMetadata(targetUrl, {
        ...seedMd,
        url: targetUrl,
        title: String(seedMd.title || seedMd.pendingLinkTitle || linkShare.title || '').trim(),
        desc: String(seedMd.desc || seedMd.pendingLinkDesc || linkShare.desc || '').trim(),
        descFull: String(seedMd.descFull || seedMd.pendingLinkDesc || linkShare.descFull || linkShare.desc || '').trim(),
        description: String(seedMd.description || seedMd.pendingLinkDesc || linkShare.desc || '').trim(),
        source: 'web',
        platform: linkShare.platform || seedMd.platform,
        keywords: linkShare.keywords || seedMd.keywords,
        shareText,
        coverUrl: '',
        imageUrl: '',
        images: [],
      }, {
        refresh: options.refresh === true,
        shareText,
      });
      const inflight = linkEnhanceInflight.get(messageId);
      if (!inflight || inflight.token !== enhanceToken || inflight.url !== targetUrl) return;
      linkEnhanceInflight.delete(messageId);
      if (!linkMeta) return;
      const latest = messages.find((m) => m.id === messageId);
      if (!latest) return;
      const latestUrl = normalizeLinkUrl(latest.content || latest.metadata?.url || latest.metadata?.pendingLinkUrl || '')
        || String(latest.content || latest.metadata?.url || '').trim();
      if (latestUrl && targetUrl && latestUrl !== targetUrl) return;
      if (latest.metadata?.linkEnhanceToken && latest.metadata.linkEnhanceToken !== enhanceToken) return;
      const resolvedUrl = normalizeLinkUrl(linkMeta.resolvedUrl || linkMeta.url || targetUrl) || targetUrl;
      if (resolvedUrl && targetUrl && resolvedUrl !== targetUrl) return;
      const next = {
        ...latest,
        type: 'link',
        content: linkMeta.url || targetUrl,
        metadata: {
          ...pickReplyOnlyMetadata(latest.metadata),
          ...linkMeta,
          url: linkMeta.url || targetUrl,
          resolvedUrl: linkMeta.url || targetUrl,
          shareText,
          linkEnhanceToken: enhanceToken,
          pendingLinkUrl: undefined,
          pendingLinkTitle: undefined,
          pendingLinkDesc: undefined,
          linkEnhanceFailedAt: undefined,
          linkEnhanceError: undefined,
          visionContextConsumed: undefined,
          visionContextConsumedAt: undefined,
          visionContextConsumedReason: undefined,
        },
      };
      await saveMessage(next);
      await updateChatPreview(chatId, previewFromMessage(next), next.timestamp);
      messages = messages.map((m) => (m.id === next.id ? next : m));
      refreshMessages();
    } catch (err) {
      linkEnhanceInflight.delete(messageId);
      console.warn('[chat-thread] link enhancement failed', err);
      const latest = messages.find((m) => m.id === messageId);
      if (latest && (!latest.metadata?.linkEnhanceToken || latest.metadata.linkEnhanceToken === enhanceToken)) {
        const hadLocalPreview = !!(
          latest.metadata?.title
          || latest.metadata?.pendingLinkTitle
          || latest.metadata?.desc
          || latest.metadata?.pendingLinkDesc
          || linkShare.title
          || linkShare.desc
        );
        const failed = {
          ...latest,
          metadata: {
            ...pickReplyOnlyMetadata(latest.metadata),
            ...(hadLocalPreview ? {
              url: targetUrl,
              title: String(latest.metadata?.title || latest.metadata?.pendingLinkTitle || linkShare.title || '').trim(),
              desc: String(latest.metadata?.desc || latest.metadata?.pendingLinkDesc || linkShare.desc || '').trim(),
              descFull: String(latest.metadata?.descFull || latest.metadata?.pendingLinkDesc || linkShare.descFull || linkShare.desc || '').trim(),
              description: String(latest.metadata?.description || latest.metadata?.pendingLinkDesc || linkShare.desc || '').trim(),
              platform: linkShare.platform || latest.metadata?.platform,
              keywords: linkShare.keywords || latest.metadata?.keywords,
              enhancedBy: 'local-share',
              localPreview: true,
            } : {
              url: targetUrl,
            }),
            shareText,
            linkEnhanceToken: enhanceToken,
            pendingLinkUrl: undefined,
            pendingLinkTitle: undefined,
            pendingLinkDesc: undefined,
            linkEnhanceFailedAt: hadLocalPreview ? undefined : Date.now(),
            linkEnhanceError: hadLocalPreview ? undefined : String(err?.message || err || '链接解析失败').slice(0, 160),
          },
        };
        await saveMessage(failed).catch(() => {});
        messages = messages.map((m) => (m.id === failed.id ? failed : m));
        refreshMessages();
        if (!hadLocalPreview) showLinkEnhanceErrorToast(err?.message || '链接解析失败');
      }
    }
  }

  async function readTaobaoLinkDetailWithRole(message, actionEl = null) {
    const messageId = String(message?.id || '');
    if (!messageId || message?.senderId !== 'user') return;
    if (isStreaming || getChatStreamSession(chatId)) {
      showToast('角色正在回复，结束后再让 TA 看商品页');
      return;
    }
    if (linkDetailReadInflight.has(messageId)) return;
    linkDetailReadInflight.add(messageId);
    if (actionEl) {
      actionEl.setAttribute('aria-disabled', 'true');
      actionEl.textContent = '读取中…';
    }
    try {
      showToast('正在读取商品页，完成后会自动让角色查看');
      const url = normalizeLinkUrl(message.metadata?.url || message.content || '')
        || String(message.metadata?.url || message.content || '').trim();
      const snapshot = await captureLinkDetailSnapshot(url, message.metadata || {});
      if (!snapshot?.screenshotFallback || !Array.isArray(snapshot.images) || !snapshot.images.length) return;
      const latest = messages.find((item) => String(item?.id || '') === messageId);
      if (!latest) return;
      const next = {
        ...latest,
        type: 'link',
        content: url,
        metadata: {
          ...attachLinkDetailSnapshotMetadata(latest.metadata || {}, snapshot),
          url,
          resolvedUrl: url,
        },
      };
      await saveMessage(next);
      messages = messages.map((item) => (String(item?.id || '') === messageId ? next : item));
      refreshMessages();
      showToast('商品页已读取，正在让角色查看');
      await runAiReply('advance', {
        manualRequest: true,
        forcedLinkVisionMessageId: messageId,
        sceneDirectiveOverride: '[用户刚主动让你查看上一条淘宝商品页] 请结合本轮附带的商品页截图回应；只描述截图中确实可见的信息，看不清的规格、价格或细节不要猜。',
      });
    } finally {
      linkDetailReadInflight.delete(messageId);
      if (actionEl?.isConnected) {
        actionEl.removeAttribute('aria-disabled');
        actionEl.textContent = '让角色看看';
      }
    }
  }

  function refreshStaleLinkMessages() {
    const failureCooldownMs = 30 * 60 * 1000;
    for (const msg of messages) {
      const normalized = normalizeMsgForUi(msg);
      const workMsg = normalized.type === 'link' && msg.type === 'text' ? normalized : msg;
      if (workMsg.type !== 'link') continue;
      if (msg.type === 'text' && normalized.type === 'link') {
        void saveMessage(normalized).then((saved) => {
          messages = messages.map((m) => (m.id === saved.id ? saved : m));
        }).catch(() => {});
      }
      if (linkEnhanceInflight.has(workMsg.id)) continue;
      const md = workMsg.metadata || {};
      const url = normalizeLinkUrl(md.url || workMsg.content || md.pendingLinkUrl || '')
        || String(md.url || workMsg.content || '').trim();
      if (!url) continue;
      const failedAt = Number(md.linkEnhanceFailedAt || 0);
      if (failedAt && Date.now() - failedAt < failureCooldownMs) continue;
      const pending = !!md.pendingLinkUrl && !md.enhancedBy && !md.linkEnhanceFailedAt;
      const stale = isLinkMessageMetadataStale(workMsg);
      if ((!pending && !stale) || staleLinkRefreshDone.has(workMsg.id)) continue;
      staleLinkRefreshDone.add(workMsg.id);
      void enhanceSentLinkMessage(workMsg, {
        url,
        title: String(md.title || md.pendingLinkTitle || '').trim(),
        desc: String(md.desc || md.pendingLinkDesc || '').trim(),
        descFull: String(md.descFull || md.pendingLinkDesc || md.desc || '').trim(),
        rawText: String(md.shareText || workMsg.content || url).trim() || url,
        platform: md.platform,
        keywords: md.keywords,
      }, { refresh: stale, keepToken: true });
    }
  }

  async function sendTextMessage() {
    const inputEl = container.querySelector('.chat-composer-input');
    const draftValue = String(inputEl?.value || '');
    const editRevisionAtSend = composerDraftEditRevision;
    const text = draftValue.trim();
    if (!text || isStreaming || phoneCinematicRunning || isComposerInputLocked() || textMessagePrepareInFlight) return;
    textMessagePrepareInFlight = true;
    const messageMentions = isGroup
      ? collectPersistedChatMentions(text, composerMentionDrafts)
      : [];
    const mentionDraftsAtSend = composerMentionDrafts.map((item) => ({ ...item }));
    const replyTargetAtSend = replyTarget;
    let ts = 0;
    let linkShare = null;
    let phoneProxySenderId = '';
    let composedSenderId = '';
    let base = null;
    try {
      const cachedWorldNow = peekNowForUser(user.id);
      ts = cachedWorldNow ?? Date.now();
      linkShare = parseSingleLinkShareText(text);
      phoneProxySenderId = fromCharacterPhone && phoneProxyMode ? phoneViewerId : '';
      composedSenderId = phoneProxySenderId || sendAsCharacterId;
      const replyIdentity = !composedSenderId ? makeStableReplyGenerationIdentity() : null;
      base = createMessage({
      chatId,
      senderId: composedSenderId || 'user',
      senderName: composedSenderId
        ? (characters[composedSenderId]?.name || characters[composedSenderId]?.customNickname || composedSenderId)
        : frontStageUserName(),
      type: linkShare?.url ? 'link' : 'text',
      content: linkShare?.url || text,
      timestamp: ts,
      metadata: {
        ...(linkShare?.url ? buildPendingLinkMetadata(linkShare) : {}),
        ...(messageMentions.length ? { mentions: messageMentions } : {}),
        ...(chatPrefs.guidanceMode === true ? { guidanceMode: true } : {}),
        ...(replyIdentity ? {
          generationTaskId: replyIdentity.taskId,
          generationIdempotencyKey: replyIdentity.idempotencyKey,
          generationAiRoundId: replyIdentity.aiRoundId,
        } : {}),
        ...(phoneProxySenderId
          ? createPhoneProxyMessageMetadata({
            ownerId: phoneViewerId,
            userId: user.id,
            participantIds: chat.participants,
            messageText: text,
            ownerName: resolveUiActorName(phoneViewerId, characters[phoneViewerId]?.name || ''),
            userName: frontStageUserName(),
          })
          : (sendAsCharacterId ? {
            userComposedAsCharacter: true,
            sendAsCharacterId,
          } : {})),
        ...(strangerChat && !composedSenderId
          ? { accountId: chat.metadata?.accountIdentityMap?.[principalKey('user', user.id)] || '' }
          : {}),
      },
      });
      if (replyTargetAtSend) {
        Object.assign(base, buildReplyTargetFields(replyTargetAtSend.raw, {
        resolveSenderLabel: resolveReplySenderLabel,
        }));
      }
      if (cachedWorldNow == null) provisionalReplyIntentTimestamps.add(base);
      // 点击发送后的首个 await 之前先同步写 shadow；否则冷缓存世界钟/IndexedDB
      // 一旦被系统冻结，既没有消息，也没有可恢复的 API 回复意图。
      stageMessageReplyIntentOutbox(base);
      // shadow 已经同步接住恢复锚点；输入框必须在点击发送的同一帧清空，不能等
      // 世界钟修复与 IndexedDB 落库。若耐久写入失败，下面只在用户没有继续编辑时
      // 恢复原草稿，既不丢消息，也不覆盖已经开始写的下一条。
      const draftCleared = clearSentComposerDraft(draftValue, editRevisionAtSend, inputEl);
      try {
        await persistUserMessage(base);
      } catch (error) {
        if (draftCleared) {
          restoreSentComposerDraftAfterFailure(
            draftValue,
            editRevisionAtSend,
            mentionDraftsAtSend,
          );
        }
        throw error;
      }
      if (replyTarget === replyTargetAtSend) {
        replyTarget = null;
        refreshReplyBar();
      }
    } finally {
      textMessagePrepareInFlight = false;
      syncComposerSendButton();
    }
    if (phoneProxySenderId) {
      const ownerName = resolveUiActorName(phoneViewerId, characters[phoneViewerId]?.name || '手机主人');
      const targetId = (chat.participants || []).find((id) => id && id !== phoneViewerId && id !== 'system');
      const targetLabel = isGroup
        ? `群「${String(chat.groupSettings?.name || title || '群聊').trim()}」`
        : resolveUiActorName(targetId, title || '当前联系人');
      const ownerMainChat = await ensurePrivateChat(user.id, phoneViewerId, ownerName).catch(() => null);
      if (ownerMainChat?.id) {
        const feedbackAnchor = createMessage({
          chatId: ownerMainChat.id,
          senderId: 'system',
          type: 'system',
          content: buildPhoneProxyOwnerFeedbackExplain({
            userName: frontStageUserName(),
            ownerName,
            targetLabel,
            messageText: text,
          }),
          timestamp: Number(ts || 0) + 1,
          metadata: {
            plotExplain: true,
            phoneProxyOwnerFeedback: true,
            phoneProxyOwnerId: phoneViewerId,
            phoneProxySourceChatId: chatId,
            phoneProxySourceMessageId: base.id,
          },
        });
        await saveMessage(feedbackAnchor).catch(() => null);
      }
    }
    if (!composedSenderId && offlineChatId) {
      void maybeStartSideTripCaught();
    }
    if (linkShare?.url) {
      void enhanceSentLinkMessage(base, linkShare, { keepToken: true });
    }
  }

  function openVoiceComposerSheet() {
    if (isStreaming) return;
    closeToolsSheet();
    markChatComposerActive(chatId);
    interruptBackgroundGenerationForComposer();
    noteComposerActivity();
    openChatVoiceComposerSheet({
      variant: anonEditorVariant(),
      ensureVoiceNotice: () => showVoiceInputNoticeIfNeeded(anonEditorVariant()),
      onSendVoice: async ({ text, duration }) => {
        await sendTypedMessage('voice', '[语音消息]', { text, duration });
      },
      onClosed: () => {
        markChatComposerIdle(chatId);
        if (!composerEmptySince) composerEmptySince = Date.now();
      },
    });
  }

  function openComposeTextEditor(options = {}) {
    markChatComposerActive(chatId);
    interruptBackgroundGenerationForComposer();
    noteComposerActivity();
    openTextEditorModal({
      ...options,
      onClosed: () => {
        try { options.onClosed?.(); } catch (_) {}
        markChatComposerIdle(chatId);
        if (!composerEmptySince) composerEmptySince = Date.now();
      },
    });
  }

  async function sendPickedSticker(sticker) {
    if (!sticker || isStreaming || phoneCinematicRunning) return;
    const { upgradeStickerImageUrl } = await import('../core/sticker-store.js');
    const url = upgradeStickerImageUrl(sticker.url);
    await sendTypedMessage('sticker', sticker.name, {
      stickerName: sticker.name,
      url,
      stickerId: String(sticker.id || '').trim(),
      packId: String(sticker.packId || '').trim(),
      packName: sticker.packName,
    });
  }

  async function sendTypedMessage(type, content, metadata = {}) {
    const cachedWorldNow = peekNowForUser(user.id);
    const ts = cachedWorldNow ?? Date.now();
    const replyIdentity = !sendAsCharacterId ? makeStableReplyGenerationIdentity(metadata) : null;
    const msg = createMessage({
      chatId,
      senderId: sendAsCharacterId || 'user',
      senderName: sendAsCharacterId
        ? (characters[sendAsCharacterId]?.name || characters[sendAsCharacterId]?.customNickname || sendAsCharacterId)
        : frontStageUserName(),
      type,
      content,
      timestamp: ts,
      metadata: {
        ...metadata,
        ...(replyIdentity ? {
          generationTaskId: replyIdentity.taskId,
          generationIdempotencyKey: replyIdentity.idempotencyKey,
          generationAiRoundId: replyIdentity.aiRoundId,
        } : {}),
        ...(strangerChat && !sendAsCharacterId
          ? { accountId: chat.metadata?.accountIdentityMap?.[principalKey('user', user.id)] || '' }
          : {}),
      },
    });
    if (replyTarget) {
      Object.assign(msg, buildReplyTargetFields(replyTarget.raw, {
        resolveSenderLabel: resolveReplySenderLabel,
      }));
    }
    const replyTargetAtSend = replyTarget;
    if (cachedWorldNow == null) provisionalReplyIntentTimestamps.add(msg);
    stageMessageReplyIntentOutbox(msg);
    await persistUserMessage(msg);
    if (replyTarget === replyTargetAtSend) {
      replyTarget = null;
      refreshReplyBar();
    }
    return msg;
  }

  async function sendPendingShoppingShare() {
    if (!pendingShoppingShareId || pendingShoppingShareHandled) return;
    pendingShoppingShareHandled = true;
    try {
      const { consumePendingShoppingShare, getPendingShoppingShare } = await import('../core/shopping-catalog.js');
      const share = await getPendingShoppingShare(pendingShoppingShareId);
      if (!share?.items?.length) return;
      const giftForName = !isGroup && partnerId
        ? resolveUiActorName(partnerId, partner?.name || partner?.customNickname || partnerId || '对方')
        : '';
      const itemCount = share.items.reduce((sum, item) => sum + (Number(item.quantity) || 1), 0);
      const summary = share.items.slice(0, 8).map((item) => (
        `${item.name}${item.spec ? `（${item.spec}）` : ''}×${Number(item.quantity) || 1}`
      )).join('、');
      const title = share.items.length === 1 ? share.items[0].name : `${share.providerLabel || '购物'}购物车（${itemCount}件）`;
      const metadata = {
        productTitle: title,
        orderTitle: title,
        orderPrice: share.amount,
        price: share.amount,
        orderNote: summary,
        note: summary,
        platform: share.providerLabel || '购物',
        orderPlatform: share.providerLabel || '购物',
        giftDirection: 'user_to_char',
        shoppingCartShare: true,
        shoppingProviderId: share.providerId,
        orderItemCount: itemCount,
        orderItems: share.items,
      };
      if (giftForName) {
        metadata.giftForName = giftForName;
        metadata.giftForCharacterId = partnerId;
      }
      await sendTypedMessage('orderShare', buildOrderShareMessageContent(metadata), metadata);
      await consumePendingShoppingShare(pendingShoppingShareId);
      showToast(giftForName ? `已把购物车发给 ${giftForName}` : '已发送购物车订单卡片');
    } catch (error) {
      pendingShoppingShareHandled = false;
      showToast(error?.message || '购物车发送失败');
    }
  }

  function normalizeVoiceCallState(raw = '') {
    const s = String(raw || '').trim().toLowerCase();
    if (/miss|未接|没接/.test(s)) return 'missed';
    if (/cancel|取消|已取消/.test(s)) return 'cancelled';
    if (/declin|reject|拒绝/.test(s)) return 'declined';
    if (/hang\s*up|hung\s*up|挂断|已挂断/.test(s)) return 'ended';
    if (/end|ended|结束|已结束|通话结束/.test(s)) return 'ended';
    if (/active|calling|ongoing|接听|通话中|正在通话|继续/.test(s)) return 'active';
    if (/out|拨出|呼出/.test(s)) return 'outgoing';
    return 'incoming';
  }

  function findLiveVoiceCallController(msg = {}) {
    const callKey = `${chatId}:${String(msg?.id || '').trim()}`;
    const overlay = Array.from(document.querySelectorAll('.voice-call-overlay[data-voice-call-key]'))
      .find((node) => node.dataset.voiceCallKey === callKey);
    const controller = overlay?.__marshmallowVoiceCallController;
    return controller?.overlay?.isConnected ? controller : null;
  }

  function resolveVoiceCallTarget(msg = {}) {
    const senderId = String(msg.senderId || '').trim();
    const targetId = senderId === 'user'
      ? (String(msg.metadata?.targetId || msg.metadata?.to || partnerId || '').trim()
        || Object.keys(characters || {})[0]
        || 'user')
      : senderId;
    const row = characters[targetId] || (targetId === partner?.id ? partner : null);
    const name = resolveUiActorName(
      targetId,
      msg.senderName || (targetId === 'user' ? user.name : targetId) || '语音通话',
    );
    const avatarHtml = row
      ? characterAvatarHtml(row, { className: 'chat-bubble-avatar-img' })
      : '';
    return { id: targetId, name, avatarHtml, row };
  }

  async function updateVoiceCallMessage(msg, patch = {}) {
    const next = {
      ...msg,
      metadata: {
        ...(msg.metadata || {}),
        ...patch,
        updatedAt: Date.now(),
      },
    };
    await saveMessage(next);
    messages = messages.map((m) => (m.id === next.id ? next : m));
    await recalcChatPreview(chatId);
    return next;
  }

  function buildVoiceCallRecord(msg, extra = {}) {
    const target = resolveVoiceCallTarget(msg);
    const md = { ...(msg.metadata || {}), ...(extra || {}) };
    const endedAt = Date.now();
    const callState = normalizeVoiceCallState(md.callState || md.state || 'ended');
    return {
      id: md.voiceCallRecordId || `call_${msg.id || Date.now()}_${endedAt}`,
      messageId: msg.id,
      chatId,
      counterpartId: target.id,
      counterpartName: target.name,
      title: md.title || '语音通话',
      callMode: String(md.callMode || '').trim() === 'video' ? 'video' : 'voice',
      note: md.note || msg.content || '',
      callState,
      duration: md.durationLabel || md.duration || '',
      durationMs: Number(md.durationMs || 0) || 0,
      startedAt: md.acceptedAt || msg.timestamp || endedAt,
      endedAt,
      ambienceMode: md.ambienceMode || 'off',
      transcript: String(md.transcript || md.transcriptText || '').trim(),
      entries: Array.isArray(md.callEntries) ? md.callEntries.map((entry) => ({ ...entry })) : [],
      source: 'chat-thread',
    };
  }

  async function saveVoiceCallRecordForMessage(msg, extra = {}) {
    const record = buildVoiceCallRecord(msg, extra);
    const updated = await updateVoiceCallMessage(msg, {
      voiceCallRecordId: record.id,
      voiceCallRecord: record,
    });
    if (record.counterpartId && record.counterpartId !== 'user') {
      appendCharacterPhoneCallRecord(user.id, record.counterpartId, {
        id: record.id,
        title: record.title || '语音通话',
        contactName: user.name || '我',
        direction: msg.senderId === 'user' ? 'outgoing' : (record.callState === 'declined' ? 'missed' : 'incoming'),
        durationText: record.duration || '',
        summary: record.transcript || record.note || record.callState || '通话记录',
        occurredAt: record.startedAt || record.endedAt || Date.now(),
        createdAt: record.endedAt || Date.now(),
      }).catch((err) => console.warn('[voice-call] sync character phone failed', err));
    }
    return updated.metadata.voiceCallRecord;
  }

  const voiceCallOpenPromises = new Map();
  const reuseVoiceCallModal = async (modal, options = {}) => {
    if (!modal?.overlay?.isConnected) return null;
    if (options.answerNow === true) {
      await modal.acceptCall?.(options.gestureToken || null);
    } else {
      modal.adoptMediaGesture?.(options.gestureToken || null);
    }
    if (options.minimized === true) modal.minimize?.();
    else modal.expand?.();
    return modal;
  };
  async function openVoiceCallFromMessage(msg, options = {}) {
    const callKey = `${chatId}:${String(msg?.id || '').trim()}`;
    const existingOverlay = Array.from(document.querySelectorAll('.voice-call-overlay[data-voice-call-key]'))
      .find((node) => node.dataset.voiceCallKey === callKey);
    const existingModal = existingOverlay?.__marshmallowVoiceCallController;
    if (existingModal?.overlay?.isConnected) return reuseVoiceCallModal(existingModal, options);

    const pendingOpen = voiceCallOpenPromises.get(callKey);
    if (pendingOpen) {
      const pendingModal = await pendingOpen;
      return reuseVoiceCallModal(pendingModal, options);
    }

    const openTask = openVoiceCallFromMessageOnce(msg, options);
    voiceCallOpenPromises.set(callKey, openTask);
    try {
      return await openTask;
    } finally {
      if (voiceCallOpenPromises.get(callKey) === openTask) voiceCallOpenPromises.delete(callKey);
    }
  }
  async function openVoiceCallFromMessageOnce(msg, options = {}) {
    let fresh = messages.find((m) => m.id === msg.id) || msg;
    const state = normalizeVoiceCallState(fresh.metadata?.callState || fresh.metadata?.state || '');
    if (options.answerNow && state !== 'active') {
      fresh = await updateVoiceCallMessage(fresh, {
        callState: 'active',
        state: 'active',
        acceptedAt: fresh.metadata?.acceptedAt || Date.now(),
      });
    }
    let target = resolveVoiceCallTarget(fresh);
    // 角色编辑页与聊天页都会 Keep-Alive。返回后页面的异步刷新尚未完成时，
    // 立即点旧的电话气泡会读到上一份 voiceProfile，表现为刚上传的背景不显示。
    // 通话是低频动作，打开前定点重读一次不会影响列表性能。
    if (target.id && target.id !== 'user') {
      const [latestBaseRow, latestUserRow] = await Promise.all([
        getRecord('characters', target.id).catch(() => null),
        ensureDefaultUser().catch(() => null),
      ]);
      const identityOverride = latestUserRow?.characterOverrides?.[target.id];
      const latestTargetRow = latestBaseRow && identityOverride && typeof identityOverride === 'object'
        ? { ...latestBaseRow, ...identityOverride, id: latestBaseRow.id }
        : latestBaseRow;
      if (latestTargetRow) {
        characters[target.id] = latestTargetRow;
        if (target.id === partnerId) partner = latestTargetRow;
        target = resolveVoiceCallTarget(fresh);
      }
    }
    const modalState = normalizeVoiceCallState(fresh.metadata?.callState || fresh.metadata?.state || '');
    const currentCallMode = String(fresh.metadata?.callMode || '').trim() === 'video' ? 'video' : 'voice';
    const activeCallStatusText = currentCallMode === 'video' ? '视频通话中' : '语音通话中';
    const voiceProfile = target.row?.voiceProfile && typeof target.row.voiceProfile === 'object'
      ? target.row.voiceProfile
      : {};
    const globalVoiceConfig = await loadVoiceToolConfig().catch(() => null);
    const voiceConfig = globalVoiceConfig
      ? resolveVoiceToolConfigForProfile(globalVoiceConfig, voiceProfile)
      : null;
    const voiceOutputEnabled = !!voiceConfig
      && isVoiceToolEnabled(voiceConfig)
      && isCharacterVoiceTtsEnabled(voiceProfile, voiceConfig.provider);
    const callVoiceConfig = voiceConfig ? {
      ...voiceConfig,
      styleBook: {
        ...(voiceConfig.styleBook || {}),
        naturalPauses: false,
        subtleEmotion: false,
        nativeEmotion: false,
      },
    } : null;
    const callVoiceWorldBookPrompt = voiceConfig?.styleBook?.enabled === true
      ? buildVoiceWorldBookPrompt(
        currentCallMode === 'video'
          ? VOICE_WORLD_BOOK_SURFACES.VIDEO_CALL
          : VOICE_WORLD_BOOK_SURFACES.VOICE_CALL,
        {
          customText: voiceConfig.styleBook?.text || '',
          provider: voiceConfig.provider,
        },
      )
      : '';
    const videoBackground = String(voiceProfile.videoBackground || voiceProfile.video_background || '').trim();
    const videoStageDirections = voiceProfile.videoStageDirections === true || String(voiceProfile.videoStageDirections || '').trim() === 'true';
    const callTranslation = resolveVoiceTranslationProfile(target.row?.translationProfile);
    const callReplyDisplayMode = resolveVoiceCallReplyDisplayMode(
      chatPrefs?.callReplyDisplayMode,
      { translationActive: callTranslation.active },
    );
    const callProactiveSpeechEnabled = chatPrefs?.callProactiveSpeechEnabled === true;
    const callProactiveIntervalSeconds = [30, 60, 120, 300].includes(Number(chatPrefs?.callProactiveIntervalSeconds))
      ? Number(chatPrefs.callProactiveIntervalSeconds)
      : 60;
    const callAiHangupEnabled = chatPrefs?.callAiHangupEnabled === true;
    const userVideoVisual = String(user.videoAvatar || user.videoProfileImage || user.avatar || '').trim();
    const userVideoDescription = String(user.videoAppearancePrompt || user.videoProfileDescription || '').trim();
    const session = {
      active: modalState === 'active',
      closed: false,
      aiAbort: null,
      ttsAbort: null,
      audio: null,
      playbackToken: 0,
      playbackChain: Promise.resolve(),
      playbackQueueGeneration: 0,
      playbackBusy: false,
      playSlot: { gesture: null, audio: null },
      pendingMediaGesture: options.gestureToken || null,
      replaying: false,
      proactiveTimer: null,
      automationBusy: false,
      lastUserAt: Date.now(),
      soundSession: null,
      ambienceGestures: (Array.isArray(options.ambienceGestureTokens)
        ? options.ambienceGestureTokens
        : [options.ambienceGestureToken]).filter(Boolean),
    };
    const persistedCallEntries = Array.isArray(fresh.metadata?.callEntries)
      ? fresh.metadata.callEntries
        .map((entry) => {
          const rawText = normalizeVoiceCallText(entry?.rawText).trim();
          const text = normalizeVoiceCallText(entry?.text).trim() || rawText;
          return { ...entry, text, rawText: rawText || text };
        })
        .filter((entry) => entry.text)
      : [];
    const callHistory = [];
    persistedCallEntries.forEach((entry) => {
      const role = entry.from === 'user' ? 'user' : 'assistant';
      const text = (normalizeVoiceCallText(entry.rawText) || normalizeVoiceCallText(entry.text)).trim();
      const groupId = String(entry.replyGroupId || '').trim();
      const previous = callHistory[callHistory.length - 1];
      if (role === 'assistant' && groupId && previous?.role === role && previous.replyGroupId === groupId) {
        previous.text += text;
        return;
      }
      callHistory.push({ role, text, replyGroupId: groupId });
    });
    let voiceCallPersistChain = Promise.resolve();
    let pendingCallCheckpoint = null;
    let callCheckpointQueued = false;
    let callCheckpointEnabled = true;
    const persistVoiceCallPatch = (patch = {}) => {
      voiceCallPersistChain = voiceCallPersistChain
        .catch(() => {})
        .then(async () => {
          const latest = messages.find((message) => message.id === fresh.id) || fresh;
          fresh = await updateVoiceCallMessage(latest, patch);
          return fresh;
        });
      return voiceCallPersistChain;
    };
    const queueCallCheckpoint = (snapshot = {}) => {
      if (!callCheckpointEnabled) return;
      pendingCallCheckpoint = {
        transcriptText: String(snapshot.transcriptText || '').trim(),
        entries: Array.isArray(snapshot.entries) ? snapshot.entries.map((entry) => ({ ...entry })) : [],
      };
      if (callCheckpointQueued) return;
      callCheckpointQueued = true;
      queueMicrotask(() => {
        callCheckpointQueued = false;
        if (!callCheckpointEnabled || !pendingCallCheckpoint) return;
        const next = pendingCallCheckpoint;
        pendingCallCheckpoint = null;
        void persistVoiceCallPatch({
          transcript: next.transcriptText,
          callEntries: next.entries,
          callSummary: next.transcriptText,
        }).catch((err) => console.warn('[voice-call] checkpoint failed', err));
      });
    };
    const stopCallCheckpoint = () => {
      callCheckpointEnabled = false;
      pendingCallCheckpoint = null;
    };
    const reportCallTtsError = (err, operation = '语音合成') => {
      if (isAbortLikeError(err) || isVoiceTtsSkipError(err) || session.closed) return;
      showGenerationErrorReport({
        scope: '语音通话 / 语音合成',
        operation,
        title: '语音合成失败',
        message: String(err?.message || err || '语音合成失败'),
        error: String(err?.message || err || '语音合成失败'),
        reason: 'generic',
        status: err?.status,
        at: Date.now(),
      });
    };
    const reportCallTextError = (err, operation = '通话台词生成') => {
      if (isAbortLikeError(err) || session.closed) return;
      showGenerationErrorReport(generationErrorFromCatch(err, {
        scope: `${currentCallMode === 'video' ? '视频通话' : '语音通话'} / 台词生成`,
        operation,
        title: err?.voiceCallParseReason ? '通话台词提取失败' : '',
        reason: err?.reason || (err?.voiceCallParseReason ? 'validation-failed' : ''),
        message: err?.message || '通话台词生成失败',
        rawText: err?.rawText || '',
        responseText: err?.responseText || '',
        upstreamResponse: err?.upstreamResponse || '',
        upstreamMeta: err?.upstreamMeta || null,
        finishReason: err?.finishReason || '',
        requestModel: err?.requestModel || '',
        requestStream: err?.requestStream,
        streamStats: err?.streamStats || null,
        emptyKind: err?.emptyKind || '',
      }));
    };
    const shouldRetryCallTtsError = (err) => {
      const status = Number(err?.status || err?.statusCode || 0) || 0;
      if (status === 408 || status === 409 || status === 425 || status === 429 || status >= 500) return true;
      return /(?:timeout|timed out|network|failed to fetch|load failed|econn|socket|temporar|rate.?limit|超时|网络|连接|限流|稍后重试)/i
        .test(String(err?.message || err || ''));
    };
    const stopCallTasks = () => {
      session.closed = true;
      session.active = false;
      session.playbackToken += 1;
      if (session.proactiveTimer) clearTimeout(session.proactiveTimer);
      session.proactiveTimer = null;
      try { session.aiAbort?.abort?.(); } catch (_) {}
      try { session.ttsAbort?.abort?.(); } catch (_) {}
      try {
        if (session.audio) {
          session.audio.pause();
          session.audio.currentTime = 0;
        }
      } catch (_) {}
      session.aiAbort = null;
      session.ttsAbort = null;
      session.audio = null;
      session.playSlot.gesture?.dispose?.();
      session.pendingMediaGesture?.dispose?.();
      session.playSlot.gesture = null;
      session.pendingMediaGesture = null;
      session.playSlot.audio = null;
      void session.soundSession?.stop?.({ immediate: true });
      session.soundSession = null;
      session.ambienceGestures.forEach((token) => token?.dispose?.());
      session.ambienceGestures = [];
    };
    const cleanCallReplyText = (raw = '') => stripLeakedVoiceCallContextPrefix(
      stripLeakedReasoningForCall(raw, {
        preserveLeadingForeign: callTranslation.active,
      })
        .replace(/^\s*(?:assistant|ai|回复)\s*[:：]\s*/i, '')
        .replace(/^\s*[\r\n]+|[\r\n]+\s*$/g, '')
        .trim(),
    );
    const buildCallSceneDirective = (userText = '', mode = 'reply') => {
      const currentUserText = String(userText || '').trim();
      const lastCallTurn = callHistory[callHistory.length - 1];
      // onSendText 会先把本句写入 callHistory；当前句在下方有独立的高优先级位置，
      // 这里从“刚刚说过”中排除一次，避免模型把同一句读两遍后机械复述。
      const priorCallHistory = mode === 'reply'
        && lastCallTurn?.role === 'user'
        && String(lastCallTurn.text || '').trim() === currentUserText
        ? callHistory.slice(0, -1)
        : callHistory;
      const callTurns = selectVoiceCallContextTurns(priorCallHistory, {
        contextDepth: chatPrefs?.contextDepth,
        charBudget: 12000,
      })
        .map((item) => `${item.role === 'user' ? '用户' : target.name}：${item.text}`)
        .join('\n');
      const sceneLabel = currentCallMode === 'video' ? '视频通话模式' : '语音通话模式';
      const sceneNoun = currentCallMode === 'video' ? '视频通话' : '电话';
      const videoUserLine = currentCallMode === 'video'
        ? [
          userVideoDescription ? `用户的视频通话画面：${userVideoDescription}` : '',
          userVideoVisual ? '用户已设置“我的视频形象”图片；如果本轮请求里包含图片，请把它当作你在视频里能看到的用户画面来参考。' : '',
        ].filter(Boolean).join('\n')
        : '';
      const aiInitiatedNote = mode === 'opening' && fresh.metadata?.aiInitiated
        ? String(fresh.metadata?.note || '').trim()
        : '';
      return [
        `[${sceneLabel}]`,
        `当前通话对象：${target.name}`,
        videoUserLine,
        '普通聊天上下文、角色设定、世界书、私聊摘要和最近聊天记录以上文为准；不要脱离未完话题。',
        mode === 'opening'
          ? (aiInitiatedNote
            ? `这通${sceneNoun}是你刚才主动打给用户的，用户接听了。你当时想打给对方的理由：${aiInitiatedNote}。开场时自然带出这个理由或情绪（不要机械报菜名、不要原样复述这句话），再问一句“喂/在吗/听得到吗”之类的口语开场。`
            : `${sceneNoun}刚接通，请你先自然开场：可以问一句“喂/听得到吗/怎么啦”之类的口语，也可以顺着你们关系主动开启一个很短的话头。`)
          : mode === 'proactive'
                ? '这次没有新的用户发言。请像真实通话里自然接续一样，主动补充一个短话头、分享一点当下，或顺着刚才的话继续说；不要假装用户刚说了新内容。'
                : '把用户刚才连续说的几句话当成同一段通话内容来回应，不要机械地一句用户话只回一句。',
        callTurns ? `本次${sceneNoun}里刚刚说过：\n${callTurns}` : '',
        mode === 'reply' ? `用户这次通话转写：\n${currentUserText}` : '',
        callReplyDisplayMode === 'single'
          ? `回复要像${sceneNoun}里自然说出口的一段连续口语，不要为了字幕人为拆成多行或多个短段；内部句子仍按语义自然结束。`
          : `回复要像${sceneNoun}里自然说出口的话。按语气和停顿分成二到四个短句或短段，每段只承载一个气口，避免整段挤成大块；也不要把每几个字机械切开。`,
        callAiHangupEnabled && mode !== 'opening'
          ? '如果从角色意愿和当前语境看确实应该由你结束这通电话，在最后额外输出 [[END_CALL]]；否则绝对不要输出这个标记。'
          : '',
        currentCallMode === 'video' && videoStageDirections
          ? '视频画面动作按旁白式镜头段落来写，并跟着台词发生的先后自然穿插。只要本轮有可见反应，通常写 1～3 段，每段约 30～90 字：连续写清神态、视线、手上动作、姿势距离、镜头与身边环境的变化，形成一个完整的小过程；不要只写“笑了笑”“靠近镜头”这类几字动作标签，也不要堆无关布景。只能描述画面里真实可见的内容，不写角色内心，不替用户行动。每段必须独立放在一组全角括号里；括号动作只作为静音画面旁白，不会被读成语音。'
          : '',
        currentCallMode === 'video' && !videoStageDirections
          ? '不要输出视频动作、镜头描述或括号场景，只输出要说出口的话。'
          : '',
        callTranslation.active
          ? (callReplyDisplayMode === 'single'
            ? (isChineseDialectLanguageHint(callTranslation.language)
              ? `本轮整段口语必须用${callTranslation.language || '你设定里的中文方言'}说，不能改说普通话；先把整段方言自然说完，再在末尾只用一组全角〔〕给出整段的简体中文普通话（现代标准汉语）译文。不要逐句插译文，〔〕里不能复制方言原文或只做繁简转换。`
              : `本轮整段口语必须用${callTranslation.language || '你设定里的外语'}说，不能用中文；先把整段外语自然说完，再在末尾只用一组全角〔〕给出整段的简体中文普通话（现代标准汉语）翻译。不要逐句插译文，〔〕里只放中文翻译本身。`)
            : (isChineseDialectLanguageHint(callTranslation.language)
              ? `本轮要说的话必须整段用${callTranslation.language || '你设定里的中文方言'}说，不能改说普通话；每说完一个自然句/气口，紧跟着用全角〔〕就地标出这句的简体中文普通话（现代标准汉语）译文，例如：我而家返紧嚟〔我现在正在回来〕。方言即使全是汉字也不能漏标，〔〕里不能复制方言原文或只做繁简转换。`
              : `本轮要说的话必须整段用${callTranslation.language || '你设定里的外语'}说，不能用中文；每说完一个自然句/气口，紧跟着用全角〔〕就地标出这句的简体中文普通话（现代标准汉语）翻译，例如：I'll be there in ten minutes〔我十分钟后到〕. 〔〕里只放中文翻译本身，不要漏标任何一句外语。`))
          : '',
        callVoiceWorldBookPrompt
          ? callVoiceWorldBookPrompt
          : '',
        '上文若存在 capability_intent 能力目录，其单行 JSON 是客户端控制行，是“只写说出口的话”的唯一例外；不需要外部能力时绝对不要输出。',
        voiceConfig?.provider === 'fish'
          ? '只写真正说出口的词句；上面明确允许的视频画面动作除外，不要另写旁白或舞台动作。只有本轮确实需要表现一次换气、叹气、轻笑或特殊停顿时，才在真实发生位置加入最多一组方括号英文自然语言提示；不要输出 MiniMax 的 <#...#> 标签，不要每句添加效果，也不要为了模拟真人擅自加入“嗯、呃、咳”等填充音。'
          : '只写真正说出口的词句；上面明确允许的视频画面动作除外，不要另写旁白或舞台动作。只有本轮确实需要表现一次换气、叹气、笑或特殊停顿时，才允许加入最多一组 <#...#> / breath / sighs / laughs 等 MiniMax 标签；不要每句添加，不要为了模拟真人擅自加入“嗯、呃、咳”等填充音。',
      ].filter(Boolean).join('\n');
    };
    const generateCallReply = async (userText, options = {}) => {
      const controller = new AbortController();
      session.aiAbort = controller;
      const opening = options.opening === true;
      const requestMode = String(options.mode || (opening ? 'opening' : 'reply')).trim();
      const { buildChatContext } = await import('../core/context/build-chat-context.js');
      const capabilityIntentRuntime = await import('../core/capabilities/intent.js');
      const pendingCapabilityContinuation = await capabilityIntentRuntime
        .loadCapabilityContinuation(chatId)
        .catch(() => null);
      const built = await buildChatContext({
        chat,
        user,
        userId: user.id,
        // 本通电话的实时轮次由 callHistory 单独提供；不要再把尚未结束的通话卡
        // 作为普通聊天记录塞回模型，避免它学习并照抄内部通话气泡标签。
        messages: messages.filter((message) => message.id !== fresh.id),
        characters,
        contextDepth: chatPrefs?.contextDepth,
        sceneDirective: [
          buildCallSceneDirective(userText, requestMode),
          pendingCapabilityContinuation?.block || '',
        ].filter(Boolean).join('\n\n'),
        disableMcpCapabilityIntent: Boolean(pendingCapabilityContinuation?.id),
        includeUserVideoAvatarVision: currentCallMode === 'video',
        outputMode: 'call',
        callReplyDisplayMode,
      });
      const callApiOverride = await resolveChatMainApiOverride(chatId).catch(() => null);
      const callMaxTokens = await resolveGenerationMaxTokens(callApiOverride);
      let callCompletionMeta = {};
      let callRequestStat = null;
      let rawResponseEvidence = '';
      const appendRawResponseEvidence = (value = '') => {
        if (rawResponseEvidence.length >= 12000) return;
        rawResponseEvidence += String(value || '').slice(0, 12000 - rawResponseEvidence.length);
      };
      const requestOptions = {
        maxTokens: callMaxTokens,
        configOverride: callApiOverride || undefined,
        signal: controller.signal,
        onCompletionMeta: (meta) => { callCompletionMeta = { ...callCompletionMeta, ...(meta || {}) }; },
        onRequestStat: (stat) => { callRequestStat = { ...(stat || {}) }; },
        onRawResponse: (text) => { appendRawResponseEvidence(text); },
        onRawSseFragment: (fragment) => { appendRawResponseEvidence(fragment); },
      };
      const attachCallGenerationEvidence = (error, rawText = '') => {
        if (!error || typeof error !== 'object') return error;
        const visibleRaw = String(rawText || '').trim();
        error.rawText ||= visibleRaw;
        if (!visibleRaw && rawResponseEvidence.trim()) error.responseText ||= rawResponseEvidence.trim();
        else if (rawResponseEvidence.trim()) error.upstreamResponse ||= rawResponseEvidence.trim();
        error.upstreamMeta ||= callCompletionMeta;
        error.finishReason ||= callCompletionMeta.finishReason || callRequestStat?.finishReason || '';
        error.requestModel ||= callCompletionMeta.requestModel || callRequestStat?.requestModel || '';
        if (error.requestStream == null) error.requestStream = callRequestStat?.requestStream;
        error.streamStats ||= callRequestStat;
        return error;
      };
      const requestCallText = async (apiMessages) => {
        let streamed = '';
        const completed = await chatWithPreferredStream(apiMessages, (_delta, acc) => {
          streamed = typeof acc === 'string' ? acc : `${streamed}${String(_delta || '')}`;
        }, requestOptions);
        return String(streamed || completed || '').trim();
      };
      let raw = '';
      let capabilityContinuationId = String(pendingCapabilityContinuation?.id || '').trim();
      try {
        let callMessages = built.messages;
        raw = await requestCallText(callMessages);
        const capabilityRequest = pendingCapabilityContinuation
          ? null
          : capabilityIntentRuntime.extractCapabilityIntent(raw);
        if (capabilityRequest) {
          const spokenPrelude = capabilityIntentRuntime.stripCapabilityIntentEvents(raw).trim();
          const { prepareConversationCapabilityMessages } = await import('../core/capabilities/conversation.js');
          const { formatCapabilityFailure, formatCapabilityPlannerError } = await import('../core/capabilities/planner.js');
          const permissionContext = capabilityIntentRuntime.resolveCapabilityIntentPermissionContext(
            capabilityRequest,
            {
              foreground: requestMode === 'reply' && Boolean(String(userText || '').trim()),
              approvalHandler: (request) => openCapabilityApprovalModal(request, { signal: controller.signal }),
            },
          );
          const capabilityTurn = await prepareConversationCapabilityMessages({
            enabled: true,
            messages: built.messages,
            intentText: capabilityIntentRuntime.buildCapabilityIntentGoal(capabilityRequest),
            connectionHint: capabilityRequest.connection,
            context: currentCallMode,
            chatId,
            actorId: target.id,
            actorName: target.name,
            userInitiated: permissionContext.userInitiated,
            autonomousOnly: capabilityRequest.initiative === 'character',
            signal: controller.signal,
            approvalHandler: permissionContext.approvalHandler,
            onStatus: (status) => modal?.setStatusText?.(status),
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
          const continuationBlock = capabilityTurn.block || capabilityIntentRuntime.buildCapabilityUnavailableBlock(
            capabilityRequest,
            capabilityTurn.plannerError
              ? formatCapabilityPlannerError(capabilityTurn.plannerError)
              : '工具模型判断本次无需或无法调用',
          );
          const continuation = await capabilityIntentRuntime.saveCapabilityContinuation(chatId, {
            goal: capabilityRequest.goal,
            block: continuationBlock,
            checkout: capabilityTurn.checkout || null,
          }).catch(() => null);
          capabilityContinuationId = String(continuation?.id || '').trim();
          callMessages = capabilityTurn.block
            ? capabilityTurn.messages
            : built.messages.map((message, index) => (
              index === 0 && message?.role === 'system'
                ? { ...message, content: `${message.content}\n\n${continuationBlock}` }
                : message
            ));
          const continued = await requestCallText(callMessages);
          raw = [spokenPrelude, continued].filter(Boolean).join('\n');
        }
      } catch (err) {
        throw attachCallGenerationEvidence(err);
      }
      const shouldEnd = /\[\[\s*END_CALL\s*\]\]/i.test(raw);
      const controlledRaw = capabilityIntentRuntime.stripCapabilityIntentEvents(
        raw.replace(/\[\[\s*END_CALL\s*\]\]/gi, ''),
      ).trim();
      const normalized = normalizeVoiceCallReplyText(cleanCallReplyText(controlledRaw), {
        targetName: target.name,
        translationActive: callTranslation.active,
        translationLanguage: callTranslation.language,
        sentenceTranslationRequired: callReplyDisplayMode === 'segments',
        allowStageDirections: currentCallMode === 'video' && videoStageDirections,
      });
      if (!normalized.ok) {
        const parseReason = normalized.reason || '格式错误';
        const error = new Error(
          raw
            ? `模型已有返回，但未提取到可播放台词（解析原因：${parseReason}）；本轮未自动重发`
            : `接口请求已结束，但没有返回可用正文（解析原因：${parseReason}）；本轮未自动重发`,
        );
        error.voiceCallParseReason = parseReason;
        error.reason = raw ? 'validation-failed' : 'empty-api-response';
        error.emptyKind = raw
          ? ''
          : ((callCompletionMeta.reasoningText || Number(callCompletionMeta.reasoningTokens || 0) > 0)
            ? 'reasoning-only'
            : 'completed-empty');
        throw attachCallGenerationEvidence(error, raw);
      }
      if (capabilityContinuationId) {
        await capabilityIntentRuntime
          .clearCapabilityContinuation(chatId, capabilityContinuationId)
          .catch(() => false);
      }
      if (session.closed || !session.active) return { text: '', shouldEnd: false };
      return { text: normalized.text, shouldEnd };
    };
    const adoptCallMediaGesture = (gestureToken = null) => {
      if (!gestureToken) return false;
      session.pendingMediaGesture?.dispose?.();
      session.pendingMediaGesture = gestureToken;
      return true;
    };
    const runCallTtsQueue = async (replyText, { gestureToken = null } = {}) => {
      if (gestureToken) adoptCallMediaGesture(gestureToken);
      const mediaGesture = session.pendingMediaGesture;
      session.pendingMediaGesture = null;
      if (mediaGesture) {
        session.playSlot.gesture?.dispose?.();
        session.playSlot.gesture = mediaGesture;
        if (session.playSlot.audio) {
          try {
            session.playSlot.audio.pause();
            session.playSlot.audio.removeAttribute('src');
            session.playSlot.audio.load?.();
          } catch (_) {}
          session.playSlot.audio = null;
        }
      }
      if (currentCallMode === 'video') {
        void session.soundSession?.playExplicitCues?.(replyText).catch(() => {});
      }
      const characterId = target.id && target.id !== 'user' ? target.id : '';
      if (!voiceOutputEnabled || !characterId || session.closed || !session.active) {
        mediaGesture?.dispose?.();
        if (!session.closed && session.active) void ensureCallSound({ contextText: replyText }).catch(() => {});
        return;
      }
      const translationCheck = validateVoiceCallTranslationText(replyText, {
        translationActive: callTranslation.active,
        translationLanguage: callTranslation.language,
        allowStageDirections: currentCallMode === 'video' && videoStageDirections,
      });
      if (!translationCheck.ok) {
        mediaGesture?.dispose?.();
        showToast('这句外语翻译格式不完整，已拦截语音；可点重 roll 重新生成');
        return;
      }
      // 只朗读外语原文：〔中文翻译〕标记只用于前台点按查看，绝不能读出声。
      const spokenText = stripTranslationMarks(replyText).trim();
      if (!spokenText) {
        mediaGesture?.dispose?.();
        return;
      }
      const segments = buildCallTtsSegments(spokenText);
      if (!segments.length) {
        mediaGesture?.dispose?.();
        return;
      }
      const parentAudioId = buildCallLineAudioId(spokenText);
      const readyAudioIds = [];
      const token = (session.playbackToken += 1);
      try { session.ttsAbort?.abort?.(); } catch (_) {}
      let controller = new AbortController();
      session.ttsAbort = controller;
      void commandDuckVolume(0.2).catch(() => {});
      void session.soundSession?.setSpeechActive?.(true).catch(() => {});
      const playSlot = session.playSlot;
      let playFailure = '';
      let synthesisFailures = 0;
      let lastSynthesisError = null;
      let mediaSession = null;
      session.playbackBusy = true;
      try {
        if (session.closed || !session.active || token !== session.playbackToken) return;
        // 已有点击解锁的 loop 垫片时不要再开 AudioContext / 第二路静音，
        // iOS 上会把垫片打断，通话开场/回复等 TTS 回来后就播不出来。
        if (!playSlot.gesture && !playSlot.audio) await primeVoicePlayback().catch(() => {});
        for (let index = 0; index < segments.length; index += 1) {
          if (session.closed || !session.active || token !== session.playbackToken) return;
          const segment = segments[index];
          const audioId = segments.length === 1 ? parentAudioId : `${parentAudioId}_${index + 1}`;
          let audioPayload = null;
          for (let attempt = 1; attempt <= 2 && !audioPayload; attempt += 1) {
            try {
              audioPayload = await withTimeout(
                synthesizeCallLineVoice({
                  callId: fresh.id,
                  lineId: audioId,
                  text: segment,
                  characterId,
                  config: callVoiceConfig,
                  signal: controller.signal,
                }),
                30000,
                controller,
                '语音合成超时',
              );
            } catch (err) {
              const synthesisTimedOut = /语音合成超时|tts.*timeout/i.test(String(err?.message || err || ''));
              if ((isAbortLikeError(err) && !synthesisTimedOut) || session.closed || token !== session.playbackToken) throw err;
              if (attempt < 2 && shouldRetryCallTtsError(err)) {
                controller = new AbortController();
                session.ttsAbort = controller;
                continue;
              }
              synthesisFailures += 1;
              lastSynthesisError = err;
            }
          }
          if (session.closed || !session.active || token !== session.playbackToken) return;
          if (!audioPayload?.audioDataUrl && !(audioPayload?.audioBlob instanceof Blob)) continue;
          readyAudioIds.push(audioId);
          modal?.markAudioReady?.(parentAudioId, readyAudioIds);
          const playback = createVoicePlaybackUrl(audioPayload);
          try {
            mediaSession ||= beginForegroundMediaSession();
            // 手势给第一段成功拿到的 Audio，后续段复用同一元素；勿写死 index===0（首段跳过会整段无声）。
            const audio = takePlayableAudio(playback.url, playSlot);
            if (!audio) continue;
            audio.preload = 'auto';
            audio.setAttribute('playsinline', 'true');
            session.audio = audio;
            let playStarted = true;
            try {
              await playAudioWhenReady(audio, { timeoutMs: 15000 });
            } catch (playErr) {
              playStarted = false;
              const msg = String(playErr?.name || playErr?.message || playErr || '');
              playFailure ||= /NotAllowedError|not allowed|user didn't interact/i.test(msg)
                ? 'blocked'
                : 'media-error';
            }
            if (playStarted) {
              const durationMs = Number.isFinite(audio.duration) && audio.duration > 0
                ? Math.ceil(audio.duration * 1000) + 8000
                : 60000;
              const completion = await withTimeout(new Promise((resolve) => {
                audio.addEventListener('ended', () => resolve('ended'), { once: true });
                audio.addEventListener('error', () => resolve('media-error'), { once: true });
                audio.addEventListener('pause', () => resolve(audio.ended ? 'ended' : 'paused'), { once: true });
              }), Math.max(60000, durationMs), null, '语音播放超时').catch(() => {
                try {
                  audio.pause();
                  audio.currentTime = 0;
                } catch (_) {}
                return 'timeout';
              });
              if (completion !== 'ended') {
                playFailure ||= completion || 'media-error';
                if (completion === 'paused' || completion === 'timeout') break;
              }
            }
          } finally {
            playback.revoke?.();
          }
        }
      } finally {
        session.playbackBusy = false;
        mediaSession?.release?.();
        if (token === session.playbackToken) {
          void commandRestoreVolume().catch(() => {});
          void session.soundSession?.setSpeechActive?.(false).catch(() => {});
          // 首句和回复先占稳前台语音元素，再启动或更新环境音，避免移动端抢占解锁轨。
          void ensureCallSound({ contextText: replyText }).catch(() => {});
        }
      }
      if (playFailure && !session.closed && token === session.playbackToken) {
        const message = playFailure === 'blocked'
          ? '系统拦住了自动播放，请点这句话旁的重听'
          : playFailure === 'paused'
            ? '语音被其他音频打断，请点这句话旁的重听'
            : playFailure === 'timeout'
              ? '语音播放超时，请点这句话旁的重听'
              : '缓存音频无法播放，请点重听；仍失败时请清除该条缓存后重试';
        showToast(message);
        modal?.setStatusText?.(message);
      }
      if (synthesisFailures && !session.closed && token === session.playbackToken) {
        const message = `${synthesisFailures} 句语音合成失败，其余句子已继续播放`;
        showToast(message);
        modal?.setStatusText?.(message);
        reportCallTtsError(lastSynthesisError, '通话分句语音合成');
      }
    };
    const playCallTtsQueue = (replyText, playOptions = {}) => {
      const replaceExisting = playOptions.replaceExisting === true;
      if (replaceExisting) {
        session.playbackQueueGeneration += 1;
        session.playbackToken += 1;
        try { session.ttsAbort?.abort?.(); } catch (_) {}
        try { session.audio?.pause?.(); } catch (_) {}
      }
      const queueGeneration = session.playbackQueueGeneration;
      const queued = session.playbackChain
        .catch(() => {})
        .then(() => {
          if (queueGeneration !== session.playbackQueueGeneration) {
            playOptions.gestureToken?.dispose?.();
            return false;
          }
          return runCallTtsQueue(replyText, playOptions);
        });
      session.playbackChain = queued.catch(() => {});
      return queued;
    };
    let modal = null;
    const callSoundContext = (extra = '') => [
      fresh.metadata?.note,
      fresh.content,
      ...callHistory.slice(-12).map((item) => item.text),
      extra,
    ].map((value) => String(value || '').trim()).filter(Boolean).join('\n');
    const ensureCallSound = async ({ gestureTokens = session.ambienceGestures, contextText = '' } = {}) => {
      const tokens = Array.isArray(gestureTokens) ? gestureTokens.filter(Boolean) : [];
      if (gestureTokens === session.ambienceGestures) session.ambienceGestures = [];
      if (session.closed || !session.active) {
        tokens.forEach((token) => token?.dispose?.());
        return false;
      }
      if (!session.soundSession) {
        session.soundSession = createAutomaticSoundSession({
          ownerId: user.id,
          seed: fresh.id,
          ambienceVolume: 0.18,
          bgmVolume: 0.095,
          cueVolume: 0.4,
          allowBgm: true,
          fallbackScene: true,
        });
      }
      const categories = await session.soundSession.updateContext(
        callSoundContext(contextText),
        { gestureTokens: tokens },
      );
      return categories.length > 0;
    };
    const clearCallAutomationTimer = () => {
      if (session.proactiveTimer) clearTimeout(session.proactiveTimer);
      session.proactiveTimer = null;
    };
    const scheduleCallAutomation = (delayMs = 0) => {
      clearCallAutomationTimer();
      if (session.closed || !session.active || !callProactiveSpeechEnabled) return;
      const waitMs = delayMs > 0
        ? delayMs
        : callProactiveIntervalSeconds * 1000;
      session.proactiveTimer = setTimeout(() => { void runAutomatedCallTurn(); }, waitMs);
    };
    const endCallFromAi = async (reason = 'ai') => {
      if (session.closed || !session.active) return;
      await modal?.endCall?.({
        aiInitiated: true,
        endReason: reason,
      });
    };
    const runAutomatedCallTurn = async () => {
      clearCallAutomationTimer();
      if (session.closed || !session.active) return;
      if (session.automationBusy || session.replaying) {
        scheduleCallAutomation(5000);
        return;
      }
      session.automationBusy = true;
      modal?.setLoading?.(true, '对方想说点什么');
      try {
        const result = await generateCallReply('', { mode: 'proactive' });
        const reply = String(result?.text || '').trim();
        if (!reply || session.closed || !session.active) return;
        callHistory.push({ role: 'assistant', text: reply });
        modal?.addLine?.({ from: 'ai', text: reply });
        await playCallTtsQueue(reply);
        if (result.shouldEnd && callAiHangupEnabled) {
          await endCallFromAi('ai-choice');
          return;
        }
      } catch (err) {
        if (!isAbortLikeError(err) && !session.closed) console.warn('[voice-call] proactive turn failed', err);
      } finally {
        session.automationBusy = false;
        if (!session.closed) {
          modal?.setLoading?.(false);
          modal?.setStatusText?.(activeCallStatusText);
          scheduleCallAutomation();
        }
      }
    };
    sessionStorage.setItem(`activeVoiceCall:${chatId}`, fresh.id);
    modal = openVoiceCallModal({
      callKey: `${chatId}:${fresh.id}`,
      title: target.name,
      avatarHtml: target.avatarHtml,
      note: fresh.metadata?.note || fresh.content || '',
      state: modalState,
      startedAt: fresh.metadata?.acceptedAt || fresh.timestamp || Date.now(),
      mode: currentCallMode,
      replyDisplayMode: callReplyDisplayMode,
      characterId: target.id,
      voiceProfile,
      backgroundImage: videoBackground,
      userVisual: userVideoVisual,
      initialEntries: persistedCallEntries,
      getAudioId: voiceOutputEnabled ? (text) => buildCallLineAudioId(stripTranslationMarks(text)) : null,
      minimized: options.minimized === true,
      connecting: modalState === 'active'
        && options.skipOpening !== true
        && !fresh.metadata?.openingDone
        && !persistedCallEntries.length,
      enableChat: true,
      onEntriesChange: queueCallCheckpoint,
      onMediaGesture: adoptCallMediaGesture,
      onSendText: async (text, { gestureToken = null } = {}) => {
        const userText = String(text || '').trim();
        if (!userText || session.closed || !session.active) {
          gestureToken?.dispose?.();
          return '';
        }
        session.lastUserAt = Date.now();
        clearCallAutomationTimer();
        callHistory.push({ role: 'user', text: userText });
        let result = null;
        try {
          result = await generateCallReply(userText);
        } catch (err) {
          gestureToken?.dispose?.();
          if (!isAbortLikeError(err) && !session.closed) {
            showToast(`通话回复失败：${err?.message || err}`);
            reportCallTextError(err, '生成通话回复');
          }
          return '';
        }
        const reply = String(result?.text || '').trim();
        if (!reply || session.closed || !session.active) {
          gestureToken?.dispose?.();
          return '';
        }
        callHistory.push({ role: 'assistant', text: reply });
        void playCallTtsQueue(reply, { gestureToken }).catch((err) => {
          reportCallTtsError(err, '通话回复语音合成');
        }).finally(async () => {
          if (result?.shouldEnd && callAiHangupEnabled) await endCallFromAi('ai-choice');
          else scheduleCallAutomation();
        });
        return { text: reply };
      },
      onRerollLast: async ({ gestureToken = null } = {}) => {
        if (session.closed || !session.active) {
          gestureToken?.dispose?.();
          return '';
        }
        if (!callHistory.length || callHistory[callHistory.length - 1]?.role !== 'assistant') {
          gestureToken?.dispose?.();
          return '';
        }
        const backup = callHistory[callHistory.length - 1];
        callHistory.pop();
        session.playbackToken += 1;
        try { session.ttsAbort?.abort?.(); } catch (_) {}
        try { session.aiAbort?.abort?.(); } catch (_) {}
        try {
          if (session.audio) {
            session.audio.pause();
            session.audio.currentTime = 0;
          }
        } catch (_) {}
        session.audio = null;
        const lastUser = [...callHistory].reverse().find((item) => item.role === 'user');
        let result = null;
        try {
          result = lastUser
            ? await generateCallReply(lastUser.text)
            : await generateCallReply('', { opening: true });
        } catch (err) {
          gestureToken?.dispose?.();
          callHistory.push(backup);
          if (!isAbortLikeError(err) && !session.closed) {
            showToast(`通话重 roll 失败：${err?.message || err}`);
            reportCallTextError(err, '重 roll 通话回复');
          }
          return '';
        }
        const reply = String(result?.text || '').trim();
        if (!reply || session.closed || !session.active) {
          gestureToken?.dispose?.();
          callHistory.push(backup);
          return '';
        }
        callHistory.push({ role: 'assistant', text: reply });
        void playCallTtsQueue(reply, { gestureToken }).catch((err) => {
          reportCallTtsError(err, '重 roll 回复语音合成');
        });
        return { text: reply };
      },
      onReplayText: async (text, _line, { gestureToken = null } = {}) => {
        if (session.closed || !session.active || session.replaying) {
          gestureToken?.dispose?.();
          return false;
        }
        session.replaying = true;
        try {
          await playCallTtsQueue(String(text || '').trim(), { gestureToken, replaceExisting: true });
          return true;
        } catch (err) {
          reportCallTtsError(err, '通话语音重听');
          return false;
        } finally {
          session.replaying = false;
        }
      },
      onAccept: async ({ gestureToken = null, soundGestureTokens = [] } = {}) => {
        if (gestureToken) adoptCallMediaGesture(gestureToken);
        if (soundGestureTokens.length) {
          session.ambienceGestures.forEach((token) => token?.dispose?.());
          session.ambienceGestures = soundGestureTokens.filter(Boolean);
        }
        fresh = await persistVoiceCallPatch({
          callState: 'active',
          state: 'active',
          acceptedAt: fresh.metadata?.acceptedAt || Date.now(),
        });
        session.active = true;
        session.closed = false;
        session.lastUserAt = Date.now();
        scheduleCallAutomation();
        refreshMessages();
        // 从响铃页点接听时，开场不会在 open 时启动，这里补上。
        if (options.skipOpening !== true
          && !fresh.metadata?.openingDone
          && !persistedCallEntries.length
          && !session.openingStarted) {
          void runCallOpening();
        }
      },
      onDecline: async () => {
        stopCallCheckpoint();
        stopCallTasks();
        try {
          fresh = await persistVoiceCallPatch({ callState: 'declined', state: 'declined' });
          await saveVoiceCallRecordForMessage(fresh, { callState: 'declined' });
          sessionStorage.removeItem(`activeVoiceCall:${chatId}`);
          refreshMessages();
        } catch (err) {
          showToast(`通话记录保存失败：${err?.message || err}`);
          throw err;
        }
      },
      onEnd: async ({ durationLabel, durationMs, cancelled, ambienceMode, transcriptText, entries, aiInitiated, endReason }) => {
        stopCallCheckpoint();
        const automaticAmbienceMode = session.soundSession?.activeCategories?.().join(',') || 'off';
        stopCallTasks();
        const callState = cancelled ? 'cancelled' : 'ended';
        const summary = String(transcriptText || '').trim()
          || (callHistory.length
            ? callHistory.map((item) => `${item.role === 'user' ? '我' : target.name}：${item.text}`).join('\n')
            : '');
        // 气泡小卡只显示「已挂断 · 时长」；转写进 transcript/callSummary，不要再塞进 note（否则小卡会拉成一条长文）
        try {
          fresh = await persistVoiceCallPatch({
            callState,
            state: callState,
            duration: cancelled ? '' : (durationLabel || ''),
            durationMs: Number(durationMs || 0) || 0,
            ambienceMode: automaticAmbienceMode,
            transcript: String(transcriptText || '').trim() || summary,
            callEntries: Array.isArray(entries) ? entries : [],
            callSummary: summary,
            note: '',
            endedByAi: aiInitiated === true,
            endReason: String(endReason || '').trim(),
          });
          await saveVoiceCallRecordForMessage(fresh, {
            callState,
            durationLabel,
            durationMs,
            ambienceMode: automaticAmbienceMode,
            transcript: String(transcriptText || '').trim() || summary,
            callEntries: Array.isArray(entries) ? entries : [],
            callSummary: summary,
            note: '',
          });
          sessionStorage.removeItem(`activeVoiceCall:${chatId}`);
          refreshMessages();
        } catch (err) {
          showToast(`通话记录保存失败：${err?.message || err}`);
          throw err;
        }
      },
      onClose: stopCallTasks,
    });
    const runCallOpening = async ({ gestureToken = null } = {}) => {
      if (session.openingStarted || session.closed || !session.active) return;
      if (options.skipOpening === true || fresh.metadata?.openingDone || persistedCallEntries.length) return;
      if (gestureToken) adoptCallMediaGesture(gestureToken);
      session.openingStarted = true;
      modal?.setOpeningError?.('');
      modal?.setLoading?.(true, '接通中');
      modal?.setStatusText?.('接通中');
      let openingResult = null;
      let opener = '';
      let openingError = null;
      try {
        openingResult = await generateCallReply('', { opening: true });
        opener = String(openingResult?.text || '').trim();
      } catch (err) {
        openingError = err;
        if (!isAbortLikeError(err) && !session.closed) {
          showToast(`通话开场失败：${err?.message || err}`);
          reportCallTextError(err, '生成通话开场白');
        }
      }
      if (!opener || session.closed || !session.active) {
        session.pendingMediaGesture?.dispose?.();
        session.pendingMediaGesture = null;
        modal?.setLoading?.(false);
        modal?.setStatusText?.(activeCallStatusText);
        if (!session.closed && session.active && !isAbortLikeError(openingError)) {
          session.openingStarted = false;
          modal?.setOpeningError?.(
            '开场白生成失败：模型未返回可用台词，请点「重 roll」重试。',
            (retryOptions = {}) => runCallOpening(retryOptions),
          );
        }
        return false;
      }
      callHistory.push({ role: 'assistant', text: opener });
      modal?.addLine?.({ from: 'ai', text: opener });
      modal?.setStatusText?.(activeCallStatusText);
      modal?.setLoading?.(false);
      void playCallTtsQueue(opener).catch((err) => {
        reportCallTtsError(err, '通话开场语音合成');
      }).finally(async () => {
        if (!session.closed) modal?.setStatusText?.(activeCallStatusText);
        try {
          fresh = await persistVoiceCallPatch({
            openingDone: true,
            note: opener || fresh.metadata?.note || fresh.content || '',
          });
        } catch (_) {
          /* ignore */
        }
        scheduleCallAutomation();
      });
      return true;
    };
    session.openingStarted = false;
    const shouldPlayOpening = modalState === 'active'
      && options.skipOpening !== true
      && !fresh.metadata?.openingDone
      && !persistedCallEntries.length;
    if (shouldPlayOpening) void runCallOpening();
    if (modalState === 'active' && !shouldPlayOpening) {
      void ensureCallSound().catch(() => {});
      scheduleCallAutomation();
    }
    return modal;
  }

  async function startOutgoingVoiceCall(note = '', mode = 'voice', gestureToken = null, callOptions = {}) {
    const cleanNote = String(note || '').trim();
    const callMode = mode === 'video' ? 'video' : 'voice';
    const acceptedAt = Date.now();
    const msg = createMessage({
      chatId,
      senderId: 'user',
      senderName: frontStageUserName(),
      type: 'voiceCall',
      content: cleanNote || (callMode === 'video' ? '视频通话' : '语音通话'),
      timestamp: await getNowForUser(user.id),
      metadata: {
        title: callMode === 'video' ? '视频通话' : '语音通话',
        note: cleanNote,
        callState: 'active',
        state: 'active',
        callMode,
        acceptedAt,
        targetId: partnerId || '',
      },
    });
    replyTarget = null;
    refreshReplyBar();
    await persistUserMessage(msg);
    return openVoiceCallFromMessage(msg, {
      answerNow: true,
      gestureToken,
      ambienceGestureTokens: Array.isArray(callOptions.ambienceGestureTokens)
        ? callOptions.ambienceGestureTokens
        : [],
    });
  }

  function openPaySheet(kind) {
    const host = document.getElementById('modal-container');
    if (!host) return;
    const isPacket = kind === 'redpacket';
    const groupPacket = isPacket && isGroup;
    const title = isPacket ? (groupPacket ? '发群红包' : '发红包') : '转账';
    const amountLabel = groupPacket ? '总金额' : '金额';
    const defaultGreeting = isPacket ? '恭喜发财' : '';
    const payAnonClass = anonShell ? ' pay-sheet--anon anon-modal-sheet' : '';
    host.classList.add('active');
    host.innerHTML = `
      <div class="modal-overlay modal-sheet-center pay-sheet-overlay${anonShell ? ' pay-sheet-overlay--anon' : ''}" data-pay-overlay>
        <form class="modal-sheet pay-sheet${payAnonClass}" data-pay-form>
          <header class="pay-sheet-head ${isPacket ? 'is-redpacket' : 'is-transfer'}">
            <button type="button" class="navbar-btn pay-sheet-close" data-pay-close aria-label="关闭">${icon('back')}</button>
            <div>
              <div class="pay-sheet-kicker">${isPacket ? '棉花糖红包' : '棉花糖转账'}</div>
              <h3>${esc(title)}</h3>
            </div>
          </header>
          <div class="modal-body pay-sheet-body">
            <label class="pay-field pay-field-amount">
              <span>${esc(amountLabel)}</span>
              <div class="pay-amount-line"><em>¥</em><input class="pay-input pay-amount-input" name="amount" inputmode="decimal" value="${isPacket ? (groupPacket ? '8.88' : '6.66') : '18.80'}" /></div>
            </label>
            ${groupPacket ? `
              <label class="pay-field">
                <span>红包个数</span>
                <input class="pay-input" name="count" inputmode="numeric" placeholder="1~100，默认 1" value="1" />
                <span class="pay-field-hint">2 个及以上为拼手气红包</span>
              </label>
            ` : ''}
            ${isPacket ? `
              <label class="pay-field">
                <span>祝福语</span>
                <input class="pay-input" name="greeting" value="${esc(defaultGreeting)}" />
              </label>
            ` : `
              <label class="pay-field">
                <span>备注</span>
                <input class="pay-input" name="note" placeholder="可不填" />
              </label>
            `}
          </div>
          <footer class="pay-sheet-foot">
            <button type="submit" class="btn btn-primary pay-sheet-submit">${isPacket ? '塞进红包' : '确认转账'}</button>
          </footer>
        </form>
      </div>
    `;
    const close = () => {
      host.classList.remove('active');
      host.innerHTML = '';
    };
    host.querySelector('[data-pay-overlay]')?.addEventListener('click', close);
    host.querySelector('[data-pay-close]')?.addEventListener('click', close);
    host.querySelector('[data-pay-form]')?.addEventListener('click', (e) => e.stopPropagation());
    host.querySelector('[data-pay-form]')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const data = new FormData(e.currentTarget);
      const amount = normalizeMoney(data.get('amount'), isPacket ? '6.66' : '18.80');
      if (isPacket) {
        const greeting = String(data.get('greeting') || '恭喜发财').trim() || '恭喜发财';
        const count = groupPacket ? normalizeCount(data.get('count'), 1) : '1';
        close();
        await sendTypedMessage('redpacket', greeting, buildRedPacketSendMetadata({
          amount,
          count,
          greeting,
          isGroup: groupPacket,
        }));
        return;
      }
      const note = String(data.get('note') || '').trim();
      close();
      await sendTypedMessage('transfer', note || `¥${amount}`, {
        title: '转账',
        amount,
        transferNote: note,
        transferState: 'pending',
      });
    });
    host.querySelector('.pay-amount-input')?.focus();
  }

  function openOrderGiftSheet() {
    const host = document.getElementById('modal-container');
    if (!host) return;
    const giftForName = !isGroup && partnerId
      ? resolveUiActorName(partnerId, partner?.name || partner?.customNickname || partnerId || '对方')
      : '';
    const sheetAnonClass = anonShell ? ' pay-sheet--anon anon-modal-sheet' : '';
    host.classList.add('active');
    host.innerHTML = `
      <div class="modal-overlay modal-sheet-center pay-sheet-overlay${anonShell ? ' pay-sheet-overlay--anon' : ''}" data-order-gift-overlay>
        <form class="modal-sheet pay-sheet${sheetAnonClass}" data-order-gift-form>
          <header class="pay-sheet-head is-transfer">
            <button type="button" class="navbar-btn pay-sheet-close" data-order-gift-close aria-label="关闭">${icon('back')}</button>
            <div>
              <div class="pay-sheet-kicker">购物礼物</div>
              <h3>${giftForName ? `送给 ${esc(giftForName)}` : '送礼物'}</h3>
            </div>
          </header>
          <div class="modal-body pay-sheet-body">
            <label class="pay-field">
              <span>商品名</span>
              <input class="pay-input" name="title" placeholder="例如：绝版手办" required />
            </label>
            <label class="pay-field pay-field-amount">
              <span>价格</span>
              <div class="pay-amount-line"><em>¥</em><input class="pay-input pay-amount-input" name="price" inputmode="decimal" placeholder="可不填" /></div>
            </label>
            <label class="pay-field">
              <span>备注</span>
              <input class="pay-input" name="note" placeholder="例如：生日惊喜 / 配色偏好" />
            </label>
          </div>
          <footer class="pay-sheet-foot">
            <button type="submit" class="btn btn-primary pay-sheet-submit">发送礼物卡</button>
          </footer>
        </form>
      </div>
    `;
    const close = () => {
      host.classList.remove('active');
      host.innerHTML = '';
    };
    host.querySelector('[data-order-gift-overlay]')?.addEventListener('click', close);
    host.querySelector('[data-order-gift-close]')?.addEventListener('click', close);
    host.querySelector('[data-order-gift-form]')?.addEventListener('click', (e) => e.stopPropagation());
    host.querySelector('[data-order-gift-form]')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const data = new FormData(e.currentTarget);
      const title = String(data.get('title') || '').trim();
      if (!title) {
        showToast('请填写商品名');
        return;
      }
      const price = normalizeOrderSharePrice(data.get('price'));
      const note = String(data.get('note') || '').trim();
      const metadata = {
        productTitle: title,
        orderTitle: title,
        orderPrice: price,
        price,
        orderNote: note,
        note,
        platform: '礼物',
        orderPlatform: '礼物',
        giftDirection: 'user_to_char',
      };
      if (giftForName) {
        metadata.giftForName = giftForName;
        if (partnerId) metadata.giftForCharacterId = partnerId;
      }
      close();
      await sendTypedMessage('orderShare', buildOrderShareMessageContent(metadata), metadata);
    });
    host.querySelector('[name="title"]')?.focus();
  }

  function userHasVisibleSpeech() {
    return messages.some((m) => {
      if (!m || m.deleted || m.recalled) return false;
      if (m.senderId !== 'user') return false;
      if (m.type === 'system') return false;
      if (m.metadata?.anonymousSeed || m.metadata?.roomJoinNotice) return false;
      return true;
    });
  }

  function lastVisibleMessageTimestamp() {
    let last = 0;
    for (const m of messages) {
      if (!m || m.deleted || m.recalled || m.senderId === 'system') continue;
      const ts = Number(m.timestamp || 0);
      if (ts > last) last = ts;
    }
    return last;
  }

  function getRerollTargetFromMessages(allMessages = []) {
    // 退出指导后要重写的是最后一轮正常扮演，不是刚刚隐藏的本体指导回复。
    const rerollCandidates = chatPrefs.guidanceMode === true
      ? allMessages
      : allMessages.filter((message) => !isGuidanceMessage(message));
    const generatedTarget = getLastAiRerollTarget(rerollCandidates);
    if (generatedTarget) {
      return {
        aiRoundId: generatedTarget.roundIds[generatedTarget.roundIds.length - 1] || '',
        aiRoundIds: generatedTarget.roundIds,
        rerollRootId: generatedTarget.rootId,
        roundKind: generatedTarget.roundKind,
        gapFillWindow: generatedTarget.gapFillWindow,
        legacyMessageIds: [],
        backupMessages: generatedTarget.messages,
      };
    }
    if (!isBackstageChat(chat)) return null;

    const visible = allMessages
      .filter((m) => m && !m.deleted && !m.recalled && m.senderId !== 'system' && m.type !== 'system')
      .sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0));
    const last = visible[visible.length - 1];
    // 旧版从其它窗口写入秘密基地的消息没有 aiRoundId，只能按同批消息的紧邻时间戳回溯。
    if (!last?.metadata?.backstage || last.metadata?.aiRoundId) return null;

    const ids = [last.id].filter(Boolean);
    const parentChatId = String(last.metadata?.parentChatId || '').trim();
    let nextTs = Number(last.timestamp || 0);
    for (let i = visible.length - 2; i >= 0; i -= 1) {
      const candidate = visible[i];
      const candidateParent = String(candidate?.metadata?.parentChatId || '').trim();
      const candidateTs = Number(candidate?.timestamp || 0);
      if (!candidate?.metadata?.backstage || candidate.metadata?.aiRoundId) break;
      if (parentChatId && candidateParent && candidateParent !== parentChatId) break;
      if (!candidateTs || !nextTs || nextTs - candidateTs > 12000) break;
      if (candidate.id) ids.unshift(candidate.id);
      nextTs = candidateTs;
    }
    return ids.length
      ? { aiRoundId: '', legacyMessageIds: ids, backupMessages: visible.filter((m) => ids.includes(m.id)) }
      : null;
  }

  async function getLastRerollTarget() {
    // 当前页面通常只保留最近 100 条；闲聊补充还会把新生成气泡回填到历史时间。
    // 必须读完整会话并按轮次生成时间选目标，不能按当前 DOM/气泡 timestamp 的末尾判断。
    return getRerollTargetFromMessages(await listMessagesForChat(chatId, 0));
  }

  function setRerollTargetUiHidden(target, { replace = false } = {}) {
    if (replace) {
      rerollUiHiddenMessageIds.clear();
      rerollUiHiddenRoundIds.clear();
    }
    const beforeSize = rerollUiHiddenMessageIds.size + rerollUiHiddenRoundIds.size;
    const targetMessages = [
      ...(Array.isArray(target?.messages) ? target.messages : []),
      ...(Array.isArray(target?.backupMessages) ? target.backupMessages : []),
    ];
    targetMessages.forEach((message) => {
      const id = String(message?.id || '').trim();
      const roundId = String(message?.metadata?.aiRoundId || '').trim();
      if (id) rerollUiHiddenMessageIds.add(id);
      if (roundId) rerollUiHiddenRoundIds.add(roundId);
    });
    (Array.isArray(target?.legacyMessageIds) ? target.legacyMessageIds : []).forEach((id) => {
      const normalized = String(id || '').trim();
      if (normalized) rerollUiHiddenMessageIds.add(normalized);
    });
    (Array.isArray(target?.aiRoundIds) ? target.aiRoundIds : [target?.aiRoundId]).forEach((roundId) => {
      const normalized = String(roundId || '').trim();
      if (normalized) rerollUiHiddenRoundIds.add(normalized);
    });
    return rerollUiHiddenMessageIds.size + rerollUiHiddenRoundIds.size > beforeSize;
  }

  function clearRerollTargetUiHidden() {
    const changed = rerollUiHiddenMessageIds.size > 0 || rerollUiHiddenRoundIds.size > 0;
    rerollUiHiddenMessageIds.clear();
    rerollUiHiddenRoundIds.clear();
    return changed;
  }

  async function removeRerollTarget(target, { skipPsychologicalRewind = false } = {}) {
    const roundIds = Array.isArray(target?.aiRoundIds) && target.aiRoundIds.length
      ? target.aiRoundIds
      : [target?.aiRoundId].filter(Boolean);
    if (roundIds.length) {
      for (const roundId of roundIds) {
        await deleteMessagesWithAiRoundId(chatId, roundId, {
          deleteSystem: true,
          skipPsychologicalRewind,
        });
      }
    } else {
      for (const id of target?.legacyMessageIds || []) {
        await deleteMessage(id);
      }
    }
    // 跨窗副作用（幕后群/角色私聊/转发）不在当前 chatId；按来源轮次级联清掉，
    // 否则每次重 roll 都会在侧窗叠一批旧输出。
    return deleteAiRoundCascadeArtifacts(user.id, roundIds, { keepChatIds: [chatId] });
  }

  // 角色间会话（peer_private / 无 user 的幕后群）里点推进/补记录时，
  // 必须先把「这扇窗里根本没有用户」说死，否则模型很容易把最近上下文当成在和用户续聊。
  function peerWindowDirective() {
    const memberIds = (chat.participants || []).filter((id) => id && id !== 'user');
    if ((chat.participants || []).includes('user') || memberIds.length < 2) return '';
    if (!observerLike && !fromCharacterPhone) return '';
    const userName = fromCharacterPhone ? '用户身份' : frontStageUserName();
    const memberNames = memberIds.map((id) => resolveUiActorName(id, id));
    const hasUserPhoneProxy = messages.some((message) => message?.metadata?.phoneProxyByUser === true);
    const sceneLabel = isGroup
      ? `群「${String(chat.groupSettings?.name || title || '群聊').trim()}」里 ${memberNames.join('、')} 的内部群聊`
      : `${memberNames.join(' 和 ')} 两人的私聊窗`;
    const viewerLine = fromCharacterPhone
      ? `你正生成 ${resolveUiActorName(phoneViewerId, 'TA')} 手机里这扇窗接下来的消息。`
      : '';
    const interceptLine = String(chat?.metadata?.phoneChannel || '') === 'intercept'
      ? '这是手机拦截箱/陌生人过滤里的会话：继续写窗内两人的往来即可；不要跨窗找用户私聊，不要新建群或把纠缠扩散到别的窗口。'
      : '';
    // 手机侧窗（不含与用户的窗）：一轮推进要写出双方来回，而不是单人连发几条就收工。
    const dualExchangeLine = fromCharacterPhone
      ? (isGroup
        ? `【手机侧窗 · 双方往来】本轮必须生成一段多人抛接的公屏消息流：至少让 2 个不同成员发言，合计约 6～12 条短气泡，形成至少 2～3 轮来回（A 说→B 接→A/C 再接）。禁止整轮只有一个人连发；禁止每人整齐交一份作业式各说一句。`
        : `【手机侧窗 · 双方往来】本轮必须生成 ${memberNames.join(' 与 ')} 的来回对话：两人轮流/交错发言，合计约 6～12 条短气泡，形成至少 2～3 轮你来我往（例如 A1→B1→A2→B2…）。禁止整轮只有一方连发、另一方整轮沉默；同一个人可以连发 1～2 条碎气泡，但另一人必须在同轮内接上。`)
      : '';
    return [
      hasUserPhoneProxy
        ? `【角色间会话】这是 ${sceneLabel}，${userName}（用户）不是本窗口成员；只有历史中明确标为「手机代发事实」的气泡，是用户曾拿手机主人设备实际操作，除此之外用户不会在这里发言。`
        : `【角色间会话】这是 ${sceneLabel}，${userName}（用户）不在这扇窗里，也不会看到或回复这里的消息。`,
      '系统附带的其他群名、chatId、成员表和“主用户是否在群”都只是写入路由，不是窗内角色新查到的剧情事实。只承认可见消息与既有设定；禁止说自己发现了后台群、另一个同名群或一扇自己不在的群，也不要复述任何路由字段。',
      viewerLine,
      interceptLine,
      dualExchangeLine,
      `只生成 ${memberNames.join('、')} 接下来真实发送的消息：禁止把任何一方当成 ${userName}，禁止替 ${userName} 新增发言；历史代发气泡按其结构化察觉结果继续演绎，不得擅自改判。察觉结果只是幕后边界，不是本轮中心任务：禁止复述“某人不会把自己说成第三人”“这不是本人在打字”等推理过程；优先回应代发正文的具体话题和情绪，除非正文确实在谈身份，否则不要套用“用户在我这里”“别来找用户”或同义句。`,
      `关于 ${userName}：可以偶尔提一句名字或随口问一句，但禁止虚构 ${userName} 未在资料/主窗里出现过的经历、行程、对话或交集；有人追问近况时用含糊/拒绝/转移话题，不要编造。优先写窗内角色自己的事。`,
      '话题围绕成员当前身份对应的生活圈、日常事务与共同关系展开；学生优先课程、同学、宿舍或社团，明确在职时才自然涉及工作。不要因为角色是成年人就默认生成公司、上司或客户；输出继续走棉花糖短气泡（一条 msg 一个点）。',
    ].filter(Boolean).join('\n');
  }

  function sceneDirectiveForMode(mode, {
    nowTs = Date.now(),
    manualTimeAware = false,
    rerollOriginalTs = 0,
  } = {}) {
    const userName = frontStageUserName();
    const peerBlock = peerWindowDirective();
    if (mode === 'gap-fill' || mode === 'gap') {
      const lastTs = lastVisibleMessageTimestamp();
      const gapMs = lastTs ? Math.max(0, nowTs - lastTs) : 0;
      const gapContent = buildGapFillSceneMessage(chat, userName, {
        gapMs,
        recentBeat: buildRecentBeatSummary(messages),
        userPresent: isUserPresentInChat(chat),
      }).content;
      return peerBlock ? `${peerBlock}\n${gapContent}` : gapContent;
    }
    let directive = buildAdvanceSceneMessage(chat, userName, {
      recentBeat: buildRecentBeatSummary(messages),
      userPresent: isUserPresentInChat(chat),
    }).content;
    if (peerBlock) directive = `${peerBlock}\n${directive}`;
    if (anonymousChat) {
      const advanceExtra = buildAnonymousAdvanceDirective(chat, userName, {
        userHasSpoken: userHasVisibleSpeech(),
        currentUserName,
        userRow: user,
        spaceProfile: anonSpaceProfile,
      });
      if (advanceExtra) directive = `${advanceExtra}\n${directive}`;
    }
    if (manualTimeAware) {
      const timeAnchor = buildManualTurnTimeAnchor({
        mode: rerollOriginalTs > 0 ? 'reroll' : 'advance',
        nowTs,
        originalRoundTs: rerollOriginalTs,
        lastMessage: getLastVisibleConversationMessage(messages),
      });
      if (timeAnchor) directive = `${directive}\n${timeAnchor}`;
    }
    if (isGroup) {
      const turn = Number(chat.metadata?.groupAiTurn || 0);
      const speakerId = pickGroupSpeaker(chat, turn);
      if (!speakerId) return directive;
      const speakerName = getAnonymousDisplayProfile(chat, speakerId, {
        currentUserName,
        spaceProfile: anonSpaceProfile,
      })?.anonymousId
        || characters[speakerId]?.name
        || speakerId;
      if (fromCharacterPhone) {
        return `${directive}\n可由 ${speakerName} 先开口带动节奏，但本轮必须继续写成多人来回，不要停在单人连发。`;
      }
      return `${directive}\n本回合优先由 ${speakerName} 接话或带动节奏。`;
    }
    return directive;
  }

  // 真人感自动接话轮的场景引导：替换「推进」语义，降低信息密度、专注闲聊本身。
  function realPersonChatterDirective() {
    const peerBlock = peerWindowDirective();
    const content = buildRealPersonChatterSceneMessage(chat, frontStageUserName(), {
      presenceFast: autoReplyPresenceFast,
      dialoguePresentation: chatPrefs.dialoguePresentationMode === true,
    }).content;
    const freshnessBlock = buildRealPersonReplyFreshnessBlock(messages);
    return [peerBlock, content, freshnessBlock].filter(Boolean).join('\n');
  }

  // 真人感追发轮的场景引导：用户没回话时 AI 自己决定要不要再开口。
  function realPersonChaseDirective() {
    const peerBlock = peerWindowDirective();
    const content = buildRealPersonChaseSceneMessage(chat, frontStageUserName(), {
      chaseCount: Math.max(0, chaseCount - 1),
      dialoguePresentation: chatPrefs.dialoguePresentationMode === true,
    }).content;
    return peerBlock ? `${peerBlock}\n${content}` : content;
  }

  // AI 一轮解析/落库都已经在别处一次性完成了，这里只找出这一轮新增的消息 id，
  // 好让 refreshMessages 知道该给谁按顺序播「一个个出现」的效果。
  function newMessageIdsSince(beforeIds) {
    return messages
      .filter((m) => m && !beforeIds.has(m.id) && !isHiddenFromChatUi(m))
      .map((m) => m.id);
  }

  async function runStreamerFanGroupAiReply(userMessage = '', mode = 'advance') {
    if (isStreaming || getChatStreamSession(chatId)) return;
    const latest = await getChat(chatId).catch(() => chat);
    if (isAllMutedGroup(latest)) {
      chat = latest;
      showToast('本群正在全员禁言');
      return;
    }
    clearChatError();
    streamingPreviewPaintedThisTurn = false;
    streamingPreviewFirstPaintAt = 0;
    clearStreamingMessagePreview();
    setBusy(true);
    const paintLease = beginLocalRoundPaint();
    beginFollowingLatestMessages();
    try {
      const previewTs = await getNowForUser(user.id);
      await updateChatPreview(chatId, CHAT_STREAM_PREVIEW, previewTs);
    } catch (_) { /* ignore */ }
    refreshMessages(true);
    pinThreadForActiveStream();
    let newMessageIds = [];
    try {
      if (mode === 'reroll' || mode === 'rerollTopic') {
        const rid = getLastAiRoundId(messages);
        if (!rid) {
          showToast('没有可重 roll 的内容');
          return;
        }
        await deleteMessagesWithAiRoundId(chatId, rid, { deleteSystem: true });
        messages = await listThreadMessages();
        refreshMessages(true);
      }
      const beforeIds = new Set(messages.map((m) => m.id));
      await runStreamerFanGroupRound(user.id, chat, { userMessage });
      messages = await listThreadMessages();
      newMessageIds = newMessageIdsSince(beforeIds);
      chat = await getChat(chatId);
      await refreshHeaderStatus();
      if (newMessageIds.length) {
        notifyManualGenerationIfAwayFromChat({
          ok: true,
          messageCount: newMessageIds.length,
        }).catch(() => {});
      }
    } catch (err) {
      showToast(err?.message || '粉丝群没刷起来，稍后再试', 3500);
    } finally {
      setBusy(false);
      try { await recalcChatPreview(chatId); } catch (_) { /* ignore */ }
      if (isCurrentLocalRoundPaint(paintLease)) {
        refreshMessages(false, { revealIds: revealIdsForPaint(newMessageIds) });
      }
      endLocalRoundPaint();
      refreshActionArea();
    }
  }

  async function runAiReply(mode = 'advance', {
    event = null,
    sceneDirectiveOverride = '',
    realPersonChatter = false,
    realPersonChase = false,
    manualRequest = false,
    requestController = null,
    deliveryGuard = null,
    onModelRequestAttempted = null,
    settleWithoutReplay = false,
    forcedLinkVisionMessageId = '',
    generationTaskId = '',
    generationIdempotencyKey = '',
    generationAiRoundId = '',
    generationPreviousTaskId = '',
    generationStartedAt: resumedGenerationStartedAt = 0,
  } = {}) {
    if (requestController?.signal?.aborted) return;
    if (isStreaming || getChatStreamSession(chatId)) return;
    if ((realPersonChatter || realPersonChase) && isChatStreamPendingAnywhere(chatId)) return;
    const durableManualAdvance = manualRequest === true && mode === 'advance';
    const rerollMode = mode === 'reroll' || mode === 'rerollTopic';
    let rerollUiRollbackOwned = false;
    let rerollUiHiddenStartedAt = 0;
    let ownedRequestIntent = null;
    let contextPrewarmEnabled = false;
    let contextPrewarmKey = '';
    let modelRequestAttempted = false;
    let latestRoundResult = null;
    let stableGenerationIdentity = null;
    let stableGenerationAiRoundId = '';
    let stableGenerationStartedAt = 0;
    let preflightTaskId = '';
    let preflightController = null;
    let generationExecutionLease = null;
    let paintLease = 0;
    if (!requestController) {
      ownedRequestIntent = manualGenerationGate.claim(mode);
      if (!ownedRequestIntent) return;
      requestController = ownedRequestIntent.controller;
      setBusy(false);
    }
    try {
    if (rerollMode) {
      // 当前内存已经足够识别绝大多数最新轮次；在首次 await 前先隐藏它。
      // 完整会话稍后仍会重新核对，历史补充/分页等特殊目标不会因此选错。
      const immediateTarget = getRerollTargetFromMessages(messages);
      if (immediateTarget && setRerollTargetUiHidden(immediateTarget, { replace: true })) {
        rerollUiHiddenStartedAt = Date.now();
        beginFollowingLatestMessages();
        refreshMessages(true);
      }
    }
    generationExecutionLease = await acquireGenerationExecutionLock(chatId);
    if (!generationExecutionLease && manualRequest && isHeadlessChatReplyRunning(chatId)) {
      abortHeadlessChatReply(chatId, 'manual-takeover');
      await waitForHeadlessChatReplyIdle(chatId, 5000);
      generationExecutionLease = await acquireGenerationExecutionLock(chatId);
    }
    if (!generationExecutionLease) {
      if (manualRequest) showToast('此会话正在其他页面生成，本轮未重复调用', 4000);
      return;
    }
    if (durableManualAdvance) {
      // 后台回复可能已经写入 messages，但当前页恰好错过了可见事件。此时推进键的
      // 第一次点击只应把既有回复对账出来；若直接继续生成，旧回复与新回复会在
      // 下一次整表刷新时同时弹出，看起来像一次推进返回了两轮。
      const latestStoredMessages = await listMessagesForChat(chatId, 1).catch(() => []);
      const latestStoredMessage = latestStoredMessages[latestStoredMessages.length - 1] || null;
      const latestStoredId = String(latestStoredMessage?.id || '').trim();
      const unseenPersistedReply = latestStoredId
        && isCharacterConversationMessage(latestStoredMessage)
        && !messages.some((message) => String(message?.id || '') === latestStoredId);
      if (unseenPersistedReply) {
        messages = await listThreadMessages().catch(() => (
          [...messages, latestStoredMessage].sort(compareChatMessageChronology)
        ));
        visibleMessageLimit = Math.max(visibleMessageLimit, messages.length);
        pendingMessagesRefreshOnResume = false;
        beginFollowingLatestMessages();
        refreshMessages(false, { revealIds: revealIdsForPaint([latestStoredId]) });
        setStreamingPlaceholderVisible(false);
        setBusy(false);
        showToast('刚才的回复已生成，已为你显示', 2600);
        return;
      }
    }
    // 手动推进的第一条 await 之前，先把稳定身份和消息锚点写入 localStorage。
    // 若存储不可用或另一标签页仍持有新鲜心跳，本轮在这里同步停止，绝不先构建
    // 上下文、更不会让用户切后台后留下“看似发送、实际没请求”的悬空状态。
    if (durableManualAdvance) {
      const unanswered = getUnansweredRealUserMessage(messages);
      const messageIdentity = unanswered?.metadata || {};
      const messageTaskId = String(messageIdentity.generationTaskId || '').trim();
      const messageIdempotencyKey = String(messageIdentity.generationIdempotencyKey || '').trim();
      const messageHasPair = !!(messageTaskId && messageIdempotencyKey);
      const hasResumedPair = !!(
        String(generationTaskId || '').trim()
        && String(generationIdempotencyKey || '').trim()
      );
      const pendingEvidence = getPendingChatStreamRecord(chatId);
      const pendingEvidenceSafe = (pendingEvidence?.phase === 'preparing' || pendingEvidence?.phase === 'ready')
        && Number(pendingEvidence?.attempt || 0) === 0
        && Number(pendingEvidence?.dispatchStartedAt || 0) <= 0
        && Number(pendingEvidence?.requestStartedAt || 0) <= 0;
      const messageIdentityKnownUnsafe = !!(
        messageTaskId
        && (
          unsafeInterruptedGenerationTaskIds.has(messageTaskId)
          || (
            String(pendingEvidence?.taskId || '').trim() === messageTaskId
            && !pendingEvidenceSafe
          )
        )
      );
      // 用户亲手点击推进已经是一次明确的新调用意图。若旧请求越过提交边界，
      // 直接换一组 task/idempotency 身份；不再额外弹一次内部计费确认。
      const reuseMessageIdentity = !hasResumedPair && messageHasPair && !messageIdentityKnownUnsafe;
      let manualRetryPreviousTaskId = String(generationPreviousTaskId || '').trim()
        || (!hasResumedPair && messageHasPair && !reuseMessageIdentity ? messageTaskId : '');
      stableGenerationIdentity = makeStableReplyGenerationIdentity({
        ...(reuseMessageIdentity ? messageIdentity : {}),
        ...(hasResumedPair ? {
          generationTaskId,
          generationIdempotencyKey,
        } : {}),
        generationAiRoundId: String(generationAiRoundId || '').trim()
          || (reuseMessageIdentity ? String(messageIdentity.generationAiRoundId || '').trim() : ''),
      });
      stableGenerationAiRoundId = stableGenerationIdentity.aiRoundId;
      stableGenerationStartedAt = Number(resumedGenerationStartedAt || 0) || Date.now();
      const turnController = requestController || new AbortController();
      const manualIntent = {
        type: 'manual-advance',
        autoResumeBeforeRequest: true,
        messageCount: messages.length,
        lastMessageId: String(messages[messages.length - 1]?.id || ''),
        anchorMessageId: String(unanswered?.id || ''),
        previousGenerationTaskId: manualRetryPreviousTaskId,
      };
      const beginDurableManualSession = () => beginChatStreamSession(chatId, {
        title,
        abortController: turnController,
        taskId: stableGenerationIdentity.taskId,
        idempotencyKey: stableGenerationIdentity.idempotencyKey,
        aiRoundId: stableGenerationAiRoundId,
        startedAt: stableGenerationStartedAt,
        intent: manualIntent,
        claimPending: true,
        // localStorage 仅用于崩溃恢复；用户明确点击推进时，恢复记录写失败不能
        // 反过来阻止正常调用。另一页面的新鲜 owner 心跳仍由 claimPending 拦截。
        requireDurable: false,
      });
      let pendingSession = beginDurableManualSession();
      if (!pendingSession) {
        showToast('此会话正在其他页面生成，本轮未重复调用', 4000);
        return;
      }
      preflightTaskId = stableGenerationIdentity.taskId;
      preflightController = turnController;
      abortController = turnController;
      generationWasHiddenThisTurn = settleWithoutReplay === true
        || (typeof document !== 'undefined' && document.hidden);
      setBusy(true);
      beginFollowingLatestMessages();
      ensureKeepAliveDuringActiveGeneration({ event }).catch(() => {});
      refreshMessages(true);
      setStreamingPlaceholderVisible(true, '正在输入…');
      pinThreadForActiveStream();

      // 首次用户消息会复用其耐久 identity；明确恢复则复用 notice identity。
      // 普通手动推进若复用了消息 identity，先查任务账本：一旦它已越过安全边界，
      // 立即在同一 durable preflight 内换新 key，绝不覆盖旧 dispatch 证据。
      if (reuseMessageIdentity) {
        let existingTask = null;
        try {
          existingTask = await getGenerationTaskStrict(stableGenerationIdentity.taskId);
        } catch (_) {
          // 用户已经明确点击推进。账本暂时不可读时不复用旧身份，走下方同一套
          // “取消旧票 + 新身份”流程；旧任务保留审计，但不再让恢复功能卡死前台。
          existingTask = { status: 'unknown' };
        }
        if (existingTask && !isGenerationTaskSafePreDispatch(existingTask)) {
          manualRetryPreviousTaskId = stableGenerationIdentity.taskId;
          manualIntent.previousGenerationTaskId = manualRetryPreviousTaskId;
          unsafeInterruptedGenerationTaskIds.add(manualRetryPreviousTaskId);
          if (!isGenerationTaskTerminal(existingTask)) {
            await saveGenerationTask({
              ...existingTask,
              taskId: manualRetryPreviousTaskId,
              status: 'aborted',
              completedAt: Date.now(),
              error: {
                kind: 'manual-takeover',
                message: '用户已手动推进并用新任务接管，旧任务停止恢复。',
              },
            }).catch(() => null);
          }
          endChatStreamSession(chatId, { taskId: manualRetryPreviousTaskId });
          stableGenerationIdentity = makeStableReplyGenerationIdentity();
          stableGenerationAiRoundId = stableGenerationIdentity.aiRoundId;
          stableGenerationStartedAt = Date.now();
          pendingSession = beginDurableManualSession();
          if (!pendingSession) {
            preflightTaskId = '';
            abortController = null;
            setStreamingPlaceholderVisible(false);
            setBusy(false);
            showToast('此会话正在其他页面生成，本轮未重复调用', 4000);
            return;
          }
          preflightTaskId = stableGenerationIdentity.taskId;
        }
      }
      if (unanswered && (!messageHasPair || manualRetryPreviousTaskId)) {
        const matchesOldReplyTicket = (action) => (
          action.kind === 'real_person_reply'
          && action.chatId === chatId
          && String(action.payload?.anchorMessageId || '') === String(unanswered.id || '')
        );
        try {
          if (manualRetryPreviousTaskId) {
            // 先立跨页停止闸门，再拿 mutation lock 删除并重读确认；任何未知状态
            // 都不能带着一张可能仍会派发的旧票继续第二次计费请求。
            requestPendingChatActionCancellation(user.id, chatId);
            const {
              cancelPendingActions,
              listPendingActions,
            } = await import('../core/chat/pending-actions.js');
            const cancelled = await cancelPendingActions(user.id, matchesOldReplyTicket);
            if (!cancelled?.ok) throw new Error('旧回复票据取消失败');
            const remaining = await listPendingActions(user.id);
            if (remaining.some(matchesOldReplyTicket)) {
              throw new Error('旧回复票据取消未确认');
            }
          }
          unanswered.metadata = {
            ...(unanswered.metadata || {}),
            generationTaskId: stableGenerationIdentity.taskId,
            generationIdempotencyKey: stableGenerationIdentity.idempotencyKey,
            generationAiRoundId: stableGenerationAiRoundId,
          };
          await saveMessage(unanswered);
          const confirmedMessage = await getRecord('messages', unanswered.id);
          const confirmedMetadata = confirmedMessage?.metadata || {};
          if (
            String(confirmedMetadata.generationTaskId || '') !== stableGenerationIdentity.taskId
            || String(confirmedMetadata.generationIdempotencyKey || '') !== stableGenerationIdentity.idempotencyKey
            || String(confirmedMetadata.generationAiRoundId || '') !== stableGenerationAiRoundId
          ) {
            throw new Error('新回复身份落库未确认');
          }
        } catch (error) {
          showToast(`无法安全登记本次重试，本轮未调用接口：${String(error?.message || error || '存储不可用')}`, 5000);
          return;
        }
      }
    }
    contextPrewarmEnabled = (await getConfig().catch(() => ({})))?.contextPrewarmEnabled === true;
    // “后台预热”开关只控制空闲时主动构建。用户真正发送过的上下文无论该开关
    // 是否开启都应带精确消息锚点缓存；这样紧接着重 roll 回到同一锚点时可直接
    // 复用刚才实际调用过的 system prompt，不再重新扫一轮世界书、记忆和关系网。
    if (manualRequest && mode === 'advance') {
      contextPrewarmKey = currentAdvanceContextPrewarmKey();
    }
    const resolveHeadlessConflict = async () => {
      if (!isHeadlessChatReplyRunning(chatId)) return true;
      if (!manualRequest) {
        // 自动接话、追发和后台轮之间的正常避让不应打扰用户；多个计时器可能
        // 同时撞上同一后台任务，若每个都弹 Toast 会在页面上连续堆叠。
        return false;
      }
      // 用户亲手点推进 / 重 roll / 补充时，以本次明确操作为准：
      // 先终止真人感、追发等后台回合，等 finally 释放跨页锁后由前台接管。
      abortHeadlessChatReply(chatId, 'manual-takeover');
      const released = await waitForHeadlessChatReplyIdle(chatId, 5000);
      if (released) return true;
      showToast('正在停止后台回复，请稍后再点一次', 3500);
      return false;
    };
    // 自动接话/追发必须服从完全下线；用户亲手点推进（两项均 false）是明确旁路，
    // 仍让 AI 看到当前下线状态并自行决定继续沉默、提前回来或延长。
    if (realPersonChatter || realPersonChase) {
      try {
        const { isHardOfflineActiveForChat, maybeRunHardOfflinePeek } = await import('../core/chat/real-person-hard-offline.js');
        const hardOffline = await isHardOfflineActiveForChat(user.id, chat);
        if (hardOffline) {
          if (realPersonChatter) {
            await maybeRunHardOfflinePeek(chat, user, { now: Date.now() }).catch(() => {});
          }
          return;
        }
      } catch (_) { /* 状态读不到时沿用普通真人感流程 */ }
    }
    if (!await resolveHeadlessConflict() || requestController?.signal?.aborted) return;
    // 一轮开始就取消挂着的追发定时器；轮次结束会按最新状态重新决定要不要追。
    cancelRealPersonChase();
    import('../core/chat/real-person-chase-beat.js')
      .then((mod) => mod.cancelChaseBeatsForChat(user.id, chatId))
      .catch(() => {});
    const latestChat = await getChat(chatId).catch(() => chat);
    if (requestController?.signal?.aborted) return;
    if (isAllMutedGroup(latestChat)) {
      chat = latestChat;
      showToast('本群正在全员禁言');
      return;
    }
    if (strangerChat) {
      const latest = await getChat(chatId).catch(() => chat);
      if (isUserAliasBlockedByCharacter(latest)) {
        chat = latest;
        showToast('消息已被对方拒收');
        return;
      }
    }
    if (streamerSourced && isGroup) {
      const lastUserMsg = [...messages].reverse().find((m) => m?.senderId === 'user' && !m.deleted);
      await runStreamerFanGroupAiReply(mode === 'advance' ? (lastUserMsg?.content || '') : '', mode);
      return;
    }
    // 自动接话最初的门禁之后会经过下线状态、后台冲突和会话刷新等异步读取。
    // 用户可能就在这些 await 期间继续打字；紧贴 setBusy(true) 再核验一次，
    // 避免用过期的“输入框为空”快照锁住正在编辑的输入框。
    if (realPersonChatter || realPersonChase) {
      const composeBlock = getRealPersonComposeBlock();
      if (composeBlock.blocked) {
        if (realPersonChatter && Date.now() < autoReplyDeadline) {
          retryRealPersonAutoReply(composeBlock.retryMs || 1500);
        }
        if (realPersonChase && Date.now() < chaseComposeDeadline && !chaseTimer) {
          chaseTimer = setTimeout(
            () => { void attemptRealPersonChase(); },
            Math.max(500, Number(composeBlock.retryMs) || 1500),
          );
        }
        return;
      }
    }
    clearChatError();
    streamingPreviewPaintedThisTurn = false;
    streamingPreviewFirstPaintAt = 0;
    persistedReplyPaintedThisTurn = false;
    persistedReplyFirstPaintAt = 0;
    persistedReplyPaintedIdsThisTurn.clear();
    generationWasHiddenThisTurn = settleWithoutReplay === true
      || (typeof document !== 'undefined' && document.hidden);
    setBusy(true);
    paintLease = beginLocalRoundPaint();
    // 点推进就要看到「正在输入」从底往上顶；别停在半截还要自己滑。
    beginFollowingLatestMessages();
    // 借用户点击手势加强保活，切后台后尽量让这一轮请求继续跑完（不另发重试请求）。
    if (!durableManualAdvance) ensureKeepAliveDuringActiveGeneration({ event }).catch(() => {});
    refreshMessages(true);
    pinThreadForActiveStream();
    const turnController = requestController || new AbortController();
    const hasSuppliedGenerationPair = String(generationTaskId || '').trim()
      && String(generationIdempotencyKey || '').trim();
    const requiresFreshGenerationIdentity = mode === 'reroll' || mode === 'rerollTopic';
    stableGenerationIdentity = stableGenerationIdentity || makeStableReplyGenerationIdentity(
      hasSuppliedGenerationPair ? {
        generationTaskId,
        generationIdempotencyKey,
        generationAiRoundId,
      } : (requiresFreshGenerationIdentity
        ? {}
        : (getUnansweredRealUserMessage(messages)?.metadata || {})),
    );
    stableGenerationAiRoundId = stableGenerationAiRoundId || stableGenerationIdentity.aiRoundId;
    stableGenerationStartedAt = stableGenerationStartedAt || Date.now();
    const generationIdentity = stableGenerationIdentity;
    const generationStartedAt = stableGenerationStartedAt;
    const generationTimeline = {
      rerollTargetResolvedAt: 0,
      rerollUiHiddenAt: rerollUiHiddenStartedAt,
      rerollCleanupDoneAt: 0,
      turnStartedAt: 0,
      requestStartedAt: 0,
      relayCompletedAt: 0,
      relayClaimedAt: 0,
      responseReadyAt: 0,
      persistPreflightStartedAt: 0,
      persistStartedAt: 0,
      visibleMessagesSavedAt: 0,
      firstStreamTextAt: 0,
      turnReturnedAt: 0,
      messagesReloadedAt: 0,
    };
    abortController = turnController;
    // 上面的本地读取包含 await；后台待办可能恰好在此期间抢先进入生成。
    // 这里紧挨着登记前台会话再核验一次，避免两个相同上下文同时落库。
    const foregroundReady = await resolveHeadlessConflict();
    if (!foregroundReady || turnController.signal.aborted) {
      abortController = null;
      if (preflightTaskId) endChatStreamSession(chatId, { taskId: preflightTaskId });
      setBusy(false);
      endLocalRoundPaint();
      paintLease = 0;
      refreshActionArea();
      return;
    }
    if (!preflightTaskId) {
      beginChatStreamSession(chatId, {
        title,
        abortController: turnController,
        taskId: generationIdentity.taskId,
        idempotencyKey: generationIdentity.idempotencyKey,
        aiRoundId: stableGenerationAiRoundId,
        startedAt: generationStartedAt,
        intent: null,
      });
    }
    armGenerationWatchdog();
    armGenerationLongWaitReminder();
    void (async () => {
      try {
        const previewTs = await getNowForUser(user.id);
        await updateChatPreview(chatId, CHAT_STREAM_PREVIEW, previewTs);
      } catch (_) { /* ignore */ }
    })();

    const resolveSenderName = async (id) => {
      if (id === 'user') return frontStageUserName();
      if (isAnonymousChat(chat)) {
        const profile = getAnonymousDisplayProfile(chat, id, { currentUserName, spaceProfile: anonSpaceProfile });
        if (profile?.anonymousId) return profile.anonymousId;
      }
      if (isGroup) {
        const card = String(chat.groupSettings?.memberCards?.[id] || '').trim();
        if (card) return card;
      }
      return resolveUiActorName(id, id);
    };

    let rerollExcludeAiRoundIds = [];
    let rerollRootId = '';
    let rerollBackup = [];
    let rerollRoundKind = '';
    let rerollGapFillWindow = null;
    let rerollOriginalBaseTs = 0;
    let rerollCascadeBackup = null;
    let rerollPsychologicalRollback = null;
    let rerollPrimaryRestoreScopes = [];
    let rerollReplacementAiRoundId = '';
    let rerollReplacementCommitted = false;
    let rerollRollbackFinalized = false;
    let rerollVisiblePersistAcknowledged = false;
    const rerollVisibleCandidateIds = new Set();
    let newMessageIds = [];
    let beforeIds = new Set();
    const rememberRerollVisibleCandidates = ({
      aiRoundId = '',
      messageIds = [],
      messages: saved = [],
      durable = false,
    } = {}) => {
      if (!rerollMode) return;
      const roundId = String(aiRoundId || '').trim();
      if (roundId) rerollReplacementAiRoundId = roundId;
      let visibleIdCount = 0;
      for (const messageId of Array.isArray(messageIds) ? messageIds : []) {
        const id = String(messageId || '').trim();
        if (id) {
          rerollVisibleCandidateIds.add(id);
          visibleIdCount += 1;
        }
      }
      for (const message of Array.isArray(saved) ? saved : []) {
        const senderId = String(message?.senderId || '').trim();
        if (!senderId || senderId === 'user' || senderId === 'system') continue;
        const id = String(message?.id || '').trim();
        if (id) rerollVisibleCandidateIds.add(id);
      }
      // 回调只会在 saveMessages 已成功返回后触发；先记下耐久候选，
      // 再从 DB 复读可见性。复读抛错时整个恢复批次也抛错，不会冒险复活旧轮。
      if (durable && visibleIdCount > 0) rerollVisiblePersistAcknowledged = true;
    };
    const confirmDurableRerollReplacement = async () => {
      if (!rerollMode) return false;
      if (rerollReplacementCommitted) return true;
      const candidateIds = [...rerollVisibleCandidateIds];
      if (!candidateIds.length) return false;
      if (!rerollVisiblePersistAcknowledged && !rerollReplacementAiRoundId) return false;
      const stored = await Promise.all(candidateIds.map((messageId) => getRecord('messages', messageId)));
      const durable = stored.some((message) => {
        if (!message || String(message.chatId || '') !== chatId) return false;
        if (!isVisibleConversationMessage(message) || isHiddenFromChatUi(message)) return false;
        const senderId = String(message.senderId || '').trim();
        if (!senderId || senderId === 'user' || senderId === 'system') return false;
        const storedRoundId = String(message.metadata?.aiRoundId || '').trim();
        return !rerollReplacementAiRoundId || storedRoundId === rerollReplacementAiRoundId;
      });
      if (durable) rerollReplacementCommitted = true;
      return durable;
    };
    const restoreRerollPsychology = async () => {
      const token = rerollPsychologicalRollback;
      if (!token) return { restored: false, reason: 'no-token' };
      // 只有 restore 已明确返回成功/冲突等终态后才消费 token；若 IDB 抛错，
      // 保留 token 让外层 catch 的恢复批次仍可重试，不能先置空再丢掉唯一快照。
      const outcome = await restoreChatPsychologicalContinuityRollback(token);
      rerollPsychologicalRollback = null;
      return outcome;
    };
    const finalizeRerollRollback = () => {
      rerollBackup = [];
      rerollCascadeBackup = null;
      rerollPrimaryRestoreScopes = [];
      rerollPsychologicalRollback = null;
      rerollRollbackFinalized = true;
    };
    const restoreRerollFailureState = async () => {
      if (!rerollMode || rerollRollbackFinalized) {
        return { restored: false, reason: 'already-finalized' };
      }
      // 可见 replacement 已经耐久落库，就是这次重 roll 的提交点。其后的通知、
      // 偏好或群资料后处理即使抛错，也绝不能再把旧轮塞回来形成新旧并存。
      if (await confirmDurableRerollReplacement()) {
        finalizeRerollRollback();
        return { restored: false, reason: 'replacement-committed' };
      }
      // 主窗与所有侧窗一次性进入 chats/settings/messages 多 store 恢复事务。
      // 校验和 put 不再留出 clear/delete 可插入的 TOCTOU 窗口。
      const artifactRestore = await restoreAiRoundCascadeArtifacts(rerollCascadeBackup, {
        primaryMessages: rerollBackup,
        primaryRestoreScopes: rerollPrimaryRestoreScopes,
      });
      if (artifactRestore?.restored !== true) {
        finalizeRerollRollback();
        return {
          restored: false,
          reason: artifactRestore?.reason || 'guarded-restore-rejected',
        };
      }
      await restoreRerollPsychology();
      rerollBackup = [];
      rerollCascadeBackup = null;
      rerollRollbackFinalized = true;
      return { restored: true, reason: 'restored' };
    };
    try {
      if (rerollMode) {
        const rollbackChat = await getChat(chatId).catch(() => null);
        const rollbackUserId = String(rollbackChat?.userId || '').trim();
        if (!rollbackChat || rollbackUserId !== String(user.id || '').trim()) {
          showToast('会话已在其他窗口变化，请重新打开后再试');
          return;
        }
        const rerollTarget = await getLastRerollTarget();
        if (!rerollTarget) {
          showToast('没有可重 roll 的 AI 回复');
          return;
        }
        const mainRestoreBundle = await captureAiRoundMessageRestoreBundle(
          rerollTarget.backupMessages || [],
          rollbackUserId,
        );
        if (mainRestoreBundle.supported !== true || mainRestoreBundle.captured !== true) {
          finalizeRerollRollback();
          const cacheNotReady = [
            'cache-rebuild-required',
            'journal-repair-required',
            'cache-sequence-behind',
            'native-cache-not-current',
            'native-staging-active',
          ].includes(String(mainRestoreBundle.reason || ''));
          showToast(
            mainRestoreBundle.reason === 'native-batch-put-unavailable'
              ? '当前安装版本暂不支持安全重 roll，请更新应用后再试'
              : cacheNotReady
                ? '本地数据缓存仍在同步，请稍后再试'
                : '会话内容已在其他窗口变化，请重新打开后再试',
          );
          return;
        }
        generationTimeline.rerollTargetResolvedAt = Date.now();
        rerollRootId = String(rerollTarget.rerollRootId || rerollTarget.aiRoundId || '').trim();
        // replacement 继续沿用最初被替换轮的 root。第二次、第三次重 roll 时，
        // 即使旧草稿气泡早已删除，也继续把整条草稿谱系排除在即时状态读取之外；
        // 否则某个漏回滚/迟到写入的 A 状态会在 C 轮重新露头。
        rerollExcludeAiRoundIds = [...new Set([
          ...(rerollTarget.aiRoundIds?.length
            ? rerollTarget.aiRoundIds
            : [rerollTarget.aiRoundId]),
          rerollRootId,
        ].map((id) => String(id || '').trim()).filter(Boolean))];
        rerollBackup = mainRestoreBundle.messages;
        rerollPrimaryRestoreScopes = mainRestoreBundle.scopes;
        rerollOriginalBaseTs = rerollBackup.reduce((earliest, message) => {
          const ts = Number(message?.timestamp || 0);
          return ts > 0 && (!earliest || ts < earliest) ? ts : earliest;
        }, 0);
        rerollRoundKind = String(rerollTarget.roundKind || '');
        rerollGapFillWindow = rerollTarget.gapFillWindow || null;
        rerollUiRollbackOwned = true;
        // 先从当前页面乐观移除目标轮，立即给出重 roll 已生效的视觉反馈；
        // 完整会话核对出的目标会替换首帧猜测；隐藏集合会挡住删除前的迟到 DB 回读。
        setRerollTargetUiHidden(rerollTarget, { replace: true });
        if (!generationTimeline.rerollUiHiddenAt) generationTimeline.rerollUiHiddenAt = Date.now();
        refreshMessages(true);
        // deleteSystem:true 一并清掉本轮 AI 产生的拍一拍/撤回提示等系统消息，避免重 roll 后残留
        // 历史秘密基地消息没有轮次 id，则退化为按同批紧邻时间戳删除上一轮。
        setStreamingPlaceholderVisible(true, '正在输入…');
        if (rerollExcludeAiRoundIds.length) {
          const psychologyRewind = await rewindChatPsychologicalContinuityForReroll(
            chatId,
            rerollExcludeAiRoundIds,
          );
          rerollPsychologicalRollback = psychologyRewind?.rollbackToken || null;
        }
        const cascade = await removeRerollTarget(rerollTarget, {
          skipPsychologicalRewind: rerollExcludeAiRoundIds.length > 0,
        });
        generationTimeline.rerollCleanupDoneAt = Date.now();
        rerollCascadeBackup = cascade;
        setStreamingPlaceholderVisible(true, '正在输入…');
        messages = await listThreadMessages();
        // 删除完成并重新读取后才真正回到上一轮请求的消息锚点。此时生成缓存键，
        // 才能命中原回合的 system 快照；若提前在只做了 UI 隐藏时取键，原回复仍
        // 在 messages 中，会误用“回复之后”的缓存，甚至把被替换内容重新带回上下文。
        if (manualRequest) contextPrewarmKey = currentAdvanceContextPrewarmKey();
        refreshMessages(true);
        await refreshHeaderStatus();
      }

      if (turnController.signal.aborted) {
        const stoppedError = new Error('生成已停止');
        stoppedError.name = 'AbortError';
        throw stoppedError;
      }

      beforeIds = new Set(messages.map((m) => m.id));

      const rerollingGap = (mode === 'reroll' || mode === 'rerollTopic')
        && rerollRoundKind === 'gap'
        && rerollGapFillWindow;
      const directiveMode = (mode === 'gap-fill' || mode === 'gap' || rerollingGap) ? 'gap' : 'advance';
      const roundNowTs = await getNowForUser(user.id);
      const gapFillNowTs = rerollingGap
        ? Number(rerollGapFillWindow.endTs || 0)
        : (directiveMode === 'gap' ? roundNowTs : 0);
      // 重生成必须整轮回到被替换回复原本发生的时刻：不仅落库时间沿用原回合，
      // system 里的世界钟、角色当地时间、日程与状态时效也要读取同一个历史锚点。
      // 断档补写覆盖的是一段时间窗，重生成时仍以窗口终点作为“当时的现在”。
      const rerollContextNowTs = rerollingGap
        ? gapFillNowTs
        : rerollOriginalBaseTs;
      const manualTimeAware = manualRequest && !(await getAiTimeBlind(user.id).catch(() => false));
      const manualAdvanceLastVisible = manualTimeAware && durableManualAdvance
        ? getLastVisibleConversationMessage(messages)
        : null;
      const manualAdvanceElapsedMs = manualAdvanceLastVisible
        ? Math.max(0, roundNowTs - Number(manualAdvanceLastVisible.timestamp || 0))
        : 0;
      // 预热快照只记录消息锚点，不记录稍后点击时的世界钟。时间空缺已经需要进入
      // 提示词时强制重建，避免复用“消息刚发出”时生成的旧时间判断。
      if (manualAdvanceElapsedMs >= 3 * 60 * 1000) {
        contextPrewarmKey = '';
      }
      if (turnController.signal.aborted) {
        const stoppedError = new Error('生成已停止');
        stoppedError.name = 'AbortError';
        throw stoppedError;
      }
      const gapFillWindow = rerollingGap
        ? rerollGapFillWindow
        : (directiveMode === 'gap'
          ? { startTs: lastVisibleMessageTimestamp(), endTs: gapFillNowTs }
          : null);
      let lastStreamStatusPreview = '';
      const interactionTurn = await prepareChatInteractionDirective({
        mode,
        realPersonChase,
      });
      if (turnController.signal.aborted) {
        const stoppedError = new Error('生成已停止');
        stoppedError.name = 'AbortError';
        throw stoppedError;
      }
      const baseSceneDirective = sceneDirectiveOverride || (chatPrefs.guidanceMode === true
        ? '[指导模式] 请以 AI 本体身份回应当前讨论；不要角色扮演，不要输出棉花糖协议或思维链标记。'
        : realPersonChase
          ? realPersonChaseDirective()
          : realPersonChatter
            ? realPersonChatterDirective()
            : sceneDirectiveForMode(directiveMode, {
              nowTs: gapFillNowTs || roundNowTs,
              manualTimeAware,
              rerollOriginalTs: rerollOriginalBaseTs,
            }));
      const effectiveSceneDirective = [baseSceneDirective, interactionTurn?.text]
        .filter(Boolean)
        .join('\n\n');
      generationTimeline.turnStartedAt = Date.now();
      let result = await runChatAiTurn({
        chat,
        chatId,
        user,
        userId: user.id,
        messages,
        characters,
        resolveSenderName,
        anonymousChat: isAnonymousChat(chat),
        signal: turnController.signal,
        generationTaskId: generationIdentity.taskId,
        generationIdempotencyKey: generationIdentity.idempotencyKey,
        aiRoundId: stableGenerationAiRoundId,
        rerollRootId: rerollRootId || stableGenerationAiRoundId,
        generationStartedAt,
        contextPrewarmKey,
        manual: true,
        manualAdvance: durableManualAdvance,
        skipBusyAutoReply: realPersonChatter !== true,
        phoneViewerId: fromCharacterPhone ? phoneViewerId : '',
        realPersonChase: realPersonChase === true,
        reason: realPersonChase
          ? 'real-person-chase-foreground'
          : (realPersonChatter ? 'real-person-chatter-foreground' : ''),
        chatPrefs,
        onRequestStat: () => {
          modelRequestAttempted = true;
          if (typeof onModelRequestAttempted === 'function') onModelRequestAttempted();
        },
        onGenerationRequestStart: ({ startedAt, attempt = 0 } = {}) => {
          const dispatchStartedAt = Number(startedAt || 0) || Date.now();
          setStreamingPlaceholderVisible(true, '正在输入…');
          const activeSession = getChatStreamSession(chatId);
          if (!activeSession || activeSession.taskId !== generationIdentity.taskId) return;
          updateChatStreamSession(chatId, {
            phase: 'dispatching',
            attempt: Math.max(1, Number(attempt || 0)),
            dispatchStartedAt,
          });
          armGenerationLongWaitReminder();
        },
        onGenerationRequestQueued: ({ queuedAt, startedAt, attempt = 0, remoteJobId = '' } = {}) => {
          const requestQueuedAt = Number(queuedAt || startedAt || 0) || Date.now();
          generationTimeline.requestStartedAt = requestQueuedAt;
          setStreamingPlaceholderVisible(true, '正在输入…');
          const activeSession = getChatStreamSession(chatId);
          if (!activeSession || activeSession.taskId !== generationIdentity.taskId) return;
          updateChatStreamSession(chatId, {
            phase: 'submitted',
            attempt: Math.max(1, Number(attempt || activeSession.attempt || 0)),
            requestStartedAt: requestQueuedAt,
            remoteJobId: String(remoteJobId || ''),
          });
          armGenerationLongWaitReminder();
        },
        onGenerationRelayReady: ({ completedAt, claimedAt } = {}) => {
          generationTimeline.relayCompletedAt = Number(completedAt || 0);
          generationTimeline.relayClaimedAt = Number(claimedAt || 0) || Date.now();
        },
        onGenerationResponseReady: ({ readyAt, relayCompletedAt, relayClaimedAt } = {}) => {
          generationTimeline.responseReadyAt = Number(readyAt || 0) || Date.now();
          if (!generationTimeline.relayCompletedAt) {
            generationTimeline.relayCompletedAt = Number(relayCompletedAt || 0);
          }
          if (!generationTimeline.relayClaimedAt) {
            generationTimeline.relayClaimedAt = Number(relayClaimedAt || 0);
          }
        },
        onGenerationPersistPreflightStart: ({ startedAt } = {}) => {
          generationTimeline.persistPreflightStartedAt = Number(startedAt || 0) || Date.now();
        },
        onGenerationPersistStart: ({ startedAt } = {}) => {
          generationTimeline.persistStartedAt = Number(startedAt || 0) || Date.now();
        },
        onVisibleMessagesPersisted: ({ at, aiRoundId, messageIds } = {}) => {
          generationTimeline.visibleMessagesSavedAt = Number(at || 0) || Date.now();
          rememberRerollVisibleCandidates({ aiRoundId, messageIds, durable: true });
        },
        capabilityApprovalHandler: (request) => openCapabilityApprovalModal(request, {
          signal: turnController.signal,
        }),
        forcedLinkVisionMessageId,
        sceneDirective: effectiveSceneDirective,
        baseTimestamp: rerollOriginalBaseTs || undefined,
        contextNow: rerollContextNowTs || undefined,
        gapFillWindow: chatPrefs.guidanceMode === true ? null : gapFillWindow,
        excludeAiRoundIds: rerollExcludeAiRoundIds,
        aiRoundKind: chatPrefs.guidanceMode === true ? 'guidance' : directiveMode,
        guidanceScopeMode: mode,
        guidanceMode: chatPrefs.guidanceMode === true,
        onTransportProgress: noteGenerationProgress,
        deliveryGuard,
        onStreamText: (displayText, rawText = '') => {
          if (!generationTimeline.firstStreamTextAt && String(displayText || '').trim()) {
            generationTimeline.firstStreamTextAt = Date.now();
          }
          noteGenerationProgress();
          if (generationWasHiddenThisTurn || document.hidden) {
            generationWasHiddenThisTurn = true;
            setStreamingPlaceholderVisible(true, '正在输入…');
            return;
          }
          setStreamingPlaceholderVisible(true, displayText);
          scheduleStreamingMessagePreview(rawText);
          const statusPreview = /^正在(?:查证|搜索)/.test(String(displayText || '').trim())
            ? String(displayText || '').trim().slice(0, 80)
            : '';
          if (statusPreview && statusPreview !== lastStreamStatusPreview) {
            lastStreamStatusPreview = statusPreview;
            getNowForUser(user.id)
              .then((timestamp) => updateChatPreview(chatId, statusPreview, timestamp))
              .catch(() => {});
          }
        },
      });
      generationTimeline.turnReturnedAt = Date.now();
      rememberRerollVisibleCandidates({
        aiRoundId: result?.aiRoundId,
        messages: result?.messages,
      });

      messages = await listThreadMessages();
      generationTimeline.messagesReloadedAt = Date.now();
      newMessageIds = newMessageIdsSince(beforeIds);
      await refreshHeaderStatus();

      // 忙碌自动回复零 API 短路：也算成功落库，刷新气泡即可。
      if (result?.handled && result?.reason === 'busy-auto-reply') {
        result = { ...result, ok: true, busyGate: true };
      }
      if (result?.fauxAutoReply) {
        result = { ...result, ok: true, busyGate: true };
      }
      if (result?.handled && (result?.reason === 'sparse-window' || result?.reason === 'busy-reply-cooldown' || result?.reason === 'already-replied' || result?.reason === 'busy-silent-no-copy')) {
        result = { ...result, ok: true, silentBusy: true, busyGate: true };
      }
      if (rerollMode && result?.ok) {
        if (await confirmDurableRerollReplacement()) {
          // 可见新轮是重 roll 的提交边界；后面的偏好、通知、群资料刷新不参与回滚。
          finalizeRerollRollback();
        } else {
          // 状态/副作用更新或 ok 标记都不能替代一条真正落库的可见新回复。
          result = {
            ...result,
            ok: false,
            reason: 'reroll-no-visible-replacement',
            error: '本次重 roll 没有落库可显示的新回复，已恢复原回复。',
          };
        }
      }
      latestRoundResult = result;

      if (result.ok) {
        if (interactionTurn?.opening && !result.busyGate && !result.silentBusy) {
          const activeInteraction = normalizeChatInteractionSession(chatPrefs.interactionSession);
          if (activeInteraction?.id === interactionTurn.sessionId) {
            chatPrefs = await patchChatPrefs(chatId, {
              interactionSession: {
                ...activeInteraction,
                openingPending: false,
                updatedAt: Date.now(),
              },
            });
          }
        }
        if (chatPrefs.guidanceMode !== true && !result.busyGate && !result.silentBusy) {
          const guidancePatch = scopedGuidanceSuccessPatch(chatPrefs, { mode });
          if (Object.keys(guidancePatch).length) {
            chatPrefs = await patchChatPrefs(chatId, guidancePatch);
          }
        }
        // 刚手动推进过一轮，把「后台自动推进」的计时锚点重置到现在——
        // 不然后台定时器还按老节奏走，隔几分钟场景没怎么变又独立生成一轮，
        // 很容易复述出高度相似甚至一样的内容。
        markChatManuallyAdvanced(chatId).catch(() => {});
        // 用户切到后台时这一轮若已跑完，补一条与后台自动推进同款的系统通知。
        notifyManualGenerationIfAwayFromChat(result).catch(() => {});
        // 忙碌自动回复 / 抽空静默后不要追发：否则会 skipBusy 再打一轮满 AI，看起来像秒回。
        // 戳醒真回后若仍在抽空窗口 / 仍挂着忙碌状态，同样不要追发。
        if (!result.busyGate && !result.silentBusy && result.reason !== 'busy-auto-reply') {
          let suppressChase = false;
          try {
            const [{ loadCharacterPhone }, proactiveTools] = await Promise.all([
              import('../core/character-phone-store.js'),
              import('../core/character-phone-proactive.js'),
            ]);
            const phone = await loadCharacterPhone(user.id, partnerId).catch(() => null);
            const nowTs = Date.now();
            if (Number(phone?.busyAutoReplyState?.sparseUntil || 0) > nowTs) suppressChase = true;
            const liveAr = phone?.sessionAutoReply;
            if (liveAr?.text && (!Number(liveAr.expireAt || 0) || Number(liveAr.expireAt) > nowTs)) {
              suppressChase = true;
            }
            const realityBlock = await proactiveTools.resolveCharacterAutonomousMessageBlock?.(
              user.id,
              partnerId,
              chatId,
              await getNowForUser(user.id),
            );
            if (realityBlock?.blocked) suppressChase = true;
          } catch (_) { /* 读不到忙碌态时照常追发 */ }
          if (!suppressChase && !realPersonChase) scheduleRealPersonChase().catch(() => {});
        }
      }

      if (result.ok && isGroup) {
        // 群管事件会在 AI 回合内先保存最新 groupSettings；这里若继续保存回合开始时的
        // 旧 chat，会把角色刚改好的公告、待办、头衔或禁言状态整块覆盖回去。
        const liveGroupChat = await getChat(chatId).catch(() => null);
        const nextGroupChat = liveGroupChat || chat;
        nextGroupChat.metadata = {
          ...(nextGroupChat.metadata || {}),
          groupAiTurn: Number(nextGroupChat.metadata?.groupAiTurn || 0) + 1,
        };
        await saveChat(nextGroupChat);
        chat = nextGroupChat;
        await refreshThreadAppearanceShell();
        refreshGroupInfoCards();
      }

      if (result.ok || result.reason !== 'stream-error') {
        consecutiveStreamErrors = 0;
      }

      const operationLabel = (mode === 'reroll' || mode === 'rerollTopic')
        ? '聊天重 roll'
        : (mode === 'gap-fill' || mode === 'gap' ? '闲聊补充' : '聊天推进');
      if (!result.ok) {
        // 只有“没有可见新轮落库 + 会话仍是原作用域”才可恢复旧轮。
        // 恢复内部抛错会进入外层 catch，且心理快照 token 仍保留可重试。
        if (rerollMode) {
          const rollback = await restoreRerollFailureState();
          messages = await listThreadMessages();
          newMessageIds = rollback.restored ? [] : newMessageIdsSince(beforeIds);
        }
        await refreshHeaderStatus();
        if (result.aborted && result.abortReason !== 'watchdog') {
          // 手动停止入口已经提示过；这里避免 abort 结果回流时重复弹两条。
        } else if (result.reason === 'client-timeout') {
          const err = buildChatErrorFromResult(result, '生成长时间无进展', operationLabel);
          setChatError(err);
        } else if (result.reason === 'upstream-content-refusal') {
          const err = buildChatErrorFromResult(result, '上游拒绝了本次请求', operationLabel);
          setChatError(err);
          const refusalSource = String(result.refusalProvider || '').trim().toLowerCase() === 'google'
            ? 'Google / Gemini 安全策略拦截'
            : '上游内容拦截';
          showToast(`${refusalSource}：请排查本轮输入/上下文中的敏感词；确认合规仍被拦截时，请更换模型或 API 渠道。完整原文可在错误卡片或“上一轮原文”查看`, 8000);
        } else if (isProtocolParseFailure(result.reason)) {
          const err = buildChatErrorFromResult(result, result.error || '协议解析失败', operationLabel);
          setChatError(err);
          showToast(err.message || '协议解析失败', 4500);
        } else if (result.reason === 'validation-failed') {
          const err = buildChatErrorFromResult(result, '模型输出未通过校验', operationLabel);
          setChatError(err);
          showToast('模型输出未通过校验，本轮未落库', 4000);
        } else if (result.reason === 'empty-api-response') {
          const err = buildChatErrorFromResult(result, '未抽到可用正文', operationLabel);
          setChatError(err);
          showToast(result.error || '接口已结束响应，但没有返回可显示的正文；请打开详情查看具体证据', 5000);
        } else if (result.reason === 'reroll-no-visible-replacement') {
          const err = buildChatErrorFromResult(result, '重 roll 没有可显示的新回复', operationLabel);
          setChatError(err);
          showToast(result.error || '本次没有生成可显示的新回复，已恢复原回复', 4500);
        } else if (result.reason === 'blocked-by-user') {
          showToast('这段会话已设为不可达，后台回复已暂停', 3500);
        } else if (result.reason === 'stream-error') {
          setChatError(buildChatErrorFromResult(result, '回复没有接收完整', operationLabel));
          consecutiveStreamErrors += 1;
          if (result.streamStats?.sawPageHidden === true) {
            // 页面曾进入后台只是相关证据，不能据此断言系统掐网；原生桥、VPN、
            // 网络切换或中转断连都会呈现相同结果。
            showToast('本轮在后台期间返回链路中断；可能与系统限网、VPN/网络切换、中转或原生返回有关，请回前台重 roll', 6500);
          } else if (consecutiveStreamErrors >= 2) {
            // Repeated mid-stream drops on this network usually mean the relay
            // or route dislikes SSE; suggest (not force) non-stream mode.
            showToast('连续两次没有收到完整回复：请检查代理或切换网络/接口线路后再试', 6000);
          } else {
            showToast('回复在传输途中断开了，请重试一次；技术原因可在错误详情里查看', 5000);
          }
        } else {
          setChatError(buildChatErrorFromResult(result, '生成失败', operationLabel));
        }
      } else if (result.recoveredFromPartial || result.partialSalvage) {
        // 内容已经补全落库、回复正常显示：不再弹「中断/截断」字样吓人，
        // 证据留在调试日志里，反馈包仍可追溯。
        import('../core/debug-log.js').then(({ appendDebugEvent }) => appendDebugEvent({
          type: 'chat_round_recovered',
          level: 'info',
          message: result.recoveredFromPartial
            ? '流传输提前结束，已用已收到内容补全落库'
            : `输出截断，已落库 ${result.messageCount || 0} 条完整气泡`,
          context: {
            chatId,
            recoveredFromPartial: !!result.recoveredFromPartial,
            partialSalvage: !!result.partialSalvage,
            messageCount: result.messageCount || 0,
          },
        })).catch(() => {});
      } else if (result.legacyTaggedFallback) {
        showToast('模型本轮掉了格式，已兼容拆成气泡并标注', 4500);
      }
    } catch (err) {
      const stopped = turnController.signal.aborted || err?.name === 'AbortError';
      if (!stopped) console.error('[chat-thread]', err);
      let rollback = { restored: false, reason: 'not-reroll' };
      try {
        rollback = await restoreRerollFailureState();
      } catch (rollbackError) {
        if (!stopped) console.error('[chat-thread] reroll rollback failed', rollbackError);
      }
      await refreshHeaderStatus().catch(() => {});
      if (!stopped) {
        const operationLabel = (mode === 'reroll' || mode === 'rerollTopic')
          ? '聊天重 roll'
          : (mode === 'gap-fill' || mode === 'gap' ? '闲聊补充' : '聊天推进');
        if (rerollMode && rerollReplacementCommitted) {
          // 新气泡已是耐久事实，这里只报告后处理没完整，不再把它伪装成“生成失败”。
          latestRoundResult = latestRoundResult?.ok ? latestRoundResult : {
            ok: true,
            reason: 'reroll-replacement-committed',
            aiRoundId: rerollReplacementAiRoundId,
          };
          showToast('新回复已保存，但部分状态后处理未完成', 4000);
        } else {
          setChatError(buildChatErrorFromException(err, operationLabel));
          showToast(err?.message || '生成失败', 3500);
        }
      }
      messages = await listThreadMessages();
      newMessageIds = rollback.restored ? [] : newMessageIdsSince(beforeIds);
    } finally {
      clearGenerationWatchdog();
      clearGenerationLongWaitReminder();
      abortController = null;
      // 会话结束通知负责同步清掉流式占位；必须在 setBusy(false) 改写
      // isStreaming 之前触发，否则气泡已显示后「正在输入」仍会残留到下一次重绘。
      endChatStreamSession(chatId, { taskId: generationIdentity.taskId });
      setBusy(false);
      try { await recalcChatPreview(chatId); } catch (_) { /* ignore */ }
      chat = await getChat(chatId);
      let visiblePaintAt = 0;
      const paintCanBeObserved = !document.hidden && container.isConnected && !container.hidden;
      if (isCurrentLocalRoundPaint(paintLease)) {
        const unpaintedMessageIds = newMessageIds.filter((id) => (
          !persistedReplyPaintedIdsThisTurn.has(String(id || ''))
        ));
        const needsFinalRefresh = !persistedReplyPaintedThisTurn || unpaintedMessageIds.length > 0;
        if (needsFinalRefresh && persistedReplyPaintedThisTurn && isBubbleRevealActive()) {
          // 正式气泡正在逐条出现时，晚到的旁路消息交给 lease 结束后的刷新补齐；
          // 此处重画会调用 cancelBubbleReveal，把尚未出现的气泡一次性全弹出来。
          pendingLocalPaintDbRefresh = true;
        } else if (needsFinalRefresh) {
          refreshMessages(false, {
            // 已提前显示过完整气泡块时，正式消息应原位接管；不要再从第一条重复播放一次。
            // 本轮进过后台时，中继返回的是完整结果，回前台应整批显示，不补演逐条揭示。
            revealIds: (streamingPreviewPaintedThisTurn || generationWasHiddenThisTurn)
              ? []
              : revealIdsForPaint(newMessageIds),
          });
        }
        stabilizeFailedRoundAtLatest();
        if (paintCanBeObserved) {
          if (persistedReplyPaintedThisTurn && persistedReplyFirstPaintAt > 0) {
            visiblePaintAt = persistedReplyFirstPaintAt;
          } else {
            await waitForNextPaint();
            if (!document.hidden && container.isConnected && !container.hidden) {
              visiblePaintAt = Date.now();
            }
          }
        }
      }
      streamingPreviewPaintedThisTurn = false;
      const finalizedAt = Date.now();
      const sinceStart = (value) => value > 0 ? Math.max(0, value - generationStartedAt) : 0;
      const timelineContext = {
        chatId,
        mode,
        totalToPaintMs: sinceStart(visiblePaintAt),
        finalizedMs: sinceStart(finalizedAt),
        paintDeferred: visiblePaintAt <= 0,
        rerollTargetMs: sinceStart(generationTimeline.rerollTargetResolvedAt),
        rerollUiHiddenMs: sinceStart(generationTimeline.rerollUiHiddenAt),
        rerollCleanupMs: sinceStart(generationTimeline.rerollCleanupDoneAt),
        turnStartMs: sinceStart(generationTimeline.turnStartedAt),
        requestStartMs: sinceStart(generationTimeline.requestStartedAt),
        relayCompletedMs: sinceStart(generationTimeline.relayCompletedAt),
        relayClaimedMs: sinceStart(generationTimeline.relayClaimedAt),
        relayClaimDelayMs: generationTimeline.relayCompletedAt > 0 && generationTimeline.relayClaimedAt > 0
          ? Math.max(0, generationTimeline.relayClaimedAt - generationTimeline.relayCompletedAt)
          : 0,
        responseReadyMs: sinceStart(generationTimeline.responseReadyAt),
        persistPreflightStartMs: sinceStart(generationTimeline.persistPreflightStartedAt),
        persistStartMs: sinceStart(generationTimeline.persistStartedAt),
        visibleMessagesSavedMs: sinceStart(generationTimeline.visibleMessagesSavedAt),
        firstStreamTextMs: sinceStart(generationTimeline.firstStreamTextAt),
        firstPreviewBubbleMs: sinceStart(streamingPreviewFirstPaintAt),
        turnReturnedMs: sinceStart(generationTimeline.turnReturnedAt),
        messagesReloadedMs: sinceStart(generationTimeline.messagesReloadedAt),
      };
      const timelineDurationMs = timelineContext.totalToPaintMs || timelineContext.finalizedMs;
      if (timelineDurationMs >= 10_000 || mode === 'reroll' || mode === 'rerollTopic') {
        import('../core/debug-log.js').then(({ appendDebugEvent }) => appendDebugEvent({
          type: 'chat_generation_timeline',
          level: timelineDurationMs >= 20_000 ? 'warn' : 'info',
          message: timelineContext.paintDeferred
            ? `聊天${mode === 'reroll' || mode === 'rerollTopic' ? '重 roll' : '生成'}已完成，页面不在前台，绘制时间暂未计入`
            : `聊天${mode === 'reroll' || mode === 'rerollTopic' ? '重 roll' : '生成'}到实际绘制耗时 ${Math.round(timelineDurationMs / 100) / 10} 秒`,
          durationMs: timelineDurationMs,
          context: timelineContext,
        })).catch(() => {});
      }
      generationWasHiddenThisTurn = false;
      persistedReplyPaintedThisTurn = false;
      persistedReplyFirstPaintAt = 0;
      persistedReplyPaintedIdsThisTurn.clear();
      endLocalRoundPaint();
      paintLease = 0;
      refreshActionArea();
      // 这轮的正式消息已经落库并绘制，趁用户阅读时就把下一次推进的
      // system prompt 准备好。以前这里漏了调度，所以连续点推进时每轮都是
      // prewarmHit=false，本地构建的 6~30 秒会完整叠加到 API 时间前面。
      scheduleAdvanceContextPrewarm(250);
      const bannerHost = container.querySelector('.chat-active-event-banner');
      if (bannerHost) bannerHost.outerHTML = renderActiveEventBanner();
      container.querySelector('[data-clear-event]')?.addEventListener('click', () => {
        clearActiveEvent(chatId).then(async () => {
          chat = await getChat(chatId);
          paint();
        });
      });
    }
    return { modelRequestAttempted, result: latestRoundResult };
    } finally {
      const rerollUiRowsWillBeRevealed = messages.some((message) => (
        rerollUiHiddenMessageIds.has(String(message?.id || ''))
        || rerollUiHiddenRoundIds.has(String(message?.metadata?.aiRoundId || ''))
      ));
      const rerollUiWasHidden = clearRerollTargetUiHidden();
      if (rerollUiWasHidden
        && (!rerollUiRollbackOwned || rerollUiRowsWillBeRevealed)
        && container.isConnected
        && !container.hidden) {
        // 锁冲突、目标失效、安全快照未就绪或失败回滚放回旧轮时，立即恢复原画面。
        refreshMessages(false);
      }
      const unfinishedPreflight = preflightTaskId
        && String(getChatStreamSession(chatId)?.taskId || '') === preflightTaskId;
      if (unfinishedPreflight) {
        clearGenerationWatchdog();
        clearGenerationLongWaitReminder();
        if (abortController === preflightController) abortController = null;
        endChatStreamSession(chatId, { taskId: preflightTaskId });
        setStreamingPlaceholderVisible(false);
        setBusy(false);
        if (paintLease) {
          endLocalRoundPaint();
          paintLease = 0;
        }
        refreshActionArea();
      }
      if (ownedRequestIntent && manualGenerationGate.release(ownedRequestIntent)) {
        setBusy(isStreaming);
      }
      generationExecutionLease?.release();
    }
  }

  async function loadForwardSourceMessage(msg) {
    if (!msg?.id || (msg.metadata?.deferredImage !== true && msg.metadata?.deferredSticker !== true)) {
      return msg;
    }
    return getRecord('messages', msg.id).catch(() => null).then((stored) => stored || msg);
  }

  async function forwardMessage(msg) {
    const { openForwardPicker } = await import('../components/forward-picker.js');
    const dest = await openForwardPicker({
      userId: user.id,
      currentChatId: chatId,
    });
    if (!dest?.chatId) return;
    const destChat = await getChat(dest.chatId).catch(() => null);
    if (!destChat || !isUserPresentInChat(destChat)) {
      showToast('该窗口不支持用户转发');
      return;
    }
    const sourceMessage = await loadForwardSourceMessage(msg);
    const copy = createMessage({
      chatId: dest.chatId,
      senderId: 'user',
      senderName: frontStageUserName(),
      type: sourceMessage.type,
      content: sourceMessage.content,
      timestamp: await nextChatMessageTimestamp(user.id, dest.chatId),
      metadata: {
        ...(sourceMessage.metadata || {}),
        forwardedFrom: chatId,
        forwardedMsgId: sourceMessage.id,
      },
    });
    await saveMessage(copy);
    await updateChatPreview(dest.chatId, previewFromMessage(copy), copy.timestamp);
    await bumpChatUnread(dest.chatId, 1);
    showToast('已转发');
  }

  async function insertMessageAfterAnchor(anchorMsg, payloadBuilder) {
    const main = container.querySelector('.chat-thread-messages');
    const historyViewportState = captureHistoryViewportState(main);
    const all = await listMessagesForChat(chatId, 0);
    const anchorTs = Number(anchorMsg?.timestamp || 0);
    const insertTs = Math.max(1, anchorTs + 1);
    const toShift = all
      .filter((m) => Number(m?.timestamp || 0) >= insertTs)
      .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    for (const item of toShift) {
      await saveMessage({ ...item, timestamp: Number(item.timestamp || 0) + 1 });
    }
    const payload = await payloadBuilder(insertTs);
    if (!payload) return false;
    const msg = createMessage({ chatId, ...payload, timestamp: payload.timestamp || insertTs });
    if (typeof msg.content === 'string') {
      msg.content = applyPermanentRegex(msg.content, {
        surface: 'chat',
        placement: msg.senderId === 'user' && !msg.metadata?.userComposedAsCharacter ? 1 : 2,
        depth: 0,
        macros: { user: frontStageUserName(), char: msg.senderName || title || '角色' },
      });
    }
    await saveMessage(msg);
    await recalcChatPreview(chatId);
    messages = await listThreadMessages();
    if (historyViewportState) visibleMessageLimit += 1;
    refreshMessages();
    stabilizeHistoryViewport(container.querySelector('.chat-thread-messages'), historyViewportState);
    showToast('已插入气泡');
    return true;
  }

  async function deleteVisibleMessagesOptimistically(targetMessages = []) {
    const rows = (Array.isArray(targetMessages) ? targetMessages : [targetMessages])
      .map((target) => (typeof target === 'object'
        ? target
        : messages.find((message) => String(message?.id || '') === String(target || ''))))
      .filter((message) => message?.id);
    if (!rows.length) return 0;
    const ids = new Set(rows.map((message) => String(message.id)));
    const mutationRevisions = new Map(rows.map((message) => [
      String(message.id),
      markLocalMessageMutation(message.id, 'delete'),
    ]));
    messages = messages.filter((message) => !ids.has(String(message?.id || '')));
    refreshMessages();
    try {
      // 单条删除本身会重算预览；批量时改为只在末尾算一次，避免大记录库
      // 连续打开多轮 IndexedDB 查询，让“删除”看起来卡住。
      await Promise.all(rows.map((message) => deleteMessage(message.id, { recalcPreview: false })));
      rows.forEach((message) => settleLocalMessageMutation(message.id, mutationRevisions.get(String(message.id))));
      await recalcChatPreview(chatId);
      return rows.length;
    } catch (error) {
      const rollbackRevisions = new Map(rows.map((message) => [
        String(message.id),
        markLocalMessageMutation(message.id, 'upsert', message),
      ]));
      await Promise.all(rows.map((message) => saveMessage(message))).catch(() => {});
      rows.forEach((message) => settleLocalMessageMutation(message.id, rollbackRevisions.get(String(message.id))));
      const currentIds = new Set(messages.map((message) => String(message?.id || '')));
      messages = [...messages, ...rows.filter((message) => !currentIds.has(String(message.id)))]
        .sort((a, b) => Number(a?.timestamp || 0) - Number(b?.timestamp || 0));
      refreshMessages();
      throw error;
    }
  }

  async function editBubbleMessage(msg) {
    if (!msg || msg.recalled) return;
    const patch = await openEditBubbleModal(msg, { variant: anonEditorVariant() });
    if (!patch) return;
    const next = {
      ...msg,
      ...patch,
      editedAt: Date.now(),
      metadata: patch.metadata !== undefined ? patch.metadata : msg.metadata,
    };
    const placement = next.senderId === 'user' && !next.metadata?.userComposedAsCharacter ? 1 : 2;
    const regexContext = {
      surface: 'chat',
      placement,
      depth: Math.max(0, messages.length - 1 - messages.findIndex((item) => item.id === msg.id)),
      macros: { user: frontStageUserName(), char: next.senderName || title || '角色' },
    };
    if (typeof next.content === 'string') next.content = applyEditRegex(next.content, regexContext);
    if (typeof next.metadata?.text === 'string') {
      next.metadata = { ...next.metadata, text: applyEditRegex(next.metadata.text, regexContext) };
    }
    // 先更新现有 DOM，再做持久化；大图/大记录库不再阻塞编辑结果出现。
    const localMutationRevision = markLocalMessageMutation(next.id, 'upsert', next);
    messages = messages.map((m) => (m.id === msg.id ? next : m));
    refreshMessages();
    try {
      await saveMessage(next);
      settleLocalMessageMutation(next.id, localMutationRevision);
    } catch (error) {
      const rollbackRevision = markLocalMessageMutation(msg.id, 'upsert', msg);
      settleLocalMessageMutation(msg.id, rollbackRevision);
      messages = messages.map((m) => (m.id === msg.id ? msg : m));
      refreshMessages();
      throw error;
    }
    // 会话首页的 lastMessage 是独立存储的预览字段；只改消息记录会让返回列表后
    // 仍显示编辑前的内容。预览失败不回滚已经成功保存的正文，稍后的常规刷新仍可自愈。
    try { await recalcChatPreview(chatId); } catch (_) { /* ignore */ }
    invalidateAdvanceContextPrewarm();
    showToast(msg.metadata?.narratorBeat === true ? '已更新旁白' : '已更新气泡');
  }

  function canEditBubbleMessage(msg) {
    if (!msg || msg.recalled || msg.deleted) return false;
    if (msg.senderId === 'system' && msg.type !== 'system') return false;
    const blocked = new Set(['offlineStory', 'offlineInvite', 'gen_image', 'redpacket', 'transfer', 'voiceCall', 'link', 'location', 'arenaRoom', 'npcCard']);
    return !blocked.has(String(msg.type || ''));
  }

  async function insertBubbleByTypeAfter(anchorMsg) {
    const groupMembers = Object.entries(characters).map(([id, c]) => ({
      id,
      name: resolveUiActorName(id, c?.name || id),
    }));
    const draft = await openInsertBubbleAfterModal({
      anchorMsg,
      chatId,
      isGroupChat: isGroup,
      groupMembers,
      partnerId: partnerId || '',
      partnerName: resolveUiActorName(partnerId || '', partner?.name || partnerId || ''),
      currentUserName,
      includeGroupExtras: isGroup,
      variant: anonEditorVariant(),
    });
    if (!draft) return false;
    return insertMessageAfterAnchor(anchorMsg, async (timestamp) => ({ ...draft, timestamp }));
  }

  function openSingleMessageFavoriteEditor(msg, {
    dialogTitle = '收藏这条消息',
    favoriteTitle = '',
  } = {}) {
    if (!msg) return;
    openTextEditorModal({
      title: dialogTitle,
      placeholder: '备注（可不填）',
      confirmLabel: '收藏',
      variant: anonEditorVariant(),
      onSave: async (note) => {
        try {
          await saveChatMessageFavorite({
            userId: user.id,
            chat,
            messages: [msg],
            title: favoriteTitle || title || '聊天收藏',
            note,
            appearance: getChatAppearance(chat),
          });
          showToast('已收藏到记忆馆');
        } catch (err) {
          showToast(err?.message || '收藏失败');
        }
      },
    });
  }

  function bindSystemHintMenus() {
    container.querySelectorAll('.system-hint-row[data-msg-id], .chat-narration-row[data-msg-id]').forEach((row) => {
      if (row.dataset.chatBubbleMenuBound === '1') return;
      const msgId = row.getAttribute('data-msg-id');
      const msg = messages.find((m) => String(m?.id ?? '') === String(msgId || ''));
      if (!msg) return;
      row.dataset.chatBubbleMenuBound = '1';
      const isNarration = msg.metadata?.narratorBeat === true;
      const recallContent = String(msg.metadata?.recalledContent || '').trim();
      if (recallContent) {
        const line = row.querySelector('.recall-hint-line') || row;
        const card = row.querySelector('.recall-hint-card');
        line.addEventListener('click', () => {
          if (!card) return;
          card.hidden = !card.hidden;
          row.classList.toggle('is-open', !card.hidden);
        });
      }
      bindLongPress(row, ({ x, y }) => {
        openChatBubbleMenu({
          x,
          y,
          actions: [
            {
              label: '复制',
              onClick: async () => {
                const text = getMessageCopyText(msg);
                if (!text) {
                  showToast('当前消息无可复制内容');
                  return;
                }
                try {
                  if (await copyTextToClipboard(text)) showToast('已复制');
                  else showToast('复制失败');
                } catch {
                  showToast('复制失败');
                }
              },
            },
            ...(isNarration ? [{
              label: '编辑旁白',
              onClick: () => editBubbleMessage(msg),
            }, {
              label: '收藏旁白',
              onClick: () => openSingleMessageFavoriteEditor(msg, {
                dialogTitle: '收藏这段旁白',
                favoriteTitle: '旁白收藏',
              }),
            }] : []),
            {
              label: '多选',
              onClick: () => startBubbleSelection(msg.id),
            },
            {
              label: isNarration ? '删除旁白' : '删除系统提示',
              danger: true,
              onClick: async () => {
                await deleteVisibleMessagesOptimistically(msg);
                showToast('已删除');
              },
            },
          ],
        });
      });
    });
  }

  function bindStoryCardInteractions() {
    container.querySelectorAll('.story-card-row[data-msg-id]').forEach((row) => {
      const msgId = row.getAttribute('data-msg-id');
      // 兼容旧备份 / 跨端同步中的数字消息 id。data-* 读取结果一定是字符串；
      // 若这里严格比较，卡片仍能渲染，但展开、编辑、重roll 和长按都会完全没有监听器。
      const isStoryMessage = (message) => String(message?.id ?? '') === msgId;
      const msg = messages.find(isStoryMessage);
      if (!msg) return;

      const card = row.querySelector('[data-card-type="story-card"]');
      // keyed paint 会复用没有变化的小剧场 DOM。每次 refresh 若再绑一套
      // click，同一次点按就会连续翻转多次；监听器为偶数时最终回到原状态，
      // 表现为“卡住不能展开，再聊几句又突然好了”。
      if (!card || card.dataset.storyInteractionsBound === '1') return;
      card.dataset.storyInteractionsBound = '1';
      const editStoryCard = async () => {
        const fresh = messages.find(isStoryMessage) || msg;
        if (isReadOnlyStoryCardMessage(fresh)) return;
        const patch = await openEditBubbleModal(fresh, { variant: anonEditorVariant() });
        if (!patch) return;
        const next = {
          ...fresh,
          ...patch,
          metadata: patch.metadata !== undefined ? patch.metadata : fresh.metadata,
        };
        const localMutationRevision = markLocalMessageMutation(next.id, 'upsert', next);
        messages = messages.map((m) => (isStoryMessage(m) ? next : m));
        refreshMessages();
        try {
          await saveMessage(next);
          settleLocalMessageMutation(next.id, localMutationRevision);
        } catch (error) {
          const rollbackRevision = markLocalMessageMutation(fresh.id, 'upsert', fresh);
          settleLocalMessageMutation(fresh.id, rollbackRevision);
          messages = messages.map((m) => (isStoryMessage(m) ? fresh : m));
          refreshMessages();
          throw error;
        }
        await updateStoryCardKnowledgeByMessageId(
          next.id,
          next.metadata?.digest || next.metadata?.summary || next.content,
        ).catch(() => 0);
        const isLifeGlimpse = next.metadata?.storyKind === 'life_glimpse'
          || next.metadata?.lifeGlimpse === true;
        showToast(isLifeGlimpse ? '生活侧面已保存' : '小剧场已保存');
      };
      const deleteStoryCard = async () => {
        const fresh = messages.find(isStoryMessage) || msg;
        await deleteVisibleMessagesOptimistically(fresh);
        showToast('已删除');
      };
      const rerollLifeGlimpse = async (fresh) => {
        const md = fresh.metadata || {};
        const characterId = String(md.characterId || '').trim();
        const character = characters?.[characterId]
          || (String(partner?.id || '') === characterId ? partner : null);
        if (!character) throw new Error('找不到这张生活侧面对应的角色');
        const { regenerateAiLifeGlimpseCard } = await import('../core/chat/life-glimpse.js');
        const result = await regenerateAiLifeGlimpseCard({
          userId: user.id,
          chat,
          user,
          character,
          messages,
          card: fresh,
        });
        if (!result?.ok || !result.card) {
          throw new Error(result?.reason || '生活侧面重新生成失败');
        }
        const next = result.card;
        const localMutationRevision = markLocalMessageMutation(next.id, 'upsert', next);
        messages = messages.map((message) => (isStoryMessage(message) ? next : message));
        refreshMessages();
        try {
          await saveMessage(next);
          settleLocalMessageMutation(next.id, localMutationRevision);
        } catch (error) {
          const rollbackRevision = markLocalMessageMutation(fresh.id, 'upsert', fresh);
          settleLocalMessageMutation(fresh.id, rollbackRevision);
          messages = messages.map((message) => (isStoryMessage(message) ? fresh : message));
          refreshMessages();
          throw error;
        }
        await updateStoryCardKnowledgeByMessageId(
          next.id,
          next.metadata?.digest || next.metadata?.summary || next.content,
        ).catch(() => 0);
        return next;
      };
      let pointerStart = null;
      let pointerMoved = false;
      card?.addEventListener('pointerdown', (e) => {
        pointerStart = { x: e.clientX, y: e.clientY };
        pointerMoved = false;
      }, { passive: true });
      card?.addEventListener('pointermove', (e) => {
        if (!pointerStart) return;
        if (Math.abs(e.clientX - pointerStart.x) > 8 || Math.abs(e.clientY - pointerStart.y) > 8) {
          pointerMoved = true;
        }
      }, { passive: true });
      card?.addEventListener('pointercancel', () => {
        pointerMoved = true;
        pointerStart = null;
      }, { passive: true });
      card?.addEventListener('pointerup', () => {
        pointerStart = null;
      }, { passive: true });

      const toggleStoryCard = () => {
        const fresh = messages.find(isStoryMessage) || msg;
        const expanded = !fresh.metadata?.expanded;
        fresh.metadata = { ...(fresh.metadata || {}), expanded };
        messages = messages.map((m) => (isStoryMessage(m) ? { ...m, metadata: fresh.metadata } : m));
        card?.classList.toggle('story-card--expanded', expanded);
        card?.classList.toggle('story-card--collapsed', !expanded);
        card?.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        const label = card?.querySelector('[data-story-toggle-label]');
        if (label) label.textContent = expanded ? '收起' : '展开阅读';
        saveMessage(fresh).catch(() => {});
      };
      card?.addEventListener('click', (e) => {
        if (e.target.closest('[data-story-action="1"]')) return;
        if (pointerMoved) {
          pointerMoved = false;
          return;
        }
        toggleStoryCard();
      });
      card?.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        if (e.target.closest('[data-story-action="1"]')) return;
        e.preventDefault();
        toggleStoryCard();
      });

      row.querySelector('[data-story-edit="1"]')?.addEventListener('click', (e) => {
        e.stopPropagation();
        void editStoryCard();
      });

      row.querySelector('[data-story-delete="1"]')?.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!window.confirm('删除这张生活侧面卡片？')) return;
        try {
          await deleteStoryCard();
        } catch (error) {
          showToast(error?.message || '删除失败', 3500);
        }
      });

      row.querySelector('[data-story-continue="1"]')?.addEventListener('click', async (e) => {
        e.stopPropagation();
        const btn = e.currentTarget;
        if (btn?.dataset.busy === '1') return;
        const fresh = messages.find(isStoryMessage) || msg;
        if (isReadOnlyStoryCardMessage(fresh)) return;
        const md = fresh.metadata || {};
        btn.dataset.busy = '1';
        btn.classList.add('is-loading');
        btn.disabled = true;
        showToast('正在续写小剧场…');
        try {
          const { createOfflineStoryCard } = await import('../core/chat/offline-story-card.js');
          const nextCard = await createOfflineStoryCard({
            chat,
            chatId,
            user,
            messages,
          }, {
            // 一键续写只承接剧情，不暗中推进虚拟时间；原卡的时间跨度也不重复套用。
            mode: 'story',
            targetWords: Number(md.targetWords || 500) || 500,
            wordMin: Number(md.wordMin || 0) || 0,
            wordMax: Number(md.wordMax || 0) || 0,
            timeLabel: '',
            toneLabel: String(md.toneLabel || '').trim(),
            extraPrompt: '',
            participantIds: Array.isArray(md.participantIds) ? md.participantIds : undefined,
            userPresent: md.userPresent,
            presetStyleIds: Array.isArray(md.presetStyleIds) ? md.presetStyleIds : [],
          });
          if (!nextCard?.id) return;
          messages = await listThreadMessages();
          await recalcChatPreview(chatId);
          refreshMessages();
          showToast('已续写小剧场');
        } catch (err) {
          showToast(err?.message || '续写失败', 3500);
        } finally {
          btn.dataset.busy = '0';
          btn.classList.remove('is-loading');
          btn.disabled = false;
        }
      });

      row.querySelector('[data-story-reroll="1"]')?.addEventListener('click', async (e) => {
        e.stopPropagation();
        const btn = e.currentTarget;
        if (btn?.dataset.busy === '1') return;
        const fresh = messages.find(isStoryMessage) || msg;
        if (isReadOnlyStoryCardMessage(fresh)) return;
        const md = fresh.metadata || {};
        btn.dataset.busy = '1';
        btn.classList.add('is-loading');
        btn.disabled = true;
        const isLifeGlimpse = fresh.metadata?.storyKind === 'life_glimpse'
          || fresh.metadata?.lifeGlimpse === true;
        showToast(isLifeGlimpse ? '正在重新生成生活侧面…' : '正在重roll小剧场…');
        try {
          if (isLifeGlimpse) {
            await rerollLifeGlimpse(fresh);
            showToast('生活侧面已重新生成');
            return;
          }
          const { createOfflineStoryCard } = await import('../core/chat/offline-story-card.js');
          const nextCard = await createOfflineStoryCard({
            chat,
            chatId,
            user,
            messages,
          }, {
            mode: String(md.mode || 'time+story'),
            targetWords: Number(md.targetWords || 500) || 500,
            wordMin: Number(md.wordMin || 0) || 0,
            wordMax: Number(md.wordMax || 0) || 0,
            timeLabel: String(md.timeLabel || '').trim(),
            toneLabel: String(md.toneLabel || '').trim(),
            extraPrompt: String(md.extraPrompt || '').trim(),
            participantIds: Array.isArray(md.participantIds) ? md.participantIds : undefined,
            userPresent: md.userPresent,
            presetStyleIds: Array.isArray(md.presetStyleIds) ? md.presetStyleIds : [],
            excludePreviousStoryCardId: fresh.id,
          });
          if (!nextCard?.id) return;
          const replacementComplete = String(nextCard.metadata?.generationStatus || 'complete') === 'complete';
          if (replacementComplete) await deleteMessage(fresh.id);
          messages = await listThreadMessages();
          await recalcChatPreview(chatId);
          refreshMessages();
          showToast(replacementComplete ? '已重roll小剧场' : '本次返回未完成，已保留原卡与原始返回');
        } catch (err) {
          showToast(err?.message || (isLifeGlimpse ? '生活侧面重新生成失败' : '重roll失败'), 3500);
        } finally {
          btn.dataset.busy = '0';
          btn.classList.remove('is-loading');
          btn.disabled = false;
        }
      });

      bindLongPress(card || row, ({ x, y }) => {
        const fresh = messages.find(isStoryMessage) || msg;
        const isReadOnly = isReadOnlyStoryCardMessage(fresh);
        const isLifeGlimpse = fresh.metadata?.storyKind === 'life_glimpse'
          || fresh.metadata?.lifeGlimpse === true;
        openChatBubbleMenu({
          x,
          y,
          actions: [
            ...(!isReadOnly ? [{
              label: isLifeGlimpse ? '编辑生活侧面' : '编辑小剧场',
              onClick: () => { void editStoryCard(); },
            }, ...(isLifeGlimpse ? [{
              label: '重新生成生活侧面',
              onClick: async () => {
                try {
                  showToast('正在重新生成生活侧面…');
                  await rerollLifeGlimpse(fresh);
                  showToast('生活侧面已重新生成');
                } catch (error) {
                  showToast(error?.message || '生活侧面重新生成失败', 3500);
                }
              },
            }] : [])] : []),
            {
              label: '复制正文',
              onClick: async () => {
                const text = getMessageCopyText(fresh);
                if (!text) return;
                try {
                  if (await copyTextToClipboard(text)) showToast('已复制');
                  else showToast('复制失败');
                } catch {
                  showToast('复制失败');
                }
              },
            },
            {
              label: isLifeGlimpse ? '删除生活侧面' : '删除小剧场',
              danger: true,
              onClick: async () => {
                const prompt = isLifeGlimpse ? '删除这张生活侧面卡片？' : '删除这张线下小剧场卡片？';
                if (!window.confirm(prompt)) return;
                await deleteStoryCard();
              },
            },
          ],
        });
      });
    });
  }

  function startBubbleSelection(initialMessageId = '') {
    const input = container.querySelector('.chat-composer-input');
    if (document.activeElement === input) input.blur();
    closeToolsSheet();
    selectionMode = true;
    selectionPurpose = 'capture';
    selectedSet.clear();
    if (initialMessageId) selectedSet.add(String(initialMessageId));
    refreshSelectionUi();
    showToast(initialMessageId ? '已选中 1 条，可继续勾选' : '已开启多选');
  }

  function openBubbleContextMenu(msg, x, y) {
    if (!msg) return;
    if (msg.senderId === 'system') {
      openChatBubbleMenu({
        x,
        y,
        actions: [
          {
            label: '复制',
            onClick: async () => {
              const text = getMessageCopyText(msg);
              if (!text) { showToast('当前消息无可复制内容'); return; }
              try {
                if (await copyTextToClipboard(text)) showToast('已复制');
                else showToast('复制失败');
              } catch {
                showToast('复制失败');
              }
            },
          },
          {
            label: '多选',
            onClick: () => startBubbleSelection(msg.id),
          },
          {
            label: '删除',
            danger: true,
            onClick: async () => {
              await deleteVisibleMessagesOptimistically(msg);
              showToast('已删除');
            },
          },
        ],
      });
      return;
    }
    const voiceRoundId = String(msg?.metadata?.aiRoundId || '').trim();
    const voiceRoundMessages = voiceRoundId
      ? messages.filter((item) => String(item?.metadata?.aiRoundId || '').trim() === voiceRoundId)
      : [];
    const voiceExport = getCachedVoiceExportAvailability(msg, voiceRoundMessages);
    const voiceActorName = resolveUiActorName(msg.senderId, msg.senderName || '角色');
    const voiceFilenameBase = `${voiceActorName}-${String(msg.content || msg.metadata?.text || '语音').slice(0, 22)}`;
    const voiceRoundFilenameBase = `${title || voiceActorName}-本轮语音`;
    const voiceRoundMixFilenameBase = `${title || voiceActorName}-本轮混音`;
    openChatBubbleMenu({
      x,
      y,
      actions: [
        {
          label: '回复',
          onClick: () => setReplyTo(msg),
        },
        {
          label: '转发',
          onClick: () => forwardMessage(msg),
        },
        {
          label: '插入后续气泡',
          onClick: () => insertBubbleByTypeAfter(msg),
        },
        ...(canEditBubbleMessage(msg) ? [{
          label: '编辑气泡',
          onClick: () => editBubbleMessage(msg),
        }] : []),
        ...(canRerollGeneratedImage(msg) ? [{
          label: msg.metadata?.generationRemoteUrl
            ? '重试保存图片'
            : (msg.metadata?.generatingImage ? '查看生图状态' : '重 roll 生图'),
          onClick: async () => {
            if (!confirmUnknownImageReplay(msg)) return;
            try {
              await rerollGenImageFromUi(msg);
              showToast('图片已更新');
            } catch (err) {
              showToast(`生图失败：${String(err?.message || err).slice(0, 80)}`);
            }
          },
        }, {
          label: '改提示词重画',
          onClick: () => openGenImagePromptEditor(msg),
        }] : []),
        ...(msg.type === 'image' && String(msg.content || msg.metadata?.url || '').trim() ? [{
          label: '查看大图',
          onClick: () => openGenImageLightbox(msg),
        }] : []),
        ...(canReadTextBubbleAsVoice(msg) ? [{
          label: isVoiceMessagePlaybackActive(msg.id) ? '停止朗读' : '朗读',
          onClick: async (event) => {
            const stopping = isVoiceMessagePlaybackActive(msg.id);
            try {
              if (!stopping) showToast('正在准备朗读…', 1600);
              await playTextBubbleAsVoice(msg, {
                gestureToken: captureMediaGesture(event),
                onRefresh: () => refreshMessages(),
              });
              if (stopping) showToast('已停止朗读');
            } catch (err) {
              if (isVoiceTtsSkipError(err)) {
                showToast('TA 还没有开启可用声线');
                return;
              }
              console.warn('[text-bubble-voice]', err);
              showToast(`朗读失败：${err?.message || err}`);
            }
          },
        }] : []),
        ...(voiceExport.segment ? [{
          label: '导出缓存语音',
          onClick: async () => {
            showToast('正在整理缓存语音…', 1200);
            try {
              const result = await exportCachedTextBubbleVoice(msg, {
                roundMessages: voiceRoundMessages,
                bubbleGapMs: chatPrefs?.voicePerformanceBubbleGapMs,
                filenameBase: voiceFilenameBase,
              });
              showToast(result?.message || '语音已导出');
            } catch (err) {
              showToast(`导出失败：${err?.message || err}`);
            }
          },
        }] : []),
        ...(voiceExport.round ? [{
          label: chatPrefs?.narrationSoundEffectsEnabled === true ? '导出本轮混音' : '导出本轮语音',
          onClick: async () => {
            const mixedExport = chatPrefs?.narrationSoundEffectsEnabled === true;
            showToast(mixedExport ? '正在生成本轮混音…' : '正在合并本轮缓存语音…', 1400);
            try {
              const result = await exportCachedTextBubbleRoundVoice(voiceRoundMessages, {
                roundId: voiceRoundId,
                bubbleGapMs: chatPrefs?.voicePerformanceBubbleGapMs,
                filenameBase: mixedExport ? voiceRoundMixFilenameBase : voiceRoundFilenameBase,
                soundEffectsEnabled: mixedExport,
                soundOwnerId: user.id,
                soundEffectsVolume: chatPrefs?.narrationSoundEffectsVolume,
                backgroundVolume: chatPrefs?.narrationBackgroundVolume,
              });
              showToast(result?.message || (mixedExport ? '本轮混音已导出' : '本轮语音已导出'));
            } catch (err) {
              showToast(`导出失败：${err?.message || err}`, 3200);
            }
          },
        }] : []),
        {
          label: '复制',
          onClick: async () => {
            const text = getMessageCopyText(msg);
            if (!text) {
              showToast('当前消息无可复制内容');
              return;
            }
            try {
              if (await copyTextToClipboard(text)) showToast('已复制');
              else showToast('复制失败');
            } catch {
              showToast('复制失败');
            }
          },
        },
        ...(msg.senderId !== 'user' ? [{
          label: '表情回应',
          onClick: async () => {
            const emoji = await openEmojiReactionPicker({ variant: anonEditorVariant() });
            if (!emoji) return;
            const updated = await applyEmojiReactionToMessage(msg.id, emoji, { byUser: true });
            if (updated) {
              messages = messages.map((m) => (m.id === msg.id ? updated : m));
              refreshMessages();
            }
          },
        }] : []),
        {
          label: '收藏',
          onClick: () => openSingleMessageFavoriteEditor(msg),
        },
        {
          label: '多选',
          onClick: () => startBubbleSelection(msg.id),
        },
        {
          label: '撤回',
          onClick: async () => recallMessage(msg),
        },
        {
          label: msg.type === 'voice' ? '删除这条语音' : '删除',
          danger: true,
          onClick: async () => {
            await deleteVisibleMessagesOptimistically(msg);
            showToast('已删除');
          },
        },
      ],
    });
  }

  function bindBubbleMenuRow(row) {
    if (!row || row.dataset.chatBubbleMenuBound === '1') return;
    row.dataset.chatBubbleMenuBound = '1';
    bindLongPress(row, ({ x, y }) => {
      const msgId = row.getAttribute('data-msg-id');
      const msg = messages.find((m) => String(m?.id ?? '') === String(msgId || ''));
      openBubbleContextMenu(msg, x, y);
    });
  }

  function bindBubbleMenus() {
    const concreteSelector = '.chat-msg-bubble[data-msg-id], .chat-msg-card[data-msg-id], .chat-msg-media[data-msg-id]';
    container.querySelectorAll(concreteSelector).forEach(bindBubbleMenuRow);
    container.querySelectorAll('.chat-bubble-row[data-msg-id]:not(.is-stack-group)').forEach((row) => {
      // 普通消息优先绑定真实气泡节点；整行只给没有气泡子节点的特殊消息兜底。
      // 否则事件冒泡会让同一次长按启动两套计时器，Android WebView 上会连续
      // 替换菜单并遗留 document 监听，积累后表现为菜单点不动、页面像卡死。
      if (!row.querySelector(concreteSelector)) bindBubbleMenuRow(row);
    });
  }

  function resolveCharStateAvatarUrl(characterId) {
    if (isAnonymousChat(chat)) {
      const profile = getAnonymousDisplayProfile(chat, characterId, { currentUserName, spaceProfile: anonSpaceProfile });
      return profile?.avatar || '';
    }
    if (strangerChat) {
      const identity = visibleIdentityFor(
        chat.metadata,
        principalKey('character', characterId),
        characters[characterId] || partner || {},
      );
      if (identity?.avatar) return identity.avatar;
    }
    const row = characters[characterId] || (characterId === partnerId ? partner : null);
    return row?.avatar || '';
  }

  async function showCharStatePopover(characterId, fallbackName = '') {
    if (!isInnerVoiceVisible()) {
      showToast(chatPrefs?.innerVoiceDisabled === true ? '本会话已关闭心声' : '本会话已隐藏心声');
      return;
    }
    const openedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
    let displayName = fallbackName || characters[characterId]?.name || characterId;
    if (isAnonymousChat(chat)) {
      const profile = getAnonymousDisplayProfile(chat, characterId, { currentUserName, spaceProfile: anonSpaceProfile });
      displayName = profile?.anonymousId || fallbackName || characterId;
    } else if (strangerChat) {
      const identity = visibleIdentityFor(
        chat.metadata,
        principalKey('character', characterId),
        characters[characterId] || partner || {},
      );
      if (identity?.displayName) displayName = identity.displayName;
    }
    const popover = openCharStatePopover({
      name: displayName,
      loading: true,
      chatId,
      characterId,
      userId: user.id,
      avatarUrl: resolveCharStateAvatarUrl(characterId),
      // 棉花糖之窗/之海默认走 ins 小白卡，会话自己选过骨架的话仍以会话设置为准。
      card: getInnerVoiceCard(chat, (windowChatTheme || seaChatTheme) ? 'ins' : 'diary'),
    });
    // 顶栏人物状态与心声是两套数据，刷新顶栏不应阻塞弹层。
    if (!isGroup && characterId === partnerId && !observerLike && !fromCharacterPhone) {
      void refreshHeaderStatus().catch(() => {});
    }
    try {
      // 弹层卡片、头像和名称都已来自当前页的 chat 快照；点击时再回读
      // 整条会话只会和心声 settings 读取争用存储事务，对显示内容没有帮助。
      const allowLegacyUnscopedState = await canReadLegacyUnscopedChatState(chatId, user?.id || '');
      const state = filterChatCharStateForUser(
        await loadChatCharState(chatId),
        user?.id || '',
        { allowLegacyUnscoped: allowLegacyUnscopedState },
      );
      const s = state?.[characterId] || {};
      popover.update?.({
        name: s.name || displayName,
        inner: s.inner || '',
        innerTranslation: s.innerTranslation || '',
        intent: s.intent || '',
        mood: s.mood || '',
        // 心声状态是最近一轮 state.status 的快照，不使用顶栏实时状态覆盖。
        status: s.status || '',
        moodValue: s.moodValue,
        custom: s.custom || {},
      });
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      const durationMs = Math.max(0, Math.round(now - openedAt));
      if (durationMs >= 80) {
        console.debug('[ui-perf] inner-voice', { durationMs, chatId, characterId });
        import('../core/debug-log.js').then(({ appendDebugEvent }) => appendDebugEvent({
          type: 'ui_phase_timing',
          level: 'info',
          message: `UI timing: inner-voice (${durationMs}ms)`,
          context: { feature: 'inner-voice', durationMs, chatId, characterId },
        })).catch(() => {});
      }
    } catch (_) {
      popover.fail?.();
    }
  }

  function cancelPendingAvatarSingleClick() {
    if (avatarSingleClickTimer) window.clearTimeout(avatarSingleClickTimer);
    avatarSingleClickTimer = 0;
  }

  function scheduleAvatarSingleClick(action) {
    cancelPendingAvatarSingleClick();
    // 第一击先给 dblclick 留出判定窗口；否则心声弹层会在第二击前接管页面，
    // Android WebView / 移动浏览器就无法把完整双击交给“拍一拍”。
    avatarSingleClickTimer = window.setTimeout(() => {
      avatarSingleClickTimer = 0;
      if (pageDisposed) return;
      action();
    }, 320);
  }

  addPageLifetimeListener(window, INNER_VOICE_CARD_CHANGED_EVENT, (event) => {
    if (String(event?.detail?.chatId || '') !== String(chatId || '')) return;
    const nextGroupSettings = { ...(chat.groupSettings || {}) };
    const nextCard = event?.detail?.card;
    if (nextCard && typeof nextCard === 'object') nextGroupSettings.innerVoiceCard = nextCard;
    else delete nextGroupSettings.innerVoiceCard;
    chat = { ...chat, groupSettings: nextGroupSettings };
    closeCharStatePopover();
    refreshMessages();
  });

  function openAnonymousAvatarMenu(actorId, fallbackName = '') {
    const profile = getAnonymousDisplayProfile(chat, actorId, { currentUserName, spaceProfile: anonSpaceProfile });
    const titleText = profile?.anonymousId || fallbackName || '匿名网友';
    const actions = [];
    if (isInnerVoiceVisible()) {
      actions.push({
        label: '查看心声',
        onClick: async () => showCharStatePopover(actorId, titleText),
      });
    }
    actions.push(
      {
        label: '打开匿名私聊',
        onClick: async () => {
          const dm = await createAnonymousPrivateFromGroup({
            userId: user.id,
            userRow: user,
            sourceChat: chat,
            counterpartActorId: actorId,
          });
          await buildAnonymousContactEntry({
            userId: user.id,
            chat,
            actorId,
            privateChatId: dm.id,
          }).catch(() => null);
          navigate('chat/thread', { chatId: dm.id, from: 'anon' });
        },
      },
      {
        label: '保存匿名联系人',
        onClick: async () => {
          await buildAnonymousContactEntry({
            userId: user.id,
            chat,
            actorId,
          });
          showToast('已保存匿名联系人');
        },
      },
    );
    openChatRowSheet({
      chatTitle: titleText,
      actions,
    });
  }

  function enterScrollCaptureMode() {
    const messagesEl = container.querySelector('.chat-thread-messages');
    if (!messagesEl) return;
    const root = document.documentElement;
    const maxScroll = Math.max(0, messagesEl.scrollHeight - messagesEl.clientHeight);
    const ratio = maxScroll > 0 ? messagesEl.scrollTop / maxScroll : 1;
    messagesEl.dataset.captureScrollRatio = String(ratio);
    root.classList.add('chat-scroll-capture-mode');
    container.classList.add('is-scroll-capture-mode');
    setTimeout(() => {
      const pageMax = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
      window.scrollTo({ top: Math.round(pageMax * ratio), behavior: 'auto' });
      showToast('已进入长截图模式，截完点顶部退出');
    }, 80);
  }

  function exitScrollCaptureMode() {
    const messagesEl = container.querySelector('.chat-thread-messages');
    const root = document.documentElement;
    const ratio = Number(messagesEl?.dataset?.captureScrollRatio || '1');
    root.classList.remove('chat-scroll-capture-mode');
    container.classList.remove('is-scroll-capture-mode');
    if (messagesEl) delete messagesEl.dataset.captureScrollRatio;
    requestAnimationFrame(() => {
      if (!messagesEl) return;
      const maxScroll = Math.max(0, messagesEl.scrollHeight - messagesEl.clientHeight);
      messagesEl.scrollTop = Math.round(maxScroll * (Number.isFinite(ratio) ? ratio : 1));
    });
  }

  function bindMessagesScrollHold() {
    const main = container.querySelector('.chat-thread-messages');
    if (!main || main.dataset.holdBottomBound === '1') return;
    main.dataset.holdBottomBound = '1';
    // 手指还在消息区滑动时，键盘/视口抖动触发的 ResizeObserver 不要抢 scrollTop，
    // 否则「正在输入框里打字时想往上翻记录」会被反复拽回底部。
    let messagesPointerDown = false;
    let messagesWheelActiveUntil = 0;
    let messagesTouchScrollUntil = 0;
    let messagesTouchMoved = false;
    let messagesTouchStart = null;
    let scrollUiRaf = 0;
    const scheduleScrollUiRefresh = () => {
      if (scrollUiRaf) return;
      scrollUiRaf = requestAnimationFrame(() => {
        scrollUiRaf = 0;
        updateScrollBottomFab();
      });
    };
    const markUserScrolling = (duration = 700) => {
      userScrollingMessagesUntil = Math.max(userScrollingMessagesUntil, Date.now() + duration);
    };
    const setMessagesPointerDown = (down) => { messagesPointerDown = !!down; };
    const hasUserScrollIntent = () => messagesPointerDown
      || Date.now() < messagesWheelActiveUntil
      || Date.now() < messagesTouchScrollUntil;
    const clearMessagesTouch = () => {
      if (messagesTouchMoved) {
        messagesTouchScrollUntil = Date.now() + 700;
        markUserScrolling();
        // iOS 在底部回弹时，最后一次 touchmove 可能没有对应的 scroll 事件。
        // 手指抬起再以真实位置收口，避免刚恢复的跟随状态又被末次移动关掉。
        if (isNearBottom(main, 48)) beginFollowingLatestMessages();
        else scheduleStableHistoryViewportCapture(900);
      }
      messagesTouchStart = null;
      messagesTouchMoved = false;
      setMessagesPointerDown(false);
    };
    main.addEventListener('touchstart', (e) => {
      const touch = e.touches?.[0];
      messagesTouchStart = touch
        ? { x: Number(touch.clientX || 0), y: Number(touch.clientY || 0) }
        : null;
      // 轻点消息本身不是上滑意图；等 touchmove 越过阈值后再占用滚动控制权。
      setMessagesPointerDown(false);
    }, { passive: true });
    main.addEventListener('touchmove', (e) => {
      const touch = e.touches?.[0];
      if (!touch || !messagesTouchStart) return;
      const dx = Number(touch.clientX || 0) - messagesTouchStart.x;
      const dy = Number(touch.clientY || 0) - messagesTouchStart.y;
      // 在首个原生 scroll 事件前先停掉 RAF / 定时补钉；否则二者会和手势逐帧争夺
      // scrollTop，在 iOS Safari 与 Android WebView 上表现为拉不动和页面抖动。
      if (Math.abs(dy) >= 6 && Math.abs(dy) > Math.abs(dx)) {
        messagesTouchMoved = true;
        messagesTouchScrollUntil = Date.now() + 700;
        markUserScrolling();
        setMessagesPointerDown(true);
        releaseBottomHoldForUserScroll();
      }
    }, { passive: true });
    main.addEventListener('touchend', clearMessagesTouch, { passive: true });
    main.addEventListener('touchcancel', clearMessagesTouch, { passive: true });
    main.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch') return;
      setMessagesPointerDown(true);
    }, { passive: true });
    main.addEventListener('pointerup', () => {
      setMessagesPointerDown(false);
      scheduleStableHistoryViewportCapture(120);
    }, { passive: true });
    main.addEventListener('pointercancel', () => {
      setMessagesPointerDown(false);
      scheduleStableHistoryViewportCapture(120);
    }, { passive: true });
    main.addEventListener('wheel', () => {
      messagesWheelActiveUntil = Date.now() + 240;
      markUserScrolling(320);
      releaseBottomHoldForUserScroll();
    }, { passive: true });
    main.addEventListener('scroll', () => {
      const userScrollIntent = hasUserScrollIntent();
      // 输入框的 auto-height 测量会在部分 Android WebView 中间态派发一次 scroll。
      // 这不是新消息或键盘重排，不能被下面的“跟随最新”分支再次吸到底。
      if (!userScrollIntent && Date.now() < composerViewportRestoreUntil) {
        scheduleScrollUiRefresh();
        return;
      }
      if (userScrollIntent) markUserScrolling();
      // 真实手势已经滑回底部时，应重新进入“跟随最新”。以前 hold 一旦
      // 因上翻被关闭就不会自行恢复，后台回复的写库广播又会先撑高长列表，
      // 于是随后的 generated 刷新只会恢复旧历史锚点。
      if (userScrollIntent && !holdBottomUntilSettled && isNearBottom(main, 48)) {
        beginFollowingLatestMessages();
      }
      if (userScrollIntent && !holdBottomUntilSettled) scheduleStableHistoryViewportCapture(180);
      if (holdBottomUntilSettled && !isNearBottom(main, 48)) {
        // 进页钉底 / scrollToBottom 的 RAF 过程中，内容高度还在长（图片、贴纸二次渲染），
        // 会误触发「用户主动上滑」而把 holdBottomUntilSettled 提前关掉。
        if (!suppressThreadScrollFlash) {
          const streaming = isStreaming || !!getChatStreamSession(chatId);
          // pending 气泡已经预留布局高度，揭示期间只跟随当前一条，不再强制跳到
          // 整个隐藏队列的底部；同时保留 hold，用户真实手势仍可立即释放。
          if (isBubbleRevealActive() && !userScrollIntent) {
            return;
          }
          // 推进后键盘收起会改 clientHeight，仅短窗口内偏离底部要钉回去。
          // 不要再用「距底 160px 内」整段锁死——从底部出发永远翻不出 160px，
          // 「正在输入」期间就没法往前翻记录。
          if (streaming && Date.now() < streamPinGuardUntil && !userScrollIntent) {
            main.scrollTop = main.scrollHeight;
            return;
          }
          if (userScrollIntent) {
            releaseBottomHoldForUserScroll();
          } else {
            // 键盘重排、占位移除、图片/心声补高度也会派发 scroll；它们不是用户上滑。
            // 保留“跟随最新消息”，否则下一轮整表重绘会按旧像素值跳回历史记录。
            main.scrollTop = main.scrollHeight;
            return;
          }
        }
      }
      scheduleScrollUiRefresh();
    }, { passive: true });
    if (typeof ResizeObserver === 'function') {
      const fabResizeObserver = new ResizeObserver(() => {
        positionScrollBottomFab();
      });
      fabResizeObserver.observe(main);
    }
    positionScrollBottomFab();
    updateScrollBottomFab();
  }

  function bindChatPressFeedback() {
    const pressSelector = [
      '.chat-composer-send',
      '.chat-composer-btn',
      '.chat-anon-icon-btn',
      '.chat-anon-send',
      '.chat-anon-inline-btn',
      '.chat-anon-tool',
      '.chat-tool-item',
      '.chat-thread-scrollbottom-fab',
      '[data-tools]',
      '[data-stickers]',
      '[data-pick-image]',
      '[data-transcribe]',
    ].join(', ');
    const clearPressStates = () => {
      container.querySelectorAll(`${pressSelector}.is-pressed`).forEach((el) => el.classList.remove('is-pressed'));
    };
    container.addEventListener('pointerdown', (e) => {
      const btn = e.target.closest(pressSelector);
      if (!btn || btn.disabled || !container.contains(btn)) return;
      btn.classList.add('is-pressed');
    }, true);
    container.addEventListener('pointerup', clearPressStates, true);
    container.addEventListener('pointercancel', clearPressStates, true);
  }

  // "+"工具面板（尤其 ins/anon 主题下横向两行滑动的图标条）几乎没有空白缝隙可抓，
  // 手指在图标上小幅度横滑准备翻页时，iOS 上仍可能把这次触摸合成为一次 click，
  // 命中"文字图/链接"之类的项直接弹出对应编辑器并唤起键盘，跟还开着的工具面板叠在一起。
  // 用 pointerdown→pointermove 的位移量识别"这其实是一次拖动"，在事件到达具体按钮前
  // （捕获阶段）就拦掉由拖动触发的 click，真正的点按（几乎不产生位移）不受影响。
  function bindToolsSheetDragGuard() {
    const DRAG_THRESHOLD = 10;
    let start = null;
    let dragged = false;
    container.addEventListener('pointerdown', (e) => {
      if (!e.target.closest?.('.chat-tools-sheet')) {
        start = null;
        return;
      }
      start = { x: e.clientX, y: e.clientY };
      dragged = false;
    }, true);
    container.addEventListener('pointermove', (e) => {
      if (!start) return;
      const dx = Math.abs(e.clientX - start.x);
      const dy = Math.abs(e.clientY - start.y);
      if (dx > DRAG_THRESHOLD || dy > DRAG_THRESHOLD) dragged = true;
    }, true);
    const endGesture = () => { start = null; };
    container.addEventListener('pointerup', endGesture, true);
    container.addEventListener('pointercancel', endGesture, true);
    container.addEventListener('click', (e) => {
      if (!dragged) return;
      dragged = false;
      if (!e.target.closest?.('.chat-tools-sheet')) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    }, true);
  }

  function bind() {
    if (!container.__chatThreadDelegated) {
      container.__chatThreadDelegated = true;
      bindChatPressFeedback();
      bindToolsSheetDragGuard();

      container.addEventListener('click', (e) => {
        const fabBtn = e.target.closest('[data-scroll-bottom]');
        if (!fabBtn || !container.contains(fabBtn)) return;
        beginFollowingLatestMessages();
        scrollToBottom();
        updateScrollBottomFab();
      });

      // 生图结果链接失效时：立刻落成失败占位，避免破图半透明反复闪
      container.addEventListener('marshmallow-gen-image-broken', (e) => {
        const wrap = e.target?.closest?.('[data-generated-image-id]');
        const msgId = wrap?.getAttribute?.('data-generated-image-id') || '';
        if (!msgId) return;
        const idx = messages.findIndex((m) => m?.id === msgId);
        if (idx < 0) return;
        const cur = messages[idx];
        if (cur?.metadata?.generationFailed && !cur.content) return;
        messages[idx] = {
          ...cur,
          content: '',
          metadata: {
            ...(cur.metadata || {}),
            generatingImage: false,
            generationFailed: true,
            generationError: String(cur.metadata?.generationError || '图片已失效').slice(0, 160),
          },
        };
        lastPaintSnapshot = null;
        refreshMessages();
        saveMessage(messages[idx]).catch(() => {});
      });

      // 旧版本可能把短时效远程 URL 当作成功生图保存。只要历史图此刻还能加载，
      // 就立即补转为本地 data URL；转存失败不打断浏览，也不覆盖当前仍可见的图片。
      container.addEventListener('marshmallow-gen-image-loaded', (e) => {
        const wrap = e.target?.closest?.('[data-generated-image-id]');
        const msgId = wrap?.getAttribute?.('data-generated-image-id') || '';
        if (!msgId) return;
        const before = messages.find((message) => message?.id === msgId);
        const remoteUrl = String(before?.content || before?.metadata?.url || '').trim();
        if (!/^https?:\/\//i.test(remoteUrl)) return;
        localizeLegacyGeneratedImageMessage(msgId)
          .then((localUrl) => {
            if (!localUrl) return;
            const idx = messages.findIndex((message) => message?.id === msgId);
            if (idx < 0) return;
            const currentUrl = String(messages[idx]?.content || messages[idx]?.metadata?.url || '').trim();
            if (currentUrl !== remoteUrl) return;
            messages[idx] = {
              ...messages[idx],
              content: localUrl,
              metadata: {
                ...(messages[idx].metadata || {}),
                url: '',
                generatedImageStoredLocally: true,
              },
            };
          })
          .catch((error) => console.warn('[chat-generated-image-localize]', error));
      });

      // 键盘弹起/收起引起可用高度变化时，只在“确实贴底”时跟随底部。
      // 旧阈值 120px 会把只是靠近底部的阅读位置也强行吸到底；再叠加 focus 时的
      // 多帧 scrollToBottom，输入和回复期间便会表现成消息区上下跳。
      const messagesElForGesture = () => container.querySelector('.chat-thread-messages');
      let stickToBottomOnResize = isNearBottom(messagesElForGesture(), 24);
      let messagesGestureActive = false;
      container.addEventListener('touchstart', (e) => {
        if (e.target.closest?.('.chat-thread-messages')) messagesGestureActive = true;
      }, true);
      container.addEventListener('touchend', () => { messagesGestureActive = false; }, true);
      container.addEventListener('touchcancel', () => { messagesGestureActive = false; }, true);
      // Some legacy Android WebViews occasionally drop the synthesized click/focus
      // for a textarea inside the composer's grid. Restore focus during the trusted
      // touch gesture without cancelling the native event or interfering with scroll.
      container.addEventListener('touchend', (e) => {
        const inputEl = e.target.closest?.('.chat-composer-input');
        if (!inputEl || inputEl.disabled || inputEl.readOnly || !container.contains(inputEl)) return;
        if (document.activeElement === inputEl) return;
        try {
          inputEl.focus({ preventScroll: true });
        } catch (_) {
          inputEl.focus();
        }
        try {
          inputEl.selectionStart = inputEl.selectionEnd = inputEl.value.length;
        } catch (_) {}
      }, { passive: true, capture: true });
      container.addEventListener('scroll', (e) => {
        const t = e.target;
        if (!t || !t.classList || !t.classList.contains('chat-thread-messages')) return;
        stickToBottomOnResize = isNearBottom(t, 24);
      }, true);
      if (typeof ResizeObserver === 'function') {
        let lastContainerH = 0;
        let resizeStickRaf = 0;
        const ro = new ResizeObserver((entries) => {
          const h = entries[entries.length - 1]?.contentRect?.height || 0;
          if (!h || Math.abs(h - lastContainerH) < 1) return;
          lastContainerH = h;
          if (!stickToBottomOnResize || messagesGestureActive) return;
          // 一帧只保留最后一次尺寸结果，避免键盘动画和气泡排版各写一次 scrollTop。
          if (resizeStickRaf) cancelAnimationFrame(resizeStickRaf);
          resizeStickRaf = requestAnimationFrame(() => {
            resizeStickRaf = 0;
            if (!stickToBottomOnResize || messagesGestureActive) return;
            const main = messagesElForGesture();
            if (main) main.scrollTop = main.scrollHeight;
          });
        });
        ro.observe(container);
        addPageLifetimeCleanup(() => {
          ro.disconnect();
          if (resizeStickRaf) cancelAnimationFrame(resizeStickRaf);
          resizeStickRaf = 0;
        });
      }

      container.addEventListener('pointerdown', (e) => {
        const sendBtn = e.target.closest('.chat-composer-send');
        const targetBtn = sendBtn;
        if (!targetBtn) return;
        const intendedAction = composerSendButtonState().mode;
        const gesture = controlGestureLatch.begin({
          target: targetBtn,
          action: intendedAction,
          pointerId: e.pointerId,
        });
        if (tryHandleStopGesture(e, intendedAction)) {
          controlGestureLatch.markHandled(gesture);
          return;
        }
        const inputEl = container.querySelector('.chat-composer-input');
        if (!inputEl || inputEl.disabled) return;
        if (document.activeElement !== inputEl) return;
        if (targetBtn.disabled) return;
        // 阻止按钮抢焦点引发的原生失焦/重新聚焦抖动
        e.preventDefault();
        if (sendBtn) {
          // 发送：保持输入框聚焦，方便连续打字（键盘不收起）
          try {
            inputEl.focus({ preventScroll: true });
          } catch (_) {
            inputEl.focus();
          }
        }
        // 推进 / 重 roll 等动作：preventDefault 已阻止按钮抢焦点（键盘不会重新弹起）。
        // 这里不要同步 blur —— 收起键盘引发的视口重排会让按钮位移，本次点击落空；
        // 改到 handleAction 里动作真正开始后再收起键盘，保证一次点击即生效。
      }, true);

      // Older Android WebViews may not synthesize click after the textarea becomes disabled.
      container.addEventListener('touchend', (e) => {
        const sendBtn = e.target.closest?.('.chat-composer-send');
        const actionBtn = sendBtn ? null : e.target.closest?.('[data-act="stop"]');
        const targetBtn = sendBtn || actionBtn;
        const gesture = controlGestureLatch.peek(targetBtn);
        if (tryHandleStopGesture(e, gesture?.action || '')) {
          controlGestureLatch.markHandled(gesture);
        }
      }, { passive: false, capture: true });
      container.addEventListener('pointercancel', (e) => {
        controlGestureLatch.cancel(e.pointerId);
      }, true);

      container.addEventListener('dblclick', (e) => {
        const avatarBtn = e.target.closest('.chat-bubble-avatar[data-msg-id]');
        if (!avatarBtn || !container.contains(avatarBtn)) return;
        cancelPendingAvatarSingleClick();
        const msgId = avatarBtn.getAttribute('data-msg-id');
        const msg = messages.find((m) => m.id === msgId);
        if (!msg || msg.senderId === 'user' || msg.senderId === 'system' || msg.senderId === GUIDANCE_SENDER_ID) return;
        e.preventDefault();
        e.stopPropagation();
        closeCharStatePopover();
        openPokeActionModal(msg).catch((err) => showToast(err?.message || '拍一拍失败'));
      });

      // 工具面板横向翻页时同步底部圆点（scroll 不冒泡，用捕获段监听）
      container.addEventListener('scroll', (e) => {
        const pager = e.target;
        if (!(pager instanceof Element) || !pager.hasAttribute('data-tools-pager')) return;
        const idx = Math.round(pager.scrollLeft / Math.max(1, pager.clientWidth));
        pager.parentElement?.querySelectorAll('[data-tools-dots] i').forEach((dot, i) => {
          dot.classList.toggle('is-on', i === idx);
        });
      }, true);

      container.addEventListener('click', (e) => {
        if (toolsOpen && !e.target.closest('.chat-tools-sheet') && !e.target.closest('[data-tools]')) {
          closeToolsSheet();
        }

        if (e.target.closest('[data-chat-error-close]')) {
          clearChatError();
          return;
        }

        if (e.target.closest('[data-chat-error-detail]')) {
          if (chatError) openGenerationErrorDetail(chatError).catch(() => {});
          return;
        }

        if (e.target.closest('[data-chat-error-support]')) {
          navigate('support', { fromError: '1' });
          return;
        }

        if (e.target.closest('[data-chat-error-plain-save]')) {
          chooseErrorRawBubblesAndSave().catch((err) => showToast(err?.message || '填入失败'));
          return;
        }

        if (e.target.closest('[data-chat-error-copy]')) {
          const text = buildGenerationErrorCopyText(chatError || {});
          copyTextToClipboard(text).then((ok) => showToast(ok ? '报错已复制' : '复制失败')).catch(() => showToast('复制失败'));
          return;
        }

        if (e.target.closest('[data-cancel-reply]')) {
          replyTarget = null;
          refreshReplyBar();
          return;
        }

        const speechPlayButton = e.target.closest('[data-speech-play]');
        if (speechPlayButton && container.contains(speechPlayButton)) {
          e.preventDefault();
          e.stopPropagation();
          const speechRoundId = String(
            speechPlayButton.getAttribute('data-speech-round') || '',
          ).trim();
          const msgId = String(
            speechPlayButton.getAttribute('data-speech-play')
            || speechPlayButton.closest('[data-msg-id]')?.getAttribute('data-msg-id')
            || '',
          ).trim();
          const msg = messages.find((item) => String(item?.id || '') === msgId);
          if (!msg) {
            showToast('这条消息尚未载入');
            return;
          }
          if (speechRoundId) {
            const stopping = isVoiceMessageSequencePlaybackActive(speechRoundId);
            const soundEffectsEnabled = chatPrefs?.narrationSoundEffectsEnabled === true;
            const gestureToken = captureMediaGesture(e);
            const backgroundGestureTokens = soundEffectsEnabled
              ? [captureMediaGesture(e), captureMediaGesture(e)]
              : [];
            const textureGestureTokens = soundEffectsEnabled
              ? [captureMediaGesture(e), captureMediaGesture(e), captureMediaGesture(e)]
              : [];
            const sequence = messages.filter((item) => (
              String(item?.metadata?.aiRoundId || '').trim() === speechRoundId
            ));
            if (!stopping) showToast('正在准备本轮语音…', 1200);
            playTextBubbleSequenceAsVoice(sequence, {
              sequenceId: speechRoundId,
              button: speechPlayButton,
              gestureToken,
              bubbleGapMs: chatPrefs?.voicePerformanceBubbleGapMs,
              soundEffectsEnabled,
              soundOwnerId: user.id,
              soundEffectsVolume: chatPrefs?.narrationSoundEffectsVolume,
              backgroundVolume: chatPrefs?.narrationBackgroundVolume,
              backgroundGestureTokens,
              textureGestureTokens,
              onRefresh: () => refreshMessages(),
            }).then(() => {
              if (stopping) showToast('已停止连续播放');
            }).catch((err) => {
              if (isVoiceTtsSkipError(err)) {
                showToast('本轮有角色尚未开启可用声线');
                return;
              }
              console.warn('[speech-plan-sequence]', err);
              showToast(`连续播放失败：${err?.message || err}`);
            });
            return;
          }
          const stopping = isVoiceMessagePlaybackActive(msg.id);
          const gestureToken = captureMediaGesture(e);
          if (!stopping) showToast('正在准备朗读…', 1200);
          playTextBubbleAsVoice(msg, {
            button: speechPlayButton,
            gestureToken,
            onRefresh: () => refreshMessages(),
          }).then(() => {
            if (stopping) showToast('已停止朗读');
          }).catch((err) => {
            if (isVoiceTtsSkipError(err)) {
              showToast('TA 还没有开启可用声线');
              return;
            }
            console.warn('[speech-plan-voice]', err);
            showToast(`朗读失败：${err?.message || err}`);
          });
          return;
        }

        const reactionChip = e.target.closest('.chat-bubble-reaction-chip.is-mine');
        if (reactionChip && container.contains(reactionChip)) {
          e.preventDefault();
          e.stopPropagation();
          const row = reactionChip.closest([
            '.chat-bubble-row[data-msg-id]',
            '.chat-msg-bubble[data-msg-id]',
            '.chat-msg-card[data-msg-id]',
            '.chat-msg-media[data-msg-id]',
          ].join(', '));
          const msgId = row?.getAttribute('data-msg-id');
          const emoji = reactionChip.getAttribute('data-reaction-emoji') || '';
          if (!msgId || !emoji) return;
          removeUserEmojiReactionFromMessage(msgId, emoji).then((updated) => {
            if (!updated) return;
            messages = messages.map((m) => (m.id === msgId ? updated : m));
            refreshMessages();
          }).catch(() => showToast('取消回应失败'));
          return;
        }

        const translateBtn = e.target.closest('[data-translation-toggle]');
        if (translateBtn && container.contains(translateBtn)) {
          e.preventDefault();
          e.stopPropagation();
          const wrap = translateBtn.nextElementSibling;
          const row = translateBtn.closest('[data-msg-id]');
          const msgId = String(row?.getAttribute('data-msg-id') || '').trim();
          // 已展开时只收起，绝不进入补译忙碌态，否则会出现「再点又正在补翻译」。
          if (wrap && !wrap.hidden) {
            wrap.hidden = true;
            translateBtn.setAttribute('aria-expanded', 'false');
            if (msgId) expandedTranslationMsgIds.delete(msgId);
            return;
          }
          const msg = msgId ? messages.find((m) => String(m?.id || '').trim() === msgId) : null;
          const sourceText = msg
            ? resolveMessageSourceText(msg)
            : String(translateBtn.closest('.chat-bubble-row, .chat-msg-bubble')?.querySelector('.chat-bubble-text')?.textContent || '').trim();
          const domTranslation = String(
            wrap?.querySelector?.('.chat-bubble-translation-text, .voice-msg-translation')?.textContent
            || '',
          ).trim();
          const translationText = String(msg?.metadata?.translation || domTranslation || '').trim();
          const charId = msg ? String(msg.senderId || '').trim() : '';
          const charRow = charId && charId !== 'user' ? characters?.[charId] : null;
          const languageHint = String(
            charRow?.translationProfile?.language || charRow?.translationProfile?.dialectNote || '',
          ).trim();
          const aiRoundId = String(msg?.metadata?.aiRoundId || '').trim();
          const needsRepair = !isValidUserFacingTranslation(sourceText, translationText, { languageHint });
          const repairKey = aiRoundId ? `round:${aiRoundId}` : `message:${msgId || sourceText}`;
          if (needsRepair && translationRepairInflight.has(repairKey)) return;

          const roundMessageIds = new Set(
            messages
              .filter((item) => (
                aiRoundId
                  ? String(item?.metadata?.aiRoundId || '').trim() === aiRoundId
                  : String(item?.id || '').trim() === msgId
              ))
              .map((item) => String(item?.id || '').trim())
              .filter(Boolean),
          );
          const setRoundTranslationBusy = (busy) => {
            container.querySelectorAll('[data-translation-toggle]').forEach((button) => {
              const id = String(button.closest('[data-msg-id]')?.getAttribute('data-msg-id') || '').trim();
              if (!roundMessageIds.has(id)) return;
              if (busy) {
                button.dataset.translationIdleLabel = button.textContent || '翻译';
                button.textContent = '正在补翻译…';
                button.disabled = true;
                button.setAttribute('aria-busy', 'true');
              } else {
                button.textContent = button.dataset.translationIdleLabel || '翻译';
                delete button.dataset.translationIdleLabel;
                button.disabled = false;
                button.removeAttribute('aria-busy');
              }
            });
          };
          if (needsRepair) {
            translationRepairInflight.add(repairKey);
            setRoundTranslationBusy(true);
          }

          handleTranslationToggleClick(translateBtn, {
            sourceText,
            translationText,
            languageHint,
            aiRoundId,
            roundMessages: messages,
            characters,
            onBatchRepaired: async (repairMap) => {
              const updates = [];
              for (const [id, repaired] of repairMap.entries()) {
                const target = messages.find((m) => String(m?.id || '').trim() === String(id || '').trim());
                if (!target) continue;
                const src = resolveMessageSourceText(target);
                const targetProfile = characters?.[target.senderId]?.translationProfile || {};
                const targetLanguageHint = String(
                  targetProfile.language || targetProfile.dialectNote || '',
                ).trim();
                const valid = sanitizeAiTranslation(src, repaired, {
                  languageHint: targetLanguageHint,
                }) || String(repaired || '').trim();
                if (!isValidUserFacingTranslation(src, valid, {
                  languageHint: targetLanguageHint,
                })) continue;
                updates.push({
                  ...target,
                  metadata: {
                    ...(target.metadata || {}),
                    translation: valid,
                    translationRepaired: true,
                  },
                });
              }
              if (!updates.length) return;
              updates.forEach((item) => markLocalTranslationWrite(item.id));
              await Promise.all(updates.map((item) => saveMessage(item)));
              messages = messages.map((m) => {
                const next = updates.find((item) => item.id === m.id);
                return next || m;
              });
              updates.forEach((item) => {
                patchMessageTranslationDom(item.id, item.metadata?.translation);
              });
            },
            onRepaired: msg ? async (repaired) => {
              const current = messages.find((item) => String(item?.id || '').trim() === String(msg.id || '').trim()) || msg;
              const src = resolveMessageSourceText(current);
              const valid = sanitizeAiTranslation(src, repaired, { languageHint }) || String(repaired || '').trim();
              if (!isValidUserFacingTranslation(src, valid, { languageHint })) return;
              if (String(current?.metadata?.translation || '').trim() === valid) return;
              const next = {
                ...current,
                metadata: { ...(current.metadata || {}), translation: valid, translationRepaired: true },
              };
              markLocalTranslationWrite(next.id);
              await saveMessage(next);
              messages = messages.map((m) => (String(m?.id || '').trim() === String(msg.id || '').trim() ? next : m));
            } : undefined,
          }).then((ok) => {
            if (ok === 'collapsed') {
              if (msgId) expandedTranslationMsgIds.delete(msgId);
              return;
            }
            if (!ok) {
              showToast('翻译暂时不可用，请稍后再试');
              return;
            }
            if (msgId) expandedTranslationMsgIds.add(msgId);
            if (!needsRepair) return;
            // 译文已经在当前气泡内局部更新；不要为一小段文字整表 innerHTML。
            // 长会话/图片较多时，整表重建会让 iOS WebKit 瞬间复制大量节点与位图，出现闪白甚至进程回收。
          }).catch(() => {
            showToast('翻译暂时不可用，请稍后再试');
          }).finally(() => {
            if (!needsRepair) return;
            translationRepairInflight.delete(repairKey);
            setRoundTranslationBusy(false);
          });
          return;
        }

        const inThumb = e.target.closest('.chat-user-image-wrap[data-chat-image]');
        if (inThumb && container.contains(inThumb)) {
          const row = e.target.closest([
            '.chat-bubble-row[data-msg-id]',
            '.chat-msg-bubble[data-msg-id]',
            '.chat-msg-card[data-msg-id]',
            '.chat-msg-media[data-msg-id]',
          ].join(', '));
          const msgId = row?.getAttribute('data-msg-id');
          const msg = messages.find((m) => m.id === msgId);
          if (msg && msg.type === 'image') {
            e.preventDefault();
            e.stopPropagation();
            openGenImageLightbox(msg).catch((err) => showToast(err?.message || '图片加载失败'));
          }
          return;
        }

        const inlineInnerVoiceBtn = e.target.closest('[data-inline-inner-voice-open]');
        if (inlineInnerVoiceBtn && container.contains(inlineInnerVoiceBtn)) {
          const charId = inlineInnerVoiceBtn.getAttribute('data-character-id');
          if (charId) {
            e.preventDefault();
            e.stopPropagation();
            showCharStatePopover(charId, inlineInnerVoiceBtn.getAttribute('data-character-name') || '').catch(() => {});
          }
          return;
        }

        const avatarBtn = e.target.closest('.chat-bubble-avatar[data-msg-id]');
        if (avatarBtn && container.contains(avatarBtn)) {
          if (e.detail > 1) {
            cancelPendingAvatarSingleClick();
            return;
          }
          const msgId = avatarBtn.getAttribute('data-msg-id');
          const msg = messages.find((m) => m.id === msgId);
          const charId = msg?.senderId;
          if (msg && charId && charId !== 'user' && charId !== 'system' && charId !== GUIDANCE_SENDER_ID) {
            scheduleAvatarSingleClick(() => {
              if (anonShell && isGroup && isAnonymousChat(chat)) {
                openAnonymousAvatarMenu(charId, msg.senderName);
                return;
              }
              showCharStatePopover(charId, msg.senderName).catch(() => {});
            });
          }
          return;
        }

        const actBtn = e.target.closest('[data-act]');
        if (actBtn && container.contains(actBtn)) {
          const gesture = controlGestureLatch.consume(actBtn);
          const intendedAction = gesture?.action || actBtn.getAttribute('data-act');
          if (intendedAction === 'stop' && (gesture?.handled || wasStopGestureHandledRecently())) return;
          handleAction(intendedAction, e).catch((err) => showToast(err?.message || '操作失败'));
          return;
        }

        const todoBtn = e.target.closest('[data-group-todo-toggle]');
        if (todoBtn && container.contains(todoBtn)) {
          toggleGroupTodoFromThread(todoBtn.getAttribute('data-group-todo-toggle')).catch((err) => showToast(err?.message || '更新失败'));
          return;
        }

        const dismissGroupInfoBtn = e.target.closest('[data-group-info-dismiss]');
        if (dismissGroupInfoBtn && container.contains(dismissGroupInfoBtn)) {
          dismissGroupInfoCard(dismissGroupInfoBtn.getAttribute('data-group-info-dismiss')).catch((err) => showToast(err?.message || '关闭失败'));
          return;
        }

        const stickerSuggestionBtn = e.target.closest('[data-sticker-suggestion]');
        if (stickerSuggestionBtn && container.contains(stickerSuggestionBtn)) {
          e.preventDefault();
          const sticker = composerStickerSuggestions[Number(stickerSuggestionBtn.getAttribute('data-sticker-suggestion'))];
          if (!sticker) return;
          setComposerText('');
          clearComposerStickerSuggestions();
          sendPickedSticker(sticker).catch((err) => showToast(err?.message || '发送表情失败'));
          return;
        }

        if (e.target.closest('[data-stickers]')) {
          e.preventDefault();
          clearComposerStickerSuggestions();
          openChatStickerPicker({
            onPick: (sticker) => sendPickedSticker(sticker).catch((err) => showToast(err?.message || '发送表情失败')),
          }).catch((err) => showToast(err?.message || '打开表情失败'));
          return;
        }

        if (e.target.closest('[data-pick-image]')) {
          container.querySelector('.chat-image-input')?.click();
          return;
        }

        if (e.target.closest('[data-transcribe]')) {
          e.preventDefault();
          openVoiceComposerSheet();
          return;
        }

        if (e.target.closest('[data-tools-order]')) {
          e.preventDefault();
          openToolsOrderEditor();
          return;
        }

        if (e.target.closest('[data-tools]')) {
          if (toolsOpen) {
            closeToolsSheet();
          } else {
            // 小米等 Android WebView 可能在键盘已收起后仍把 textarea 保持为焦点，
            // 导致美化过的悬浮输入栏继续按旧 visualViewport 定位，与工具面板脱节。
            const inputEl = container.querySelector('.chat-composer-input');
            if (inputEl && document.activeElement === inputEl) inputEl.blur();
            setComposerFocusState(false);
            toolsOpen = true;
            container.classList.add('has-chat-tools-open');
            container.querySelector('.chat-tools-sheet')?.classList.add('is-open');
            container.querySelector('.chat-composer-more')?.classList.add('is-open');
            scheduleComposerDockGapSettle();
          }
          return;
        }

        const mentionBtn = e.target.closest('[data-composer-mention-id]');
        if (mentionBtn && container.contains(mentionBtn)) {
          e.preventDefault();
          selectComposerMention(mentionBtn.getAttribute('data-composer-mention-id'));
          return;
        }

        const composerSendBtn = e.target.closest('.chat-composer-send');
        if (composerSendBtn) {
          e.preventDefault();
          const gesture = controlGestureLatch.consume(composerSendBtn);
          const intendedAction = gesture?.action || composerSendButtonState().mode;
          if (intendedAction === 'stop') {
            if (gesture?.handled || wasStopGestureHandledRecently()) return;
            // 生成中这个按钮是「停止」
            handleAction('stop').catch((err) => showToast(err?.message || '操作失败'));
            return;
          }
          const inputEl = container.querySelector('.chat-composer-input');
          const hasText = !!String(inputEl?.value || '').trim();
          if (intendedAction === 'advance' || !hasText) {
            // 没字时这个按钮是「推进」：复用原操作栏同一套分发逻辑（含群聊/粉丝群特殊分支）
            handleAction('advance').catch((err) => showToast(err?.message || '操作失败'));
            return;
          }
          const shouldRestoreFocus = document.activeElement === inputEl;
          sendTextMessage()
            .then(() => {
              if (!shouldRestoreFocus) return;
              requestAnimationFrame(() => {
                const liveInput = container.querySelector('.chat-composer-input');
                if (!liveInput || liveInput.disabled) return;
                try {
                  liveInput.focus({ preventScroll: true });
                } catch (_) {
                  liveInput.focus();
                }
              });
            })
            .catch((err) => showToast(err.message || '发送失败'));
          return;
        }

        const toolBtn = e.target.closest('[data-tool]');
        if (toolBtn && container.contains(toolBtn)) {
          handleTool(toolBtn.getAttribute('data-tool'), e).catch((err) => showToast(err?.message || '操作失败'));
        }
      });

      container.addEventListener('input', (e) => {
        if (!e.target.matches('.chat-composer-input')) return;
        markUserActivity();
        resizeComposerInput(e.target, { preserveMessagesViewport: true });
        noteComposerDraft(e.target.value || '');
        syncComposerSendButton();
        if (!composerImeComposing) {
          updateComposerMentionSuggestions(e.target);
          if (!composerMentionSuggestions.length) scheduleComposerStickerSuggestions(e.target.value || '');
        }
      });

      container.addEventListener('beforeinput', (e) => {
        if (!e.target.matches?.('.chat-composer-input')) return;
        composerDraftEditRevision += 1;
        // beforeinput 早于 textarea.value 和 input 事件更新。先登记占用，
        // 可封住到点定时器与中文输入法首个字符恰好同帧触发的竞态。
        markUserActivity();
        noteComposerActivity();
        markChatComposerActive(chatId, {
          hasDraft: !!String(e.target.value || composerDraftText || '').trim(),
        });
        interruptBackgroundGenerationForComposer();
      });

      container.addEventListener('compositionstart', (e) => {
        if (!e.target.matches?.('.chat-composer-input')) return;
        composerDraftEditRevision += 1;
        composerImeComposing = true;
        clearComposerMentionSuggestions();
        clearComposerStickerSuggestions();
        noteComposerActivity();
        markChatComposerActive(chatId);
        interruptBackgroundGenerationForComposer();
      });

      container.addEventListener('compositionend', (e) => {
        if (!e.target.matches?.('.chat-composer-input')) return;
        composerImeComposing = false;
        noteComposerDraft(e.target.value || '');
        syncComposerSendButton();
        updateComposerMentionSuggestions(e.target);
        if (!composerMentionSuggestions.length) scheduleComposerStickerSuggestions(e.target.value || '');
      });

      container.addEventListener('focusin', (e) => {
        if (!e.target.matches('.chat-composer-input')) return;
        if (composerBlurTimer) window.clearTimeout(composerBlurTimer);
        composerBlurTimer = 0;
        markUserActivity();
        setComposerFocusState(true);
        // 仅在本来就真正贴底时同步一次；键盘动画后续由 ResizeObserver 单路接管，
        // 不再启动四帧补钉与它争抢 scrollTop。
        const main = container.querySelector('.chat-thread-messages');
        if (holdBottomUntilSettled || isNearBottom(main, 24)) {
          beginFollowingLatestMessages();
          if (main) main.scrollTop = main.scrollHeight;
        }
      });

      container.addEventListener('focusout', (e) => {
        if (!e.target.matches('.chat-composer-input')) return;
        if (composerBlurTimer) window.clearTimeout(composerBlurTimer);
        const blurStartedAt = Date.now();
        const settleBlur = () => {
          composerBlurTimer = 0;
          const active = document.activeElement;
          if (active?.matches?.('.chat-composer-input')) return;
          // Chrome / Gboard 在切换系统表情页、候选栏或调整键盘高度时，可能短暂把
          // activeElement 交给 body。短暂等待视口稳定即可；键盘状态若残留，不能无限续期。
          if (!pageDisposed
            && container.isConnected
            && !container.hidden
            && isSoftKeyboardVisible()
            && Date.now() - blurStartedAt < 900) {
            composerBlurTimer = window.setTimeout(settleBlur, 180);
            return;
          }
          setComposerFocusState(false);
        };
        composerBlurTimer = window.setTimeout(settleBlur, 120);
      });

      container.addEventListener('keydown', (e) => {
        if (!e.target.matches('.chat-composer-input')) return;
        if (composerMentionSuggestions.length) {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            const delta = e.key === 'ArrowDown' ? 1 : -1;
            composerMentionActiveIndex = (composerMentionActiveIndex + delta + composerMentionSuggestions.length)
              % composerMentionSuggestions.length;
            paintComposerMentionSuggestions();
            container.querySelector('.chat-composer-mention-item.is-active')?.scrollIntoView({ block: 'nearest' });
            return;
          }
          if (e.key === 'Escape') {
            e.preventDefault();
            clearComposerMentionSuggestions();
            return;
          }
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            selectComposerMention(composerMentionSuggestions[composerMentionActiveIndex]?.actorId);
            return;
          }
        }
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          sendTextMessage().catch((err) => showToast(err.message || '发送失败'));
        }
      });

      container.addEventListener('change', async (e) => {
        if (!e.target.matches('.chat-image-input')) return;
        const file = e.target.files?.[0];
        e.target.value = '';
        if (!file) return;
        (async () => {
          try {
            if (Number(file.size || 0) > CHAT_IMAGE_INLINE_MAX_BYTES) {
              showToast('正在压缩图片...', 1800);
            }
            const imagePayload = await fileToOptimizedChatImageDataUrl(file);
            const dataUrl = imagePayload.dataUrl;
            if (!dataUrl || dataUrlApproxBytes(dataUrl) > CHAT_IMAGE_TARGET_MAX_BYTES * 1.8) {
              throw new Error('图片仍然过大，请换一张较小的图片');
            }
            await sendTypedMessage('image', dataUrl, {
              localName: file.name,
              localSize: Number(file.size || 0),
              localType: String(file.type || ''),
              compressedLocalImage: imagePayload.compressed === true,
              storedSize: dataUrlApproxBytes(dataUrl),
            });
          } catch (err) {
            showToast(err?.message || '图片上传失败');
          }
        })();
      });
    }

    container.querySelector('[data-back]')?.addEventListener('click', () => {
      back();
    });
    container.querySelector('[data-return-offline]')?.addEventListener('click', () => {
      invalidateKeepAlive('offline', { chatId: offlineChatId });
      invalidateOfflinePresenceKeepAlive(offlineChatId);
      navigateDismissing('offline', { chatId: offlineChatId }, {
        dismissPaths: ['chat', 'chat/thread', 'chat/details'],
        matchChatId: false,
      });
    });
    container.querySelectorAll('[data-open-settings]').forEach((btn) => {
      const detailsParams = {
        chatId,
        ...(anonShell ? { from: shellFrom } : {}),
        ...(fromCharacterPhone ? { from: 'phone', viewer: phoneViewerId } : {}),
      };
      btn.addEventListener('pointerdown', (event) => {
        if (!event.target.closest('[data-header-status-detail]')) prefetchRoute('chat/details', detailsParams);
      });
      btn.addEventListener('click', (event) => {
        if (event.target.closest('[data-header-status-detail]')) {
          event.preventDefault();
          event.stopPropagation();
          openHeaderStatusDetail();
          return;
        }
        navigate('chat/details', detailsParams);
      });
    });
    container.querySelector('[data-stranger-translation-settings]')?.addEventListener('click', () => {
      navigate('chat/details', { chatId, focus: 'translation' });
    });
    container.querySelector('[data-contact-application-retry]')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        chat = await getChat(chatId).catch(() => chat);
        const result = await resolveQqContactApplication(chat, user, { forceRetry: true });
        if (result?.decided) {
          chat = result.chat || await getChat(chatId).catch(() => chat);
          paint();
        } else {
          await refreshThreadMessagesAfterForeground({ forcePin: true, animateNewMessages: true });
        }
        if (!result?.ok) showToast('暂时没收到回应，可以稍后再试');
      } catch (error) {
        showToast(error?.message || '重新询问失败');
      }
    });
    container.querySelector('[data-clear-event]')?.addEventListener('click', async () => {
      await clearActiveEvent(chatId);
      chat = await getChat(chatId);
      paint();
      showToast('特殊事件已清除');
    });
    container.querySelectorAll('[data-stranger-friend]').forEach((button) => {
      button.addEventListener('click', async () => {
        try {
          const nextState = String(button.dataset.strangerFriend || '').trim();
          chat = await updateStrangerFriendship(chatId, nextState, {
            by: principalKey('user', user.id),
            at: Date.now(),
          });
          // 用户侧申请/通过时清掉角色决策标记，避免和角色主动 request 混淆
          if (nextState === 'requested' || nextState === 'accepted') {
            chat.metadata = {
              ...(chat.metadata || {}),
              friendshipDecisionBy: nextState === 'accepted' ? principalKey('user', user.id) : '',
              friendshipDecisionAt: nextState === 'accepted' ? Date.now() : 0,
              friendshipDecision: nextState === 'accepted' ? 'accept' : '',
              friendshipDecisionReason: '',
            };
            await saveChat(chat);
          }
          paint();
        } catch (error) {
          showToast(error?.message || '状态更新失败');
        }
      });
    });
    container.querySelector('[data-stranger-reveal]')?.addEventListener('click', async (event) => {
      const subjectKey = String(event.currentTarget.dataset.strangerReveal || '').trim();
      const userUsesAlias = subjectKey.startsWith('user:');
      const ok = window.confirm(userUsesAlias
        ? '确认公开你的真实身份？对方将按已识破理解你是谁。'
        : '确认标记已识破？顶栏与后续对话将按对方真实身份显示与理解，等于主动掉马。');
      if (!ok) return;
      try {
        chat = await updateStrangerIdentityReveal(chatId, subjectKey, 'revealed', {
          text: '用户在会话中明确确认身份',
          by: principalKey('user', user.id),
        });
        paint();
      } catch (error) {
        showToast(error?.message || '身份状态更新失败');
      }
    });
    container.querySelectorAll('[data-alias-picker-close]').forEach((element) => {
      element.addEventListener('click', (event) => {
        if (event.target.closest('.chat-alias-picker') && !event.target.closest('button[data-alias-picker-close]')) return;
        aliasPickerOpen = false;
        paint();
      });
    });
    container.querySelectorAll('[data-alias-open]').forEach((button) => {
      button.addEventListener('click', async () => {
        const ownerType = button.dataset.aliasOwner === 'character' ? 'character' : 'user';
        try {
          const nextChat = await ensureStrangerThread({
            userId: user.id,
            characterId: partnerId,
            userAccountId: ownerType === 'user' ? button.dataset.aliasOpen : '',
            characterAccountId: ownerType === 'character' ? button.dataset.aliasOpen : '',
            initiatorType: ownerType,
            friendshipState: 'intercepted',
          });
          navigate('chat/thread', { chatId: nextChat.id }, true);
        } catch (error) {
          showToast(error?.message || '打开马甲会话失败');
        }
      });
    });
    container.querySelector('[data-alias-manage]')?.addEventListener('click', () => {
      navigate('chat/aliases', { targetCharacterId: partnerId || '', ownerType: 'user' });
    });
    container.querySelector('[data-cancel-reply]')?.addEventListener('click', () => {
      replyTarget = null;
      refreshReplyBar();
    });
  }

  async function beginExitGuidanceMode() {
    if (chatPrefs.guidanceMode !== true) return;
    const guidanceMsgs = selectGuidanceSessionMessages(messages, {
      startedAt: chatPrefs.guidanceModeStartedAt,
    });
    if (!guidanceMsgs.length) {
      await finishExitGuidanceMode({ saved: false });
      return;
    }
    selectionMode = true;
    selectionPurpose = 'guidance-exit';
    selectedSet.clear();
    guidanceMsgs.forEach((m) => selectedSet.add(m.id));
    refreshSelectionUi();
    showToast('勾选要计入指导记忆的内容，再点「保存并退出」');
  }

  async function finishExitGuidanceMode({ saved = false } = {}) {
    selectionMode = false;
    selectionPurpose = '';
    selectedSet.clear();
    // 回复目标是复制式元数据；若它指向指导气泡，退出后目标虽然隐藏，引用仍会被下一条
    // 普通消息带回聊天。退出模式时统一清空，保证指导讨论不泄漏到正常扮演。
    replyTarget = null;
    chatPrefs = await patchChatPrefs(chatId, {
      guidanceMode: false,
      guidanceModeStartedAt: 0,
    });
    // 指导讨论连续超过首屏时，当前 messages 可能恰好全是指导气泡；退出后这些气泡
    // 会被隐藏，但此前正常聊天仍在 IndexedDB。主动向前补到一页正常消息，不能把
    // 当前会话错误画成空窗（搜索能找到、会话页却空白的根因）。
    await restoreRoleplayMessagesAfterGuidanceExit();
    try { await recalcChatPreview(chatId); } catch (_) { /* ignore */ }
    paint();
    showToast(saved ? '已保存指导记忆并退出' : '已退出指导模式');
  }

  async function restoreRoleplayMessagesAfterGuidanceExit() {
    const wanted = CHAT_THREAD_RENDER_BATCH;
    const countRoleplay = () => messages.filter((message) => (
      message && !message.deleted && !message.recalled && !isGuidanceMessage(message)
    )).length;
    if (countRoleplay() >= wanted || !hasOlderMessages) return;
    const seen = new Set(messages.map((message) => String(message?.id || '')).filter(Boolean));
    let beforeTimestamp = Math.min(...messages
      .map((message) => Number(message?.timestamp || 0))
      .filter((timestamp) => Number.isFinite(timestamp) && timestamp > 0));
    // 正常情况下只需补一页；上限避免异常数据让退出操作无限扫历史。
    for (let pageCount = 0; pageCount < 12 && Number.isFinite(beforeTimestamp) && beforeTimestamp > 0; pageCount += 1) {
      const page = await listMessagesPageForChat(chatId, {
        limit: CHAT_THREAD_RENDER_BATCH,
        beforeTimestamp,
        deferHeavyImages: true,
      });
      if (!page.messages.length) {
        hasOlderMessages = false;
        break;
      }
      const additions = page.messages.filter((message) => message?.id && !seen.has(message.id));
      additions.forEach((message) => seen.add(message.id));
      messages = [...additions, ...messages].sort((left, right) => Number(left.timestamp || 0) - Number(right.timestamp || 0));
      hasOlderMessages = page.hasMore;
      if (countRoleplay() >= wanted || !page.hasMore) break;
      const nextBefore = Math.min(...page.messages
        .map((message) => Number(message?.timestamp || 0))
        .filter((timestamp) => Number.isFinite(timestamp) && timestamp > 0));
      if (!Number.isFinite(nextBefore) || nextBefore >= beforeTimestamp) break;
      beforeTimestamp = nextBefore;
    }
    visibleMessageLimit = Math.max(visibleMessageLimit, wanted);
  }

  async function handleAction(act, event = null) {
    closeToolsSheet();
    if (act === 'stop') {
      await stopCurrentGeneration();
      return;
    }
    if (act === 'select-done') {
      if (selectionPurpose === 'guidance-exit') {
        selectionMode = false;
        selectionPurpose = '';
        selectedSet.clear();
        refreshSelectionUi();
        showToast('已取消，仍停留在指导模式');
        return;
      }
      selectionMode = false;
      selectionPurpose = '';
      selectedSet.clear();
      refreshSelectionUi();
      return;
    }
    if (act === 'aliases') {
      if (!partnerId) return;
      const [userAliases, characterAliases] = await Promise.all([
        listAliasAccounts('user', user.id, { userId: user.id }),
        listAliasAccounts('character', partnerId, { userId: user.id }),
      ]);
      aliasPickerAccounts = { user: userAliases, character: characterAliases };
      aliasPickerOpen = true;
      paint();
      return;
    }
    if (act === 'interaction') {
      await openChatInteractionLibrary();
      return;
    }
    if (act === 'gacha') {
      const { openEventGachaModal } = await import('../components/event-gacha-modal.js');
      openEventGachaModal({
        chatId,
        chat,
        userName: currentUserName,
        onInjected: async () => {
          chat = await getChat(chatId);
          paint();
        },
      });
      return;
    }
    if (act === 'narrator') {
      openTextEditorModal({
        title: '旁白推进',
        placeholder: '例如：你把手机揣回口袋，先去开会。十分钟后才重新摸出来看消息。',
        multiline: true,
        confirmLabel: '插入',
        variant: anonEditorVariant(),
        onSave: async (text) => {
          const body = String(text || '').trim();
          if (!body) {
            showToast('未填写旁白内容');
            return;
          }
          const msg = await stampSceneMessage(buildNarratorMessage(chat, body), user.id);
          if (msg) await persistUserMessage(msg);
          showToast('已插入旁白推进');
        },
      });
      return;
    }
    if (act === 'plot') {
      openTextEditorModal({
        title: '剧情提示',
        value: chat.metadata?.plotDirective || chat.groupSettings?.plotDirective || '',
        placeholder: '写给 AI 的剧情方向…',
        multiline: true,
        variant: anonEditorVariant(),
        onSave: async (text) => {
          chat = await updateChatDirectives(chat.id, { plotDirective: text });
          showToast('剧情提示已保存');
        },
      });
      return;
    }
    if (act === 'guidance-expert') {
      await openChatExpertConsultationSheet();
      return;
    }
    if (act === 'guidance' || act === 'guidance-exit') {
      if (anonShell) {
        showToast('匿名会话暂不支持指导模式');
        return;
      }
      if (act === 'guidance-exit') {
        await beginExitGuidanceMode();
        return;
      }
      const charLabel = guidanceSubjectLabel();
      openGuidanceModeSheet({
        guidanceMode: chatPrefs.guidanceMode === true,
        characterName: charLabel,
        variant: anonEditorVariant(),
        onToggleMode: async (next) => {
          if (next) {
            chatPrefs = await patchChatPrefs(chatId, {
              guidanceMode: true,
              guidanceModeStartedAt: Date.now(),
            });
            paint();
            showToast('已进入指导模式 · 发消息后点推进即可与本体讨论');
            return;
          }
          await beginExitGuidanceMode();
        },
        onManageMemories: async () => {
          const scopeId = guidanceScopeId();
          if (!scopeId) {
            showToast('找不到对应会话');
            return;
          }
          await openGuidanceMemoryManageModal({
            characterId: scopeId,
            userId: user.id,
            characterName: charLabel,
            characters,
            variant: anonEditorVariant(),
          });
        },
      });
      return;
    }
    if (act === 'guidance-exit-cancel') {
      selectionMode = false;
      selectionPurpose = '';
      selectedSet.clear();
      refreshActionArea();
      refreshMessages();
      showToast('已取消，仍停留在指导模式');
      return;
    }
    if (act === 'guidance-exit-skip') {
      await finishExitGuidanceMode({ saved: false });
      return;
    }
    if (act === 'guidance-exit-scope') {
      const scopeId = guidanceScopeId();
      if (!scopeId) {
        showToast('找不到对应会话');
        return;
      }
      const picked = selectGuidanceSessionMessages(messages, {
        startedAt: chatPrefs.guidanceModeStartedAt,
      }).filter((m) => selectedSet.has(m.id));
      if (!picked.length) {
        showToast('请先勾选要保存的指导内容');
        return;
      }
      const note = formatMessagesAsGuidanceNote(picked, {
        userName: currentUserName || '用户',
        characterName: guidanceSubjectLabel(),
      });
      if (!note.trim()) {
        showToast('选中的气泡没有可写入的文字');
        return;
      }
      openGuidanceExitScopeSheet({
        characterName: guidanceSubjectLabel(),
        variant: anonEditorVariant(),
        onSelect: async (scope) => {
          if (scope === 'discard') {
            await finishExitGuidanceMode({ saved: false });
            return;
          }
          if (scope === 'reroll') {
            chatPrefs = await patchChatPrefs(chatId, {
              guidancePendingReroll: { content: note, createdAt: Date.now() },
            });
            await finishExitGuidanceMode({ saved: false });
            showToast('本次指导会用于下一次重 roll，成功后自动失效', 4500);
            return;
          }
          if (scope === 'scene') {
            chatPrefs = await patchChatPrefs(chatId, {
              guidanceScene: {
                content: note,
                createdAt: Date.now(),
                remainingTurns: GUIDANCE_SCENE_DEFAULT_TURNS,
              },
            });
            await finishExitGuidanceMode({ saved: false });
            showToast(`本次指导将在接下来 ${GUIDANCE_SCENE_DEFAULT_TURNS} 轮内生效`);
            return;
          }
          if (scope === 'persistent-raw') {
            await saveGuidanceMemory({
              characterId: scopeId,
              userId: user.id,
              content: note,
              chatId,
              sourceMessageIds: picked.map((m) => m.id),
              distilled: false,
            });
            await finishExitGuidanceMode({ saved: true });
            return;
          }
          // 兼容旧页面已经打开时传回的 persistent；新页面使用更明确的分支名。
          if (scope !== 'persistent-distilled' && scope !== 'persistent') return;
          showToast('正在整理长期规则…');
          try {
            const distilled = await distillGuidanceSession({
              content: note,
              characterName: guidanceSubjectLabel(),
            });
            openTextEditorModal({
              title: '确认长期指导',
              value: distilled,
              placeholder: '检查适用条件，避免把一次性反应写成永久习惯…',
              multiline: true,
              confirmLabel: '保存并退出',
              variant: anonEditorVariant(),
              onSave: async (text) => {
                await saveGuidanceMemory({
                  characterId: scopeId,
                  userId: user.id,
                  content: text,
                  chatId,
                  sourceMessageIds: picked.map((m) => m.id),
                  distilled: true,
                });
                await finishExitGuidanceMode({ saved: true });
              },
            });
          } catch (error) {
            showToast(error?.message || '长期规则整理失败');
          }
        },
      });
      return;
    }
    if (act === 'description') {
      openTextEditorModal({
        title: '会话描述',
        value: chat.groupSettings?.description || chat.metadata?.description || '',
        placeholder: '会话背景设定…',
        multiline: true,
        variant: anonEditorVariant(),
        onSave: async (text) => {
          chat = await updateChatDirectives(chat.id, { description: text });
          showToast('会话描述已保存');
        },
      });
      return;
    }
    if (act === 'phone-proxy') {
      if (!fromCharacterPhone || isStreaming) return;
      phoneProxyMode = !phoneProxyMode;
      sendAsCharacterId = '';
      toolsOpen = false;
      showToast(phoneProxyMode
        ? `已进入代发：消息会显示由${resolveUiActorName(phoneViewerId, 'TA')}发出`
        : '已退出代发');
      paint();
      if (phoneProxyMode) {
        requestAnimationFrame(() => {
          const input = container.querySelector('.chat-composer-input');
          try {
            input?.focus?.({ preventScroll: true });
          } catch (_) {
            input?.focus?.();
          }
        });
      }
      return;
    }
    if (act === 'rolesay') {
      if (sendAsCharacterId) {
        sendAsCharacterId = '';
        showToast('已取消代发');
        paint();
        return;
      }
      const items = (chat.participants || []).filter((id) => id && id !== 'user').map((id) => ({
        id,
        name: resolveUiActorName(id, characters[id]?.name),
      }));
      if (!items.length && partnerId) items.push({ id: partnerId, name: resolveUiActorName(partnerId, partner?.name) });
      const picked = await openParticipantPicker({ title: '选择代发角色', items });
      if (picked) {
        sendAsCharacterId = picked;
        showToast(`代发已锁定：${resolveUiActorName(picked, characters[picked]?.name)}`);
        paint();
      }
      return;
    }
    if (act === 'offline-ff') {
      const { openOfflineFastForwardModal } = await import('../components/offline-fast-forward-modal.js');
      openOfflineFastForwardModal({
        chat,
        user,
        messages,
        participantOptions: (chat.participants || [])
          .filter((id) => id && id !== 'user')
          .map((id) => ({
            id,
            name: resolveUiActorName(id, characters[id]?.name || id),
          })),
        onChatUpdated: (c) => {
          Object.assign(chat, c);
        },
        reloadMessages: async () => {
          messages = await listThreadMessages();
          refreshMessages();
        },
      });
      return;
    }
    if (act === 'enter-offline') {
      try {
        const existingSession = await loadOfflineSession(chatId).catch(() => null);
        if (existingSession) {
          showToast('继续上次未收纳的线下');
          navigate('offline', { chatId });
          return;
        }
        const experienceMode = userAbsentGroup
          ? 'normal'
          : await chooseOfflineExperienceMode({
            allowAudio: !isGroup,
            title: '直接进入线下',
          });
        if (!experienceMode) return;
        navigate(experienceMode === 'audio' ? 'encounter/audio' : 'encounter/date', { chatId });
      } catch (err) {
        showToast(`进入线下失败：${err?.message || err}`);
      }
      return;
    }
    if (act === 'invite-offline') {
      const { openOfflineInviteModal } = await import('../components/offline-invite-modal.js');
      const draft = await openOfflineInviteModal({
        partnerName: resolveUiActorName(partnerId || '', partner?.name || '对方'),
      });
      if (!draft) return;
      const ts = await getNowForUser(user.id);
      const note = String(draft.note || draft.activity || '约你线下见一面').trim();
      const msg = createMessage({
        chatId,
        senderId: 'user',
        senderName: frontStageUserName(),
        type: 'offlineInvite',
        content: note,
        timestamp: ts,
        metadata: {
          offlineInvite: true,
          inviteFrom: 'user',
          place: draft.place,
          activity: draft.activity,
          timeLabel: draft.timeLabel,
          note,
          tone: draft.tone,
          status: 'pending',
        },
      });
      await persistUserMessage(msg);
      showToast('邀约卡已递出，点卡片进入线下');
      return;
    }
    if (act === 'debug-raw') {
      const row = await get(`chatAiDebug_${chatId}`);
      openTextEditorModal({
        title: '上一轮原文',
        value: row?.value?.text || '暂无记录',
        multiline: true,
        confirmLabel: '关闭',
        variant: anonEditorVariant(),
        onSave: async () => {},
      });
      return;
    }
    if (act === 'favorite') {
      const picked = messages.filter((m) => selectedSet.has(m.id));
      if (!picked.length) {
        showToast('请先选择消息');
        return;
      }
      openTextEditorModal({
        title: `收藏 ${picked.length} 条消息`,
        placeholder: '备注（可不填）',
        confirmLabel: '收藏',
        variant: anonEditorVariant(),
        onSave: async (note) => {
          try {
            await saveChatMessageFavorite({
              userId: user.id,
              chat,
              messages: picked,
              title: title || '聊天收藏',
              note,
              appearance: getChatAppearance(chat),
            });
            selectionMode = false;
            selectionPurpose = '';
            selectedSet.clear();
            refreshSelectionUi();
            showToast('已收藏到记忆馆');
          } catch (err) {
            showToast(err?.message || '收藏失败');
          }
        },
      });
      return;
    }
    if (act === 'share-moments') {
      if (isAnonymousChat(chat)) {
        showToast('匿名聊天记录不能分享到朋友圈');
        return;
      }
      const picked = messages.filter((m) => selectedSet.has(m.id));
      if (!picked.length) {
        showToast('请先选择消息');
        return;
      }
      const { shareChatLinesToMoments, buildMomentShareLinesFromMessages } = await import('../components/moments-interactions.js');
      const lines = buildMomentShareLinesFromMessages(picked, { user, characters });
      if (!lines.length) {
        showToast('所选消息没有可分享的正文');
        return;
      }
      const shared = await shareChatLinesToMoments({
        user,
        lines,
        title: title || '聊天记录',
        caption: `分享了 ${lines.length} 条聊天`,
        sourceChatId: chat.id,
        involvedActorIds: [...new Set(picked
          .map((message) => String(message?.senderId || '').trim())
          .filter((id) => id && id !== 'user' && characters[id]))],
      });
      if (!shared) return;
      selectionMode = false;
      selectionPurpose = '';
      selectedSet.clear();
      refreshSelectionUi();
      return;
    }
    if (act === 'merge-forward') {
      const picked = await Promise.all(messages
        .filter((m) => selectedSet.has(m.id))
        .map((m) => loadForwardSourceMessage(m)));
      const { openMergeForwardPicker } = await import('../components/merge-forward-picker.js');
      const dest = await openMergeForwardPicker({
        userId: user.id,
        currentChatId: chatId,
        previewLines: picked.map((m) => `${resolveUiActorName(m.senderId, m.senderName) || m.senderId}: ${m.content || ''}`.slice(0, 60)),
        title: '发给别人',
      });
      if (!dest?.chatId) return;
      const destChat = await getChat(dest.chatId).catch(() => null);
      if (!destChat || !isUserPresentInChat(destChat)) {
        showToast('该窗口不支持用户转发');
        return;
      }
      const bundleItems = picked.map((m) => {
        const type = m.type || 'text';
        let content = m.content;
        const aliasSource = resolveSanitizedForwardAliasSource(chat, m.senderId, user.id);
        if (type === 'image') {
          content = String(m.content || m.metadata?.url || '').trim();
        }
        if (type === 'link') {
          content = String(m.content || m.metadata?.url || '').trim();
          const md = m.metadata || {};
          return sanitizeForwardedAliasItem({
            senderId: m.senderId,
            senderName: resolveUiActorName(m.senderId, m.senderName),
            type,
            content,
            timestamp: m.timestamp,
            metadata: {
              title: md.title || md.pendingLinkTitle || '',
              desc: md.desc || md.pendingLinkDesc || md.descFull || '',
              coverUrl: md.coverUrl || md.imageUrl || '',
              platform: md.platform,
              url: content,
            },
          }, aliasSource);
        }
        return sanitizeForwardedAliasItem({
          senderId: m.senderId,
          senderName: resolveUiActorName(m.senderId, m.senderName),
          type,
          content,
          timestamp: m.timestamp,
        }, aliasSource);
      });
      const forwardedAliasSources = [...new Map(bundleItems
        .filter((item) => item.sourceAliasAccountId)
        .map((item) => [item.sourceAliasAccountId, {
          accountId: item.sourceAliasAccountId,
          sourceChannel: 'stranger',
          frontstageLabel: item.frontstageLabel || item.senderName || '前台账户',
        }])).values()];
      const bundle = createMessage({
        chatId: dest.chatId,
        senderId: 'user',
        senderName: frontStageUserName(),
        type: 'chatBundle',
        content: `[合并转发] ${title}`,
        timestamp: await nextChatMessageTimestamp(user.id, dest.chatId),
        metadata: {
          bundleTitle: title,
          bundleSummary: `共 ${bundleItems.length} 条`,
          items: bundleItems,
          // 陌生窗的来源会话只在本地账号隔离层有意义；转发包不携带可回查本体
          // 线程的索引，接收角色只能看到上面的前台账号与实际转发内容。
          ...(!strangerChat ? { fromChatId: chatId } : {}),
          ...(forwardedAliasSources.length ? {
            forwardedAliasSources,
            forwardedSourceChannel: 'stranger',
          } : {}),
        },
      });
      await saveMessage(bundle);
      await updateChatPreview(dest.chatId, previewFromMessage(bundle), bundle.timestamp);
      showToast('已发给别人');
      selectionMode = false;
      selectionPurpose = '';
      selectedSet.clear();
      paint();
      return;
    }
    if (act === 'select-delete') {
      const picked = messages.filter((m) => selectedSet.has(m.id));
      if (!picked.length) {
        showToast('请先选择消息');
        return;
      }
      if (!window.confirm(`确定删除已选的 ${picked.length} 条消息？此操作不可恢复。`)) return;
      await deleteVisibleMessagesOptimistically(picked);
      selectionMode = false;
      selectionPurpose = '';
      selectedSet.clear();
      refreshActionArea();
      refreshMessages();
      // 增量刷新只会移除已删节点，剩余气泡（尤其旁白/系统提示）仍可能保留旧勾选框。
      // 删除后再统一同步一次退出态，并重算输入栏停靠，避免“完成”栏残影或底栏错位。
      refreshSelectionUi();
      clearComposerDockGapRepair();
      scheduleComposerDockGapSettle();
      showToast(`已删除 ${picked.length} 条`);
      return;
    }
    if (act === 'long-image') {
      const picked = messages.filter((m) => selectedSet.has(m.id));
      try {
        // 选择消息期间角色仍可能换头像；导出前重读一次，不把进页时的旧映射带进长图。
        await refreshThreadAppearanceShell();
        const { exportChatMessagesAsLongImage } = await import('../components/chat-long-image-export.js');
        await exportChatMessagesAsLongImage({
          messages: picked,
          title,
          isGroup,
          characters,
          currentUserName,
          currentUserAvatar: user.avatar,
          currentUserId: user.id,
          resolveSenderName: async (m) => {
            if (m.senderId === 'user') return currentUserName;
            return resolveUiActorName(m.senderId, m.senderName || m.senderId || '某人');
          },
          resolveSenderAvatar: async (m) => participantIdentityLookupIds(m.senderId)
            .map((id) => characters[id])
            .find(Boolean)?.avatar || '',
          filenameBase: `${title || 'chat'}-长图`,
        });
        showToast('长图已导出');
      } catch (err) {
        showToast(err.message || '导出失败');
      }
      return;
    }
    if (act === 'scroll-capture') {
      selectionMode = true;
      selectionPurpose = 'capture';
      selectedSet.clear();
      refreshSelectionUi();
      showToast('勾选要导出的消息，再点「导出长图」');
      return;
    }
    if (act === 'scroll-capture-exit') {
      exitScrollCaptureMode();
      return;
    }
    if (act === 'advance' || act === 'reroll' || act === 'gap-fill') {
      if (isStreaming || getChatStreamSession(chatId) || abortController || manualGenerationGate.current()) return;
      if (act === 'reroll') {
        if (rerollInFlight) return;
        // 在等待下一帧之前就上锁，挡住部分安卓浏览器同一次触摸产生的重复 click。
        rerollInFlight = true;
      }
      const manualIntent = manualGenerationGate.claim(act);
      if (!manualIntent) {
        if (act === 'reroll') rerollInFlight = false;
        return;
      }
      // 按下后立即切成“停止”，同时让准备阶段也拥有可取消令牌。
      setBusy(false);
      markUserActivity();
      // 之前这里特意不收键盘，是因为 blur() 触发的原生键盘回弹会带着一次很慢的
      // JS 视口重排（--app-height 靠 visualViewport 轮询算）一起卡顿；
      // 现在原生壳走 100dvh 原生跟手，viewport 重排交给浏览器自己做，不再卡，
      // 推进/重roll 这类「大概率不会立刻继续打字」的动作可以放心收起键盘了。
      const inputEl = container.querySelector('.chat-composer-input');
      const didBlur = !!(inputEl && document.activeElement === inputEl);
      if (didBlur) inputEl.blur();
      const supportOperationStartedAt = Date.now();
      const supportOperationLabel = act === 'reroll'
        ? '聊天重 roll'
        : (act === 'gap-fill' ? '闲聊补充' : '聊天推进');
      const visibleCountBefore = messages.length;
      const visibleIdsBefore = new Set(messages.map((item) => item.id));
      recordSupportOperation({
        label: supportOperationLabel,
        status: 'started',
        startedAt: supportOperationStartedAt,
      });
      // 重 roll / 补充仍先让出一帧；手动推进则必须立刻进入 runAiReply，令它在
      // 本次点击调用栈、首个 await 之前写好耐久 preflight。否则用户恰在这一帧
      // 切后台时，既没有请求，也没有可恢复的推进意图。
      try {
        if (act !== 'advance') await waitForNextPaint();
        if (manualIntent.controller.signal.aborted) return;
        if (act === 'advance') await runAiReply('advance', { event, manualRequest: true, requestController: manualIntent.controller });
        if (act === 'reroll') await runAiReply('reroll', { event, manualRequest: true, requestController: manualIntent.controller });
        if (act === 'gap-fill') await runAiReply('gap-fill', { event, manualRequest: true, requestController: manualIntent.controller });
        const visibleDelta = messages.length - visibleCountBefore;
        const hasNewVisibleMessage = messages.some((item) => !visibleIdsBefore.has(item.id));
        recordSupportOperation({
          label: supportOperationLabel,
          status: chatError
            ? 'failed'
            : (hasNewVisibleMessage ? 'succeeded' : 'no-visible-result'),
          code: chatError?.diagnostic?.code || '',
          startedAt: supportOperationStartedAt,
          finishedAt: Date.now(),
          visibleDelta,
        });
      } finally {
        if (act === 'reroll') rerollInFlight = false;
        if (manualGenerationGate.release(manualIntent)) setBusy(isStreaming);
      }
      return;
    }
  }

  async function handleTool(tool, event = null) {
    const callGesture = tool === 'voice-call' || tool === 'video-call'
      ? captureMediaGesture(event)
      : null;
    const ambienceGestures = tool === 'voice-call' || tool === 'video-call'
      ? [captureMediaGesture(event), captureMediaGesture(event)]
      : [];
    closeToolsSheet();
    if (tool === 'phone-takeover') {
      await maybeStartSideTripCaught({ force: true, notify: true });
      return;
    }
    if (tool === 'search') {
      openChatSearchModal();
      return;
    }
    if (tool === 'image') {
      container.querySelector('.chat-image-input')?.click();
      return;
    }
    if (tool === 'draw') {
      await openChatUserGenImageModal({
        chat,
        characters,
        onSend: async ({ url, prompt }) => {
          const dataUrl = String(url || '').trim();
          if (!dataUrl) throw new Error('没有可发送的图片');
          await sendTypedMessage('image', dataUrl, {
            localName: 'user-gen.png',
            localType: 'image/png',
            compressedLocalImage: true,
            // 故意不写 generatedImage / marshmallowEventType，上下文按「用户图片」识别
            userDrawnImage: true,
            caption: String(prompt || '').trim().slice(0, 120),
          });
          showToast('已发送');
        },
      });
      return;
    }
    if (tool === 'dice') {
      const result = Math.floor(Math.random() * 6) + 1;
      await sendTypedMessage('dice', `d6=${result}`, { sides: 6, result });
      return;
    }
    if (tool === 'vote') {
      openVoteEditorModal({
        variant: anonEditorVariant(),
        onSave: async ({ title, options: voteOptions }) => {
          await sendTypedMessage('vote', title, {
            voteTitle: title,
            voteOptions,
            voteCounts: {},
            voteClosed: false,
          });
        },
      });
      return;
    }
    if (tool === 'voice') {
      openVoiceComposerSheet();
      return;
    }
    if (tool === 'voice-call') {
      cancelVoiceMessagePlayback();
      await startOutgoingVoiceCall('', 'voice', callGesture, { ambienceGestureTokens: ambienceGestures });
      return;
    }
    if (tool === 'video-call') {
      cancelVoiceMessagePlayback();
      await startOutgoingVoiceCall('', 'video', callGesture, { ambienceGestureTokens: ambienceGestures });
      return;
    }
    if (tool === 'redpacket') {
      openPaySheet('redpacket');
      return;
    }
    if (tool === 'transfer') {
      openPaySheet('transfer');
      return;
    }
    if (tool === 'ordershare') {
      openOrderGiftSheet();
      return;
    }
    if (tool === 'textimg') {
      openComposeTextEditor({
        title: '文字图',
        placeholder: '输入要展示的大段文字…',
        multiline: true,
        variant: anonEditorVariant(),
        onSave: async (text) => sendTypedMessage('textimg', text, { caption: text, text }),
      });
      return;
    }
    if (tool === 'location') {
      openComposeTextEditor({
        title: '位置',
        placeholder: '例如：云港市 · 旧街咖啡馆',
        variant: anonEditorVariant(),
        onSave: async (text) => sendTypedMessage('location', text, { label: text }),
      });
      return;
    }
    if (tool === 'link') {
      openComposeTextEditor({
        title: '链接地址',
        placeholder: 'https://weibo.com/... 或整段分享文案',
        multiline: true,
        variant: anonEditorVariant(),
        onSave: async (rawInput) => {
          const linkShare = parseSingleLinkShareText(String(rawInput || '').trim());
          if (!linkShare?.url) {
            showToast('请输入有效的小红书/微博链接或分享文案');
            return;
          }
          const ts = await getNowForUser(user.id);
          const base = createMessage({
            chatId,
            senderId: sendAsCharacterId || 'user',
            senderName: sendAsCharacterId
              ? (characters[sendAsCharacterId]?.name || characters[sendAsCharacterId]?.customNickname || sendAsCharacterId)
              : frontStageUserName(),
            type: 'link',
            content: linkShare.url,
            timestamp: ts,
            metadata: buildPendingLinkMetadata(linkShare),
          });
          if (replyTarget) {
            Object.assign(base, buildReplyTargetFields(replyTarget.raw, {
              resolveSenderLabel: resolveReplySenderLabel,
            }));
          }
          replyTarget = null;
          refreshReplyBar();
          await persistUserMessage(base);
          void enhanceSentLinkMessage(base, linkShare, { keepToken: true });
        },
      });
    }
  }

  markPerfPhase('pageSetup');
  let prefetchedPage = await initialMessagesPromise;
  if (strangerChat) {
    const purged = await purgeStrangerGeneratedUserMessages(chat).catch(() => 0);
    if (purged > 0) {
      prefetchedPage = await listMessagesPageForChat(chatId, {
        limit: CHAT_THREAD_RENDER_BATCH,
        deferHeavyImages: true,
      }).catch(() => prefetchedPage);
    }
  }
  if (prefetchedPage) {
    const worldNow = peekNowForUser(user.id) ?? await getNowForUser(user.id);
    const repair = await repairChatFutureTimestampDrift(chatId, user.id, {
      knownMessages: prefetchedPage.messages,
      worldNow,
    }).catch(() => ({ repaired: false }));
    if (repair.repaired) {
      prefetchedPage = await listMessagesPageForChat(chatId, {
        limit: CHAT_THREAD_RENDER_BATCH,
        deferHeavyImages: true,
      });
    }
  }
  if (prefetchedPage) {
    messages = prefetchedPage.messages;
    hasOlderMessages = prefetchedPage.hasMore;
    hasNewerMessages = false;
    if (isGroup) {
      const migration = await import('../core/lightweight-npc.js')
        .then((mod) => mod.migrateEphemeralNpcMessagesForChat(chat, messages, {
          userId: user?.id || '',
          phoneUserId: fromCharacterPhone ? user?.id : '',
          phoneOwnerId: fromCharacterPhone ? phoneViewerId : '',
        }))
        .catch(() => null);
      if (migration?.changed) {
        chat = migration.chat;
        messages = migration.messages;
        for (const row of migration.characters || []) characters[row.id] = row;
      }
    }
  }
  markPerfPhase('messages');
  messagesLoading = false;
  paint();
  // 火花只是顶栏装饰。旧会话可能需要一次历史日期回填，必须等首屏完成并进入空闲
  // 后再做，不能与最新消息页的 IndexedDB 查询和首帧布局争抢主线程。
  scheduleSparkStatsLoad();
  markPerfPhase('dom');
  // 首屏完成后立即预热心声快照和往期记录。两者都会复用同一个在途 Promise，
  // 避免用户点推进后才从大 settings 存储中整块读取。
  const allowLegacyUnscopedState = await canReadLegacyUnscopedChatState(chatId, user?.id || '');
  void Promise.all([
    loadChatCharState(chatId),
    ...(chat.participants || [])
      .filter((id) => id && id !== 'user' && id !== 'system')
      .map((id) => loadChatCharStateHistory(chatId, id, {
        userId: user?.id || '',
        allowLegacyUnscoped: allowLegacyUnscopedState,
      })),
  ]).catch(() => null);
  const perfTotalMs = Math.max(0, Math.round(perfLastAt - perfStartedAt));
  if (perfTotalMs >= 180) {
    console.debug('[route-perf] chat/thread', { totalMs: perfTotalMs, phases: perfPhases, tasks: perfTasks });
    import('../core/debug-log.js').then(({ appendDebugEvent }) => appendDebugEvent({
      type: 'route_phase_timing',
      level: 'info',
      message: `Route phases: chat/thread (${perfTotalMs}ms)`,
      context: { path: 'chat/thread', totalMs: perfTotalMs, phases: perfPhases, tasks: perfTasks },
    })).catch(() => {});
  }
  scheduleAdvanceContextPrewarm(0);
  void clearChatUnread(chatId).catch(() => {});
  // 角色手机“当前在做什么”属于顶栏补充状态，不再阻塞消息气泡首屏。
  void refreshHeaderCurrentContext()
    .then(() => {
      if (container.isConnected) patchHeaderStatusDom();
    })
    .catch(() => {});
  let deferredInterruptedStreamNotice = null;
  const queuedInterruptedResumeKeys = new Set();
  const evaluatingInterruptedResumeKeys = new Set();
  const shownUnsafeInterruptedKeys = new Set();
  const interruptedNoticeKey = (notice) => String(
    notice?.taskId || `${notice?.startedAt || 0}:${notice?.phase || ''}`,
  );
  const finalizeFailedInterruptedRecovery = async ({
    ledgerTask = null,
    taskId = '',
    recovered = null,
    error = null,
  } = {}) => {
    const stableTaskId = String(taskId || ledgerTask?.taskId || '').trim();
    const failureReason = String(
      recovered?.error
      || recovered?.reason
      || error?.message
      || error
      || 'recovered-result-persist-failed',
    ).trim().slice(0, 240);
    if (stableTaskId) {
      await saveGenerationTask({
        ...(ledgerTask || {}),
        taskId: stableTaskId,
        status: 'failed',
        completedAt: Date.now(),
        error: {
          kind: 'recovered-result-persist-failed',
          message: failureReason,
        },
      }).catch(() => null);
      clearPendingChatStream(chatId, { taskId: stableTaskId });
    }
    const anchorMessageId = String(ledgerTask?.anchorMessageId || '').trim();
    const anchor = anchorMessageId
      ? messages.find((message) => String(message?.id || '') === anchorMessageId)
      : null;
    if (anchor && isRealUserMessage(anchor)) {
      chatPrefs = await patchChatPrefs(chatId, {
        automaticGenerationStoppedAnchor: {
          messageId: anchorMessageId,
          messageTimestamp: Number(anchor.timestamp || 0) || 0,
          stoppedAt: Date.now(),
          reason: 'recovered-result-persist-failed',
        },
      }).catch(() => chatPrefs);
      anchor.metadata = {
        ...(anchor.metadata || {}),
        replyIntentState: 'failed',
        replyIntentCompletedAt: Date.now(),
        replyIntentFailureReason: 'recovered-result-persist-failed',
      };
      await saveMessage(anchor).catch(() => null);
    }
    if (stableTaskId) {
      try {
        const { cancelPendingActions } = await import('../core/chat/pending-actions.js');
        await cancelPendingActions(user.id, (action) => (
          String(action.payload?.generationTaskId || '') === stableTaskId
        ));
      } catch (_) {}
    }
    void import('../core/debug-log.js').then(({ appendDebugEvent }) => appendDebugEvent({
      type: 'chat_recovered_result_persist_failed',
      level: 'warn',
      message: '已取回的聊天正文未能完成本地整理，旧任务已终结',
      context: {
        chatId,
        taskId: stableTaskId,
        reason: failureReason,
      },
    })).catch(() => {});
    return failureReason;
  };
  const consumeInterruptedStreamNotice = async (providedNotice = null) => {
    if (!container.isConnected || getChatStreamSession(chatId)) return;
    const notice = providedNotice
      || deferredInterruptedStreamNotice
      || takeInterruptedChatStreamNotice(chatId);
    if (!notice) return;
    if (messagesLoading) {
      deferredInterruptedStreamNotice = notice;
      return;
    }
    deferredInterruptedStreamNotice = null;
    const intent = notice.intent || null;
    const taskId = String(notice.taskId || '').trim();
    const idempotencyKey = String(notice.idempotencyKey || '').trim();
    const aiRoundId = String(notice.aiRoundId || '').trim();
    const noticeKey = interruptedNoticeKey(notice);
    if (queuedInterruptedResumeKeys.has(noticeKey) || evaluatingInterruptedResumeKeys.has(noticeKey)) return;
    let ledgerTask = null;
    let ledgerReadable = false;
    if (taskId) {
      try {
        ledgerTask = await getGenerationTaskStrict(taskId);
        ledgerReadable = true;
      } catch (_) {
        ledgerReadable = false;
      }
    }
    if (
      ledgerTask?.status === 'received'
      && String(ledgerTask.partial || '').trim()
    ) {
      evaluatingInterruptedResumeKeys.add(noticeKey);
      try {
        const recoveredRoundId = String(ledgerTask.aiRoundId || aiRoundId || '').trim();
        const recovered = await persistMarshmallowTurn(String(ledgerTask.partial || ''), {
          chat,
          chatId,
          aiRoundId: recoveredRoundId,
          aiRoundCreatedAt: Number(ledgerTask.startedAt || 0) || Date.now(),
          rerollRootId: recoveredRoundId,
          aiRoundKind: 'recovered-foreground-result',
          messages,
          user,
          userId: user.id,
          characters,
          currentActorId: partnerId,
          currentUserName: frontStageUserName(),
          resolveSenderName: async (id) => {
            if (id === 'user') return frontStageUserName();
            const actor = characters?.[id] || null;
            return actor?.customNickname || actor?.name || String(id || '角色');
          },
          allowOpenTail: true,
          skipExistingAiRoundCleanup: false,
          reason: 'recovered-foreground-result',
        });
        if (recovered?.ok) {
          await saveGenerationTask({
            ...ledgerTask,
            status: 'completed',
            completedAt: Date.now(),
            persistedMessageCount: Number(recovered.messageCount || recovered.messages?.length || 0),
            error: null,
          }).catch(() => null);
          clearPendingChatStream(chatId, { taskId });
          try {
            const { cancelPendingActions } = await import('../core/chat/pending-actions.js');
            await cancelPendingActions(user.id, (action) => (
              String(action.payload?.generationTaskId || '') === taskId
            ));
          } catch (_) {}
          messages = await listThreadMessages();
          refreshMessages(true);
          showToast('已恢复上次完成的回复，没有重新调用接口', 3600);
          return;
        }
        await finalizeFailedInterruptedRecovery({ ledgerTask, taskId, recovered });
        showToast('上次回复未能完成整理，已停止重复恢复；可手动推进重试', 5000);
        return;
      } catch (error) {
        await finalizeFailedInterruptedRecovery({ ledgerTask, taskId, error });
        showToast('上次回复未能完成整理，已停止重复恢复；可手动推进重试', 5000);
        return;
      } finally {
        evaluatingInterruptedResumeKeys.delete(noticeKey);
      }
    }
    const locallySafePreparingResume = (notice.phase === 'preparing' || notice.phase === 'ready')
      && Number(notice.attempt || 0) === 0
      && Number(notice.dispatchStartedAt || 0) <= 0
      && Number(notice.requestStartedAt || 0) <= 0
      && !!taskId
      && !!idempotencyKey
      && !!aiRoundId
      && intent?.type === 'manual-advance'
      && intent?.autoResumeBeforeRequest === true
      && Number(intent.messageCount || 0) === messages.length;
    let ledgerSafe = false;
    if (locallySafePreparingResume) {
      evaluatingInterruptedResumeKeys.add(noticeKey);
      try {
        ledgerSafe = ledgerReadable && (!ledgerTask || (
          isGenerationTaskSafePreDispatch(ledgerTask)
          && String(ledgerTask.idempotencyKey || '').trim() === idempotencyKey
          && (!String(ledgerTask.aiRoundId || '').trim() || String(ledgerTask.aiRoundId || '').trim() === aiRoundId)
        ));
      } finally {
        evaluatingInterruptedResumeKeys.delete(noticeKey);
      }
    }
    const safePreparingResume = locallySafePreparingResume
      && ledgerSafe
      && String(intent.lastMessageId || '') === String(messages[messages.length - 1]?.id || '');
    if (!safePreparingResume) {
      // 请求已可能抵达上游时不自动重发，避免重复计费和重复落库。
      if (taskId) unsafeInterruptedGenerationTaskIds.add(taskId);
      if (!shownUnsafeInterruptedKeys.has(noticeKey)) {
        shownUnsafeInterruptedKeys.add(noticeKey);
        showToast('上次生成结果无法确认，已停止自动补发；再次手动推进会作为一次新调用', 6000);
      }
      return;
    }
    queuedInterruptedResumeKeys.add(noticeKey);
    showToast('上次推进尚未发出接口请求，正在继续', 2600);
    window.setTimeout(() => {
      if (!container.isConnected) {
        queuedInterruptedResumeKeys.delete(noticeKey);
        return;
      }
      if (container.hidden || document.hidden) {
        queuedInterruptedResumeKeys.delete(noticeKey);
        deferredInterruptedStreamNotice = notice;
        return;
      }
      if (getChatStreamSession(chatId) || isStreaming) {
        queuedInterruptedResumeKeys.delete(noticeKey);
        return;
      }
      void runAiReply('advance', {
        manualRequest: true,
        settleWithoutReplay: true,
        generationTaskId: taskId,
        generationIdempotencyKey: idempotencyKey,
        generationAiRoundId: aiRoundId,
        generationPreviousTaskId: String(notice.intent?.previousGenerationTaskId || '').trim(),
        generationStartedAt: Number(notice.startedAt || 0),
      }).finally(() => queuedInterruptedResumeKeys.delete(noticeKey));
    }, 0);
  };
  addPageLifetimeListener(window, CHAT_STREAM_INTERRUPTED_EVENT, (event) => {
    const chatIds = Array.isArray(event?.detail?.chatIds) ? event.detail.chatIds : [];
    if (chatIds.length && !chatIds.includes(chatId)) return;
    void consumeInterruptedStreamNotice();
  });
  addPageLifetimeListener(window, 'pageshow', () => { void consumeInterruptedStreamNotice(); }, { passive: true });
  addPageLifetimeListener(document, 'visibilitychange', () => {
    if (!document.hidden) void consumeInterruptedStreamNotice();
  });

  if (prefetchedPage) {
    refreshStaleLinkMessages();
    recoverRealPersonSchedulingAfterLoad();
    void consumeInterruptedStreamNotice();
  } else {
    // 首屏预取失败时兜底重试一次，仍走完整的加载态流程。
    void loadInitialMessages().then(() => {
      recoverRealPersonSchedulingAfterLoad();
      void consumeInterruptedStreamNotice();
    }).catch((err) => {
      messagesLoading = false;
      refreshMessages();
      showToast(err?.message || '消息加载失败');
    });
  }

  const activeStream = getChatStreamSession(chatId);
  if (activeStream?.abortController?.signal?.aborted) {
    endChatStreamSession(chatId);
  } else if (activeStream) {
    isStreaming = true;
    abortController = activeStream.abortController;
    setBusy(true);
    setStreamingPlaceholderVisible(true, chatStreamPlaceholderText(activeStream));
  } else {
    void consumeInterruptedStreamNotice();
  }

  addPageLifetimeCleanup(subscribeChatStreamSession(() => {
    if (!container.isConnected) return;
    const active = getChatStreamSession(chatId);
    if (active?.abortController?.signal?.aborted) {
      endChatStreamSession(chatId);
      return;
    }
    if (active) {
      cloudTypingRefreshSeq += 1;
      isStreaming = true;
      abortController = active.abortController || abortController;
      setBusy(true);
      setStreamingPlaceholderVisible(
        !streamingPreviewPaintedThisTurn,
        chatStreamPlaceholderText(active),
      );
      return;
    }
    // 订阅是全局的：其它会话的前台流开始/结束也会通知这里。当前会话若正由
    // headless 后台生成，不能因为“本会话没有前台 stream session”就把停止键和
    // 「正在输入」清掉；这正是后台状态偶发顶掉/消失的竞态。
    if (headlessReplyVisible || isHeadlessChatReplyTyping(chatId)) {
      syncHeadlessReplyUi(isHeadlessChatReplyTyping(chatId));
      return;
    }
    if (cloudTypingVisible) {
      setBusy(true);
      setStreamingPlaceholderVisible(true);
      return;
    }
    if (!isStreaming) return;
    isStreaming = false;
    abortController = null;
    setBusy(false);
    // 本页手动推进会在 finally 中用准确的 revealIds 完成最终绘制。此时先保留
    // 「正在输入」，让最终绘制把它和首条角色气泡在同一帧交换；若现在就删除，
    // 后面的异步收尾会留下可见空档，长会话就会先跳回旧消息再回到底部。
    if (localRoundOwnsPaint()) {
      pendingLocalPaintDbRefresh = true;
      return;
    }
    setStreamingPlaceholderVisible(false);
    const prevIds = new Set(messages.map((m) => m?.id).filter(Boolean));
    listThreadMessages().then((rows) => {
      messages = rows;
      const newIds = rows.map((m) => m?.id).filter((id) => id && !prevIds.has(id));
      refreshMessages(false, { revealIds: revealIdsForPaint(newIds) });
    }).catch(() => refreshMessages());
  }));

  addPageLifetimeListener(window, 'chat-visible-ai-reply-persisted', (event) => {
    const detail = event?.detail || {};
    if (String(detail.chatId || '') !== chatId) return;
    const ownsLocalPaint = localRoundOwnsPaint();
    const persisted = (Array.isArray(detail.messages) ? detail.messages : [])
      .filter((message) => message && String(message.chatId || '') === chatId);
    if (!persisted.length) return;
    const byId = new Map(messages.filter(Boolean).map((message) => [String(message.id || ''), message]));
    persisted.forEach((message) => {
      const id = String(message.id || '').trim();
      if (id) {
        byId.set(id, message);
        if (ownsLocalPaint) persistedReplyPaintedIdsThisTurn.add(id);
      }
    });
    messages = [...byId.values()].sort(compareChatMessageChronology);
    visibleMessageLimit = Math.max(visibleMessageLimit, messages.length);
    if (document.hidden || container.hidden || !container.isConnected) {
      // 落库事件可能在 Keep-Alive 页或其它设置页停留时送达。此时只同步内存，
      // 不把“事件已触发”误记成气泡已绘制，也不在恢复后补演逐条动画。
      if (ownsLocalPaint) generationWasHiddenThisTurn = true;
      pendingMessagesRefreshOnResume = true;
      clearStreamingMessagePreview();
      return;
    }
    // headless 模块会先广播“可见回复”并准备一次 DB 兜底刷新；本监听已经拿到了
    // 同一批耐久消息，作废那次延迟刷新，避免它紧接着取消逐条出现动画。
    if (!ownsLocalPaint) headlessReplyRecoverySeq += 1;
    // 原生缓冲流可能在请求完成后快速交付整段 SSE，临时预览已经把完整回复画过。
    // 正式消息接管时必须记住这个事实；若先无条件改成 true 再启动 reveal，用户会
    // 看到“完整回复闪现 → 清掉 → 又从第一条重新跳一遍”。
    const hadStreamingPreview = streamingPreviewPaintedThisTurn;
    if (ownsLocalPaint) {
      streamingPreviewPaintedThisTurn = true;
      persistedReplyPaintedThisTurn = true;
    } else {
      cloudTypingVisible = false;
      cloudTypingHoldUntil = Date.now() + 30_000;
      pendingMessagesRefreshOnResume = false;
    }
    clearStreamingMessagePreview();
    setStreamingPlaceholderVisible(false);
    if (!ownsLocalPaint && !getChatStreamSession(chatId) && !isHeadlessChatReplyTyping(chatId)) {
      setBusy(false);
    }
    refreshMessages(false, {
      revealIds: ((ownsLocalPaint && generationWasHiddenThisTurn) || hadStreamingPreview)
        ? []
        : revealIdsForPaint(Array.isArray(detail.messageIds) ? detail.messageIds : []),
    });
    if (ownsLocalPaint && (!streamingPreviewFirstPaintAt || !persistedReplyFirstPaintAt)) {
      void waitForNextPaint().then(() => {
        if (
          !document.hidden
          && container.isConnected
          && !container.hidden
        ) {
          const paintedAt = Date.now();
          if (!streamingPreviewFirstPaintAt) streamingPreviewFirstPaintAt = paintedAt;
          if (!persistedReplyFirstPaintAt) persistedReplyFirstPaintAt = paintedAt;
        }
      });
    }
    pinThreadForActiveStream();
  });

  let startCallRequestRunning = false;
  const handledStartCallNonces = new Set();
  const consumeStartCallRequest = async (routeParams = {}) => {
    if (String(routeParams.startCall || '').trim() !== '1' || startCallRequestRunning) return false;
    const callNonce = String(routeParams.callNonce || '').trim() || `${chatId}:direct`;
    if (handledStartCallNonces.has(callNonce)) return false;
    startCallRequestRunning = true;
    handledStartCallNonces.add(callNonce);
    cancelVoiceMessagePlayback();
    try {
      const modal = await startOutgoingVoiceCall(
        String(routeParams.callNote || ''),
        String(routeParams.callMode || 'voice'),
        takePendingMediaGesture(),
      );
      if (!modal) throw new Error('通话窗口未能打开');
      const cleanParams = { chatId, ...(anonShell ? { from: shellFrom } : {}) };
      const sp = new URLSearchParams(cleanParams);
      window.history.replaceState(
        { path: 'chat/thread', params: cleanParams },
        '',
        `#chat/thread?${sp.toString()}`,
      );
      return true;
    } catch (err) {
      handledStartCallNonces.delete(callNonce);
      showToast(`语音通话未能打开：${err?.message || err}`);
      return false;
    } finally {
      startCallRequestRunning = false;
    }
  };
  // chat/thread 会被 Keep-Alive。复挂旧聊天页时 render 不会重跑，必须从路由激活事件
  // 消费通讯录带来的拨号意图，否则只会停在聊天界面，看起来像按钮没有反应。
  addPageLifetimeListener(window, 'marshmallow-route-activated', (event) => {
    if (event?.detail?.path !== 'chat/thread' || event.detail.container !== container) return;
    void consumeStartCallRequest(event.detail.params || {});
  });

  if (String(params.startCall || '').trim() === '1') {
    await consumeStartCallRequest(params);
  }

  if (String(params.startCall || '').trim() !== '1') {
    const activeCallId = sessionStorage.getItem(`activeVoiceCall:${chatId}`);
    const isActiveVoiceCall = (m) => (
      m?.type === 'voiceCall'
      && normalizeVoiceCallState(m.metadata?.callState || m.metadata?.state || '') === 'active'
    );
    const activeCall = messages.find((m) => (
      m.id === activeCallId
      && isActiveVoiceCall(m)
    )) || [...messages].reverse().find(isActiveVoiceCall);
    if (activeCall && !document.querySelector('.voice-call-overlay')) {
      sessionStorage.setItem(`activeVoiceCall:${chatId}`, activeCall.id);
      cancelVoiceMessagePlayback();
      await openVoiceCallFromMessage(activeCall, { skipOpening: true, minimized: true });
    }
  }

  if (params.pendingMusic) {
    navigate('chat/thread', {
      chatId,
      ...(fromCharacterPhone ? { viewer: phoneViewerId, from: 'phone' } : {}),
      ...(anonShell ? { from: shellFrom } : {}),
    }, true);
  }

  const pendingMusicKey = `pendingMusic_${chatId}`;
  const pendingMusicRaw = sessionStorage.getItem(pendingMusicKey);
  if (pendingMusicRaw) {
    sessionStorage.removeItem(pendingMusicKey);
    try {
      const track = JSON.parse(String(pendingMusicRaw));
      await sendTypedMessage('link', track.url || track.title, {
        title: `🎵 ${track.title}`,
        url: track.url || '#',
        musicTitle: track.title,
      });
      const caption = String(track.caption || '').trim();
      const lyric = String(track.lyric || '').trim();
      if (caption || lyric) {
        const shareText = [
          `（分享了《${track.title}》${track.artist ? ` - ${track.artist}` : ''}）`,
          caption,
          lyric ? `其中这几句：\n${lyric}` : '',
        ].filter(Boolean).join('\n');
        await sendTypedMessage('text', shareText);
      }
    } catch {
      /* ignore */
    }
  }

  const phoneCinematicJobId = String(params.phoneCinematic || '').trim();
  if (phoneCinematicJobId) {
    const cleanParams = {
      chatId,
      ...(offlineChatId ? { offlineChatId } : {}),
      ...(fromCharacterPhone ? { viewer: phoneViewerId, from: 'phone' } : {}),
      ...(anonShell ? { from: shellFrom } : {}),
    };
    const sp = new URLSearchParams(cleanParams);
    window.history.replaceState(
      { path: 'chat/thread', params: cleanParams },
      '',
      `#chat/thread?${sp.toString()}`,
    );
    await playOfflinePhoneCinematic(phoneCinematicJobId);
  }

  addPageLifetimeListener(window, 'marshmallow-route-settled', (ev) => {
    const path = String(ev?.detail?.path || '');
    // 离开本会话页时，即使输入框没触发 blur，也算停止输入并开始计时。
    if (path && path !== 'chat/thread') {
      setComposerFocusState(false);
      return;
    }
    const paramsChatId = String(ev?.detail?.params?.chatId || '').trim();
    if (path === 'chat/thread' && paramsChatId && paramsChatId !== String(chatId || '').trim()) {
      setComposerFocusState(false);
    }
  });

  addPageLifetimeListener(window, 'marshmallow-route-activated', (ev) => {
    const detail = ev.detail || {};
    if (!detail.resumed || detail.container !== container || detail.path !== 'chat/thread') return;
    void reconcileOfflinePresenceBar();
    // 页面刚重新入树时不要信任挂起前的 DOM/增量绘制快照。尤其 iOS WebKit 可能
    // 没有提交 detached DOM 上发生的异步更新，先用当前内存消息强制画出正确内容。
    reconcileGenerationUiAfterResume();
    lastPaintSnapshot = null;
    recoverBlankChatMediaImages();
    recoverMissedRealPersonAutoReply();
    const mainOnResume = container.querySelector('.chat-thread-messages');
    if (mainOnResume) bindLazyMediaHydration(mainOnResume);
    const hasRenderedBubbles = !!(mainOnResume && mainOnResume.childElementCount > 0);
    // 有壁纸 + Keep-Alive 复进：气泡已经在 DOM 里时绝不要再整区 opacity:0，
    // 否则每次从列表点进来都会「空一下/闪一下」；只同步钉底即可。
    // 路由会先把缓存页挂回 DOM，再同步派发本事件；必须在当前调用栈内立即换成
    // 本会话 CSS，避免浏览器首帧拿「新会话 DOM + 上一会话全局 style」绘制。
    try {
      const resumedAppearance = resolveThreadAppearance(chat);
      applyThreadBubbleVars(resumedAppearance);
      syncChatWallpaperShell(container, chat);
      applyChatThreadAppearance(resumedAppearance);
    } catch (_) {}
    void (async () => {
      const routeParams = detail.params || {};
      const fromNotify = String(routeParams.entry || '').trim() === 'notify';
      const [freshChat, resumedChatPrefs] = await Promise.all([
        getChat(chatId).catch(() => chat),
        loadChatPrefsWithExpiredStatus(chatId).catch(() => chatPrefs),
      ]);
      if (freshChat) chat = freshChat;
      const voicePerformanceModeChanged = (resumedChatPrefs?.voicePerformanceMode === true)
        !== (chatPrefs?.voicePerformanceMode === true);
      const voicePerformanceContinuousChanged = (resumedChatPrefs?.voicePerformanceContinuous === true)
        !== (chatPrefs?.voicePerformanceContinuous === true);
      chatPrefs = resumedChatPrefs || chatPrefs;
      if (!container.isConnected || container.hidden) return;
      const pinToLatest = shouldPinThreadToLatest(routeParams, freshChat || chat, {
        includeUnread: !hasRenderedBubbles,
      })
        || isNearBottom(mainOnResume, 60)
        || fromNotify;
      if (pinToLatest) {
        beginFollowingLatestMessages();
        if (mainOnResume) mainOnResume.scrollTop = mainOnResume.scrollHeight;
        if (!hasRenderedBubbles) {
          suppressThreadScrollFlash = true;
          mainOnResume?.classList.add('is-entry-settling');
        } else {
          suppressThreadScrollFlash = false;
          mainOnResume?.classList.remove('is-entry-settling');
        }
      }
      try {
        applyThreadBubbleVars(resolveThreadAppearance(chat));
        syncChatWallpaperShell(container, chat);
        applyChatThreadAppearance(resolveThreadAppearance(chat));
      } catch (_) {}
      // 气泡已在 DOM 时不要先整表刷一轮；loadInitialMessages 会在列表变化时再画。
      // 否则 Keep-Alive 复进会「占位→真图」连闪好几次。
      // 点系统通知进会话：即使 DOM 里还有旧空状态，也必须先标 pending 再强制拉库。
      if (fromNotify) pendingMessagesRefreshOnResume = true;
      if (!hasRenderedBubbles && (pendingMessagesRefreshOnResume || messages.length || fromNotify)) {
        refreshMessages();
      } else if (voicePerformanceModeChanged || voicePerformanceContinuousChanged) {
        lastPaintSnapshot = null;
        refreshMessages();
      }
      await clearChatUnread(chatId).catch(() => {});
      await refreshThreadAppearanceShell();
      await refreshHeaderStatus().catch(() => {});
      // 本上下文写入会标 pending；后台调度、其它页面或其它浏览器上下文写入则可能
      // 没有本地广播。用已读取的 chat 摘要与缓存尾消息核对，只在确有变化时重读消息库。
      const shouldReloadMessages = shouldReloadCachedThreadMessages({
        freshChat: freshChat || chat,
        cachedMessages: messages,
        hasRenderedBubbles,
        pendingWrite: pendingMessagesRefreshOnResume,
        fromNotification: fromNotify,
      });
      if (shouldReloadMessages) {
        await loadInitialMessages();
      }
      if (hasActiveGenerationControl()
        && !(headlessReplyVisible && headlessRoundBubblesPainted())) {
        setStreamingPlaceholderVisible(true, chatStreamPlaceholderText(getChatStreamSession(chatId)));
      }
      if (holdBottomUntilSettled) {
        const main = container.querySelector('.chat-thread-messages');
        if (main) main.scrollTop = main.scrollHeight;
        scrollToBottom(() => tryReleaseEntryFlash());
        requestAnimationFrame(() => {
          requestAnimationFrame(() => tryReleaseEntryFlash());
        });
        window.setTimeout(() => tryReleaseEntryFlash(), 220);
      }
      pendingMessagesRefreshOnResume = false;
      // Keep-Alive 复挂后数据已经对账完成，此时补热当前窗口。A/B 会话之间切换
      // 只切换各自的物化快照，不应等用户再次点击推进才开始拼接。
      scheduleAdvanceContextPrewarm(0);
    })().catch(() => refreshMessages());
  });

  addPageLifetimeListener(document, 'visibilitychange', onChatStreamVisibilityChange);

  // 云端中继生成中：聊天窗补「正在输入」（本地流式会话优先，不抢）。
  let cloudTypingTimer = 0;
  let cloudTypingFalseSince = 0;
  async function refreshCloudTypingHint() {
    const seq = ++cloudTypingRefreshSeq;
    if (!container.isConnected || container.hidden) return;
    if ((isStreaming && !cloudTypingVisible) || getChatStreamSession(chatId)) return;
    try {
      const { isCloudScheduledBackgroundEnabled } = await import('../core/generation-relay.js');
      if (seq !== cloudTypingRefreshSeq) return;
      if (!isCloudScheduledBackgroundEnabled()) {
        if (cloudTypingVisible) {
          cloudTypingVisible = false;
          setStreamingPlaceholderVisible(false);
          setBusy(false);
        }
        return;
      }
      const { getCloudChatTypingHint } = await import('../core/cloud-background-coordinator.js');
      const hint = await getCloudChatTypingHint(chatId);
      if (seq !== cloudTypingRefreshSeq
        || getChatStreamSession(chatId)
        || (isStreaming && !cloudTypingVisible)
        || isHeadlessChatReplyTyping(chatId)) return;
      let show = hint?.typing === true;
      let forceHide = false;
      if (show && getRealPersonComposeBlock().blocked) {
        const { cancelCloudChatGeneration } = await import('../core/cloud-background-coordinator.js');
        await cancelCloudChatGeneration?.(chatId, 'composer-active').catch(() => {});
        if (seq !== cloudTypingRefreshSeq) return;
        composerCancelledCloudGeneration = true;
        scheduleComposerCloudResync(realPersonComposeSettleMs() + 100);
        show = false;
        forceHide = true;
      }
      // 消息刚落地后的抑制窗：本地链路已把这轮生成写进聊天、云端计划还没对账掉时，
      // 「已到点未成功」的过期计划会让轮询在气泡后面再补一轮假的「正在输入」。
      if (show && hint?.reason === 'due' && Date.now() < cloudTypingHoldUntil) {
        show = false;
        forceHide = true;
      }
      if (show) {
        cloudTypingFalseSince = 0;
      } else if (cloudTypingVisible && !forceHide) {
        if (!cloudTypingFalseSince) {
          cloudTypingFalseSince = Date.now();
          return;
        }
        if (Date.now() - cloudTypingFalseSince < 6500) return;
      } else {
        cloudTypingFalseSince = 0;
      }
      if (seq !== cloudTypingRefreshSeq) return;
      if (show !== cloudTypingVisible) {
        const wasCloudTypingVisible = cloudTypingVisible;
        cloudTypingVisible = show;
        if (!show) cloudTypingFalseSince = 0;
        setStreamingPlaceholderVisible(show, '正在输入…');
        setBusy(show);
        if (wasCloudTypingVisible && !show && pendingMessagesRefreshOnResume) {
          void refreshThreadMessagesAfterForeground({ forcePin: true, animateNewMessages: true });
        }
      } else if (show) {
        setStreamingPlaceholderVisible(true, '正在输入…');
        setBusy(true);
      }
    } catch (_) {}
  }
  function startCloudTypingWatch() {
    if (cloudTypingTimer) window.clearInterval(cloudTypingTimer);
    cloudTypingTimer = window.setInterval(() => {
      refreshCloudTypingHint().catch(() => {});
    }, 4000);
    refreshCloudTypingHint().catch(() => {});
  }
  startCloudTypingWatch();
  addPageLifetimeCleanup(() => {
    if (cloudTypingTimer) window.clearInterval(cloudTypingTimer);
    cloudTypingTimer = 0;
  });

  function syncHeadlessReplyUi(running) {
    const wasVisible = headlessReplyVisible;
    headlessReplyVisible = running === true;
    if (headlessReplyVisible && !wasVisible) {
      // 占用开始：记下当前列表末尾，本轮新气泡画出来后占位就该让位。
      headlessBaselineMsgId = String(messages[messages.length - 1]?.id || '');
    }
    if (!headlessReplyVisible) headlessBaselineMsgId = '';
    if (headlessReplyVisible) {
      // 后台链路已经取得本会话的生成权，取消本页同一时刻的真人感定时器，
      // 避免后台落库与前台重试擦肩而过后重复生成第二轮。
      cancelRealPersonAutoReply();
      cancelRealPersonChase();
    }
    if (!container.isConnected || container.hidden || document.hidden) {
      if (wasVisible && !headlessReplyVisible) autoReplyMissedWhileHidden = true;
      return;
    }
    if (headlessReplyVisible) {
      // 气泡已经落地、只剩 persist 收尾：不要再把「正在输入」补回气泡后面
      //（回前台重放 running=true 时最容易踩到）。
      if (headlessRoundBubblesPainted()) {
        setStreamingPlaceholderVisible(false);
        setBusy(false);
        return;
      }
      setBusy(true);
      setStreamingPlaceholderVisible(true, '正在输入…');
      return;
    }
    // 本地流式回合拥有自己的状态，后台回合结束时不能把它的停止按钮和占位一起清掉。
    if (getChatStreamSession(chatId) || abortController || cloudTypingVisible) return;
    setStreamingPlaceholderVisible(false);
    setBusy(false);
    if (wasVisible) {
      // 后台回合曾真正进入 typing 后会取消本页真人感计时器，但它可能因为碰撞、
      // 输入避让或临时门禁在没有可见气泡时结束。释放事件不能只清占位：从 DB
      // 对账后，仍悬空的用户消息必须重新进入秒级回复链路。
      const recoverySeq = ++headlessReplyRecoverySeq;
      // visible-reply 事件与 headless 状态释放在同一调用栈内先后广播。让 DB 兜底
      // 延后一拍：可见事件若已携带完整消息，会递增 recoverySeq 并直接完成绘制；
      // 只有确实错过该事件时才整页回读。
      void Promise.resolve().then(() => {
        if (recoverySeq !== headlessReplyRecoverySeq) return false;
        return refreshThreadMessagesAfterForeground({ forcePin: true, animateNewMessages: true });
      }).then(() => {
        if (recoverySeq !== headlessReplyRecoverySeq) return;
        if (!container.isConnected || container.hidden || document.hidden) {
          autoReplyMissedWhileHidden = true;
          return;
        }
        if (getUnansweredRealUserMessage(messages) && !isChatStreamPendingAnywhere(chatId)) {
          void scheduleRealPersonAutoReply();
        }
      });
      return;
    }
    void refreshThreadMessagesAfterForeground({ forcePin: true, animateNewMessages: true });
  }

  /**
   * Keep-Alive 页面复挂时，以真实会话/后台任务重新建立 UI 控制权。
   * 隐藏期间事件只更新内存标记、不操作 detached DOM；若不在这里对账，
   * 就会出现消息区显示「正在输入」但发送键仍是发送/推进，或任务已经结束却仍显示停止。
   */
  function reconcileGenerationUiAfterResume() {
    const activeStream = getChatStreamSession(chatId);
    if (activeStream?.abortController?.signal?.aborted) {
      endChatStreamSession(chatId);
    } else if (activeStream) {
      abortController = activeStream.abortController || abortController;
      setBusy(true);
      setStreamingPlaceholderVisible(true, chatStreamPlaceholderText(activeStream));
      armGenerationWatchdog();
      return 'stream';
    }

    abortController = null;
    if (isHeadlessChatReplyTyping(chatId)) {
      syncHeadlessReplyUi(true);
      return 'headless';
    }

    if (headlessReplyVisible) {
      headlessReplyVisible = false;
      headlessBaselineMsgId = '';
    }
    if (cloudTypingVisible) {
      setBusy(true);
      setStreamingPlaceholderVisible(true);
      return 'cloud';
    }

    // 前台会话或后台任务可能在本页隐藏期间结束，订阅回调因 detached DOM 提前返回。
    // 此时清掉挂起前遗留的 busy/占位，再立即向云端协调器复核一次。
    setStreamingPlaceholderVisible(false);
    setBusy(false);
    void refreshCloudTypingHint();
    return 'idle';
  }

  addPageLifetimeListener(window, 'headless-chat-reply-state', (ev) => {
    const detail = ev?.detail || {};
    if (String(detail.chatId || '').trim() !== String(chatId || '').trim()) return;
    // claim 只表示后台领取了任务，prepare 仍可能因旧锚点、前台生成或输入占用而退出。
    // 只有真正开始模型请求后才接管 UI/取消前台计时器，否则第二轮的新排程会被旧任务空领取吞掉。
    syncHeadlessReplyUi(
      detail.running === true
      && detail.visibleReply !== true
      && detail.typingStarted === true,
    );
  });
  if (isHeadlessChatReplyTyping(chatId)) syncHeadlessReplyUi(true);

  // 后台自动闲聊 / 日程主动等写库完成后：若用户正停在本会话，立刻同步最新气泡。
  addPageLifetimeListener(window, 'background-trigger', (ev) => {
    const detail = ev?.detail || {};
    if (String(detail.chatId || '').trim() !== String(chatId || '').trim()) return;
    if (!container.isConnected) return;
    cloudTypingVisible = false;
    cloudTypingHoldUntil = Date.now() + 30_000;
    setStreamingPlaceholderVisible(false);
    if (!headlessReplyVisible && !getChatStreamSession(chatId)) setBusy(false);
    if (container.hidden || document.hidden) {
      pendingMessagesRefreshOnResume = true;
      return;
    }
    void refreshThreadMessagesAfterForeground({
      forcePin: !!detail.generated,
      animateNewMessages: !!detail.generated,
    });
  });

  addPageLifetimeListener(window, 'marshmallow-autonomy-changed', (ev) => {
    const detail = ev?.detail || {};
    if (String(detail.userId || '') !== String(user?.id || '')) return;
    if (String(detail.characterId || '') !== String(partnerId || '')) return;
    // 设置页和聊天页可能同时被 Keep-Alive：立即作废 30 秒策略缓存，
    // 不要求用户退出聊天或等待下一次缓存过期。
    realPersonPolicyCache.at = 0;
    const enabled = detail.settings?.roleDefaults?.realPersonMode?.enabled === true;
    const chatOverride = detail.settings?.chatOverrides?.[chatId];
    const proactiveEnabled = chatOverride
      && Object.prototype.hasOwnProperty.call(chatOverride, 'totalEnabled')
      ? chatOverride.totalEnabled === true
      : detail.settings?.roleDefaults?.totalEnabled === true;
    if (!enabled) {
      cancelRealPersonAutoReply();
      cancelRealPersonChase();
      autoReplyMissedWhileHidden = false;
      chaseMissedWhileHidden = false;
      return;
    }
    if (!proactiveEnabled) {
      cancelRealPersonChase();
      chaseMissedWhileHidden = false;
      chaseCount = 0;
    }
    if (!container.isConnected || container.hidden || document.hidden) return;
    const lastVisible = getLastVisibleConversationMessage(messages);
    if (!lastVisible) return;
    if (getUnansweredRealUserMessage(messages)) void scheduleRealPersonAutoReply();
    else if (proactiveEnabled && isCharacterConversationMessage(lastVisible)) void scheduleRealPersonChase();
  });

  addPageLifetimeListener(window, 'marshmallow-appearance-changed', () => {
    if (!container.isConnected || container.hidden) return;
    void refreshThreadAppearanceShell();
  });

  // 通讯录 / 聊天详情页改头像、备注不会主动通知这个已打开的会话页，
  // 靠 IndexedDB 写入广播兜底，避免要等切页/整页重渲染才看到新名字新头像。
  addPageLifetimeCleanup(onStoreWrite('characters', (key) => {
    if (key && partnerId && key !== partnerId && !characters[key]) return;
    invalidateAdvanceContextPrewarm();
    scheduleAdvanceContextPrewarm(500);
    if (!container.isConnected || container.hidden) return;
    void refreshThreadAppearanceShell({ forceMessageRepaint: true });
  }));
  addPageLifetimeCleanup(onStoreWrite('settings', (key) => {
    // 生成任务检查点、外观等 settings 写入很频繁，但并不参与上下文；不要让
    // 这些后台写入反复清掉已经拼好的窗口快照。上下文模块统一判定依赖范围。
    void import('../core/context/build-chat-context.js').then((mod) => {
      if (!mod.isChatContextRelevantSettingsKey?.(key)) return;
      invalidateAdvanceContextPrewarm();
      scheduleAdvanceContextPrewarm(700);
    }).catch(() => {});
    if (!container.isConnected || container.hidden) return;
    if (offlineChatId && String(key || '') === offlineSessionKey(offlineChatId)) {
      void reconcileOfflinePresenceBar();
      return;
    }
    if (key && key !== chatPrefsKey(chatId)) return;
    void refreshThreadAppearanceShell();
  }));
  addPageLifetimeCleanup(onStoreWrite('users', (key) => {
    if (key && key !== user?.id) return;
    invalidateAdvanceContextPrewarm();
    scheduleAdvanceContextPrewarm(500);
    if (!container.isConnected || container.hidden) return;
    void refreshThreadAppearanceShell({ forceMessageRepaint: true });
  }));
  // 后台生图完成后会更新 messages；打开中的会话要立刻换掉「生成中」占位。
  // 后台自动闲聊等批量写入（key 常为空）也要同步，否则点通知回来仍是旧列表。
  // 流式中也要合并：另一路 headless 回合可能已落库并弹了通知。
  addPageLifetimeCleanup(onStoreWrite('messages', (key) => {
    if (key && consumeLocalTranslationWrite(key)) return;
    // 本页已经乐观绘制的发送/编辑/删除不需要再排一次整页回读；后台生图、
    // headless 回复和其它页面写入仍走下面的同步链路。
    if (key && hasLocalMessageMutation(key)) return;
    // 消息变化只推进精确锚点，保留同会话的短时旧快照作为切后台兜底；
    // 角色、设置与用户资料变化仍由上方监听彻底清除，避免跨配置复用。
    if (!localRoundOwnsPaint()) invalidateAdvanceContextPrewarm({ preserveRecent: true });
    // Keep-Alive 会把页面从 DOM 摘下；挂起期间也要记住写入，复挂后才知道需要拉库。
    if (!container.isConnected || container.hidden || document.hidden) {
      pendingMessagesRefreshOnResume = true;
      return;
    }
    // 当前前台回合自己持有最终绘制权；AI 消息逐条落库时不让 220ms 广播刷新抢跑。
    if (localRoundOwnsPaint()) {
      pendingLocalPaintDbRefresh = true;
      return;
    }
    const pendingIds = messages
      .filter((m) => m?.metadata?.generatingImage)
      .map((m) => m.id)
      .filter(Boolean);
    if (pendingIds.length && (!key || pendingIds.includes(key))) {
      void (async () => {
        const changed = await syncGeneratingImageMessagesFromDb();
        if (changed && container.isConnected && !container.hidden) refreshMessages();
      })();
    }
    // 后台/云端任务仍显示“正在输入”时不抢先整表重绘，以免完整回复先闪现、
    // 随后又被逐条揭示流程藏回去。先记住落库变化；任务的可见回复、终态或
    // background-trigger 事件会立即对账。上面的生图占位仍可做局部替换。
    if (headlessReplyVisible
      || cloudTypingVisible
      || isHeadlessChatReplyTyping(chatId)) {
      pendingMessagesRefreshOnResume = true;
      return;
    }
    window.clearTimeout(messagesStoreRefreshTimer);
    const runMessagesStoreRefresh = () => {
      // 定时器排队后也可能恰好开始了本地回合，执行前再核验一次。
      if (localRoundOwnsPaint()) {
        pendingLocalPaintDbRefresh = true;
        return;
      }
      if (!container.isConnected || container.hidden || document.hidden) {
        pendingMessagesRefreshOnResume = true;
        return;
      }
      // 通知/后台角色消息的写库广播不要在用户滑动长列表时触发整表重绘。
      // 手势结束后再刷新，既不会漏消息，也避免滑动中突然掉帧或跳位置。
      const scrollWait = userScrollingMessagesUntil - Date.now();
      if (scrollWait > 0) {
        messagesStoreRefreshTimer = window.setTimeout(runMessagesStoreRefresh, scrollWait + 40);
        return;
      }
      // 一轮回复正在逐条揭示时，延后 DB 刷新；否则 refreshMessages 会取消 reveal、
      // 整表重绘并把刚稳定的 scrollTop 再清零，长会话里就会反复跳回旧消息。
      if (isBubbleRevealActive()) {
        messagesStoreRefreshTimer = window.setTimeout(runMessagesStoreRefresh, BUBBLE_REVEAL_STEP_MS + 40);
        return;
      }
      void refreshThreadMessagesAfterForeground();
    };
    messagesStoreRefreshTimer = window.setTimeout(runMessagesStoreRefresh, 220);
  }));
  addPageLifetimeListener(window, 'marshmallow-user-slot-changed', () => {
    if (!container.isConnected || container.hidden) return;
    void refreshThreadAppearanceShell();
  });
  if (pendingShoppingShareId) void sendPendingShoppingShare();
  // 只领取首次排队、已中断超时或已有本地决定的申请。明确失败的申请留给用户手动重试，
  // 避免每次进入聊天都重新调用模型并重复消耗额度。
  if (strangerChat && chat.metadata?.contactApplication && chat.metadata?.friendshipState === 'requested') {
    void (async () => {
      let result = await recoverQqContactApplicationFromHistory(chat, user).catch(() => null);
      const latest = result?.chat || await getChat(chatId).catch(() => chat);
      if (!result?.decided) {
        // 同进程已有任务时会加入原 Promise；刷新后没有原任务时由核心状态门控直接跳过，
        // 因而既能等到首次申请完成，也不会为失败申请再开一次模型请求。
        result = await resolveQqContactApplication(latest, user);
      }
      if (!container.isConnected || container.hidden) return;
      if (result?.decided) {
        chat = result.chat || await getChat(chatId).catch(() => chat);
        paint();
        return;
      }
      await refreshThreadMessagesAfterForeground({ forcePin: true, animateNewMessages: true });
    })().catch(() => {});
  }
  addPageLifetimeCleanup(() => {
    if (scrollToBottomRaf) cancelAnimationFrame(scrollToBottomRaf);
    scrollToBottomRaf = 0;
    if (bubbleRevealTimer) {
      window.clearTimeout(bubbleRevealTimer);
      cancelAnimationFrame(bubbleRevealTimer);
    }
    bubbleRevealTimer = 0;
    if (messagesStoreRefreshTimer) window.clearTimeout(messagesStoreRefreshTimer);
    messagesStoreRefreshTimer = 0;
    if (contextPrewarmTimer) window.clearTimeout(contextPrewarmTimer);
    contextPrewarmTimer = 0;
    // 页面销毁只释放 UI 定时器；完成的 system prompt 是按 chatId 隔离的共享派生数据，
    // 保留到 TTL/LRU 淘汰。以前这里清空当前前缀，导致 A→B→A 每次都冷构建。
    if (autoReplyTimer) window.clearTimeout(autoReplyTimer);
    autoReplyTimer = null;
    if (chaseTimer) window.clearTimeout(chaseTimer);
    chaseTimer = null;
    clearGenerationLongWaitReminder();
    streamPinTimers.forEach((timer) => window.clearTimeout(timer));
    streamPinTimers = [];
  });
}
