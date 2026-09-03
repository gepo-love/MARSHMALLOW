import {
  back,
  navigate,
  setLeaveGuard,
  clearLeaveGuard,
  invalidateKeepAlive,
  invalidateOfflinePresenceKeepAlive,
} from '../core/router.js';
import { icon } from '../components/svg-icons.js';
import { showToast } from '../components/toast.js';
import { beginLongTaskNotice } from '../core/long-task-notifications.js';
import { showCutscene } from '../components/encounter-cutscene.js';
import {
  BUILTIN_CLICHE_CLEANUP_GROUP_ID,
  BUILTIN_DEGREE_CLEANUP_GROUP_ID,
  applyDisplayRegex,
  applyPermanentRegex,
  createBuiltinClicheCleanupGroup,
  createBuiltinDegreeCleanupGroup,
  listRegexGroups,
  primeDisplayRegex,
  saveRegexGroups,
} from '../core/display-regex.js';
import {
  inspectNarrationEditorialAudit,
  sanitizeNarrationOutput,
  splitNarrationParagraphs,
} from '../core/narration-sanitize.js';
import { stripLeakedOfflineContinuityTail } from '../core/offline-continuity-state.js';
import { renderNarrationTextWithTranslations, bindNarrationTranslationToggle } from '../core/narration-translation.js';
import { saveWordRangePrefs } from '../core/narration-settings.js';
import { openTextEditorModal } from '../components/text-editor-modal.js';
import { chooseOfflineExperienceMode } from '../components/offline-experience-mode-sheet.js';
import {
  describeImageSaveResult,
  openImageLightbox,
  saveImageSrc,
} from '../components/image-lightbox.js';
import { openLinkPreview } from '../components/link-preview-sheet.js';
import { ensureDefaultUser } from '../core/user-slot.js';
import { getChat, listMessagesForChat, saveChat } from '../core/chat-store.js';
import { getCharacter, getCharactersByIds, listCharacters } from '../core/character-store.js';
import { captureElementScrollState } from '../core/scroll-state.js';
import {
  captureMediaGesture,
  playAudioWhenReady,
  takePlayableAudio,
} from '../core/media-playback.js';
import {
  buildTextureSoundSchedule,
  filterBreathSoundCues,
  filterTextureSoundAssetsByPlan,
  inferNarrationContinuousSoundCuesFromMessages,
  inferNarrationSoundCues,
  inferNarrationTexturePlanFromMessages,
  isTextureSoundCategory,
  normalizeBreathSupplementMode,
  prioritizeNarrationSoundCategories,
  resolveNarrationSoundMixVolume,
  resolveSoundCueEnvelope,
} from '../core/sound-cues.js';
import { createSoundAssetPlayback, listSoundAssets } from '../core/sound-library.js';
import { getRegularAnonymousMemoryInjectMode } from '../core/anonymous-chat.js';
import {
  getNowForUser,
  ensureTimeSchedule,
  formatGapHint,
  formatPromptTimeLine,
  getUserTimezone,
} from '../core/time-mode.js';
import { formatZonedClock } from '../core/user-timezone.js';
import {
  canAdvanceOfflineSettlementTime,
  describeOfflineSettlementTiming,
  resolveOfflineSettlementTarget,
} from '../core/offline-settlement-time.js';
import {
  applyOfflineAutoReplyDefaults,
  loadOfflineAutoReplySettings,
  maybeRunOfflineStoryPhoneTakeover,
  saveOfflineAutoReplySettings,
  DEFAULT_OFFLINE_AUTO_REPLY_TEXT,
} from '../core/offline-auto-reply.js';
import {
  loadOfflineSessionWithMeta,
  saveOfflineSession,
  clearOfflineSession,
  createSceneDraft,
  runOfflineBeat,
  supplementOfflineCharacterStates,
  missingOfflineCharacterStateIds,
  joinOfflineContinuationText,
  summarizeOfflineSession,
  beginPhoneSideTrip,
  resolvePhoneSideTripInterlude,
  canReviseLastOfflineBeat,
  applyLastOfflineRevision,
  restoreLastOfflineRevision,
  listOfflineRerollVersions,
  selectOfflineRerollVersion,
  editOfflineBeatText,
  deleteOfflineBeat,
  resolveOfflineBeatAnchorAfterRemoval,
  clearOfflineBeatImage,
  syncOpeningBeatFromScene,
  generateOfflineBeatImage,
  resolveOfflineBeatImagePrompt,
  advanceOfflineSceneDay,
  getPendingTripCheckpoint,
  resolveTripCheckpointChoice,
  rerollTripItineraryFromToday,
  commitOfflineInFlightIfNeeded,
  flushOfflineSessionPersist,
  ensureOfflineAttendance,
  getOfflineAttendanceMembers,
  getActiveOfflineParticipantIds,
  buildOfflineGuidanceReferenceContext,
  isOfflineUserPresent,
  inviteOfflineParticipant,
  joinOfflineParticipant,
  leaveOfflineParticipant,
  withdrawOfflineParticipantInvite,
} from '../core/offline-session.js';
import { collectOfflinePlaceMaterial } from '../core/offline-place-material.js';
import { restoreOfflineSourcePrivateChat } from '../core/offline-chat-isolation.js';
import {
  listOfflineScenePresets,
  saveOfflineScenePreset,
  deleteOfflineScenePreset,
  getLastOfflineScenePresetId,
  setLastOfflineScenePresetId,
  pickOfflineScenePresetFields,
} from '../core/offline-scene-presets.js';
import { listAllWorldBookRows, saveWorldBookEntry } from '../core/world-book-store.js';
import { createWorldBookEntry } from '../models/worldbook.js';
import { WORLD_BOOKS } from '../data/world-books.js';
import {
  createCustomPresetId,
  listOfflinePresetOptions,
  savePresetRecord,
} from '../core/preset-store.js';
import { discussOfflineGuidance } from '../core/offline-guidance.js';
import { runNarrativeExpertConsultation } from '../core/expert-consultation.js';
import {
  deleteExpertConsultationPreset,
  listExpertConsultationPresets,
  saveExpertConsultationPreset,
} from '../core/expert-consultation-presets.js';
import {
  listApiSectionPresetOptions,
  resolveApiSectionPresetConfig,
} from '../core/api-presets.js';
import {
  normalizeAnonMemoryInject,
  sceneMechanicsFieldsHtml,
  scenePresetBarHtml,
  readMechanicsFromInputs,
  applyMechanicsPresetToInputs,
  bindMechanicsCommonControls,
  refreshScenePresetSelect,
} from '../components/offline-scene-mechanics.js';
import { beatActionsHtml, bindOfflineBeatDelete } from '../components/offline-beat-ui.js';
import { showGenerationErrorReport } from '../components/generation-error-report.js';
import { openCharStatePopover } from '../components/char-state-popover.js';
import { placeOfflineCharacterStateAnchors } from '../core/offline-character-states.js';
import { generationErrorFromCatch } from '../core/generation-error-guide.js';
import { classifyOfflineErrorReason } from '../core/offline-error-classification.js';
import {
  canForceReleaseNarrationGenerationLease,
  forceReleaseNarrationGenerationLease,
  isNarrationGenerationActive,
  narrationGenerationLeaseKey,
  reconcileNarrationGenerationActivity,
  registerNarrationGenerationAbortController,
  requestNarrationGenerationAbort,
} from '../core/narration-generation-lease.js';
import { OFFLINE_PHONE_FREQUENCIES } from '../core/offline-phone-cinematic.js';
import { getOfflineInterludeNotice } from '../core/offline-interlude.js';
import {
  alignNarrativeVoiceLinesToDialogueSpans,
  extractNarrativeDialogueSpans,
  isStandaloneNarrativeDialogueSpan,
} from '../core/narrative-voice-lines.js';
import { downloadTextFile } from '../core/appearance-theme-export.js';
import { saveOfflineFavorite } from '../core/message-favorites.js';
import {
  OFFLINE_STYLE_DEFAULTS,
  normalizeOfflineStylePrefs as normalizeStylePrefs,
  loadOfflineStylePrefs,
  saveOfflineStylePrefs,
  subscribeOfflineStyleChanges,
  listOfflineStylePresets,
  saveOfflineStylePreset,
  deleteOfflineStylePreset,
  offlineStylePresetToPrefs,
  parseOfflineStyleDocument,
  buildOfflineAppearanceReferenceMarkdown,
  prepareOfflineStyleCss,
  resolveOfflineInnerVoiceCard,
} from '../core/offline-appearance.js';
import {
  OFFLINE_AUDIO_STYLE_DEFAULTS,
  normalizeOfflineAudioStylePrefs,
  loadOfflineAudioStylePrefs,
  saveOfflineAudioStylePrefs,
  subscribeOfflineAudioStyleChanges,
  prepareOfflineAudioStyleCss,
  buildOfflineAudioAppearanceReferenceMarkdown,
} from '../core/offline-audio-appearance.js';
import {
  restoreOfflinePhoneActionsForBeat,
  rollbackOfflinePhoneActionsForBeat,
} from '../core/offline-phone-actions.js';
import {
  ensureOfflineBranching,
  addOfflineBookmark,
  deleteOfflineBookmark,
  getOfflineForkEligibility,
  forkOfflineBranch,
  switchOfflineBranch,
  renameOfflineBranch,
  deleteOfflineBranch,
  clearOfflineBranchSnapshots,
} from '../core/offline-branch-snapshot.js';
import {
  loadInnerVoiceCardPresets,
  parseInnerVoiceCardImportText,
  presetToCard,
} from '../core/chat/inner-voice-style.js';
import {
  offlineCharacterStateHistory,
  resolveOfflineCharacterStateDisplayName,
} from '../core/offline-character-states.js';
import { hydrateHtmlExtensionHosts } from '../core/html-extensions.js';
import {
  collectOfflineSceneMediaStats,
  exportOfflineSceneVideo,
  formatMediaBytes,
  formatSceneDuration,
} from '../core/offline-scene-video-export.js';

const OFFLINE_LONG_WAIT_NOTICE_MS = 3 * 60 * 1000;
const OFFLINE_VERY_LONG_WAIT_NOTICE_MS = 5 * 60 * 1000;

function esc(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** iOS Safari 点中文字时，委托事件的 target 偶尔是 Text，而不是按钮元素。 */
function eventTargetElement(event) {
  const target = event?.target;
  if (target?.nodeType === 1) return target;
  return target?.parentElement || null;
}

/** 用户方向/开场：保留换行分段，不压成一行。 */
function multilineBeatHtml(text = '') {
  return `<p class="os-beat-multiline">${esc(applyDisplayRegex(String(text || ''), 'offline'))}</p>`;
}

function syncDirectiveTextareaHeight(el) {
  if (!el) return;
  // 拼音 composition 中改高度会触发布局，iOS 候选栏易叠到键盘键上。
  try {
    if (el.isComposing) return;
  } catch (_) {}
  el.style.height = 'auto';
  const next = Math.min(132, Math.max(38, el.scrollHeight || 38));
  el.style.height = `${next}px`;
}

function reportOfflineGenerationError(err, { title = '线下推进失败', scope = '线下相遇' } = {}) {
  const report = generationErrorFromCatch(err, {
    scope,
    title,
    reason: classifyOfflineErrorReason(err),
    rawText: err?.rawText || err?.rawResponse || '',
  });
  showGenerationErrorReport(report);
  showToast(`失败：${String(report.message || err?.message || err || '生成失败').slice(0, 120)}`);
  return report;
}

function applyStylePrefs(container, prefs, { customCssEnabled = true } = {}) {
  const p = normalizeStylePrefs(prefs);
  container.dataset.osBg = p.bg;
  container.dataset.osFont = p.font;
  container.dataset.osAnchor = p.anchor ? 'on' : 'off';
  container.dataset.osTimelineNav = p.timelineNav ? 'on' : 'off';
  container.dataset.osReasoning = p.showReasoning ? 'on' : 'off';
  container.style.setProperty('--os-body-size', `${p.size}px`);
  container.style.setProperty('--os-leading', String(p.leading));
  container.style.setProperty('--os-measure', p.measure === 'wide' ? '100%' : '42em');
  if (p.textColor) container.style.setProperty('--os-body-ink', p.textColor);
  else container.style.removeProperty('--os-body-ink');
  if (p.bgImage) {
    container.dataset.osHasBg = '1';
    container.style.setProperty('--os-bg-image', `url("${p.bgImage}")`);
    const veilRgb = p.bg === 'dusk' ? '25, 26, 29' : '255, 255, 255';
    container.style.setProperty('--os-veil', `rgba(${veilRgb}, ${p.veil})`);
  } else {
    delete container.dataset.osHasBg;
    container.style.removeProperty('--os-bg-image');
    container.style.removeProperty('--os-veil');
  }
  applyCustomCss(p.css, p.darkCss, { enabled: customCssEnabled });
}

/** 自定义 CSS 统一编译进线下页面作用域；style 节点常驻 head，离页后不再命中。 */
function applyCustomCss(css, darkCss = '', { enabled = true } = {}) {
  let el = document.getElementById('os-custom-css');
  const text = String(css || '').trim();
  if (!text) {
    if (el) el.textContent = '';
  } else if (!el) {
    el = document.createElement('style');
    el.id = 'os-custom-css';
    document.head.appendChild(el);
  }
  if (el && text) {
    el.media = enabled && !document.documentElement.classList.contains('beautify-safe-mode') ? 'all' : 'not all';
    el.textContent = prepareOfflineStyleCss(text);
  }

  let darkEl = document.getElementById('os-custom-dark-css');
  const darkText = String(darkCss || '').trim();
  if (!darkText) {
    darkEl?.remove();
    return;
  }
  if (!darkEl) {
    darkEl = document.createElement('style');
    darkEl.id = 'os-custom-dark-css';
    document.head.appendChild(darkEl);
  }
  const darkEnabled = enabled
    && document.documentElement.dataset.colorMode === 'dark'
    && !document.documentElement.classList.contains('beautify-safe-mode');
  darkEl.media = darkEnabled ? 'all' : 'not all';
  darkEl.textContent = prepareOfflineStyleCss(darkText);
}

const AUDIO_STAGE_FONT_STACKS = Object.freeze({
  serif: '"Songti SC", "Noto Serif SC", "STSong", serif',
  sans: '"PingFang SC", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif',
  rounded: '"Hiragino Maru Gothic ProN", "M PLUS Rounded 1c", "PingFang SC", sans-serif',
});

function applyAudioStageCustomCss(css = '') {
  let el = document.getElementById('oas-custom-css');
  const text = prepareOfflineAudioStyleCss(css);
  if (!text) {
    el?.remove();
    return;
  }
  if (!el) {
    el = document.createElement('style');
    el.id = 'oas-custom-css';
    document.head.appendChild(el);
  }
  el.media = document.documentElement.classList.contains('beautify-safe-mode') ? 'not all' : 'all';
  el.textContent = text;
}

function applyAudioStageAppearance(container, prefs) {
  const p = normalizeOfflineAudioStylePrefs(prefs);
  container.dataset.oasTheme = p.theme;
  container.dataset.oasFont = p.font;
  const fontFamily = p.font === 'custom' && p.fontFamily
    ? p.fontFamily
    : AUDIO_STAGE_FONT_STACKS[p.font] || AUDIO_STAGE_FONT_STACKS.serif;
  container.style.setProperty('--oas-font-family', fontFamily);
  container.style.setProperty('--oas-font-size', `${p.size}px`);
  container.style.setProperty('--oas-leading', String(p.leading));
  container.style.setProperty('--oas-paper-opacity', String(p.paperOpacity));
  [
    ['--oas-ink', p.textColor],
    ['--oas-muted', p.mutedColor],
    ['--oas-accent', p.accentColor],
  ].forEach(([name, value]) => {
    if (value) container.style.setProperty(name, value);
    else container.style.removeProperty(name);
  });
  applyAudioStageCustomCss(p.css);
}

/** 底图上传：等比压到 1600px 内存成 JPEG data URL，避免撑爆本地库 */
function readBgImageFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('读取图片失败'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('不是可用的图片文件'));
      img.onload = () => {
        const max = 1600;
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.src = String(reader.result || '');
    };
    reader.readAsDataURL(file);
  });
}

/** 时空锚：这段相遇发生在哪里、什么时候、和谁 —— 页面的签名元素 */
function anchorStripHtml(session, worldStartTs = 0) {
  const scene = session?.scene || {};
  const seed = session?.originSeed || {};
  const bits = [];
  const place = String(scene.place || seed.place || '').trim();
  bits.push(place || '某个还没命名的地方');
  const timeLabel = String(seed.timeLabel || '').trim();
  if (timeLabel) {
    bits.push(timeLabel);
  } else {
    const ts = Number(worldStartTs || session?.startedAtWorld || session?.createdAt || 0);
    if (ts > 0) {
      const d = new Date(ts);
      bits.push(`${d.getMonth() + 1} 月 ${d.getDate()} 日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`);
    }
  }
  const companions = String(session?.attendance ? (scene.companions || '') : (scene.companions || seed.companions || '')).trim();
  if (companions) bits.push(`与 ${companions}`);
  return `
    <div class="os-anchor" role="note" aria-label="这段相遇的时空">
      <span class="os-anchor-mark" aria-hidden="true"></span>
      <span class="os-anchor-text">${bits.map(esc).join('<i class="os-anchor-dot" aria-hidden="true"></i>')}</span>
    </div>`;
}

async function resolveTitle(chat, scene, session = null) {
  if (scene?.activityKind === 'trip' && scene.place) return `旅行 · ${scene.place}`;
  if (chat?.groupSettings?.name) return chat.groupSettings.name;
  const partnerId = session
    ? (getActiveOfflineParticipantIds(session, chat)[0] || '')
    : ((chat?.participants || []).find((p) => p && p !== 'user') || '');
  if (!partnerId) return scene?.activityKind === 'trip' ? '一起旅行' : '线下';
  const ch = await getCharacter(partnerId, {
    userId: session?.userId || chat?.userId || '',
  }).catch(() => null);
  const name = (ch && (ch.customNickname || ch.name)) || '线下';
  return scene?.activityKind === 'trip' ? `旅行 · ${name}` : name;
}

/** 内容型字段：地点 / 一起做什么 / 开场白；同行者与时间由邀约自动带入，天气跟现实。 */
function sceneContentFieldsHtml(scene = {}, originSeed = null, attendanceAware = false, userPresent = true) {
  const isTrip = scene.activityKind === 'trip';
  const companions = String(attendanceAware ? (scene.companions || '') : (scene.companions || originSeed?.companions || '')).trim();
  const timeLabel = String(originSeed?.timeLabel || '').trim();
  return `
    ${timeLabel ? `<div class="offline-scene-autofill"><span>约定时间</span><strong>${esc(timeLabel)}</strong></div>` : ''}
    ${companions ? `<div class="offline-scene-autofill"><span>同行</span><strong>${esc(companions)}</strong></div>` : ''}
    <label class="api-field">
      <span class="api-field-label">${isTrip ? '目的地（可选）' : '去哪儿（可选）'}</span>
      <input type="text" class="form-input off-scene-place" value="${esc(scene.place)}" placeholder="如：海滨小城的旧书店" maxlength="60" />
    </label>
    <label class="api-field">
      <span class="api-field-label">一起做什么（可选）</span>
      <input type="text" class="form-input off-scene-goal" value="${esc(scene.goal)}" placeholder="如：一起挑一本旧书" maxlength="80" />
    </label>
    <label class="api-field">
      <span class="api-field-label">${userPresent ? '开场白 / 想法（可选）' : '开场设定（可选）'}</span>
      <textarea class="form-input off-scene-opening" rows="2" placeholder="${userPresent ? '留空由 TA 自然开口；也可以写一句你想要的开场' : '留空自然开场；也可写角色们此刻在做什么'}">${esc(scene.openingLine || '')}</textarea>
    </label>
    ${isTrip ? `
    <label class="api-field">
      <span class="api-field-label">出行天数</span>
      <select class="form-input off-scene-duration-days">
        ${[1, 2, 3, 4, 5, 6, 7].map((d) => `<option value="${d}" ${Number(scene.durationDays || 3) === d ? 'selected' : ''}>${d} 天</option>`).join('')}
      </select>
    </label>` : ''}
    <button type="button" class="btn btn-outline btn-sm off-query-place">按地点查附近</button>
    <label class="api-field">
      <span class="api-field-label">地点 / 攻略素材（可选）</span>
      <textarea class="form-input off-scene-place-material" rows="2" placeholder="点「按地点查附近」自动填入，也可手改">${esc(scene.placeMaterial || '')}</textarea>
    </label>`;
}

function readSceneFromInputs(root, base = {}) {
  return createSceneDraft({
    ...base,
    ...readMechanicsFromInputs(root, base),
    place: root.querySelector('.off-scene-place')?.value ?? base.place,
    companions: base.companions,
    goal: root.querySelector('.off-scene-goal')?.value ?? base.goal,
    openingLine: root.querySelector('.off-scene-opening')?.value ?? base.openingLine,
    durationDays: root.querySelector('.off-scene-duration-days')?.value ?? base.durationDays,
    placeMaterial: root.querySelector('.off-scene-place-material')?.value ?? base.placeMaterial,
    dayIndex: base.dayIndex,
    activityKind: base.activityKind,
  });
}

function originSeedHtml(seed) {
  if (!seed) return '';
  // 直接进入没有邀约内容时不摆空横幅，时间地点交给时空锚
  if ((seed.from === 'direct' || seed.from === 'first') && !seed.activity && !seed.note && !seed.routeSummary) return '';
  const ribbon = seed.from === 'user' ? '你递出的邀约'
    : (seed.from === 'observer' ? '旁观视角'
      : (seed.from === 'activity' ? '从「他的手机」延续'
        : (seed.from === 'direct' ? '承接聊天 · 直接进入'
          : (seed.from === 'first' ? '初遇 · 第一次见面' : 'TA 的邀约'))));
  const meta = [seed.timeLabel, seed.place, seed.companions ? `与 ${seed.companions}` : ''].filter(Boolean).map(esc).join(' · ');
  return `
    <section class="scrapbook-card offline-invite-banner">
      <div class="offline-invite-banner-ribbon">${ribbon}</div>
      ${meta ? `<div class="offline-invite-banner-meta">${meta}</div>` : ''}
      ${seed.activity ? `<div class="offline-invite-banner-act">${esc(seed.activity)}</div>` : ''}
      ${seed.note ? `<div class="offline-invite-banner-note">${esc(seed.note)}</div>` : ''}
      ${seed.routeSummary ? `<div class="offline-invite-banner-route">🧭 ${esc(seed.routeSummary)}</div>` : ''}
    </section>`;
}

function settingsHintHtml(userPresent = true) {
  return `
    <div class="offline-settings-hint" data-settings-hint>
      <span>${userPresent ? '字数 / 视角 / 文风等叙事设置可随时点顶部三横线按钮调整' : '旁观线下固定全知第三人称；字数与文风可随时调整'}</span>
      <button type="button" class="offline-settings-hint-open" data-hint-open>去看看 ›</button>
      <button type="button" class="offline-settings-hint-close" data-hint-close aria-label="关闭">×</button>
    </div>`;
}

function sceneSummaryHtml(scene = {}, originSeed = null, attendanceAware = false) {
  const bits = [];
  if (scene.place) bits.push(esc(scene.place));
  const companions = String(attendanceAware ? (scene.companions || '') : (scene.companions || originSeed?.companions || '')).trim();
  if (companions) bits.push(`与 ${esc(companions)}`);
  if (scene.goal) bits.push(esc(scene.goal));
  if (scene.tone) bits.push(esc(scene.tone));
  return bits.length ? bits.join(' · ') : '未设定场景';
}

function groupedMechanicsFieldsHtml(scene, anonMemoryInject, extras) {
  const raw = sceneMechanicsFieldsHtml(scene, anonMemoryInject, extras);
  const audioMark = '<div class="off-settings-divider">舞台音效</div>';
  const imageMark = '<div class="off-settings-divider">场景生图</div>';
  const contextMark = '<div class="off-settings-divider">语音 / 上下文 / 自动总结</div>';
  const loreMark = '<div class="off-settings-divider">世界书 / 文风绑定</div>';
  const audioAt = raw.indexOf(audioMark);
  const imageAt = raw.indexOf(imageMark);
  const contextAt = raw.indexOf(contextMark);
  const loreAt = raw.indexOf(loreMark);
  if (imageAt < 0 || contextAt < 0 || loreAt < 0) return raw;
  const base = raw.slice(0, audioAt >= 0 ? audioAt : imageAt);
  const audio = audioAt >= 0 ? raw.slice(audioAt + audioMark.length, imageAt) : '';
  const image = raw.slice(imageAt + imageMark.length, contextAt);
  const context = raw.slice(contextAt + contextMark.length, loreAt);
  const lore = raw.slice(loreAt + loreMark.length);
  const section = (title, meta, body, open = false) => `
    <details class="os-settings-group" ${open ? 'open' : ''}>
      <summary><span>${title}</span><small>${meta}</small>${icon('chevronDown')}</summary>
      <div class="os-settings-group-body">${body}</div>
    </details>`;
  return [
    section('写作方式', extras?.userPresent === false ? '旁观 · 字数 · 走向' : '视角 · 人称 · 字数', base, true),
    audio ? section('舞台音效', '开关 · 动作 · 背景', audio, true) : '',
    section('场景与配图', '引擎 · 自动生图 · 画风', image),
    section('上下文', '语音 · 记忆深度 · 小结', context),
    section('设定绑定', '世界书 · 文风 · 匿名记忆', lore),
  ].filter(Boolean).join('');
}

function autoReplyModeLabel(mode) {
  if (mode === 'fixed') return '固定代答';
  if (mode === 'companion') return '同行代答';
  return '代答关';
}

function tripProgressHtml(scene = {}) {
  if (scene.activityKind !== 'trip' || Number(scene.durationDays || 1) <= 1) return '';
  const day = Number(scene.dayIndex || 0) + 1;
  const total = Number(scene.durationDays || 1);
  const isLastDay = day >= total;
  const dayPlan = scene.itinerary?.days?.[Number(scene.dayIndex || 0)];
  return `
    <section class="offline-trip-progress">
      <div class="offline-trip-progress-head">
        <span>第 ${day} / 共 ${total} 天${dayPlan?.title ? ` · ${esc(dayPlan.title)}` : ''}</span>
        <button type="button" class="btn btn-outline btn-sm off-advance-day" ${isLastDay ? 'disabled' : ''}>${isLastDay ? '已是最后一天' : '推进到下一天'}</button>
      </div>
      ${dayPlan?.summary ? `<div class="offline-trip-day-summary">${esc(dayPlan.summary)}</div>` : ''}
      ${dayPlan?.stops?.length ? `<div class="offline-trip-day-stops">${dayPlan.stops.map((s) => `<span class="offline-trip-stop-chip">${esc(s.name)}</span>`).join('')}</div>` : ''}
      ${scene.itinerary ? '<button type="button" class="offline-trip-replan-btn" data-trip-replan>重新规划从今天起的行程</button>' : ''}
    </section>`;
}

function tripCheckpointHtml(session) {
  const checkpoint = getPendingTripCheckpoint(session);
  if (!checkpoint) return '';
  // 刚进入这天还没写过一轮叙事时先不弹岔路，等有内容铺垫过再出现，不然像开场就被打断。
  if (!session.beats.some((b) => b.role === 'narration')) return '';
  return `
    <section class="offline-trip-checkpoint">
      <div class="offline-trip-checkpoint-prompt">${esc(checkpoint.prompt)}</div>
      <div class="offline-trip-checkpoint-options">
        ${checkpoint.options.map((o) => `<button type="button" class="offline-trip-checkpoint-opt" data-checkpoint-opt="${esc(o.id)}">${esc(o.label)}</button>`).join('')}
      </div>
    </section>`;
}

function inlineThoughtButtonHtml(beat = {}, characterId = '', state = {}, characterNamesById = null) {
  const currentName = characterNamesById instanceof Map
    ? characterNamesById.get(String(characterId || '').trim())
    : '';
  const name = resolveOfflineCharacterStateDisplayName(characterId, state?.name, currentName);
  return `<button type="button" class="os-inline-thought" data-offline-thought="${esc(characterId)}" data-thought-beat="${esc(beat.id)}" aria-label="展开${esc(name)}此刻没说出口的话"><span aria-hidden="true">…</span><small>${esc(name)}没说出口的话</small></button>`;
}

function renderNarrationHtml(text = '', {
  beat = null,
  thoughts = false,
  characterNamesById = null,
} = {}) {
  const cleaned = applyDisplayRegex(stripLeakedOfflineContinuityTail(sanitizeNarrationOutput(text)), 'offline');
  const paras = splitNarrationParagraphs(cleaned);
  const states = thoughts && beat?.characterStates && typeof beat.characterStates === 'object'
    ? Object.entries(beat.characterStates)
    : [];
  if (!states.length) return paras.map((p) => `<p>${renderNarrationTextWithTranslations(p)}</p>`).join('');
  const inserts = new Map();
  const displayAnchoredStates = states.map(([characterId, state]) => [characterId, {
    ...state,
    anchor: applyDisplayRegex(state?.anchor || '', 'offline'),
  }]);
  placeOfflineCharacterStateAnchors(paras, displayAnchoredStates).forEach(({ characterId, state, paragraphIndex }) => {
    const current = inserts.get(paragraphIndex) || [];
    current.push(inlineThoughtButtonHtml(beat, characterId, state, characterNamesById));
    inserts.set(paragraphIndex, current);
  });
  return paras.map((p, index) => {
    const thoughtButtons = inserts.get(index) || [];
    return `<p>${renderNarrationTextWithTranslations(p)}</p>${thoughtButtons.length ? `<span class="os-inline-thoughts">${thoughtButtons.join('')}</span>` : ''}`;
  }).join('');
}

function offlineReasoningHtml(reasoningText = '', { streaming = false, status = '' } = {}) {
  const text = String(reasoningText || '').trim();
  const normalizedStatus = String(status || '').trim();
  if (!text && !streaming && !normalizedStatus) return '';
  const labelByStatus = {
    complete: '思维链 · 已执行',
    truncated: '思维链 · 格式不完整',
    empty: '思维链 · 空回执',
    missing: '思维链 · 未返回',
    'native-only': '思维链 · 仅原生推理',
  };
  const label = streaming ? '思维链生成中…' : (labelByStatus[normalizedStatus] || '思维链');
  const fallbackByStatus = {
    truncated: '模型返回的生成前检查没有闭合。',
    empty: '模型返回了空的生成前检查。',
    missing: '本轮没有返回可核验的生成前检查。',
    'native-only': '本轮只返回了接口原生推理，没有按预设返回生成前检查。',
  };
  return `
    <details class="offline-reasoning${streaming ? ' is-streaming' : ''}" data-offline-reasoning ${streaming ? 'open' : ''}>
      <summary><i aria-hidden="true"></i><span>${label}</span></summary>
      <pre data-offline-reasoning-text>${text ? esc(text) : (fallbackByStatus[normalizedStatus] || '等待模型返回思维链…')}</pre>
    </details>`;
}

function settleReasoningOnlyStream(el, error = {}) {
  const reasoning = String(
    error?.reasoningText
    || error?.upstreamMeta?.reasoningText
    || '',
  ).trim();
  const reasoningOnly = error?.emptyKind === 'reasoning-only'
    || (reasoning && /只返回了?推理|没有返回可显示的正文|推理占满/i.test(String(error?.message || error || '')));
  if (!el || !reasoningOnly || !reasoning) return false;
  el.classList.remove('is-streaming');
  el.innerHTML = `
    ${offlineReasoningHtml(reasoning)}
    <div class="offline-model-output-note">这轮只完成了思考，没有写出正文。可以直接再次推进，或展开思维链查看。</div>
  `;
  return true;
}

const AUDIO_STAGE_SEGMENT_MAX = 150;

function splitAudioStageNarration(text = '') {
  const source = String(text || '')
    .trim();
  if (!source) return [];
  // 协议标记偶发包在引号内或流式截在引号旁，剥离后可能只剩一个 “ / 「。
  // 这种纯标点残片不是旁白，不能单独占用舞台进度。
  const hasNarrationContent = (value = '') => /[\p{L}\p{N}]/u.test(String(value || ''));
  const paragraphs = source.split(/\n{2,}|\n/u)
    .map((part) => part.trim())
    .filter((part) => hasNarrationContent(part));
  const chunks = [];
  paragraphs.forEach((paragraph) => {
    if (paragraph.length <= AUDIO_STAGE_SEGMENT_MAX) {
      chunks.push(paragraph);
      return;
    }
    const sentences = paragraph.match(/[^。！？!?…]+[。！？!?…]*/gu) || [paragraph];
    let current = '';
    sentences.forEach((sentence) => {
      if (current && current.length + sentence.length > AUDIO_STAGE_SEGMENT_MAX) {
        const chunk = current.trim();
        if (hasNarrationContent(chunk)) chunks.push(chunk);
        current = '';
      }
      current += sentence;
    });
    const chunk = current.trim();
    if (hasNarrationContent(chunk)) chunks.push(chunk);
  });
  return chunks;
}

export function buildOfflineAudioStageSegments(beat = {}) {
  // 再走一次共享叙事清洗：不仅保护新生成内容，也让旧版本已经保存的 <br>
  // 分隔符在读取时立即恢复为换行，不再成为可播放的“旁白”段落。
  const body = stripLeakedOfflineContinuityTail(sanitizeNarrationOutput(beat?.text || '')).trim();
  const lines = (Array.isArray(beat?.voiceLines) ? beat.voiceLines : [])
    .map((line) => ({ ...line, text: String(line?.text || '').trim() }))
    .filter((line) => line.text);
  const actors = lines
    .map((line) => ({ id: line.actorId || line.actorName, name: line.actorName || '' }))
    .filter((actor) => actor.id && actor.name);
  const fallbackActorName = String(beat?.audioStageActorName || actors[0]?.name || '角色').trim() || '角色';
  if (!actors.length) actors.push({ id: 'stage-actor', name: fallbackActorName });
  const strictSpeechTags = beat?.voiceLineFormat === 'speech_tags_v1';
  const visibleSpans = extractNarrativeDialogueSpans(body, {
    actors,
    allowBracketDialogue: true,
  }).filter((span) => (
    !strictSpeechTags || isStandaloneNarrativeDialogueSpan(body, span)
  ));
  const locatedLines = alignNarrativeVoiceLinesToDialogueSpans(body, lines, {
    actors,
    withLocations: true,
    allowBracketDialogue: true,
  });
  const claimedSourceStarts = new Set(locatedLines.map((line) => line.sourceStart));
  visibleSpans.forEach((span, index) => {
    if (claimedSourceStarts.has(span.start)) return;
    locatedLines.push({
      text: span.text,
      actorId: '',
      actorName: span.actorName || fallbackActorName,
      audio: null,
      start: span.start,
      end: span.end,
      envelopeStart: span.envelopeStart,
      envelopeEnd: span.envelopeEnd,
    });
  });
  locatedLines.sort((left, right) => left.envelopeStart - right.envelopeStart);
  const cues = (Array.isArray(beat?.stageSound?.cues) ? beat.stageSound.cues : [])
    .map((cue) => ({
      anchor: String(cue?.anchor || '').trim(),
      categories: [...new Set((Array.isArray(cue?.categories) ? cue.categories : [])
        .map((category) => String(category || '').trim())
        .filter(Boolean))].slice(0, 3),
    }))
    .filter((cue) => cue.anchor && cue.categories.length);
  const result = [];
  const pushNarration = (text) => {
    splitAudioStageNarration(text).forEach((part) => {
      const explicit = cues
        .filter((cue) => part.includes(cue.anchor) || cue.anchor.includes(part))
        .flatMap((cue) => cue.categories);
      const soundCategories = prioritizeNarrationSoundCategories([
        ...explicit,
        ...inferNarrationSoundCues(part, { max: 3 }),
      ], { max: 3 });
      const texturePlan = inferNarrationTexturePlanFromMessages([{
        content: part,
        metadata: { soundCueCategories: soundCategories },
      }]);
      const validatedTextureCategories = texturePlan?.categories || [];
      const validatedSoundCategories = prioritizeNarrationSoundCategories([
        ...soundCategories.filter((category) => !isTextureSoundCategory(category)),
        ...validatedTextureCategories,
      ], { max: 3 });
      result.push({
        type: 'narration',
        text: part,
        soundCategories: validatedSoundCategories,
        ...(texturePlan?.categories?.length ? { texturePlan } : {}),
      });
    });
  };
  let cursor = 0;
  locatedLines.forEach((line) => {
    const narrationEnd = line.envelopeStart;
    let envelopeEnd = line.envelopeEnd;
    let translation = '';
    const translationStart = body.slice(envelopeEnd).search(/\S/u);
    if (translationStart >= 0) {
      const markerStart = envelopeEnd + translationStart;
      if (body[markerStart] === '〔') {
        const markerEnd = body.indexOf('〕', markerStart + 1);
        if (markerEnd > markerStart && markerEnd - markerStart <= 260) {
          translation = body.slice(markerStart + 1, markerEnd).trim();
          envelopeEnd = markerEnd + 1;
        }
      }
    }
    pushNarration(body.slice(cursor, narrationEnd));
    const attachedTextureCategories = [];
    let nearestTexturePlan = null;
    for (let segmentIndex = result.length - 1; segmentIndex >= 0; segmentIndex -= 1) {
      const segment = result[segmentIndex];
      if (segment?.type === 'dialogue') break;
      if (segment?.type !== 'narration') continue;
      attachedTextureCategories.push(...(segment.soundCategories || []).filter(isTextureSoundCategory));
      if (!nearestTexturePlan && segment?.texturePlan?.categories?.length) {
        nearestTexturePlan = segment.texturePlan;
      }
    }
    const dialogueTextures = prioritizeNarrationSoundCategories(attachedTextureCategories, { max: 3 });
    result.push({
      type: 'dialogue',
      text: line.text,
      ...(translation ? { translation } : {}),
      actorId: line.actorId || '',
      actorName: line.actorName || '角色',
      audioDataUrl: line.audio?.dataUrl || '',
      ...(dialogueTextures.length ? { soundCategories: dialogueTextures } : {}),
      ...(dialogueTextures.length ? {
        texturePlan: {
          ...(nearestTexturePlan || {}),
          categories: dialogueTextures,
        },
      } : {}),
    });
    cursor = envelopeEnd;
  });
  pushNarration(body.slice(cursor));
  if (!result.length && body) pushNarration(body);
  let previousActorId = '';
  result.forEach((segment, index) => {
    if (segment.type === 'dialogue') {
      previousActorId = String(segment.actorId || '').trim() || previousActorId;
      return;
    }
    const nextActorId = result.slice(index + 1)
      .find((row) => row?.type === 'dialogue' && String(row?.actorId || '').trim())?.actorId;
    const soundActorId = String(nextActorId || previousActorId || '').trim();
    if (soundActorId) segment.soundActorId = soundActorId;
  });
  return result;
}

function beatImageHtml(b) {
  if (b.image?.url) {
    return `
    <div class="offline-beat-image">
      <img src="${esc(b.image.url)}" alt="场景图" loading="lazy" data-beat-image-view="${esc(b.id)}" />
      <button type="button" class="offline-beat-image-save" data-beat-image-save="${esc(b.id)}">${icon('download')} 保存图片</button>
      ${b.image.warning ? `<p class="offline-beat-image-warning">${esc(b.image.warning)}</p>` : ''}
    </div>`;
  }
  if (b.image?.error) {
    return `
    <div class="offline-beat-image offline-beat-image--error">
      <p>场景图未生成：${esc(b.image.error)}</p>
      <button type="button" class="btn btn-outline btn-sm" data-beat-image="${esc(b.id)}">重试生图</button>
    </div>`;
  }
  return '';
}

function beatAudioHtml(b) {
  const voiceLines = (Array.isArray(b?.voiceLines) ? b.voiceLines : [])
    .filter((line) => line?.audio?.dataUrl);
  if (voiceLines.length) {
    return `<div class="offline-beat-voice-lines">${voiceLines.map((line) => `
      <div class="offline-beat-voice-line">
        <span>${esc(line.actorName || '角色')}</span>
        <audio class="offline-beat-audio" controls preload="none" src="${esc(line.audio.dataUrl)}"></audio>
      </div>
    `).join('')}</div>`;
  }
  return '';
}

function beatHtmlWidgetsHtml(beat = {}) {
  const widgets = Array.isArray(beat.htmlWidgets) ? beat.htmlWidgets : [];
  if (!widgets.length) return '';
  return `<div class="offline-html-widgets">${widgets.map((_, index) => (
    `<div class="offline-html-widget" data-html-extension-host="${esc(`${beat.id}:${index}`)}"></div>`
  )).join('')}</div>`;
}

const HISTORY_FOLD_KEEP = 12;

function beatPickHtml(b, view) {
  if (!view.manage || b.role === 'daymark') return '';
  const checked = view.selected?.has(b.id) ? 'checked' : '';
  return `<label class="os-beat-pick"><input type="checkbox" data-beat-pick="${esc(b.id)}" ${checked} aria-label="选中这条" /></label>`;
}

function beatTimeLabel(beat, timeZone = '') {
  const ts = Number(beat?.ts || beat?.createdAt || 0);
  return formatZonedClock(ts, timeZone);
}

function beatFooterHtml(beat, {
  image = false,
  floor = 0,
  guidedRevision = false,
  thoughts = false,
  activeCharacterIds = [],
  timeZone = '',
} = {}) {
  const time = beatTimeLabel(beat, timeZone);
  const floorNum = Math.max(0, Number(floor) || 0);
  const menuLabel = floorNum > 0 ? `第 ${floorNum} 楼 · 本段操作` : '本段操作';
  const missingThoughts = thoughts && beat?.naturalEnsemble !== true
    ? missingOfflineCharacterStateIds(beat, activeCharacterIds)
    : [];
  const canContinue = guidedRevision && beat?.continuationPending === true;
  return `
    <footer class="os-beat-footer">
      <div class="os-beat-meta">
        <span class="os-beat-rule" aria-hidden="true"></span>
        ${time ? `<time datetime="${new Date(Number(beat.ts || beat.createdAt)).toISOString()}">${esc(time)}</time>` : '<span></span>'}
        <button type="button" class="os-beat-menu" data-beat-menu="${esc(beat.id)}" aria-label="${esc(menuLabel)}" aria-expanded="false" title="${esc(menuLabel)}">${icon('more')}</button>
      </div>
      ${(guidedRevision || missingThoughts.length) ? `
        <span class="os-beat-quick-actions" aria-label="本轮快捷操作">
          ${canContinue ? `<button type="button" data-beat-continue="${esc(beat.id)}">从断点续写</button>` : ''}
          ${missingThoughts.length ? `<button type="button" data-beat-supplement-thoughts="${esc(beat.id)}">补心声</button>` : ''}
          ${guidedRevision ? `<button type="button" data-beat-reroll="${esc(beat.id)}">重 roll</button>` : ''}
          ${guidedRevision ? `<button type="button" data-beat-audit-reroll="${esc(beat.id)}">补审重写</button>` : ''}
          ${guidedRevision ? `<button type="button" data-beat-expert="${esc(beat.id)}">专家会诊 <small>测试中</small></button>` : ''}
          ${guidedRevision ? `<button type="button" data-beat-revise="${esc(beat.id)}">指导重修</button>` : ''}
        </span>` : ''}
      ${beatActionsHtml(beat.id, {
        image,
        hasImage: !!beat.image?.url,
        clearImage: !!beat.image,
        hidden: true,
        continuation: guidedRevision,
        supplementalAudit: guidedRevision,
        expertConsultation: guidedRevision,
        bookmark: floorNum > 0,
        fork: floorNum > 0,
        favorite: true,
      })}
    </footer>`;
}

function messageNoticeHtml(notice = {}) {
  const tag = notice.chatId ? 'button' : 'div';
  return `
    <${tag} ${notice.chatId ? 'type="button"' : ''} class="os-message-notice${notice.chatId ? '' : ' is-static'}" ${notice.chatId ? `data-interlude-chat="${esc(notice.chatId)}"` : ''} ${notice.viewerId ? `data-phone-viewer="${esc(notice.viewerId)}"` : ''}>
      <span class="os-message-notice-icon">${icon('message')}</span>
      <span class="os-message-notice-copy">
        <strong>${esc(notice.title)}</strong>
        ${notice.detail ? `<small>${esc(notice.detail)}</small>` : ''}
      </span>
      ${notice.chatId ? `<span class="os-message-notice-go">${icon('chevron')}</span>` : ''}
    </${tag}>`;
}

function interludeNoticeHtml(beat) {
  let notice = getOfflineInterludeNotice(beat);
  if (!notice) {
    const legacyText = String(beat?.text || '');
    const looksLikePhone = /掏出手机|手机在这期间响了|线上往来|手机插曲/.test(legacyText);
    if (!looksLikePhone) return '';
    const labels = [...legacyText.matchAll(/「([^」]{1,30})」/g)].map((m) => m[1]);
    notice = {
      chatId: '',
      title: labels.length === 1 ? `${labels[0]}有新的消息` : '手机上有新的往来',
      detail: labels.length > 1 ? `涉及 ${labels.length} 个聊天` : '已收进这段线下',
    };
  }
  return messageNoticeHtml(notice);
}

function phoneActionNoticesHtml(beat = {}) {
  const notices = Array.isArray(beat.phoneActionNotices) ? beat.phoneActionNotices : [];
  if (!notices.length) return '';
  return `<div class="os-phone-action-notices">${notices.map(messageNoticeHtml).join('')}</div>`;
}

function beatsHtml(session, view = {}) {
  if (!session?.beats?.length) {
    return '<div class="offline-empty">点「推进」开始这段线下。</div>';
  }
  const floorById = new Map();
  const lastNarrationId = [...session.beats].reverse().find((row) => row?.role === 'narration')?.id || '';
  let narrationFloor = 0;
  for (const row of session.beats) {
    if (row?.role === 'narration' && row.id) {
      narrationFloor += 1;
      floorById.set(row.id, narrationFloor);
    }
  }
  let beats = session.beats;
  if (view.audioScene === true && !view.manage) {
    const latestNarration = [...beats].reverse().find((row) => row?.role === 'narration');
    const latestOpening = [...beats].reverse().find((row) => row?.role === 'opening');
    beats = latestNarration ? [latestNarration] : (latestOpening ? [latestOpening] : []);
  }
  let foldNotice = '';
  const foldable = view.audioScene !== true && !view.manage && !view.historyExpanded && beats.length > HISTORY_FOLD_KEEP + 2;
  if (foldable) {
    const hidden = beats.length - HISTORY_FOLD_KEEP;
    beats = beats.slice(-HISTORY_FOLD_KEEP);
    foldNotice = `<button type="button" class="os-history-toggle" data-history-expand>展开更早的 ${hidden} 条</button>`;
  }
  return foldNotice + beats.map((b) => {
    if (b.role === 'daymark') {
      return `<div class="offline-beat offline-beat--daymark"><span>${esc(applyDisplayRegex(String(b.text || ''), 'offline'))}</span></div>`;
    }
    if (b.role === 'opening') {
      return `<div class="offline-beat offline-beat--opening" data-beat-id="${esc(b.id)}">
        ${beatPickHtml(b, view)}
        <span>${view.userPresent === false ? '开场设定' : '你的开场'}</span>${multilineBeatHtml(b.text)}
        ${beatFooterHtml(b, { timeZone: view.timeZone })}
      </div>`;
    }
    if (b.role === 'directive') {
      return `<div class="offline-beat offline-beat--directive" data-beat-id="${esc(b.id)}">
        ${beatPickHtml(b, view)}
        <span>${view.userPresent === false ? '旁观方向' : '你的方向'}</span>${multilineBeatHtml(b.text)}
        ${beatFooterHtml(b, { timeZone: view.timeZone })}
      </div>`;
    }
    if (b.role === 'interlude') {
      const notice = interludeNoticeHtml(b);
      if (notice) {
        return `<div class="offline-beat offline-beat--interlude os-interlude-notice" data-beat-id="${esc(b.id)}">
          ${beatPickHtml(b, view)}
          ${notice}
          ${beatFooterHtml(b, { timeZone: view.timeZone })}
        </div>`;
      }
      return `<div class="offline-beat offline-beat--interlude" data-beat-id="${esc(b.id)}">
        ${beatPickHtml(b, view)}
        <span>手机插曲</span>${multilineBeatHtml(b.text)}
        ${beatFooterHtml(b, { timeZone: view.timeZone })}
      </div>`;
    }
    const body = renderNarrationHtml(b.text || '', {
      beat: b,
      thoughts: view.thoughtsEnabled === true,
      characterNamesById: view.characterNamesById,
    });
    const floor = floorById.get(b.id) || 0;
    return `<div class="offline-beat offline-beat--narration" data-beat-id="${esc(b.id)}">
      ${beatPickHtml(b, view)}
      ${offlineReasoningHtml(b.reasoningText, { status: b.thinkingStatus })}
      ${body || multilineBeatHtml(b.text || '')}
      ${beatHtmlWidgetsHtml(b)}
      ${phoneActionNoticesHtml(b)}
      ${beatAudioHtml(b)}
      ${beatImageHtml(b)}
      ${beatFooterHtml(b, {
        image: true,
        floor,
        guidedRevision: b.id === lastNarrationId,
        thoughts: view.thoughtsEnabled === true,
        activeCharacterIds: view.activeCharacterIds,
        timeZone: view.timeZone,
      })}
    </div>`;
  }).join('');
}

export default async function render(container, params = {}) {
  const renderStartedAt = globalThis.performance?.now?.() || Date.now();
  const chatId = String(params.chatId || '').trim();
  if (!chatId) {
    showToast('缺少会话');
    navigate('chat', {}, true);
    return;
  }
  const user = await ensureDefaultUser();
  const userReadyAt = globalThis.performance?.now?.() || Date.now();
  const [offlineTimeZone, chat, loaded] = await Promise.all([
    getUserTimezone(user.id).catch(() => String(user?.timezone || '').trim()),
    getChat(chatId),
    loadOfflineSessionWithMeta(chatId),
    primeDisplayRegex(),
  ]);
  const coreDataReadyAt = globalThis.performance?.now?.() || Date.now();
  if (!chat) {
    showToast('会话不存在');
    navigate('chat', {}, true);
    return;
  }
  let session = loaded.session;
  let recoveredFromMirror = !!loaded.recoveredFromMirror;
  if (session && Number(session.scene?.innerVoiceDefaultVersion || 0) < 1) {
    // 旧版把“默认关闭”和“用户关闭”都保存成 false，无法区分。升级后按新的常驻默认迁移一次；
    // 此后设置页会用 innerVoicePreferenceTouched 保存用户真正做出的选择。
    session.scene = createSceneDraft(session.scene || {});
    await saveOfflineSession(session).catch(() => {});
  }
  if (session) {
    // 旧版用现实 Date.now() 创建 opening。只修复能由 startedAtReal 明确识别的旧记录，
    // 避免碰触用户编辑、导入或本来就属于其它世界时间的合法时间戳。
    const opening = (session.beats || []).find((beat) => beat?.role === 'opening');
    const openingTs = Number(opening?.ts || 0);
    const startedAtReal = Number(session.startedAtReal || session.createdAt || 0);
    const startedAtWorld = Number(session.startedAtWorld || 0);
    if (
      opening
      && startedAtWorld > 0
      && startedAtReal > 0
      && Math.abs(openingTs - startedAtReal) <= 5 * 60_000
      && Math.abs(openingTs - startedAtWorld) > 5 * 60_000
    ) {
      opening.ts = startedAtWorld;
      await saveOfflineSession(session).catch(() => {});
    }
  }
  if (session) {
    await restoreOfflineSourcePrivateChat(session, chat).catch(() => {});
  }
  const justStarted = String(params.justStarted || '') === '1';
  if (session && !session.attendance) {
    ensureOfflineAttendance(session, chat);
    await saveOfflineSession(session).catch(() => {});
  }

  const liveGenerationAtMount = !!session?.inFlight
    && reconcileNarrationGenerationActivity('offline', session.id || session.chatId);
  if (session?.inFlight && !liveGenerationAtMount) {
    const recovered = commitOfflineInFlightIfNeeded(session);
    if (recovered.committed || recovered.cleared) {
      await saveOfflineSession(session, { allowShrink: true }).catch(() => {});
      if (recovered.committed) {
        showToast('已恢复上次未完成的推进');
      }
    }
  }
  if (recoveredFromMirror) {
    const mediaTrimmed = (session?.beats || []).some((beat) => (
      beat?.image?.recoveredWithoutLocalMedia || beat?.audio?.recoveredWithoutLocalMedia
    ));
    showToast(mediaTrimmed
      ? '已从本地备份恢复未收纳线下；本地生成的图片或语音需重新生成'
      : '已从本地备份恢复未收纳线下');
    recoveredFromMirror = false;
  }

  // 「掏出手机」插曲回程：把期间的线上往来折成一条插曲 beat
  if (session?.phoneSideTrip) {
    const folded = await resolvePhoneSideTripInterlude(session).catch(() => ({ added: false }));
    if (folded.added) showToast('刚才的线上插曲已记进线下时间线');
  }
  const sessionReadyAt = globalThis.performance?.now?.() || Date.now();

  const thoughtCharacterIds = [...new Set([
    ...(session ? getOfflineAttendanceMembers(session, chat).map((row) => row.characterId) : []),
    ...((session?.beats || []).flatMap((beat) => Object.keys(beat?.characterStates || {}))),
  ].map((id) => String(id || '').trim()).filter(Boolean))];
  const [globalAutoReply, stylePrefs, initialAudioStylePrefs, title, thoughtCharacters] = await Promise.all([
    loadOfflineAutoReplySettings(user.id).catch(() => ({
      mode: 'off',
      fixedText: '',
      proxyCharacterId: '',
      incomingTakeover: { enabled: false, frequency: 'medium' },
      sideTripCaught: { enabled: false, frequency: 'medium' },
      phoneMessagesEnabled: true,
    })),
    loadOfflineStylePrefs(user.id),
    loadOfflineAudioStylePrefs(user.id),
    resolveTitle(chat, session?.scene, session),
    getCharactersByIds(thoughtCharacterIds, { userId: user.id }).catch(() => []),
  ]);
  const thoughtCharacterNamesById = new Map();
  thoughtCharacterIds.forEach((id, index) => {
    const row = thoughtCharacters[index];
    const name = String(row?.customNickname || row?.name || row?.realName || '').trim();
    if (name) thoughtCharacterNamesById.set(id, name);
  });
  const displayDataReadyAt = globalThis.performance?.now?.() || Date.now();
  if (session && isOfflineUserPresent(session, chat) && applyOfflineAutoReplyDefaults(session, globalAutoReply)) {
    // 默认值已经同步应用到当前内存态；持久化不应继续挡住首屏。
    globalThis.setTimeout(() => saveOfflineSession(session).catch((err) => {
      console.warn('[offline-session] default message settings save failed', err);
    }), 0);
  }

  // 世界书与预设只在打开叙事设置或指导重修时使用。大库用户进门时不再为了
  // 一个尚未展开的设置抽屉扫描全部世界书。
  let worldBookRows = [];
  let worldBookOptions = [];
  let presetOptions = [];
  let scenePresets = [];
  let selectedPresetId = '';
  let settingsCatalogPromise = null;
  const ensureSettingsCatalogs = async () => {
    if (settingsCatalogPromise) return settingsCatalogPromise;
    settingsCatalogPromise = Promise.all([
      listAllWorldBookRows().catch(() => []),
      listOfflinePresetOptions().catch(() => []),
      listOfflineScenePresets(user.id).catch(() => []),
      getLastOfflineScenePresetId(user.id).catch(() => ''),
    ]).then(([books, styles, scenes, selected]) => {
      worldBookRows = Array.isArray(books) ? books : [];
      worldBookOptions = worldBookRows
        .filter((wb) => wb.isBookRoot)
        .map((wb) => ({ id: wb.id, name: wb.name || wb.title || wb.id }));
      presetOptions = Array.isArray(styles) ? styles : [];
      scenePresets = Array.isArray(scenes) ? scenes : [];
      selectedPresetId = String(selected || '');
      if (selectedPresetId && !scenePresets.some((p) => p.id === selectedPresetId)) selectedPresetId = '';
      return { worldBookRows, worldBookOptions, presetOptions, scenePresets, selectedPresetId };
    }).finally(() => {
      settingsCatalogPromise = null;
    });
    return settingsCatalogPromise;
  };

  let sceneOpen = false;
  let finishedArchive = null;
  let optionsCollapsed = false;
  let selectedOptionChoices = [];
  let beatEditBound = false;
  let unbindBeatDelete = null;
  let isAdvancing = liveGenerationAtMount;
  let followLatestDuringAdvance = liveGenerationAtMount;
  let advanceAbortController = null;
  let phoneStoryAbortController = null;
  let phoneStoryTask = null;
  let advanceRunRevision = 0;
  let stopRecoveryTimer = 0;
  let stopRecoveryInProgress = false;
  let generationWaitNoticeLevel = 0;
  let generationWaitNoticeTimers = [];
  let routeActivationRevision = 0;
  let settingsSheetOpen = false;
  let guidanceDiscussionOpen = false;
  let pendingPersistError = '';
  let manageMode = false;
  let selectedBeats = new Set();
  let historyExpanded = false;
  let hasPainted = false;
  let anchorWorldTs = 0;
  let closeBeatActionLayer = null;
  let timelineClearanceObserver = null;

  function cancelPhoneStoryTakeover(reason = 'cancelled') {
    if (phoneStoryAbortController && !phoneStoryAbortController.signal.aborted) {
      phoneStoryAbortController.abort(reason);
    }
    phoneStoryAbortController = null;
  }

  function startPhoneStoryTakeover(beat, parentSignal = null) {
    cancelPhoneStoryTakeover('superseded');
    const controller = new AbortController();
    phoneStoryAbortController = controller;
    const abortWithParent = () => controller.abort(parentSignal?.reason || 'offline-generation-stopped');
    if (parentSignal?.aborted) abortWithParent();
    else parentSignal?.addEventListener?.('abort', abortWithParent, { once: true });
    const task = maybeRunOfflineStoryPhoneTakeover({
      user,
      session,
      offlineChat: chat,
      beat,
      signal: controller.signal,
    }).catch((error) => {
      if (!controller.signal.aborted) {
        console.warn('[offline-session] phone story takeover failed', error);
      }
      return { handled: false, reason: controller.signal.aborted ? 'cancelled' : 'failed' };
    }).finally(() => {
      parentSignal?.removeEventListener?.('abort', abortWithParent);
      if (phoneStoryAbortController === controller) phoneStoryAbortController = null;
      if (phoneStoryTask === task) phoneStoryTask = null;
    });
    phoneStoryTask = task;
    return task;
  }
  let audioStageBeatId = String(session?.uiState?.audioStageBeatId || '');
  let audioStageSegmentIndex = Math.max(0, Number(session?.uiState?.audioStageSegmentIndex || 0) || 0);
  // 自动播放依赖一次当前页面内的用户手势。跨路由/重载恢复旧的 true 只会让
  // 按钮显示“暂停”，浏览器却不会允许实际续播，因此每次挂载舞台都从关闭开始。
  let audioStageAuto = false;
  if (session?.uiState?.audioStageAuto === true) session.uiState.audioStageAuto = false;
  let audioStageChoicesOpen = session?.uiState?.audioStageChoicesOpen === true;
  let audioStageMenuOpen = false;
  let audioStageInputOpen = false;
  let audioStageRunToken = 0;
  let audioStagePlaybackBeatId = '';
  let audioStageVoiceWaitBeatId = '';
  let audioStageVoiceNoticeBeatId = '';
  let audioStageTimer = 0;
  let audioStageForegroundSlot = { gesture: null, audio: null };
  let audioStageEffectGestureTokens = [];
  const audioStageEffectSlots = new Map();
  let audioStageAssetRows = null;
  const audioStageBreathModeByActor = new Map();
  let audioStageBackground = [];
  let audioStageEffects = [];
  let audioStageStreamingBeat = null;
  let audioStageAwaitingBeat = false;
  let audioStagePlaybackReadyDuringAdvance = false;
  let audioStageProgressLabel = '';
  let audioStageStreamFrame = 0;
  let audioStagePendingBackgroundUrl = '';
  let audioSceneHistorySheet = null;

  const isTrip = session?.scene?.activityKind === 'trip';
  let audioStylePrefs = initialAudioStylePrefs;
  let activeStyleDraft = null;
  let activeAudioStyleDraft = null;

  function generationPrimaryActionContent(stopping = isAdvancing) {
    return stopping
      ? `${icon('stop')}<span class="offline-primary-action-label">停止</span>`
      : icon('advance');
  }

  function generationWaitNoticeText() {
    return generationWaitNoticeLevel >= 2
      ? '长时间未收到内容，线路可能仍在处理，也可能已经失去响应。'
      : '等待时间较长，任务仍在继续，不会自动停止。';
  }

  function generationWaitNoticeHtml() {
    return `
      <div class="offline-generation-wait" data-offline-long-wait role="status" aria-live="polite" ${generationWaitNoticeLevel ? '' : 'hidden'}>
        <span data-offline-long-wait-copy>${esc(generationWaitNoticeText())}</span>
        <button type="button" id="offline-generation-wait-stop" data-offline-wait-stop>停止本轮</button>
      </div>`;
  }

  function renderGenerationWaitNotice() {
    const notice = container.querySelector('[data-offline-long-wait]');
    if (!notice) return;
    notice.hidden = generationWaitNoticeLevel <= 0 || !isAdvancing;
    const copy = notice.querySelector('[data-offline-long-wait-copy]');
    if (copy) copy.textContent = generationWaitNoticeText();
  }

  function clearGenerationWaitNotice() {
    generationWaitNoticeTimers.forEach((timer) => window.clearTimeout(timer));
    generationWaitNoticeTimers = [];
    generationWaitNoticeLevel = 0;
    renderGenerationWaitNotice();
  }

  function armGenerationWaitNotice(startedAt = Date.now()) {
    clearGenerationWaitNotice();
    const elapsed = Math.max(0, Date.now() - Number(startedAt || Date.now()));
    const schedule = (level, threshold) => {
      const show = () => {
        if (!isAdvancing) return;
        generationWaitNoticeLevel = Math.max(generationWaitNoticeLevel, level);
        renderGenerationWaitNotice();
      };
      const remaining = threshold - elapsed;
      if (remaining <= 0) show();
      else generationWaitNoticeTimers.push(window.setTimeout(show, remaining));
    };
    schedule(1, OFFLINE_LONG_WAIT_NOTICE_MS);
    schedule(2, OFFLINE_VERY_LONG_WAIT_NOTICE_MS);
  }

  function clearStopRecoveryTimer() {
    if (stopRecoveryTimer) window.clearTimeout(stopRecoveryTimer);
    stopRecoveryTimer = 0;
  }

  function restoreStopButtonsForRetry() {
    container.querySelectorAll('.offline-stop, .offline-stop-primary, [data-offline-wait-stop]').forEach((button) => {
      button.disabled = false;
      const label = button.querySelector('span');
      if (label) label.textContent = '再次终止';
      else if (button.matches('[data-offline-wait-stop]')) button.textContent = '再次终止';
    });
  }

  async function forceFinishStoppedGeneration() {
    stopRecoveryTimer = 0;
    if (!isAdvancing || stopRecoveryInProgress || !session) return;
    const sessionKey = session.id || session.chatId || chatId;
    if (!canForceReleaseNarrationGenerationLease('offline', sessionKey)) {
      restoreStopButtonsForRetry();
      showToast('这轮请求仍由另一个页面持有，请回到原页面停止或关闭它后再试', 5000);
      return;
    }

    stopRecoveryInProgress = true;
    const stoppedSession = session;
    const stoppedFlight = stoppedSession.inFlight ? { ...stoppedSession.inFlight } : null;
    const recovery = commitOfflineInFlightIfNeeded(stoppedSession);
    // 先让仍悬挂的旧 runAdvance 失去 UI 所有权；核心层也会因 inFlight beatId
    // 已被清除而拒绝任何晚到正文、媒体或最终保存。
    advanceRunRevision += 1;
    isAdvancing = false;
    advanceAbortController = null;
    clearGenerationWaitNotice();

    try {
      const releaseTask = forceReleaseNarrationGenerationLease(
        'offline',
        sessionKey,
        'user-stop-timeout',
      );
      let recoveredSession = stoppedSession;
      if (stoppedFlight?.mode === 'revision') {
        // 重写事务可能已在旧内存对象里临时替换末层，但成功前不会提交。强制停止时
        // 从数据库重读旧稿，只清恢复标记，绝不把半成品重写保存成正式版本。
        const latest = (await loadOfflineSessionWithMeta(chatId).catch(() => null))?.session;
        if (latest) {
          if (String(latest.inFlight?.beatId || '') === String(stoppedFlight.beatId || '')) {
            commitOfflineInFlightIfNeeded(latest);
            await saveOfflineSession(latest, { allowShrink: true }).catch(() => {});
          }
          recoveredSession = latest;
        }
      } else {
        await saveOfflineSession(stoppedSession, { allowShrink: true }).catch(() => {});
      }
      await releaseTask;
      session = recoveredSession;
      showToast(recovery.committed
        ? '已停止本轮，收到的部分正文已保留'
        : '已停止本轮，可以继续发送');
    } catch (error) {
      session = stoppedSession;
      console.warn('[offline-session] forced stop cleanup failed', error);
      showToast('已解除页面生成状态，可以继续操作');
    } finally {
      stopRecoveryInProgress = false;
      paint();
    }
  }

  container.className = `page scrapbook-page offline-page${isTrip ? ' offline-page--trip' : ' offline-session-page'}`;
  if (!isTrip) {
    applyStylePrefs(container, stylePrefs, {
      customCssEnabled: session?.scene?.audioSceneEnabled !== true,
    });
    anchorWorldTs = Number(session?.startedAtWorld || session?.createdAt || 0);
  }
  const unsubscribeOfflineStyle = subscribeOfflineStyleChanges(user.id, (next, meta) => {
    if (!container.isConnected) {
      unsubscribeOfflineStyle();
      return;
    }
    Object.assign(stylePrefs, next);
    if (meta.reason === 'clear-css' && activeStyleDraft) {
      activeStyleDraft.css = '';
      const cssInput = document.querySelector('#modal-container [data-style-css]');
      if (cssInput) cssInput.value = '';
    }
    if (!isTrip) {
      applyStylePrefs(container, stylePrefs, {
        customCssEnabled: session?.scene?.audioSceneEnabled !== true,
      });
    }
  });
  const unsubscribeOfflineAudioStyle = subscribeOfflineAudioStyleChanges(user.id, (next) => {
    if (!container.isConnected) {
      unsubscribeOfflineAudioStyle();
      return;
    }
    audioStylePrefs = next;
    if (session?.scene?.audioSceneEnabled === true) applyAudioStageAppearance(container, audioStylePrefs);
  });

  function beatsView() {
    return {
      manage: manageMode,
      selected: selectedBeats,
      historyExpanded,
      thoughtsEnabled: session.scene?.innerVoiceEnabled === true,
      activeCharacterIds: getActiveOfflineParticipantIds(session, chat),
      characterNamesById: thoughtCharacterNamesById,
      audioScene: session.scene?.audioSceneEnabled === true,
      userPresent: isOfflineUserPresent(session, chat),
      timeZone: offlineTimeZone,
    };
  }

  function applyAudioScenePresentation() {
    const enabled = session?.scene?.audioSceneEnabled === true;
    container.classList.toggle('offline-audio-scene', enabled);
    if (!enabled) {
      delete container.dataset.audioLayout;
      container.style.removeProperty('--offline-audio-scene-image');
      return;
    }
    container.dataset.audioLayout = session.scene?.audioSceneLayout === 'landscape' ? 'landscape' : 'portrait';
    const latestGeneratedBeat = [...(session.beats || [])]
      .reverse()
      .find((beat) => beat?.role === 'narration' && beat?.image?.url);
    const latestGenerated = latestGeneratedBeat?.image?.url || '';
    const generatedAt = Math.max(0, Number(latestGeneratedBeat?.image?.generatedAt || 0) || 0);
    const uploadedBackground = session.scene?.audioSceneBackground || '';
    const uploadedAt = Math.max(0, Number(session.scene?.audioSceneBackgroundUpdatedAt || 0) || 0);
    // 上传与生图都按最后更新时间接管舞台。旧会话没有时间戳时继续保留上传图；
    // 新生成的场景图完成后会自动换景，之后用户再次上传仍可覆盖到下一次生图。
    const storedSceneImage = latestGenerated && (!uploadedBackground || generatedAt > uploadedAt)
      ? latestGenerated
      : (uploadedBackground || latestGenerated);
    const imageUrl = audioStagePendingBackgroundUrl
      || storedSceneImage
      || stylePrefs.bgImage
      || '';
    if (imageUrl) {
      container.style.setProperty('--offline-audio-scene-image', `url("${String(imageUrl).replace(/"/g, '%22')}")`);
      container.dataset.audioHasSceneImage = '1';
    } else {
      container.style.removeProperty('--offline-audio-scene-image');
      delete container.dataset.audioHasSceneImage;
    }
    applyAudioStageAppearance(container, activeAudioStyleDraft || audioStylePrefs);
  }

  function releaseAudioStagePendingBackground() {
    const url = audioStagePendingBackgroundUrl;
    audioStagePendingBackgroundUrl = '';
    if (url && url.startsWith('blob:')) {
      try { URL.revokeObjectURL(url); } catch (_) {}
    }
  }

  function latestAudioStageBeat() {
    if (audioStageStreamingBeat?.text) return audioStageStreamingBeat;
    if (audioStageAwaitingBeat) return null;
    return [...(session?.beats || [])].reverse().find((beat) => beat?.role === 'narration') || null;
  }

  function persistAudioStageState() {
    if (!session) return;
    session.uiState = {
      ...(session.uiState || {}),
      audioStageBeatId,
      audioStageSegmentIndex,
      audioStageAuto,
      audioStageChoicesOpen,
    };
  }

  function getAudioStageModel() {
    const beat = latestAudioStageBeat();
    if (!beat) return { beat: null, segments: [], current: null, index: 0 };
    const segments = buildOfflineAudioStageSegments(beat);
    if (audioStageBeatId !== beat.id) {
      audioStageBeatId = beat.id;
      audioStageSegmentIndex = 0;
      audioStageChoicesOpen = false;
      if (!audioStageStreamingBeat) persistAudioStageState();
    }
    const index = Math.min(Math.max(0, audioStageSegmentIndex), Math.max(0, segments.length - 1));
    audioStageSegmentIndex = index;
    return { beat, segments, current: segments[index] || null, index };
  }

  function audioStageDialogueHtml() {
    const { beat, segments, current, index } = getAudioStageModel();
    const isDialogue = current?.type === 'dialogue';
    const speaker = isDialogue ? (current.actorName || '角色') : '旁白';
    const text = current?.text
      || (isAdvancing
        ? (audioStageProgressLabel || '正在准备这一幕……')
        : (beat ? '这一幕已经结束。' : '点击下方开始，让故事在这里发生。'));
    const progress = segments.length ? `${index + 1} / ${segments.length}` : '序幕';
    const voicePending = isDialogue && !current?.audioDataUrl && beat?.voiceSynthesis?.pending === true;
    const stageStatus = voicePending
      ? '语音合成中…'
      : (current ? audioStageProgressLabel : '');
    const playbackBlocked = isAdvancing && !audioStagePlaybackReadyDuringAdvance;
    const canAdvanceSegment = !!current && !audioStageChoicesOpen && !playbackBlocked;
    const canGoPrevious = index > 0 && !playbackBlocked;
    const canReplayRound = segments.length > 0 && !playbackBlocked;
    const canRerollRound = !isAdvancing && session?.beats?.some((row) => row?.role === 'narration');
    return `
      <section class="offline-audio-dialogue${isDialogue ? ' is-dialogue' : ' is-narration'}" aria-live="polite" aria-busy="${playbackBlocked || voicePending ? 'true' : 'false'}">
        <div class="offline-audio-nameplate"><span>${esc(speaker)}</span>${stageStatus ? `<small>${esc(stageStatus)}</small>` : ''}</div>
        <button type="button" class="offline-audio-dialogue-copy" data-audio-segment-next ${canAdvanceSegment ? '' : 'disabled'}>
          <span>${esc(applyDisplayRegex(text, 'offline'))}</span>
          ${isDialogue && current?.translation ? `<small class="offline-audio-dialogue-translation">${esc(applyDisplayRegex(current.translation, 'offline'))}</small>` : ''}
        </button>
        <footer class="offline-audio-dialogue-controls">
          <div class="offline-audio-dialogue-actions">
            <button type="button" data-audio-autoplay class="${audioStageAuto ? 'is-active' : ''}" aria-pressed="${audioStageAuto ? 'true' : 'false'}">${icon(audioStageAuto ? 'pause' : 'play')}<span>${voicePending && audioStageAuto ? '等待语音' : (audioStageAuto ? '暂停' : '自动')}</span></button>
            <button type="button" data-audio-reroll ${canRerollRound ? '' : 'disabled'}>${icon('reroll')}<span>重 roll</span></button>
            <button type="button" data-audio-input-toggle aria-expanded="${audioStageInputOpen ? 'true' : 'false'}">${icon('edit')}<span>写回应</span></button>
          </div>
          <div class="offline-audio-dialogue-nav">
            <button type="button" class="offline-audio-replay" data-audio-replay aria-label="从第一段播放整幕" ${canReplayRound ? '' : 'disabled'}>${icon('speaker')}<span>从头播放</span></button>
            <button type="button" class="offline-audio-prev" data-audio-segment-prev aria-label="上一段" ${canGoPrevious ? '' : 'disabled'}>${icon('chevron')}<span>上一段</span></button>
            <span class="offline-audio-progress">${esc(progress)}</span>
            <button type="button" class="offline-audio-next" data-audio-segment-next aria-label="下一段" ${canAdvanceSegment ? '' : 'disabled'}><span>下一段</span>${icon('chevron')}</button>
          </div>
        </footer>
      </section>`;
  }

  function audioStageMenuHtml() {
    const currentBeat = [...(session?.beats || [])].reverse().find((beat) => beat?.role === 'narration');
    const imageActionLabel = currentBeat?.image?.url ? '重 roll 场景图' : '生图换景';
    const versionCount = currentBeat && session?.scene?.retainRerollVersions === true
      ? listOfflineRerollVersions(session, currentBeat.id).versions.length
      : 0;
    return `
      <div class="offline-audio-menu" ${audioStageMenuOpen ? '' : 'hidden'}>
        <button type="button" data-audio-background-upload>${icon('image')}<span>更换背景</span></button>
        <input type="file" data-audio-background-file accept="image/*" hidden />
        ${session?.scene?.audioSceneBackground ? `<button type="button" data-audio-background-clear>${icon('close')}<span>恢复生成背景</span></button>` : ''}
        <button type="button" data-audio-reroll>${icon('reroll')}<span>重 roll 本幕</span></button>
        ${versionCount > 1 ? `<button type="button" data-audio-versions>${icon('time')}<span>本幕版本（${versionCount}）</span></button>` : ''}
        <button type="button" data-audio-change-scene>${icon('sparkle')}<span>${imageActionLabel}</span></button>
        <button type="button" data-audio-history>${icon('time')}<span>回顾幕历史</span></button>
        <button type="button" data-audio-layout-toggle>${icon('window')}<span>${session?.scene?.audioSceneLayout === 'landscape' ? '切回竖屏布局' : '切到横屏布局'}</span></button>
        <button type="button" data-audio-style>${icon('palette')}<span>舞台美化</span></button>
        <button type="button" data-open-chat>${icon('message')}<span>本场聊天</span></button>
        <button type="button" data-open-settings>${icon('settings')}<span>叙事设置</span></button>
        <button type="button" class="offline-summarize" ${isAdvancing ? 'disabled' : ''}>${icon('check')}<span>总结收纳</span></button>
      </div>`;
  }

  function audioStageShellHtml() {
    return `
      <main class="offline-scroll offline-audio-stage" aria-label="音声舞台">
        <div class="offline-audio-stage-shade" aria-hidden="true"></div>
        ${audioStageDialogueHtml()}
      </main>
      <div class="offline-options" hidden></div>
      ${generationWaitNoticeHtml()}
      <section class="offline-audio-input" ${audioStageInputOpen ? '' : 'hidden'}>
        <header>
          <label for="offline-audio-directive">写下你的回应</label>
          <button type="button" data-audio-input-toggle aria-label="收起输入">${icon('close')}</button>
        </header>
        <div>
          <textarea id="offline-audio-directive" class="form-input offline-directive" rows="2" placeholder="此刻，你想说……">${esc(session?.uiState?.directiveDraft || '')}</textarea>
          <button type="button" class="offline-directive-clear" data-clear-directive aria-label="清空输入" ${session?.uiState?.directiveDraft ? '' : 'hidden'}>${icon('close')}</button>
          <button type="button" class="offline-expand" aria-label="展开输入">${icon('expand')}</button>
          ${isAdvancing
            ? `<button type="button" id="offline-generation-action" class="offline-advance offline-stop-primary" aria-label="终止 AI 输出">${generationPrimaryActionContent(true)}</button>`
            : `<button type="button" id="offline-generation-action" class="offline-advance" aria-label="发送对白">${generationPrimaryActionContent(false)}</button>`}
        </div>
      </section>
      ${audioStageMenuHtml()}`;
  }

  function stopAudioStageForeground() {
    audioStageRunToken += 1;
    if (audioStageTimer) {
      window.clearTimeout(audioStageTimer);
      audioStageTimer = 0;
    }
    const audio = audioStageForegroundSlot.audio;
    if (audio) {
      try { audio.pause(); } catch (_) {}
      try { audio.currentTime = 0; } catch (_) {}
    }
    audioStageForegroundSlot.gesture?.dispose?.();
    audioStageForegroundSlot.gesture = null;
    clearAudioStageSegmentEffects();
    resetAudioStageEffectPlayback();
  }

  function resetAudioStageEffectPlayback() {
    audioStageEffectGestureTokens.forEach((token) => token?.dispose?.());
    audioStageEffectGestureTokens = [];
    audioStageEffectSlots.forEach((slot) => {
      slot.gesture?.dispose?.();
      slot.owner = null;
      try {
        slot.audio?.pause?.();
        slot.audio?.removeAttribute?.('src');
        slot.audio?.load?.();
      } catch (_) {}
    });
    audioStageEffectSlots.clear();
  }

  function primeAudioStagePlaybackGestures(event = null) {
    audioStageForegroundSlot.gesture = captureMediaGesture(event);
    audioStageEffectGestureTokens = [
      captureMediaGesture(event),
      captureMediaGesture(event),
      captureMediaGesture(event),
    ];
  }

  function takeAudioStageEffectAudio(category = '', src = '', layer = null) {
    const key = String(category || '').trim();
    let slot = audioStageEffectSlots.get(key);
    if (!slot) {
      const reusableSlot = [...audioStageEffectSlots.values()].find((candidate) => (
        candidate.owner?.longLived !== true
      ));
      slot = {
        gesture: audioStageEffectGestureTokens.shift() || null,
        audio: null,
        owner: null,
      };
      if (!slot.gesture && reusableSlot) slot = reusableSlot;
      if (!slot.gesture && !slot.audio) return null;
      audioStageEffectSlots.set(key, slot);
    }
    const audio = takePlayableAudio(src, slot);
    if (!audio) return null;
    slot.owner = layer;
    if (layer) layer.slotState = slot;
    return audio;
  }

  function cleanupAudioStageLayer(layer) {
    if (!layer) return;
    if (layer.startTimer) window.clearTimeout(layer.startTimer);
    if (layer.fadeTimer) window.clearTimeout(layer.fadeTimer);
    if (layer.fadeInterval) window.clearInterval(layer.fadeInterval);
    const ownsAudio = !layer.slotState || layer.slotState.owner === layer;
    if (ownsAudio) {
      try { layer.audio?.pause(); } catch (_) {}
      try { layer.audio && (layer.audio.src = ''); } catch (_) {}
    }
    if (layer.slotState?.owner === layer) layer.slotState.owner = null;
    layer.revoke?.();
  }

  function clearAudioStageSegmentEffects({ keepLong = false } = {}) {
    const retained = [];
    audioStageEffects.forEach((layer) => {
      if (keepLong && layer?.longLived === true && layer.audio && !layer.audio.ended) {
        retained.push(layer);
        return;
      }
      cleanupAudioStageLayer(layer);
    });
    audioStageEffects = retained;
  }

  async function finishAudioStageEffects() {
    const active = audioStageEffects.filter((layer) => layer?.audio && !layer.audio.ended);
    active.forEach((layer) => fadeAudioStageLayer(layer, 0, 520));
    if (active.length) await new Promise((resolve) => window.setTimeout(resolve, 540));
    clearAudioStageSegmentEffects();
  }

  function fadeAudioStageLayer(layer, target, duration = 180) {
    if (!layer?.audio) return;
    if (layer.fadeInterval) window.clearInterval(layer.fadeInterval);
    const audio = layer.audio;
    const from = Number(audio.volume || 0);
    const startedAt = Date.now();
    layer.fadeInterval = window.setInterval(() => {
      const progress = Math.min(1, (Date.now() - startedAt) / Math.max(1, duration));
      audio.volume = Math.max(0, Math.min(1, from + ((target - from) * progress)));
      if (progress >= 1) {
        window.clearInterval(layer.fadeInterval);
        layer.fadeInterval = 0;
      }
    }, 24);
  }

  function stopAudioStageBackground() {
    audioStageBackground.forEach(cleanupAudioStageLayer);
    audioStageBackground = [];
    audioStageEffects.forEach(cleanupAudioStageLayer);
    audioStageEffects = [];
  }

  async function getAudioStageAssets() {
    if (!audioStageAssetRows) {
      audioStageAssetRows = await listSoundAssets({ ownerId: user.id }).catch(() => []);
    }
    return audioStageAssetRows.filter((row) => row?.enabled !== false && row?.audioBlob instanceof Blob);
  }

  function isAudioStageSoundEnabled() {
    return session?.scene?.audioStageSoundEnabled !== false;
  }

  function audioStageMixValue(key, fallback) {
    const value = Number(session?.scene?.[key]);
    return (Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : fallback) / 100;
  }

  function syncActiveAudioStageMix() {
    if (!isAudioStageSoundEnabled()) {
      stopAudioStageBackground();
      return;
    }
    const backgroundMix = audioStageMixValue('audioStageBackgroundVolume', 20);
    audioStageBackground.forEach((layer) => {
      const target = backgroundMix * (String(layer.category || '').startsWith('bgm') ? 0.7 : 1);
      fadeAudioStageLayer(layer, target, 160);
    });
    audioStageEffects.forEach((layer) => {
      if (!layer.audio || layer.audio.ended) return;
      const target = resolveNarrationSoundMixVolume(
        audioStageMixValue('audioStageActionVolume', 58),
        layer.category,
        { eventGain: Number(layer.eventGain || 0.5) },
      );
      fadeAudioStageLayer(layer, target, 120);
    });
  }

  function chooseAudioStageAsset(rows, category, seed = '') {
    const pool = rows.filter((row) => String(row?.category || '') === String(category || ''));
    if (!pool.length) return null;
    const score = [...String(seed || category)].reduce((sum, char) => sum + char.charCodeAt(0), 0);
    return pool[score % pool.length];
  }

  async function resolveAudioStageBreathMode(actorId = '') {
    const id = String(actorId || '').trim();
    if (!id) return 'standard';
    if (audioStageBreathModeByActor.has(id)) return audioStageBreathModeByActor.get(id);
    const character = await getCharacter(id, { userId: user.id }).catch(() => null);
    const mode = normalizeBreathSupplementMode(
      (character?.voiceProfile || character?.voice)?.breathSupplementMode,
    );
    audioStageBreathModeByActor.set(id, mode);
    return mode;
  }

  async function startAudioStageBackground(beat) {
    if (!isAudioStageSoundEnabled() || !beat || audioStageBackground.some((layer) => layer.beatId === beat.id)) return;
    stopAudioStageBackground();
    const rows = await getAudioStageAssets();
    const explicit = Array.isArray(beat?.stageSound?.background) ? beat.stageSound.background : [];
    const categories = explicit.length
      ? explicit
      : inferNarrationContinuousSoundCuesFromMessages([{ content: beat.text || '' }]);
    for (const category of categories.slice(0, 2)) {
      const asset = chooseAudioStageAsset(rows, category, `${beat.id}:${category}`);
      const playback = createSoundAssetPlayback(asset || {});
      if (!playback.url) continue;
      const audio = new Audio(playback.url);
      const layer = { audio, revoke: playback.revoke, beatId: beat.id, category };
      audio.loop = true;
      audio.preload = 'auto';
      audio.setAttribute('playsinline', 'true');
      const backgroundMix = audioStageMixValue('audioStageBackgroundVolume', 20);
      const targetVolume = backgroundMix * (String(category).startsWith('bgm') ? 0.7 : 1);
      audio.volume = 0;
      try {
        await playAudioWhenReady(audio, { foregroundMedia: false });
        audioStageBackground.push(layer);
        fadeAudioStageLayer(layer, targetVolume, String(category).startsWith('bgm') ? 720 : 520);
      } catch (_) {
        cleanupAudioStageLayer(layer);
      }
    }
  }

  async function playAudioStageEffects(segment, beat, { durationMs = 0 } = {}) {
    if (!isAudioStageSoundEnabled()) return;
    let categories = prioritizeNarrationSoundCategories(
      Array.isArray(segment?.soundCategories) ? segment.soundCategories : [],
      { max: 3 },
    );
    const soundActorId = String(segment?.actorId || segment?.soundActorId || '').trim();
    if (soundActorId) {
      categories = filterBreathSoundCues(
        categories,
        await resolveAudioStageBreathMode(soundActorId),
      );
    }
    if (!categories.length) return;
    const rows = await getAudioStageAssets();
    const textureCategories = categories.filter(isTextureSoundCategory);
    const texturePlan = segment?.texturePlan?.categories?.length
      ? { ...segment.texturePlan, categories: textureCategories }
      : { categories: textureCategories, intensity: 0.56, tempo: 'steady' };
    const schedule = segment?.type === 'dialogue' && textureCategories.length
      ? buildTextureSoundSchedule(texturePlan, {
        durationMs: Math.max(720, Number(durationMs || 0)),
        seed: `${beat?.id}:${audioStageSegmentIndex}:texture`,
      })
      : [];
    const events = [
      ...categories.filter((category) => !isTextureSoundCategory(category)).map((category, index) => ({
        category,
        offsetMs: index * 90,
        gain: 0.72,
        playbackRate: 1,
        assetIndex: index,
      })),
      ...(schedule.length ? schedule : textureCategories.map((category, index) => ({
        category,
        offsetMs: index * 90,
        gain: 0.5,
        playbackRate: 1,
        assetIndex: index,
      }))),
    ].sort((left, right) => left.offsetMs - right.offsetMs);
    events.forEach((event, index) => {
      const layer = {
        audio: null,
        revoke: null,
        category: event.category,
        eventGain: Number(event.gain || 0.5),
        longLived: false,
        startTimer: 0,
      };
      audioStageEffects.push(layer);
      layer.startTimer = window.setTimeout(() => {
        layer.startTimer = 0;
        if (!isAudioStageSoundEnabled()) {
          audioStageEffects = audioStageEffects.filter((row) => row !== layer);
          return;
        }
        if (audioStageEffects.some((row) => (
          row !== layer
          && row?.category === event.category
          && row.audio
          && !row.audio.ended
        ))) {
          audioStageEffects = audioStageEffects.filter((row) => row !== layer);
          return;
        }
        const categoryRows = rows.filter((row) => String(row?.category || '') === String(event.category || ''));
        const pool = filterTextureSoundAssetsByPlan(categoryRows, event.category, {
          ...texturePlan,
          durationMs,
        });
        const asset = pool.length ? pool[Math.abs(Number(event.assetIndex || index)) % pool.length] : null;
        if (!audioStageEffects.includes(layer)) return;
        const playback = createSoundAssetPlayback(asset || {});
        if (!playback.url) {
          audioStageEffects = audioStageEffects.filter((row) => row !== layer);
          return;
        }
        const audio = takeAudioStageEffectAudio(event.category, playback.url, layer);
        if (!audio) {
          playback.revoke?.();
          audioStageEffects = audioStageEffects.filter((row) => row !== layer);
          return;
        }
        layer.longLived = Number(asset?.durationMs || 0) >= 2200 || asset?.texturePlayback === 'span';
        layer.audio = audio;
        layer.revoke = playback.revoke;
        audio.preload = 'auto';
        audio.setAttribute('playsinline', 'true');
        audio.volume = 0;
        audio.playbackRate = Math.max(0.9, Math.min(1.15, Number(event.playbackRate || 1)));
        audio.addEventListener('ended', () => {
          audioStageEffects = audioStageEffects.filter((row) => row !== layer);
          cleanupAudioStageLayer(layer);
        }, { once: true });
        void playAudioWhenReady(audio, { foregroundMedia: false }).then(() => {
          audio.playbackRate = Math.max(0.9, Math.min(1.15, Number(event.playbackRate || 1)));
          const durationMs = Number.isFinite(audio.duration) && audio.duration > 0
            ? audio.duration * 1000
            : Number(asset?.durationMs || 0);
          const envelope = resolveSoundCueEnvelope(event.category, durationMs);
          const targetVolume = resolveNarrationSoundMixVolume(
            audioStageMixValue('audioStageActionVolume', 58),
            event.category,
            { eventGain: Number(event.gain || 0.5) },
          );
          fadeAudioStageLayer(layer, targetVolume, envelope.fadeInMs);
          if (durationMs > 0) {
            layer.fadeTimer = window.setTimeout(() => {
              layer.fadeTimer = 0;
              fadeAudioStageLayer(layer, 0, envelope.fadeOutMs);
            }, Math.max(envelope.fadeInMs, durationMs - envelope.fadeOutMs));
          }
        }).catch(() => {
          audioStageEffects = audioStageEffects.filter((row) => row !== layer);
          cleanupAudioStageLayer(layer);
        });
      }, Math.max(0, Number(event.offsetMs || 0)));
    });
  }

  function waitForAudioStageDelay(ms, token) {
    return new Promise((resolve) => {
      audioStageTimer = window.setTimeout(() => {
        audioStageTimer = 0;
        resolve(token === audioStageRunToken);
      }, ms);
    });
  }

  function waitForAudioStageEnd(audio, token) {
    return new Promise((resolve) => {
      let settled = false;
      let timeout = 0;
      const done = () => {
        if (settled) return;
        settled = true;
        if (timeout) window.clearTimeout(timeout);
        audio.removeEventListener('ended', done);
        audio.removeEventListener('error', done);
        audio.removeEventListener('pause', done);
        resolve(token === audioStageRunToken);
      };
      audio.addEventListener('ended', done, { once: true });
      audio.addEventListener('error', done, { once: true });
      audio.addEventListener('pause', done, { once: true });
      timeout = window.setTimeout(done, 30000);
    });
  }

  async function playAudioStageCurrent({ replayOnly = false } = {}) {
    const token = ++audioStageRunToken;
    const { beat, segments, current, index } = getAudioStageModel();
    if (!beat || !current) return;
    if (current.type === 'dialogue' && !current.audioDataUrl && beat?.voiceSynthesis?.pending === true) {
      audioStageVoiceWaitBeatId = beat.id;
      return;
    }
    audioStageVoiceWaitBeatId = '';
    audioStagePlaybackBeatId = beat.id;
    // 自动连播换片段时只收掉短动作声；长素材属于整幕音床，允许从旁白跨过对白继续。
    clearAudioStageSegmentEffects({ keepLong: audioStageAuto && !replayOnly });
    void startAudioStageBackground(beat);
    let shouldContinue = true;
    if (current.type === 'dialogue' && current.audioDataUrl) {
      if (audioStageForegroundSlot.audio && audioStageForegroundSlot.gesture) {
        audioStageForegroundSlot.gesture.dispose?.();
        audioStageForegroundSlot.gesture = null;
      }
      const audio = takePlayableAudio(current.audioDataUrl, audioStageForegroundSlot);
      if (audio) {
        audio.volume = 1;
        try {
          await playAudioWhenReady(audio);
          const voiceDurationMs = Number.isFinite(audio.duration) && audio.duration > 0
            ? Math.round(audio.duration * 1000)
            : Math.min(5200, Math.max(1600, current.text.length * 95));
          void playAudioStageEffects(current, beat, { durationMs: voiceDurationMs });
          shouldContinue = await waitForAudioStageEnd(audio, token);
        } catch (_) {
          shouldContinue = await waitForAudioStageDelay(Math.min(4200, Math.max(1300, current.text.length * 95)), token);
        }
      }
    } else {
      const segmentDurationMs = Math.min(5200, Math.max(1600, current.text.length * 82));
      void playAudioStageEffects(current, beat, { durationMs: segmentDurationMs });
      shouldContinue = await waitForAudioStageDelay(segmentDurationMs, token);
    }
    if (!shouldContinue || replayOnly || !audioStageAuto) return;
    if (index < segments.length - 1) {
      audioStageSegmentIndex += 1;
      persistAudioStageState();
      renderAudioStage();
      await playAudioStageCurrent();
      return;
    }
    await finishAudioStageEffects();
    audioStageChoicesOpen = true;
    persistAudioStageState();
    renderAudioStage();
    renderOptionsFromSession();
  }

  function advanceAudioStageSegment(event = null) {
    const continueAuto = audioStageAuto;
    stopAudioStageForeground();
    const { segments, index } = getAudioStageModel();
    if (!segments.length) {
      audioStageInputOpen = true;
      renderAudioStage();
      return;
    }
    if (index < segments.length - 1) {
      if (continueAuto && event) primeAudioStagePlaybackGestures(event);
      audioStageSegmentIndex += 1;
      persistAudioStageState();
      renderAudioStage();
      if (continueAuto) void playAudioStageCurrent();
      return;
    }
    audioStageChoicesOpen = true;
    persistAudioStageState();
    renderAudioStage();
    renderOptionsFromSession();
  }

  function previousAudioStageSegment(event = null) {
    stopAudioStageForeground();
    const { segments, index } = getAudioStageModel();
    if (!segments.length || index <= 0) return;
    primeAudioStagePlaybackGestures(event);
    audioStageSegmentIndex = index - 1;
    audioStageChoicesOpen = false;
    persistAudioStageState();
    renderOptions([]);
    renderAudioStage();
    void playAudioStageCurrent({ replayOnly: !audioStageAuto });
  }

  function openAudioSceneHistory() {
    if (!session) return;
    const existingSheet = audioSceneHistorySheet?.isConnected
      ? audioSceneHistorySheet
      : container.querySelector('.offline-audio-history');
    if (existingSheet) {
      audioSceneHistorySheet = existingSheet;
      const panel = existingSheet.querySelector('.offline-audio-history-panel');
      try { panel?.focus({ preventScroll: true }); } catch (_) { panel?.focus(); }
      return;
    }
    const rounds = (session.beats || []).filter((beat) => beat?.role === 'narration');
    const stats = collectOfflineSceneMediaStats(rounds, session.scene || {});
    const sheet = document.createElement('div');
    sheet.className = 'offline-audio-history';
    sheet.innerHTML = `
      <button type="button" class="offline-audio-history-backdrop" data-audio-history-close aria-label="关闭幕历史"></button>
      <section class="offline-audio-history-panel" role="dialog" aria-modal="true" aria-label="幕历史" tabindex="-1">
        <header>
          <button type="button" class="offline-audio-history-return" data-audio-history-close aria-label="返回音声舞台">${icon('back')}<span>返回</span></button>
          <div><strong>幕历史</strong><small>${stats.sceneCount} 幕 · 缓存 ${formatMediaBytes(stats.cachedBytes)}</small></div>
        </header>
        <div class="offline-audio-history-actions">
          <span>视频约 ${formatSceneDuration(stats.durationSeconds)} · ${formatMediaBytes(stats.estimatedVideoBytes)}</span>
          <button type="button" data-audio-video-export ${rounds.length ? '' : 'disabled'}>导出视频</button>
        </div>
        <div class="offline-audio-history-list">
          ${rounds.length ? rounds.map((round, index) => {
            // 历史回放也重跑最终正文对齐，避免脱离当前正文的孤立缓存音轨继续播放。
            const voices = alignNarrativeVoiceLinesToDialogueSpans(
              round.text || '',
              (Array.isArray(round.voiceLines) ? round.voiceLines : []).filter((line) => line?.audio?.dataUrl),
              { allowBracketDialogue: true },
            );
            return `
              <article class="offline-audio-history-scene">
                <div class="offline-audio-history-scene-head"><strong>第 ${index + 1} 幕</strong><time>${esc(beatTimeLabel(round, offlineTimeZone))}</time></div>
                ${round.image?.url ? `<div class="offline-audio-history-image-wrap"><button type="button" class="offline-audio-history-image" data-audio-history-image="${index}"><img src="${esc(round.image.url)}" alt="第 ${index + 1} 幕场景图" loading="lazy" /></button><button type="button" class="offline-audio-history-image-save" data-audio-history-image-save="${index}">${icon('download')} 保存图片</button></div>` : ''}
                <div class="offline-audio-history-text">${renderNarrationHtml(round.text || '')}</div>
                <details class="offline-audio-history-complete">
                  <summary>查看完整文本</summary>
                  <pre>${esc(round.text || '')}</pre>
                </details>
                ${voices.length ? `<div class="offline-audio-history-voices">${voices.map((line) => `
                  <label><span>${esc(line.actorName || '角色')}</span><audio controls preload="none" src="${esc(line.audio.dataUrl)}"></audio></label>
                `).join('')}</div>` : '<div class="offline-audio-history-no-voice">本幕没有可重播的语音缓存</div>'}
              </article>`;
          }).join('') : '<div class="offline-audio-history-empty">推进第一幕后会显示在这里</div>'}
        </div>
      </section>`;
    const close = () => {
      // 旧版本可能已经叠出多个历史层；任意一个关闭入口都一次清干净。
      container.querySelectorAll('.offline-audio-history').forEach((node) => node.remove());
      audioSceneHistorySheet = null;
    };
    sheet.querySelectorAll('[data-audio-history-close]').forEach((button) => button.addEventListener('click', close));
    sheet.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      close();
    });
    sheet.querySelectorAll('[data-audio-history-image]').forEach((button) => {
      button.addEventListener('click', () => {
        const round = rounds[Number(button.getAttribute('data-audio-history-image'))];
        if (round?.image?.url) {
          openImageLightbox(round.image.url, {
            save: { filename: `offline-scene-${round.id}.png` },
            onEditPrompt: () => onGenerateBeatImage(round.id, { useAsAudioBackground: true }),
            onReroll: async () => {
              await generateOfflineBeatImage({ session, chat, user, beatId: round.id });
              applyAudioScenePresentation();
              return session.beats.find((beat) => beat.id === round.id)?.image?.url || '';
            },
          });
        }
      });
    });
    sheet.querySelectorAll('[data-audio-history-image-save]').forEach((button) => {
      button.addEventListener('click', async () => {
        const round = rounds[Number(button.getAttribute('data-audio-history-image-save'))];
        if (!round?.image?.url || button.disabled) return;
        button.disabled = true;
        try {
          const result = await saveImageSrc(round.image.url, { filename: `offline-scene-${round.id}.png` });
          showToast(describeImageSaveResult(result));
        } catch (error) {
          showToast(error?.message || '图片保存失败');
        } finally {
          button.disabled = false;
        }
      });
    });
    sheet.querySelector('[data-audio-video-export]')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      if (!button || button.disabled) return;
      if (!window.confirm(`预计生成 ${formatSceneDuration(stats.durationSeconds)}、约 ${formatMediaBytes(stats.estimatedVideoBytes)} 的视频。导出过程按实际时长录制，成片不会留在应用缓存。继续吗？`)) return;
      const original = button.textContent;
      button.disabled = true;
      try {
        const result = await exportOfflineSceneVideo({
          rounds,
          scene: session.scene || {},
          title,
          orientation: session.scene?.audioSceneLayout || 'portrait',
          onProgress: (progress) => {
            if (!button.isConnected) return;
            if (progress.phase === 'prepare') button.textContent = `准备 ${progress.current}/${progress.total}`;
            else button.textContent = `生成 ${Math.min(100, Math.round((progress.elapsed / Math.max(1, progress.total)) * 100))}%`;
          },
        });
        showToast(`视频已导出（${formatMediaBytes(result.bytes)}）`);
      } catch (error) {
        showToast(`视频导出失败：${error?.message || error}`);
      } finally {
        if (button.isConnected) {
          button.disabled = false;
          button.textContent = original;
        }
      }
    });
    audioSceneHistorySheet = sheet;
    container.appendChild(sheet);
    window.requestAnimationFrame(() => {
      const panel = sheet.querySelector('.offline-audio-history-panel');
      const list = sheet.querySelector('.offline-audio-history-list');
      if (list) list.scrollTop = 0;
      try { panel?.focus({ preventScroll: true }); } catch (_) { panel?.focus(); }
    });
  }

  function renderBeats() {
    closeBeatActionLayer?.();
    const beatsEl = container.querySelector('.offline-beats');
    if (!beatsEl) return;
    beatsEl.classList.toggle('is-managing', manageMode);
    beatsEl.innerHTML = beatsHtml(session, beatsView());
    applyAudioScenePresentation();
    const snapshots = {};
    (session?.beats || []).forEach((beat) => {
      (Array.isArray(beat?.htmlWidgets) ? beat.htmlWidgets : []).forEach((snapshot, index) => {
        snapshots[`${beat.id}:${index}`] = snapshot;
      });
    });
    hydrateHtmlExtensionHosts(beatsEl, snapshots, {
      onOpenLink: (url, linkOptions) => openLinkPreview(url, linkOptions),
    });
    syncTimelineNavigator();
  }

  function timelineNavigatorHtml() {
    return `
      <nav class="os-timeline-nav" aria-label="楼层导航">
        <button type="button" class="os-timeline-nav-button is-top" data-timeline-nav="top" aria-label="一键回顶" title="一键回顶">${icon('chevronDown')}</button>
        <button type="button" class="os-timeline-nav-button is-prev" data-timeline-nav="prev" aria-label="查看上一条" title="查看上一条">${icon('chevronDown')}</button>
        <button type="button" class="os-timeline-nav-button is-next" data-timeline-nav="next" aria-label="查看下一条" title="查看下一条">${icon('chevronDown')}</button>
        <button type="button" class="os-timeline-nav-button is-bottom" data-timeline-nav="bottom" aria-label="一键置底" title="一键置底">${icon('chevronDown')}</button>
      </nav>`;
  }

  function timelineRows() {
    return [...container.querySelectorAll('.offline-beat[data-beat-id]')];
  }

  function hasCollapsedTimelineHistory() {
    return !historyExpanded
      && !manageMode
      && (session?.beats?.length || 0) > HISTORY_FOLD_KEEP + 2;
  }

  function currentTimelineIndex(rows = timelineRows()) {
    const scroller = container.querySelector('.offline-scroll');
    if (!scroller || !rows.length) return -1;
    const scrollRect = scroller.getBoundingClientRect();
    const viewportCenter = scrollRect.top + (scroller.clientHeight / 2);
    let bestIndex = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    rows.forEach((row, index) => {
      const rect = row.getBoundingClientRect();
      const distance = Math.abs((rect.top + (rect.height / 2)) - viewportCenter);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    });
    return bestIndex;
  }

  function syncTimelineNavigator() {
    const nav = container.querySelector('.os-timeline-nav');
    const scroller = container.querySelector('.offline-scroll');
    if (!nav || !scroller) return;
    const rows = timelineRows();
    const currentIndex = currentTimelineIndex(rows);
    const atTop = scroller.scrollTop <= 4;
    const atBottom = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= 4;
    const setDisabled = (action, disabled) => {
      const button = nav.querySelector(`[data-timeline-nav="${action}"]`);
      if (button) button.disabled = !!disabled;
    };
    setDisabled('top', atTop);
    setDisabled('prev', !rows.length || (currentIndex <= 0 && !hasCollapsedTimelineHistory()));
    setDisabled('next', !rows.length || currentIndex >= rows.length - 1);
    setDisabled('bottom', atBottom);
  }

  function syncTimelineNavigatorClearance() {
    const nav = container.querySelector('.os-timeline-nav');
    const bottomStack = container.querySelector('.offline-bottom-stack');
    if (!nav || !bottomStack) return;
    const stackHeight = Math.ceil(bottomStack.getBoundingClientRect().height || 0);
    const bottomOffset = Math.max(84, stackHeight + 12);
    nav.style.setProperty('--os-timeline-bottom-offset', `${bottomOffset}px`);

    const pageHeight = Math.ceil(container.getBoundingClientRect().height || 0);
    const navbarHeight = Math.ceil(container.querySelector('.navbar')?.getBoundingClientRect().height || 0);
    const buttonCount = nav.querySelectorAll('.os-timeline-nav-button').length;
    const navHeight = buttonCount * 40 + Math.max(0, buttonCount - 1) * 6;
    nav.classList.toggle('is-space-limited', pageHeight - bottomOffset - navHeight < navbarHeight + 12);
  }

  function scrollTimelineTo(top) {
    const scroller = container.querySelector('.offline-scroll');
    if (!scroller) return;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    try {
      scroller.scrollTo({ top, behavior: reduced ? 'auto' : 'smooth' });
    } catch (_) {
      scroller.scrollTop = top;
    }
  }

  function moveTimeline(direction) {
    let rows = timelineRows();
    if (!rows.length) return;
    const currentIndex = currentTimelineIndex(rows);
    const currentId = rows[currentIndex]?.getAttribute('data-beat-id') || '';
    if (direction < 0 && currentIndex <= 0 && hasCollapsedTimelineHistory()) {
      historyExpanded = true;
      renderBeats();
      rows = timelineRows();
      const restoredIndex = rows.findIndex((row) => row.getAttribute('data-beat-id') === currentId);
      const target = rows[Math.max(0, restoredIndex - 1)];
      if (target) revealRenderedBeat(target.getAttribute('data-beat-id'), { block: 'center', smooth: true });
      return;
    }
    const targetIndex = Math.min(rows.length - 1, Math.max(0, currentIndex + direction));
    const target = rows[targetIndex];
    if (target) revealRenderedBeat(target.getAttribute('data-beat-id'), { block: 'center', smooth: true });
  }

  function bindTimelineNavigator() {
    const nav = container.querySelector('.os-timeline-nav');
    const scroller = container.querySelector('.offline-scroll');
    if (!nav || !scroller) return;
    let syncFrame = 0;
    let idleTimer = 0;
    const keepNavigatorVisible = () => {
      nav.classList.remove('is-idle');
      if (idleTimer) window.clearTimeout(idleTimer);
      idleTimer = window.setTimeout(() => {
        idleTimer = 0;
        const mouseHovering = !!window.matchMedia?.('(hover: hover)').matches && nav.matches(':hover');
        const keyboardFocused = !!nav.querySelector(':focus-visible');
        if (!nav.isConnected || mouseHovering || keyboardFocused) return;
        nav.classList.add('is-idle');
      }, 1400);
    };
    const stopFollowingLatest = () => {
      if (!isAdvancing) return;
      followLatestDuringAdvance = false;
      session.uiState = {
        ...(session.uiState || {}),
        scrollTop: scroller.scrollTop,
      };
    };
    scroller.addEventListener('touchstart', stopFollowingLatest, { passive: true });
    scroller.addEventListener('pointerdown', stopFollowingLatest, { passive: true });
    scroller.addEventListener('wheel', stopFollowingLatest, { passive: true });
    scroller.addEventListener('keydown', stopFollowingLatest);
    scroller.addEventListener('scroll', () => {
      keepNavigatorVisible();
      if (syncFrame) return;
      syncFrame = window.requestAnimationFrame(() => {
        syncFrame = 0;
        syncTimelineNavigator();
      });
    }, { passive: true });
    nav.addEventListener('pointerenter', keepNavigatorVisible);
    nav.addEventListener('pointerleave', keepNavigatorVisible);
    nav.addEventListener('focusin', keepNavigatorVisible);
    nav.addEventListener('focusout', keepNavigatorVisible);
    nav.querySelectorAll('[data-timeline-nav]').forEach((button) => {
      button.addEventListener('click', () => {
        keepNavigatorVisible();
        const action = button.getAttribute('data-timeline-nav');
        if (action === 'top') scrollTimelineTo(0);
        else if (action === 'bottom') scrollTimelineTo(Math.max(0, scroller.scrollHeight - scroller.clientHeight));
        else if (action === 'prev') moveTimeline(-1);
        else if (action === 'next') moveTimeline(1);
      });
    });
    timelineClearanceObserver?.disconnect();
    if (typeof ResizeObserver === 'function') {
      timelineClearanceObserver = new ResizeObserver(() => syncTimelineNavigatorClearance());
      timelineClearanceObserver.observe(container);
      timelineClearanceObserver.observe(container.querySelector('.offline-bottom-stack'));
    }
    syncTimelineNavigatorClearance();
    syncTimelineNavigator();
    keepNavigatorVisible();
  }

  function revealRenderedBeat(beatId, { block = 'nearest', smooth = false } = {}) {
    const id = String(beatId || '').trim();
    if (!id) return;
    window.requestAnimationFrame(() => {
      const target = [...container.querySelectorAll('.offline-beat[data-beat-id]')]
        .find((row) => row.getAttribute('data-beat-id') === id);
      if (!target) return;
      const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      target.scrollIntoView({
        behavior: smooth && !reduced ? 'smooth' : 'auto',
        block,
      });
    });
  }

  /**
   * 楼层操作不能继续挤在气泡页脚里：用户 CSS 改窄气泡、放大字号或切换书写
   * 方向时，行内菜单会被一起压成竖排并越出视口。这里把已有按钮克隆到 body
   * 下的独立操作面板；点击后仍转发给原按钮，避免复制任何业务逻辑。
   */
  function openBeatActionLayer(trigger, actions) {
    closeBeatActionLayer?.();
    if (!trigger || !actions) return;

    const layer = document.createElement('div');
    layer.className = 'offline-beat-action-layer';
    layer.innerHTML = `
      <button type="button" class="offline-beat-action-backdrop" data-beat-action-close aria-label="关闭本段操作"></button>
      <section class="offline-beat-action-sheet" role="dialog" aria-modal="true" aria-label="本段操作">
        <div class="offline-beat-action-sheet-head">
          <strong>本段操作</strong>
          <button type="button" data-beat-action-close aria-label="关闭本段操作">${icon('close')}</button>
        </div>
        <div class="offline-beat-action-sheet-list"></div>
        <button type="button" class="offline-beat-action-cancel" data-beat-action-close>取消</button>
      </section>`;

    const actionList = actions.cloneNode(true);
    actionList.hidden = false;
    layer.querySelector('.offline-beat-action-sheet-list')?.appendChild(actionList);

    const pageStyle = window.getComputedStyle(container);
    [
      '--os-paper',
      '--os-ink',
      '--os-ink-2',
      '--os-ink-3',
      '--os-line',
      '--os-accent',
      '--os-accent-soft',
      '--os-sans',
    ].forEach((name) => {
      const value = pageStyle.getPropertyValue(name);
      if (value) layer.style.setProperty(name, value);
    });

    let closed = false;
    const close = ({ restoreFocus = false } = {}) => {
      if (closed) return;
      closed = true;
      layer.remove();
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('hashchange', onRouteLeave);
      window.removeEventListener('pagehide', onRouteLeave);
      trigger.setAttribute('aria-expanded', 'false');
      if (closeBeatActionLayer === close) closeBeatActionLayer = null;
      if (restoreFocus && trigger.isConnected) {
        try { trigger.focus({ preventScroll: true }); } catch (_) { trigger.focus(); }
      }
    };
    const onKeyDown = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      close({ restoreFocus: true });
    };
    const onRouteLeave = () => close();

    layer.addEventListener('click', (event) => {
      const eventTarget = eventTargetElement(event);
      if (!eventTarget) return;
      if (eventTarget.closest('[data-beat-action-close]')) {
        close({ restoreFocus: true });
        return;
      }
      const actionButton = eventTarget.closest('.offline-beat-actions button');
      if (!actionButton || !layer.contains(actionButton)) return;
      const actionClass = [...actionButton.classList]
        .find((name) => name.startsWith('offline-beat-'));
      const originalButton = actionClass ? actions.querySelector(`.${actionClass}`) : null;
      close();
      originalButton?.click();
    });

    document.body.appendChild(layer);
    trigger.setAttribute('aria-expanded', 'true');
    closeBeatActionLayer = close;
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('hashchange', onRouteLeave);
    window.addEventListener('pagehide', onRouteLeave);
    window.requestAnimationFrame(() => {
      const firstAction = layer.querySelector('.offline-beat-actions button');
      if (!firstAction) return;
      try { firstAction.focus({ preventScroll: true }); } catch (_) { firstAction.focus(); }
    });
  }

  function bindAudioStageDialogueControls() {
    container.querySelectorAll('[data-audio-segment-next]').forEach((button) => {
      button.addEventListener('click', advanceAudioStageSegment);
    });
    container.querySelector('[data-audio-segment-prev]')?.addEventListener('click', previousAudioStageSegment);
    container.querySelector('.offline-audio-dialogue [data-audio-reroll]')?.addEventListener('click', () => {
      void onReroll();
    });
    container.querySelector('[data-audio-replay]')?.addEventListener('click', (event) => {
      stopAudioStageForeground();
      primeAudioStagePlaybackGestures(event);
      audioStageSegmentIndex = 0;
      audioStageChoicesOpen = false;
      audioStageAuto = true;
      persistAudioStageState();
      renderOptions([]);
      renderAudioStage();
      void playAudioStageCurrent();
    });
    container.querySelector('[data-audio-autoplay]')?.addEventListener('click', (event) => {
      if (audioStageAuto) {
        audioStageAuto = false;
        stopAudioStageForeground();
        persistAudioStageState();
        renderAudioStage();
        return;
      }
      stopAudioStageForeground();
      primeAudioStagePlaybackGestures(event);
      if (audioStageChoicesOpen) audioStageSegmentIndex = 0;
      audioStageAuto = true;
      audioStageChoicesOpen = false;
      persistAudioStageState();
      renderOptions([]);
      renderAudioStage();
      void playAudioStageCurrent();
    });
    container.querySelectorAll('[data-audio-input-toggle]').forEach((button) => {
      if (button.dataset.audioInputToggleBound === '1') return;
      button.dataset.audioInputToggleBound = '1';
      button.addEventListener('click', () => {
        audioStageInputOpen = !audioStageInputOpen;
        renderAudioStage();
        if (audioStageInputOpen) {
          window.requestAnimationFrame(() => container.querySelector('.offline-audio-input .offline-directive')?.focus());
        }
      });
    });
  }

  function renderAudioStage() {
    if (session?.scene?.audioSceneEnabled !== true) return;
    const current = container.querySelector('.offline-audio-dialogue');
    if (current) current.outerHTML = audioStageDialogueHtml();
    const input = container.querySelector('.offline-audio-input');
    if (input) input.hidden = !audioStageInputOpen;
    bindAudioStageDialogueControls();
  }

  function queueAudioStageStreamRender(fullText = '') {
    const text = String(fullText || '').trim();
    if (!text) return;
    const streamId = String(session?.inFlight?.beatId || 'pending');
    audioStageStreamingBeat = {
      id: `stream:${streamId}`,
      role: 'narration',
      text,
      voiceLines: [],
      voiceSynthesis: { pending: true },
      audioStageActorName: title || '角色',
    };
    if (audioStageStreamFrame) return;
    audioStageStreamFrame = window.requestAnimationFrame(() => {
      audioStageStreamFrame = 0;
      renderAudioStage();
    });
  }

  function clearAudioStageStreamPreview() {
    if (audioStageStreamFrame) {
      window.cancelAnimationFrame(audioStageStreamFrame);
      audioStageStreamFrame = 0;
    }
    audioStageStreamingBeat = null;
  }

  function paintDone() {
    const arc = finishedArchive?.archive;
    container.innerHTML = `
      <header class="navbar">
        <button type="button" class="navbar-btn" data-back aria-label="返回">${icon('back')}</button>
        <h1 class="navbar-title">${esc(title)}</h1>
        <button type="button" class="navbar-btn" data-open-chat aria-label="进入小群聊天">${icon('message')}</button>
      </header>
      <main class="offline-scroll offline-done-scroll">
        <section class="scrapbook-card offline-done-card">
          <div class="offline-done-ribbon">这段旅程结束了</div>
          <h2 class="offline-done-title">${esc(arc?.title || '这次线下已收进记忆')}</h2>
          ${arc?.summary ? `<p class="offline-done-summary">${esc(arc.summary)}</p>` : ''}
          <p class="offline-done-note">当前路线的摘要已写入共同回忆；完整轮次收录在记录里。${arc?.unusedBranches?.length ? `其余 ${arc.unusedBranches.length} 条路线作为未采用路线保留，不会写入角色记忆。` : ''}</p>
          <div class="offline-done-actions">
            ${arc?.id ? `<button type="button" class="btn btn-primary" data-view-archive>查看完整记录</button>` : ''}
            <button type="button" class="btn btn-outline" data-done-back>返回</button>
          </div>
        </section>
      </main>
    `;
    container.querySelector('[data-back]')?.addEventListener('click', () => back());
    container.querySelector('[data-open-chat]')?.addEventListener('click', () => {
      navigate('chat/thread', { chatId });
    });
    container.querySelector('[data-done-back]')?.addEventListener('click', () => back());
    container.querySelector('[data-view-archive]')?.addEventListener('click', () => {
      if (arc?.id) navigate('offline/archive', { id: arc.id });
    });
  }

  function paintEmpty() {
    container.innerHTML = `
      <header class="navbar">
        <button type="button" class="navbar-btn" data-back aria-label="返回">${icon('back')}</button>
        <h1 class="navbar-title">线下</h1>
        <span class="navbar-btn scrapbook-nav-spacer" aria-hidden="true"></span>
      </header>
      <main class="offline-scroll">
        <section class="scrapbook-card offline-empty-state">
          <p>这段对话目前没有进行中的线下。</p>
          <button type="button" class="btn btn-outline" data-open-chat>进入聊天</button>
          <button type="button" class="btn btn-primary" data-go-date>去约线下</button>
        </section>
      </main>
    `;
    container.querySelector('[data-back]')?.addEventListener('click', () => back());
    container.querySelector('[data-open-chat]')?.addEventListener('click', () => navigate('chat/thread', { chatId }));
    container.querySelector('[data-go-date]')?.addEventListener('click', async () => {
      const participantCount = (chat?.participants || []).filter((id) => id && id !== 'user').length;
      const experienceMode = await chooseOfflineExperienceMode({
        allowAudio: participantCount === 1,
        title: '进入线下',
      });
      if (!experienceMode) return;
      navigate(experienceMode === 'audio' ? 'encounter/audio' : 'encounter/date', { chatId });
    });
  }

  function paint() {
    // 已挂载页面生成中时避免整页重建打断流式预览；刷新首挂载即便检测到其它标签页
    // 正在生成，也必须先画出可返回的只读现场，不能把路由加载壳永久留在屏幕上。
    if (isAdvancing && hasPainted) return;
    timelineClearanceObserver?.disconnect();
    timelineClearanceObserver = null;
    if (finishedArchive) {
      paintDone();
      return;
    }
    if (!session) {
      paintEmpty();
      return;
    }
    applyAudioScenePresentation();
    const audioSceneEnabled = session.scene?.audioSceneEnabled === true;
    const observerMode = !isOfflineUserPresent(session, chat);
    container.innerHTML = `
      <header class="navbar${audioSceneEnabled ? ' offline-audio-navbar' : ''}">
        <button type="button" class="navbar-btn" data-back aria-label="返回">${icon('back')}</button>
        <h1 class="navbar-title">${esc(title)}</h1>
        <div class="offline-navbar-actions">
          ${audioSceneEnabled
            ? `<button type="button" class="navbar-btn" data-audio-menu-toggle aria-label="舞台菜单" aria-expanded="${audioStageMenuOpen ? 'true' : 'false'}">${icon('more')}</button>`
            : `<button type="button" class="navbar-btn" data-open-settings aria-label="叙事设置">${icon('menu')}</button>
              <button type="button" class="navbar-btn offline-summarize" aria-label="总结收纳" ${isAdvancing ? 'disabled' : ''}>${icon('check')}</button>`}
        </div>
      </header>
      ${audioSceneEnabled ? audioStageShellHtml() : `
        <main class="offline-scroll">
          ${!isTrip ? anchorStripHtml(session, anchorWorldTs) : ''}
          ${originSeedHtml(session.originSeed)}
          ${!session.settingsHintSeen && !session.beats.some((b) => b.role === 'narration') ? settingsHintHtml(!observerMode) : ''}
          <section class="scrapbook-card offline-scene-card">
            <button type="button" class="offline-scene-head" data-toggle-scene>
              <span class="offline-scene-label">场景</span>
              <span class="offline-scene-summary">${sceneSummaryHtml(session.scene, session.originSeed, !!session.attendance)}</span>
              <span class="offline-scene-caret">${sceneOpen ? '收起' : '编辑'}</span>
            </button>
            <div class="offline-scene-body" ${sceneOpen ? '' : 'hidden'}>
              ${sceneContentFieldsHtml(session.scene, session.originSeed, !!session.attendance, !observerMode)}
              <button type="button" class="btn btn-outline btn-sm off-scene-save">保存场景</button>
            </div>
          </section>
          ${tripProgressHtml(session.scene)}
          <section class="offline-beats${manageMode ? ' is-managing' : ''}">${beatsHtml(session, beatsView())}</section>
          ${tripCheckpointHtml(session)}
        </main>
        ${!isTrip ? timelineNavigatorHtml() : ''}
        <div class="os-manage-bar" ${manageMode ? '' : 'hidden'}>
          <span class="os-manage-count">已选 ${selectedBeats.size} 条</span>
          <button type="button" class="os-manage-btn" data-manage-all>全选</button>
          <button type="button" class="os-manage-btn" data-manage-favorite>收藏所选</button>
          <button type="button" class="os-manage-btn os-manage-btn--danger" data-manage-delete>删除所选</button>
          <button type="button" class="os-manage-btn" data-manage-done>完成</button>
        </div>
        <div class="offline-bottom-stack">
          <div class="offline-options" hidden></div>
          <div class="offline-tools" hidden>
            <button type="button" class="offline-tool" data-tool="options">${icon('sparkle')}<span>走向选项</span><em class="offline-tool-state">${session.scene?.optionCards ? '开' : '关'}</em></button>
            ${getActiveOfflineParticipantIds(session, chat).length > 1 ? `<button type="button" class="offline-tool" data-tool="ensemble">${icon('select')}<span>自然群像</span><em class="offline-tool-state">${session.scene?.naturalEnsemble ? '开' : '关'}</em></button>` : ''}
            <button type="button" class="offline-tool offline-reroll" data-tool="reroll">${icon('reroll')}<span>重 roll 上一轮</span></button>
            ${session.scene?.retainRerollVersions === true ? (() => {
              const last = [...(session.beats || [])].reverse().find((beat) => beat?.role === 'narration');
              const count = last ? listOfflineRerollVersions(session, last.id).versions.length : 0;
              return count > 1 ? `<button type="button" class="offline-tool" data-tool="versions">${icon('time')}<span>本轮版本</span><em class="offline-tool-state">${count}</em></button>` : '';
            })() : ''}
            <button type="button" class="offline-tool" data-tool="guidance">${icon('book')}<span>写作指导</span><em class="offline-tool-state">${session.scene?.guidancePrompt ? '本场' : '未启用'}</em></button>
            <button type="button" class="offline-tool offline-stop" data-tool="stop" ${isAdvancing ? '' : 'disabled'}>${icon('stop')}<span>终止 AI 输出</span></button>
            <button type="button" class="offline-tool" data-tool="addChar">${icon('plus')}<span>现场成员</span></button>
            <button type="button" class="offline-tool" data-open-chat>${icon('message')}<span>本场聊天</span></button>
            ${observerMode ? '' : `<button type="button" class="offline-tool" data-tool="phone">${icon('smartphone')}<span>掏出手机</span></button>
            <button type="button" class="offline-tool" data-tool="autoReply">${icon('message')}<span>消息与代答</span><em class="offline-tool-state">${autoReplyModeLabel(session.autoReply?.mode || globalAutoReply.mode)}</em></button>`}
            <button type="button" class="offline-tool" data-tool="routes">${icon('menu')}<span>路线</span><em class="offline-tool-state">${ensureOfflineBranching(session).branches.length}</em></button>
            <button type="button" class="offline-tool" data-tool="manage">${icon('select')}<span>管理历史</span></button>
            ${!isTrip ? `<button type="button" class="offline-tool" data-tool="beautify">${icon('palette')}<span>美化界面</span></button>` : ''}
          </div>
          ${generationWaitNoticeHtml()}
          <footer class="offline-bar">
            <button type="button" class="offline-plus" aria-label="工具栏" aria-expanded="false">${icon('plus')}</button>
            <div class="offline-input-wrap">
              <textarea class="form-input offline-directive" rows="1" placeholder="${observerMode ? '想看的下一幕……' : '接下来……（回车换行）'}" aria-label="本轮方向">${esc(session.uiState?.directiveDraft || '')}</textarea>
              <button type="button" class="offline-directive-clear" data-clear-directive aria-label="清空本轮方向" ${session.uiState?.directiveDraft ? '' : 'hidden'}>${icon('close')}</button>
              <button type="button" class="offline-expand" aria-label="展开输入">${icon('expand')}</button>
            </div>
            ${isAdvancing
              ? `<button type="button" id="offline-generation-action" class="btn btn-primary offline-advance offline-stop-primary" aria-label="终止 AI 输出">${generationPrimaryActionContent(true)}</button>`
              : `<button type="button" id="offline-generation-action" class="btn btn-primary offline-advance" aria-label="推进">${generationPrimaryActionContent(false)}</button>`}
          </footer>
        </div>`}
    `;
    hasPainted = true;

    container.querySelector('[data-back]')?.addEventListener('click', () => openOfflineLeaveModal());
    container.querySelector('[data-audio-menu-toggle]')?.addEventListener('click', (event) => {
      audioStageMenuOpen = !audioStageMenuOpen;
      const menu = container.querySelector('.offline-audio-menu');
      if (menu) menu.hidden = !audioStageMenuOpen;
      event.currentTarget?.setAttribute('aria-expanded', audioStageMenuOpen ? 'true' : 'false');
    });
    container.querySelector('[data-open-chat]')?.addEventListener('click', () => {
      navigate('chat/thread', { chatId, offlineChatId: chatId });
    });

    container.querySelector('[data-toggle-scene]')?.addEventListener('click', () => {
      sceneOpen = !sceneOpen;
      const body = container.querySelector('.offline-scene-body');
      const caret = container.querySelector('.offline-scene-caret');
      if (body) body.hidden = !sceneOpen;
      if (caret) caret.textContent = sceneOpen ? '收起' : '编辑';
    });
    container.querySelector('[data-open-settings]')?.addEventListener('click', () => openSettingsSheet());
    const audioBackgroundFile = container.querySelector('[data-audio-background-file]');
    container.querySelector('[data-audio-background-upload]')?.addEventListener('click', () => audioBackgroundFile?.click());
    audioBackgroundFile?.addEventListener('change', async () => {
      const file = audioBackgroundFile.files?.[0];
      if (!file || !session) return;
      releaseAudioStagePendingBackground();
      try {
        audioStagePendingBackgroundUrl = URL.createObjectURL(file);
      } catch (_) {
        audioStagePendingBackgroundUrl = '';
      }
      audioStageMenuOpen = false;
      const menu = container.querySelector('.offline-audio-menu');
      if (menu) menu.hidden = true;
      applyAudioScenePresentation();
      try {
        const background = await readBgImageFile(file);
        session.scene = createSceneDraft({
          ...(session.scene || {}),
          audioSceneBackground: background,
          audioSceneBackgroundName: file.name,
          audioSceneBackgroundUpdatedAt: Date.now(),
        });
        releaseAudioStagePendingBackground();
        applyAudioScenePresentation();
        paint();
        await saveOfflineSession(session);
        showToast('音声场景背景已更新');
      } catch (err) {
        releaseAudioStagePendingBackground();
        applyAudioScenePresentation();
        showToast(`背景读取失败：${err?.message || err}`);
      }
    });
    container.querySelector('[data-audio-background-clear]')?.addEventListener('click', async () => {
      if (!session) return;
      releaseAudioStagePendingBackground();
      session.scene = createSceneDraft({
        ...(session.scene || {}),
        audioSceneBackground: '',
        audioSceneBackgroundName: '',
        audioSceneBackgroundUpdatedAt: 0,
      });
      applyAudioScenePresentation();
      paint();
      await saveOfflineSession(session);
    });
    container.querySelector('[data-audio-history]')?.addEventListener('click', openAudioSceneHistory);
    container.querySelector('[data-audio-versions]')?.addEventListener('click', () => {
      audioStageMenuOpen = false;
      openRerollVersionsSheet();
    });
    container.querySelector('.offline-audio-menu [data-audio-reroll]')?.addEventListener('click', () => {
      audioStageMenuOpen = false;
      const menu = container.querySelector('.offline-audio-menu');
      if (menu) menu.hidden = true;
      void onReroll();
    });
    container.querySelector('[data-audio-style]')?.addEventListener('click', () => {
      audioStageMenuOpen = false;
      openAudioStageStyleSheet();
    });
    container.querySelector('[data-audio-change-scene]')?.addEventListener('click', () => {
      const beat = [...(session?.beats || [])].reverse().find((row) => row?.role === 'narration');
      if (!beat) {
        showToast('先推进一轮，再按当前画面生图换景');
        return;
      }
      onGenerateBeatImage(beat.id, { useAsAudioBackground: true });
    });
    container.querySelector('[data-audio-layout-toggle]')?.addEventListener('click', async () => {
      if (!session) return;
      session.scene = createSceneDraft({
        ...(session.scene || {}),
        audioSceneLayout: session.scene?.audioSceneLayout === 'landscape' ? 'portrait' : 'landscape',
      });
      await saveOfflineSession(session);
      paint();
    });
    container.querySelector('.off-query-place')?.addEventListener('click', onQueryPlaceInline);
    container.querySelector('[data-hint-open]')?.addEventListener('click', onOpenSettingsHint);
    container.querySelector('[data-hint-close]')?.addEventListener('click', () => dismissSettingsHint(false));
    container.querySelector('.off-scene-save')?.addEventListener('click', onSaveScene);
    container.querySelector('.off-advance-day')?.addEventListener('click', onAdvanceDay);
    container.querySelector('[data-trip-replan]')?.addEventListener('click', onReplanTrip);
    container.querySelectorAll('[data-checkpoint-opt]').forEach((optBtn) => {
      optBtn.addEventListener('click', () => onResolveCheckpoint(optBtn.getAttribute('data-checkpoint-opt')));
    });
    container.querySelector('.offline-advance')?.addEventListener('click', (event) => {
      if (isAdvancing) onStopAdvance();
      else onAdvance(event);
    });
    container.querySelector('[data-offline-wait-stop]')?.addEventListener('click', onStopAdvance);
    container.querySelector('.offline-expand')?.addEventListener('click', openExpandEditor);
    container.querySelector('[data-clear-directive]')?.addEventListener('click', () => {
      selectedOptionChoices = [];
      renderOptionsFromSession();
      setDirectiveDraft('', { focus: true });
    });
    const toolsEl = container.querySelector('.offline-tools');
    const toolsToggle = container.querySelector('.offline-plus');
    toolsToggle?.addEventListener('click', () => {
      if (!toolsEl) return;
      const opening = toolsEl.hidden;
      const directiveInput = container.querySelector('.offline-directive');
      if (opening && document.activeElement === directiveInput) directiveInput.blur();
      toolsEl.hidden = !opening;
      const timelineNav = container.querySelector('.os-timeline-nav');
      if (timelineNav) timelineNav.hidden = opening;
      toolsToggle.setAttribute('aria-expanded', opening ? 'true' : 'false');
    });
    container.querySelectorAll('.offline-tool').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tool = btn.getAttribute('data-tool');
        // 终止时先留着工具栏，避免收起瞬间窄宽重排把「终止 AI 输出」挤成竖排字
        if (tool !== 'stop' && toolsEl) {
          toolsEl.hidden = true;
          const timelineNav = container.querySelector('.os-timeline-nav');
          if (timelineNav) timelineNav.hidden = false;
        }
        if (tool === 'reroll') onReroll();
        else if (tool === 'versions') openRerollVersionsSheet();
        else if (tool === 'stop') onStopAdvance();
        else if (tool === 'options') toggleOptionCards();
        else if (tool === 'ensemble') toggleNaturalEnsemble();
        else if (tool === 'guidance') {
          const beat = [...(session?.beats || [])].reverse().find((row) => row?.role === 'narration');
          if (beat) openGuidedRevisionSheet(beat.id);
          else showToast('先推进一轮，再根据实际文本整理写作指导');
        }
        else if (tool === 'addChar') openAddParticipantModal();
        else if (tool === 'phone') openPhoneSideTrip();
        else if (tool === 'autoReply') openAutoReplySheet();
        else if (tool === 'routes') openRoutesSheet();
        else if (tool === 'manage') setManageMode(true);
        else if (tool === 'beautify') openStyleSheet();
      });
    });
    container.querySelector('[data-manage-all]')?.addEventListener('click', () => {
      const pickable = (session?.beats || []).filter((b) => b.role !== 'daymark').map((b) => b.id);
      selectedBeats = selectedBeats.size >= pickable.length ? new Set() : new Set(pickable);
      renderBeats();
      syncManageBar();
    });
    container.querySelector('[data-manage-delete]')?.addEventListener('click', onBatchDeleteBeats);
    container.querySelector('[data-manage-favorite]')?.addEventListener('click', onBatchFavoriteBeats);
    container.querySelector('[data-manage-done]')?.addEventListener('click', () => setManageMode(false));
    container.querySelector('.offline-summarize')?.addEventListener('click', () => onSummarize());
    const directiveInput = container.querySelector('.offline-directive');
    directiveInput?.addEventListener('keydown', (e) => {
      // 回车换行分段；Ctrl/Cmd+Enter 仍可快捷推进
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        onAdvance();
      }
    });
    directiveInput?.addEventListener('input', (e) => {
      if (!session) return;
      session.uiState = { ...(session.uiState || {}), directiveDraft: String(e.target?.value || '') };
      syncDirectiveClearButton(e.target);
      if (e.isComposing) return;
      syncDirectiveTextareaHeight(e.target);
    });
    directiveInput?.addEventListener('compositionend', (e) => {
      syncDirectiveTextareaHeight(e.target);
    });
    syncDirectiveTextareaHeight(directiveInput);
    syncDirectiveClearButton(directiveInput);
    if (audioSceneEnabled) bindAudioStageDialogueControls();
    bindNarrationTranslationToggle(container);
    const savedScroll = Number(session.uiState?.scrollTop);
    if (Number.isFinite(savedScroll) && savedScroll > 0) {
      const scroller = container.querySelector('.offline-scroll');
      if (scroller) scroller.scrollTop = savedScroll;
    } else {
      scrollToBottom();
    }
    bindTimelineNavigator();
    renderOptionsFromSession();
    bindBeatEdits();
    bindBeatDeleteHandler();
  }

  function bindBeatDeleteHandler() {
    if (unbindBeatDelete) unbindBeatDelete();
    unbindBeatDelete = bindOfflineBeatDelete(container, {
      isDeletable: (beatId) => {
        if (manageMode) return false;
        const beat = session?.beats?.find((b) => b.id === beatId);
        return !!beat && beat.role !== 'daymark';
      },
      onDelete: onDeleteBeat,
    });
  }

  function setManageMode(on) {
    manageMode = !!on;
    if (!manageMode) selectedBeats = new Set();
    const bar = container.querySelector('.os-manage-bar');
    if (bar) bar.hidden = !manageMode;
    renderBeats();
    syncManageBar();
  }

  function syncManageBar() {
    const count = container.querySelector('.os-manage-count');
    if (count) count.textContent = `已选 ${selectedBeats.size} 条`;
    const delBtn = container.querySelector('[data-manage-delete]');
    if (delBtn) delBtn.disabled = !selectedBeats.size;
    const favoriteBtn = container.querySelector('[data-manage-favorite]');
    if (favoriteBtn) favoriteBtn.disabled = !selectedBeats.size;
  }

  function openOfflineFavoriteEditor(beats, label = '收藏线下片段') {
    const rows = (Array.isArray(beats) ? beats : []).filter(Boolean);
    if (!session || !rows.length) {
      showToast('请先选择片段');
      return;
    }
    openTextEditorModal({
      title: label,
      placeholder: '备注（可不填）',
      confirmLabel: '收藏',
      onSave: async (note) => {
        try {
          await saveOfflineFavorite({
            userId: user.id,
            session,
            beats: rows,
            characterIds: getActiveOfflineParticipantIds(session, chat),
            title,
            note,
          });
          if (manageMode) setManageMode(false);
          showToast('已收藏到对应角色的记忆馆');
        } catch (err) {
          showToast(err?.message || '收藏失败');
        }
      },
    });
  }

  function onBatchFavoriteBeats() {
    const rows = (session?.beats || []).filter((beat) => selectedBeats.has(beat.id));
    openOfflineFavoriteEditor(rows, `收藏 ${rows.length} 条线下片段`);
  }

  async function onBatchDeleteBeats() {
    if (!session || !selectedBeats.size) return;
    if (!window.confirm(`删除所选的 ${selectedBeats.size} 条记录？删除叙事时会连同那轮你给的方向一起删。`)) return;
    // 从后往前删，避免 deleteOfflineBeat 连带删除前一条 directive 时打乱未处理的索引
    const selectedIds = session.beats.filter((b) => selectedBeats.has(b.id)).map((b) => b.id);
    const anchorBeatId = resolveOfflineBeatAnchorAfterRemoval(session.beats, selectedIds);
    const ids = [...selectedIds].reverse();
    let removed = 0;
    for (const id of ids) {
      const targetBeat = session.beats.find((b) => b.id === id);
      if (!targetBeat) continue;
      if (targetBeat.role === 'narration') {
        await rollbackOfflinePhoneActionsForBeat(targetBeat, session.id).catch(() => {});
      }
      const { ok } = deleteOfflineBeat(session, id);
      if (ok) removed += 1;
    }
    selectedBeats = new Set();
    await saveOfflineSession(session, { allowShrink: true });
    renderBeats();
    revealRenderedBeat(anchorBeatId);
    syncManageBar();
    renderOptionsFromSession();
    showToast(removed ? `已删除 ${removed} 条` : '没有可删除的记录');
  }

  async function onDeleteBeat(beatId) {
    if (!session || !beatId) return;
    const beat = session.beats.find((b) => b.id === beatId);
    if (!beat || beat.role === 'daymark') return;
    const label = beat.role === 'opening' ? '开场白' : (beat.role === 'directive'
      ? (isOfflineUserPresent(session, chat) ? '你的方向' : '旁观方向')
      : '这段叙事');
    if (!window.confirm(`删除这条${label}？`)) return;
    if (beat.role === 'narration') {
      await rollbackOfflinePhoneActionsForBeat(beat, session.id).catch(() => {});
    }
    const anchorBeatId = resolveOfflineBeatAnchorAfterRemoval(session.beats, beatId);
    const { ok } = deleteOfflineBeat(session, beatId);
    if (!ok) { showToast('无法删除'); return; }
    await saveOfflineSession(session, { allowShrink: true });
    renderBeats();
    revealRenderedBeat(anchorBeatId);
    renderOptionsFromSession();
    showToast('已删除');
  }

  async function openOfflineThoughtPopover(beatId, characterId) {
    const beat = session?.beats?.find((row) => String(row?.id || '') === String(beatId || ''));
    const state = beat?.characterStates?.[characterId];
    if (!state) return;
    const character = await getCharacter(characterId, {
      userId: user?.id || session?.userId || '',
    }).catch(() => null);
    const charKey = String(characterId || '').trim();
    const currentBeatId = String(beat.id || '').trim();

    const patchOfflineCharState = async (targetBeatId, patch = {}) => {
      const target = session?.beats?.find((row) => String(row?.id || '') === String(targetBeatId || ''));
      if (!target?.characterStates?.[charKey]) return null;
      const prev = target.characterStates[charKey];
      const next = {
        ...prev,
        inner: String(patch.inner ?? prev.inner ?? '').trim(),
        innerTranslation: String(patch.innerTranslation ?? prev.innerTranslation ?? '').trim(),
        intent: String(patch.intent ?? prev.intent ?? '').trim(),
        mood: String(patch.mood ?? prev.mood ?? '').trim(),
        status: String(patch.status ?? prev.status ?? '').trim(),
        moodValue: Number.isFinite(Number(patch.moodValue))
          ? Math.max(0, Math.min(100, Math.round(Number(patch.moodValue))))
          : prev.moodValue,
        name: String(prev.name || character?.customNickname || character?.name || 'TA').trim(),
        recordedAt: Number(prev.recordedAt || target.ts || Date.now()) || Date.now(),
      };
      target.characterStates = {
        ...target.characterStates,
        [charKey]: next,
      };
      await saveOfflineSession(session);
      return next;
    };

    openCharStatePopover({
      name: resolveOfflineCharacterStateDisplayName(
        characterId,
        state.name,
        character?.customNickname || character?.name || character?.realName,
      ),
      inner: state.inner || '',
      innerTranslation: state.innerTranslation || '',
      intent: state.intent || '',
      mood: state.mood || '',
      status: state.status || '',
      moodValue: state.moodValue,
      chatId,
      characterId,
      avatarUrl: character?.avatar || '',
      card: resolveOfflineInnerVoiceCard(stylePrefs, chat, 'diary'),
      historyItems: offlineCharacterStateHistory(session, characterId, beat.id),
      historyDeletable: false,
      onSaveCurrent: async (patch) => patchOfflineCharState(currentBeatId, patch),
      onSaveHistory: async (entryId, patch) => {
        const raw = String(entryId || '');
        const fromList = offlineCharacterStateHistory(session, charKey, currentBeatId)
          .find((row) => row && String(row.id || '') === raw);
        const sourceBeatId = String(fromList?.beatId || '').trim();
        if (!sourceBeatId) return null;
        const saved = await patchOfflineCharState(sourceBeatId, patch);
        return saved
          ? { id: raw, beatId: sourceBeatId, ...saved, charId: charKey }
          : null;
      },
    });
  }

  function bindBeatEdits() {
    if (beatEditBound) return;
    beatEditBound = true;
    container.addEventListener('change', (e) => {
      const pick = e.target.closest?.('[data-beat-pick]');
      if (!pick || !container.contains(pick)) return;
      const id = pick.getAttribute('data-beat-pick');
      if (!id) return;
      if (pick.checked) selectedBeats.add(id);
      else selectedBeats.delete(id);
      syncManageBar();
    });
    container.addEventListener('click', (e) => {
      const eventTarget = eventTargetElement(e);
      if (!eventTarget) return;
      const thoughtBtn = eventTarget.closest('[data-offline-thought]');
      if (thoughtBtn && container.contains(thoughtBtn)) {
        const characterId = String(thoughtBtn.getAttribute('data-offline-thought') || '');
        const beatId = String(thoughtBtn.getAttribute('data-thought-beat') || '');
        openOfflineThoughtPopover(beatId, characterId).catch(() => showToast('心声暂时无法打开'));
        return;
      }
      const noticeBtn = eventTarget.closest('[data-interlude-chat]');
      if (noticeBtn && container.contains(noticeBtn)) {
        const targetChatId = String(noticeBtn.getAttribute('data-interlude-chat') || '');
        if (targetChatId) {
          const phoneViewerId = String(noticeBtn.getAttribute('data-phone-viewer') || '');
          clearLeaveGuard();
          invalidateKeepAlive('chat/thread', { chatId: targetChatId });
          navigate('chat/thread', {
            chatId: targetChatId,
            offlineChatId: chatId,
            ...(phoneViewerId ? { viewer: phoneViewerId, from: 'phone' } : {}),
          });
        }
        return;
      }
      const menuBtn = eventTarget.closest('[data-beat-menu]');
      if (menuBtn && container.contains(menuBtn)) {
        const footer = menuBtn.closest('.os-beat-footer');
        const actions = footer?.querySelector('.offline-beat-actions');
        if (!actions) return;
        if (menuBtn.getAttribute('aria-expanded') === 'true') {
          closeBeatActionLayer?.({ restoreFocus: true });
          return;
        }
        openBeatActionLayer(menuBtn, actions);
        return;
      }
      const expandBtn = eventTarget.closest('[data-history-expand]');
      if (expandBtn && container.contains(expandBtn)) {
        historyExpanded = true;
        const scroller = container.querySelector('.offline-scroll');
        const prevHeight = scroller ? scroller.scrollHeight : 0;
        renderBeats();
        // 展开后保持视口停在原来看到的位置，不跳回顶部
        if (scroller) scroller.scrollTop += scroller.scrollHeight - prevHeight;
        return;
      }
      const rerollBtn = eventTarget.closest('[data-beat-reroll]');
      if (rerollBtn && container.contains(rerollBtn)) {
        onReroll();
        return;
      }
      const continueBtn = eventTarget.closest('[data-beat-continue]');
      if (continueBtn && container.contains(continueBtn)) {
        const beatId = String(continueBtn.getAttribute('data-beat-continue') || '');
        runAdvance({ continuation: { beatId } });
        return;
      }
      const auditRerollBtn = eventTarget.closest('[data-beat-audit-reroll]');
      if (auditRerollBtn && container.contains(auditRerollBtn)) {
        onSupplementalAuditReroll(auditRerollBtn.getAttribute('data-beat-audit-reroll'));
        return;
      }
      const expertBtn = eventTarget.closest('[data-beat-expert]');
      if (expertBtn && container.contains(expertBtn)) {
        openExpertConsultationSheet(expertBtn.getAttribute('data-beat-expert'));
        return;
      }
      const supplementThoughtsBtn = eventTarget.closest('[data-beat-supplement-thoughts]');
      if (supplementThoughtsBtn && container.contains(supplementThoughtsBtn)) {
        openMissingThoughtsSheet(supplementThoughtsBtn.getAttribute('data-beat-supplement-thoughts'));
        return;
      }
      const reviseBtn = eventTarget.closest('[data-beat-revise]');
      if (reviseBtn && container.contains(reviseBtn)) {
        openGuidedRevisionSheet(reviseBtn.getAttribute('data-beat-revise'));
        return;
      }
      const bookmarkBtn = eventTarget.closest('[data-beat-bookmark]');
      if (bookmarkBtn && container.contains(bookmarkBtn)) {
        openBookmarkEditor(bookmarkBtn.getAttribute('data-beat-bookmark'));
        return;
      }
      const favoriteBtn = eventTarget.closest('[data-beat-favorite]');
      if (favoriteBtn && container.contains(favoriteBtn)) {
        const beat = session?.beats?.find((row) => row.id === favoriteBtn.getAttribute('data-beat-favorite'));
        openOfflineFavoriteEditor(beat ? [beat] : []);
        return;
      }
      const forkBtn = eventTarget.closest('[data-beat-fork]');
      if (forkBtn && container.contains(forkBtn)) {
        openForkEditor(forkBtn.getAttribute('data-beat-fork'));
        return;
      }
      const editBtn = eventTarget.closest('[data-beat-edit]');
      if (editBtn && container.contains(editBtn)) {
        const beatId = editBtn.getAttribute('data-beat-edit');
        const beat = session?.beats?.find((b) => b.id === beatId);
        if (!beat || (beat.role !== 'narration' && beat.role !== 'opening' && beat.role !== 'directive')) return;
        const titleMap = { opening: '编辑开场白', directive: '编辑你的方向' };
        const placeholderMap = {
          opening: '修改后保存将覆盖开场白',
          directive: '修改后保存将覆盖这一轮你给的方向',
        };
        const editorialAudits = Array.isArray(beat.editorialAudits)
          ? beat.editorialAudits.map((row) => String(row || '').trim()).filter(Boolean)
          : [];
        const editorialAuditWarnings = editorialAudits.flatMap((row, index) => (
          inspectNarrationEditorialAudit(row, {
            userName: user?.name || '',
            blockUserSpeech: session?.scene?.blockUserSpeech !== false,
          }).map((warning) => `第 ${index + 1} 段：${warning}`)
        ));
        const editorialStatus = editorialAudits.length
          ? [
            ...(editorialAuditWarnings.length
              ? [`【本地硬格式核验：发现 ${editorialAuditWarnings.length} 项漏检】\n${editorialAuditWarnings.map((row) => `- ${row}`).join('\n')}\n本地核验只检查可机械识别项，不代表人物、事实与物理逻辑已经通过。`]
              : ['【本地硬格式核验：未命中机械规则】\n这里只检查固定句式与审稿格式，不代表人物、事实与物理逻辑已经通过。']),
            ...editorialAudits.map((row, index) => `【第 ${index + 1} 段】\n${row}`),
          ].join('\n\n')
          : (beat.editorialAuditRequested === true
            ? '本轮已要求模型执行编辑审稿，但返回中没有可识别的 editorial-audit 记录。模型可能没有遵守格式，定稿正文仍已正常保存。'
            : (beat.editorialAuditRequested === false
              ? '本轮生成时没有启用编辑审稿。'
              : '本轮没有保存到编辑审稿记录；旧楼层未记录当时是否启用了编辑审稿。'));
        openTextEditorModal({
          title: titleMap[beat.role] || '编辑本轮叙事',
          value: beat.text || '',
          placeholder: placeholderMap[beat.role] || '修改后保存将覆盖本轮文本',
          confirmLabel: '保存',
          details: beat.role === 'narration' ? [{
            summary: editorialAudits.length
              ? `编辑审稿记录 · ${editorialAudits.length} 段`
              : '编辑审稿状态',
            content: editorialStatus,
            open: editorialAudits.length > 0 || beat.editorialAuditRequested === true,
          }] : [],
          onSave: async (next) => {
            if (beat.role !== 'directive' && !next) { showToast('内容不能为空'); return; }
            const edited = editOfflineBeatText(session, beatId, next);
            if (!edited.ok) {
              showToast(edited.reason === 'empty_text' ? '内容不能为空' : '这条内容已经无法编辑');
              return;
            }
            await saveOfflineSession(session);
            renderBeats();
            showToast('已保存，后续会按编辑后的内容继续');
          },
        });
        return;
      }
      const imageBtn = eventTarget.closest('[data-beat-image]');
      if (imageBtn && container.contains(imageBtn)) {
        onGenerateBeatImage(imageBtn.getAttribute('data-beat-image'));
        return;
      }
      const imageClearBtn = eventTarget.closest('[data-beat-image-clear]');
      if (imageClearBtn && container.contains(imageClearBtn)) {
        onClearBeatImage(imageClearBtn.getAttribute('data-beat-image-clear'));
        return;
      }
      const imageView = eventTarget.closest('[data-beat-image-view]');
      if (imageView && container.contains(imageView)) {
        onViewBeatImage(imageView.getAttribute('data-beat-image-view'));
        return;
      }
      const imageSave = eventTarget.closest('[data-beat-image-save]');
      if (imageSave && container.contains(imageSave)) {
        onSaveBeatImage(imageSave.getAttribute('data-beat-image-save'), imageSave);
      }
    });
  }

  function onViewBeatImage(beatId) {
    const beat = session?.beats?.find((b) => b.id === beatId);
    if (!beat?.image?.url) return;
    openImageLightbox(beat.image.url, {
      save: { filename: `offline-scene-${beatId}.png` },
      onEditPrompt: () => onGenerateBeatImage(beatId),
      onReroll: async () => {
        await generateOfflineBeatImage({ session, chat, user, beatId });
        renderBeats();
        return session.beats.find((b) => b.id === beatId)?.image?.url || '';
      },
    });
  }

  async function onSaveBeatImage(beatId, button) {
    const beat = session?.beats?.find((row) => row.id === beatId);
    if (!beat?.image?.url || button?.disabled) return;
    if (button) button.disabled = true;
    try {
      const result = await saveImageSrc(beat.image.url, { filename: `offline-scene-${beatId}.png` });
      showToast(describeImageSaveResult(result));
    } catch (error) {
      showToast(error?.message || '图片保存失败');
    } finally {
      if (button) button.disabled = false;
    }
  }

  async function onClearBeatImage(beatId) {
    const beat = session?.beats?.find((row) => row.id === beatId);
    if (!beat?.image) return;
    const hadImage = !!beat.image.url;
    const label = hadImage ? '删除这张场景图？' : '清除这条生图失败记录？';
    if (!window.confirm(label)) return;
    const result = clearOfflineBeatImage(session, beatId);
    if (!result.ok) {
      showToast('图片记录已经不存在');
      return;
    }
    await saveOfflineSession(session);
    renderBeats();
    showToast(hadImage ? '图片已删除' : '失败记录已清除');
  }

  function onGenerateBeatImage(beatId, { useAsAudioBackground = false } = {}) {
    const beat = session?.beats?.find((b) => b.id === beatId);
    if (!beat) return;
    const currentPrompt = resolveOfflineBeatImagePrompt(beat, session.scene?.imageGenMode);
    openTextEditorModal({
      title: currentPrompt ? '编辑场景图提示词' : '生成场景图',
      value: currentPrompt,
      placeholder: '描述想要的画面；留空会按场景和本轮内容重新组织',
      confirmLabel: beat.image?.url ? '重新生成' : '生成',
      onSave: async (promptOverride) => {
        const btn = container.querySelector(`[data-beat-image="${beatId}"]`);
        const notice = beginLongTaskNotice({
          title: '线下场景图已生成',
          body: '新画面已经准备好了',
          tag: `offline-image-${chatId}-${beatId}`,
          isStillViewing: () => container.isConnected,
        });
        if (btn) { btn.disabled = true; btn.textContent = '生成中…'; }
        try {
          await generateOfflineBeatImage({ session, chat, user, beatId, promptOverride });
          if (useAsAudioBackground) {
            session.scene = createSceneDraft({
              ...(session.scene || {}),
              audioSceneBackground: '',
              audioSceneBackgroundName: '',
              audioSceneBackgroundUpdatedAt: 0,
            });
            releaseAudioStagePendingBackground();
            applyAudioScenePresentation();
            paint();
            await saveOfflineSession(session);
          }
          void notice.complete();
          if (!useAsAudioBackground) renderBeats();
          showToast('已生成场景图');
        } catch (err) {
          notice.cancel();
          showToast(`失败：${err?.message || err}`);
          if (btn) { btn.disabled = false; btn.textContent = beat.image?.url ? '换一张' : '生成场景图'; }
        }
      },
    });
  }

  function refreshPresetSelect(selectedId = '') {
    const sheet = container.querySelector('.offline-settings-sheet');
    refreshScenePresetSelect(sheet || container, scenePresets, selectedId);
  }

  function closeSettingsSheet() {
    settingsSheetOpen = false;
    guidanceDiscussionOpen = false;
    container.querySelector('.offline-settings-sheet')?.remove();
  }

  function revisionHistoryHtml(beatId) {
    if (session?.scene?.retainRerollVersions === true) {
      const set = listOfflineRerollVersions(session, beatId);
      return set.versions.length > 1
        ? `<button type="button" class="btn btn-outline btn-block" data-open-reroll-versions>选择已保留的 ${set.versions.length} 个版本</button>`
        : '';
    }
    const rows = (Array.isArray(session?.revisions) ? session.revisions : [])
      .filter((row) => row?.beatId === beatId && row?.originalText && row?.newText)
      .slice(-5)
      .reverse();
    if (!rows.length) return '';
    return `
      <details class="os-revision-history">
        <summary>版本记录 <span>${rows.length}</span></summary>
        <div class="os-revision-history-list">
          ${rows.map((row) => `
            <article class="os-revision-version">
              <header><time>${esc(new Date(Number(row.ts || 0) || Date.now()).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }))}</time><span>${esc(row.requirement || '重修')}</span></header>
              <div class="os-revision-compare">
                <details><summary>修改前</summary><p>${esc(row.originalText)}</p></details>
                <details><summary>修改后</summary><p>${esc(row.newText)}</p></details>
              </div>
              <button type="button" class="os-revision-restore" data-revision-restore="${esc(row.id)}">恢复修改前</button>
            </article>`).join('')}
        </div>
      </details>`;
  }

  function openMissingThoughtsSheet(beatId = '') {
    const target = [...(session?.beats || [])].reverse().find((beat) => beat?.role === 'narration');
    if (!target || String(target.id || '') !== String(beatId || '')) {
      showToast('只能处理当前最后一层');
      return;
    }
    if (isAdvancing) {
      showToast('正在生成，请先停止输出');
      return;
    }
    const missingIds = missingOfflineCharacterStateIds(
      target,
      getActiveOfflineParticipantIds(session, chat),
    );
    if (!missingIds.length) {
      showToast('这一层的心声已经齐了');
      renderBeats();
      return;
    }
    closeSettingsSheet();
    const sheet = document.createElement('div');
    sheet.className = 'offline-settings-sheet os-thought-recovery-sheet';
    sheet.innerHTML = `
      <div class="offline-settings-sheet-backdrop" data-thought-recovery-close></div>
      <div class="offline-settings-sheet-panel" role="dialog" aria-modal="true" aria-labelledby="os-thought-recovery-title">
        <header class="offline-settings-sheet-head">
          <h2 id="os-thought-recovery-title">这一层缺少心声</h2>
          <button type="button" class="navbar-btn" data-thought-recovery-close aria-label="关闭">${icon('close')}</button>
        </header>
        <div class="offline-settings-sheet-body">
          <div class="os-recovery-choice-list">
            <button type="button" class="os-recovery-choice" data-thought-recovery-supplement>
              <strong>只补心声</strong><span>保留当前正文，单独调用一次接口补齐缺失角色</span>
            </button>
            <button type="button" class="os-recovery-choice" data-thought-recovery-reroll>
              <strong>整轮重 roll</strong><span>重新生成当前正文与心声，成功后替换这一层</span>
            </button>
          </div>
          <div class="os-revision-status" role="status" aria-live="polite"></div>
        </div>
      </div>`;
    const close = () => sheet.remove();
    sheet.querySelectorAll('[data-thought-recovery-close]').forEach((el) => el.addEventListener('click', close));
    sheet.querySelector('[data-thought-recovery-reroll]')?.addEventListener('click', () => {
      close();
      onReroll();
    });
    sheet.querySelector('[data-thought-recovery-supplement]')?.addEventListener('click', async () => {
      const buttons = [...sheet.querySelectorAll('button')];
      const status = sheet.querySelector('.os-revision-status');
      buttons.forEach((button) => { button.disabled = true; });
      if (status) status.textContent = '正在补心声…';
      const notice = beginLongTaskNotice({ title: '正在补线下心声', body: '当前正文会原样保留' });
      try {
        const result = await supplementOfflineCharacterStates({ session, chat, user, beatId: target.id });
        void notice.complete();
        renderBeats();
        close();
        showToast(`已补齐 ${result.addedIds.length} 位角色的心声`);
      } catch (error) {
        notice.cancel();
        if (status) status.textContent = String(error?.message || error || '补心声失败');
        buttons.forEach((button) => { button.disabled = false; });
        reportOfflineGenerationError(error, { title: '补心声失败', scope: '线下相遇 / 补心声' });
      }
    });
    container.appendChild(sheet);
    sheet.querySelector('[data-open-reroll-versions]')?.addEventListener('click', () => {
      closeSettingsSheet();
      openRerollVersionsSheet();
    });
  }

  async function openGuidedRevisionSheet(beatId) {
    if (!session || isAdvancing || !canReviseLastOfflineBeat(session, beatId)) {
      showToast('只能指导重修当前最后一层');
      return;
    }
    closeSettingsSheet();
    settingsSheetOpen = true;
    guidanceDiscussionOpen = true;
    await ensureSettingsCatalogs();
    if (!container.isConnected) return;
    const beat = session.beats.find((row) => row.id === beatId);
    const quickRules = [
      ['continue-next', '接下一拍', '把用户已经说过、做过或指定完成的内容视为已发生，从角色的下一拍反应开始写'],
      ['character-side', '只写角色侧', '用户的发言、动作和决定由用户控制；正文聚焦角色与环境对既定输入的回应'],
      ['slow-down', '放慢推进', '本场后续每轮只推进一个局部节点，写清当下反应后停住，把关键选择留给下一轮'],
      ['scene-focus', '突出重点', '每轮只选一个场景重心，围绕触发动作、即时感官、贴身心理和回应动作展开，删去无关流程'],
      ['show-dont-label', '用行动呈现', '让关系与气氛通过可见动作、对白和环境反应呈现，不用全知旁白替读者定性总结'],
      ['direct-affirmative', '直接写发生', '优先使用肯定句直写正在发生的动作与感受，不用“不是……而是……”或虚构未发生行为作负向垫句'],
    ];
    const storedGuidanceDraft = String(session.guidedRevisionDraft?.beatId || '') === String(beatId)
      ? session.guidedRevisionDraft
      : null;
    const selected = new Set(
      (Array.isArray(storedGuidanceDraft?.selectedRuleIds) ? storedGuidanceDraft.selectedRuleIds : [])
        .map((id) => String(id || ''))
        .filter((id) => quickRules.some(([ruleId]) => ruleId === id)),
    );
    const currentGuidance = String(session.scene?.guidancePrompt || '').trim();
    const builtinWorldBookIds = new Set(WORLD_BOOKS.map((row) => String(row.id || '')).filter(Boolean));
    const guidanceTargetOptions = worldBookRows
      .filter((row) => (
        row?.isBookRoot
        && !row.isCollection
        && row.system !== 'miniwiki'
        && !builtinWorldBookIds.has(String(row.id || ''))
      ))
      .map((book) => {
        const groups = worldBookRows.filter((row) => (
          row?.kind === 'group'
          && !row.isBookRoot
          && !row.isCollection
          && row.system !== 'miniwiki'
          && String(row.bookId || row.parentGroupId || '') === String(book.id || '')
        ));
        const bookId = encodeURIComponent(String(book.id || ''));
        return `<optgroup label="世界书 · ${esc(book.name || book.title || '未命名')}">
          <option value="worldbook:${bookId}:">直接放在书中</option>
          ${groups.map((group) => `<option value="worldbook:${bookId}:${encodeURIComponent(String(group.id || ''))}">分组 · ${esc(group.name || '未命名')}</option>`).join('')}
        </optgroup>`;
      })
      .join('');
    const sheet = document.createElement('div');
    sheet.className = 'offline-settings-sheet os-guided-revision-sheet';
    sheet.innerHTML = `
      <div class="offline-settings-sheet-backdrop" data-revision-close></div>
      <div class="offline-settings-sheet-panel" role="dialog" aria-modal="true" aria-labelledby="os-revision-title">
        <header class="offline-settings-sheet-head">
          <div><h2 id="os-revision-title">指导与重修</h2><p>本体指导中 · 剧情已暂停</p></div>
          <button type="button" class="navbar-btn" data-revision-close aria-label="关闭">${icon('close')}</button>
        </header>
        <div class="offline-settings-sheet-body" data-ime-scroll-region>
          <details class="os-revision-original">
            <summary>上次文本</summary>
            <p>${esc(applyDisplayRegex(String(beat.text || ''), 'offline'))}</p>
          </details>
          <section class="os-guidance-conversation" hidden aria-live="polite">
            <div class="os-guidance-conversation-list"></div>
          </section>
          <label class="api-field os-revision-request">
            <span class="api-field-label">对本体说</span>
            <textarea class="form-input" rows="3" maxlength="800" placeholder="说说哪里不对，或希望以后遇到这种情况怎么写">${esc(storedGuidanceDraft?.request || '')}</textarea>
          </label>
          <div class="os-revision-chips" aria-label="快捷约束">
            ${quickRules.map(([id, label]) => `<button type="button" data-revision-rule="${id}" class="${selected.has(id) ? 'is-active' : ''}" aria-pressed="${selected.has(id) ? 'true' : 'false'}">${label}</button>`).join('')}
          </div>
          <div class="os-revision-status" role="status" aria-live="polite"></div>
          ${currentGuidance ? `
            <details class="os-current-guidance">
              <summary>本场已启用指导</summary>
              <p>${esc(currentGuidance)}</p>
              <button type="button" class="btn btn-soft btn-sm" data-guidance-clear>停用本场指导</button>
            </details>` : ''}
          <section class="os-guidance-draft" hidden>
            <header class="os-guidance-draft-head">
              <strong>提示词草稿</strong>
              <span data-guidance-scope></span>
            </header>
            <label class="api-field">
              <span class="api-field-label">指导名称</span>
              <input class="form-input" data-guidance-name maxlength="30" placeholder="例如：场景聚焦与贴身心理">
            </label>
            <label class="api-field">
              <span class="api-field-label">整理后的写作指导</span>
              <textarea class="form-input" data-guidance-content rows="8" maxlength="2600"></textarea>
            </label>
            <label class="api-field">
              <span class="api-field-label">保存位置</span>
              <select class="form-input" data-guidance-target>
                <option value="session">仅本场（不新建条目）</option>
                <option value="preset">线下预设（仅绑定本场）</option>
                ${guidanceTargetOptions}
              </select>
            </label>
            <div class="os-guidance-actions">
              <button type="button" class="btn btn-primary" data-guidance-save>保存并重写</button>
            </div>
          </section>
          ${revisionHistoryHtml(beatId)}
        </div>
        <footer class="offline-settings-sheet-foot">
          <button type="button" class="btn btn-outline" data-revision-submit>直接重写</button>
          <button type="button" class="btn btn-primary" data-guidance-organize>发送给本体</button>
        </footer>
      </div>`;
    container.appendChild(sheet);
    const requestInput = sheet.querySelector('.os-revision-request textarea');
    const submit = sheet.querySelector('[data-revision-submit]');
    const organize = sheet.querySelector('[data-guidance-organize]');
    const status = sheet.querySelector('.os-revision-status');
    const conversationHost = sheet.querySelector('.os-guidance-conversation');
    const conversationList = sheet.querySelector('.os-guidance-conversation-list');
    const discussionTurns = (Array.isArray(storedGuidanceDraft?.discussion) ? storedGuidanceDraft.discussion : [])
      .map((turn) => ({
        role: turn?.role === 'assistant' ? 'assistant' : 'user',
        content: String(turn?.content || '').trim(),
      }))
      .filter((turn) => turn.content);
    let latestGuidanceDraft = storedGuidanceDraft?.guidanceDraft?.content
      ? {
        name: String(storedGuidanceDraft.guidanceDraft.name || '').trim(),
        scope: storedGuidanceDraft.guidanceDraft.scope === 'session' ? 'session' : 'preset',
        content: String(storedGuidanceDraft.guidanceDraft.content || '').trim(),
      }
      : null;
    let guidanceBusy = false;
    let guidanceDraftSaveTimer = 0;
    let guidanceDraftSaveChain = Promise.resolve();
    const renderDiscussion = () => {
      if (!conversationHost || !conversationList) return;
      conversationHost.hidden = discussionTurns.length === 0;
      conversationList.innerHTML = discussionTurns.map((turn) => `
        <article class="os-guidance-turn os-guidance-turn--${turn.role === 'assistant' ? 'assistant' : 'user'}">
          <span>${turn.role === 'assistant' ? '本体' : '你'}</span>
          <p>${esc(turn.content)}</p>
        </article>`).join('');
      const body = sheet.querySelector('.offline-settings-sheet-body');
      if (body && discussionTurns.length) {
        window.requestAnimationFrame(() => {
          conversationHost.scrollIntoView({ block: 'nearest' });
        });
      }
    };
    const readDraftFromFields = () => {
      const contentInput = sheet.querySelector('[data-guidance-content]');
      const content = String(contentInput?.value || '').trim();
      if (contentInput && !content) return null;
      if (!content) return latestGuidanceDraft;
      return {
        name: String(sheet.querySelector('[data-guidance-name]')?.value || '').trim(),
        scope: latestGuidanceDraft?.scope === 'session' ? 'session' : 'preset',
        content,
      };
    };
    const showGuidanceDraft = (draft) => {
      if (!draft?.ready) return;
      latestGuidanceDraft = {
        name: String(draft.name || '').trim(),
        scope: draft.scope === 'session' ? 'session' : 'preset',
        content: String(draft.content || '').trim(),
      };
      const draftHost = sheet.querySelector('.os-guidance-draft');
      const nameInput = sheet.querySelector('[data-guidance-name]');
      const contentInput = sheet.querySelector('[data-guidance-content]');
      const scopeLabel = sheet.querySelector('[data-guidance-scope]');
      const targetInput = sheet.querySelector('[data-guidance-target]');
      if (nameInput) nameInput.value = latestGuidanceDraft.name;
      if (contentInput) contentInput.value = latestGuidanceDraft.content;
      if (scopeLabel) scopeLabel.textContent = latestGuidanceDraft.scope === 'session' ? '建议仅本场' : '建议保存复用';
      if (targetInput) targetInput.value = latestGuidanceDraft.scope === 'session' ? 'session' : 'preset';
      if (draftHost) draftHost.hidden = false;
    };
    const guidanceDraftSnapshot = () => {
      const fieldDraft = readDraftFromFields();
      return {
        beatId: String(beatId),
        request: String(requestInput?.value || '').slice(0, 800),
        selectedRuleIds: [...selected],
        discussion: discussionTurns.map((turn) => ({
          role: turn.role === 'assistant' ? 'assistant' : 'user',
          content: String(turn.content || ''),
        })),
        guidanceDraft: fieldDraft ? {
          name: String(fieldDraft.name || '').slice(0, 30),
          scope: fieldDraft.scope === 'session' ? 'session' : 'preset',
          content: String(fieldDraft.content || '').slice(0, 2600),
        } : null,
        target: String(sheet.querySelector('[data-guidance-target]')?.value || 'session'),
        updatedAt: Date.now(),
      };
    };
    const persistGuidanceDraftNow = () => {
      if (guidanceDraftSaveTimer) window.clearTimeout(guidanceDraftSaveTimer);
      guidanceDraftSaveTimer = 0;
      session.guidedRevisionDraft = guidanceDraftSnapshot();
      guidanceDraftSaveChain = guidanceDraftSaveChain
        .catch(() => {})
        .then(() => saveOfflineSession(session));
      return guidanceDraftSaveChain;
    };
    const scheduleGuidanceDraftSave = () => {
      if (guidanceDraftSaveTimer) window.clearTimeout(guidanceDraftSaveTimer);
      guidanceDraftSaveTimer = window.setTimeout(() => {
        guidanceDraftSaveTimer = 0;
        void persistGuidanceDraftNow().catch((error) => {
          console.warn('[offline-session] guided revision draft save failed', error);
        });
      }, 320);
    };
    const clearPersistedGuidanceDraft = async () => {
      if (guidanceDraftSaveTimer) window.clearTimeout(guidanceDraftSaveTimer);
      guidanceDraftSaveTimer = 0;
      delete session.guidedRevisionDraft;
      guidanceDraftSaveChain = guidanceDraftSaveChain
        .catch(() => {})
        .then(() => saveOfflineSession(session));
      await guidanceDraftSaveChain;
    };
    renderDiscussion();
    if (latestGuidanceDraft?.content) {
      showGuidanceDraft({ ...latestGuidanceDraft, ready: true });
      const targetInput = sheet.querySelector('[data-guidance-target]');
      const storedTarget = String(storedGuidanceDraft?.target || '');
      if (targetInput && [...targetInput.options].some((option) => option.value === storedTarget)) {
        targetInput.value = storedTarget;
      }
    }
    if (storedGuidanceDraft) {
      if (status) status.textContent = '已恢复上次未完成的指导草稿';
      const requestLabel = sheet.querySelector('.os-revision-request .api-field-label');
      if (requestLabel) requestLabel.textContent = '对本体说 · 草稿已恢复';
    }
    requestInput?.addEventListener('input', scheduleGuidanceDraftSave);
    sheet.querySelector('[data-guidance-name]')?.addEventListener('input', scheduleGuidanceDraftSave);
    sheet.querySelector('[data-guidance-content]')?.addEventListener('input', scheduleGuidanceDraftSave);
    sheet.querySelector('[data-guidance-target]')?.addEventListener('change', scheduleGuidanceDraftSave);
    const clearComposer = () => {
      if (requestInput) requestInput.value = '';
      selected.clear();
      sheet.querySelectorAll('[data-revision-rule]').forEach((button) => {
        button.classList.remove('is-active');
        button.setAttribute('aria-pressed', 'false');
      });
    };
    const close = async () => {
      if (submit?.disabled || guidanceBusy) return;
      await persistGuidanceDraftNow().catch((error) => {
        console.warn('[offline-session] guided revision draft close save failed', error);
      });
      closeSettingsSheet();
    };
    sheet.querySelectorAll('[data-revision-close]').forEach((el) => el.addEventListener('click', close));
    sheet.querySelector('.offline-settings-sheet-panel')?.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') close();
    });
    sheet.querySelectorAll('[data-revision-rule]').forEach((button) => {
      button.addEventListener('click', () => {
        const id = button.getAttribute('data-revision-rule');
        if (selected.has(id)) selected.delete(id);
        else selected.add(id);
        button.classList.toggle('is-active', selected.has(id));
        button.setAttribute('aria-pressed', selected.has(id) ? 'true' : 'false');
        scheduleGuidanceDraftSave();
      });
    });
    const buildRequirement = () => {
      const typed = String(requestInput?.value || '').trim();
      const constraints = quickRules.filter(([id]) => selected.has(id)).map(([, , text]) => text);
      return [typed, ...constraints].filter(Boolean).join('；');
    };
    const setGuidanceToolState = (active) => {
      const state = container.querySelector('.offline-tool[data-tool="guidance"] .offline-tool-state');
      if (state) state.textContent = active ? '本场' : '未启用';
    };
    const rewriteWithRequirement = async (requirement, successMessage = '已按要求重写，可在版本记录中恢复') => {
      const body = String(requirement || '').trim();
      if (!body) return;
      await persistGuidanceDraftNow().catch((error) => {
        console.warn('[offline-session] guided revision draft preflight save failed', error);
      });
      isAdvancing = true;
      submit.disabled = true;
      if (organize) organize.disabled = true;
      submit.textContent = '正在重写…';
      if (requestInput) requestInput.disabled = true;
      sheet.querySelectorAll('[data-revision-rule], [data-revision-restore], [data-guidance-save], [data-guidance-clear]').forEach((el) => { el.disabled = true; });
      if (status) status.textContent = '旧稿会保留到新稿生成成功';
      try {
        const messages = await listMessagesForChat(chatId);
        await runOfflineBeat({
          session,
          chat,
          user,
          messages,
          directive: '',
          revision: { beatId, requirement: body },
          onChunk: (text) => {
            if (status) status.textContent = text ? '正在整理新版本…' : '正在等待正文…';
          },
        });
        await clearPersistedGuidanceDraft().catch((error) => {
          console.warn('[offline-session] guided revision draft cleanup failed', error);
        });
        closeSettingsSheet();
        renderBeats();
        renderOptionsFromSession();
        showToast(successMessage);
      } catch (err) {
        if (status) status.textContent = `未替换旧稿：${err?.message || err}`;
        reportOfflineGenerationError(err, { title: '指导重修失败', scope: '线下相遇 / 指导重修' });
        submit.disabled = false;
        if (organize) organize.disabled = false;
        submit.textContent = '重试指导重修';
        if (requestInput) requestInput.disabled = false;
        sheet.querySelectorAll('[data-revision-rule], [data-revision-restore], [data-guidance-save], [data-guidance-clear]').forEach((el) => { el.disabled = false; });
      } finally {
        isAdvancing = false;
      }
    };
    sheet.querySelector('[data-guidance-clear]')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        session.scene = createSceneDraft({ ...(session.scene || {}), guidancePrompt: '' });
        await saveOfflineSession(session);
        setGuidanceToolState(false);
        button.closest('.os-current-guidance')?.remove();
        if (status) status.textContent = '本场指导已停用';
      } catch (err) {
        button.disabled = false;
        if (status) status.textContent = `停用失败：${err?.message || err}`;
      }
    });
    organize?.addEventListener('click', async () => {
      const requirement = buildRequirement();
      if (!requirement) {
        if (status) status.textContent = '先告诉本体哪里不对，或选择一个快捷方向';
        requestInput?.focus();
        return;
      }
      const nextTurns = [...discussionTurns, { role: 'user', content: requirement }];
      await persistGuidanceDraftNow().catch((error) => {
        console.warn('[offline-session] guidance discussion draft save failed', error);
      });
      guidanceBusy = true;
      organize.disabled = true;
      organize.textContent = '本体正在回复…';
      if (submit) submit.disabled = true;
      if (requestInput) requestInput.disabled = true;
      sheet.querySelectorAll('[data-revision-rule], [data-guidance-save], [data-guidance-clear]').forEach((el) => { el.disabled = true; });
      if (status) status.textContent = '角色扮演保持暂停，正在讨论写法…';
      try {
        const draft = await discussOfflineGuidance({
          discussion: nextTurns,
          sampleText: String(beat.text || ''),
          scene: session.scene || {},
          currentGuidance: String(session.scene?.guidancePrompt || '').trim(),
          currentDraft: readDraftFromFields(),
          referenceContext: await buildOfflineGuidanceReferenceContext({
            session,
            chat,
            user,
            messages: await listMessagesForChat(chatId),
          }),
          onProgress: (text) => {
            if (status && text) status.textContent = text;
          },
        });
        discussionTurns.splice(0, discussionTurns.length, ...nextTurns, {
          role: 'assistant',
          content: draft.reply || draft.question || '你可以再具体说说想保留什么、改掉什么。',
        });
        renderDiscussion();
        clearComposer();
        if (draft.ready) showGuidanceDraft(draft);
        await persistGuidanceDraftNow().catch((error) => {
          console.warn('[offline-session] guidance response draft save failed', error);
        });
        if (status) {
          status.textContent = draft.ready
            ? (draft.scope === 'session'
              ? '已生成提示词草稿，建议仅在本场启用'
              : '已生成提示词草稿，可保存为已启用预设')
            : '本体还需要你补充一点，再继续发送即可';
        }
      } catch (err) {
        await persistGuidanceDraftNow().catch(() => {});
        if (status) status.textContent = `本体回复失败：${err?.message || err}`;
        reportOfflineGenerationError(err, {
          title: '本体指导回复失败',
          scope: '线下相遇 / 本体指导',
        });
      } finally {
        guidanceBusy = false;
        organize.disabled = false;
        organize.textContent = discussionTurns.length ? '继续发送' : '发送给本体';
        if (submit) submit.disabled = false;
        if (requestInput) {
          requestInput.disabled = false;
          requestInput.placeholder = discussionTurns.length
            ? '继续补充，或让本体调整刚生成的提示词'
            : '说说哪里不对，或希望以后遇到这种情况怎么写';
          requestInput.focus();
        }
        sheet.querySelectorAll('[data-revision-rule], [data-guidance-save], [data-guidance-clear]').forEach((el) => { el.disabled = false; });
      }
    });
    sheet.querySelector('[data-guidance-save]')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      if (guidanceBusy || button.disabled) return;
      const target = String(sheet.querySelector('[data-guidance-target]')?.value || 'session');
      const nameInput = sheet.querySelector('[data-guidance-name]');
      const name = String(nameInput?.value || '').trim();
      const content = String(sheet.querySelector('[data-guidance-content]')?.value || '').trim();
      if (target !== 'session' && !name) {
        if (status) status.textContent = '请给这条指导起一个名字';
        nameInput?.focus();
        return;
      }
      if (content.length < 40) {
        if (status) status.textContent = '指导还不够具体，请补充执行方法';
        return;
      }
      guidanceBusy = true;
      button.disabled = true;
      try {
        let savedLabel = '已启用本场指导并重写';
        if (target === 'session') {
          session.scene = createSceneDraft({ ...(session.scene || {}), guidancePrompt: content });
          setGuidanceToolState(true);
        } else if (target === 'preset') {
          const saved = await savePresetRecord({
            id: createCustomPresetId(), name, category: 'custom', mode: 'offline', content,
          });
          session.scene = createSceneDraft({ ...(session.scene || {}), guidancePrompt: content });
          setGuidanceToolState(true);
          presetOptions = await listOfflinePresetOptions().catch(() => presetOptions);
          savedLabel = `已保存线下预设「${saved.name}」并绑定本场`;
        } else if (target.startsWith('worldbook:')) {
          const [, rawBookId = '', rawGroupId = ''] = target.split(':');
          const bookId = decodeURIComponent(rawBookId);
          const groupId = decodeURIComponent(rawGroupId);
          const book = worldBookRows.find((row) => String(row.id || '') === bookId && row.isBookRoot);
          if (!book) throw new Error('所选世界书已不存在');
          const group = groupId
            ? worldBookRows.find((row) => String(row.id || '') === groupId && !row.isBookRoot)
            : null;
          if (groupId && !group) throw new Error('所选世界书分组已不存在');
          await saveWorldBookEntry(createWorldBookEntry({
            kind: 'item', name, content, category: 'custom', priority: 'normal',
            constant: true, selective: false, bookId, groupId,
          }));
          savedLabel = `已保存到「${book.name || book.title || '世界书'}${group ? ` / ${group.name || '分组'}` : ''}」`;
        } else {
          throw new Error('无法识别保存位置');
        }
        await saveOfflineSession(session);
        // 保存到本场或预设时，完整正文已会通过 scene.guidancePrompt
        // 进入生成提示。这里只需要一条短的重写指令，避免把同一份
        // 指导再作为 revision requirement 重复发送，令长上下文被中转拒绝。
        const rewriteRequirement = target === 'session' || target === 'preset'
          ? '按本场已启用的写作指导重写当前这一层，完整执行其中要求。'
          : content;
        guidanceBusy = false;
        await rewriteWithRequirement(rewriteRequirement, savedLabel);
      } catch (err) {
        guidanceBusy = false;
        button.disabled = false;
        if (status) status.textContent = `指导保存失败：${err?.message || err}`;
      }
    });
    sheet.querySelectorAll('[data-revision-restore]').forEach((button) => {
      button.addEventListener('click', async () => {
        if (!window.confirm('恢复到这次修改前的版本？当前版本仍会留在版本记录里。')) return;
        const snapshot = {
          beats: JSON.parse(JSON.stringify(session.beats || [])),
          revisions: JSON.parse(JSON.stringify(session.revisions || [])),
          checkpoints: JSON.parse(JSON.stringify(session.checkpointSummaries || [])),
        };
        button.disabled = true;
        try {
          const currentBeat = [...(session.beats || [])].reverse()
            .find((beat) => beat?.role === 'narration') || null;
          const restored = restoreLastOfflineRevision(session, button.getAttribute('data-revision-restore'));
          if (!restored.ok) throw new Error('这个版本已不能恢复');
          await saveOfflineSession(session);
          if (currentBeat) {
            await rollbackOfflinePhoneActionsForBeat(currentBeat, session.id).catch(() => {});
          }
          const restoredBeat = [...(session.beats || [])].reverse()
            .find((beat) => beat?.role === 'narration') || null;
          if (restoredBeat) {
            await restoreOfflinePhoneActionsForBeat({
              beat: restoredBeat,
              userId: user.id,
              sessionId: session.id,
              activeCharacterIds: getActiveOfflineParticipantIds(session, chat),
            }).catch(() => {});
            await saveOfflineSession(session).catch(() => {});
          }
          closeSettingsSheet();
          renderBeats();
          renderOptionsFromSession();
          showToast('已恢复上一版');
        } catch (err) {
          session.beats = snapshot.beats;
          session.revisions = snapshot.revisions;
          session.checkpointSummaries = snapshot.checkpoints;
          button.disabled = false;
          if (status) status.textContent = `恢复失败：${err?.message || err}`;
        }
      });
    });
    submit?.addEventListener('click', async () => {
      const requirement = buildRequirement() || String(readDraftFromFields()?.content || '').trim();
      if (!requirement) {
        if (status) status.textContent = '写一句要求，或选择一个快捷约束';
        requestInput?.focus();
        return;
      }
      await rewriteWithRequirement(requirement);
    });
    window.setTimeout(() => requestInput?.focus(), 0);
  }

  function openBookmarkEditor(beatId) {
    if (!session) return;
    const beat = session.beats.find((row) => row.id === beatId && row.role === 'narration');
    if (!beat) return;
    const floor = session.beats.slice(0, session.beats.indexOf(beat) + 1)
      .filter((row) => row.role === 'narration').length;
    const existing = (session.bookmarks || []).find((row) => row.beatId === beatId);
    openTextEditorModal({
      title: existing ? '重命名节点' : '存为节点',
      value: existing?.name || `第 ${floor} 楼`,
      multiline: false,
      placeholder: '节点名称',
      confirmLabel: '保存',
      onSave: async (name) => {
        if (!String(name || '').trim()) { showToast('名字不能为空'); return; }
        const result = addOfflineBookmark(session, beatId, name);
        if (!result.ok) { showToast('找不到这个楼层'); return; }
        await saveOfflineSession(session);
        showToast(existing ? '节点已重命名' : '已存为节点');
      },
    });
  }

  function openForkEditor(beatId) {
    if (!session || isAdvancing) return;
    const eligibility = getOfflineForkEligibility(session, beatId);
    if (!eligibility.ok) {
      showToast(eligibility.message || '此处不能另开路线');
      return;
    }
    const branching = ensureOfflineBranching(session);
    openTextEditorModal({
      title: '从这里另开路线',
      value: `路线 ${branching.branches.length + 1}`,
      multiline: false,
      placeholder: '路线名称',
      confirmLabel: '另开路线',
      onSave: async (name) => {
        if (!String(name || '').trim()) { showToast('名字不能为空'); return; }
        try {
          const result = await forkOfflineBranch(session, beatId, name);
          if (!result.ok) {
            showToast(result.message || '无法从这里另开路线');
            return;
          }
          await saveOfflineSession(session, { allowShrink: true });
          historyExpanded = true;
          optionsCollapsed = false;
          paint();
          showToast(`已切换到「${result.branch.name}」`);
        } catch (err) {
          showToast(err?.message || '另开路线失败');
        }
      },
    });
  }

  function jumpToBookmarkedBeat(beatId) {
    closeSettingsSheet();
    historyExpanded = true;
    renderBeats();
    window.requestAnimationFrame(() => {
      const target = [...container.querySelectorAll('.offline-beat[data-beat-id]')]
        .find((row) => row.getAttribute('data-beat-id') === String(beatId || ''));
      if (!target) { showToast('这个节点已不在当前路线'); return; }
      target.setAttribute('tabindex', '-1');
      const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      target.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'center' });
      target.focus({ preventScroll: true });
      window.setTimeout(() => target.removeAttribute('tabindex'), 800);
    });
  }

  function openRoutesSheet() {
    if (!session || isAdvancing) return;
    closeSettingsSheet();
    settingsSheetOpen = true;
    const branching = ensureOfflineBranching(session);
    const activeId = branching.activeBranchId;
    const sheet = document.createElement('div');
    sheet.className = 'offline-settings-sheet os-routes-sheet';
    sheet.innerHTML = `
      <div class="offline-settings-sheet-backdrop" data-routes-close></div>
      <div class="offline-settings-sheet-panel" role="dialog" aria-modal="true" aria-labelledby="os-routes-title">
        <header class="offline-settings-sheet-head">
          <div><h2 id="os-routes-title">路线</h2><p>收纳时，当前路线会成为正史</p></div>
          <button type="button" class="navbar-btn" data-routes-close aria-label="关闭">${icon('close')}</button>
        </header>
        <div class="offline-settings-sheet-body">
          <section class="os-route-group">
            <h3>路线</h3>
            <div class="os-route-list">
              ${branching.branches.map((branch) => `
                <article class="os-route-row${branch.id === activeId ? ' is-active' : ''}">
                  <button type="button" class="os-route-main" data-route-switch="${esc(branch.id)}" ${branch.id === activeId ? 'disabled' : ''}>
                    <strong>${esc(branch.name)}</strong>
                    <small>${branch.isMain ? '主干' : '分支'}${branch.id === activeId ? ' · 当前' : ''}</small>
                  </button>
                  <button type="button" class="os-route-icon-btn" data-route-rename="${esc(branch.id)}" aria-label="重命名 ${esc(branch.name)}">改名</button>
                  ${branch.id !== activeId ? `<button type="button" class="os-route-icon-btn is-danger" data-route-delete="${esc(branch.id)}" aria-label="删除 ${esc(branch.name)}">删除</button>` : ''}
                </article>`).join('')}
            </div>
          </section>
          <section class="os-route-group">
            <h3>节点</h3>
            <div class="os-bookmark-list">
              ${(session.bookmarks || []).length ? session.bookmarks.map((bookmark) => `
                <article class="os-bookmark-row">
                  <button type="button" data-bookmark-jump="${esc(bookmark.beatId)}"><strong>${esc(bookmark.name)}</strong><small>第 ${Number(bookmark.floor || 0)} 楼</small></button>
                  <button type="button" class="os-route-icon-btn" data-bookmark-rename="${esc(bookmark.id)}">改名</button>
                  <button type="button" class="os-route-icon-btn is-danger" data-bookmark-delete="${esc(bookmark.id)}">删除</button>
                </article>`).join('') : '<div class="os-route-empty">在任意楼层菜单中存为节点</div>'}
            </div>
          </section>
        </div>
      </div>`;
    container.appendChild(sheet);
    const close = () => closeSettingsSheet();
    sheet.querySelectorAll('[data-routes-close]').forEach((el) => el.addEventListener('click', close));
    sheet.querySelector('.offline-settings-sheet-panel')?.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') close();
    });
    sheet.querySelectorAll('[data-bookmark-jump]').forEach((button) => {
      button.addEventListener('click', () => jumpToBookmarkedBeat(button.getAttribute('data-bookmark-jump')));
    });
    sheet.querySelectorAll('[data-bookmark-rename]').forEach((button) => {
      button.addEventListener('click', () => {
        const bookmark = (session.bookmarks || []).find((row) => row.id === button.getAttribute('data-bookmark-rename'));
        if (bookmark) {
          close();
          openBookmarkEditor(bookmark.beatId);
        }
      });
    });
    sheet.querySelectorAll('[data-bookmark-delete]').forEach((button) => {
      button.addEventListener('click', async () => {
        const bookmark = (session.bookmarks || []).find((row) => row.id === button.getAttribute('data-bookmark-delete'));
        if (!bookmark || !window.confirm(`删除节点「${bookmark.name}」？`)) return;
        deleteOfflineBookmark(session, bookmark.id);
        await saveOfflineSession(session);
        close();
        openRoutesSheet();
      });
    });
    sheet.querySelectorAll('[data-route-rename]').forEach((button) => {
      button.addEventListener('click', () => {
        const branch = ensureOfflineBranching(session).branches.find((row) => row.id === button.getAttribute('data-route-rename'));
        if (!branch) return;
        close();
        openTextEditorModal({
          title: '重命名路线',
          value: branch.name,
          multiline: false,
          placeholder: '路线名称',
          confirmLabel: '保存',
          onSave: async (name) => {
            if (!String(name || '').trim()) { showToast('名字不能为空'); return; }
            await renameOfflineBranch(session, branch.id, name);
            await saveOfflineSession(session);
            showToast('路线已重命名');
          },
        });
      });
    });
    sheet.querySelectorAll('[data-route-switch]').forEach((button) => {
      button.addEventListener('click', async () => {
        const targetId = button.getAttribute('data-route-switch');
        const target = ensureOfflineBranching(session).branches.find((row) => row.id === targetId);
        if (!target || !window.confirm(`切换到「${target.name}」？当前路线会先保存。`)) return;
        button.disabled = true;
        try {
          const result = await switchOfflineBranch(session, targetId);
          if (!result.ok) {
            button.disabled = false;
            showToast(result.message || (result.reason === 'snapshot_not_found' ? '这条路线的快照已不可用' : '切换失败'));
            return;
          }
          await saveOfflineSession(session, { allowShrink: true });
          close();
          historyExpanded = false;
          paint();
          showToast(`已切换到「${target.name}」`);
        } catch (err) {
          button.disabled = false;
          showToast(err?.message || '切换失败');
        }
      });
    });
    sheet.querySelectorAll('[data-route-delete]').forEach((button) => {
      button.addEventListener('click', async () => {
        const targetId = button.getAttribute('data-route-delete');
        const target = ensureOfflineBranching(session).branches.find((row) => row.id === targetId);
        if (!target || !window.confirm(`删除路线「${target.name}」？此操作无法恢复。`)) return;
        const result = await deleteOfflineBranch(session, targetId);
        if (!result.ok) { showToast('当前路线不能删除'); return; }
        await saveOfflineSession(session);
        close();
        openRoutesSheet();
      });
    });
    window.setTimeout(() => sheet.querySelector('[data-routes-close]')?.focus(), 0);
  }

  async function openAutoReplySheet() {
    if (!session) return;
    closeSettingsSheet();
    settingsSheetOpen = true;
    const partIds = getActiveOfflineParticipantIds(session, chat);
    const nameOf = new Map((await getCharactersByIds(partIds, { userId: user.id }).catch(() => []))
      .filter(Boolean)
      .map((c) => [c.id, c.customNickname || c.name || 'TA']));
    const draft = {
      mode: session.autoReply?.mode || globalAutoReply.mode || 'off',
      fixedText: session.autoReply?.fixedText || globalAutoReply.fixedText || '',
      proxyCharacterId: session.autoReply?.proxyCharacterId || partIds[0] || '',
      incomingTakeover: {
        ...globalAutoReply.incomingTakeover,
        ...(session.autoReply?.incomingTakeover || session.incomingTakeover || {}),
      },
      sideTripCaught: {
        ...globalAutoReply.sideTripCaught,
        ...(session.autoReply?.sideTripCaught || session.sideTripCaught || {}),
      },
      phoneMessagesEnabled: typeof session.scene?.phoneMessagesEnabled === 'boolean'
        ? session.scene.phoneMessagesEnabled
        : globalAutoReply.phoneMessagesEnabled !== false,
    };
    const frequencyOptions = (selected = 'medium') => Object.entries(OFFLINE_PHONE_FREQUENCIES)
      .map(([value, meta]) => `<option value="${value}" ${(selected || 'medium') === value ? 'selected' : ''}>${meta.label}</option>`)
      .join('');
    const sheet = document.createElement('div');
    sheet.className = 'offline-settings-sheet os-auto-reply-sheet';
    sheet.innerHTML = `
      <div class="offline-settings-sheet-backdrop" data-settings-close></div>
      <div class="offline-settings-sheet-panel" role="dialog" aria-label="消息与代答">
        <header class="offline-settings-sheet-head">
          <div><h2>消息与代答</h2><p>线下期间的手机消息</p></div>
          <button type="button" class="navbar-btn" data-settings-close aria-label="关闭">${icon('close')}</button>
        </header>
        <div class="offline-settings-sheet-body">
          <div class="os-reply-modes">
            ${[
              ['off', '关闭', '由你自己决定是否回复'],
              ['fixed', '固定回复', '自动发出一条预设文案'],
              ['companion', '同行代答', '由现场角色替你回一句'],
            ].map(([value, label, note]) => `
              <button type="button" class="os-reply-mode ${draft.mode === value ? 'is-active' : ''}" data-reply-mode="${value}">
                <strong>${label}</strong><small>${note}</small>
              </button>`).join('')}
          </div>
          <label class="api-field off-auto-reply-text-wrap" ${draft.mode === 'fixed' ? '' : 'hidden'}>
            <span class="api-field-label">自动回复文案</span>
            <input type="text" class="form-input off-auto-reply-text" value="${esc(draft.fixedText)}" placeholder="${esc(DEFAULT_OFFLINE_AUTO_REPLY_TEXT)}" />
          </label>
          <label class="api-field off-auto-reply-proxy-wrap" ${draft.mode === 'companion' ? '' : 'hidden'}>
            <span class="api-field-label">由谁代答</span>
            <select class="form-input off-auto-reply-proxy">
              ${partIds.map((id) => `<option value="${esc(id)}" ${id === draft.proxyCharacterId ? 'selected' : ''}>${esc(nameOf.get(id) || 'TA')}</option>`).join('')}
            </select>
          </label>
          <div class="os-phone-playback-settings">
            <label class="os-phone-playback-row is-toggle-only">
              <span><strong>剧情内手机消息</strong><small>允许叙事生成角色收发微信</small></span>
              <input type="checkbox" class="off-phone-messages-enabled" ${draft.phoneMessagesEnabled ? 'checked' : ''} />
            </label>
            <label class="os-phone-playback-row">
              <span><strong>消息代答演出</strong><small>来消息或剧情接手机时，切进 Chat 代回</small></span>
              <input type="checkbox" class="off-incoming-takeover-enabled" ${draft.incomingTakeover?.enabled ? 'checked' : ''} />
              <select class="form-input off-incoming-takeover-frequency" aria-label="消息代答演出频率">${frequencyOptions(draft.incomingTakeover?.frequency)}</select>
            </label>
            <label class="os-phone-playback-row">
              <span><strong>掏手机被注意</strong><small>你和别人聊了一会儿后，TA 可能接过手机</small></span>
              <input type="checkbox" class="off-side-trip-caught-enabled" ${draft.sideTripCaught?.enabled ? 'checked' : ''} />
              <select class="form-input off-side-trip-caught-frequency" aria-label="掏手机被注意频率">${frequencyOptions(draft.sideTripCaught?.frequency)}</select>
            </label>
          </div>
          <label class="off-auto-reply-global">
            <input type="checkbox" class="off-auto-reply-global-input" />
            <span>设为以后线下的默认档位</span>
          </label>
        </div>
        <footer class="offline-settings-sheet-foot">
          <button type="button" class="btn btn-primary" data-auto-reply-save>保存</button>
        </footer>
      </div>`;
    container.appendChild(sheet);
    const sync = () => {
      sheet.querySelectorAll('[data-reply-mode]').forEach((btn) => {
        btn.classList.toggle('is-active', btn.getAttribute('data-reply-mode') === draft.mode);
      });
      const text = sheet.querySelector('.off-auto-reply-text-wrap');
      const proxy = sheet.querySelector('.off-auto-reply-proxy-wrap');
      if (text) text.hidden = draft.mode !== 'fixed';
      if (proxy) proxy.hidden = draft.mode !== 'companion';
    };
    sheet.querySelectorAll('[data-settings-close]').forEach((el) => el.addEventListener('click', closeSettingsSheet));
    sheet.querySelectorAll('[data-reply-mode]').forEach((btn) => btn.addEventListener('click', () => {
      draft.mode = btn.getAttribute('data-reply-mode') || 'off';
      sync();
    }));
    sheet.querySelector('[data-auto-reply-save]')?.addEventListener('click', async () => {
      draft.fixedText = String(sheet.querySelector('.off-auto-reply-text')?.value || '').trim();
      draft.proxyCharacterId = String(sheet.querySelector('.off-auto-reply-proxy')?.value || '');
      draft.incomingTakeover = {
        enabled: !!sheet.querySelector('.off-incoming-takeover-enabled')?.checked,
        frequency: String(sheet.querySelector('.off-incoming-takeover-frequency')?.value || 'medium'),
      };
      draft.sideTripCaught = {
        enabled: !!sheet.querySelector('.off-side-trip-caught-enabled')?.checked,
        frequency: String(sheet.querySelector('.off-side-trip-caught-frequency')?.value || 'medium'),
      };
      draft.phoneMessagesEnabled = !!sheet.querySelector('.off-phone-messages-enabled')?.checked;
      const saveButton = sheet.querySelector('[data-auto-reply-save]');
      if (saveButton) saveButton.disabled = true;
      session.scene = {
        ...(session.scene || {}),
        phoneMessagesEnabled: draft.phoneMessagesEnabled,
      };
      session.autoReply = {
        mode: draft.mode,
        fixedText: draft.fixedText,
        proxyCharacterId: draft.proxyCharacterId,
        incomingTakeover: { ...draft.incomingTakeover },
        sideTripCaught: { ...draft.sideTripCaught },
      };
      try {
        await saveOfflineSession(session);
      } catch (err) {
        console.warn('[offline-session] message settings save failed', err);
        if (saveButton) saveButton.disabled = false;
        showToast('消息设置保存失败，请重试');
        return;
      }
      if (sheet.querySelector('.off-auto-reply-global-input')?.checked) {
        try {
          const savedDefaults = await saveOfflineAutoReplySettings(user.id, {
            mode: draft.mode,
            fixedText: draft.fixedText,
            proxyCharacterId: draft.proxyCharacterId,
            incomingTakeover: draft.incomingTakeover,
            sideTripCaught: draft.sideTripCaught,
            phoneMessagesEnabled: draft.phoneMessagesEnabled,
          });
          Object.assign(globalAutoReply, savedDefaults);
        } catch (err) {
          console.warn('[offline-session] default message settings save failed', err);
          if (saveButton) saveButton.disabled = false;
          showToast('本场已保存，以后默认值保存失败，请重试');
          return;
        }
      }
      const state = container.querySelector('.offline-tool[data-tool="autoReply"] .offline-tool-state');
      if (state) state.textContent = autoReplyModeLabel(draft.mode);
      closeSettingsSheet();
      showToast('已保存消息设置');
    });
  }

  async function openSettingsSheet() {
    if (!session) return;
    closeSettingsSheet();
    settingsSheetOpen = true;
    // 预设页新建/导入后这里要重读，避免 Keep-Alive 会话一直用进页时的旧候选
    const [, freshRegexGroups] = await Promise.all([
      ensureSettingsCatalogs(),
      listRegexGroups().catch(() => null),
    ]);
    if (!container.isConnected) return;
    const cleanupGroups = Array.isArray(freshRegexGroups) ? freshRegexGroups : [];
    const degreeCleanupEnabled = cleanupGroups.find((group) => (
      group.id === BUILTIN_DEGREE_CLEANUP_GROUP_ID
    ))?.enabled !== false;
    const clicheCleanupEnabled = cleanupGroups.find((group) => (
      group.id === BUILTIN_CLICHE_CLEANUP_GROUP_ID
    ))?.enabled !== false;
    const sheet = document.createElement('div');
    sheet.className = 'offline-settings-sheet';
    sheet.innerHTML = `
      <div class="offline-settings-sheet-backdrop" data-settings-close></div>
      <div class="offline-settings-sheet-panel" role="dialog" aria-label="叙事设置">
        <header class="offline-settings-sheet-head">
          <h2>叙事设置</h2>
          <button type="button" class="navbar-btn" data-settings-close aria-label="关闭">${icon('close')}</button>
        </header>
        <div class="offline-settings-sheet-body">
          <div class="os-settings-preset">${scenePresetBarHtml(scenePresets, selectedPresetId)}</div>
          ${groupedMechanicsFieldsHtml(session.scene, getRegularAnonymousMemoryInjectMode(chat), {
            worldBookOptions,
            presetOptions,
            showEncounterModes: true,
            userPresent: isOfflineUserPresent(session, chat),
          })}
          <div class="off-settings-divider">正文清理</div>
          <label class="off-toggle-row">
            <input type="checkbox" class="off-regex-degree-cleanup" ${degreeCleanupEnabled ? 'checked' : ''} />
            <span>去掉“极其 / 极度 / 极为”</span>
          </label>
          <label class="off-toggle-row">
            <input type="checkbox" class="off-regex-cliche-cleanup" ${clicheCleanupEnabled ? 'checked' : ''} />
            <span>折叠“没有 / 不是”八股句（激进）</span>
          </label>
          <div class="off-settings-divider">重 roll</div>
          <label class="off-mode-toggle">
            <input type="checkbox" class="off-scene-retain-reroll-versions" ${session.scene?.retainRerollVersions === true ? 'checked' : ''} />
            <span><strong>保留多个版本</strong><small>仅本场生效；最多保留 5 版，关闭后清除候选</small></span>
          </label>
        </div>
        <footer class="offline-settings-sheet-foot">
          <button type="button" class="btn btn-primary" data-settings-save>保存设置</button>
        </footer>
      </div>`;
    container.appendChild(sheet);
    bindMechanicsCommonControls(sheet, {
      onApplyPreset: (id) => {
        const preset = scenePresets.find((p) => p.id === id);
        if (preset) {
          selectedPresetId = preset.id;
          applyMechanicsPresetToInputs(sheet, preset);
          setLastOfflineScenePresetId(user.id, preset.id).catch(() => {});
        } else {
          selectedPresetId = '';
        }
      },
    });
    sheet.querySelectorAll('[data-settings-close]').forEach((el) => {
      el.addEventListener('click', () => closeSettingsSheet());
    });
    sheet.querySelector('.off-preset-save')?.addEventListener('click', () => onSavePreset({ asNew: false }));
    sheet.querySelector('.off-preset-save-as')?.addEventListener('click', () => onSavePreset({ asNew: true }));
    sheet.querySelector('.off-preset-delete')?.addEventListener('click', onDeletePreset);
    sheet.querySelector('[data-settings-save]')?.addEventListener('click', async () => {
      const saved = await onSaveMechanicsFromSheet(sheet);
      if (saved !== false) {
        closeSettingsSheet();
        paint();
      }
    });
  }

  function onSavePreset({ asNew = false } = {}) {
    const sheet = container.querySelector('.offline-settings-sheet');
    const currentId = (sheet || container)?.querySelector('.off-preset-select')?.value;
    const current = scenePresets.find((p) => p.id === currentId);
    if (!asNew) {
      if (!current) {
        showToast('先选一个预设，或点「另存为」');
        return;
      }
      const draft = pickOfflineScenePresetFields(readMechanicsFromInputs(sheet || container, session?.scene || {}));
      saveOfflineScenePreset(user.id, { id: current.id, name: current.name, ...draft })
        .then(async (saved) => {
          scenePresets = await listOfflineScenePresets(user.id);
          selectedPresetId = saved.id;
          refreshPresetSelect(saved.id);
          showToast('已覆盖所选预设');
        })
        .catch((err) => showToast(`保存失败：${err?.message || err}`));
      return;
    }
    openTextEditorModal({
      title: '另存为新预设',
      value: current?.name || '',
      multiline: false,
      placeholder: '给这组叙事设置起个名字',
      confirmLabel: '保存',
      onSave: async (name) => {
        if (!name) { showToast('名字不能为空'); return; }
        const draft = pickOfflineScenePresetFields(readMechanicsFromInputs(sheet || container, session?.scene || {}));
        const saved = await saveOfflineScenePreset(user.id, { name, ...draft });
        scenePresets = await listOfflineScenePresets(user.id);
        selectedPresetId = saved.id;
        refreshPresetSelect(saved.id);
        showToast('已保存预设');
      },
    });
  }

  async function onDeletePreset() {
    const sheet = container.querySelector('.offline-settings-sheet');
    const id = (sheet || container).querySelector('.off-preset-select')?.value;
    if (!id) { showToast('先选一个预设'); return; }
    await deleteOfflineScenePreset(user.id, id);
    scenePresets = await listOfflineScenePresets(user.id);
    selectedPresetId = '';
    refreshPresetSelect();
    showToast('已删除预设');
  }

  async function onQueryPlaceInline() {
    if (!session) return;
    const btn = container.querySelector('.off-query-place');
    const place = container.querySelector('.off-scene-place')?.value || '';
    const goal = container.querySelector('.off-scene-goal')?.value || '';
    if (btn) { btn.disabled = true; btn.textContent = '查询中…'; }
    try {
      const result = await collectOfflinePlaceMaterial({ place, activity: goal, keywords: place });
      const material = String(result?.material || '').trim();
      const textarea = container.querySelector('.off-scene-place-material');
      if (textarea) textarea.value = material;
      session.scene = session.scene || {};
      session.scene.placeMaterial = material;
      await saveOfflineSession(session);
      if (!material) showToast('没查到相关信息，可以直接手动填地点');
      else showToast('已查到相关素材');
    } catch (err) {
      showToast(`查询失败：${err?.message || err}`);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '按地点查附近'; }
    }
  }

  async function dismissSettingsHint(openSettings) {
    if (!session) return;
    session.settingsHintSeen = true;
    await saveOfflineSession(session);
    const hint = container.querySelector('[data-settings-hint]');
    if (hint) hint.remove();
    if (openSettings) openSettingsSheet();
  }

  function onOpenSettingsHint() {
    dismissSettingsHint(true);
  }

  async function onSaveMechanicsFromSheet(sheet) {
    if (!session || !sheet) return;
    const mechanics = readMechanicsFromInputs(sheet, session.scene || {});
    if (mechanics.audioSceneEnabled && getActiveOfflineParticipantIds(session, chat).length !== 1) {
      showToast('音声版初版只支持一名在场角色');
      return false;
    }
    // 以库内最新会话为底再写回机制字段，避免内存 beats 落后时被 shrink 防护整单拒写，
    // 导致「场景与配图」看起来保存了、下次打开又没了。
    const latest = (await loadOfflineSessionWithMeta(chatId).catch(() => null))?.session;
    const base = latest && String(latest.id || '') === String(session.id || '')
      ? latest
      : session;
    base.scene = createSceneDraft({
      ...(base.scene || {}),
      ...mechanics,
      retainRerollVersions: sheet.querySelector('.off-scene-retain-reroll-versions')?.checked === true,
    });
    if (base.scene.retainRerollVersions !== true) base.rerollVersions = {};
    session = base;
    await saveWordRangePrefs(session.scene);
    const next = normalizeAnonMemoryInject(sheet.querySelector('.off-anon-memory-inject')?.value);
    chat.metadata = { ...(chat.metadata || {}), anonymousMemoryInject: next };
    await saveChat(chat);
    const saved = await saveOfflineSession(session);
    if (saved && String(saved.id || '') === String(session.id || '')) {
      session = saved;
      // 拒写时库内 scene 不会变；若机制未落上则明确提示，避免假成功。
      const persisted = session.scene || {};
      if (
        !!persisted.innerVoiceEnabled !== !!mechanics.innerVoiceEnabled
        || !!persisted.naturalEnsemble !== !!mechanics.naturalEnsemble
        || !!persisted.perBeatDigestEnabled !== !!mechanics.perBeatDigestEnabled
        || !!persisted.autoImagePerBeat !== !!mechanics.autoImagePerBeat
        || String(persisted.imageGenMode || '') !== String(mechanics.imageGenMode || '')
        || String(persisted.imagePromptTemplate || '') !== String(mechanics.imagePromptTemplate || '').trim()
        || String(persisted.imageStyleId || '') !== String(mechanics.imageStyleId || '')
        || !!persisted.audioStageSoundEnabled !== !!mechanics.audioStageSoundEnabled
        || Number(persisted.audioStageActionVolume) !== Number(mechanics.audioStageActionVolume)
        || Number(persisted.audioStageBackgroundVolume) !== Number(mechanics.audioStageBackgroundVolume)
        || !!persisted.retainRerollVersions
          !== !!sheet.querySelector('.off-scene-retain-reroll-versions')?.checked
      ) {
        showToast('叙事设置未能写入，请重试一次', 4000);
        return false;
      }
    }
    syncActiveAudioStageMix();
    try {
      const groups = await listRegexGroups();
      if (!groups.some((group) => group.id === BUILTIN_DEGREE_CLEANUP_GROUP_ID)) {
        groups.push(createBuiltinDegreeCleanupGroup());
      }
      if (!groups.some((group) => group.id === BUILTIN_CLICHE_CLEANUP_GROUP_ID)) {
        groups.push(createBuiltinClicheCleanupGroup());
      }
      const enabledById = new Map([
        [BUILTIN_DEGREE_CLEANUP_GROUP_ID, sheet.querySelector('.off-regex-degree-cleanup')?.checked === true],
        [BUILTIN_CLICHE_CLEANUP_GROUP_ID, sheet.querySelector('.off-regex-cliche-cleanup')?.checked === true],
      ]);
      groups.forEach((group) => {
        if (enabledById.has(group.id)) group.enabled = enabledById.get(group.id);
      });
      await saveRegexGroups(groups);
    } catch (error) {
      console.warn('[offline-session] narrative cleanup settings save failed', error);
      showToast('正文清理开关保存失败，请重试');
      return false;
    }
    const optState = container.querySelector('.offline-tool-state');
    if (optState) optState.textContent = session.scene?.optionCards ? '开' : '关';
    showToast('叙事设置已保存');
    return true;
  }

  async function onAdvanceDay() {
    if (!session) return;
    session = await advanceOfflineSceneDay(session);
    showToast(`已推进到第 ${Number(session.scene?.dayIndex || 0) + 1} 天`);
    paint();
  }

  async function onReplanTrip() {
    if (!session) return;
    const btn = container.querySelector('[data-trip-replan]');
    const notice = beginLongTaskNotice({
      title: '旅行行程已规划',
      body: '今天之后的行程已经更新',
      tag: `offline-trip-plan-${chatId}`,
      isStillViewing: () => container.isConnected,
    });
    if (btn) { btn.disabled = true; btn.textContent = '规划中…'; }
    try {
      session = await rerollTripItineraryFromToday({ session, chat, user });
      void notice.complete();
      showToast('行程已重新规划');
      paint();
    } catch (err) {
      notice.cancel();
      showToast(`失败：${err?.message || err}`);
      if (btn) { btn.disabled = false; btn.textContent = '重新规划从今天起的行程'; }
    }
  }

  async function onResolveCheckpoint(optionId) {
    if (!session || !optionId) return;
    const cpEl = container.querySelector('.offline-trip-checkpoint');
    if (cpEl) cpEl.remove();
    const { session: nextSession, directiveText } = await resolveTripCheckpointChoice(session, optionId);
    session = nextSession;
    const input = container.querySelector('.offline-directive');
    if (input) input.value = directiveText;
    await runAdvance({ directive: directiveText });
  }

  async function openAddParticipantModal() {
    if (!session) return;
    const allCharacters = (await listCharacters({
      excludeAnonNpc: true,
      userId: user.id,
      identityScoped: true,
    }).catch(() => []))
      .filter((c) => c?.id);
    allCharacters.forEach((row) => {
      const name = String(row.customNickname || row.name || row.realName || '').trim();
      if (name) thoughtCharacterNamesById.set(String(row.id), name);
    });
    const byId = new Map(allCharacters.map((c) => [String(c.id), c]));
    const attendance = getOfflineAttendanceMembers(session, chat);
    const attendanceById = new Map(attendance.map((row) => [row.characterId, row]));
    const rows = [
      ...attendance,
      ...allCharacters
        .filter((c) => !attendanceById.has(String(c.id)))
        .map((c) => ({ characterId: String(c.id), status: 'available', source: '' })),
    ];
    if (!rows.length) { showToast('没有可管理的角色'); return; }
    const host = document.getElementById('modal-container');
    if (!host) return;
    host.classList.add('active');
    const statusLabel = { active: '在场', pending: '待回应', left: '已离场', available: '' };
    const actionHtml = (row) => {
      if (row.status === 'active') return `<button type="button" class="btn btn-soft btn-sm" data-attendance-action="leave" data-cid="${esc(row.characterId)}">离场</button>`;
      if (row.status === 'pending') {
        return `<span class="offline-attendance-actions"><button type="button" class="btn btn-primary btn-sm" data-attendance-action="join" data-cid="${esc(row.characterId)}">已到场</button><button type="button" class="btn btn-soft btn-sm" data-attendance-action="withdraw" data-cid="${esc(row.characterId)}">撤回</button></span>`;
      }
      if (row.status === 'left') return `<button type="button" class="btn btn-outline btn-sm" data-attendance-action="invite" data-cid="${esc(row.characterId)}">再次邀请</button>`;
      return `<button type="button" class="btn btn-primary btn-sm" data-attendance-action="join" data-cid="${esc(row.characterId)}">叫来现场</button>`;
    };
    host.innerHTML = `
      <div class="modal-overlay offline-attendance-overlay" data-add-participant-overlay>
        <div class="modal-sheet scrapbook-card text-editor-sheet offline-attendance-sheet" role="dialog" aria-modal="true">
          <header class="modal-header">
            <h3>现场成员</h3>
            <button type="button" class="navbar-btn modal-close-btn" data-add-participant-close aria-label="关闭">${icon('back')}</button>
          </header>
          <div class="modal-body offline-add-participant-list">
            ${rows.map((row) => {
              const c = byId.get(row.characterId);
              const name = c?.customNickname || c?.name || 'TA';
              return `<div class="offline-add-participant-row" data-attendance-row="${esc(row.characterId)}"><span class="offline-attendance-name">${esc(name)}</span>${statusLabel[row.status] ? `<em>${statusLabel[row.status]}</em>` : ''}${actionHtml(row)}</div>`;
            }).join('')}
          </div>
        </div>
      </div>`;
    const close = () => { host.classList.remove('active'); host.innerHTML = ''; };
    host.querySelector('[data-add-participant-overlay]')?.addEventListener('click', close);
    host.querySelector('[data-add-participant-close]')?.addEventListener('click', close);
    host.querySelector('.text-editor-sheet')?.addEventListener('click', (e) => e.stopPropagation());
    host.querySelector('.offline-add-participant-list')?.addEventListener('click', async (event) => {
      const button = event.target.closest('[data-attendance-action]');
      if (!button) return;
      const cid = String(button.getAttribute('data-cid') || '');
      const action = String(button.getAttribute('data-attendance-action') || '');
      button.disabled = true;
      try {
        if (action === 'leave') {
          await leaveOfflineParticipant({ session, chat, characterId: cid, source: 'manual_manage' });
          showToast('已离开现场');
        } else if (action === 'invite') {
          await inviteOfflineParticipant({ session, chat, characterId: cid, source: 'manual_reinvite' });
          showToast('已再次邀请');
        } else if (action === 'withdraw') {
          await withdrawOfflineParticipantInvite({ session, chat, characterId: cid, source: 'manual_withdraw' });
          showToast('已撤回邀请');
        } else {
          await joinOfflineParticipant({ session, chat, characterId: cid, source: 'manual_add' });
          showToast('已经来到现场');
        }
        close();
        paint();
        openAddParticipantModal();
      } catch (err) {
        showToast(`失败：${err?.message || err}`);
        button.disabled = false;
      }
    });
  }

  /** 掏出手机：直接回 Chat；用户实际聊过哪些会话，回来时再按消息记录折成插曲。 */
  async function openPhoneSideTrip() {
    if (!session) return;
    try {
      await beginPhoneSideTrip(session);
      // 这是局内的正常动作，不弹「未收纳是否离开」；返回线下后 guard 会重新绑定。
      clearLeaveGuard();
      invalidateKeepAlive('chat');
      navigate('chat', { offlineChatId: chatId });
    } catch (err) {
      showToast(`失败：${err?.message || err}`);
    }
  }

  /** 音声舞台独立美化：不继承普通线下长卷的自定义 CSS。 */
  function openAudioStageStyleSheet() {
    const host = document.getElementById('modal-container');
    if (!host) return;
    const draft = { ...audioStylePrefs };
    activeAudioStyleDraft = draft;
    const preview = () => applyAudioStageAppearance(container, draft);
    const close = ({ restore = true } = {}) => {
      if (restore) applyAudioStageAppearance(container, audioStylePrefs);
      activeAudioStyleDraft = null;
      host.classList.remove('active');
      host.innerHTML = '';
    };
    host.classList.add('active');
    host.innerHTML = `
      <div class="modal-overlay" data-oas-style-overlay>
        <div class="modal-sheet scrapbook-card text-editor-sheet os-style-sheet" role="dialog" aria-modal="true" aria-label="音声舞台美化">
          <header class="modal-header">
            <h3>音声舞台美化</h3>
            <button type="button" class="navbar-btn modal-close-btn" data-oas-style-close aria-label="关闭">${icon('close')}</button>
          </header>
          <div class="modal-body os-style-body">
            <div class="os-style-row">
              <span class="os-style-label">显示模式</span>
              <div class="os-style-seg" role="radiogroup" aria-label="显示模式">
                ${[['auto', '跟随应用'], ['day', '日间'], ['night', '夜间']].map(([value, label]) => `
                  <button type="button" class="os-style-seg-btn ${draft.theme === value ? 'is-on' : ''}" data-oas-style-theme="${value}">${label}</button>`).join('')}
              </div>
            </div>
            <div class="os-style-row">
              <span class="os-style-label">舞台字体</span>
              <div class="os-style-seg" role="radiogroup" aria-label="舞台字体">
                ${[['serif', '宋体'], ['sans', '黑体'], ['rounded', '圆体'], ['custom', '自定义']].map(([value, label]) => `
                  <button type="button" class="os-style-seg-btn ${draft.font === value ? 'is-on' : ''}" data-oas-style-font="${value}">${label}</button>`).join('')}
              </div>
            </div>
            <label class="os-style-row" data-oas-custom-font-row ${draft.font === 'custom' ? '' : 'hidden'}>
              <span class="os-style-label">字体族</span>
              <input type="text" class="form-input" data-oas-font-family maxlength="160" value="${esc(draft.fontFamily)}" placeholder='例如 "霞鹜文楷", serif' />
            </label>
            ${[
              ['textColor', '正文颜色', 'data-oas-text-color'],
              ['mutedColor', '次要文字', 'data-oas-muted-color'],
              ['accentColor', '强调颜色', 'data-oas-accent-color'],
            ].map(([key, label, attr]) => `
              <label class="os-style-row">
                <span class="os-style-label">${label}</span>
                <div class="os-style-color-row">
                  <input type="color" ${attr} value="${esc(draft[key] || (key === 'textColor' ? '#292621' : key === 'mutedColor' ? '#746d64' : '#a57168'))}" aria-label="选择${label}" />
                  <input type="text" class="form-input" ${attr}-input value="${esc(draft[key])}" placeholder="跟随模式" />
                  <button type="button" class="btn btn-soft btn-sm" ${attr}-clear>恢复默认</button>
                </div>
              </label>`).join('')}
            <label class="os-style-row">
              <span class="os-style-label">正文字号 <em class="os-style-val" data-oas-size-val>${draft.size}px</em></span>
              <input type="range" class="os-style-range" data-oas-size min="14" max="22" step="1" value="${draft.size}" />
            </label>
            <label class="os-style-row">
              <span class="os-style-label">正文行距 <em class="os-style-val" data-oas-leading-val>${Number(draft.leading).toFixed(2)}</em></span>
              <input type="range" class="os-style-range" data-oas-leading min="1.4" max="2.3" step="0.05" value="${draft.leading}" />
            </label>
            <label class="os-style-row">
              <span class="os-style-label">字幕纸浓度 <em class="os-style-val" data-oas-paper-val>${Math.round(draft.paperOpacity * 100)}%</em></span>
              <input type="range" class="os-style-range" data-oas-paper min="0.68" max="1" step="0.02" value="${draft.paperOpacity}" />
            </label>
            <label class="os-style-row os-style-css-row">
              <span class="os-style-label">自定义 CSS <em class="os-style-val">只作用于音声舞台</em></span>
              <textarea class="form-input os-style-css" data-oas-css rows="5" spellcheck="false" placeholder=".offline-audio-dialogue-copy { letter-spacing: 0.06em; }">${esc(draft.css)}</textarea>
            </label>
            <div class="os-style-doc-actions">
              <button type="button" class="btn btn-outline btn-sm" data-oas-style-doc>CSS 参考文档</button>
              <button type="button" class="btn btn-soft btn-sm" data-oas-style-reset>恢复默认</button>
            </div>
            <div class="os-style-foot">
              <button type="button" class="btn btn-soft" data-oas-style-cancel>取消</button>
              <button type="button" class="btn btn-primary" data-oas-style-save>保存</button>
            </div>
          </div>
        </div>
      </div>`;

    const syncSeg = (name, value) => {
      host.querySelectorAll(`[data-oas-style-${name}]`).forEach((button) => {
        button.classList.toggle('is-on', button.getAttribute(`data-oas-style-${name}`) === value);
      });
    };
    host.querySelectorAll('[data-oas-style-theme]').forEach((button) => button.addEventListener('click', () => {
      draft.theme = button.getAttribute('data-oas-style-theme');
      syncSeg('theme', draft.theme);
      preview();
    }));
    host.querySelectorAll('[data-oas-style-font]').forEach((button) => button.addEventListener('click', () => {
      draft.font = button.getAttribute('data-oas-style-font');
      syncSeg('font', draft.font);
      const row = host.querySelector('[data-oas-custom-font-row]');
      if (row) row.hidden = draft.font !== 'custom';
      preview();
    }));
    host.querySelector('[data-oas-font-family]')?.addEventListener('input', (event) => {
      draft.fontFamily = String(event.target?.value || '');
      preview();
    });
    const bindColor = (selector, key, fallback) => {
      const picker = host.querySelector(`[${selector}]`);
      const input = host.querySelector(`[${selector}-input]`);
      const clear = host.querySelector(`[${selector}-clear]`);
      picker?.addEventListener('input', () => {
        draft[key] = picker.value;
        if (input) input.value = draft[key];
        preview();
      });
      input?.addEventListener('change', () => {
        const value = String(input.value || '').trim();
        if (value && !/^#[0-9a-f]{6}$/i.test(value)) {
          showToast('颜色请填写 6 位十六进制，例如 #e8e4dc');
          input.value = draft[key];
          return;
        }
        draft[key] = value;
        if (value && picker) picker.value = value;
        preview();
      });
      clear?.addEventListener('click', () => {
        draft[key] = '';
        if (input) input.value = '';
        if (picker) picker.value = fallback;
        preview();
      });
    };
    bindColor('data-oas-text-color', 'textColor', '#292621');
    bindColor('data-oas-muted-color', 'mutedColor', '#746d64');
    bindColor('data-oas-accent-color', 'accentColor', '#a57168');
    host.querySelector('[data-oas-size]')?.addEventListener('input', (event) => {
      draft.size = Number(event.target?.value) || OFFLINE_AUDIO_STYLE_DEFAULTS.size;
      const value = host.querySelector('[data-oas-size-val]');
      if (value) value.textContent = `${draft.size}px`;
      preview();
    });
    host.querySelector('[data-oas-leading]')?.addEventListener('input', (event) => {
      draft.leading = Number(event.target?.value) || OFFLINE_AUDIO_STYLE_DEFAULTS.leading;
      const value = host.querySelector('[data-oas-leading-val]');
      if (value) value.textContent = draft.leading.toFixed(2);
      preview();
    });
    host.querySelector('[data-oas-paper]')?.addEventListener('input', (event) => {
      draft.paperOpacity = Number(event.target?.value) || OFFLINE_AUDIO_STYLE_DEFAULTS.paperOpacity;
      const value = host.querySelector('[data-oas-paper-val]');
      if (value) value.textContent = `${Math.round(draft.paperOpacity * 100)}%`;
      preview();
    });
    host.querySelector('[data-oas-css]')?.addEventListener('input', (event) => {
      draft.css = String(event.target?.value || '');
      preview();
    });
    host.querySelector('[data-oas-style-doc]')?.addEventListener('click', async () => {
      try {
        await downloadTextFile(
          buildOfflineAudioAppearanceReferenceMarkdown(),
          `marshmallow-offline-audio-css-reference-${Date.now()}.md`,
        );
        showToast('音声舞台 CSS 参考文档已下载');
      } catch (err) {
        showToast(`下载失败：${err?.message || err}`);
      }
    });
    host.querySelector('[data-oas-style-reset]')?.addEventListener('click', async () => {
      try {
        audioStylePrefs = await saveOfflineAudioStylePrefs(user.id, OFFLINE_AUDIO_STYLE_DEFAULTS, { reason: 'reset' });
        applyAudioStageAppearance(container, audioStylePrefs);
        close({ restore: false });
        showToast('已恢复音声舞台默认外观');
      } catch (err) {
        showToast(`恢复失败：${err?.message || err}`);
      }
    });
    host.querySelector('[data-oas-style-save]')?.addEventListener('click', async () => {
      try {
        audioStylePrefs = await saveOfflineAudioStylePrefs(user.id, draft);
        applyAudioStageAppearance(container, audioStylePrefs);
        close({ restore: false });
        showToast('音声舞台美化已保存');
      } catch (err) {
        showToast(`保存失败：${err?.message || err}`);
      }
    });
    host.querySelector('[data-oas-style-cancel]')?.addEventListener('click', () => close());
    host.querySelector('[data-oas-style-close]')?.addEventListener('click', () => close());
    host.querySelector('[data-oas-style-overlay]')?.addEventListener('click', (event) => {
      if (event.target === event.currentTarget) close();
    });
    preview();
  }

  /** 自定义美化：token 级偏好，实时预览，保存后跨场次生效 */
  async function openStyleSheet() {
    const host = document.getElementById('modal-container');
    if (!host) return;
    const draft = { ...stylePrefs };
    activeStyleDraft = draft;
    let stylePresets = await listOfflineStylePresets(user.id).catch(() => []);
    const innerVoicePresets = await loadInnerVoiceCardPresets().catch(() => []);
    const innerVoiceSourceValue = draft.innerVoiceCardSource === 'custom' ? 'custom' : 'chat';
    const innerVoiceCustomLabel = draft.innerVoiceCardName || '当前线下独立方案';
    const preview = () => applyStylePrefs(container, draft);
    host.classList.add('active');
    host.innerHTML = `
      <div class="modal-overlay" data-style-overlay>
        <div class="modal-sheet scrapbook-card text-editor-sheet os-style-sheet" role="dialog" aria-modal="true" aria-label="美化界面">
          <header class="modal-header">
            <h3>美化界面</h3>
            <button type="button" class="navbar-btn modal-close-btn" data-style-close aria-label="关闭">${icon('close')}</button>
          </header>
          <div class="modal-body os-style-body">
            <div class="os-style-presets">
              <div class="os-style-preset-row">
                <select class="form-input os-style-preset-select" data-style-preset aria-label="线下美化预设">
                  <option value="">选择共享美化预设</option>
                  ${stylePresets.map((item) => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join('')}
                </select>
                <button type="button" class="btn btn-outline btn-sm" data-style-preset-apply>应用</button>
                <button type="button" class="btn btn-soft btn-sm" data-style-preset-delete>删除</button>
              </div>
              <div class="os-style-preset-save-row">
                <input type="text" class="form-input" data-style-preset-name maxlength="24" placeholder="预设名称" />
                <button type="button" class="btn btn-outline btn-sm" data-style-preset-save>另存为预设</button>
              </div>
            </div>
            <div class="os-style-row">
              <span class="os-style-label">底色</span>
              <div class="os-style-seg" role="radiogroup" aria-label="底色">
                ${[['white', '纯白'], ['paper', '暖纸'], ['dusk', '暮色']].map(([v, t]) => `
                  <button type="button" class="os-style-seg-btn ${draft.bg === v ? 'is-on' : ''}" data-style-bg="${v}">${t}</button>`).join('')}
              </div>
            </div>
            <div class="os-style-row">
              <span class="os-style-label">底图</span>
              <div class="os-style-seg">
                <button type="button" class="os-style-seg-btn" data-style-bg-upload>${draft.bgImage ? '换一张底图' : '上传底图'}</button>
                <button type="button" class="os-style-seg-btn" data-style-bg-clear ${draft.bgImage ? '' : 'hidden'}>移除底图</button>
              </div>
              <input type="file" accept="image/*" data-style-bg-file hidden />
            </div>
            <label class="os-style-row" data-style-veil-row ${draft.bgImage ? '' : 'hidden'}>
              <span class="os-style-label">蒙版浓度 <em class="os-style-val" data-style-veil-val>${Math.round(draft.veil * 100)}%</em></span>
              <input type="range" class="os-style-range" data-style-veil min="0.4" max="0.96" step="0.02" value="${draft.veil}" />
            </label>
            <div class="os-style-row">
              <span class="os-style-label">正文字体</span>
              <div class="os-style-seg" role="radiogroup" aria-label="正文字体">
                ${[['serif', '衬线'], ['sans', '黑体']].map(([v, t]) => `
                  <button type="button" class="os-style-seg-btn ${draft.font === v ? 'is-on' : ''}" data-style-font="${v}">${t}</button>`).join('')}
              </div>
            </div>
            <label class="os-style-row">
              <span class="os-style-label">正文颜色</span>
              <div class="os-style-color-row">
                <input type="color" data-style-text-color value="${esc(draft.textColor || (draft.bg === 'dusk' ? '#e8e4dc' : '#3f3832'))}" aria-label="选择正文颜色" />
                <input type="text" class="form-input" data-style-text-color-input value="${esc(draft.textColor)}" placeholder="跟随底色" />
                <button type="button" class="btn btn-soft btn-sm" data-style-text-color-clear>恢复默认</button>
              </div>
            </label>
            <label class="os-style-row">
              <span class="os-style-label">字号 <em class="os-style-val" data-style-size-val>${draft.size}px</em></span>
              <input type="range" class="os-style-range" data-style-size min="14" max="20" step="1" value="${draft.size}" />
            </label>
            <label class="os-style-row">
              <span class="os-style-label">行距 <em class="os-style-val" data-style-leading-val>${draft.leading.toFixed(2)}</em></span>
              <input type="range" class="os-style-range" data-style-leading min="1.5" max="2.3" step="0.05" value="${draft.leading}" />
            </label>
            <div class="os-style-row">
              <span class="os-style-label">正文宽度</span>
              <div class="os-style-seg" role="radiogroup" aria-label="正文宽度">
                ${[['cozy', '舒适'], ['wide', '铺满']].map(([v, t]) => `
                  <button type="button" class="os-style-seg-btn ${draft.measure === v ? 'is-on' : ''}" data-style-measure="${v}">${t}</button>`).join('')}
              </div>
            </div>
            <label class="os-style-row os-style-row--check">
              <input type="checkbox" data-style-anchor ${draft.anchor ? 'checked' : ''} />
              <span>显示时空锚与装饰</span>
            </label>
            <label class="os-style-row os-style-row--check">
              <input type="checkbox" data-style-timeline-nav ${draft.timelineNav ? 'checked' : ''} />
              <span>显示右侧楼层导航</span>
            </label>
            <label class="os-style-row os-style-row--check">
              <input type="checkbox" data-style-reasoning ${draft.showReasoning ? 'checked' : ''} />
              <span>显示思维链</span>
            </label>
            <label class="os-style-row">
              <span class="os-style-label">心声方案</span>
              <select class="form-input" data-style-inner-voice>
                <option value="chat" ${innerVoiceSourceValue === 'chat' ? 'selected' : ''}>沿用关联会话</option>
                ${innerVoiceSourceValue === 'custom'
                  ? `<option value="custom" selected>${esc(innerVoiceCustomLabel)}</option>`
                  : ''}
                ${innerVoicePresets.map((item) => `<option value="preset:${esc(item.id)}">${esc(item.name)}</option>`).join('')}
              </select>
              <button type="button" class="btn btn-outline btn-sm" data-style-inner-voice-import>导入方案</button>
              <input type="file" accept=".json,.txt,application/json,text/plain" data-style-inner-voice-file hidden />
            </label>
            <label class="os-style-row">
              <span class="os-style-label">自定义 CSS <em class="os-style-val">只作用于本页</em></span>
              <textarea class="form-input os-style-css" data-style-css rows="4" spellcheck="false" placeholder="p { letter-spacing: 0.02em; }&#10;.offline-beat--narration { ... }">${esc(draft.css)}</textarea>
            </label>
            <div class="os-style-doc-actions">
              <button type="button" class="btn btn-outline btn-sm" data-style-doc>CSS 参考文档</button>
              <button type="button" class="btn btn-outline btn-sm" data-style-import>导入文档</button>
              <input type="file" accept=".css,.txt,.md,text/css,text/plain,text/markdown" data-style-import-file hidden />
            </div>
            <div class="os-style-foot">
              <button type="button" class="btn btn-outline" data-style-reset>恢复默认</button>
              <button type="button" class="btn btn-primary" data-style-save>保存</button>
            </div>
          </div>
        </div>
      </div>`;
    const close = (revert) => {
      if (revert) applyStylePrefs(container, stylePrefs);
      if (activeStyleDraft === draft) activeStyleDraft = null;
      host.classList.remove('active');
      host.innerHTML = '';
    };
    const syncSeg = (attr, value) => {
      host.querySelectorAll(`[data-style-${attr}]`).forEach((btn) => {
        if (btn.tagName === 'BUTTON') btn.classList.toggle('is-on', btn.getAttribute(`data-style-${attr}`) === value);
      });
    };
    host.querySelector('[data-style-overlay]')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) close(true);
    });
    host.querySelector('[data-style-close]')?.addEventListener('click', () => close(true));
    host.querySelectorAll('button[data-style-bg]').forEach((btn) => btn.addEventListener('click', () => {
      draft.bg = btn.getAttribute('data-style-bg');
      syncSeg('bg', draft.bg);
      preview();
    }));
    host.querySelectorAll('button[data-style-font]').forEach((btn) => btn.addEventListener('click', () => {
      draft.font = btn.getAttribute('data-style-font');
      syncSeg('font', draft.font);
      preview();
    }));
    host.querySelectorAll('button[data-style-measure]').forEach((btn) => btn.addEventListener('click', () => {
      draft.measure = btn.getAttribute('data-style-measure');
      syncSeg('measure', draft.measure);
      preview();
    }));
    host.querySelector('[data-style-size]')?.addEventListener('input', (e) => {
      draft.size = Number(e.target.value) || OFFLINE_STYLE_DEFAULTS.size;
      const val = host.querySelector('[data-style-size-val]');
      if (val) val.textContent = `${draft.size}px`;
      preview();
    });
    host.querySelector('[data-style-leading]')?.addEventListener('input', (e) => {
      draft.leading = Number(e.target.value) || OFFLINE_STYLE_DEFAULTS.leading;
      const val = host.querySelector('[data-style-leading-val]');
      if (val) val.textContent = draft.leading.toFixed(2);
      preview();
    });
    host.querySelector('[data-style-anchor]')?.addEventListener('change', (e) => {
      draft.anchor = !!e.target.checked;
      preview();
    });
    host.querySelector('[data-style-timeline-nav]')?.addEventListener('change', (e) => {
      draft.timelineNav = !!e.target.checked;
      draft.timelineNavConfigured = true;
      preview();
    });
    host.querySelector('[data-style-reasoning]')?.addEventListener('change', (e) => {
      draft.showReasoning = !!e.target.checked;
      preview();
    });
    const bgFileInput = host.querySelector('[data-style-bg-file]');
    const syncBgControls = () => {
      const upBtn = host.querySelector('[data-style-bg-upload]');
      if (upBtn) upBtn.textContent = draft.bgImage ? '换一张底图' : '上传底图';
      const clearBtn = host.querySelector('[data-style-bg-clear]');
      if (clearBtn) clearBtn.hidden = !draft.bgImage;
      const veilRow = host.querySelector('[data-style-veil-row]');
      if (veilRow) veilRow.hidden = !draft.bgImage;
    };
    const syncDraftControls = () => {
      syncSeg('bg', draft.bg);
      syncSeg('font', draft.font);
      syncSeg('measure', draft.measure);
      const sizeInput = host.querySelector('[data-style-size]');
      if (sizeInput) sizeInput.value = String(draft.size);
      const sizeVal = host.querySelector('[data-style-size-val]');
      if (sizeVal) sizeVal.textContent = `${draft.size}px`;
      const leadInput = host.querySelector('[data-style-leading]');
      if (leadInput) leadInput.value = String(draft.leading);
      const leadVal = host.querySelector('[data-style-leading-val]');
      if (leadVal) leadVal.textContent = Number(draft.leading).toFixed(2);
      const textColor = host.querySelector('[data-style-text-color]');
      if (textColor) textColor.value = draft.textColor || (draft.bg === 'dusk' ? '#e8e4dc' : '#3f3832');
      const textColorInput = host.querySelector('[data-style-text-color-input]');
      if (textColorInput) textColorInput.value = draft.textColor;
      const anchorInput = host.querySelector('[data-style-anchor]');
      if (anchorInput) anchorInput.checked = draft.anchor;
      const timelineNavInput = host.querySelector('[data-style-timeline-nav]');
      if (timelineNavInput) timelineNavInput.checked = draft.timelineNav;
      const reasoningInput = host.querySelector('[data-style-reasoning]');
      if (reasoningInput) reasoningInput.checked = draft.showReasoning;
      const cssInput = host.querySelector('[data-style-css]');
      if (cssInput) cssInput.value = draft.css;
      const innerVoiceSelect = host.querySelector('[data-style-inner-voice]');
      if (innerVoiceSelect) innerVoiceSelect.value = draft.innerVoiceCardSource === 'custom' ? 'custom' : 'chat';
      const veilInput = host.querySelector('[data-style-veil]');
      if (veilInput) veilInput.value = String(draft.veil);
      const veilVal = host.querySelector('[data-style-veil-val]');
      if (veilVal) veilVal.textContent = `${Math.round(draft.veil * 100)}%`;
      syncBgControls();
      preview();
    };
    host.querySelector('[data-style-bg-upload]')?.addEventListener('click', () => bgFileInput?.click());
    bgFileInput?.addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!file) return;
      try {
        draft.bgImage = await readBgImageFile(file);
        syncBgControls();
        preview();
      } catch (err) {
        showToast(String(err?.message || err));
      }
    });
    host.querySelector('[data-style-bg-clear]')?.addEventListener('click', () => {
      draft.bgImage = '';
      syncBgControls();
      preview();
    });
    host.querySelector('[data-style-veil]')?.addEventListener('input', (e) => {
      draft.veil = Number(e.target.value) || OFFLINE_STYLE_DEFAULTS.veil;
      const val = host.querySelector('[data-style-veil-val]');
      if (val) val.textContent = `${Math.round(draft.veil * 100)}%`;
      preview();
    });
    const textColor = host.querySelector('[data-style-text-color]');
    const textColorInput = host.querySelector('[data-style-text-color-input]');
    textColor?.addEventListener('input', () => {
      draft.textColor = textColor.value;
      if (textColorInput) textColorInput.value = draft.textColor;
      preview();
    });
    textColorInput?.addEventListener('change', () => {
      const value = String(textColorInput.value || '').trim();
      if (value && !/^#[0-9a-f]{6}$/i.test(value)) {
        showToast('请填 #RRGGBB 或留空');
        textColorInput.value = draft.textColor;
        return;
      }
      draft.textColor = value;
      if (value && textColor) textColor.value = value;
      preview();
    });
    host.querySelector('[data-style-text-color-clear]')?.addEventListener('click', () => {
      draft.textColor = '';
      if (textColorInput) textColorInput.value = '';
      if (textColor) textColor.value = draft.bg === 'dusk' ? '#e8e4dc' : '#3f3832';
      preview();
    });
    host.querySelector('[data-style-css]')?.addEventListener('input', (e) => {
      draft.css = String(e.target.value || '');
      preview();
    });
    const innerVoiceSelect = host.querySelector('[data-style-inner-voice]');
    innerVoiceSelect?.addEventListener('change', () => {
      const value = String(innerVoiceSelect.value || 'chat');
      if (value === 'chat') {
        draft.innerVoiceCardSource = 'chat';
        draft.innerVoiceCardName = '';
        draft.innerVoiceCard = null;
        showToast('线下心声将沿用关联会话');
        return;
      }
      if (value === 'custom') return;
      const presetId = value.startsWith('preset:') ? value.slice(7) : '';
      const preset = innerVoicePresets.find((item) => item.id === presetId);
      if (!preset) return;
      draft.innerVoiceCardSource = 'custom';
      draft.innerVoiceCardName = preset.name;
      draft.innerVoiceCard = presetToCard(preset);
      let customOption = innerVoiceSelect.querySelector('option[value="custom"]');
      if (!customOption) {
        customOption = document.createElement('option');
        customOption.value = 'custom';
        innerVoiceSelect.insertBefore(customOption, innerVoiceSelect.options[1] || null);
      }
      customOption.textContent = preset.name;
      innerVoiceSelect.value = 'custom';
      showToast(`已选用心声方案「${preset.name}」`);
    });
    const innerVoiceFile = host.querySelector('[data-style-inner-voice-file]');
    host.querySelector('[data-style-inner-voice-import]')?.addEventListener('click', () => innerVoiceFile?.click());
    innerVoiceFile?.addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!file) return;
      try {
        draft.innerVoiceCard = parseInnerVoiceCardImportText(await file.text(), 'diary');
        draft.innerVoiceCardSource = 'custom';
        draft.innerVoiceCardName = String(file.name || '导入的心声方案').replace(/\.(?:json|txt)$/i, '').slice(0, 40);
        let customOption = innerVoiceSelect?.querySelector('option[value="custom"]');
        if (!customOption && innerVoiceSelect) {
          customOption = document.createElement('option');
          customOption.value = 'custom';
          innerVoiceSelect.insertBefore(customOption, innerVoiceSelect.options[1] || null);
        }
        if (customOption) customOption.textContent = draft.innerVoiceCardName || '导入的心声方案';
        if (innerVoiceSelect) innerVoiceSelect.value = 'custom';
        showToast('心声方案已导入，保存后用于线下');
      } catch (err) {
        showToast(`导入失败：${err?.message || err}`);
      }
    });
    host.querySelector('[data-style-doc]')?.addEventListener('click', async () => {
      try {
        await downloadTextFile(
          buildOfflineAppearanceReferenceMarkdown(),
          `marshmallow-offline-css-reference-${Date.now()}.md`,
        );
        showToast('线下 CSS 参考文档已下载');
      } catch (err) {
        showToast(`下载失败：${err?.message || err}`);
      }
    });
    const importFile = host.querySelector('[data-style-import-file]');
    host.querySelector('[data-style-import]')?.addEventListener('click', () => importFile?.click());
    importFile?.addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!file) return;
      try {
        draft.css = parseOfflineStyleDocument(await file.text(), { fileName: file.name });
        syncDraftControls();
        showToast('文档已导入，确认效果后保存');
      } catch (err) {
        showToast(`导入失败：${err?.message || err}`);
      }
    });
    host.querySelector('[data-style-preset-apply]')?.addEventListener('click', () => {
      const id = String(host.querySelector('[data-style-preset]')?.value || '');
      const preset = stylePresets.find((item) => item.id === id);
      if (!preset) {
        showToast('请先选择预设');
        return;
      }
      Object.assign(draft, offlineStylePresetToPrefs(preset));
      syncDraftControls();
      showToast('预设已应用，确认后保存');
    });
    host.querySelector('[data-style-preset-save]')?.addEventListener('click', async () => {
      const input = host.querySelector('[data-style-preset-name]');
      const name = String(input?.value || '').trim();
      if (!name) {
        showToast('请填写预设名称');
        input?.focus();
        return;
      }
      try {
        const saved = await saveOfflineStylePreset(user.id, name, draft);
        stylePresets = await listOfflineStylePresets(user.id);
        const select = host.querySelector('[data-style-preset]');
        if (select) {
          select.innerHTML = `<option value="">选择共享美化预设</option>${stylePresets.map((item) => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join('')}`;
          select.value = saved.id;
        }
        if (input) input.value = '';
        showToast('已保存为跨档位共享预设');
      } catch (err) {
        showToast(`保存失败：${err?.message || err}`);
      }
    });
    host.querySelector('[data-style-preset-delete]')?.addEventListener('click', async () => {
      const select = host.querySelector('[data-style-preset]');
      const id = String(select?.value || '');
      const preset = stylePresets.find((item) => item.id === id);
      if (!preset) {
        showToast('请先选择预设');
        return;
      }
      if (!window.confirm(`删除线下美化预设“${preset.name}”？`)) return;
      try {
        stylePresets = await deleteOfflineStylePreset(user.id, id);
        if (select) {
          select.innerHTML = `<option value="">选择共享美化预设</option>${stylePresets.map((item) => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join('')}`;
        }
        showToast('预设已删除');
      } catch (err) {
        showToast(`删除失败：${err?.message || err}`);
      }
    });
    host.querySelector('[data-style-reset]')?.addEventListener('click', () => {
      Object.assign(draft, OFFLINE_STYLE_DEFAULTS);
      syncDraftControls();
    });
    host.querySelector('[data-style-save]')?.addEventListener('click', async () => {
      try {
        Object.assign(stylePrefs, normalizeStylePrefs(draft));
        applyStylePrefs(container, stylePrefs);
        await saveOfflineStylePrefs(user.id, stylePrefs);
        close(false);
        showToast('已保存美化偏好');
      } catch (err) {
        showToast(`保存失败：${err?.message || err}`);
      }
    });
  }

  function openExpandEditor() {
    const input = container.querySelector('.offline-directive');
    openTextEditorModal({
      title: '本轮方向',
      value: input?.value || '',
      placeholder: '写下这一轮想发生什么（回车换行分段）',
      multiline: true,
      confirmLabel: '填入',
      onSave: (next) => {
        if (!input) return;
        setDirectiveDraft(next);
      },
    });
  }

  function syncDirectiveClearButton(input = container.querySelector('.offline-directive')) {
    const clearButton = container.querySelector('[data-clear-directive]');
    if (clearButton) clearButton.hidden = !String(input?.value || '').length;
  }

  function setDirectiveDraft(value, { focus = false } = {}) {
    const input = container.querySelector('.offline-directive');
    if (!input) return;
    const next = String(value || '');
    input.value = next;
    if (session) {
      session.uiState = { ...(session.uiState || {}), directiveDraft: next };
    }
    syncDirectiveTextareaHeight(input);
    syncDirectiveClearButton(input);
    if (focus) {
      input.focus();
      input.setSelectionRange(next.length, next.length);
    }
  }

  function selectedOptionsDirective() {
    return selectedOptionChoices
      .map((choice, index) => `${index === 0 ? '先' : '随后'}：${choice}`)
      .join('\n');
  }

  async function toggleOptionCards() {
    if (!session) return;
    session.scene = session.scene || {};
    if (session.scene.audioSceneEnabled === true) {
      session.scene.optionCards = true;
      showToast('音声版固定保留对白选项，也可以直接输入');
      renderOptionsFromSession();
      return;
    }
    session.scene.optionCards = !session.scene.optionCards;
    await saveOfflineSession(session);
    const state = container.querySelector('.offline-tool[data-tool="options"] .offline-tool-state');
    if (state) state.textContent = session.scene.optionCards ? '开' : '关';
    const checkbox = container.querySelector('.off-scene-optioncards');
    if (checkbox) checkbox.checked = session.scene.optionCards;
    if (!session.scene.optionCards) renderOptions([]);
    else { showToast('已开启：下一轮推进会在文末附走向选项'); renderOptionsFromSession(); }
  }

  async function toggleNaturalEnsemble() {
    if (!session || session.scene?.audioSceneEnabled === true) return;
    session.scene = session.scene || {};
    session.scene.naturalEnsemble = session.scene.naturalEnsemble !== true;
    await saveOfflineSession(session);
    const state = container.querySelector('.offline-tool[data-tool="ensemble"] .offline-tool-state');
    if (state) state.textContent = session.scene.naturalEnsemble ? '开' : '关';
    const checkbox = container.querySelector('.off-scene-natural-ensemble');
    if (checkbox) checkbox.checked = session.scene.naturalEnsemble;
    showToast(session.scene.naturalEnsemble
      ? '已开启自然群像：按剧情选择本轮焦点角色'
      : '已关闭自然群像：恢复全员在场模式');
  }

  function renderOptionsFromSession() {
    if (!session?.scene?.optionCards) { renderOptions([]); return; }
    const lastNarration = [...(session.beats || [])].reverse().find((b) => b.role === 'narration');
    renderOptions(Array.isArray(lastNarration?.options) ? lastNarration.options : []);
  }

  function renderOptions(list, { pending = false } = {}) {
    const box = container.querySelector('.offline-options');
    if (!box) return;
    const audioSceneEnabled = session?.scene?.audioSceneEnabled === true;
    if (audioSceneEnabled && isAdvancing) {
      // 生成状态已经在字幕纸的名牌中显示。横屏下再挂一层选项等待页，
      // 会把同一条“语音准备中”拆到左右两边，还会遮住场景画面。
      box.hidden = true;
      box.innerHTML = '';
      return;
    }
    if (audioSceneEnabled && (pending || !audioStageChoicesOpen)) {
      box.hidden = true;
      box.innerHTML = '';
      return;
    }
    if (!Array.isArray(list) || !list.length) {
      selectedOptionChoices = [];
      if (pending) {
        box.hidden = false;
        box.innerHTML = `
          <div class="offline-options-head">
            <span class="offline-options-title">${audioSceneEnabled ? '正在准备对白…' : '正在生成走向…'}</span>
          </div>
          <div class="offline-options-pending" aria-live="polite">
            <i></i><i></i><i></i>
          </div>`;
        return;
      }
      box.hidden = true;
      box.innerHTML = '';
      return;
    }
    const letters = ['A', 'B', 'C', 'D'];
    selectedOptionChoices = selectedOptionChoices.filter((choice) => list.includes(choice));
    box.hidden = false;
    if (audioSceneEnabled) {
      box.innerHTML = `
        <section class="offline-audio-choices" aria-label="选择对白">
          <span>此刻，你想……</span>
          ${list.map((opt, i) => `<button type="button" class="offline-option-chip" data-opt="${esc(opt)}"><b>${letters[i] || '·'}</b><span>${esc(applyDisplayRegex(opt, 'offline'))}</span></button>`).join('')}
          <button type="button" class="offline-audio-custom-choice" data-audio-custom-choice>${icon('edit')}<span>写下自己的回应</span></button>
        </section>`;
      box.querySelectorAll('[data-opt]').forEach((btn) => {
        btn.addEventListener('click', (event) => {
          if (isAdvancing) return;
          const choice = btn.getAttribute('data-opt') || '';
          box.querySelectorAll('button').forEach((button) => { button.disabled = true; });
          btn.classList.add('is-selected');
          const input = container.querySelector('.offline-directive');
          if (input) input.value = choice;
          audioStageProgressLabel = '已选择，正在生成下一幕…';
          audioStageChoicesOpen = false;
          persistAudioStageState();
          renderAudioStage();
          showToast('已选择，正在推进下一幕…');
          void onAdvance(event, choice);
        });
      });
      box.querySelector('[data-audio-custom-choice]')?.addEventListener('click', () => {
        audioStageChoicesOpen = false;
        audioStageInputOpen = true;
        persistAudioStageState();
        renderOptions([]);
        renderAudioStage();
        window.requestAnimationFrame(() => container.querySelector('.offline-audio-input .offline-directive')?.focus());
      });
      return;
    }
    box.innerHTML = `
      <div class="offline-options-head">
        <span class="offline-options-title">${pending ? (audioSceneEnabled ? '正在准备对白…' : '正在生成走向…') : (audioSceneEnabled ? '选择你要说的话，或直接输入' : '走向选项（可多选）')}</span>
        <button type="button" class="offline-options-collapse">${optionsCollapsed ? '展开' : '收起'}</button>
      </div>
      <div class="offline-options-list" ${optionsCollapsed ? 'hidden' : ''}>
        ${list.map((opt, i) => `<button type="button" class="offline-option-chip ${selectedOptionChoices.includes(opt) ? 'is-selected' : ''}" data-opt="${esc(opt)}" aria-pressed="${selectedOptionChoices.includes(opt) ? 'true' : 'false'}" ${pending ? 'disabled' : ''}><b>${letters[i] || '·'}</b><span>${esc(applyDisplayRegex(opt, 'offline'))}</span></button>`).join('')}
      </div>
      <div class="offline-options-actions" ${optionsCollapsed ? 'hidden' : ''}>
        <button type="button" class="offline-options-clear" ${selectedOptionChoices.length ? '' : 'disabled'}>清空</button>
        <button type="button" class="offline-options-apply" ${selectedOptionChoices.length ? '' : 'disabled'}>填入并编辑${selectedOptionChoices.length > 1 ? `（${selectedOptionChoices.length}）` : ''}</button>
      </div>`;
    box.querySelector('.offline-options-collapse')?.addEventListener('click', () => {
      optionsCollapsed = !optionsCollapsed;
      const listEl = box.querySelector('.offline-options-list');
      const btn = box.querySelector('.offline-options-collapse');
      if (listEl) listEl.hidden = optionsCollapsed;
      const actions = box.querySelector('.offline-options-actions');
      if (actions) actions.hidden = optionsCollapsed;
      if (btn) btn.textContent = optionsCollapsed ? '展开' : '收起';
    });
    box.querySelectorAll('[data-opt]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const choice = btn.getAttribute('data-opt') || '';
        selectedOptionChoices = selectedOptionChoices.includes(choice)
          ? selectedOptionChoices.filter((item) => item !== choice)
          : [...selectedOptionChoices, choice];
        setDirectiveDraft(selectedOptionsDirective());
        renderOptions(list, { pending });
      });
    });
    box.querySelector('.offline-options-clear')?.addEventListener('click', () => {
      selectedOptionChoices = [];
      setDirectiveDraft('');
      renderOptions(list, { pending });
    });
    box.querySelector('.offline-options-apply')?.addEventListener('click', () => {
      if (!selectedOptionChoices.length || isAdvancing) return;
      setDirectiveDraft(selectedOptionsDirective(), { focus: true });
    });
  }

  function scrollToBottom() {
    const scroll = container.querySelector('.offline-scroll');
    if (scroll) scroll.scrollTop = scroll.scrollHeight;
  }

  // 最终正文落库会同时重建楼层、心声入口和底部选项。移动端若此时用 smooth
  // scrollIntoView，动画目标会按旧 clientHeight 计算，后续布局一变就停在历史楼层。
  // 这里直接钉真实滚动容器，并在紧接着的两帧与短延迟后复核；用户一旦主动触摸、
  // 滚轮或按键浏览历史，立即取消本轮自动跟随。
  function settleScrollToBottom() {
    const scroll = container.querySelector('.offline-scroll');
    if (!scroll) return;
    let cancelled = false;
    const cancel = () => {
      cancelled = true;
      followLatestDuringAdvance = false;
    };
    const snap = () => {
      if (!cancelled && scroll.isConnected) {
        scroll.scrollTop = scroll.scrollHeight;
        session.uiState = { ...(session.uiState || {}), scrollTop: scroll.scrollTop };
      }
    };
    const cleanup = () => {
      scroll.removeEventListener('touchstart', cancel);
      scroll.removeEventListener('pointerdown', cancel);
      scroll.removeEventListener('wheel', cancel);
      scroll.removeEventListener('keydown', cancel);
    };
    scroll.addEventListener('touchstart', cancel, { passive: true });
    scroll.addEventListener('pointerdown', cancel, { passive: true });
    scroll.addEventListener('wheel', cancel, { passive: true });
    scroll.addEventListener('keydown', cancel);
    snap();
    window.requestAnimationFrame(() => {
      snap();
      window.requestAnimationFrame(snap);
    });
    window.setTimeout(snap, 120);
    window.setTimeout(() => {
      snap();
      cleanup();
    }, 420);
  }

  // 流式追加内容前先判断用户是否本来就贴着底部看，只有贴底才继续跟随，
  // 避免用户往上翻看时被逐字输出反复拽回底部
  function wasStickingToBottom() {
    const state = captureElementScrollState(container, '.offline-scroll');
    return !state || state.nearBottom;
  }

  async function persistAnonMemoryInjectFromUI() {
    const next = normalizeAnonMemoryInject(container.querySelector('.off-anon-memory-inject')?.value);
    chat.metadata = { ...(chat.metadata || {}), anonymousMemoryInject: next };
    await saveChat(chat);
    return next;
  }

  async function onSaveScene() {
    if (!session) return;
    const contentOnly = {
      ...(session.scene || {}),
      place: container.querySelector('.off-scene-place')?.value ?? session.scene?.place,
      goal: container.querySelector('.off-scene-goal')?.value ?? session.scene?.goal,
      openingLine: container.querySelector('.off-scene-opening')?.value ?? session.scene?.openingLine,
      durationDays: container.querySelector('.off-scene-duration-days')?.value ?? session.scene?.durationDays,
      placeMaterial: container.querySelector('.off-scene-place-material')?.value ?? session.scene?.placeMaterial,
      companions: session.scene?.companions || session.originSeed?.companions || '',
    };
    session.scene = createSceneDraft(contentOnly);
    syncOpeningBeatFromScene(session);
    await saveOfflineSession(session);
    title = await resolveTitle(chat, session.scene, session);
    showToast('场景已保存');
    if (!isAdvancing) paint();
    else {
      const summary = container.querySelector('.offline-scene-summary');
      if (summary) summary.innerHTML = sceneSummaryHtml(session.scene, session.originSeed, !!session.attendance);
    }
  }

  function renderStreamInto(el, fullText) {
    const cleaned = applyDisplayRegex(stripLeakedOfflineContinuityTail(sanitizeNarrationOutput(fullText)), 'offline');
    const paras = splitNarrationParagraphs(cleaned);
    const body = el.querySelector('[data-offline-stream-body]') || el;
    body.innerHTML = paras.map((p) => `<p>${renderNarrationTextWithTranslations(p)}</p>`).join('') || (cleaned ? `<p>${renderNarrationTextWithTranslations(cleaned)}</p>` : '<p>正在写下这段线下…</p>');
  }

  function onStopAdvance() {
    if (!isAdvancing) return;
    clearStopRecoveryTimer();
    const buttons = [...container.querySelectorAll('.offline-stop, .offline-stop-primary, [data-offline-wait-stop]')];
    buttons.forEach((btn) => {
      btn.disabled = true;
      const label = btn.querySelector('span');
      if (label) label.textContent = '正在停止…';
      else if (btn.matches('[data-offline-wait-stop]')) btn.textContent = '正在停止…';
    });
    const requested = requestNarrationGenerationAbort(
      'offline',
      session?.id || session?.chatId || chatId,
      'user-stop',
    );
    if (!requested && advanceAbortController && !advanceAbortController.signal.aborted) {
      advanceAbortController.abort('user-stop');
    }
    // AbortSignal 正常生效时 runAdvance 会自行收尾；底层插件或旧页面没有响应时，
    // 用户已经明确点了停止，三秒后安全回收本标签页租约并恢复操作，不能无限灰住。
    stopRecoveryTimer = window.setTimeout(() => {
      void forceFinishStoppedGeneration();
    }, requested ? 3000 : 50);
  }

  async function runAdvance({ directive = '', revision = null, continuation = null } = {}) {
    if (!session || isAdvancing) return;
    if (guidanceDiscussionOpen) {
      showToast('请先退出本体指导，再继续推进剧情');
      return;
    }
    clearStopRecoveryTimer();
    cancelPhoneStoryTakeover('next-offline-turn');
    const runRevision = ++advanceRunRevision;
    const revisionBeatId = String(revision?.beatId || '').trim();
    const isRevision = !!revisionBeatId;
    const continuationBeatId = String(continuation?.beatId || '').trim();
    const isContinuation = !!continuationBeatId;
    const continuationPrefix = isContinuation
      ? String(session.beats?.find((beat) => beat?.id === continuationBeatId)?.text || '').trim()
      : '';
    isAdvancing = true;
    followLatestDuringAdvance = true;
    audioStagePlaybackReadyDuringAdvance = false;
    audioStageProgressLabel = isRevision
      ? '正在重写这一幕…'
      : (isContinuation ? '正在从断点续写…' : '正在生成下一幕…');
    if (session.scene?.audioSceneEnabled === true) {
      clearAudioStageStreamPreview();
      audioStageAwaitingBeat = true;
      audioStagePlaybackBeatId = '';
      renderAudioStage();
    }
    const notice = beginLongTaskNotice({
      title: isRevision ? '线下本轮已重写' : (isContinuation ? '线下断点已续写' : '线下内容已生成'),
      body: isRevision
        ? `${title || '这段线下'}已换成新版本`
        : (isContinuation ? '续写内容已接回原楼层' : `${title || '这段线下'}有了新的进展`),
      tag: `offline-beat-${chatId}`,
      isStillViewing: () => container.isConnected,
    });
    closeSettingsSheet();
    const input = container.querySelector('.offline-directive');
    const advBtn = container.querySelector('.offline-advance');
    const rerollBtn = container.querySelector('.offline-reroll');
    const stopBtn = container.querySelector('.offline-stop');
    const summarizeBtns = [...container.querySelectorAll('.offline-summarize')];
    advanceAbortController = new AbortController();
    const runAbortController = advanceAbortController;
    const unregisterAdvanceAbort = registerNarrationGenerationAbortController(
      'offline',
      session?.id || session?.chatId || chatId,
      runAbortController,
    );
    let streamedOptions = [];
    let streamedReasoning = '';
    let audioBeatReady = false;
    const trimmedDirective = String(directive || input?.value || '').trim();
    let directiveInputReleased = false;
    const releaseDirectiveInputForNextTurn = async ({ persist = true } = {}) => {
      if (directiveInputReleased || isRevision || isContinuation) return;
      directiveInputReleased = true;
      if (input?.isConnected) {
        input.value = '';
        input.disabled = false;
        syncDirectiveTextareaHeight(input);
        syncDirectiveClearButton(input);
      }
      session.uiState = session.uiState || {};
      session.uiState.directiveDraft = '';
      // text 阶段之后 core 会立刻把已经追加了新 beat 的同一份 session 落库。
      // 此处只同步 UI 和内存，避免长会话并发写两遍整份楼层数据；兼容旧回调或
      // 完整请求返回时仍保留独立持久化兜底。
      if (!persist) return;
      await flushOfflineSessionPersist(session).catch((err) => {
        console.warn('[offline-session] cleared directive draft save failed', err);
        pendingPersistError = String(err?.message || err || '未知错误');
      });
    };
    if (session.scene?.audioSceneEnabled === true) {
      audioStageProgressLabel = isRevision
        ? '正在重写这一幕…'
        : (isContinuation
          ? '正在从断点续写…'
          : (trimmedDirective ? '已收到选择，正在生成下一幕…' : '正在生成下一幕…'));
      renderAudioStage();
    }
    if (advBtn) {
      advBtn.disabled = false;
      advBtn.classList.add('offline-stop-primary');
      advBtn.setAttribute('aria-label', '终止 AI 输出');
      advBtn.innerHTML = generationPrimaryActionContent(true);
    }
    if (rerollBtn) rerollBtn.disabled = true;
    if (stopBtn) stopBtn.disabled = false;
    summarizeBtns.forEach((button) => { button.disabled = true; });
    if (input) input.disabled = true;
    renderOptions([]);
    const cut = showCutscene('connect', '正在连线这段线下…');
    let cutClosed = false;
    const closeCut = (duration) => {
      if (cutClosed) return;
      cutClosed = true;
      void cut.close(duration);
    };
    let streamEl = null;
    let directiveEl = null;
    let joinedExistingGeneration = false;
    const ensureStreamEl = () => {
      if (session?.scene?.audioSceneEnabled === true) return null;
      if (streamEl) return streamEl;
      const beatsEl = container.querySelector('.offline-beats');
      if (!beatsEl) return null;
      beatsEl.querySelector('.offline-empty')?.remove();
      if (trimmedDirective && !isRevision && !isContinuation) {
        directiveEl = document.createElement('div');
        directiveEl.className = 'offline-beat offline-beat--directive';
        directiveEl.innerHTML = `<span>${isOfflineUserPresent(session, chat) ? '你的方向' : '旁观方向'}</span>${multilineBeatHtml(trimmedDirective)}`;
        beatsEl.appendChild(directiveEl);
      }
      streamEl = document.createElement('div');
      streamEl.className = 'offline-beat offline-beat--narration is-streaming';
      const replaceBeatId = revisionBeatId || continuationBeatId;
      if (replaceBeatId) streamEl.setAttribute('data-beat-id', replaceBeatId);
      streamEl.innerHTML = `${offlineReasoningHtml(streamedReasoning, { streaming: true })}<div data-offline-stream-body><p>正在写下这段线下…</p></div>`;
      if (isContinuation && continuationPrefix) renderStreamInto(streamEl, continuationPrefix);
      const revisionTarget = replaceBeatId
        ? [...beatsEl.querySelectorAll('.offline-beat[data-beat-id]')]
          .find((row) => row.getAttribute('data-beat-id') === replaceBeatId)
        : null;
      if (revisionTarget) revisionTarget.replaceWith(streamEl);
      else beatsEl.appendChild(streamEl);
      return streamEl;
    };
    ensureStreamEl();
    scrollToBottom();
    const cutTimer = setTimeout(() => closeCut(), 650);
    const onChunk = (fullText, meta = {}) => {
      closeCut();
      if (String(fullText || '').trim()) clearGenerationWaitNotice();
      if (session?.scene?.audioSceneEnabled === true) {
        audioStageProgressLabel = '正在接收下一幕正文…';
        queueAudioStageStreamRender(fullText);
        if (meta.optionsStarted) {
          streamedOptions = Array.isArray(meta.options) ? meta.options : [];
          renderOptions(streamedOptions, { pending: meta.optionsComplete !== true });
          if (meta.optionsComplete === true) {
            void releaseDirectiveInputForNextTurn({ persist: false });
          }
        }
        return;
      }
      const el = ensureStreamEl();
      if (!el) return;
      const stick = followLatestDuringAdvance;
      renderStreamInto(el, isContinuation
        ? joinOfflineContinuationText(continuationPrefix, fullText)
        : fullText);
      if (meta.optionsStarted) {
        streamedOptions = Array.isArray(meta.options) ? meta.options : [];
        renderOptions(streamedOptions, { pending: meta.optionsComplete !== true });
        if (meta.optionsComplete === true) {
          el.classList.remove('is-streaming');
          void releaseDirectiveInputForNextTurn({ persist: false });
        }
      }
      if (stick) scrollToBottom();
    };
    const onReasoning = (reasoningText) => {
      streamedReasoning = String(reasoningText || '');
      if (streamedReasoning.trim()) clearGenerationWaitNotice();
      if (session?.scene?.audioSceneEnabled === true) {
        audioStageProgressLabel = 'AI 正在思考…';
        renderAudioStage();
        return;
      }
      const el = ensureStreamEl();
      if (!el) return;
      let panel = el.querySelector('[data-offline-reasoning]');
      if (!panel) {
        el.insertAdjacentHTML('afterbegin', offlineReasoningHtml(streamedReasoning, { streaming: true }));
        panel = el.querySelector('[data-offline-reasoning]');
      }
      const output = panel?.querySelector('[data-offline-reasoning-text]');
      if (output) {
        const maxPreviewChars = 12000;
        output.textContent = streamedReasoning.length > maxPreviewChars
          ? `（较早的思维链内容已省略）\n${streamedReasoning.slice(-maxPreviewChars)}`
          : streamedReasoning;
        output.scrollTop = output.scrollHeight;
      }
    };
    const onBeatReady = (beat, meta = {}) => {
      const stick = session?.scene?.audioSceneEnabled !== true && followLatestDuringAdvance;
      streamedOptions = Array.isArray(beat?.options) ? beat.options : streamedOptions;
      if (meta.phase === 'text' || meta.phase === 'content' || meta.phase === 'complete') {
        // 正文已经完整返回后就消费本轮方向并开放下一轮草稿。text 阶段紧接着会
        // 保存包含新楼层的同一 session，不必为了清草稿再并发重写一次长会话。
        void releaseDirectiveInputForNextTurn({ persist: meta.phase !== 'text' });
      }
      if (session?.scene?.audioSceneEnabled !== true
        && beat?.text
        && (meta.phase === 'text' || meta.phase === 'content' || meta.phase === 'complete')) {
        const el = ensureStreamEl();
        if (el) {
          renderStreamInto(el, beat.text);
          // 正文已经完成。落库、语音、生图、日程及手机动作可以继续收尾，
          // 但不应让正文末尾的流式光标继续闪烁，误导用户以为 API 仍未结束。
          el.classList.remove('is-streaming');
          const reasoningPanel = el.querySelector('[data-offline-reasoning]');
          if (reasoningPanel) {
            if (!beat?.reasoningText) {
              reasoningPanel.remove();
            } else {
              reasoningPanel.classList.remove('is-streaming');
              reasoningPanel.removeAttribute('open');
              const label = reasoningPanel.querySelector('summary span');
              if (label) label.textContent = '思维链';
            }
          }
        }
      }
      if (session?.scene?.audioSceneEnabled === true && beat?.id) {
        const isFirstReady = meta.phase === 'content' || audioStageBeatId !== beat.id;
        clearAudioStageStreamPreview();
        audioStageAwaitingBeat = false;
        audioStageBeatId = beat.id;
        if (isFirstReady) {
          audioStageSegmentIndex = 0;
          audioStageChoicesOpen = false;
          audioStageInputOpen = false;
        }
        audioBeatReady = true;
        persistAudioStageState();
        if (beat?.image?.url) applyAudioScenePresentation();
        const voiceProgressPhase = meta.phase === 'voice-progress';
        const voiceReadyPhase = meta.phase === 'voice' || meta.phase === 'complete';
        if (voiceProgressPhase || voiceReadyPhase || (meta.phase === 'content' && beat?.voiceSynthesis?.pending !== true)) {
          audioStagePlaybackReadyDuringAdvance = true;
        }
        if (meta.phase === 'content') {
          audioStageProgressLabel = beat?.voiceSynthesis?.pending === true
            ? '正文已就绪，正在合成语音…'
            : '正文已就绪';
        } else if (voiceProgressPhase) {
          const completed = Number(beat?.voiceSynthesis?.completed || 0);
          const requested = Number(beat?.voiceSynthesis?.requested || 0);
          audioStageProgressLabel = requested > 0
            ? `语音准备中 ${completed}/${requested}`
            : '正在准备语音…';
        } else if (voiceReadyPhase) {
          audioStageProgressLabel = meta.phase === 'complete'
            ? ''
            : (meta.mediaPending === true ? '场景图后台生成中…' : '');
        }
        renderAudioStage();
        const voiceState = voiceReadyPhase ? beat?.voiceSynthesis : null;
        if (
          voiceState
          && Number(voiceState?.failed || 0) > 0
          && audioStageVoiceNoticeBeatId !== beat.id
        ) {
          audioStageVoiceNoticeBeatId = beat.id;
          showToast(voiceState.reason === 'not_configured'
            ? '尚未配置角色语音，本幕将以文字节奏播放'
            : `${voiceState.failed} 句语音未生成，本幕会以文字节奏继续`);
        }
        if (
          (voiceProgressPhase || voiceReadyPhase)
          && audioStageAuto
          && (audioStagePlaybackBeatId !== beat.id || audioStageVoiceWaitBeatId === beat.id)
        ) {
          void playAudioStageCurrent();
        }
      }
      renderOptions(streamedOptions);
      // 选项区位于正文滚动容器之外，它变高会压缩正文可视高度；按变化前的
      // 贴底状态补一次同步校准，避免完成回调刚好把最新几行顶出视口。
      if (stick) scrollToBottom();
    };
    try {
      const messages = await listMessagesForChat(chatId);
      const completedBeat = await runOfflineBeat({
        session,
        chat,
        user,
        messages,
        directive: trimmedDirective,
        revision: isRevision ? revision : null,
        continuation: isContinuation ? continuation : null,
        onChunk,
        onReasoning,
        onBeatReady,
        onRequestStart: ({ startedAt }) => armGenerationWaitNotice(startedAt),
        signal: runAbortController.signal,
      });
      void notice.complete();
      closeCut();
      // 极少数兼容实现可能没有发 content 阶段，完整请求返回时再兜底释放一次。
      await releaseDirectiveInputForNextTurn();
      const stick = followLatestDuringAdvance;
      renderBeats();
      renderOptionsFromSession();
      if (stick) settleScrollToBottom();
      // 手机剧情是正文完成后的附加演出，不再占用线下正文的生成锁。接口较慢时
      // 用户仍可继续阅读和操作；停止本轮、离开页面或开始下一轮都会取消它。
      void startPhoneStoryTakeover(completedBeat, runAbortController.signal);
    } catch (e) {
      if (runRevision !== advanceRunRevision) {
        notice.cancel();
        if (!cutClosed) {
          cutClosed = true;
          await cut.close(0);
        }
        return;
      }
      notice.cancel();
      if (!cutClosed) {
        cutClosed = true;
        await cut.close(0);
      }
      if (e?.reason === 'generation-in-flight') {
        joinedExistingGeneration = true;
        streamEl?.remove();
        directiveEl?.remove();
        showToast('当前一幕仍在生成，已阻止重复调用');
        return;
      }
      if (runAbortController.signal.aborted) {
        const recovered = commitOfflineInFlightIfNeeded(session);
        if (!isRevision && recovered.committed) {
          const beat = [...session.beats].reverse().find((b) => b.role === 'narration');
          if (beat && streamedOptions.length) beat.options = streamedOptions;
        }
        await saveOfflineSession(session, { allowShrink: true }).catch(() => {});
        renderBeats();
        renderOptionsFromSession();
        showToast(isRevision
          ? '已停止重写，仍保留上一版'
          : (isContinuation
            ? (recovered.committed ? '已停止，续写片段已接回原楼层' : '已停止续写')
            : (recovered.committed ? '已停止，当前内容已保留' : '已停止输出')));
      } else {
        const reasoningOnlySettled = settleReasoningOnlyStream(streamEl, e);
        if (!reasoningOnlySettled) streamEl?.remove();
        directiveEl?.remove();
        const recovered = commitOfflineInFlightIfNeeded(session);
        if (recovered.committed || recovered.cleared) {
          await saveOfflineSession(session, { allowShrink: true }).catch(() => {});
        }
        if (isRevision) {
          renderBeats();
          renderOptionsFromSession();
        } else if (recovered.committed || recovered.preservedExisting) {
          renderBeats();
          renderOptionsFromSession();
          showToast(recovered.committed
            ? '连接中断，已保留收到的部分正文'
            : '正文已保留，附加内容处理失败');
          if (e && typeof e === 'object') {
            e.partialRecovered = true;
            e.recoveredChars = String([...session.beats].reverse()
              .find((b) => b?.recoveredFromInFlight)?.text || '').length;
          }
        }
        if (reasoningOnlySettled) {
          showToast('模型这轮只完成了思考，没有写出正文');
        } else {
          reportOfflineGenerationError(e, {
            title: isRevision ? '线下重写失败' : (isContinuation ? '断点续写失败' : '线下推进失败'),
            scope: isRevision ? '线下相遇 / 重写' : (isContinuation ? '线下相遇 / 断点续写' : '线下相遇 / 推进'),
          });
        }
      }
    } finally {
      clearTimeout(cutTimer);
      unregisterAdvanceAbort();
      if (runRevision !== advanceRunRevision) return;
      clearStopRecoveryTimer();
      clearGenerationWaitNotice();
      isAdvancing = joinedExistingGeneration
        && isNarrationGenerationActive('offline', session?.id || session?.chatId);
      if (isAdvancing) {
        armGenerationWaitNotice(session?.inFlight?.requestStartedAt || session?.inFlight?.startedAt || Date.now());
      }
      audioStagePlaybackReadyDuringAdvance = false;
      if (advanceAbortController === runAbortController) advanceAbortController = null;
      if (advBtn?.isConnected) {
        advBtn.disabled = false;
        advBtn.classList.toggle('offline-stop-primary', isAdvancing);
        advBtn.setAttribute('aria-label', isAdvancing ? '终止 AI 输出' : '推进');
        advBtn.innerHTML = generationPrimaryActionContent(isAdvancing);
      }
      if (rerollBtn) rerollBtn.disabled = !session?.beats?.some((b) => b.role === 'narration');
      summarizeBtns.forEach((button) => { button.disabled = isAdvancing; });
      container.querySelectorAll('.offline-stop').forEach((button) => {
        button.disabled = !isAdvancing;
        const label = button.querySelector('span');
        if (label) label.textContent = '终止 AI 输出';
      });
      // 终止流程结束后再收起工具栏，避免进行中改文案时被挤成竖排字
      const tools = container.querySelector('.offline-tools');
      if (tools) tools.hidden = true;
      // 不自动 focus，否则手机端点「推进 / 重 roll」后会弹出软键盘
      if (input) {
        input.disabled = isAdvancing;
        syncDirectiveTextareaHeight(input);
      }
      if (session?.scene?.audioSceneEnabled === true) {
        clearAudioStageStreamPreview();
        audioStageAwaitingBeat = false;
        audioStageProgressLabel = '';
        renderAudioStage();
        renderOptions([]);
        if (audioBeatReady && audioStageAuto && audioStagePlaybackBeatId !== audioStageBeatId) {
          void playAudioStageCurrent();
        }
      }
    }
  }

  async function onAdvance(event = null, directiveOverride = null) {
    if (!session) return;
    if (session.scene?.audioSceneEnabled === true && audioStageAuto && event) {
      stopAudioStageForeground();
      primeAudioStagePlaybackGestures(event);
    }
    const input = container.querySelector('.offline-directive');
    const trimmedDirective = String(directiveOverride ?? input?.value ?? '').trim();
    const narrationCount = session.beats.filter((b) => b.role === 'narration').length;
    if (narrationCount > 0 && !trimmedDirective) {
      if (!window.confirm('还没写本轮方向。\n\n确定从已有剧情末尾衔接续写？（不会回到开场）')) return;
    }
    await runAdvance({ directive: trimmedDirective });
  }

  async function onReroll() {
    if (!session) return;
    if (guidanceDiscussionOpen) {
      showToast('请先退出本体指导，再重 roll 剧情');
      return;
    }
    if (isAdvancing) {
      showToast('正在生成，请先停止输出');
      return;
    }
    const lastBeat = (session.beats || [])[session.beats.length - 1];
    if (lastBeat?.role !== 'narration') {
      showToast('还没有可重 roll 的轮次');
      return;
    }
    const retainVersions = session.scene?.retainRerollVersions === true;
    const hasExternalActions = !!(
      (Array.isArray(lastBeat.phoneActions) && lastBeat.phoneActions.length)
      || (Array.isArray(lastBeat.phoneActionOutbox) && lastBeat.phoneActionOutbox.length)
      || (Array.isArray(lastBeat.socialPostActions) && lastBeat.socialPostActions.length)
      || (Array.isArray(lastBeat.socialPostOutbox) && lastBeat.socialPostOutbox.length)
    );
    if (retainVersions && hasExternalActions) {
      showToast('这一层已经发出真实手机消息或朋友圈，不能安全保留多版本；请推进下一层后再使用', 5000);
      return;
    }
    const lastIndex = session.beats.length - 1;
    const directive = session.beats[lastIndex - 1]?.role === 'directive'
      ? String(session.beats[lastIndex - 1].text || '').trim()
      : '';
    const input = container.querySelector('.offline-directive');
    showToast(retainVersions ? '正在重写本轮，上一版会保留…' : '正在重写本轮，上一版会在成功后替换…');
    await runAdvance({
      directive: directive || input?.value || '',
      revision: {
        beatId: lastBeat.id,
        independentReroll: true,
        requirement: '重新生成当前这一层，保持此前已经发生的上文不变，输出同一时间点的替代版本；不要沿用上一版的措辞、动作编排和段落结构。',
      },
    });
  }

  async function onSupplementalAuditReroll(beatId = '') {
    if (!session || isAdvancing || !canReviseLastOfflineBeat(session, beatId)) {
      showToast('只能补审当前最后一层');
      return;
    }
    if (guidanceDiscussionOpen) {
      showToast('请先退出本体指导，再补审重写');
      return;
    }
    const lastBeat = session.beats[session.beats.length - 1];
    const lastIndex = session.beats.length - 1;
    const directive = session.beats[lastIndex - 1]?.role === 'directive'
      ? String(session.beats[lastIndex - 1].text || '').trim()
      : '';
    showToast('正在逐句补审；新稿仍有硬命中时不会替换旧稿…', 5000);
    await runAdvance({
      directive,
      revision: {
        beatId: lastBeat.id,
        supplementalAudit: true,
        requirement: '逐句补审当前旧稿，清除漏检八股并重写为自然长短错落的同一时间点版本。',
      },
    });
  }

  async function openExpertConsultationSheet(beatId = '') {
    if (!session || isAdvancing || !canReviseLastOfflineBeat(session, beatId)) {
      showToast('只能会诊当前最后一层');
      return;
    }
    const target = session.beats[session.beats.length - 1];
    const [mainPresets, scenePresetsForExpert, flavorPresets] = await Promise.all([
      listApiSectionPresetOptions('main').catch(() => []),
      listApiSectionPresetOptions('scene').catch(() => []),
      listExpertConsultationPresets().catch(() => []),
    ]);
    const choices = [
      ...mainPresets.map((row) => ({ ...row, section: 'main', group: '聊天模型' })),
      ...scenePresetsForExpert.map((row) => ({ ...row, section: 'scene', group: '场景叙事' })),
    ];
    if (!choices.length) {
      showToast('请先在 API 管理中保存至少一个聊天模型或场景叙事档位');
      return;
    }
    closeSettingsSheet();
    const sheet = document.createElement('div');
    sheet.className = 'offline-settings-sheet os-expert-consultation-sheet';
    sheet.innerHTML = `
      <div class="offline-settings-sheet-backdrop" data-expert-close></div>
      <div class="offline-settings-sheet-panel" role="dialog" aria-modal="true" aria-labelledby="os-expert-title">
        <header class="offline-settings-sheet-head">
          <div><h2 id="os-expert-title">专家会诊 <small>测试中</small></h2><p>所选专家一次调用直接改写</p></div>
          <button type="button" class="navbar-btn" data-expert-close aria-label="关闭">${icon('close')}</button>
        </header>
        <div class="offline-settings-sheet-body">
          <label><span class="api-field-label">会诊方案</span>
            <select class="form-input" data-expert-flavor-preset>
              <option value="">临时填写</option>
              ${flavorPresets.map((row) => `<option value="${esc(row.id)}">${esc(row.name)}</option>`).join('')}
            </select>
          </label>
          <label><span class="api-field-label">会诊模型档位</span>
            <select class="form-input" data-expert-preset>
              ${choices.map((row) => `<option value="${esc(`${row.section}:${row.id}`)}">${esc(row.group)} · ${esc(row.name)}${row.model ? ` · ${esc(row.model)}` : ''}</option>`).join('')}
            </select>
          </label>
          <label><span class="api-field-label">希望保留当前稿的什么</span>
            <textarea class="form-input" rows="3" maxlength="500" data-expert-preserve placeholder="例如：Gemini 的剧情推进、情感浓度和具体生活信息"></textarea>
          </label>
          <label><span class="api-field-label">希望从会诊模型引入什么</span>
            <textarea class="form-input" rows="3" maxlength="500" data-expert-introduce placeholder="例如：Claude 的克制、细腻心理和动作连贯性"></textarea>
          </label>
          <div class="offline-settings-inline-actions">
            <button type="button" class="btn btn-soft btn-sm" data-expert-flavor-save>保存为方案</button>
            <button type="button" class="btn btn-soft btn-sm" data-expert-flavor-delete>删除方案</button>
          </div>
          <div class="os-revision-status" role="status" aria-live="polite">所选专家会在一次调用中直接产出替代正文。</div>
          <button type="button" class="btn btn-primary btn-block" data-expert-run>让专家直接写一版</button>
        </div>
      </div>`;
    const close = () => sheet.remove();
    sheet.querySelectorAll('[data-expert-close]').forEach((el) => el.addEventListener('click', close));
    const flavorSelect = sheet.querySelector('[data-expert-flavor-preset]');
    flavorSelect?.addEventListener('change', () => {
      const preset = flavorPresets.find((row) => row.id === flavorSelect.value);
      if (!preset) return;
      sheet.querySelector('[data-expert-preserve]').value = preset.preserveFlavor;
      sheet.querySelector('[data-expert-introduce]').value = preset.introduceFlavor;
      const apiValue = `${preset.apiSection}:${preset.apiPresetId}`;
      if (choices.some((row) => `${row.section}:${row.id}` === apiValue)) {
        sheet.querySelector('[data-expert-preset]').value = apiValue;
      }
    });
    sheet.querySelector('[data-expert-flavor-save]')?.addEventListener('click', async () => {
      const preserveFlavor = String(sheet.querySelector('[data-expert-preserve]')?.value || '').trim();
      const introduceFlavor = String(sheet.querySelector('[data-expert-introduce]')?.value || '').trim();
      const name = String(window.prompt('给这套会诊方案起个名字', '') || '').trim();
      if (!name) return;
      const selected = String(sheet.querySelector('[data-expert-preset]')?.value || '');
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
    sheet.querySelector('[data-expert-flavor-delete]')?.addEventListener('click', async () => {
      const id = String(flavorSelect?.value || '');
      if (!id) return;
      await deleteExpertConsultationPreset(id);
      [...flavorSelect.options].find((option) => option.value === id)?.remove();
      flavorSelect.value = '';
      showToast('会诊方案已删除');
    });
    sheet.querySelector('[data-expert-run]')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      const status = sheet.querySelector('.os-revision-status');
      const preserveFlavor = String(sheet.querySelector('[data-expert-preserve]')?.value || '').trim();
      const introduceFlavor = String(sheet.querySelector('[data-expert-introduce]')?.value || '').trim();
      if (!preserveFlavor || !introduceFlavor) {
        if (status) status.textContent = '请把两边想要的特点都写清楚，避免模型自行套品牌刻板印象。';
        return;
      }
      const selected = String(sheet.querySelector('[data-expert-preset]')?.value || '');
      const splitAt = selected.indexOf(':');
      const section = selected.slice(0, splitAt);
      const presetId = selected.slice(splitAt + 1);
      const choice = choices.find((row) => row.section === section && row.id === presetId);
      button.disabled = true;
      sheet.querySelectorAll('select, textarea').forEach((el) => { el.disabled = true; });
      if (status) status.textContent = '会诊模型正在阅读人物、关系与原稿…';
      try {
        const [configOverride, referenceContext] = await Promise.all([
          resolveApiSectionPresetConfig(section, presetId),
          buildOfflineGuidanceReferenceContext({
            session,
            chat,
            user,
            messages: await listMessagesForChat(chatId),
          }),
        ]);
        const consultation = await runNarrativeExpertConsultation({
          sampleText: target.text,
          referenceContext,
          preserveFlavor,
          introduceFlavor,
          consultantLabel: `${choice?.name || '会诊档位'}${choice?.model ? ` / ${choice.model}` : ''}`,
          configOverride,
          onProgress: () => { if (status) status.textContent = '专家正在直接改写正文…'; },
        });
        const rewrittenRaw = stripLeakedOfflineContinuityTail(
          sanitizeNarrationOutput(consultation.rewrite),
        ).trim();
        const rewritten = applyPermanentRegex(rewrittenRaw, {
          surface: 'offline',
          placement: 2,
          depth: 0,
          macros: { user: user?.name || '用户', char: '角色' },
        }).trim();
        if (!rewritten) throw new Error('专家没有返回可采用的替代正文');
        const applied = applyLastOfflineRevision(session, {
          beatId: target.id,
          newBeat: {
            ...target,
            text: rewritten,
            editorialAudits: [],
            voiceLines: [],
          },
          requirement: [
            `专家直接改写；保留：${preserveFlavor}`,
            `引入：${introduceFlavor}`,
            `会诊说明：${consultation.diagnosis}`,
          ].join('\n'),
        });
        if (!applied.ok) throw new Error('当前末层已经变化，专家版本未覆盖原稿');
        await saveOfflineSession(session, { allowShrink: true });
        close();
        renderBeats();
        revealRenderedBeat(target.id);
        renderOptionsFromSession();
        showToast('已采用专家直接改写版本');
      } catch (error) {
        if (status) status.textContent = `会诊未完成：${error?.message || error}`;
        button.disabled = false;
        sheet.querySelectorAll('select, textarea').forEach((el) => { el.disabled = false; });
      }
    });
    container.appendChild(sheet);
  }

  function openRerollVersionsSheet() {
    if (!session || isAdvancing) return;
    const lastBeat = [...(session.beats || [])].reverse().find((beat) => beat?.role === 'narration');
    if (!lastBeat) {
      showToast('还没有可选择的版本');
      return;
    }
    const versionSet = listOfflineRerollVersions(session, lastBeat.id);
    if (versionSet.versions.length < 2) {
      showToast('重 roll 成功后会在这里保留多个版本');
      return;
    }
    closeSettingsSheet();
    settingsSheetOpen = true;
    const sheet = document.createElement('div');
    sheet.className = 'offline-settings-sheet os-reroll-versions-sheet';
    sheet.innerHTML = `
      <div class="offline-settings-sheet-backdrop" data-versions-close></div>
      <div class="offline-settings-sheet-panel" role="dialog" aria-modal="true" aria-labelledby="os-reroll-versions-title">
        <header class="offline-settings-sheet-head">
          <h2 id="os-reroll-versions-title">选择本轮版本</h2>
          <button type="button" class="navbar-btn" data-versions-close aria-label="关闭">${icon('close')}</button>
        </header>
        <div class="offline-settings-sheet-body os-reroll-version-list">
          ${versionSet.versions.map((version, index) => {
            const active = version.id === versionSet.activeVersionId;
            const text = applyDisplayRegex(String(version.beat?.text || ''), 'offline').trim();
            return `<article class="os-reroll-version${active ? ' is-active' : ''}">
              <header><strong>${esc(version.label || `版本 ${index + 1}`)}</strong>${active ? '<span>当前采用</span>' : ''}</header>
              <p>${esc(text.slice(0, 220))}${text.length > 220 ? '…' : ''}</p>
              <button type="button" class="btn ${active ? 'btn-soft' : 'btn-outline'} btn-sm" data-select-reroll-version="${esc(version.id)}" ${active ? 'disabled' : ''}>${active ? '已采用' : '采用此版'}</button>
            </article>`;
          }).join('')}
        </div>
      </div>`;
    container.appendChild(sheet);
    sheet.querySelectorAll('[data-versions-close]').forEach((node) => {
      node.addEventListener('click', closeSettingsSheet);
    });
    sheet.querySelectorAll('[data-select-reroll-version]').forEach((button) => {
      button.addEventListener('click', async () => {
        const versionId = button.getAttribute('data-select-reroll-version') || '';
        const snapshot = {
          beats: JSON.parse(JSON.stringify(session.beats || [])),
          checkpoints: JSON.parse(JSON.stringify(session.checkpointSummaries || [])),
          versions: JSON.parse(JSON.stringify(session.rerollVersions || {})),
        };
        sheet.querySelectorAll('button').forEach((node) => { node.disabled = true; });
        try {
          const selected = selectOfflineRerollVersion(session, lastBeat.id, versionId);
          if (!selected.ok) throw new Error('这个版本已不能切换');
          await saveOfflineSession(session);
          closeSettingsSheet();
          paint();
          showToast('已切换本轮版本；后续只会读取当前采用版');
        } catch (err) {
          session.beats = snapshot.beats;
          session.checkpointSummaries = snapshot.checkpoints;
          session.rerollVersions = snapshot.versions;
          sheet.querySelectorAll('button').forEach((node) => { node.disabled = false; });
          showToast(`切换失败：${err?.message || err}`);
        }
      });
    });
  }

  /**
   * 收纳确认 + 可选时间线推进。
   * 返回 null（取消）或 { advance: null | { targetTs, keepVirtual } }。
   */
  function openOfflineSettleModal({
    startedAtWorld,
    worldNow,
    allowTimeAdvance,
    timeZone = '',
  }) {
    const branching = ensureOfflineBranching(session);
    const activeBranch = branching.branches.find((branch) => branch.id === branching.activeBranchId)
      || branching.branches[0]
      || null;
    const unusedBranchCount = Math.max(0, branching.branches.length - 1);
    const hasBranches = unusedBranchCount > 0;
    const activeBranchName = String(activeBranch?.name || '当前路线').trim() || '当前路线';
    const settleTitle = hasBranches ? `将「${activeBranchName}」设为正史` : '总结收纳这段线下';
    const settleHint = hasBranches
      ? `当前路线会生成摘要并写入角色记忆；其余 ${unusedBranchCount} 条路线仅作为「未采用路线」保存在档案中，不参与角色记忆。`
      : '确认后写进共同回忆和约会档案，并把这段时间写回 TA 当天的日程；取消可继续玩。';
    const settleAction = hasBranches ? '设为正史并收纳' : '总结收纳';
    const host = document.getElementById('modal-container');
    if (!host) {
      return Promise.resolve(window.confirm(
        hasBranches
          ? `是否将「${activeBranchName}」设为正史并收纳？\n\n其余 ${unusedBranchCount} 条路线只保留在档案中，不写入角色记忆。`
          : '是否总结这段相遇？\n\n确定后会收纳进共同回忆；取消可继续玩。',
      ) ? { advance: null } : null);
    }
    const startTs = Number(startedAtWorld || 0) || worldNow;
    const elapsedLabel = formatGapHint(Math.max(0, worldNow - startTs)) || '不到 1 分钟';
    return new Promise((resolve) => {
      const done = (value) => {
        host.classList.remove('active');
        host.innerHTML = '';
        resolve(value);
      };
      host.innerHTML = `
        <div class="modal-overlay modal-sheet-center" data-off-settle-overlay>
          <div class="modal-sheet scrapbook-card off-settle-sheet" role="dialog" aria-modal="true" aria-label="总结收纳">
            <header class="modal-header">
              <h3>${esc(settleTitle)}</h3>
              <button type="button" class="navbar-btn modal-close-btn off-settle-close" aria-label="关闭">${icon('close')}</button>
            </header>
            <div class="modal-body off-settle-body">
              <p class="off-settle-hint">${esc(settleHint)}</p>
              <details class="off-settle-advance-details" ${allowTimeAdvance ? '' : 'hidden'}>
                <summary>推进世界时间（可选，默认不推进 · 按自然经过约 ${esc(elapsedLabel)}）</summary>
                <label class="api-field">
                  <span class="api-field-label">这段线下经过了多久</span>
                  <select class="form-input off-settle-span">
                    <option value="">不推进（按自然经过约 ${esc(elapsedLabel)}）</option>
                    <option value="1800000">推进到共 30 分钟</option>
                    <option value="3600000">推进到共 1 小时</option>
                    <option value="7200000">推进到共 2 小时</option>
                    <option value="14400000">推进到共 4 小时</option>
                    <option value="next-morning">推进到第二天早上</option>
                    <option value="custom">自定义小时数…</option>
                  </select>
                </label>
                <label class="api-field off-settle-custom" hidden>
                  <span class="api-field-label">共持续（小时）</span>
                  <input type="number" class="form-input off-settle-custom-hours" min="0.5" step="0.5" value="3" />
                </label>
                <div class="off-settle-time-preview" hidden aria-live="polite">
                  <span class="off-settle-time-preview-start"></span>
                  <i aria-hidden="true">→</i>
                  <strong class="off-settle-time-preview-end"></strong>
                  <small class="off-settle-time-preview-impact"></small>
                </div>
                <p class="off-settle-note" hidden></p>
              </details>
              <div class="off-settle-actions">
                <button type="button" class="btn btn-outline off-settle-cancel">再玩会儿</button>
                <button type="button" class="btn btn-primary off-settle-confirm">${esc(settleAction)}</button>
              </div>
            </div>
          </div>
        </div>
      `;
      host.classList.add('active');
      const overlay = host.querySelector('[data-off-settle-overlay]');
      const advanceDetails = host.querySelector('.off-settle-advance-details');
      const spanSel = host.querySelector('.off-settle-span');
      const customWrap = host.querySelector('.off-settle-custom');
      const customHours = host.querySelector('.off-settle-custom-hours');
      const timePreview = host.querySelector('.off-settle-time-preview');
      const previewStart = host.querySelector('.off-settle-time-preview-start');
      const previewEnd = host.querySelector('.off-settle-time-preview-end');
      const previewImpact = host.querySelector('.off-settle-time-preview-impact');
      const note = host.querySelector('.off-settle-note');

      const computeTarget = () => {
        return resolveOfflineSettlementTarget({
          startedAtWorld: startTs,
          worldNow,
          selection: spanSel?.value,
          customHours: customHours?.value,
          timeZone,
        });
      };
      const syncUi = () => {
        const raw = String(spanSel?.value || '');
        if (customWrap) customWrap.hidden = raw !== 'custom';
        const target = computeTarget();
        const timing = describeOfflineSettlementTiming({
          startedAtWorld: startTs,
          worldNow,
          targetTs: target,
          timeZone,
        });
        const { deltaMs: delta, willAdvance } = timing;
        if (timePreview) timePreview.hidden = !raw;
        if (raw) {
          if (previewStart) previewStart.textContent = `开始 ${formatPromptTimeLine(startTs, timeZone)}`;
          if (previewEnd) previewEnd.textContent = `结束 ${formatPromptTimeLine(target, timeZone)}`;
          if (previewImpact) {
            previewImpact.textContent = willAdvance
              ? (timing.crossesStartDay
                ? '会跨到新的日期，所有聊天都会按新的日期理解“今天 / 昨天”。'
                : '会修改这个档位下所有聊天共用的世界时间。')
              : '当前世界时间已经超过这个结束时间，不会额外推进。';
          }
          timePreview?.classList.toggle('is-cross-day', willAdvance && timing.crossesStartDay);
        }
        if (note) {
          note.hidden = !raw;
          if (raw) {
            note.textContent = willAdvance
              ? `收纳后固定虚拟时间线将向前推进约 ${formatGapHint(delta)}。`
              : '所选时长不超过已自然经过的时间，不会额外推进。';
          }
        }
      };
      syncUi();
      spanSel?.addEventListener('change', syncUi);
      customHours?.addEventListener('input', syncUi);
      // 收起折叠区 = 放弃推进：清掉已选档位，避免忘了里面选过什么就直接收纳。
      advanceDetails?.addEventListener('toggle', () => {
        if (!advanceDetails.open && spanSel && spanSel.value) {
          spanSel.value = '';
          syncUi();
        }
      });

      overlay?.addEventListener('click', (e) => {
        if (e.target === overlay) done(null);
      });
      host.querySelector('.off-settle-sheet')?.addEventListener('click', (e) => e.stopPropagation());
      host.querySelector('.off-settle-close')?.addEventListener('click', () => done(null));
      host.querySelector('.off-settle-cancel')?.addEventListener('click', () => done(null));
      host.querySelector('.off-settle-confirm')?.addEventListener('click', () => {
        const target = computeTarget();
        const willAdvance = target > worldNow;
        done({
          advance: willAdvance
            ? {
              targetTs: target,
            }
            : null,
        });
      });
    });
  }

  function confirmOfflineTimeAdvance({
    startedAtWorld,
    worldNow,
    targetTs,
    timeZone = '',
  }) {
    const host = document.getElementById('modal-container');
    const timing = describeOfflineSettlementTiming({
      startedAtWorld,
      worldNow,
      targetTs,
      timeZone,
    });
    if (!timing.willAdvance) return Promise.resolve(true);
    const startLabel = formatPromptTimeLine(timing.startTs, timeZone);
    const targetLabel = formatPromptTimeLine(timing.targetTs, timeZone);
    const impact = timing.crossesStartDay
      ? '这段线下开始日将不再是“今天”，私聊、群聊和旁观群聊都会按新日期继续。'
      : '私聊、群聊和旁观群聊都会从这个新时间继续。';
    const debt = `固定虚拟时间线将向前推进约 ${formatGapHint(timing.deltaMs)}。`;
    const message = `${startLabel} → ${targetLabel}\n${impact}\n${debt}`;
    if (!host) return Promise.resolve(window.confirm(`确认推进所有聊天的世界时间？\n\n${message}`));

    host.classList.add('active');
    host.innerHTML = `
      <div class="modal-overlay modal-sheet-center" data-off-time-confirm-overlay>
        <div class="modal-sheet scrapbook-card off-time-confirm-sheet" role="dialog" aria-modal="true" aria-labelledby="off-time-confirm-title" aria-describedby="off-time-confirm-impact">
          <header class="modal-header">
            <h3 id="off-time-confirm-title">${timing.crossesStartDay ? '这次推进会跨到新的日期' : '确认推进所有聊天的时间'}</h3>
            <button type="button" class="navbar-btn modal-close-btn" data-off-time-confirm-cancel aria-label="关闭">${icon('close')}</button>
          </header>
          <div class="modal-body off-time-confirm-body">
            <div class="off-settle-time-preview${timing.crossesStartDay ? ' is-cross-day' : ''}">
              <span>开始 ${esc(startLabel)}</span>
              <i aria-hidden="true">→</i>
              <strong>结束 ${esc(targetLabel)}</strong>
            </div>
            <p id="off-time-confirm-impact">${esc(impact)}</p>
            <p>${esc(debt)}</p>
          </div>
          <footer class="off-settle-actions">
            <button type="button" class="btn btn-outline" data-off-time-confirm-cancel>暂不收纳</button>
            <button type="button" class="btn btn-primary" data-off-time-confirm-accept>${timing.crossesStartDay ? '确认跨日并收纳' : '确认推进并收纳'}</button>
          </footer>
        </div>
      </div>
    `;

    return new Promise((resolve) => {
      let settled = false;
      const finish = (confirmed) => {
        if (settled) return;
        settled = true;
        document.removeEventListener('keydown', onKeydown);
        host.innerHTML = '';
        host.classList.remove('active');
        resolve(confirmed);
      };
      const onKeydown = (event) => {
        if (event.key === 'Escape') finish(false);
      };
      host.querySelectorAll('[data-off-time-confirm-cancel]').forEach((button) => {
        button.addEventListener('click', () => finish(false));
      });
      host.querySelector('[data-off-time-confirm-accept]')?.addEventListener('click', () => finish(true));
      host.querySelector('[data-off-time-confirm-overlay]')?.addEventListener('click', (event) => {
        if (event.target === event.currentTarget) finish(false);
      });
      document.addEventListener('keydown', onKeydown);
      host.querySelector('[data-off-time-confirm-accept]')?.focus();
    });
  }

  async function onSummarize() {
    if (!session) return;
    if (isAdvancing || isNarrationGenerationActive('offline', session.id || session.chatId)) {
      showToast('当前一幕仍在生成，请完成后再收纳');
      return;
    }
    const [worldNow, schedule, timeZone] = await Promise.all([
      getNowForUser(user.id).catch(() => Date.now()),
      ensureTimeSchedule(user.id).catch(() => null),
      getUserTimezone(user.id).catch(() => ''),
    ]);
    const startedAtWorld = Number(session.startedAtWorld || session.createdAt || 0);
    const settle = await openOfflineSettleModal({
      startedAtWorld,
      worldNow,
      allowTimeAdvance: canAdvanceOfflineSettlementTime(schedule),
      timeZone,
    });
    if (!settle) return;
    if (settle.advance) {
      const confirmed = await confirmOfflineTimeAdvance({
        startedAtWorld,
        worldNow,
        targetTs: settle.advance.targetTs,
        timeZone,
      });
      if (!confirmed) return;
    }
    const sumBtn = container.querySelector('.offline-summarize');
    const notice = beginLongTaskNotice({
      title: '线下记录已收纳',
      body: '摘要和完整记录已经保存',
      tag: `offline-summary-${chatId}`,
      isStillViewing: () => container.isConnected,
    });
    if (sumBtn) sumBtn.disabled = true;
    showToast('正在收纳这段线下…');
    try {
      const messages = await listMessagesForChat(chatId);
      const wasFirstEncounter = session.firstEncounter === true;
      finishedArchive = await summarizeOfflineSession({ session, chat, user, messages, advance: settle.advance });
      void notice.complete();
      session = null;
      clearLeaveGuard();
      invalidateKeepAlive('offline', { chatId });
      invalidateOfflinePresenceKeepAlive(chatId);
      showToast(wasFirstEncounter ? '已收进共同回忆，TA 正式加入通讯录' : '已收进共同回忆');
      paint();
    } catch (e) {
      notice.cancel();
      reportOfflineGenerationError(e, { title: '总结收纳失败', scope: '线下相遇 / 总结收纳' });
      if (sumBtn) sumBtn.disabled = false;
    }
  }

  /**
   * 返回键：暂离（保留进度）或删除本次线下（误入可直接退出）。
   * 系统后退 / 其它导航也走 leaveGuard 打开同一选择。
   */
  function openOfflineLeaveModal({ onPause = null } = {}) {
    if (!session) {
      clearLeaveGuard();
      back();
      return;
    }
    let pauseSaving = false;
    const pauseAndLeave = async () => {
      if (pauseSaving) return;
      pauseSaving = true;
      stopAudioStageForeground();
      stopAudioStageBackground();
      captureOfflineUiState();
      try {
        // 暂离的承诺是“进度会保留”，保存必须成为离开页面的提交边界；
        // 不能发起写入后立刻导航，让移动端有机会挂起 WebView。
        await flushOfflineSessionPersist(session);
        clearLeaveGuard();
        if (typeof onPause === 'function') onPause();
        else back();
      } catch (err) {
        pauseSaving = false;
        pendingPersistError = String(err?.message || err || '未知错误');
        armLeaveGuard();
        showToast('暂离前保存失败，仍留在当前页面，请重试');
      }
    };
    const host = document.getElementById('modal-container');
    if (!host) {
      const leave = window.confirm('暂离这场线下？进度会保留，可稍后再回来继续。\n\n若要彻底清除本场，请取消后点返回并选择「删除本次线下」。');
      if (leave) void pauseAndLeave();
      return;
    }
    const hasProgress = session.beats.some((b) => b.role === 'narration');
    const done = () => {
      host.classList.remove('active');
      host.innerHTML = '';
    };
    host.classList.add('active');
    host.innerHTML = `
      <div class="modal-overlay modal-sheet-center" data-off-leave-overlay>
        <div class="modal-sheet scrapbook-card off-leave-sheet" role="dialog" aria-modal="true" aria-label="离开线下">
          <header class="modal-header">
            <h3>离开这场线下</h3>
            <button type="button" class="navbar-btn modal-close-btn" data-off-leave-close aria-label="关闭">${icon('close')}</button>
          </header>
          <div class="modal-body off-leave-body">
            <p class="off-leave-hint">${hasProgress
              ? '进度还没收纳进共同回忆。可以先暂离稍后再来，或直接删除本场（误入时用）。'
              : '还没正式开场。可以暂离保留场景，或直接删除本场退出。'}</p>
            <div class="off-leave-actions">
              <button type="button" class="btn btn-primary off-leave-pause">暂离</button>
              <button type="button" class="btn btn-outline off-leave-discard">删除本次线下</button>
              <button type="button" class="btn btn-outline off-leave-cancel">取消</button>
            </div>
            <p class="off-leave-note">暂离会保留进度，可随时从聊天/相遇回来继续；删除会清掉本场线下进度，不会写进共同回忆。</p>
          </div>
        </div>
      </div>`;
    host.querySelector('[data-off-leave-overlay]')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) done();
    });
    host.querySelector('[data-off-leave-close]')?.addEventListener('click', done);
    host.querySelector('.off-leave-cancel')?.addEventListener('click', done);
    host.querySelector('.off-leave-pause')?.addEventListener('click', () => {
      done();
      void pauseAndLeave();
    });
    host.querySelector('.off-leave-discard')?.addEventListener('click', () => {
      if (!window.confirm('确定删除本次线下？本场进度会清除且无法恢复，也不会收进共同回忆。')) return;
      done();
      void discardOfflineSessionAndLeave();
    });
  }

  async function discardOfflineSessionAndLeave() {
    if (!session) {
      clearLeaveGuard();
      back();
      return;
    }
    const targetChatId = String(session.chatId || chatId || '').trim();
    if (isAdvancing && advanceAbortController) {
      try { advanceAbortController.abort(); } catch (_) { /* ignore */ }
    }
    advanceRunRevision += 1;
    cancelPhoneStoryTakeover('offline-session-discarded');
    clearStopRecoveryTimer();
    isAdvancing = false;
    stopAudioStageForeground();
    stopAudioStageBackground();
    const snapshot = session;
    try {
      // 先给主会话落“已删除”墓碑，再清附属快照。否则停止中的生成/后台保存
      // 可能趁清快照的空窗把同一场重新写活，返回后看起来仍在继续。
      await clearOfflineSession(targetChatId, { sessionId: snapshot.id });
      session = null;
      await clearOfflineBranchSnapshots(snapshot).catch(() => {});
      finishedArchive = null;
      clearLeaveGuard();
      invalidateKeepAlive('offline', { chatId: targetChatId });
      invalidateOfflinePresenceKeepAlive(targetChatId);
      showToast('已删除本次线下');
      back();
    } catch (err) {
      session = snapshot;
      showToast(`删除失败：${err?.message || err}`);
    }
  }

  function armLeaveGuard() {
    setLeaveGuard((nextPath, nextParams) => {
      if (!session) return true;
      openOfflineLeaveModal({
        onPause: () => {
          if (nextPath) navigate(nextPath, nextParams || {});
          else back();
        },
      });
      return false;
    });
  }

  armLeaveGuard();

  function captureOfflineUiState() {
    if (!session || !container.isConnected) return;
    const input = container.querySelector('.offline-directive');
    const scroller = container.querySelector('.offline-scroll');
    session.uiState = {
      ...(session.uiState || {}),
      directiveDraft: input ? String(input.value || '') : String(session.uiState?.directiveDraft || ''),
      scrollTop: scroller ? scroller.scrollTop : Number(session.uiState?.scrollTop || 0),
    };
  }

  function flushOfflineOnBackground() {
    if (!container.isConnected || !session) return;
    if (typeof document !== 'undefined' && document.visibilityState && document.visibilityState !== 'hidden') return;
    captureOfflineUiState();
    void flushOfflineSessionPersist(session).catch((err) => {
      console.warn('[offline-session] background save failed', err);
      pendingPersistError = String(err?.message || err || '未知错误');
    });
  }

  const onVisibilityChange = () => {
    if (!container.isConnected) {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('pagehide', onPageHide);
      return;
    }
    if (document.visibilityState === 'hidden') {
      stopAudioStageForeground();
      stopAudioStageBackground();
      flushOfflineOnBackground();
      return;
    }
    if (pendingPersistError) {
      pendingPersistError = '';
      showToast('线下进度暂未保存，请保持页面打开后再推进一次');
    }
  };
  const onPageHide = () => {
    if (!container.isConnected) return;
    stopAudioStageForeground();
    stopAudioStageBackground();
    captureOfflineUiState();
    void flushOfflineSessionPersist(session).catch((err) => {
      console.warn('[offline-session] pagehide save failed', err);
      pendingPersistError = String(err?.message || err || '未知错误');
    });
  };
  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('pagehide', onPageHide);
  const clearPhoneCinematicCues = () => {
    container.querySelectorAll('.os-phone-cinematic-cue').forEach((cue) => cue.remove());
  };
  const onRouteActivated = async (event) => {
    const detail = event.detail || {};
    // 每次路由激活都会让上一轮异步恢复失效。移动端连续“暂离 → 返回现场”时，
    // IndexedDB 读取可能晚于下一次导航完成；旧任务绝不能再给当前页面挂 leaveGuard，
    // 否则聊天页会被已挂起的线下页拦住，看起来像整页失去响应。
    const activationRevision = ++routeActivationRevision;
    // Keep-Alive 挂起后仍会收到其它页面的全局激活事件。先核对事件归属，不能因为
    // 自己暂时不在 DOM 就解绑，否则真正返回本页时再也收不到恢复通知。
    if (detail.container !== container || detail.path !== 'offline') {
      cancelPhoneStoryTakeover('offline-route-left');
      return;
    }
    if (!container.isConnected) {
      window.removeEventListener('marshmallow-route-activated', onRouteActivated);
      return;
    }
    // 线下页会被路由保活；离开前遗留的转场提示不能跟着缓存回来。
    clearPhoneCinematicCues();
    if (!detail.resumed) return;
    const latest = (await loadOfflineSessionWithMeta(chatId).catch(() => null))?.session;
    if (activationRevision !== routeActivationRevision || !container.isConnected) return;
    if (!latest) return;
    session = latest;
    const generationActive = !!session.inFlight
      && reconcileNarrationGenerationActivity('offline', session.id || session.chatId);
    if (session.inFlight && !generationActive) {
      const recovered = commitOfflineInFlightIfNeeded(session);
      if (recovered.committed || recovered.cleared) {
        await saveOfflineSession(session, { allowShrink: true }).catch(() => {});
        if (activationRevision !== routeActivationRevision || !container.isConnected) return;
        if (recovered.committed) showToast('已恢复离开期间收到的推进');
      }
    }
    isAdvancing = generationActive;
    if (!generationActive) advanceAbortController = null;
    armLeaveGuard();
    ensureOfflineAttendance(session, chat);
    let foldedPhoneInterlude = false;
    if (session.phoneSideTrip) {
      const folded = await resolvePhoneSideTripInterlude(session).catch(() => ({ added: false }));
      session = folded.session || session;
      foldedPhoneInterlude = folded.added === true;
      if (folded.added) {
        showToast('刚才的线上插曲已记进线下时间线');
      }
    }
    paint();
    if (foldedPhoneInterlude) scrollToBottom();
    if (generationActive) {
      armGenerationWaitNotice(session.inFlight?.requestStartedAt || session.inFlight?.startedAt || Date.now());
    } else {
      clearGenerationWaitNotice();
    }
  };
  window.addEventListener('marshmallow-route-activated', onRouteActivated);
  const activeGenerationKey = narrationGenerationLeaseKey('offline', session?.id || chatId);
  const onNarrationGenerationState = async (event) => {
    if (event?.detail?.key !== activeGenerationKey || event?.detail?.active !== false) return;
    if (stopRecoveryInProgress) return;
    if (!container.isConnected) {
      // Keep-Alive 页面可能在生成结束时仍处于挂起状态。返回时 onRouteActivated
      // 会重新核验并重绘；这里保留监听，避免把一次正常挂起误当成永久销毁。
      return;
    }
    // 本页发起的 runAdvance 会在自己的 finally 中收尾。正文就绪后输入框已经
    // 提前开放；若此时再因 lease release 整页 paint，会替换用户刚聚焦的
    // textarea，移动端会出现“键盘还在、光标和文字却不在输入框里”的竞态。
    if (advanceAbortController) {
      isAdvancing = false;
      clearStopRecoveryTimer();
      clearGenerationWaitNotice();
      return;
    }
    const shouldFollowLatest = followLatestDuringAdvance;
    const visibleScrollTop = container.querySelector('.offline-scroll')?.scrollTop || 0;
    const directiveInput = container.querySelector('.offline-directive');
    const directiveHadFocus = directiveInput && document.activeElement === directiveInput;
    const liveDirectiveDraft = String(directiveInput?.value || '');
    const selectionStart = Number(directiveInput?.selectionStart || 0);
    const selectionEnd = Number(directiveInput?.selectionEnd || selectionStart);
    const latest = (await loadOfflineSessionWithMeta(chatId).catch(() => null))?.session;
    if (!latest) return;
    session = latest;
    session.uiState = {
      ...(session.uiState || {}),
      scrollTop: shouldFollowLatest ? 0 : visibleScrollTop,
      // 外部页面完成生成时仍需同步整页；合并当前 DOM 草稿，避免异步重读
      // 用旧快照覆盖用户在等待期间刚输入的内容。
      directiveDraft: liveDirectiveDraft || session.uiState?.directiveDraft || '',
    };
    isAdvancing = false;
    advanceAbortController = null;
    clearStopRecoveryTimer();
    clearGenerationWaitNotice();
    paint();
    if (directiveHadFocus) {
      const nextInput = container.querySelector('.offline-directive');
      nextInput?.focus({ preventScroll: true });
      nextInput?.setSelectionRange?.(
        Math.min(selectionStart, nextInput.value.length),
        Math.min(selectionEnd, nextInput.value.length),
      );
    }
    if (shouldFollowLatest) settleScrollToBottom();
    followLatestDuringAdvance = false;
  };
  window.addEventListener('marshmallow-narration-generation-state', onNarrationGenerationState);
  const onOfflineSocialPostState = (event) => {
    if (!container.isConnected || String(event?.detail?.sessionId || '') !== String(session?.id || '')) return;
    // 副作用完成时 session 对象已被 core 更新，只局部刷新时间线，不替换
    // 正在输入的指令框，也不打断移动端键盘。
    renderBeats();
  };
  window.addEventListener('marshmallow-offline-social-post-state', onOfflineSocialPostState);
  const onPhoneCinematic = (event) => {
    const detail = event.detail || {};
    if (!container.isConnected) {
      window.removeEventListener('marshmallow-offline-phone-cinematic', onPhoneCinematic);
      return;
    }
    if (!session || String(detail.offlineChatId || '') !== String(chatId)) return;
    const enter = () => {
      if (!container.isConnected || !session || isAdvancing || settingsSheetOpen) {
        window.setTimeout(enter, 500);
        return;
      }
      clearPhoneCinematicCues();
      const cue = document.createElement('div');
      cue.className = 'os-phone-cinematic-cue';
      cue.innerHTML = `<span>${icon('smartphone')}</span><strong>${esc(detail.proxyName || 'TA')}接过了手机</strong>`;
      container.appendChild(cue);
      window.setTimeout(() => {
        // 提示只负责说明这次转场；必须在导航前移除，否则保活恢复线下页时会永久残留。
        cue.remove();
        clearLeaveGuard();
        invalidateKeepAlive('chat/thread', { chatId: detail.targetChatId });
        navigate('chat/thread', {
          chatId: detail.targetChatId,
          offlineChatId: chatId,
          phoneCinematic: detail.jobId,
        });
      }, 720);
    };
    enter();
  };
  window.addEventListener('marshmallow-offline-phone-cinematic', onPhoneCinematic);
  const onRouteDisposed = (event) => {
    if (event?.detail?.container !== container) return;
    routeActivationRevision += 1;
    cancelPhoneStoryTakeover('offline-route-disposed');
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('pagehide', onPageHide);
    window.removeEventListener('marshmallow-route-activated', onRouteActivated);
    window.removeEventListener('marshmallow-narration-generation-state', onNarrationGenerationState);
    window.removeEventListener('marshmallow-offline-social-post-state', onOfflineSocialPostState);
    window.removeEventListener('marshmallow-offline-phone-cinematic', onPhoneCinematic);
    window.removeEventListener('marshmallow-route-disposed', onRouteDisposed);
    clearStopRecoveryTimer();
    clearGenerationWaitNotice();
  };
  window.addEventListener('marshmallow-route-disposed', onRouteDisposed);

  paint();
  if (liveGenerationAtMount) {
    armGenerationWaitNotice(session?.inFlight?.requestStartedAt || session?.inFlight?.startedAt || Date.now());
  }
  const paintedAt = globalThis.performance?.now?.() || Date.now();
  const initialRenderMs = paintedAt - renderStartedAt;
  if (initialRenderMs >= 1200) {
    void import('../core/debug-log.js').then(({ appendDebugEvent }) => appendDebugEvent({
      type: 'offline_initial_render_slow',
      level: 'warn',
      message: `Offline initial render slow: ${Math.round(initialRenderMs)}ms`,
      context: {
        chatId,
        durationMs: Math.round(initialRenderMs),
        ensureUserMs: Math.round(userReadyAt - renderStartedAt),
        coreDataMs: Math.round(coreDataReadyAt - userReadyAt),
        sessionRecoveryMs: Math.round(sessionReadyAt - coreDataReadyAt),
        displayDataMs: Math.round(displayDataReadyAt - sessionReadyAt),
        bindAndPaintMs: Math.round(paintedAt - displayDataReadyAt),
        beatCount: Array.isArray(session?.beats) ? session.beats.length : 0,
      },
    })).catch(() => {});
  }
  if (justStarted && session && !session.beats.some((b) => b.role === 'narration')) {
    await onAdvance();
  }
}
