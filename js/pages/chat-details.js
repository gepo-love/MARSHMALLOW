import { back, navigate, invalidateKeepAlive } from '../core/router.js';
import { consumeRoutePrefetchData } from '../core/route-prefetch.js';
import { icon } from '../components/svg-icons.js';
import { showToast } from '../components/toast.js';
import { openTextEditorModal } from '../components/text-editor-modal.js';
import { chooseOfflineExperienceMode } from '../components/offline-experience-mode-sheet.js';
import { ensureDefaultUser } from '../core/user-slot.js';
import {
  getChat,
  findPrivateChat,
  saveChat,
  updateChatDirectives,
  listMessagesForChat,
  computeSparkStatsForChat,
  clearChatHistory,
  pruneChatHistory,
  clearChatMemories,
  leaveGroupAsUser,
  promoteBackstageChatToGroup,
  listChatsForUser,
} from '../core/chat-store.js';
import { getRecord, get, put, putRecord } from '../core/db.js';
import {
  loadCharacterLiveState,
  setCharacterStatusPolicy,
  setManualCharacterStatus,
} from '../core/character-live-state.js';
import { characterAvatarHtml, escAttr } from '../components/scrapbook-illustrations.js';
import {
  listBeautifyAssets,
  resolveBeautifyCssAssets,
  saveBeautifyImageDataUrl,
  saveBeautifyImageUrl,
} from '../core/beautify-assets.js';
import { openParticipantPicker } from '../components/participant-picker.js';
import { openChatRowSheet } from '../components/chat-row-sheet.js';
import {
  listCharacters,
  getCharacter,
  saveCharacterForUser,
} from '../core/character-store.js';
import {
  getLightweightNpc,
  promoteLightweightNpcToCharacter,
  updateLightweightNpcTranslationProfile,
} from '../core/lightweight-npc.js';
import {
  listStickerPackSummaries,
  normalizeBoundStickerPackIdsFromRow,
} from '../core/sticker-store.js';
import {
  AI_REACT_KIND_EMOJI,
  AI_REACT_KIND_KAOMOJI,
  EXPRESSION_FREQUENCY_HIGH,
  EXPRESSION_FREQUENCY_LOW,
  EXPRESSION_FREQUENCY_NORMAL,
  EXPRESSION_FREQUENCY_OFF,
  chatEmoteSettingsMeta,
  loadKaomojiLibrary,
  parseKaomojiImportText,
  resolveChatEmoteSettings,
  saveKaomojiLibrary,
} from '../core/chat/chat-emote-settings.js';
import {
  loadCharacterPhoneContacts,
  buildPhoneLightContactCharacter,
  findPhoneContactByActorId,
  syncPhoneContactGroupFromChat,
} from '../core/character-phone-contacts.js';
import { loadRelationshipNetwork } from '../core/relationship-network.js';
import {
  getAnonymousMainChatInjectMode,
  getAnonymousMemoryMode,
  getAnonymousPrivateCounterpartId,
  applyAnonymousIdentityPatch,
} from '../core/anonymous-chat.js';
import { getAnonymousParticipantPresentation } from '../core/anonymous-identity-presenter.js';
import { loadAnonymousSpaceUserProfile, saveUserSpaceProfile, syncAnonymousSpaceAvatarToChats } from '../core/anonymous-space.js';
import { isAnonymousChat, isStreamerSourcedChat } from '../core/chat-helpers.js';
import {
  normalizeChatBubbleRange,
  resolveEnabledChatBubbleRange,
} from '../core/chat-bubble-range.js';
import { DEFAULT_CHASE_MIN_INTERVAL_MINUTES } from '../core/chat/marshmallow-presence.js';
import { createAnonymousPrivateFromGroup } from '../core/anonymous-private-chat.js';
import { buildAnonymousContactEntry } from '../core/anonymous-contacts.js';
import {
  ANONYMOUS_MAIN_CHAT_INJECT_MODES,
  ANONYMOUS_MEMORY_MODES,
} from '../data/anonymous-room-presets.js';
import { estimateChatInputTokens } from '../core/context/estimate-chat-tokens.js';
import {
  CHAT_CONTEXT_DEPTH_DEFAULT,
  CHAT_CONTEXT_DEPTH_MAX,
  CHAT_CONTEXT_DEPTH_MIN,
  normalizeChatContextDepth,
} from '../core/context/prompt-registry.js';
import { getActiveEvent, clearActiveEvent, isActiveEventUserVisible } from '../core/chat/active-event.js';
import {
  resolveLinkageNudgeEvery,
  resolveLinkageCadenceMode,
  resolveLinkageMinIntervalTurns,
  resolveLinkageRouteBias,
  resolveLinkageGroupPityEvery,
  resolveAiGroupCreationCooldownTurns,
  LINKAGE_NUDGE_EVERY_MIN,
  LINKAGE_NUDGE_EVERY_MAX,
  DEFAULT_LINKAGE_NUDGE_EVERY,
  LINKAGE_MIN_INTERVAL_TURNS_MIN,
  LINKAGE_MIN_INTERVAL_TURNS_MAX,
  DEFAULT_LINKAGE_MIN_INTERVAL_TURNS,
  LINKAGE_GROUP_PITY_MIN,
  LINKAGE_GROUP_PITY_MAX,
  DEFAULT_LINKAGE_GROUP_PITY_EVERY,
  AI_GROUP_CREATION_COOLDOWN_TURNS_MIN,
  AI_GROUP_CREATION_COOLDOWN_TURNS_MAX,
  DEFAULT_AI_GROUP_CREATION_COOLDOWN_TURNS,
} from '../core/chat/chat-linkage-settings.js';
import {
  buildTimezoneSettingsPreview,
  normalizeTimezoneId,
  resolveCharacterTimezone,
  formatTimezoneDisplayName,
} from '../core/chat/chat-timezone.js';
import { getUserTimezone } from '../core/time-mode.js';
import { TIMEZONE_OPTION_GROUPS } from '../data/timezone-options.js';
import {
  loadDriftBottleScanSettings,
  saveDriftBottleScanSettings,
  clampDriftBottleScanIntervalMinutes,
  DRIFT_BOTTLE_SCAN_INTERVAL_MIN,
  DRIFT_BOTTLE_SCAN_INTERVAL_MAX,
} from '../core/chat/drift-bottle-proactive.js';
import { getUserDisplayName } from '../models/user.js';
import {
  isNoUserGroup,
  resolveUserTopicPolicy,
} from '../models/chat.js';
import { resolveActorDisplayLabel } from '../core/chat/character-code-fallback.js';
import {
  maybeSummarizeChatMemory,
  describeChatSummaryFailure,
  isChatSummaryInFlight,
  extractChatSharedMemory,
  getChatSummaryStatus,
  resolveChatSummarySettings,
} from '../core/chat-summary.js';
import {
  getCharacterAiContextName,
  normalizeTranslationProfile,
  resolveVoiceTranslationProfile,
} from '../models/character.js';
import { resolveVoiceCallReplyDisplayMode } from '../core/chat/voice-call-guard.js';
import {
  narrationUserPersonOptions,
  normalizeNarrationUserPerson,
} from '../core/narration-style-guard.js';
import { setChatBlockedByUser, getChatBlockedState, patchChatPrefs, loadChatPrefs } from '../core/chat-block-state.js';
import { promptProfilePrefsPatch, resolvePromptProfile } from '../core/prompt-profile.js';
import {
  getChatAppearance,
  markChatSessionAppearanceActive,
  clampWallpaperOpacity,
  clampChatAvatarSize,
  DEFAULT_CHAT_AVATAR_SIZE,
  MIN_CHAT_AVATAR_SIZE,
  MAX_CHAT_AVATAR_SIZE,
  loadChatAppearancePresets,
  saveChatAppearancePreset,
  deleteChatAppearancePreset,
  presetToAppearance,
  pickChatAppearanceGroupSettings,
  buildChatAppearanceReferenceMarkdown,
} from '../core/chat-appearance.js';
import {
  getInnerVoiceCard,
  normalizeInnerVoiceCard,
  loadInnerVoiceCardPresets,
  saveInnerVoiceCardPreset,
  deleteInnerVoiceCardPreset,
  presetToCard,
  findMatchingPresetId,
  buildInnerVoiceCardReferenceMarkdown,
  buildInnerVoiceCardExportPayload,
  parseInnerVoiceCardImportText,
  INNER_VOICE_LABEL_DEFAULTS,
  INNER_VOICE_CARD_CHANGED_EVENT,
} from '../core/chat/inner-voice-style.js';
import { normalizeInnerVoiceInjectCount } from '../core/chat/inner-voice-history-settings.js';
import {
  buildThinkingPromptExportPayload,
  deleteThinkingPromptPreset,
  loadThinkingPromptPresets,
  normalizeThinkingPromptConfig,
  parseThinkingPromptImportText,
  saveThinkingPromptPreset,
} from '../core/chat/thinking-prompt-prefs.js';
import { downloadTextFile } from '../core/appearance-theme-export.js';
import { shareToCommunityStore } from '../core/community-share-draft.js';
import {
  MEMORY_INJECTION_LIMIT_MAX,
  RELATED_MEMORY_CHAT_MAX,
  memoryInjectionSettingsPatch,
  normalizeMemoryInjectionSettings,
} from '../core/memory/memory-injection-settings.js';
import {
  resolveMemoryShareOptionLabel,
  uniquifyMemoryShareLabels,
} from '../core/memory/memory-chat-label.js';
import {
  getGlobalChatBubbleFontSize,
  setGlobalChatBubbleFontSize,
  clampChatBubbleFontSize,
  MIN_CHAT_BUBBLE_FONT_SIZE,
  MAX_CHAT_BUBBLE_FONT_SIZE,
  getActiveTheme,
  isWindowHomeTheme,
  isSeaHomeTheme,
  loadAppearancePrefs,
  normalizeChatPlatform,
  setChatPlatform,
} from '../core/appearance-prefs.js';
import {
  listAllWorldBookRows,
  listWorldBookRootOptions,
  normalizeWorldBookIds,
} from '../core/world-book-store.js';
import { listMainApiPresetOptions } from '../core/api-presets.js';
import { isNativeShell } from '../core/native-update-bridge.js';
import { isStrangerInterceptChat, visibleIdentityFor } from '../core/stranger-thread-model.js';
import { principalKey } from '../core/alias-account-model.js';
import { resetCharacterSlotProgress } from '../core/character-progress-reset.js';
import { pickWebSaveWritable } from '../core/native-download.js';
import { triggerFileInput } from '../core/open-file-picker.js';
import {
  exportChatRecords,
  importChatRecordsIntoChat,
  parseChatRecordJson,
} from '../core/chat-record-transfer.js';
import {
  loadChatSettingsPresets,
  saveChatSettingsPreset,
  renameChatSettingsPreset,
  deleteChatSettingsPreset,
  pickChatSettingsPresetPrefs,
} from '../core/chat/chat-settings-presets.js';
import {
  listOnlineBuiltinPresets,
  loadDisabledBuiltinPresetIds,
} from '../core/preset-store.js';

const CD_OPEN_GROUPS_KEY = 'mm-chat-details-open';
const selectedChatSettingsPresetIds = new Map();
const chatDetailsRenderRuntime = new WeakMap();
const chatDetailsRenderEpoch = new WeakMap();
let backgroundSchedulerModulePromise = null;
let imageCropModulePromise = null;
let characterTimeCapsuleModulePromise = null;

function loadBackgroundSchedulerModule() {
  if (!backgroundSchedulerModulePromise) {
    backgroundSchedulerModulePromise = import('../core/background-scheduler.js').catch((error) => {
      backgroundSchedulerModulePromise = null;
      throw error;
    });
  }
  return backgroundSchedulerModulePromise;
}

function loadImageCropModule() {
  if (!imageCropModulePromise) {
    imageCropModulePromise = import('../components/image-crop-modal.js').catch((error) => {
      imageCropModulePromise = null;
      throw error;
    });
  }
  return imageCropModulePromise;
}

function loadCharacterTimeCapsuleModule() {
  if (!characterTimeCapsuleModulePromise) {
    characterTimeCapsuleModulePromise = import('../core/character-time-capsule.js').catch((error) => {
      characterTimeCapsuleModulePromise = null;
      throw error;
    });
  }
  return characterTimeCapsuleModulePromise;
}

async function scheduleChatLazy(chat) {
  const { scheduleChat } = await loadBackgroundSchedulerModule();
  return scheduleChat(chat);
}

async function unscheduleChatLazy(chatId) {
  const { unscheduleChat } = await loadBackgroundSchedulerModule();
  return unscheduleChat(chatId);
}

async function refreshDriftBottleScanTimerLazy() {
  const { refreshDriftBottleScanTimer } = await loadBackgroundSchedulerModule();
  return refreshDriftBottleScanTimer();
}

/** 首帧先画聊天设定结构；整页重渲染时保留旧页面，避免开关操作闪骨架。 */
function renderChatDetailsSkeleton(container) {
  if (container.firstElementChild) return;
  container.className = 'page scrapbook-page chat-details-page';
  container.innerHTML = `
    <header class="navbar">
      <button type="button" class="navbar-btn" aria-label="返回" disabled>${icon('back')}</button>
      <h1 class="navbar-title">聊天设定</h1>
      <span class="navbar-btn scrapbook-nav-spacer" aria-hidden="true"></span>
    </header>
    <main class="chat-details-scroll scrapbook-scroll" aria-busy="true">
      <div class="page-skeleton" aria-hidden="true">
        <div class="sk-row">
          <span class="sk-block sk-circle"></span>
          <span class="sk-block sk-bar" style="width:38%"></span>
        </div>
        <span class="sk-block" style="height:92px"></span>
        <span class="sk-block sk-bar" style="width:54%"></span>
        <span class="sk-block" style="height:72px"></span>
        <span class="sk-block" style="height:72px"></span>
      </div>
    </main>`;
}

function readOpenCdGroups() {
  try {
    const raw = sessionStorage.getItem(CD_OPEN_GROUPS_KEY);
    if (raw === null) return new Set(['real-person']);
    const parsed = raw ? JSON.parse(raw) : [];
    const set = new Set(Array.isArray(parsed) ? parsed.map(String) : []);
    // 旧版合并组 look → 壁纸 / 消息美化
    if (set.has('look')) {
      set.add('wallpaper');
      set.add('beautify');
      set.delete('look');
    }
    return set;
  } catch {
    return new Set();
  }
}

function writeOpenCdGroups(set) {
  try {
    sessionStorage.setItem(CD_OPEN_GROUPS_KEY, JSON.stringify([...set]));
  } catch {
    /* ignore quota */
  }
}

function cdDetailsGroup(id, title, meta, body, openGroups, extraClass = '') {
  const open = openGroups.has(id);
  const extra = String(extraClass || '').trim();
  return `
    <details class="chat-details-group scrapbook-card${extra ? ` ${extra}` : ''}" data-cd-group="${esc(id)}" data-cd-hydrated="${open ? '1' : '0'}"${open ? ' open' : ''}>
      <summary class="chat-details-group-summary">
        <span class="chat-details-group-title">${title}</span>
        <small class="chat-details-group-meta">${meta}</small>
        ${icon('chevronDown')}
      </summary>
      <div class="chat-details-group-body">${open ? body : ''}</div>
    </details>`;
}

function confirmCharacterProgressReset(characterName = '该角色') {
  const host = document.getElementById('modal-container');
  if (!host) {
    return Promise.resolve(window.confirm(`清空「${characterName}」在当前档位的相关内容？此操作不可恢复。`));
  }
  return new Promise((resolve) => {
    let settled = false;
    const close = (confirmed = false) => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKeydown);
      host.classList.remove('active');
      host.innerHTML = '';
      resolve(confirmed);
    };
    const onKeydown = (event) => {
      if (event.key === 'Escape') close(false);
    };
    host.classList.add('active');
    host.innerHTML = `
      <div class="modal-overlay modal-sheet-center" data-character-reset-overlay>
        <div class="modal-sheet scrapbook-card" role="dialog" aria-modal="true" aria-labelledby="character-reset-title">
          <header class="modal-header">
            <h3 id="character-reset-title">清除角色相关内容</h3>
          </header>
          <div class="modal-body">
            <p>将清空「${esc(characterName)}」在当前档位的聊天、记忆、手机内容、自动化、线下记录与群像事件状态。</p>
            <p>角色卡、人设、当前窗口外观和群聊会保留。此操作不可恢复。</p>
            <div class="modal-actions">
              <button type="button" class="btn btn-outline" data-character-reset-cancel>取消</button>
              <button type="button" class="btn btn-primary" data-character-reset-confirm>确认清除</button>
            </div>
          </div>
        </div>
      </div>
    `;
    host.querySelector('[data-character-reset-overlay]')?.addEventListener('click', () => close(false));
    host.querySelector('.modal-sheet')?.addEventListener('click', (event) => event.stopPropagation());
    host.querySelector('[data-character-reset-cancel]')?.addEventListener('click', () => close(false));
    host.querySelector('[data-character-reset-confirm]')?.addEventListener('click', () => close(true));
    document.addEventListener('keydown', onKeydown);
    host.querySelector('[data-character-reset-confirm]')?.focus();
  });
}

function esc(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const QUICK_TRANSLATION_MODES = [
  ['off', '关闭'],
  ['full', '整句外语 / 方言 + 翻译'],
  ['mixed', '中文为主，外语 / 方言就地翻译'],
];

const QUICK_TRANSLATION_LANGUAGES = [
  ['', '由 AI 按人设判断'],
  ['英语', '英语'], ['日语', '日语'], ['韩语', '韩语'],
  ['法语', '法语'], ['德语', '德语'], ['西班牙语', '西班牙语'],
  ['葡萄牙语', '葡萄牙语'], ['意大利语', '意大利语'], ['俄语', '俄语'],
  ['阿拉伯语', '阿拉伯语'], ['泰语', '泰语'], ['越南语', '越南语'],
  ['印尼语', '印尼语'], ['土耳其语', '土耳其语'], ['荷兰语', '荷兰语'],
  ['粤语', '粤语（方言）'],
];

function quickTranslationMeta(profile = {}) {
  const row = normalizeTranslationProfile(profile);
  if (row.mode === 'off') return '已关闭';
  const mode = row.mode === 'full' ? '整句翻译' : '混合翻译';
  return row.language ? `${mode} · ${row.language}` : mode;
}

function formatTokenCount(n) {
  const num = Math.max(0, Math.round(Number(n) || 0));
  return num.toLocaleString('zh-CN');
}

function formatStorageSize(bytes = 0) {
  const value = Math.max(0, Number(bytes || 0) || 0);
  if (value < 1024) return `${Math.round(value)} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(value < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function renderTokenBreakdownRows(rows = [], depth = 0) {
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const children = Array.isArray(row.children) ? row.children : [];
    const hasChildren = children.length > 0;
    const main = hasChildren
      ? `<button type="button" class="cd-token-row-main" data-token-toggle aria-expanded="false">
          <span class="cd-token-label">${esc(row.label || row.id || '未命名')}</span>
          <span class="cd-token-value">${formatTokenCount(row.tokens)} <small>tok</small></span>
          <span class="cd-token-row-chevron" aria-hidden="true">›</span>
        </button>`
      : `<div class="cd-token-row-main">
          <span class="cd-token-label">${esc(row.label || row.id || '未命名')}</span>
          <span class="cd-token-value">${formatTokenCount(row.tokens)} <small>tok</small></span>
        </div>`;
    return `
      <div class="cd-token-row ${hasChildren ? 'has-children' : ''}" style="--cd-token-depth:${depth}">
        ${main}
        ${hasChildren ? `<div class="cd-token-children" hidden>${renderTokenBreakdownRows(children, depth + 1)}</div>` : ''}
      </div>
    `;
  }).join('');
}

async function resolvePartner(chat, identityUserId = '', relationshipUserId = '') {
  if (!chat || chat.type === 'group') return null;
  const partnerId = (chat.participants || []).find((p) => p && p !== 'user');
  if (!partnerId) return null;
  const stored = identityUserId
    ? getCharacter(partnerId, { userId: identityUserId })
    : getRecord('characters', partnerId);
  return (await stored.catch(() => null))
    || getLightweightNpc(partnerId, relationshipUserId || identityUserId).catch(() => null);
}

function getGroupOwnerId(chat) {
  const owner = String(chat?.groupSettings?.owner || '').trim();
  if (owner) return owner;
  const parts = chat?.participants || [];
  if (parts.includes('user')) return 'user';
  return String(parts.find((id) => id && id !== 'user') || '').trim();
}

function getGroupRoleLabel(chat, memberId) {
  const id = String(memberId || '').trim();
  if (!id) return '';
  const customTitle = String(chat?.groupSettings?.titles?.[id] || '').trim();
  const systemRole = getGroupOwnerId(chat) === id
    ? '群主'
    : ((chat?.groupSettings?.admins || []).includes(id) ? '管理员' : '');
  return [customTitle, systemRole].filter(Boolean).join(' · ');
}

function todoId() {
  return `todo_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

function renderGroupTodoList(todos = []) {
  const list = (Array.isArray(todos) ? todos : []).filter((item) => item && String(item.text || '').trim());
  if (!list.length) {
    return '<div class="group-info-empty-line">暂无群待办</div>';
  }
  return list.map((item) => `
    <div class="group-todo-row ${item.done ? 'is-done' : ''}">
      <label class="group-todo-check">
        <input type="checkbox" class="cd-group-todo-toggle" data-todo-id="${esc(item.id)}" ${item.done ? 'checked' : ''} />
        <span>${esc(item.text)}</span>
      </label>
      <button type="button" class="group-mini-icon-btn cd-group-todo-delete" data-todo-id="${esc(item.id)}" aria-label="删除待办">${icon('close')}</button>
    </div>
  `).join('');
}

function anonymousAvatarHtml(label = '', avatarUrl = '') {
  const av = String(avatarUrl || '').trim();
  if (/^(data:image\/|https?:\/\/)/i.test(av)) {
    return `<img src="${escAttr(av)}" alt="" loading="lazy" decoding="async">`;
  }
  const text = String(label || '匿名').trim();
  return `<span class="anon-detail-avatar">${esc(text.slice(0, 1) || '?')}</span>`;
}

function buildMuteBadge() {
  return '<span class="group-member-mute-badge" aria-label="已禁言">禁</span>';
}

/**
 * 页面里几乎每个开关/选择类操作都靠整页重渲染来反映最新状态，但
 * container.innerHTML 重建会把 .chat-details-scroll 的 scrollTop 清零，
 * 长设置页里点一下就弹回顶部——这里包一层，重渲染前后自己搬运滚动位置。
 */
async function rerenderKeepScroll(container, params, options = {}) {
  const scroller = container.querySelector('.chat-details-scroll');
  const top = scroller ? scroller.scrollTop : 0;
  const anchorGroupId = String(options.anchorGroupId || '').trim();
  const anchor = anchorGroupId
    ? scroller?.querySelector(`details[data-cd-group="${CSS.escape(anchorGroupId)}"] > summary`)
    : null;
  const anchorTop = anchor?.getBoundingClientRect().top;
  const runtime = chatDetailsRenderRuntime.get(container);
  const nextParams = runtime?.chatId && runtime.chatId === String(params?.chatId || '').trim()
    ? { ...params, __chatDetailsSnapshot: runtime.getSnapshot() }
    : params;
  await render(container, nextParams);
  const nextScroller = container.querySelector('.chat-details-scroll');
  if (!nextScroller) return;
  nextScroller.scrollTop = top;
  if (!anchorGroupId || !Number.isFinite(anchorTop)) return;
  const nextAnchor = nextScroller.querySelector(`details[data-cd-group="${CSS.escape(anchorGroupId)}"] > summary`);
  if (!nextAnchor) return;
  // content-visibility 会在折叠组首次挂载时修正离屏占位高度。只恢复 scrollTop
  // 仍可能被这次修正再次推走；以用户刚点的摘要为锚，保证它留在原屏幕位置。
  const delta = nextAnchor.getBoundingClientRect().top - anchorTop;
  if (Math.abs(delta) > 0.5) nextScroller.scrollTop += delta;
}

async function buildMemoryShareOptions(userId, currentChatId, selectedIds = []) {
  const [chats, characterRows] = await Promise.all([
    listChatsForUser(userId).catch(() => []),
    listCharacters({ userId, excludeAnonNpc: true }).catch(() => []),
  ]);
  const characters = new Map(characterRows.filter((row) => row?.id).map((row) => [row.id, row]));
  const selected = new Set((Array.isArray(selectedIds) ? selectedIds : []).map(String));
  const options = (Array.isArray(chats) ? chats : [])
    .filter((row) => row?.id && row.id !== currentChatId && !isAnonymousChat(row)
      && Array.isArray(row.participants) && row.participants.includes('user'))
    .sort((left, right) => Number(selected.has(String(right.id))) - Number(selected.has(String(left.id)))
      || Number(right.lastActivity || 0) - Number(left.lastActivity || 0))
    .slice(0, RELATED_MEMORY_CHAT_MAX)
    .map((row) => ({
      id: row.id,
      label: resolveMemoryShareOptionLabel(row, characters, { userId }),
      type: row.type,
    }));
  return uniquifyMemoryShareLabels(options);
}

export default async function render(container, params = {}) {
  const renderEpoch = (chatDetailsRenderEpoch.get(container) || 0) + 1;
  chatDetailsRenderEpoch.set(container, renderEpoch);
  const isCurrentRender = () => chatDetailsRenderEpoch.get(container) === renderEpoch;
  const perfStartedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
  let perfLastAt = perfStartedAt;
  const perfPhases = {};
  const markPerfPhase = (name) => {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    perfPhases[name] = Math.max(0, Math.round(now - perfLastAt));
    perfLastAt = now;
  };
  const chatId = String(params.chatId || '').trim();
  const openCdGroups = readOpenCdGroups();
  const focusedDetailsGroup = String(params.focus || '').trim();
  if (focusedDetailsGroup === 'translation') openCdGroups.add('translation');
  const runtimeSnapshot = params.__chatDetailsSnapshot;
  // 首次进入才画骨架；页内展开/改设置已有内存快照时保留当前 DOM，等新内容
  // 完整就绪再一次替换，避免整页先闪成骨架再弹回设置项。
  if (!runtimeSnapshot || String(runtimeSnapshot.chat?.id || '') !== chatId) {
    renderChatDetailsSkeleton(container);
  }
  const prefetched = runtimeSnapshot && String(runtimeSnapshot.chat?.id || '') === chatId
    ? runtimeSnapshot
    : (chatId
      ? await (consumeRoutePrefetchData('chat/details', { chatId }) || Promise.resolve(null)).catch(() => null)
      : null);
  const prefetchedChat = prefetched?.chat && String(prefetched.chat.id || '') === chatId
    ? prefetched.chat
    : null;
  const [user, loadedChat] = await Promise.all([
    prefetched?.user ? Promise.resolve(prefetched.user) : ensureDefaultUser(),
    prefetchedChat ? Promise.resolve(prefetchedChat) : (chatId ? getChat(chatId) : Promise.resolve(null)),
  ]);
  markPerfPhase('userChat');
  if (!isCurrentRender()) return;
  const currentUserName = getUserDisplayName(user);
  let chat = loadedChat;
  if (!chat) {
    container.className = 'page scrapbook-page';
    container.innerHTML = `<div class="chat-empty scrapbook-empty"><div class="chat-empty-text">会话不存在</div></div>`;
    return;
  }

  const shellFrom = String(params.from || '').trim();
  const anonymousChat = isAnonymousChat(chat);
  const strangerChat = isStrangerInterceptChat(chat);
  const streamerSourced = isStreamerSourcedChat(chat);
  if (!anonymousChat && shellFrom === 'anon') {
    navigate('chat/details', { chatId }, true);
    return;
  }
  const enteredViaValidShell = shellFrom === 'anon' || (streamerSourced && shellFrom === 'streamer');
  if (anonymousChat && !enteredViaValidShell) {
    if (streamerSourced) {
      showToast('请从主播空间进入这个聊天');
      navigate('anon/streamer/space', chat.metadata?.streamerChannelId ? { channelId: chat.metadata.streamerChannelId } : {}, true);
    } else {
      showToast('匿名会话详情请从匿名聊天室进入');
      navigate('chat', {}, true);
    }
    return;
  }

  const isGroup = chat.type === 'group';
  const noUserGroup = isNoUserGroup(chat);
  const anonShell = anonymousChat && enteredViaValidShell;
  const anonEditorVariant = () => (anonShell ? 'anon' : '');
  const [anonSpaceProfile, resolvedPartner, loadedPrefs] = await Promise.all([
    Object.prototype.hasOwnProperty.call(prefetched || {}, 'anonSpaceProfile')
      ? Promise.resolve(prefetched.anonSpaceProfile)
      : (anonShell ? loadAnonymousSpaceUserProfile(user.id) : Promise.resolve(null)),
    Object.prototype.hasOwnProperty.call(prefetched || {}, 'partner')
      ? Promise.resolve(prefetched.partner)
      : resolvePartner(chat, anonShell ? '' : user.id, user.id),
    prefetched?.chatPrefs ? Promise.resolve(prefetched.chatPrefs) : loadChatPrefs(chatId).catch(() => ({})),
  ]);
  markPerfPhase('partnerPrefs');
  if (!isCurrentRender()) return;
  let partner = resolvedPartner;
  const anonPresentationOpts = { currentUserName, userRow: user, spaceProfile: anonSpaceProfile };
  const strangerPartnerId = (chat.participants || []).find((id) => id && id !== 'user') || '';
  const strangerPartnerProfile = strangerChat
    ? visibleIdentityFor(chat.metadata, principalKey('character', strangerPartnerId), partner || {})
    : null;
  let prefs = loadedPrefs;
  const narrationUserPerson = normalizeNarrationUserPerson(prefs.narrationUserPerson);
  const narrationUserPersonOptionsHtml = narrationUserPersonOptions()
    .map((option) => `<option value="${escAttr(option.value)}" ${option.value === narrationUserPerson ? 'selected' : ''}>${esc(option.label)}</option>`)
    .join('');
  const voicePerformanceBubbleGapMs = (() => {
    const value = Number(prefs.voicePerformanceBubbleGapMs);
    if (!Number.isFinite(value)) return 400;
    return Math.max(200, Math.min(5000, Math.round(value / 100) * 100));
  })();
  const narrationSoundEffectsVolume = (() => {
    const value = Number(prefs.narrationSoundEffectsVolume);
    if (!Number.isFinite(value)) return 58;
    return Math.max(0, Math.min(100, Math.round(value)));
  })();
  const narrationBackgroundVolume = (() => {
    const value = Number(prefs.narrationBackgroundVolume);
    if (!Number.isFinite(value)) return 22;
    return Math.max(0, Math.min(100, Math.round(value)));
  })();
  const callProactiveIntervalSeconds = (() => {
    const value = Number(prefs.callProactiveIntervalSeconds);
    return [30, 60, 120, 300].includes(value) ? value : 60;
  })();
  const partnerCallTranslation = resolveVoiceTranslationProfile(partner?.translationProfile);
  const callReplyDisplayMode = resolveVoiceCallReplyDisplayMode(
    prefs.callReplyDisplayMode,
    { translationActive: partnerCallTranslation.active },
  );
  const memoryInjection = normalizeMemoryInjectionSettings(loadedPrefs);
  const needsDialogData = openCdGroups.has('dialog');
  const needsEmoteData = openCdGroups.has('emote');
  const needsMemoryData = openCdGroups.has('memory');
  const needsWorldBookData = openCdGroups.has('worldbook');
  const needsBeautifyData = openCdGroups.has('beautify');
  const needsInnerVoiceData = openCdGroups.has('innervoice');
  const needsBlockData = openCdGroups.has('block');
  const needsArchiveData = openCdGroups.has('archive');
  const earlyPartnerId = String(partner?.id || '').trim();
  const earlyAutonomyActorId = !isGroup && !strangerChat
    ? String((chat.participants || []).find((id) => id && id !== 'user') || earlyPartnerId).trim()
    : '';
  const liveStatePromise = !isGroup && !strangerChat && !anonShell && earlyPartnerId
    ? loadCharacterLiveState(user.id, earlyPartnerId).catch(() => null)
    : Promise.resolve(null);
  const autonomyBundlePromise = !isGroup && !strangerChat && earlyAutonomyActorId
    ? import('../core/character-autonomy-settings.js').then(async (module) => ({
      module,
      policy: await module.loadResolvedCharacterAutonomyPolicy(user.id, earlyAutonomyActorId, chatId),
    })).catch(() => null)
    : Promise.resolve(null);
  const lifeGlimpseSettingsPromise = !isGroup && !strangerChat && !anonShell && earlyAutonomyActorId
    ? import('../core/chat/life-glimpse.js')
      .then((module) => module.loadLifeGlimpseSettings(user.id, earlyAutonomyActorId))
      .catch(() => null)
    : Promise.resolve(null);
  const appearanceDataPromise = Promise.all([
    needsBeautifyData ? loadChatAppearancePresets().catch(() => []) : Promise.resolve([]),
    loadAppearancePrefs().catch(() => ({})),
    needsInnerVoiceData ? loadInnerVoiceCardPresets().catch(() => []) : Promise.resolve([]),
    needsDialogData ? loadThinkingPromptPresets().catch(() => []) : Promise.resolve([]),
    needsBeautifyData ? getGlobalChatBubbleFontSize().catch(() => 14) : Promise.resolve(14),
    needsDialogData
      ? getUserTimezone(user.id).catch(() => String(user?.timezone || '').trim())
      : Promise.resolve(String(user?.timezone || '').trim()),
    loadChatSettingsPresets().catch(() => []),
  ]);
  const characterTimeCapsuleDataPromise = needsArchiveData
    ? loadCharacterTimeCapsuleModule()
    : Promise.resolve(null);
  const supportDataPromise = Promise.all([
    import('../core/chat/idle-continue-reply.js').then(async (module) => ({
      module,
      value: await module.loadIdleContinueSettings(chatId).catch(() => ({ enabled: false, minutes: 3 })),
    })),
    needsBlockData
      ? loadDriftBottleScanSettings(user.id).catch(() => ({}))
      : Promise.resolve({}),
    needsEmoteData ? listStickerPackSummaries().catch(() => []) : Promise.resolve([]),
    needsEmoteData ? loadKaomojiLibrary().catch(() => []) : Promise.resolve([]),
    !anonShell && needsWorldBookData
      ? listAllWorldBookRows().catch(() => [])
      : Promise.resolve([]),
    needsDialogData ? listMainApiPresetOptions().catch(() => []) : Promise.resolve([]),
    !anonShell && needsMemoryData
      ? buildMemoryShareOptions(user.id, chatId, memoryInjection.explicitSharedChatIds)
      : Promise.resolve([]),
    !anonShell && needsWorldBookData
      ? loadDisabledBuiltinPresetIds().catch(() => new Set())
      : Promise.resolve(new Set()),
  ]);
  const [
    idleBundle,
    loadedDriftBottleScan,
    stickerPacks,
    kaomojiLibrary,
    worldBookRows,
    mainApiPresetOptions,
    memoryShareOptions,
    disabledBuiltinPresetIds,
  ] = await supportDataPromise;
  markPerfPhase('supportData');
  if (!isCurrentRender()) return;
  const {
    saveIdleContinueSettings,
    IDLE_CONTINUE_MIN_MINUTES,
    IDLE_CONTINUE_MAX_MINUTES,
  } = idleBundle.module;
  let idleContinue = idleBundle.value;
  let driftBottleScan = loadedDriftBottleScan;
  const summarySettings = resolveChatSummarySettings(chat, prefs);
  const autoSummary = summarySettings.autoSummary === true;
  const autoSummaryFreq = summarySettings.autoSummaryFreq;
  const shortBubbleReply = prefs.shortBubbleReply === true;
  const voiceBubblePreferMore = prefs.voiceBubblePreference === 'more';
  const statusStoryMode = prefs.statusStoryMode === true;
  let allowAiStatusUpdates = prefs.allowAiStatusUpdates !== false;
  let allowAiPresenceUpdates = Object.prototype.hasOwnProperty.call(prefs, 'allowAiPresenceUpdates')
    ? prefs.allowAiPresenceUpdates !== false
    : allowAiStatusUpdates;
  let statusManualLocked = false;
  let manualStatusLine = '';
  let manualPresenceState = 'online';
  let allowAiStatusScheduleOverride = prefs.allowAiStatusScheduleOverride !== false;
  const chaseBeatMaxRounds = (() => {
    const n = Math.trunc(Number(prefs.chaseBeatMaxRounds));
    if (!Number.isFinite(n)) return 3;
    return Math.max(0, Math.min(5, n));
  })();
  const chaseMinIntervalMinutes = (() => {
    if (!Object.prototype.hasOwnProperty.call(prefs || {}, 'chaseMinIntervalMinutes')) {
      return DEFAULT_CHASE_MIN_INTERVAL_MINUTES;
    }
    const n = Math.trunc(Number(prefs.chaseMinIntervalMinutes));
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_CHASE_MIN_INTERVAL_MINUTES;
    return Math.min(1440, n);
  })();
  const chatImageGenEnabled = prefs.chatImageGenEnabled === true;
  const stickerVisionEnabled = prefs.stickerVisionEnabled === true;
  const stickerGifFirstFrameEnabled = prefs.stickerGifFirstFrameEnabled === true;
  const emoteSettings = resolveChatEmoteSettings(prefs);
  const boundStickerPackIds = !isGroup && partner
    ? normalizeBoundStickerPackIdsFromRow(partner)
    : [];
  const weiboAllowStickers = !isGroup && partner
    ? partner.weiboAllowStickers !== false
    : true;
  const showChatSpark = prefs.showChatSpark === true;
  const messageTimestampMode = prefs.messageTimestampMode === 'each' ? 'each' : 'last';
  const contextDepth = normalizeChatContextDepth(prefs.contextDepth, CHAT_CONTEXT_DEPTH_DEFAULT);
  const innerVoiceDisabled = prefs.innerVoiceDisabled === true;
  const innerVoiceHidden = prefs.innerVoiceHidden === true;
  const innerVoiceInjectEnabled = prefs.innerVoiceInjectEnabled !== false;
  const innerVoiceInjectCount = normalizeInnerVoiceInjectCount(prefs.innerVoiceInjectCount);
  const seeUserAvatar = prefs.seeUserAvatar === true;
  const chatWorldBookIds = normalizeWorldBookIds(prefs);
  const mainApiPresetId = String(prefs.mainApiPresetId || '').trim();
  const linkagePrivateIds = Array.isArray(prefs.privateLinkageIds)
    ? prefs.privateLinkageIds
    : (chat.groupSettings?.linkagePrivateMemberIds || []);
  // 摘要覆盖统计需要遍历该会话的消息与记忆。大聊天中这是秒级任务，
  // 它不应阻塞设定页首屏；页面先可用，统计再于空闲时补上。
  let memoryCount = 0;
  let summaryStatus = { coveredCount: 0, totalCount: 0, uncoveredCount: 0, firstUncoveredIndex: 0 };
  let memoryStatsPending = true;
  const worldBookOptions = listWorldBookRootOptions(worldBookRows);
  const onlinePresetOptions = listOnlineBuiltinPresets().map((preset) => ({
    id: String(preset.id || '').trim(),
    name: String(preset.name || preset.id || '').trim(),
  })).filter((preset) => preset.id);
  const onlinePresetOptionIds = new Set(onlinePresetOptions.map((preset) => preset.id));
  const onlinePresetOverrideEnabled = Array.isArray(prefs.onlinePresetIds);
  const boundOnlinePresetIds = normalizeWorldBookIds({
    worldBookIds: onlinePresetOverrideEnabled ? prefs.onlinePresetIds : [],
  }).filter((id) => onlinePresetOptionIds.has(id));
  const effectiveOnlinePresetIds = new Set(onlinePresetOverrideEnabled
    ? boundOnlinePresetIds
    : onlinePresetOptions
      .filter((preset) => !disabledBuiltinPresetIds.has(preset.id))
      .map((preset) => preset.id));
  let hasUncoveredSummary = Number(summaryStatus.uncoveredCount || 0) > 0;
  let defaultSummaryFrom = hasUncoveredSummary
    ? summaryStatus.firstUncoveredIndex
    : (summaryStatus.totalCount ? 1 : 0);
  const memberCards = chat.groupSettings?.memberCards || {};
  // 手机轻量群成员多为 phone-contact:…；会话气泡有通讯录补全，详情页也需同一套解析。
  const phoneOwnerId = (() => {
    const fromParams = String(params.viewer || '').trim();
    if (fromParams) return fromParams;
    const fromMeta = String(chat.metadata?.phoneOwnerId || chat.metadata?.focalActorId || '').trim();
    if (fromMeta) return fromMeta;
    for (const id of chat.participants || []) {
      const raw = String(id || '');
      if (!/^phone-contact:/i.test(raw)) continue;
      const parts = raw.split(':');
      if (parts.length < 4) continue;
      try {
        const owner = decodeURIComponent(parts[2] || '');
        if (owner) return owner;
      } catch (_) { /* ignore */ }
    }
    if (String(params.from || '') === 'phone' || chat.metadata?.channel === 'backstage') {
      return (chat.participants || []).find((id) => id && id !== 'user') || '';
    }
    return '';
  })();
  const ownerId = isGroup ? getGroupOwnerId(chat) : '';
  const needsFullGroupMemberData = isGroup
    && (openCdGroups.has('group') || openCdGroups.has('linkage'));
  const needsAuxGroupMemberSources = needsFullGroupMemberData || (ownerId && ownerId !== 'user');
  const [relationshipNetwork, phoneState] = needsAuxGroupMemberSources
    ? await Promise.all([
      loadRelationshipNetwork(user.id).catch(() => null),
      phoneOwnerId
        ? loadCharacterPhoneContacts(user.id, phoneOwnerId).catch(() => null)
        : Promise.resolve(null),
    ])
    : [null, null];
  const phoneContactRows = phoneState?.contacts || [];
  const relationshipNpcCards = new Map();
  for (const npc of relationshipNetwork?.npcs || []) {
    const id = String(npc?.id || '').trim();
    if (id) relationshipNpcCards.set(id, npc);
  }
  // groupMembers / allGroupMembers 会为同一成员各解析一次；缓存 Promise 避免重复读 IDB。
  const memberCharacterPromises = new Map();
  const resolveMemberCharacter = (id) => {
    const key = String(id || '').trim();
    if (memberCharacterPromises.has(key)) return memberCharacterPromises.get(key);
    const pending = (async () => {
      const storedCharacter = await getRecord('characters', key).catch(() => null);
      if (storedCharacter) return { character: storedCharacter, isLightweightNpc: false, isPhoneContact: false };
      // 手机联系人是这部手机里用户实际看到并编辑过的身份。对关系网 / 轻量 NPC，
      // 它应覆盖旧的简略角色快照，且要兼容历史被截短的 phone-contact id。
      const phoneContact = findPhoneContactByActorId(phoneContactRows, key);
      if (phoneContact) {
        const phoneCard = buildPhoneLightContactCharacter(phoneContact, phoneOwnerId);
        return {
          character: { ...phoneCard, id: key },
          isLightweightNpc: false,
          isPhoneContact: true,
        };
      }
      const storedAlias = chat.metadata?.phoneLightNpcAliases?.[key];
      if (storedAlias?.name || storedAlias?.realName) {
        return {
          character: {
            ...storedAlias,
            id: key,
            name: storedAlias.name || storedAlias.realName,
            avatar: storedAlias.avatar || '',
          },
          isLightweightNpc: true,
          isPhoneContact: true,
        };
      }
      const lightweightNpc = await getLightweightNpc(key, user.id).catch(() => null);
      if (lightweightNpc) return { character: lightweightNpc, isLightweightNpc: true, isPhoneContact: false };
      const relationshipNpc = relationshipNpcCards.get(key);
      if (relationshipNpc) {
        return {
          character: {
            ...relationshipNpc,
            id: key,
            realName: relationshipNpc.realName || relationshipNpc.name || key,
            metadata: { ...(relationshipNpc.metadata || {}), isRelationshipNetworkNpc: true },
          },
          isLightweightNpc: false,
          isPhoneContact: false,
        };
      }
      return { character: null, isLightweightNpc: false, isPhoneContact: false };
    })();
    memberCharacterPromises.set(key, pending);
    return pending;
  };
  const groupMembers = needsFullGroupMemberData
    ? await Promise.all((chat.participants || []).filter((id) => id && id !== 'user').map(async (id) => {
      const { character: c, isLightweightNpc, isPhoneContact } = await resolveMemberCharacter(id);
      const anonProfile = anonShell ? getAnonymousParticipantPresentation(chat, id, anonPresentationOpts) : null;
      if (anonProfile?.displayName) {
        return { id, base: anonProfile.displayName, card: '', name: anonProfile.displayName, anonBio: anonProfile.bio || '' };
      }
      const base = resolveActorDisplayLabel(c?.name || c?.customNickname || id, {
        user,
        characters: c ? { [id]: c } : {},
        fallback: '成员',
      });
      const card = String(memberCards[id] || '').trim();
      return { id, base, card, name: card || base, isLightweightNpc, isPhoneContact };
    }))
    : [];
  const mutedSet = new Set(chat.groupSettings?.muted || []);
  const announcement = String(chat.groupSettings?.announcement || '').trim();
  const groupTodos = Array.isArray(chat.groupSettings?.todos) ? chat.groupSettings.todos : [];
  const allGroupMemberIds = needsFullGroupMemberData
    ? (chat.participants || []).filter(Boolean)
    : [ownerId].filter(Boolean);
  const allGroupMembers = isGroup
    ? await Promise.all(allGroupMemberIds.map(async (id) => {
      const anonProfile = anonShell ? getAnonymousParticipantPresentation(chat, id, anonPresentationOpts) : null;
      if (anonProfile?.displayName) {
        return {
          id,
          name: anonProfile.displayName,
          base: anonProfile.displayName,
          avatarHtml: anonymousAvatarHtml(anonProfile.displayName, anonProfile.avatar),
          role: getGroupRoleLabel(chat, id),
          isUser: id === 'user',
        };
      }
      if (id === 'user') {
        return {
          id,
          name: currentUserName,
          base: currentUserName,
          avatarHtml: user.avatar ? `<img src="${escAttr(user.avatar)}" alt="" loading="lazy" decoding="async">` : `<span>${esc(String(currentUserName).slice(0, 1))}</span>`,
          role: getGroupRoleLabel(chat, id),
          isUser: true,
        };
      }
      const { character: c, isLightweightNpc, isPhoneContact } = await resolveMemberCharacter(id);
      const base = resolveActorDisplayLabel(c?.name || c?.customNickname || id, {
        user,
        characters: c ? { [id]: c } : {},
        fallback: '成员',
      });
      const card = String(memberCards[id] || '').trim();
      return {
        id,
        name: card || base,
        base,
        avatarHtml: characterAvatarHtml(c, { className: '' }),
        role: getGroupRoleLabel(chat, id),
        isUser: false,
        isLightweightNpc,
        isPhoneContact,
      };
    }))
    : [];
  markPerfPhase('members');
  if (!isCurrentRender()) return;
  const activeEventCandidate = getActiveEvent(chat);
  const activeEvent = isActiveEventUserVisible(activeEventCandidate) ? activeEventCandidate : null;
  const anonMemoryMode = anonShell ? getAnonymousMemoryMode(chat) : '';
  const anonMainChatInjectMode = anonShell
    ? getAnonymousMainChatInjectMode(chat)
    : 'off';
  const anonymousCounterpartId = anonShell && !isGroup ? getAnonymousPrivateCounterpartId(chat) : '';
  const anonymousPartnerProfile = anonymousCounterpartId
    ? getAnonymousParticipantPresentation(chat, anonymousCounterpartId, anonPresentationOpts)
    : null;
  const userAnonProfile = anonShell
    ? getAnonymousParticipantPresentation(chat, 'user', anonPresentationOpts)
    : null;
  const remarkName = String(strangerPartnerProfile?.displayName || prefs.remarkName || partner?.name || partner?.customNickname || '').trim();
  const relationLabel = strangerChat ? '陌生人' : String(prefs.relationLabel || partner?.currentRole || '').trim();
  const partnerId = partner?.id || '';
  const showOtherBubbleAppearance = anonShell || (!isGroup && !!partnerId);
  const partnerTranslation = normalizeTranslationProfile(partner?.translationProfile);
  const autonomyActorId = !isGroup && !strangerChat
    ? String((chat.participants || []).find((id) => id && id !== 'user') || partnerId).trim()
    : '';
  if (!isGroup && !strangerChat && !anonShell && partnerId) {
    const liveState = await liveStatePromise;
    if (liveState) {
      allowAiStatusUpdates = liveState.policy?.aiUpdatesAllowed !== false
        && liveState.policy?.manualLocked !== true;
      allowAiPresenceUpdates = liveState.policy?.presenceUpdatesAllowed !== false
        && liveState.policy?.presenceManualLocked !== true;
      statusManualLocked = liveState.policy?.manualLocked === true;
      allowAiStatusScheduleOverride = liveState.policy?.sceneScheduleOverrideAllowed !== false;
      manualStatusLine = String(liveState.statusLine?.text || '').trim();
      manualPresenceState = ['online', 'busy', 'offline'].includes(liveState.presence?.state)
        ? liveState.presence.state
        : 'online';
    }
  }
  // 真人感回复是角色级开关（回复方式），这里只是前移一个入口。
  let realPersonEnabled = false;
  let proactiveEnabled = false;
  let mailboxProactiveEnabled = false;
  let mailboxProactiveIntervalHours = 72;
  let systemAutoReplyEnabled = false;
  let allowHardOffline = false;
  let lifeGlimpseEnabled = false;
  let statusActivityLevel = 'natural';
  let realPersonIdleFloorEnabled = false;
  let realPersonIdleFloorSeconds = 3;
  let proactiveMinGapMinutes = 20;
  let idleReplyFloorMinSeconds = 1;
  let idleReplyFloorMaxSeconds = 24 * 60 * 60;
  let autonomyPolicy = null;
  if (!isGroup && !strangerChat && autonomyActorId) {
    try {
      const autonomyBundle = await autonomyBundlePromise;
      if (!autonomyBundle?.module) throw new Error('autonomy settings unavailable');
      const {
        REAL_PERSON_IDLE_REPLY_FLOOR_MIN_SECONDS,
        REAL_PERSON_IDLE_REPLY_FLOOR_MAX_SECONDS,
        REAL_PERSON_IDLE_REPLY_FLOOR_DEFAULT_SECONDS,
      } = autonomyBundle.module;
      idleReplyFloorMinSeconds = REAL_PERSON_IDLE_REPLY_FLOOR_MIN_SECONDS;
      idleReplyFloorMaxSeconds = REAL_PERSON_IDLE_REPLY_FLOOR_MAX_SECONDS;
      autonomyPolicy = autonomyBundle.policy || null;
      realPersonEnabled = autonomyPolicy?.realPersonMode?.enabled === true;
      proactiveEnabled = autonomyPolicy?.totalEnabled === true;
      proactiveMinGapMinutes = Math.max(
        0,
        Math.min(1440, Math.trunc(Number(autonomyPolicy?.scheduleProactive?.minGapMinutes) || 0)),
      );
      mailboxProactiveEnabled = autonomyPolicy?.mailboxProactive?.enabled === true;
      mailboxProactiveIntervalHours = Math.max(
        12,
        Math.min(720, Math.round(Number(autonomyPolicy?.mailboxProactive?.intervalHours) || 72)),
      );
      systemAutoReplyEnabled = autonomyPolicy?.realPersonMode?.systemAutoReplyEnabled === true;
      allowHardOffline = autonomyPolicy?.realPersonMode?.allowHardOffline === true;
      statusActivityLevel = ['quiet', 'natural', 'active'].includes(autonomyPolicy?.realPersonMode?.statusActivityLevel)
        ? autonomyPolicy.realPersonMode.statusActivityLevel
        : 'natural';
      realPersonIdleFloorEnabled = autonomyPolicy?.realPersonMode?.idleReplyFloorEnabled === true;
      realPersonIdleFloorSeconds = Math.max(
        idleReplyFloorMinSeconds,
        Math.min(
          idleReplyFloorMaxSeconds,
          Math.trunc(Number(autonomyPolicy?.realPersonMode?.idleReplyFloorSeconds)
            || REAL_PERSON_IDLE_REPLY_FLOOR_DEFAULT_SECONDS),
        ),
      );
    } catch (_) {}
  }
  lifeGlimpseEnabled = (await lifeGlimpseSettingsPromise)?.enabled === true;
  const description = String(chat.metadata?.description || chat.groupSettings?.description || '').trim();
  const plot = String(chat.metadata?.plotDirective || chat.groupSettings?.plotDirective || '').trim();
  const blockedState = getChatBlockedState(chat, prefs);
  const chatAppearance = getChatAppearance(chat);
  const [
    chatAppearancePresets,
    appearancePrefs,
    innerVoiceCardPresets,
    thinkingPromptPresets,
    globalBubbleFontSize,
    userTimezone,
    chatSettingsPresets,
  ] = await appearanceDataPromise;
  const sparkStats = null;
  const characterTimeCapsuleModule = await characterTimeCapsuleDataPromise;
  markPerfPhase('appearance');
  // 棉花糖之窗/之海默认走 ins 小白卡，会话自己选过骨架的话仍以会话设置为准。
  const activeHomeTheme = getActiveTheme(appearancePrefs);
  const chatPlatform = normalizeChatPlatform(appearancePrefs.chatPlatform);
  const insHomeTheme = isWindowHomeTheme(activeHomeTheme.id, activeHomeTheme.theme)
    || isSeaHomeTheme(activeHomeTheme.id, activeHomeTheme.theme);
  const innerVoiceCard = getInnerVoiceCard(chat, insHomeTheme ? 'ins' : 'diary');
  const innerVoiceCardActivePresetId = findMatchingPresetId(innerVoiceCardPresets, innerVoiceCard);
  const thinkingPrompt = normalizeThinkingPromptConfig({
    mode: prefs.thinkingPromptMode,
    prompt: prefs.thinkingPromptCustom,
  });
  const INNER_VOICE_LABEL_FIELDS = [
    ['titleSuffix', '标题后缀'],
    ['fieldInner', '心声字段名'],
    ['fieldIntent', '心思字段名'],
    ['fieldStatus', '状态字段名'],
    ['fieldMood', '心情字段名'],
    ['fieldMoodBar', '情绪波动字段名'],
    ['tabCurrent', '「当前」tab 文案'],
    ['tabHistory', '「往期」tab 文案'],
    ['closeButton', '关闭按钮文案'],
  ];
  const bubbleFontOverride = Number(chatAppearance.bubbleFontSize) || 0;
  const bubbleFontFollowGlobal = bubbleFontOverride <= 0;
  const bubbleFontValue = clampChatBubbleFontSize(bubbleFontFollowGlobal ? globalBubbleFontSize : bubbleFontOverride);
  const avatarSizeOverride = Number(chatAppearance.avatarSize) || 0;
  const avatarSizeValue = clampChatAvatarSize(avatarSizeOverride || DEFAULT_CHAT_AVATAR_SIZE);
  const narrationFontOverride = Number(chatAppearance.narrationFontSize) || 0;
  const narrationFontValue = narrationFontOverride > 0
    ? Math.max(11, Math.min(18, Math.round(narrationFontOverride)))
    : 12;
  const timezoneEnabled = prefs.timezoneEnabled === true;
  const characterTimezone = resolveCharacterTimezone(prefs, partner);
  const timezonePreview = buildTimezoneSettingsPreview(
    { ...prefs, timezoneEnabled, characterTimezone },
    user,
    partner,
    Date.now(),
    { userTimezone },
  );
  const knownTimezoneIds = new Set(TIMEZONE_OPTION_GROUPS.flatMap((group) => group.options.map((opt) => opt.id)));
  const customTimezoneOption = characterTimezone && !knownTimezoneIds.has(characterTimezone)
    ? `<option value="${escAttr(characterTimezone)}" selected>${esc(formatTimezoneDisplayName(characterTimezone))}</option>`
    : '';

  const heroAvatar = isGroup
    ? (anonShell
      ? (chat.groupSettings?.avatar
        ? `<img src="${escAttr(chat.groupSettings.avatar)}" alt="" loading="lazy" decoding="async">`
        : anonymousAvatarHtml(chat.groupSettings?.name || '匿名'))
      : (chat.groupSettings?.avatar
      ? `<img src="${escAttr(chat.groupSettings.avatar)}" alt="" loading="lazy" decoding="async">`
        : `<span>${esc(String(chat.groupSettings?.name || '群').slice(0, 1))}</span>`))
    : (anonShell
      ? anonymousAvatarHtml(anonymousPartnerProfile?.displayName || '匿名网友', anonymousPartnerProfile?.avatar)
      : strangerChat
        ? anonymousAvatarHtml(strangerPartnerProfile?.displayName || '陌生人', strangerPartnerProfile?.avatar)
        : characterAvatarHtml(partner, { className: '' }));
  const heroAvatarLabel = anonShell
    ? (isGroup ? '群头像' : '对方匿名头像')
    : (isGroup ? '更换群头像' : '更换角色头像');
  const heroAvatarPickable = (!anonShell && !strangerChat) || isGroup;

  const bubbleRange = normalizeChatBubbleRange(prefs);
  const bubbleRangeEnabled = !!resolveEnabledChatBubbleRange(prefs);
  const chatSettingsPresetKind = isGroup ? 'group' : 'private';
  const compatibleChatSettingsPresets = (!anonShell && !strangerChat)
    ? chatSettingsPresets.filter((preset) => preset.kind === chatSettingsPresetKind)
    : [];
  const rememberedChatSettingsPresetId = selectedChatSettingsPresetIds.get(chatId) || '';
  const selectedChatSettingsPreset = compatibleChatSettingsPresets.find((preset) => preset.id === rememberedChatSettingsPresetId) || null;

  function currentChatSettingsSnapshot() {
    const liveSummarySettings = resolveChatSummarySettings(chat, prefs);
    const transferableMemoryPrefs = memoryInjectionSettingsPatch(normalizeMemoryInjectionSettings(prefs));
    delete transferableMemoryPrefs.explicitSharedMemoryChatIds;
    const snapshot = {
      prefs: pickChatSettingsPresetPrefs({
        ...prefs,
        ...transferableMemoryPrefs,
        thinkingPromptMode: container.querySelector('.cd-thinking-mode')?.value ?? thinkingPrompt.mode,
        thinkingPromptCustom: container.querySelector('.cd-thinking-prompt')?.value ?? thinkingPrompt.prompt,
        callReplyDisplayMode,
        autoSummary: liveSummarySettings.autoSummary,
        autoSummaryFreq: liveSummarySettings.autoSummaryFreq,
        contextDepth: normalizeChatContextDepth(prefs.contextDepth, CHAT_CONTEXT_DEPTH_DEFAULT),
      }),
      appearance: { ...chatAppearance },
      innerVoiceCard: { ...innerVoiceCard },
    };
    if (isGroup) {
      snapshot.group = {
        autoActive: chat.autoActive === true,
        autoInterval: Math.max(60000, Number(chat.autoInterval) || 300000),
        allowSocialLinkage: chat.groupSettings?.allowSocialLinkage === true,
        allowPrivateLinkage: chat.groupSettings?.allowPrivateLinkage === true,
        linkageCadenceMode: resolveLinkageCadenceMode(chat),
        linkageMinIntervalTurns: resolveLinkageMinIntervalTurns(chat),
        linkageNudgeEvery: resolveLinkageNudgeEvery(chat),
        linkageRouteBias: resolveLinkageRouteBias(chat),
        linkageGroupPityEvery: resolveLinkageGroupPityEvery(chat),
      };
    } else {
      snapshot.private = {
        roleDefaults: {
          totalEnabled: proactiveEnabled === true,
          realPersonMode: {
            ...(autonomyPolicy?.realPersonMode || {}),
            enabled: realPersonEnabled === true,
            systemAutoReplyEnabled: systemAutoReplyEnabled === true,
            allowHardOffline: allowHardOffline === true,
            statusActivityLevel,
            idleReplyFloorEnabled: realPersonIdleFloorEnabled === true,
            idleReplyFloorSeconds: realPersonIdleFloorSeconds,
          },
        },
        idleContinue: {
          enabled: idleContinue.enabled === true,
          minutes: Math.max(1, Number(idleContinue.minutes) || 3),
        },
      };
    }
    return snapshot;
  }
  // 快速连点不同折叠组时可能有多次异步重绘并行；旧轮次不得回写覆盖新页。
  if (!isCurrentRender()) return;
  chatDetailsRenderRuntime.set(container, {
    chatId,
    getSnapshot: () => ({ user, chat, chatPrefs: prefs, partner, anonSpaceProfile }),
  });
  const nativeWebviewClass = isNativeShell() ? ' is-native-webview' : '';
  container.className = anonShell
    ? `page chat-details-page chat-details-page--anon${nativeWebviewClass}`
    : `page scrapbook-page chat-details-page${nativeWebviewClass}`;
  container.innerHTML = `
    <header class="navbar">
      <button type="button" class="navbar-btn" data-back aria-label="返回">${icon('back')}</button>
      <h1 class="navbar-title">聊天设定</h1>
      <span class="navbar-btn scrapbook-nav-spacer" aria-hidden="true"></span>
    </header>
    <main class="chat-details-scroll scrapbook-scroll" data-chat-details-id="${escAttr(chatId)}">
      <section class="chat-details-hero scrapbook-card">
        ${heroAvatarPickable ? `<button type="button" class="chat-details-avatar-btn" data-pick-avatar aria-label="${heroAvatarLabel}">
          ${heroAvatar}
          <span class="chat-details-avatar-badge">换图</span>
        </button>` : `<div class="chat-details-avatar-static" aria-hidden="false">${heroAvatar}</div>`}
        ${showChatSpark && !isGroup && !anonShell ? `<div class="chat-details-spark-stat" data-chat-spark-stat${sparkStats ? '' : ' hidden'}>${sparkStats ? `🔥 已聊 ${sparkStats.activeDays} 天${sparkStats.streak > 1 ? ` · 连续 ${sparkStats.streak} 天` : ''}` : ''}</div>` : ''}
        <input type="file" class="chat-details-avatar-input" accept="image/*" hidden />
        ${anonShell ? `
        <button type="button" class="chat-details-row chat-details-user-anon-avatar" data-pick-user-anon-avatar>
          我的匿名头像 <span>换图 ›</span>
        </button>
        <input type="file" class="chat-details-user-anon-avatar-input" accept="image/*" hidden />
        ` : ''}
        ${isGroup
    ? `<input type="text" class="form-input chat-details-name-input" data-group-name value="${esc(chat.groupSettings?.name || '')}" placeholder="群名称" maxlength="40" />`
    : anonShell
      ? `<div class="anon-detail-name">${esc(anonymousPartnerProfile?.displayName || '匿名网友')}</div>
         ${anonymousPartnerProfile?.bio ? `<div class="anon-detail-bio">${esc(anonymousPartnerProfile.bio)}</div>` : ''}
         ${!isGroup && anonymousCounterpartId ? `<button type="button" class="btn btn-outline btn-block anon-detail-space-link" data-go-anon-space>${streamerSourced ? '查看主播空间' : '查看匿名空间'}</button>` : ''}`
    : strangerChat
      ? `<div class="anon-detail-name">${esc(strangerPartnerProfile?.displayName || '陌生人')}</div>
         ${strangerPartnerProfile?.bio ? `<div class="anon-detail-bio">${esc(strangerPartnerProfile.bio)}</div>` : ''}`
      : `<input type="text" class="form-input chat-details-name-input" data-remark value="${esc(remarkName)}" placeholder="备注昵称" maxlength="40" />
           <input type="text" class="form-input chat-details-relation-input" data-relation value="${esc(relationLabel)}" placeholder="关系" maxlength="24" />`}
        ${isGroup ? `
          <div class="group-info-meta">
            <span>${Number(chat.groupSettings?.fanGroupMemberCount) || (chat.participants || []).length} 人</span>
            ${streamerSourced ? '' : `<span>${esc((allGroupMembers.find((m) => m.id === ownerId)?.name) || (ownerId === 'user' ? currentUserName : ownerId))} · 群主</span>`}
          </div>
        ` : ''}
      </section>

      ${isGroup && chat.metadata?.encounterOrigin === true ? `
      <section class="scrapbook-card chat-details-encounter-inbox">
        <label class="chat-details-row chat-details-toggle">
          <span>
            <strong>保持在 Chat</strong>
            <small>关闭后收进相遇记录</small>
          </span>
          <input type="checkbox" data-encounter-inbox-policy ${String(chat.metadata?.encounterInboxPolicy || 'auto') === 'chat' ? 'checked' : ''} />
        </label>
      </section>
      ` : ''}

      ${!isGroup && partnerId && !anonShell && !strangerChat ? `
      <section class="chat-details-shortcuts">
        <button type="button" class="chat-shortcut-btn" data-go-character-phone>TA 的手机</button>
        <button type="button" class="chat-shortcut-btn" data-go-memory>记忆馆</button>
        <button type="button" class="chat-shortcut-btn" data-go-schedule>TA 的日程</button>
        <button type="button" class="chat-shortcut-btn" data-go-interests>TA 的兴趣</button>
        <button type="button" class="chat-shortcut-btn" data-go-contact-edit>角色详情</button>
        <button type="button" class="chat-shortcut-btn" data-go-video-media>视频音频设置</button>
      </section>
      ` : ''}

      ${!isGroup && partnerId && !anonShell ? cdDetailsGroup('translation', '翻译', quickTranslationMeta(partnerTranslation), `
        <label class="api-field">
          <span class="api-field-label">翻译模式</span>
          <select class="form-input cd-partner-translation-mode">
            ${QUICK_TRANSLATION_MODES.map(([value, label]) => `<option value="${value}" ${partnerTranslation.mode === value ? 'selected' : ''}>${label}</option>`).join('')}
          </select>
        </label>
        <label class="api-field">
          <span class="api-field-label">主要外语 / 方言</span>
          <select class="form-input cd-partner-translation-language">
            ${QUICK_TRANSLATION_LANGUAGES.map(([value, label]) => `<option value="${value}" ${partnerTranslation.language === value ? 'selected' : ''}>${label}</option>`).join('')}
          </select>
        </label>
        <label class="api-field">
          <span class="api-field-label">偶尔使用的语言 / 方言</span>
          <input type="text" class="form-input cd-partner-translation-note" maxlength="120" value="${escAttr(partnerTranslation.dialectNote)}" placeholder="如：四川话、偶尔蹦英文单词" />
        </label>
      `, openCdGroups) : ''}

      ${!anonShell && !strangerChat ? `
      <section class="scrapbook-card cd-settings-preset-card">
        <div class="cd-settings-preset-head">
          <strong>设置预设</strong>
          <small>${isGroup ? '群聊' : '私聊'}</small>
        </div>
        <div class="cd-settings-preset-pick">
          <select class="form-input cd-settings-preset-select" aria-label="选择${isGroup ? '群聊' : '私聊'}设置预设">
            <option value="">选择预设</option>
            ${compatibleChatSettingsPresets.map((preset) => `<option value="${escAttr(preset.id)}" ${preset.id === selectedChatSettingsPreset?.id ? 'selected' : ''}>${esc(preset.name)}</option>`).join('')}
          </select>
          <button type="button" class="btn btn-primary btn-sm cd-settings-preset-apply" ${selectedChatSettingsPreset ? '' : 'disabled'}>应用</button>
        </div>
        <div class="cd-settings-preset-actions">
          <button type="button" class="btn btn-outline btn-sm cd-settings-preset-create">保存当前</button>
          ${selectedChatSettingsPreset ? `
            <button type="button" class="btn btn-soft btn-sm cd-settings-preset-update">更新</button>
            <button type="button" class="btn btn-soft btn-sm cd-settings-preset-rename">重命名</button>
            <button type="button" class="btn btn-soft btn-sm cd-settings-preset-delete">删除</button>
          ` : ''}
        </div>
      </section>
      ` : ''}

      ${cdDetailsGroup('platform', '聊天外观', chatPlatform === 'wechat' ? '微信 · 原生四栏与朋友圈' : chatPlatform === 'qq' ? 'QQ · 消息、联系人与空间' : '原有样式', `
        <div class="chat-platform-picker" role="radiogroup" aria-label="全局聊天外观">
          ${[
            ['current', '原有样式', ''],
            ['wechat', '微信', '原生四栏与朋友圈'],
            ['qq', 'QQ', '消息、联系人与空间'],
          ].map(([value, label, status]) => `<button type="button" class="chat-platform-option${chatPlatform === value ? ' is-active' : ''}" data-chat-platform-option="${value}" role="radio" aria-checked="${chatPlatform === value ? 'true' : 'false'}" aria-label="${label}${status ? `（${status}）` : ''}"><span>${label}</span>${status ? `<small class="chat-platform-option-status">${status}</small>` : ''}</button>`).join('')}
        </div>
      `, openCdGroups)}

      ${cdDetailsGroup('dialog', '对话相关', '模型 · 节奏 · 模式', `
        <label class="api-field">
          <span class="api-field-label">内置提示词</span>
          <select class="form-select cd-prompt-profile">
            <option value="v2" ${resolvePromptProfile(prefs) === 'v2' ? 'selected' : ''}>V2 优化版（推荐 · 测试中 · tokens 中等）</option>
            <option value="full" ${resolvePromptProfile(prefs) === 'full' ? 'selected' : ''}>全量版（原版提示词）</option>
            <option value="lightweight" ${resolvePromptProfile(prefs) === 'lightweight' ? 'selected' : ''}>轻量版（tokens 低）</option>
          </select>
        </label>
        <div class="chat-details-hint">轻量版约束更少，推荐搭配自用世界书；全量版保留原版提示词。</div>
        <label class="chat-details-row chat-details-toggle">
          <span>错落节奏</span>
          <input type="checkbox" class="cd-varied-rhythm" ${prefs.variedRhythmReply !== false ? 'checked' : ''} />
        </label>
        <div class="chat-details-hint">先按内容与表达欲说到位，再按自然气口分拆；只纠正连续模板，不按上一轮条数机械增减。</div>
        <label class="chat-details-row chat-details-toggle">
          <span>限定每轮气泡条数</span>
          <input type="checkbox" class="cd-bubble-range-enabled" ${bubbleRangeEnabled ? 'checked' : ''} />
        </label>
        <div class="cd-bubble-range-fields"${bubbleRangeEnabled ? '' : ' hidden'}>
          <label class="api-field">
            <span class="api-field-label">最少（条）</span>
            <input type="number" class="form-input cd-bubble-range-min" min="1" step="1" inputmode="numeric" value="${bubbleRange.min}" />
          </label>
          <label class="api-field">
            <span class="api-field-label">最多（条）</span>
            <input type="number" class="form-input cd-bubble-range-max" min="1" step="1" inputmode="numeric" value="${bubbleRange.max}" />
          </label>
        </div>
        <button type="button" class="chat-details-row" data-edit-description>
          会话描述 <span>${description ? '已填写' : '未填写'} ›</span>
        </button>
        <button type="button" class="chat-details-row" data-edit-plot>
          剧情提示 <span>${plot ? '已填写' : '未填写'} ›</span>
        </button>
        <details class="cd-thinking-details">
          <summary>自定义思维链</summary>
          <label class="api-field">
            <span class="api-field-label">整理规则</span>
            <select class="form-input cd-thinking-mode">
              <option value="default" ${thinkingPrompt.mode === 'default' ? 'selected' : ''}>使用内置规则</option>
              <option value="claude-light" ${thinkingPrompt.mode === 'claude-light' ? 'selected' : ''}>Claude 轻量规则</option>
              <option value="gemini-flash-deep" ${thinkingPrompt.mode === 'gemini-flash-deep' ? 'selected' : ''}>Gemini Flash 深描规则（测试）</option>
              <option value="custom" ${thinkingPrompt.mode === 'custom' ? 'selected' : ''}>使用自定义规则</option>
            </select>
          </label>
          <div class="cd-thinking-custom-fields" ${thinkingPrompt.mode === 'custom' ? '' : 'hidden'}>
            <label class="api-field">
              <span class="api-field-label">思维链步骤</span>
              <textarea class="form-input cd-thinking-prompt" rows="5" maxlength="4000" placeholder="逐行写回复前要思考的重点">${esc(thinkingPrompt.prompt)}</textarea>
            </label>
            <div class="cd-chat-css-actions">
              <button type="button" class="btn btn-primary btn-sm cd-thinking-save">保存到本会话</button>
              <button type="button" class="btn btn-outline btn-sm cd-thinking-bigedit">大窗编辑</button>
              <button type="button" class="btn btn-outline btn-sm cd-thinking-export">导出规则</button>
              <button type="button" class="btn btn-soft btn-sm cd-thinking-share" title="分享到应用商店">分享</button>
              <button type="button" class="btn btn-outline btn-sm cd-thinking-import">导入规则</button>
              <input type="file" class="cd-thinking-import-file" accept=".json,.txt,application/json,text/plain" hidden />
            </div>
            <div class="cd-chat-preset-row">
              <input type="text" class="form-input cd-thinking-preset-name" placeholder="模板名称" maxlength="40" autocomplete="off" />
              <button type="button" class="btn btn-soft btn-sm cd-thinking-preset-save">存为模板</button>
            </div>
            ${thinkingPromptPresets.length ? `
            <div class="cd-chat-preset-list">
              ${thinkingPromptPresets.map((p) => `<span class="cd-chat-preset-chip"><button type="button" class="cd-thinking-preset-apply" data-preset-id="${escAttr(p.id)}">${esc(p.name)}</button><button type="button" class="cd-thinking-preset-del" data-preset-id="${escAttr(p.id)}" aria-label="删除模板">×</button></span>`).join('')}
            </div>` : ''}
          </div>
        </details>
        <label class="api-field">
          <span class="api-field-label">对话模型</span>
          <select class="form-input cd-api-model-preset">
            <option value="">跟随全局默认</option>
            ${mainApiPresetOptions.map((p) => `<option value="${esc(p.id)}" ${p.id === mainApiPresetId ? 'selected' : ''}>${esc(p.name)}${p.model ? `（${esc(p.model)}）` : ''}</option>`).join('')}
          </select>
        </label>
        <div class="chat-details-hint">${mainApiPresetOptions.length ? '选一个「设置 · API 配置」里保存的聊天模型预设，本会话改用它的渠道和模型；不选则跟随全局默认。' : '「设置 · API 配置」里还没保存聊天模型预设，保存后可在此单独指定本会话使用的模型。'}</div>
        <label class="chat-details-row chat-details-toggle">
          <span>短气泡回复</span>
          <input type="checkbox" class="cd-short-bubble-reply" ${shortBubbleReply ? 'checked' : ''} />
        </label>
        <div class="chat-details-hint">按自然口语拍子强制分句；整轮条数由内容决定，需要限制时使用“限定每轮气泡条数”。</div>
        <label class="chat-details-row chat-details-toggle">
          <span>更爱发语音</span>
          <input type="checkbox" class="cd-voice-bubble-prefer" ${voiceBubblePreferMore ? 'checked' : ''} />
        </label>
        <div class="chat-details-hint">TA 会更常用语音条代替打字；关闭则完全跟随人设。</div>
        <label class="chat-details-row chat-details-toggle">
          <span>${isGroup ? '群聊语音演绎' : '语音演绎模式'}</span>
          <input type="checkbox" class="cd-voice-performance-mode" ${prefs.voicePerformanceMode === true ? 'checked' : ''} />
        </label>
        <div class="chat-details-hint">${isGroup
    ? '新生成的成员台词会按各自声线带上播放键；点播放时才生成音频，旁白不会朗读。'
    : '新生成的角色文字会带可播放表演轨；点播放时才生成音频，旁白不会朗读。'}</div>
        <div class="cd-voice-performance-options" ${prefs.voicePerformanceMode === true ? '' : 'hidden'}>
          <label class="chat-details-row chat-details-toggle">
            <span>本轮连续播放</span>
            <input type="checkbox" class="cd-voice-performance-continuous" ${prefs.voicePerformanceContinuous === true ? 'checked' : ''} />
          </label>
          <div class="chat-details-hint">每轮只留一个播放键；MiniMax 连贯合成，Fish 逐气泡合成并按下方间隔真实留白。</div>
          <label class="api-field cd-voice-round-gap" ${prefs.voicePerformanceContinuous === true ? '' : 'hidden'}>
            <span class="api-field-label">气泡间隔 <span class="cd-voice-round-gap-value">${(voicePerformanceBubbleGapMs / 1000).toFixed(2).replace(/0+$/, '').replace(/\.$/, '')} 秒</span></span>
            <input type="range" class="cd-voice-round-gap-input" min="200" max="5000" step="100" value="${voicePerformanceBubbleGapMs}" />
          </label>
          <label class="chat-details-row chat-details-toggle">
            <span>旁白音效</span>
            <input type="checkbox" class="cd-narration-sound-effects" ${prefs.narrationSoundEffectsEnabled === true ? 'checked' : ''} />
          </label>
          <div class="cd-narration-sound-mix" ${prefs.narrationSoundEffectsEnabled === true ? '' : 'hidden'}>
            <label class="api-field">
              <span class="api-field-label">动作音量 <span class="cd-narration-sound-volume-value">${narrationSoundEffectsVolume}%</span></span>
              <input type="range" class="cd-narration-sound-volume" min="0" max="100" step="1" value="${narrationSoundEffectsVolume}" />
            </label>
            <label class="api-field">
              <span class="api-field-label">背景音量 <span class="cd-narration-background-volume-value">${narrationBackgroundVolume}%</span></span>
              <input type="range" class="cd-narration-background-volume" min="0" max="100" step="1" value="${narrationBackgroundVolume}" />
            </label>
          </div>
          <button type="button" class="chat-details-row cd-open-sound-library">
            音频库 <span>管理素材 ›</span>
          </button>
        </div>
        ${!isGroup && partnerId ? `
        <button type="button" class="chat-details-row cd-open-radio">
          角色电台 <span>节目与往期 ›</span>
        </button>
        ` : ''}
        ${isGroup && !anonShell ? `
        <label class="chat-details-row chat-details-toggle">
          <span>旁白模式</span>
          <input type="checkbox" class="cd-narration-mode" ${prefs.narrationMode === true ? 'checked' : ''} />
        </label>
        ${noUserGroup ? '' : `<label class="api-field cd-narration-user-person-field" ${prefs.narrationMode === true ? '' : 'hidden'}>
          <span class="api-field-label">用户人称</span>
          <select class="form-input cd-narration-user-person">${narrationUserPersonOptionsHtml}</select>
        </label>`}
        <div class="chat-details-hint">在成员台词之间穿插场景、动作与群像变化。</div>
        ` : ''}
        <label class="chat-details-row chat-details-toggle">
          <span>允许 AI 生图</span>
          <input type="checkbox" class="cd-chat-image-gen" ${chatImageGenEnabled ? 'checked' : ''} />
        </label>
        <div class="chat-details-hint">开启后本会话使用真实生图；关闭时改用文字图。真实生图需先配置可用的生图 API。</div>
        <label class="chat-details-row chat-details-toggle">
          <span>表情包识图</span>
          <input type="checkbox" class="cd-sticker-vision" ${stickerVisionEnabled ? 'checked' : ''} />
        </label>
        <div class="chat-details-hint">开启后会把你最新发送的表情包图像交给当前对话模型读取；需模型支持视觉，关闭时只读取表情包名称。</div>
        <label class="chat-details-row chat-details-toggle cd-sticker-gif-first-frame${stickerVisionEnabled ? '' : ' is-disabled'}">
          <span>GIF 仅发送第一帧</span>
          <input type="checkbox" class="cd-sticker-gif-first-frame-input" ${stickerGifFirstFrameEnabled ? 'checked' : ''} ${stickerVisionEnabled ? '' : 'disabled'} />
        </label>
        <div class="chat-details-hint cd-sticker-gif-first-frame-hint">Gemini 反重力渠道目前不支持 GIF 识图；开启后只把 GIF 第一帧发给模型。</div>
        ${!isGroup && !anonShell && !strangerChat ? `
        <label class="chat-details-row chat-details-toggle">
          <span>让 TA 看到我的头像</span>
          <input type="checkbox" class="cd-see-user-avatar" ${seeUserAvatar ? 'checked' : ''} />
        </label>
        <label class="chat-details-row chat-details-toggle">
          <span>聊天火花统计</span>
          <input type="checkbox" class="cd-show-chat-spark" ${showChatSpark ? 'checked' : ''} />
        </label>
        <label class="chat-details-row chat-details-toggle">
          <span>允许 TA 主动约你线下</span>
          <input type="checkbox" class="cd-allow-offline-invite" ${chat.groupSettings?.allowAiOfflineInvite ? 'checked' : ''} />
        </label>
        <div class="chat-details-hint">开启后，聊到合适的时候 TA 会偶尔递来线下邀约卡；你也可以在聊天「更多 · 约 TA 线下」里主动发起。</div>
        <label class="chat-details-row chat-details-toggle">
          <span>允许 TA 主动打电话/视频通话</span>
          <input type="checkbox" class="cd-allow-ai-voice-call" ${chat.groupSettings?.allowAiVoiceCall ? 'checked' : ''} />
        </label>
        <div class="chat-details-hint">开启后，聊到想听你声音、太久没联系或你直接开口要求时，TA 可能会主动打来一通语音/视频电话；你可以随时接听或挂断。</div>
        <label class="chat-details-row chat-details-toggle">
          <span>通话中允许 TA 主动说话</span>
          <input type="checkbox" class="cd-call-proactive-speech" ${prefs.callProactiveSpeechEnabled === true ? 'checked' : ''} />
        </label>
        <label class="api-field cd-call-proactive-interval" ${prefs.callProactiveSpeechEnabled === true ? '' : 'hidden'}>
          <span class="api-field-label">主动说话间隔</span>
          <select class="form-input">
            <option value="30" ${callProactiveIntervalSeconds === 30 ? 'selected' : ''}>约 30 秒</option>
            <option value="60" ${callProactiveIntervalSeconds === 60 ? 'selected' : ''}>约 1 分钟</option>
            <option value="120" ${callProactiveIntervalSeconds === 120 ? 'selected' : ''}>约 2 分钟</option>
            <option value="300" ${callProactiveIntervalSeconds === 300 ? 'selected' : ''}>约 5 分钟</option>
          </select>
        </label>
        <label class="chat-details-row chat-details-toggle">
          <span>允许 TA 主动挂断</span>
          <input type="checkbox" class="cd-call-ai-hangup" ${prefs.callAiHangupEnabled === true ? 'checked' : ''} />
        </label>
        <label class="api-field">
          <span class="api-field-label">通话回复显示</span>
          <select class="form-input cd-call-reply-display-mode">
            <option value="segments" ${callReplyDisplayMode === 'segments' ? 'selected' : ''}>${partnerCallTranslation.active ? '多段显示（逐句翻译）' : '多段显示'}</option>
            <option value="single" ${callReplyDisplayMode === 'single' ? 'selected' : ''}>${partnerCallTranslation.active ? '整段显示（整段翻译）' : '整段显示'}</option>
          </select>
        </label>
        <label class="chat-details-row chat-details-toggle">
          <span>平行世界模式</span>
          <input type="checkbox" class="cd-parallel-world" ${prefs.parallelWorldMode === true ? 'checked' : ''} />
        </label>
        <div class="chat-details-hint">你们相隔于两个平行世界，网络一线牵，永远不会见面：转账、红包、线下邀约都会关闭；一起旅行等玩法变成「同一地点、各自世界」的平行共游。</div>
        <label class="chat-details-row chat-details-toggle">
          <span>异地模式</span>
          <input type="checkbox" class="cd-long-distance" ${prefs.longDistanceMode === true ? 'checked' : ''} />
        </label>
        <div class="chat-details-hint">同一个世界、分隔两地：短期内见不了面，TA 不会突然说「我在你楼下」，线下邀约会关闭；转账、红包、寄东西照常，核心是把异地恋谈下去。与平行世界模式二选一。</div>
        <label class="chat-details-row chat-details-toggle">
          <span>对话表现模式</span>
          <input type="checkbox" class="cd-dialogue-presentation" ${prefs.dialoguePresentationMode === true ? 'checked' : ''} />
        </label>
        <div class="chat-details-hint">气泡只负责承载演绎；剧情见面后，双方是在现场正常交谈，不默认拿着手机发消息。</div>
        <label class="chat-details-row chat-details-toggle">
          <span>旁白模式</span>
          <input type="checkbox" class="cd-narration-mode" ${prefs.narrationMode === true ? 'checked' : ''} />
        </label>
        <label class="api-field cd-narration-user-person-field" ${prefs.narrationMode === true ? '' : 'hidden'}>
          <span class="api-field-label">用户人称</span>
          <select class="form-input cd-narration-user-person">${narrationUserPersonOptionsHtml}</select>
        </label>
        <div class="chat-details-hint">每回合穿插简短的小剧场旁白，写场景、动作与角色状态；开启时会同时开启对话表现模式。</div>
        <label class="chat-details-row chat-details-toggle">
          <span>启用时差</span>
          <input type="checkbox" class="cd-timezone-enabled" ${timezoneEnabled ? 'checked' : ''} />
        </label>
        <div class="cd-timezone-fields"${timezoneEnabled ? '' : ' hidden'}>
          <div class="chat-details-stat">你的时区：${esc(formatTimezoneDisplayName(userTimezone))}</div>
          <label class="api-field">
            <span class="api-field-label">角色所在时区</span>
            <select class="form-input cd-character-timezone">
              <option value="" ${characterTimezone ? '' : 'selected'}>请选择</option>
              ${customTimezoneOption}
              ${TIMEZONE_OPTION_GROUPS.map((group) => `
                <optgroup label="${esc(group.label)}">
                  ${group.options.map((opt) => `<option value="${esc(opt.id)}" ${opt.id === characterTimezone ? 'selected' : ''}>${esc(opt.label)}（${esc(opt.id)}）</option>`).join('')}
                </optgroup>
              `).join('')}
            </select>
          </label>
          ${timezonePreview ? `<div class="chat-details-stat cd-timezone-preview">${esc(timezonePreview)}</div>` : ''}
        </div>
        ` : ''}
        ${activeEvent ? `
          <div class="chat-details-event">
            <strong>特殊事件进行中</strong>
            <p>${esc(activeEvent.text)}</p>
            <button type="button" class="btn btn-soft btn-sm" data-clear-event>清除事件</button>
          </div>
        ` : ''}
      `, openCdGroups)}

      ${!isGroup && !anonShell && !strangerChat && partnerId ? cdDetailsGroup(
    'real-person',
    '真人感回复',
    realPersonEnabled ? '已开启' : '推荐开启',
    `
        <label class="chat-details-row chat-details-toggle">
          <span>真人感回复</span>
          <input type="checkbox" class="cd-real-person" ${realPersonEnabled ? 'checked' : ''} />
        </label>
        <label class="chat-details-row chat-details-toggle">
          <span>允许 TA 主动来找你</span>
          <input type="checkbox" class="cd-proactive-enabled" ${proactiveEnabled ? 'checked' : ''} />
        </label>
        <div class="cd-real-person-floor" ${realPersonEnabled ? '' : 'hidden'}>
          <label class="chat-details-row chat-details-toggle">
            <span>发送已登记的系统回复</span>
            <input type="checkbox" class="cd-system-auto-reply" ${systemAutoReplyEnabled ? 'checked' : ''} />
          </label>
          <label class="chat-details-row chat-details-toggle">
            <span>允许 TA 自行完全下线</span>
            <input type="checkbox" class="cd-hard-offline" ${allowHardOffline ? 'checked' : ''} />
          </label>
          <label class="chat-details-row chat-details-toggle">
            <span>生活侧面（会调用 API）</span>
            <input type="checkbox" class="cd-life-glimpse" ${lifeGlimpseEnabled ? 'checked' : ''} />
          </label>
          <label class="chat-details-row chat-details-toggle">
            <span>自定义无输入等待</span>
            <input type="checkbox" class="cd-real-person-floor" ${realPersonIdleFloorEnabled ? 'checked' : ''} />
          </label>
          <label class="api-field">
              <span class="api-field-label">无输入后等待（秒）</span>
            <input type="number" class="form-input cd-real-person-floor-seconds" min="${idleReplyFloorMinSeconds}" max="${idleReplyFloorMaxSeconds}" step="1" value="${realPersonIdleFloorSeconds}" ${realPersonIdleFloorEnabled ? '' : 'disabled'} />
          </label>
          <label class="api-field">
            <span class="api-field-label">不回时最多追几拍（0 = 关闭）</span>
            <input type="number" class="form-input cd-chase-beat-max" min="0" max="5" step="1" value="${chaseBeatMaxRounds}" />
          </label>
          <label class="api-field">
            <span class="api-field-label">追发最短间隔（分钟）</span>
            <input type="number" class="form-input cd-chase-min-interval" min="1" max="1440" step="1" value="${chaseMinIntervalMinutes}" />
          </label>
        </div>
          <label class="api-field">
            <span class="api-field-label">主动消息统一下限（分钟，0 = 不覆盖）</span>
            <input type="number" class="form-input cd-proactive-min-gap" min="0" max="1440" step="5" value="${proactiveMinGapMinutes}" />
          </label>
        <button type="button" class="btn btn-outline btn-sm cd-open-autonomy-settings">角色手机 · 更多设置</button>
      `,
    openCdGroups,
  ) : ''}

      ${!isGroup && !anonShell && !strangerChat && partnerId ? cdDetailsGroup('status', '顶栏状态', allowAiStatusUpdates || allowAiPresenceUpdates ? 'AI 可更新' : '仅手动', `
        <label class="api-field">
          <span class="api-field-label">在线状态</span>
          <select class="form-input cd-manual-presence-state">
            <option value="online" ${manualPresenceState === 'online' ? 'selected' : ''}>在线</option>
            <option value="busy" ${manualPresenceState === 'busy' ? 'selected' : ''}>忙碌</option>
            <option value="offline" ${manualPresenceState === 'offline' ? 'selected' : ''}>离线</option>
          </select>
        </label>
        <label class="api-field">
          <span class="api-field-label">公开短句</span>
          <input type="text" class="form-input cd-manual-status-line" maxlength="40" value="${escAttr(manualStatusLine)}" placeholder="写一句角色会公开展示的话" />
        </label>
        <div class="cd-chat-css-actions">
          <button type="button" class="btn btn-primary btn-sm cd-manual-status-save">保存状态</button>
          <button type="button" class="btn btn-soft btn-sm cd-manual-status-clear">清空短句</button>
        </div>
        <label class="chat-details-row chat-details-toggle">
          <span>允许 AI 修改公开短句</span>
          <input type="checkbox" class="cd-ai-status-updates" ${allowAiStatusUpdates ? 'checked' : ''} />
        </label>
        <label class="chat-details-row chat-details-toggle">
          <span>允许 AI 修改在线状态</span>
          <input type="checkbox" class="cd-ai-presence-updates" ${allowAiPresenceUpdates ? 'checked' : ''} />
        </label>
        <div class="cd-ai-status-options" ${allowAiStatusUpdates || allowAiPresenceUpdates ? '' : 'hidden'}>
          <label class="api-field">
            <span class="api-field-label">状态活跃度</span>
            <select class="form-input cd-status-activity-level">
              <option value="quiet" ${statusActivityLevel === 'quiet' ? 'selected' : ''}>低调</option>
              <option value="natural" ${statusActivityLevel === 'natural' ? 'selected' : ''}>自然</option>
              <option value="active" ${statusActivityLevel === 'active' ? 'selected' : ''}>活跃</option>
            </select>
          </label>
        </div>
        <label class="chat-details-row chat-details-toggle">
          <span>允许当前场景临时覆盖日程</span>
          <input type="checkbox" class="cd-ai-status-schedule-override" ${allowAiStatusScheduleOverride ? 'checked' : ''} />
        </label>
      `, openCdGroups) : ''}

      ${cdDetailsGroup('emote', '表情管理', chatEmoteSettingsMeta(emoteSettings), `
        <label class="api-field">
          <span class="api-field-label">表情包发送频率</span>
          <select class="form-input cd-sticker-frequency">
            <option value="${EXPRESSION_FREQUENCY_OFF}" ${emoteSettings.stickerFrequency === EXPRESSION_FREQUENCY_OFF ? 'selected' : ''}>关闭</option>
            <option value="${EXPRESSION_FREQUENCY_LOW}" ${emoteSettings.stickerFrequency === EXPRESSION_FREQUENCY_LOW ? 'selected' : ''}>低频</option>
            <option value="${EXPRESSION_FREQUENCY_NORMAL}" ${emoteSettings.stickerFrequency === EXPRESSION_FREQUENCY_NORMAL ? 'selected' : ''}>自然</option>
            <option value="${EXPRESSION_FREQUENCY_HIGH}" ${emoteSettings.stickerFrequency === EXPRESSION_FREQUENCY_HIGH ? 'selected' : ''}>高频</option>
          </select>
        </label>
        <label class="api-field">
          <span class="api-field-label">正文 Emoji / 颜文字频率</span>
          <select class="form-input cd-inline-emote-frequency">
            <option value="${EXPRESSION_FREQUENCY_OFF}" ${emoteSettings.inlineEmoteFrequency === EXPRESSION_FREQUENCY_OFF ? 'selected' : ''}>关闭</option>
            <option value="${EXPRESSION_FREQUENCY_LOW}" ${emoteSettings.inlineEmoteFrequency === EXPRESSION_FREQUENCY_LOW ? 'selected' : ''}>低频</option>
            <option value="${EXPRESSION_FREQUENCY_NORMAL}" ${emoteSettings.inlineEmoteFrequency === EXPRESSION_FREQUENCY_NORMAL ? 'selected' : ''}>自然</option>
            <option value="${EXPRESSION_FREQUENCY_HIGH}" ${emoteSettings.inlineEmoteFrequency === EXPRESSION_FREQUENCY_HIGH ? 'selected' : ''}>高频</option>
          </select>
        </label>
        ${!isGroup && partnerId && !anonShell && !strangerChat ? `
        <label class="chat-details-row chat-details-toggle">
          <span>允许 TA 在微博发表情包</span>
          <input type="checkbox" class="cd-weibo-allow-stickers" ${weiboAllowStickers ? 'checked' : ''} />
        </label>
        ` : ''}
        <label class="chat-details-row chat-details-toggle">
          <span>允许 TA 贴表情</span>
          <input type="checkbox" class="cd-allow-ai-react" ${emoteSettings.allowAiReact ? 'checked' : ''} />
        </label>
        <div class="cd-emote-react-fields"${emoteSettings.allowAiReact ? '' : ' hidden'}>
          <label class="api-field">
            <span class="api-field-label">贴表情频率</span>
            <select class="form-input cd-ai-react-frequency">
              <option value="${EXPRESSION_FREQUENCY_LOW}" ${emoteSettings.aiReactFrequency === EXPRESSION_FREQUENCY_LOW ? 'selected' : ''}>低频</option>
              <option value="${EXPRESSION_FREQUENCY_NORMAL}" ${emoteSettings.aiReactFrequency === EXPRESSION_FREQUENCY_NORMAL ? 'selected' : ''}>自然</option>
              <option value="${EXPRESSION_FREQUENCY_HIGH}" ${emoteSettings.aiReactFrequency === EXPRESSION_FREQUENCY_HIGH ? 'selected' : ''}>高频</option>
            </select>
          </label>
          <label class="api-field">
            <span class="api-field-label">贴表情类型</span>
            <select class="form-input cd-ai-react-kind">
              <option value="${AI_REACT_KIND_EMOJI}" ${emoteSettings.aiReactKind === AI_REACT_KIND_EMOJI ? 'selected' : ''}>emoji</option>
              <option value="${AI_REACT_KIND_KAOMOJI}" ${emoteSettings.aiReactKind === AI_REACT_KIND_KAOMOJI ? 'selected' : ''}>颜文字</option>
            </select>
          </label>
          <div class="cd-emote-emoji-fields"${emoteSettings.aiReactKind === AI_REACT_KIND_EMOJI ? '' : ' hidden'}>
            <label class="chat-details-row chat-details-toggle">
              <span>安全 emoji 优先</span>
              <input type="checkbox" class="cd-prefer-safe-emoji" ${emoteSettings.preferSafeEmoji ? 'checked' : ''} />
            </label>
          </div>
          <div class="cd-emote-kaomoji-fields"${emoteSettings.aiReactKind === AI_REACT_KIND_KAOMOJI ? '' : ' hidden'}>
            <button type="button" class="chat-details-row" data-manage-kaomoji>
              管理颜文字 <span>${kaomojiLibrary.length} 个 ›</span>
            </button>
          </div>
        </div>
        ${!isGroup && partnerId && !anonShell && !strangerChat ? `
        <div class="chat-details-section-title">表情包分组</div>
        ${stickerPacks.length ? `
          <div class="cd-worldbook-picks cd-sticker-pack-picks">
            ${stickerPacks.map((pack) => `
              <label class="cd-worldbook-check">
                <input type="checkbox" class="cd-bound-sticker-pack" data-pack-id="${esc(pack.id)}" ${boundStickerPackIds.includes(pack.id) ? 'checked' : ''} />
                <span>${esc(pack.name || '分组')}（${Number(pack.count || 0)}）</span>
              </label>
            `).join('')}
          </div>
        ` : '<div class="chat-details-stat">还没有表情包分组</div>'}
        ` : ''}
        <button type="button" class="chat-details-row" data-go-stickers>表情包管理 <span>›</span></button>
      `, openCdGroups)}

      ${cdDetailsGroup('memory', '记忆', `${memoryStatsPending ? '统计中' : `${memoryCount} 条`} · 摘要 · 上下文`, `
        <div class="chat-details-stat cd-memory-stat">${memoryStatsPending ? '正在读取记忆统计…' : `本会话 ${memoryCount} 条记忆`}</div>
        <div class="cd-summary-progress" aria-live="polite">
          ${memoryStatsPending ? '正在读取摘要进度…' : `已总结 <strong>${summaryStatus.coveredCount}</strong> / ${summaryStatus.totalCount} 条消息`}
        </div>
        <label class="chat-details-row chat-details-toggle">
          <span>自动摘要（AI 回合后）</span>
          <input type="checkbox" class="cd-auto-summary" ${autoSummary ? 'checked' : ''} />
        </label>
        <details class="cd-memory-advanced">
          <summary>高级记忆设置</summary>
        <label class="api-field cd-auto-freq-field">
          <span class="api-field-label">自动摘要频率（条）</span>
          <input type="number" class="form-input cd-auto-freq" min="10" max="2000" step="10" value="${autoSummaryFreq}" />
        </label>
        <label class="api-field">
          <span class="api-field-label">上下文消息条数</span>
          <input type="number" class="form-input cd-context-depth" min="${CHAT_CONTEXT_DEPTH_MIN}" max="${CHAT_CONTEXT_DEPTH_MAX}" step="1" value="${contextDepth}" />
        </label>
        ${!anonShell && !strangerChat ? `
        <div class="chat-details-section-title">记忆注入</div>
        <label class="chat-details-row chat-details-toggle">
          <span>允许其它窗口读取本窗记忆</span>
          <input type="checkbox" class="cd-memory-source-enabled" ${memoryInjection.allowAsCrossWindowSource ? 'checked' : ''} />
        </label>
        <label class="chat-details-row chat-details-toggle">
          <span>自动读取同角色其它窗口</span>
          <input type="checkbox" class="cd-related-memory-enabled" ${memoryInjection.relatedMemoryEnabled ? 'checked' : ''} />
        </label>
        <div class="chat-details-section-title">记忆衰退</div>
        <label class="chat-details-row chat-details-toggle">
          <span>记忆逐渐退出常驻</span>
          <input type="checkbox" class="cd-memory-decay-enabled" ${memoryInjection.memoryDecayEnabled ? 'checked' : ''} />
        </label>
        <div class="chat-details-stat">退出常驻不等于删除，再次提到时仍可召回</div>
        <div class="chat-details-memory-limits cd-memory-decay-fields" ${memoryInjection.memoryDecayEnabled ? '' : 'hidden'}>
          <label class="api-field"><span class="api-field-label">与用户相关（小时）</span><input type="number" class="form-input cd-memory-decay-hours" data-memory-decay-pref="memoryDecayCoreHours" min="1" value="${memoryInjection.memoryDecayCoreHours}" /></label>
          <label class="api-field"><span class="api-field-label">群聊旁支（小时）</span><input type="number" class="form-input cd-memory-decay-hours" data-memory-decay-pref="memoryDecayGroupHours" min="1" value="${memoryInjection.memoryDecayGroupHours}" /></label>
          <label class="api-field"><span class="api-field-label">朋友圈 / 微博（小时）</span><input type="number" class="form-input cd-memory-decay-hours" data-memory-decay-pref="memoryDecaySocialHours" min="1" value="${memoryInjection.memoryDecaySocialHours}" /></label>
          <label class="api-field"><span class="api-field-label">论坛 / 拦截（小时）</span><input type="number" class="form-input cd-memory-decay-hours" data-memory-decay-pref="memoryDecayAmbientHours" min="1" value="${memoryInjection.memoryDecayAmbientHours}" /></label>
        </div>
        <div class="chat-details-memory-limits">
          <label class="api-field"><span class="api-field-label">本窗记忆</span><input type="number" class="form-input cd-memory-limit" data-memory-pref="currentWindowMemoryLimit" min="0" max="${MEMORY_INJECTION_LIMIT_MAX}" value="${memoryInjection.currentMemoryLimit}" /></label>
          <label class="api-field"><span class="api-field-label">角色本体记忆</span><input type="number" class="form-input cd-memory-limit" data-memory-pref="characterMemoryLimit" min="0" max="${MEMORY_INJECTION_LIMIT_MAX}" value="${memoryInjection.characterMemoryLimit}" /></label>
          <label class="api-field"><span class="api-field-label">相关窗口数</span><input type="number" class="form-input cd-memory-limit" data-memory-pref="relatedMemoryChatLimit" min="0" max="${RELATED_MEMORY_CHAT_MAX}" value="${memoryInjection.relatedChatLimit}" /></label>
          <label class="api-field"><span class="api-field-label">每个私聊窗记忆</span><input type="number" class="form-input cd-memory-limit" data-memory-pref="relatedPrivateMemoryLimit" min="0" max="${MEMORY_INJECTION_LIMIT_MAX}" value="${memoryInjection.relatedPrivateMemoryLimit}" /></label>
          <label class="api-field"><span class="api-field-label">每个群聊窗记忆</span><input type="number" class="form-input cd-memory-limit" data-memory-pref="relatedGroupMemoryLimit" min="0" max="${MEMORY_INJECTION_LIMIT_MAX}" value="${memoryInjection.relatedGroupMemoryLimit}" /></label>
          <label class="api-field"><span class="api-field-label">每个私聊窗近期消息</span><input type="number" class="form-input cd-memory-limit" data-memory-pref="relatedPrivateRecentMessageLimit" min="0" max="120" value="${memoryInjection.relatedPrivateRecentMessageLimit}" /></label>
          <label class="api-field"><span class="api-field-label">每个群聊窗近期消息</span><input type="number" class="form-input cd-memory-limit" data-memory-pref="relatedGroupRecentMessageLimit" min="0" max="120" value="${memoryInjection.relatedGroupRecentMessageLimit}" /></label>
          <label class="api-field"><span class="api-field-label">结构化事实</span><input type="number" class="form-input cd-memory-limit" data-memory-pref="memoryFactsLimit" min="0" max="30" value="${memoryInjection.memoryFactsLimit}" /></label>
          <label class="api-field"><span class="api-field-label">事件时间轴</span><input type="number" class="form-input cd-memory-limit" data-memory-pref="eventTimelineLimit" min="0" max="80" value="${memoryInjection.eventTimelineLimit}" /></label>
          <label class="api-field"><span class="api-field-label">线下总结记忆</span><input type="number" class="form-input cd-memory-limit" data-memory-pref="offlineMemoryLimit" min="0" max="${MEMORY_INJECTION_LIMIT_MAX}" value="${memoryInjection.offlineMemoryLimit}" /></label>
        </div>
        ${memoryShareOptions.length ? `
        <div class="api-field">
          <span class="api-field-label">与其它窗口双向互通</span>
          <div class="cd-worldbook-picks">
            ${memoryShareOptions.map((option) => `
              <label class="cd-worldbook-check">
                <input type="checkbox" class="cd-memory-share-chat" data-chat-id="${esc(option.id)}" ${memoryInjection.explicitSharedChatIds.includes(option.id) ? 'checked' : ''} />
                <span>${esc(option.label)}</span>
              </label>
            `).join('')}
          </div>
        </div>
        ` : ''}
        ` : ''}
        </details>
        <div class="cd-summary-range" ${summaryStatus.totalCount ? '' : 'hidden'}>
          <label class="api-field">
            <span class="api-field-label">从第几条</span>
            <input type="number" class="form-input cd-summary-from" min="1" max="${summaryStatus.totalCount}" step="1" value="${defaultSummaryFrom}" />
          </label>
          <span class="cd-summary-range-separator" aria-hidden="true">—</span>
          <label class="api-field">
            <span class="api-field-label">到第几条</span>
            <input type="number" class="form-input cd-summary-to" min="1" max="${summaryStatus.totalCount}" step="1" value="${summaryStatus.totalCount}" />
          </label>
        </div>
        <div class="cd-summary-selection" ${summaryStatus.totalCount ? '' : 'hidden'}>
          已选择 <span>${summaryStatus.totalCount ? summaryStatus.totalCount - defaultSummaryFrom + 1 : 0}</span> 条消息
        </div>
        <button type="button" class="chat-details-row cd-generate-summary" ${hasUncoveredSummary ? '' : 'disabled'}>${memoryStatsPending ? '统计完成后可用' : (hasUncoveredSummary ? '总结所选范围' : '暂无新增消息')}</button>
        <button type="button" class="chat-details-row cd-extract-shared-memory" ${summaryStatus.totalCount ? '' : 'disabled'}>补记共同回忆</button>
        <button type="button" class="chat-details-row" data-go-memory>查看记忆条目 <span>›</span></button>
        <button type="button" class="chat-details-row cd-token-estimate-btn" data-token-estimate aria-expanded="false">
          <span data-token-estimate-label>估算输入 tokens</span>
          <span class="cd-token-chevron" aria-hidden="true">›</span>
        </button>
        <div class="cd-token-panel" data-token-panel hidden>
          <div class="cd-token-total">本轮稳定输入约 <strong data-token-total>0</strong> tokens · 不含随机提示</div>
          <div class="cd-token-list" data-token-list></div>
        </div>
        ${anonShell ? `
        <label class="api-field">
          <span class="api-field-label">匿名记忆档位</span>
          <select class="form-input cd-anon-memory-mode">
            ${ANONYMOUS_MEMORY_MODES.map((m) => `<option value="${esc(m.id)}" ${anonMemoryMode === m.id ? 'selected' : ''}>${esc(m.label)}</option>`).join('')}
          </select>
        </label>
        ${(chat.participants || []).includes('user') ? `
        <label class="api-field">
          <span class="api-field-label">${anonMemoryMode === 'room_only' ? '带回主聊天（临时房关闭）' : '带回主聊天'}</span>
          <select class="form-input cd-anon-main-chat-inject" ${anonMemoryMode === 'room_only' ? 'disabled' : ''}>
            ${ANONYMOUS_MAIN_CHAT_INJECT_MODES.map((m) => `<option value="${esc(m.id)}" ${anonMainChatInjectMode === m.id ? 'selected' : ''}>${esc(m.label)}</option>`).join('')}
          </select>
        </label>
        ` : ''}
        ` : ''}
      `, openCdGroups)}

      ${!anonShell ? cdDetailsGroup('worldbook', '世界书与线上预设', [
    chatWorldBookIds.length ? `世界书 ${chatWorldBookIds.length}` : '',
    onlinePresetOverrideEnabled ? `预设 ${boundOnlinePresetIds.length}` : '',
  ].filter(Boolean).join(' · ') || '按默认规则', `
        <div class="api-field">
          <span class="api-field-label">本会话额外启用</span>
          ${worldBookOptions.length ? `<div class="cd-worldbook-picks">
            ${worldBookOptions.map((wb) => `
              <label class="cd-worldbook-check">
                <input type="checkbox" class="cd-worldbook-id" data-worldbook-id="${esc(wb.id)}" ${chatWorldBookIds.includes(wb.id) ? 'checked' : ''} />
                <span>${esc(wb.name)}</span>
              </label>
            `).join('')}
          </div>` : '<div class="chat-details-stat">还没有可选的世界书</div>'}
          <p class="chat-details-hint">全局开启及人物绑定的世界书照常生效；这里可为本会话额外启用其它书。</p>
        </div>
        <div class="api-field">
          <label class="chat-details-row chat-details-toggle">
            <span>单独绑定线上预设</span>
            <input type="checkbox" class="cd-online-preset-override" ${onlinePresetOverrideEnabled ? 'checked' : ''} />
          </label>
          ${onlinePresetOptions.length ? `<div class="cd-worldbook-picks">
            ${onlinePresetOptions.map((preset) => `
              <label class="cd-worldbook-check${onlinePresetOverrideEnabled ? '' : ' is-disabled'}">
                <input type="checkbox" class="cd-online-preset-id" data-preset-id="${escAttr(preset.id)}" ${effectiveOnlinePresetIds.has(preset.id) ? 'checked' : ''} ${onlinePresetOverrideEnabled ? '' : 'disabled'} />
                <span>${esc(preset.name)}</span>
              </label>
            `).join('')}
          </div>` : '<div class="chat-details-stat">还没有可绑定的线上预设</div>'}
        </div>
      `, openCdGroups) : ''}

      ${isGroup ? cdDetailsGroup('group', '群相关', '成员 · 公告 · 管理', `
        <div class="group-info-tape" aria-hidden="true"></div>
        <div class="chat-details-section-title">群成员</div>
        <div class="group-member-grid">
          ${allGroupMembers.map((m) => `
            <button type="button" class="group-member-tile" data-member-manage="${esc(m.id)}" aria-label="管理 ${esc(m.name)}">
              <div class="group-member-avatar">${m.avatarHtml}${mutedSet.has(m.id) ? buildMuteBadge() : ''}</div>
              <div class="group-member-name">${esc(m.name)}</div>
              ${m.role ? `<div class="group-member-role">${esc(m.role)}</div>` : ''}
            </button>
          `).join('')}
          ${!anonShell ? `
            <button type="button" class="group-member-tile group-member-invite" data-invite-member aria-label="邀请成员">
              <span class="group-member-plus">${icon('plus')}</span>
              <span class="group-member-name">邀请</span>
            </button>
          ` : ''}
        </div>
        <div class="chat-details-section-title">群公告</div>
        <button type="button" class="group-announcement-paper" data-edit-announcement>
          ${announcement ? esc(announcement) : '<span>未设置</span>'}
        </button>
        <div class="chat-details-section-title chat-details-subtitle">群待办</div>
        <div class="group-todo-list">${renderGroupTodoList(groupTodos)}</div>
        <button type="button" class="btn btn-soft btn-sm group-todo-add" data-add-group-todo>${icon('plus')}<span>添加待办</span></button>
        <div class="chat-details-section-title">群应用</div>
        <div class="group-app-grid">
          <button type="button" class="group-app-btn" data-chat-app="redpacket">${icon('redpacket')}<span>抢红包</span></button>
          <button type="button" class="group-app-btn" data-chat-app="offline">${icon('pin')}<span>多人线下</span></button>
          <button type="button" class="group-app-btn" data-chat-app="vote">${icon('vote')}<span>投票</span></button>
          <button type="button" class="group-app-btn" data-chat-app="files">${icon('folder')}<span>文件</span></button>
        </div>
        <div class="chat-details-section-title">群管理</div>
        <label class="chat-details-row chat-details-toggle">
          <span>旁观者模式（用户不在群）</span>
          <input type="checkbox" class="cd-observer-mode" ${chat.groupSettings?.isObserverMode ? 'checked' : ''} />
        </label>
        <label class="chat-details-row chat-details-toggle">
          <span>全员禁言</span>
          <input type="checkbox" class="cd-all-muted" ${chat.groupSettings?.allMuted ? 'checked' : ''} />
        </label>
        <label class="chat-details-row chat-details-toggle">
          <span>允许 AI 群管事件</span>
          <input type="checkbox" class="cd-ai-group-ops" ${chat.groupSettings?.allowAiGroupOps !== false ? 'checked' : ''} />
        </label>
        <label class="chat-details-row chat-details-toggle">
          <span>允许成员主动约线下</span>
          <input type="checkbox" class="cd-allow-offline-invite" ${chat.groupSettings?.allowAiOfflineInvite ? 'checked' : ''} />
        </label>
        <div class="chat-details-hint">开启后，聊到合适的时候某位成员可能发起群聚邀约；你可赴约或填写理由婉拒，其他人会去还是会生成小剧场。</div>
        <button type="button" class="chat-details-row" data-transfer-owner>
          群转让 <span>${ownerId === 'user' ? '选择成员' : esc(resolveActorDisplayLabel(allGroupMembers.find((m) => m.id === ownerId)?.name || ownerId, { user, characters: Object.fromEntries(allGroupMembers.map((m) => [m.id, m])), fallback: '成员' }))} ›</span>
        </button>
        <button type="button" class="chat-details-row" data-focus-member-grid>
          成员管理 <span>点头像设置 ›</span>
        </button>
        ${(chat.participants || []).includes('user') && !streamerSourced ? `
        <button type="button" class="chat-details-row is-danger" data-leave-group>
          退出群聊 <span>转为旁观 ›</span>
        </button>
        ` : ''}
        ${groupMembers.length && !anonShell ? `
        <div class="chat-details-section-title chat-details-subtitle">私聊联动白名单</div>
        ${groupMembers.map((m) => `
          <label class="chat-details-row chat-details-toggle">
            <span>${esc(m.name)}</span>
            <input type="checkbox" class="cd-linkage-member" data-member-id="${esc(m.id)}" ${linkagePrivateIds.includes(m.id) ? 'checked' : ''} />
          </label>
        `).join('')}
        ` : ''}
      `, openCdGroups, 'group-info-card') : ''}

      ${strangerChat ? '' : cdDetailsGroup(
    'linkage',
    '自动回复与后台联动',
    isGroup
      ? '跨窗 · 自动推进'
      : (proactiveEnabled ? '跨窗 · 闲置续聊' : '主动消息已关闭'),
    `
        ${!anonShell ? (isGroup ? `
        ${noUserGroup ? `
        <label class="api-field">
          <span class="api-field-label">聊到用户</span>
          <select class="form-input cd-user-topic-policy">
            <option value="rare" ${resolveUserTopicPolicy(chat) === 'rare' ? 'selected' : ''}>偶尔</option>
            <option value="normal" ${resolveUserTopicPolicy(chat) === 'normal' ? 'selected' : ''}>正常</option>
            <option value="off" ${resolveUserTopicPolicy(chat) === 'off' ? 'selected' : ''}>不聊</option>
          </select>
        </label>
        <label class="chat-details-row chat-details-toggle">
          <span>关联角色与用户主窗</span>
          <input type="checkbox" class="cd-user-main-chat-context" ${chat.groupSettings?.allowUserMainChatContext !== false ? 'checked' : ''} />
        </label>
        <div class="chat-details-hint">关闭后，本群不读取角色与用户主窗的近期私聊。</div>
        ` : ''}
        <label class="chat-details-row chat-details-toggle">
          <span>允许跨窗联动</span>
          <input type="checkbox" class="cd-allow-linkage" ${chat.groupSettings?.allowSocialLinkage === true ? 'checked' : ''} />
        </label>
        <div class="chat-details-hint">仅作用于当前群；开启后角色可能把话题带到其它角色窗口。</div>
        <label class="chat-details-row chat-details-toggle">
          <span>允许私聊联动</span>
          <input type="checkbox" class="cd-allow-private-linkage" ${chat.groupSettings?.allowPrivateLinkage ? 'checked' : ''} />
        </label>
        <div class="chat-details-hint">开启后，群成员可能会顺手单独给你发条私信。</div>
        ` : `
        <label class="chat-details-row chat-details-toggle">
          <span>允许跨窗联动</span>
          <input type="checkbox" class="cd-allow-linkage" ${chat.groupSettings?.allowSocialLinkage === true ? 'checked' : ''} />
        </label>
        <div class="chat-details-hint">开启后，聊到位了 TA 可能去其它窗口继续聊。</div>
        <label class="chat-details-row chat-details-toggle">
          <span>允许角色自主建群</span>
          <input type="checkbox" class="cd-allow-ai-group-creation" ${chat.groupSettings?.allowAiGroupCreation !== false ? 'checked' : ''} />
        </label>
        <label class="api-field">
          <span class="api-field-label">建群冷却（AI 回合）</span>
          <input type="number" class="form-input cd-ai-group-creation-cooldown" min="${AI_GROUP_CREATION_COOLDOWN_TURNS_MIN}" max="${AI_GROUP_CREATION_COOLDOWN_TURNS_MAX}" step="1" value="${resolveAiGroupCreationCooldownTurns(chat)}" />
        </label>
        `) : ''}
        ${!anonShell ? `
        <label class="api-field">
          <span class="api-field-label">联动节奏</span>
          <select class="form-input cd-linkage-cadence-mode">
            <option value="natural" ${resolveLinkageCadenceMode(chat) === 'natural' ? 'selected' : ''}>自然模式</option>
            <option value="custom" ${resolveLinkageCadenceMode(chat) === 'custom' ? 'selected' : ''}>自定义间隔</option>
          </select>
        </label>
        <div class="cd-linkage-interval-wrap" ${resolveLinkageCadenceMode(chat) === 'custom' ? '' : 'hidden'}>
          <label class="api-field">
            <span class="api-field-label">每几轮实际联动一次</span>
            <input type="number" class="form-input cd-linkage-interval-turns" min="${LINKAGE_MIN_INTERVAL_TURNS_MIN}" max="${LINKAGE_MIN_INTERVAL_TURNS_MAX}" step="1" value="${resolveLinkageMinIntervalTurns(chat)}" />
          </label>
          <div class="chat-details-hint">到点轮会要求真正落地一次联动；若模型没有成功执行，下一轮仍保持到点，不会提前进入冷却。</div>
        </div>
        <label class="api-field">
          <span class="api-field-label">跨窗联动保底轮数</span>
          <input type="number" class="form-input cd-linkage-nudge-turns" min="${LINKAGE_NUDGE_EVERY_MIN}" max="${LINKAGE_NUDGE_EVERY_MAX}" step="1" value="${resolveLinkageNudgeEvery(chat)}" />
        </label>
        <div class="chat-details-hint">距上次真正联动这么多轮后会优先提醒，再拖一倍会强制保底。群成员私信用户单独计数，不会被幕后群或角色间私聊顶替。</div>
        <label class="api-field">
          <span class="api-field-label">跨窗去向</span>
          <select class="form-input cd-linkage-route-bias">
            <option value="private" ${resolveLinkageRouteBias(chat) === 'private' ? 'selected' : ''}>私聊多</option>
            <option value="balanced" ${resolveLinkageRouteBias(chat) === 'balanced' ? 'selected' : ''}>均衡</option>
            <option value="group" ${resolveLinkageRouteBias(chat) === 'group' ? 'selected' : ''}>群聊多</option>
          </select>
        </label>
        <label class="api-field">
          <span class="api-field-label">群聊保底（连续未命中次数）</span>
          <input type="number" class="form-input cd-linkage-group-pity" min="${LINKAGE_GROUP_PITY_MIN}" max="${LINKAGE_GROUP_PITY_MAX}" step="1" value="${resolveLinkageGroupPityEvery(chat)}" />
        </label>
        <div class="chat-details-hint">连续这么多次跨窗只走私聊后，下一次有合适群聊路径时优先兑现群聊。</div>
        ` : ''}
        ${streamerSourced && isGroup ? '' : (isGroup ? `
        <label class="chat-details-row chat-details-toggle">
          <span>后台自动推进</span>
          <input type="checkbox" class="cd-auto-active" ${chat.autoActive ? 'checked' : ''} />
        </label>
        <div class="chat-details-hint">App 运行时按固定间隔推进；被系统挂起后会在回到前台时补跑。</div>
        <label class="api-field">
          <span class="api-field-label">自动推进间隔（分钟）</span>
          <input type="number" class="form-input cd-auto-interval" min="1" max="1440" value="${Math.max(1, Math.round((chat.autoInterval || 300000) / 60000))}" />
        </label>
        ` : `
        ${anonShell ? `
        <label class="chat-details-row chat-details-toggle">
          <span>角色主动消息总开关</span>
          <input type="checkbox" class="cd-proactive-enabled" ${proactiveEnabled ? 'checked' : ''} />
        </label>
        <div class="chat-details-hint">与角色本体共用；只控制是否允许主动开口，不会合并两个窗口的聊天记录。</div>
        ` : ''}
        ${anonShell ? '' : `
        <label class="chat-details-row chat-details-toggle">
          <span>偶尔写邮件</span>
          <input type="checkbox" class="cd-mailbox-proactive" ${mailboxProactiveEnabled ? 'checked' : ''} />
        </label>
        <label class="api-field cd-mailbox-proactive-interval" ${mailboxProactiveEnabled ? '' : 'hidden'}>
          <span class="api-field-label">邮件最短间隔（小时）</span>
          <input type="number" class="form-input" min="12" max="720" step="12" value="${mailboxProactiveIntervalHours}" />
        </label>
        `}
        <label class="chat-details-row chat-details-toggle">
          <span>闲置后自动续聊</span>
          <input type="checkbox" class="cd-idle-continue" ${idleContinue.enabled ? 'checked' : ''} />
        </label>
        <div class="chat-details-hint cd-idle-continue-hint">${!proactiveEnabled
    ? '先开启主动消息总开关；续聊设置会保留，开启后生效。'
    : (realPersonEnabled
      ? '真人感已开启：续聊频率由 TA 决定，这里保持关闭即可。'
      : '从你停止输入时开始计时；离开聊天后也照常计时。')}</div>
        <label class="api-field">
          <span class="api-field-label">停止输入后等待（分钟）</span>
          <input type="number" class="form-input cd-idle-continue-minutes" min="${IDLE_CONTINUE_MIN_MINUTES}" max="${IDLE_CONTINUE_MAX_MINUTES}" value="${idleContinue.minutes}" />
        </label>
        `)}
      `, openCdGroups)}

      ${cdDetailsGroup('wallpaper', '壁纸', chat.groupSettings?.wallpaper ? '已设置' : '未设置', `
        <label class="api-field">
          <span class="api-field-label">会话壁纸</span>
          <input type="file" class="cd-wallpaper-input" accept="image/*" hidden />
          <input type="file" class="cd-wallpaper-library-input" accept="image/*" multiple hidden />
          ${chat.groupSettings?.wallpaper ? `<div class="cd-wallpaper-preview"><img src="${esc(chat.groupSettings.wallpaper)}" alt="" loading="lazy" decoding="async"></div>` : ''}
          <div class="cd-wallpaper-actions">
            <button type="button" class="btn btn-outline btn-sm cd-wallpaper-pick">选择图片</button>
            <button type="button" class="btn btn-outline btn-sm cd-wallpaper-library-toggle">壁纸库</button>
            <button type="button" class="btn btn-soft btn-sm cd-wallpaper-library-add">批量导入</button>
            ${chat.groupSettings?.wallpaper ? '<button type="button" class="btn btn-soft btn-sm cd-wallpaper-clear">清除</button>' : ''}
          </div>
          <div class="cd-wallpaper-library" hidden>
            <div class="cd-wallpaper-library-grid"></div>
          </div>
          <div class="cd-wallpaper-url-row">
            <input type="url" class="form-input cd-wallpaper-url" placeholder="或粘贴图片链接 https://…" autocomplete="off" autocapitalize="off" spellcheck="false" />
            <button type="button" class="btn btn-outline btn-sm cd-wallpaper-url-apply">用链接</button>
          </div>
        </label>
        ${chat.groupSettings?.wallpaper ? `
        <label class="api-field">
          <span class="api-field-label">壁纸不透明度 <span class="cd-wp-opacity-val">${chatAppearance.wallpaperOpacity}%</span></span>
          <input type="range" class="cd-wp-opacity" min="10" max="100" step="5" value="${chatAppearance.wallpaperOpacity}" />
        </label>
        ` : ''}
      `, openCdGroups)}

      ${cdDetailsGroup('beautify', '消息界面美化', '本会话气泡 · 提示字色 · CSS', `
        <div class="chat-details-section-title chat-details-subtitle">本会话气泡</div>
        <label class="api-field">
          <span class="api-field-label">我的气泡色</span>
          <div class="user-space-color-row">
            <input type="color" class="cd-chat-bubble-self" value="${esc(chatAppearance.bubbleSelf || '#f3e6d4')}" />
            <input type="text" class="form-input cd-chat-bubble-self-text" placeholder="留空跟随主题" value="${esc(chatAppearance.bubbleSelf)}" />
            <button type="button" class="btn btn-soft btn-sm cd-chat-bubble-self-clear">恢复主题</button>
          </div>
        </label>
        <label class="api-field">
          <span class="api-field-label">我的字色</span>
          <div class="user-space-color-row">
            <input type="color" class="cd-chat-bubble-text-self" value="${esc(chatAppearance.bubbleTextSelf || '#8c7362')}" />
            <input type="text" class="form-input cd-chat-bubble-text-self-text" placeholder="留空跟随主题" value="${esc(chatAppearance.bubbleTextSelf)}" />
            <button type="button" class="btn btn-soft btn-sm cd-chat-bubble-text-self-clear">恢复主题</button>
          </div>
        </label>
        ${showOtherBubbleAppearance ? `
        <label class="api-field">
          <span class="api-field-label">对方气泡色</span>
          <div class="user-space-color-row">
            <input type="color" class="cd-chat-bubble-other" value="${esc(chatAppearance.bubbleOther || '#fffdf8')}" />
            <input type="text" class="form-input cd-chat-bubble-other-text" placeholder="留空跟随主题" value="${esc(chatAppearance.bubbleOther)}" />
            <button type="button" class="btn btn-soft btn-sm cd-chat-bubble-other-clear">恢复主题</button>
          </div>
        </label>
        <label class="api-field">
          <span class="api-field-label">对方字色</span>
          <div class="user-space-color-row">
            <input type="color" class="cd-chat-bubble-text-other" value="${esc(chatAppearance.bubbleTextOther || '#8c7362')}" />
            <input type="text" class="form-input cd-chat-bubble-text-other-text" placeholder="留空跟随主题" value="${esc(chatAppearance.bubbleTextOther)}" />
            <button type="button" class="btn btn-soft btn-sm cd-chat-bubble-text-other-clear">恢复主题</button>
          </div>
        </label>
        ` : ''}
        <div class="chat-details-section-title chat-details-subtitle">提示与排版</div>
        <label class="api-field">
          <span class="api-field-label">头像尺寸 <span class="cd-avatar-size-val">${avatarSizeValue}px</span>${avatarSizeOverride <= 0 ? ' <span class="cd-bubble-fs-scope">· 默认</span>' : ''}</span>
          <input type="range" class="cd-avatar-size" min="${MIN_CHAT_AVATAR_SIZE}" max="${MAX_CHAT_AVATAR_SIZE}" step="1" value="${avatarSizeValue}" />
        </label>
        <label class="api-field">
          <span class="api-field-label">气泡字号 <span class="cd-bubble-fs-val">${bubbleFontValue}px</span> <span class="cd-bubble-fs-scope">${bubbleFontFollowGlobal ? '· 跟随全局' : '· 仅本会话'}</span></span>
          <input type="range" class="cd-bubble-fs" min="${MIN_CHAT_BUBBLE_FONT_SIZE}" max="${MAX_CHAT_BUBBLE_FONT_SIZE}" step="1" value="${bubbleFontValue}" />
        </label>
        <label class="api-field">
          <span class="api-field-label">旁白字号 <span class="cd-narration-fs-val">${narrationFontValue}px</span>${narrationFontOverride <= 0 ? ' <span class="cd-bubble-fs-scope">· 默认</span>' : ''}</span>
          <input type="range" class="cd-narration-fs" min="11" max="18" step="1" value="${narrationFontValue}" />
        </label>
        <label class="api-field">
          <span class="api-field-label">提示字色（旁白 / 系统 / 时间）</span>
          <div class="user-space-color-row">
            <input type="color" class="cd-narration-text-color" value="${esc(chatAppearance.narrationTextColor || '#80838a')}" />
            <input type="text" class="form-input cd-narration-text-color-text" placeholder="留空跟随主题" value="${esc(chatAppearance.narrationTextColor)}" />
            <button type="button" class="btn btn-soft btn-sm cd-narration-text-color-clear">恢复主题</button>
          </div>
        </label>
        <label class="api-field cd-bubble-fs-global-field">
          <span class="cd-bubble-fs-global-line">
            <input type="checkbox" class="cd-bubble-fs-global" ${bubbleFontFollowGlobal ? 'checked' : ''} />
            <span>应用到全部聊天（全局字号）</span>
          </span>
        </label>
        <label class="api-field cd-bubble-fs-global-field">
          <span class="cd-bubble-fs-global-line">
            <input type="checkbox" class="cd-bubble-group" ${chatAppearance.bubbleGrouping ? 'checked' : ''} />
            <span>连续气泡（同一个人连发的消息合并显示，头像只露一次）</span>
          </span>
        </label>
        <label class="api-field">
          <span class="api-field-label">时间戳</span>
          <select class="form-input cd-message-timestamp-mode">
            <option value="last" ${messageTimestampMode === 'last' ? 'selected' : ''}>连续消息末尾一条</option>
            <option value="each" ${messageTimestampMode === 'each' ? 'selected' : ''}>每条消息</option>
          </select>
        </label>
        <div class="chat-details-css-block">
          <label class="api-field">
            <span class="api-field-label">整页 CSS（顶栏 / 输入区等）</span>
            <textarea class="form-input cd-chat-css" rows="4" placeholder=".chat-thread-page .chat-thread-composer{ background:#fffaf6; }" autocomplete="off" autocapitalize="off" spellcheck="false">${esc(chatAppearance.customCss)}</textarea>
          </label>
          <div class="cd-chat-css-actions">
            <button type="button" class="btn btn-outline btn-sm cd-chat-css-bigedit">大窗编辑</button>
            <button type="button" class="btn btn-outline btn-sm cd-chat-css-export">导出</button>
            <button type="button" class="btn btn-soft btn-sm cd-chat-css-share" title="分享到应用商店">分享</button>
            <button type="button" class="btn btn-outline btn-sm cd-chat-css-import">导入</button>
            <button type="button" class="btn btn-soft btn-sm cd-chat-css-reset">清空</button>
            <input type="file" class="cd-chat-css-import-file" accept=".css,.txt,text/css,text/plain" hidden />
          </div>
        </div>
        <div class="chat-details-css-block">
          <label class="api-field">
            <span class="api-field-label">我方气泡 CSS</span>
            <textarea class="form-input cd-user-bubble-css" rows="4" placeholder=".chat-thread-page .chat-bubble-row.is-user .scrapbook-bubble{ background:rgba(142,197,232,.72) !important; }" autocomplete="off" autocapitalize="off" spellcheck="false">${esc(chatAppearance.userBubbleCss)}</textarea>
          </label>
          <div class="cd-chat-css-actions">
            <button type="button" class="btn btn-outline btn-sm cd-user-bubble-css-bigedit">大窗编辑</button>
            <button type="button" class="btn btn-outline btn-sm cd-user-bubble-css-export">导出</button>
            <button type="button" class="btn btn-soft btn-sm cd-user-bubble-css-share" title="分享到应用商店">分享</button>
            <button type="button" class="btn btn-outline btn-sm cd-user-bubble-css-import">导入</button>
            <button type="button" class="btn btn-soft btn-sm cd-user-bubble-css-reset">清空</button>
            <input type="file" class="cd-user-bubble-css-import-file" accept=".css,.txt,text/css,text/plain" hidden />
          </div>
        </div>
        <div class="chat-details-css-block">
          <label class="api-field">
            <span class="api-field-label">对方气泡 CSS</span>
            <textarea class="form-input cd-char-bubble-css" rows="4" placeholder=".chat-thread-page .chat-bubble-row.is-them .scrapbook-bubble{ background:rgba(255,255,255,.88) !important; }" autocomplete="off" autocapitalize="off" spellcheck="false">${esc(chatAppearance.charBubbleCss)}</textarea>
          </label>
          <div class="cd-chat-css-actions">
            <button type="button" class="btn btn-outline btn-sm cd-char-bubble-css-bigedit">大窗编辑</button>
            <button type="button" class="btn btn-outline btn-sm cd-char-bubble-css-export">导出</button>
            <button type="button" class="btn btn-soft btn-sm cd-char-bubble-css-share" title="分享到应用商店">分享</button>
            <button type="button" class="btn btn-outline btn-sm cd-char-bubble-css-import">导入</button>
            <button type="button" class="btn btn-soft btn-sm cd-char-bubble-css-reset">清空</button>
            <input type="file" class="cd-char-bubble-css-import-file" accept=".css,.txt,text/css,text/plain" hidden />
          </div>
        </div>
        <div class="cd-chat-css-actions">
          <button type="button" class="btn btn-primary btn-sm cd-chat-css-save">保存美化</button>
          <button type="button" class="btn btn-outline btn-sm cd-chat-css-doc">CSS 参考文档</button>
          ${strangerChat && partnerId ? '<button type="button" class="btn btn-soft btn-sm cd-chat-css-sync-main">从主会话同步</button>' : ''}
        </div>
        <div class="cd-chat-preset-row">
          <input type="text" class="form-input cd-chat-preset-name" placeholder="预设名称" maxlength="40" autocomplete="off" />
          <button type="button" class="btn btn-soft btn-sm cd-chat-preset-save">存为预设</button>
        </div>
        ${chatAppearancePresets.length ? `
        <div class="cd-chat-preset-list">
          ${chatAppearancePresets.map((p) => `<span class="cd-chat-preset-chip${p.builtin ? ' is-builtin' : ''}"><button type="button" class="cd-chat-preset-apply" data-preset-id="${escAttr(p.id)}">${esc(p.name)}</button>${p.builtin ? '' : `<button type="button" class="cd-chat-preset-del" data-preset-id="${escAttr(p.id)}" aria-label="删除预设">×</button>`}</span>`).join('')}
        </div>
        <div class="cd-chat-preset-hint">点预设名应用到本会话；身份默认可在 Chat 侧栏管理。</div>
        ` : '<div class="cd-chat-preset-hint">还没有美化预设，保存后可一键套用到其它会话。</div>'}
      `, openCdGroups)}

      ${cdDetailsGroup('innervoice', '心声设定与美化', '开关 · 注入 · 卡片样式', `
        <label class="chat-details-row chat-details-toggle">
          <span>关闭心声</span>
          <input type="checkbox" class="cd-inner-voice-disabled" ${innerVoiceDisabled ? 'checked' : ''} />
        </label>
        <label class="chat-details-row chat-details-toggle">
          <span>隐藏心声</span>
          <input type="checkbox" class="cd-inner-voice-hidden" ${innerVoiceHidden ? 'checked' : ''} ${innerVoiceDisabled ? 'disabled' : ''} />
        </label>
        <label class="chat-details-row chat-details-toggle">
          <span>读取最近原心声</span>
          <input type="checkbox" class="cd-inner-voice-inject-enabled" ${innerVoiceInjectEnabled ? 'checked' : ''} ${innerVoiceDisabled ? 'disabled' : ''} />
        </label>
        <label class="chat-details-row chat-details-toggle">
          <span>消息内显示心声</span>
          <input type="checkbox" class="cd-ivc-inline-enabled" ${innerVoiceCard.inlineEnabled ? 'checked' : ''} ${innerVoiceDisabled ? 'disabled' : ''} />
        </label>
        <label class="api-field">
          <span class="api-field-label">原心声参考条数</span>
          <input type="number" class="form-input cd-inner-voice-inject-count" min="0" max="8" step="1" value="${innerVoiceInjectCount}" ${innerVoiceDisabled || !innerVoiceInjectEnabled ? 'disabled' : ''} />
        </label>
        <div class="chat-details-section-title">心声生成</div>
        <label class="api-field">
          <span class="api-field-label">内容来源</span>
          <select class="form-input cd-ivc-generation-mode">
            <option value="default" ${innerVoiceCard.generationMode === 'default' ? 'selected' : ''}>沿用原心声（只改外观）</option>
            <option value="custom" ${innerVoiceCard.generationMode === 'custom' ? 'selected' : ''}>按自定义规则生成</option>
          </select>
        </label>
        <label class="api-field cd-ivc-generation-fields" ${innerVoiceCard.generationMode === 'custom' ? '' : 'hidden'}>
          <span class="api-field-label">生成要求</span>
          <textarea class="form-input cd-ivc-generation-prompt" rows="5" maxlength="4000" placeholder="例如：额外生成「戒备」「没说出口的话」两个字段；语气克制，不使用数值">${esc(innerVoiceCard.generationPrompt)}</textarea>
        </label>
        <div class="chat-details-section-title">心声样式</div>
        <label class="api-field">
          <span class="api-field-label">卡片骨架</span>
          <div class="cd-chat-preset-row cd-ivc-choice-row">
            <button type="button" class="btn btn-sm cd-ivc-template ${innerVoiceCard.template === 'diary' ? 'btn-primary' : 'btn-outline'}" data-template="diary">奶油手账</button>
            <button type="button" class="btn btn-sm cd-ivc-template ${innerVoiceCard.template === 'ins' ? 'btn-primary' : 'btn-outline'}" data-template="ins">ins 小白卡</button>
          </div>
        </label>
        <label class="api-field">
          <span class="api-field-label">弹出位置</span>
          <div class="cd-chat-preset-row cd-ivc-choice-row">
            <button type="button" class="btn btn-sm cd-ivc-position ${innerVoiceCard.position === 'center' ? 'btn-primary' : 'btn-outline'}" data-position="center">居中</button>
            <button type="button" class="btn btn-sm cd-ivc-position ${innerVoiceCard.position === 'top' ? 'btn-primary' : 'btn-outline'}" data-position="top">顶部</button>
            <button type="button" class="btn btn-sm cd-ivc-position ${innerVoiceCard.position === 'bottom' ? 'btn-primary' : 'btn-outline'}" data-position="bottom">底部</button>
          </div>
        </label>
        <details class="cd-ivc-labels-details">
          <summary>自定义文案</summary>
          <div class="cd-ivc-labels-grid">
            ${INNER_VOICE_LABEL_FIELDS.map(([key, label]) => `
            <label class="api-field">
              <span class="api-field-label">${esc(label)}</span>
              <input type="text" class="form-input cd-ivc-label" data-label-key="${key}" maxlength="10" placeholder="${esc(INNER_VOICE_LABEL_DEFAULTS[key])}" value="${esc(innerVoiceCard.labels[key] || '')}" />
            </label>`).join('')}
          </div>
        </details>
        <label class="api-field">
          <span class="api-field-label">自定义内容 HTML</span>
          <textarea class="form-input cd-ivc-html" rows="5" maxlength="12000" placeholder="<section class=&quot;my-state&quot;>{{customRows}}</section>" autocomplete="off" autocapitalize="off" spellcheck="false">${esc(innerVoiceCard.templateHtml)}</textarea>
        </label>
        <div class="chat-details-hint">可用 {{name}}、{{inner}}、{{intent}}、{{status}}、{{moodValue}}、{{customRows}}；留空使用当前内置骨架。</div>
        <label class="api-field">
          <span class="api-field-label">自定义 CSS（仅作用于本会话心声弹层）</span>
          <textarea class="form-input cd-ivc-css" rows="4" placeholder="#char-state-popover .char-state-card{ background:#fff; }" autocomplete="off" autocapitalize="off" spellcheck="false">${esc(innerVoiceCard.css)}</textarea>
        </label>
        <label class="api-field">
          <span class="api-field-label">消息内心声 CSS</span>
          <textarea class="form-input cd-ivc-inline-css" rows="4" placeholder=".chat-inline-inner-voice-host .chat-inline-inner-voice{ ... }" autocomplete="off" autocapitalize="off" spellcheck="false">${esc(innerVoiceCard.inlineCss)}</textarea>
        </label>
        <div class="cd-chat-css-actions">
          <button type="button" class="btn btn-primary btn-sm cd-ivc-css-save">保存心声方案</button>
          <button type="button" class="btn btn-outline btn-sm cd-ivc-html-bigedit">编辑 HTML</button>
          <button type="button" class="btn btn-outline btn-sm cd-ivc-css-bigedit">大窗编辑</button>
          <button type="button" class="btn btn-outline btn-sm cd-ivc-inline-css-bigedit">编辑行内 CSS</button>
          <button type="button" class="btn btn-outline btn-sm cd-ivc-css-doc">CSS 参考文档</button>
          <button type="button" class="btn btn-outline btn-sm cd-ivc-css-export">导出方案</button>
          <button type="button" class="btn btn-soft btn-sm cd-ivc-css-share" title="分享到应用商店">分享</button>
          <button type="button" class="btn btn-outline btn-sm cd-ivc-css-import">导入方案</button>
          <button type="button" class="btn btn-soft btn-sm cd-ivc-css-reset">恢复默认</button>
          <input type="file" class="cd-ivc-css-import-file" accept=".json,.txt,.css,application/json,text/plain,text/css" hidden />
        </div>
        <div class="cd-chat-preset-row">
          <input type="text" class="form-input cd-ivc-preset-name" placeholder="预设名称" maxlength="40" autocomplete="off" />
          <button type="button" class="btn btn-soft btn-sm cd-ivc-preset-save">存为预设</button>
        </div>
        ${innerVoiceCardPresets.length ? `
        <div class="cd-chat-preset-list">
          ${innerVoiceCardPresets.map((p) => `<span class="cd-chat-preset-chip${p.builtin ? ' is-builtin' : ''}${p.id === innerVoiceCardActivePresetId ? ' is-active' : ''}"><button type="button" class="cd-ivc-preset-apply" data-preset-id="${escAttr(p.id)}">${esc(p.name)}</button>${p.builtin ? '' : `<button type="button" class="cd-ivc-preset-del" data-preset-id="${escAttr(p.id)}" aria-label="删除预设">×</button>`}</span>`).join('')}
        </div>
        <div class="cd-chat-preset-hint">点预设名应用到本会话；预设全局共享，不随用户档位切换。</div>
        ` : ''}
      `, openCdGroups)}

      ${!isGroup && !anonShell && !strangerChat ? cdDetailsGroup('block', '拉黑', '失联后尝试联系', `
        <label class="chat-details-row chat-details-toggle is-danger">
          <span>是否拉黑 ${esc(remarkName || partner?.name || partner?.customNickname || 'TA')}</span>
          <input type="checkbox" class="cd-blocked-by-user" ${blockedState.blocked ? 'checked' : ''} />
        </label>
        <label class="api-field">
          <span class="api-field-label">再次尝试间隔（分钟）</span>
          <input type="number" class="form-input cd-drift-bottle-interval" min="5" max="1440" step="5" value="${Math.max(5, Math.min(1440, Number(prefs.driftBottleIntervalMinutes || 30) || 30))}" />
        </label>
        <label class="api-field">
          <span class="api-field-label">后台检查间隔（分钟）</span>
          <input type="number" class="form-input cd-drift-bottle-scan-interval" min="${DRIFT_BOTTLE_SCAN_INTERVAL_MIN}" max="${DRIFT_BOTTLE_SCAN_INTERVAL_MAX}" step="1" value="${clampDriftBottleScanIntervalMinutes(driftBottleScan.scanIntervalMinutes)}" />
        </label>
      `, openCdGroups) : ''}

      ${!isGroup && partnerId && !anonShell && !strangerChat ? cdDetailsGroup('archive', '保存与空间', '角色时光档案', `
        <div class="chat-details-stat cd-archive-stat">尚未统计本角色相关记录</div>
        <div class="cd-storage-breakdown" data-character-storage-breakdown hidden></div>
        <button type="button" class="chat-details-row" data-inspect-character-storage>查看占用 <span>›</span></button>
        <button type="button" class="chat-details-row" data-export-character-archive="light">导出轻量档案 <span>ZIP</span></button>
        <button type="button" class="chat-details-row" data-export-character-archive="complete">导出完整档案 <span>ZIP</span></button>
        <button type="button" class="chat-details-row" data-import-character-archive>导入角色档案 <span>›</span></button>
        <input type="file" class="cd-character-archive-file" accept=".zip,application/zip" hidden />
        <button type="button" class="chat-details-row" data-clear-character-voice-cache>清理本角色语音缓存</button>
      `, openCdGroups) : ''}

      ${cdDetailsGroup('danger', '情况记录', '清除记录 · 记忆', `
        <button type="button" class="chat-details-row" data-export-chat-records>导出聊天记录 <span>JSON</span></button>
        <button type="button" class="chat-details-row" data-import-chat-records>导入聊天记录 <span>›</span></button>
        <input type="file" class="cd-chat-records-file mm-file-input" accept=".json,application/json" hidden />
        <button type="button" class="chat-details-row" data-prune-history>清理较早记录（保留最近 500 条）</button>
        <button type="button" class="chat-details-row is-danger" data-clear-history>清除聊天记录</button>
        <button type="button" class="chat-details-row is-danger" data-clear-memory>清除记忆</button>
        ${!isGroup && partnerId && !anonShell && !strangerChat
    ? '<button type="button" class="chat-details-row is-danger" data-reset-character-progress>一键清除角色相关内容</button>'
    : ''}
      `, openCdGroups)}
    </main>
  `;
  markPerfPhase('dom');
  const perfTotalMs = Math.max(0, Math.round(perfLastAt - perfStartedAt));
  if (perfTotalMs >= 180) {
    console.debug('[route-perf] chat/details', { totalMs: perfTotalMs, phases: perfPhases });
    import('../core/debug-log.js').then(({ appendDebugEvent }) => appendDebugEvent({
      type: 'route_phase_timing',
      level: 'info',
      message: `Route phases: chat/details (${perfTotalMs}ms)`,
      context: { path: 'chat/details', totalMs: perfTotalMs, phases: perfPhases },
    })).catch(() => {});
  }

  container.querySelector('[data-back]')?.addEventListener('click', () => {
    back();
  });

  container.querySelector('.cd-settings-preset-select')?.addEventListener('change', async (event) => {
    const presetId = String(event.currentTarget?.value || '').trim();
    if (presetId) selectedChatSettingsPresetIds.set(chatId, presetId);
    else selectedChatSettingsPresetIds.delete(chatId);
    await rerenderKeepScroll(container, params);
  });

  container.querySelector('.cd-settings-preset-create')?.addEventListener('click', () => {
    openTextEditorModal({
      title: `保存${isGroup ? '群聊' : '私聊'}设置预设`,
      value: '',
      placeholder: '预设名称',
      multiline: false,
      confirmLabel: '保存',
      onSave: async (name) => {
        const label = String(name || '').trim();
        if (!label) { showToast('请输入预设名称'); return; }
        const saved = await saveChatSettingsPreset({
          name: label,
          kind: chatSettingsPresetKind,
          snapshot: currentChatSettingsSnapshot(),
        });
        selectedChatSettingsPresetIds.set(chatId, saved.id);
        showToast(`已保存预设「${saved.name}」`);
        await rerenderKeepScroll(container, params);
      },
    });
  });

  container.querySelector('.cd-settings-preset-update')?.addEventListener('click', async () => {
    if (!selectedChatSettingsPreset) return;
    const saved = await saveChatSettingsPreset({
      id: selectedChatSettingsPreset.id,
      name: selectedChatSettingsPreset.name,
      kind: selectedChatSettingsPreset.kind,
      snapshot: currentChatSettingsSnapshot(),
    });
    showToast(`已更新预设「${saved.name}」`);
    await rerenderKeepScroll(container, params);
  });

  container.querySelector('.cd-settings-preset-rename')?.addEventListener('click', () => {
    if (!selectedChatSettingsPreset) return;
    openTextEditorModal({
      title: '重命名设置预设',
      value: selectedChatSettingsPreset.name,
      placeholder: '预设名称',
      multiline: false,
      confirmLabel: '保存',
      onSave: async (name) => {
        const renamed = await renameChatSettingsPreset(selectedChatSettingsPreset.id, name);
        selectedChatSettingsPresetIds.set(chatId, renamed.id);
        showToast(`已重命名为「${renamed.name}」`);
        await rerenderKeepScroll(container, params);
      },
    });
  });

  container.querySelector('.cd-settings-preset-delete')?.addEventListener('click', async () => {
    if (!selectedChatSettingsPreset) return;
    if (!window.confirm(`删除设置预设「${selectedChatSettingsPreset.name}」？`)) return;
    await deleteChatSettingsPreset(selectedChatSettingsPreset.id);
    selectedChatSettingsPresetIds.delete(chatId);
    showToast('设置预设已删除');
    await rerenderKeepScroll(container, params);
  });

  container.querySelector('.cd-settings-preset-apply')?.addEventListener('click', async () => {
    if (!selectedChatSettingsPreset) return;
    const button = container.querySelector('.cd-settings-preset-apply');
    if (button) { button.disabled = true; button.textContent = '应用中…'; }
    try {
      const snapshot = selectedChatSettingsPreset.snapshot || {};
      prefs = await patchChatPrefs(chatId, snapshot.prefs || {});
      let chatSettingsChanged = false;
      if (snapshot.appearance && typeof snapshot.appearance === 'object') {
        chat = {
          ...chat,
          groupSettings: {
            ...(chat.groupSettings || {}),
            ...snapshot.appearance,
          },
        };
        chatSettingsChanged = true;
      }
      if (snapshot.innerVoiceCard && typeof snapshot.innerVoiceCard === 'object') {
        chat = {
          ...chat,
          groupSettings: {
            ...(chat.groupSettings || {}),
            innerVoiceCard: normalizeInnerVoiceCard(snapshot.innerVoiceCard, insHomeTheme ? 'ins' : 'diary'),
          },
        };
        chatSettingsChanged = true;
      }
      if (isGroup && snapshot.group) {
        const groupPreset = snapshot.group;
        chat = {
          ...chat,
          autoActive: groupPreset.autoActive === true,
          autoInterval: Math.max(60000, Number(groupPreset.autoInterval) || 300000),
          groupSettings: {
            ...(chat.groupSettings || {}),
            allowSocialLinkage: groupPreset.allowSocialLinkage === true,
            allowPrivateLinkage: groupPreset.allowPrivateLinkage === true,
            linkageCadenceMode: groupPreset.linkageCadenceMode,
            linkageMinIntervalTurns: groupPreset.linkageMinIntervalTurns,
            linkageNudgeEvery: groupPreset.linkageNudgeEvery,
            linkageRouteBias: groupPreset.linkageRouteBias,
            linkageGroupPityEvery: groupPreset.linkageGroupPityEvery,
          },
        };
        chatSettingsChanged = true;
      }
      if (chatSettingsChanged) {
        await saveChat(chat);
        notifyChatAppearanceChanged();
        if (snapshot.innerVoiceCard && typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent(INNER_VOICE_CARD_CHANGED_EVENT, {
            detail: { chatId: chat.id, card: chat.groupSettings?.innerVoiceCard || null },
          }));
        }
      }
      if (isGroup && snapshot.group) {
        if (chat.autoActive) await scheduleChatLazy(chat);
        else await unscheduleChatLazy(chat.id);
      }
      if (!isGroup && snapshot.private) {
        const privatePreset = snapshot.private;
        if (partnerId && privatePreset.roleDefaults) {
          const { saveCharacterAutonomySettings } = await import('../core/character-autonomy-settings.js');
          await saveCharacterAutonomySettings(user.id, partnerId, {
            roleDefaults: privatePreset.roleDefaults,
            chatOverrides: {
              [chatId]: { totalEnabled: privatePreset.roleDefaults.totalEnabled === true },
            },
          });
        }
        if (privatePreset.idleContinue) {
          idleContinue = await saveIdleContinueSettings(chatId, privatePreset.idleContinue);
        }
      }
      const { resyncAllChatSchedules } = await import('../core/background-scheduler.js');
      await resyncAllChatSchedules(user.id).catch(() => {});
      showToast(`已应用预设「${selectedChatSettingsPreset.name}」`);
      await rerenderKeepScroll(container, params);
    } catch (error) {
      showToast(`应用失败：${error?.message || error}`);
      if (button?.isConnected) { button.disabled = false; button.textContent = '应用'; }
    }
  });

  container.querySelectorAll('[data-chat-platform-option]').forEach((button) => {
    button.addEventListener('click', async () => {
      const next = normalizeChatPlatform(button.getAttribute('data-chat-platform-option'));
      const restoringCurrentPlatform = next === chatPlatform;
      button.disabled = true;
      try {
        await setChatPlatform(next);
        invalidateKeepAlive('chat');
        showToast(`${restoringCurrentPlatform ? '已恢复' : '已切换为'}${next === 'wechat' ? '微信' : next === 'qq' ? 'QQ' : '原有'}聊天外观`);
        await rerenderKeepScroll(container, params);
      } catch (error) {
        showToast(error?.message || '聊天外观切换失败');
        if (button.isConnected) button.disabled = false;
      }
    });
  });

  container.querySelectorAll('details[data-cd-group]').forEach((el) => {
    const summary = el.querySelector('summary.chat-details-group-summary');
    summary?.addEventListener('click', (event) => {
      if (el.open || el.dataset.cdHydrated === '1' || el.dataset.cdHydrating === '1') return;
      const id = String(el.getAttribute('data-cd-group') || '').trim();
      if (!id) return;
      // 未挂载的分组不先展开空壳：iOS 会先画一次空 details，下一帧整页重绘后
      // 又改高度，视觉上就是“卡一下、弹一下”。保持摘要原位，数据与控件就绪后
      // 由新 DOM 一次性进入 open 状态。
      event.preventDefault();
      const next = readOpenCdGroups();
      next.add(id);
      writeOpenCdGroups(next);
      el.dataset.cdHydrating = '1';
      el.classList.add('is-opening');
      summary.setAttribute('aria-busy', 'true');
      void rerenderKeepScroll(container, params, { anchorGroupId: id }).catch((error) => {
        if (!el.isConnected) return;
        const rollback = readOpenCdGroups();
        rollback.delete(id);
        writeOpenCdGroups(rollback);
        delete el.dataset.cdHydrating;
        el.classList.remove('is-opening');
        summary.removeAttribute('aria-busy');
        console.warn('[chat-details] lazy group failed', id, error);
      });
    });
    el.addEventListener('toggle', () => {
      const id = String(el.getAttribute('data-cd-group') || '').trim();
      if (!id) return;
      const next = readOpenCdGroups();
      if (el.open) next.add(id);
      else next.delete(id);
      writeOpenCdGroups(next);
      // 未挂载分组的打开动作已在 summary click 中接管；这里仅记录已挂载分组
      // 的正常收起/展开，避免同一次操作再触发第二轮异步重绘。
    });
  });

  if (focusedDetailsGroup === 'translation') {
    requestAnimationFrame(() => {
      const group = container.querySelector('details[data-cd-group="translation"]');
      if (!group) return;
      group.open = true;
      group.scrollIntoView({ block: 'start', behavior: 'smooth' });
      group.querySelector('.cd-partner-translation-mode')?.focus({ preventScroll: true });
    });
  }

  const fileInput = container.querySelector('.chat-details-avatar-input');
  const userAnonFileInput = container.querySelector('.chat-details-user-anon-avatar-input');
  container.querySelector('[data-pick-avatar]')?.addEventListener('click', () => {
    if (fileInput) fileInput.value = '';
    fileInput?.click();
  });
  container.querySelector('[data-pick-user-anon-avatar]')?.addEventListener('click', () => userAnonFileInput?.click());

  async function saveAnonUserAvatar(dataUrl) {
    await saveUserSpaceProfile(user.id, { avatar: dataUrl });
    applyAnonymousIdentityPatch(chat, 'user', { avatar: dataUrl });
    await saveChat(chat);
    await syncAnonymousSpaceAvatarToChats(user.id, 'user', dataUrl);
    showToast('匿名头像已更新');
    await rerenderKeepScroll(container, params);
  }

  fileInput?.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    try {
      const { fileToCroppedOptimizedAvatarDataUrl } = await loadImageCropModule();
      const result = await fileToCroppedOptimizedAvatarDataUrl(file);
      if (!result) return;
      const dataUrl = result.dataUrl;
      if (!String(dataUrl).startsWith('data:')) throw new Error('图片处理失败');
      if (isGroup) {
        chat.groupSettings = { ...(chat.groupSettings || {}), avatar: dataUrl };
        await saveChat(chat);
      } else if (partner) {
        partner = await saveCharacterForUser(
          user.id,
          { ...partner, avatar: dataUrl },
          { forceOverride: true },
        );
      }
      showToast('头像已更新');
      await rerenderKeepScroll(container, params);
    } catch (err) {
      showToast(err?.message || '图片处理失败');
    } finally {
      // 取消或失败后也允许 Safari 重选同一文件。
      fileInput.value = '';
    }
  });

  userAnonFileInput?.addEventListener('change', async () => {
    const file = userAnonFileInput.files && userAnonFileInput.files[0];
    if (!file) return;
    let dataUrl = '';
    try {
      const { fileToCroppedOptimizedAvatarDataUrl } = await loadImageCropModule();
      const result = await fileToCroppedOptimizedAvatarDataUrl(file);
      if (!result) return;
      dataUrl = result.dataUrl;
    } catch (err) {
      showToast(err?.message || '图片处理失败');
      return;
    }
    if (!String(dataUrl).startsWith('data:')) return;
    await saveAnonUserAvatar(dataUrl);
  });

  container.querySelector('[data-edit-description]')?.addEventListener('click', () => {
    openTextEditorModal({
      title: '会话描述',
      value: description,
      multiline: true,
      variant: anonEditorVariant(),
      onSave: async (text) => {
        chat = await updateChatDirectives(chat.id, { description: text });
        showToast('已保存');
        await rerenderKeepScroll(container, params);
      },
    });
  });

  container.querySelector('[data-edit-plot]')?.addEventListener('click', () => {
    openTextEditorModal({
      title: '剧情提示',
      value: plot,
      multiline: true,
      variant: anonEditorVariant(),
      onSave: async (text) => {
        chat = await updateChatDirectives(chat.id, { plotDirective: text });
        showToast('已保存');
        await rerenderKeepScroll(container, params);
      },
    });
  });

  const thinkingModeInput = container.querySelector('.cd-thinking-mode');
  const thinkingPromptArea = container.querySelector('.cd-thinking-prompt');
  const thinkingFields = container.querySelector('.cd-thinking-custom-fields');
  thinkingModeInput?.addEventListener('change', async () => {
    const mode = ['default', 'claude-light', 'gemini-flash-deep', 'custom'].includes(thinkingModeInput.value)
      ? thinkingModeInput.value
      : 'default';
    if (thinkingFields) thinkingFields.hidden = mode !== 'custom';
    prefs = await patchChatPrefs(chatId, { thinkingPromptMode: mode });
    showToast(mode === 'custom'
      ? '已使用自定义思维链'
      : (mode === 'claude-light'
        ? '已使用 Claude 轻量思维链'
        : (mode === 'gemini-flash-deep' ? '已使用 Gemini Flash 深描思维链' : '已恢复内置思维链')));
  });
  async function saveThinkingPrompt(text) {
    const config = normalizeThinkingPromptConfig({ mode: 'custom', prompt: text });
    if (thinkingPromptArea) thinkingPromptArea.value = config.prompt;
    if (thinkingModeInput) thinkingModeInput.value = 'custom';
    if (thinkingFields) thinkingFields.hidden = false;
    prefs = await patchChatPrefs(chatId, {
      thinkingPromptMode: 'custom',
      thinkingPromptCustom: config.prompt,
    });
    return config;
  }
  container.querySelector('.cd-thinking-save')?.addEventListener('click', async () => {
    await saveThinkingPrompt(thinkingPromptArea?.value || '');
    showToast('自定义思维链已保存');
  });
  container.querySelector('.cd-thinking-bigedit')?.addEventListener('click', () => {
    openTextEditorModal({
      title: '编辑自定义思维链',
      value: thinkingPromptArea?.value || '',
      placeholder: '逐行写回复前要思考的重点',
      multiline: true,
      confirmLabel: '保存',
      variant: anonEditorVariant(),
      onSave: async (text) => {
        await saveThinkingPrompt(text);
        showToast('自定义思维链已保存');
      },
    });
  });
  container.querySelector('.cd-thinking-export')?.addEventListener('click', async () => {
    const payload = buildThinkingPromptExportPayload({
      mode: 'custom',
      prompt: thinkingPromptArea?.value || '',
    });
    try {
      await downloadTextFile(JSON.stringify(payload, null, 2), `marshmallow-thinking-prompt-${Date.now()}.json`);
      showToast('思维链规则已导出');
    } catch (err) {
      showToast(`导出失败：${err?.message || err}`);
    }
  });
  container.querySelector('.cd-thinking-share')?.addEventListener('click', () => {
    const payload = buildThinkingPromptExportPayload({
      mode: 'custom',
      prompt: thinkingPromptArea?.value || '',
    });
    if (!String(payload?.config?.prompt || payload?.prompt || '').trim()) {
      showToast('当前没有可分享的思维链规则');
      return;
    }
    shareToCommunityStore({
      source: payload,
      fileName: 'marshmallow-thinking-prompt.json',
      resourceType: 'thinking-prompt',
      title: '思维链规则',
      originLabel: '会话思维链',
    });
  });
  const thinkingImportFile = container.querySelector('.cd-thinking-import-file');
  container.querySelector('.cd-thinking-import')?.addEventListener('click', () => {
    thinkingImportFile?.click();
  });
  thinkingImportFile?.addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const config = parseThinkingPromptImportText(await file.text());
      await saveThinkingPrompt(config.prompt);
      showToast('思维链规则已导入');
    } catch (err) {
      showToast(String(err?.message || '导入失败'));
    }
  });
  container.querySelector('.cd-thinking-preset-save')?.addEventListener('click', async () => {
    const name = container.querySelector('.cd-thinking-preset-name')?.value.trim() || '';
    try {
      const config = await saveThinkingPrompt(thinkingPromptArea?.value || '');
      await saveThinkingPromptPreset(name, config);
      showToast(`已存为模板「${name}」`);
      await rerenderKeepScroll(container, params);
    } catch (err) {
      showToast(String(err?.message || '保存失败'));
    }
  });
  container.querySelectorAll('.cd-thinking-preset-apply').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const list = await loadThinkingPromptPresets();
      const preset = list.find((item) => item.id === btn.dataset.presetId);
      if (!preset) { showToast('模板不存在'); return; }
      await saveThinkingPrompt(preset.prompt);
      showToast(`已应用模板「${preset.name}」`);
      await rerenderKeepScroll(container, params);
    });
  });
  container.querySelectorAll('.cd-thinking-preset-del').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await deleteThinkingPromptPreset(btn.dataset.presetId);
      showToast('模板已删除');
      await rerenderKeepScroll(container, params);
    });
  });

  container.querySelector('[data-clear-event]')?.addEventListener('click', async () => {
    await clearActiveEvent(chatId);
    showToast('特殊事件已清除');
    await rerenderKeepScroll(container, params);
  });

  if (isGroup) {
    container.querySelector('[data-group-name]')?.addEventListener('change', async (e) => {
      chat.groupSettings = { ...(chat.groupSettings || {}), name: String(e.target.value || '').trim() };
      await saveChat(chat);
      showToast('群名称已保存');
    });
    container.querySelector('[data-encounter-inbox-policy]')?.addEventListener('change', async (e) => {
      chat.metadata = {
        ...(chat.metadata || {}),
        encounterInboxPolicy: e.target.checked ? 'chat' : 'archive',
      };
      await saveChat(chat);
      showToast(e.target.checked ? '已保持在 Chat' : '已收进相遇记录');
    });
  } else {
    const savePrefs = async ({ syncRemark = false } = {}) => {
      const remarkName = String(container.querySelector('[data-remark]')?.value || '').trim();
      if (syncRemark && partner && remarkName && remarkName !== String(partner.name || '').trim()) {
        partner = await saveCharacterForUser(
          user.id,
          { ...partner, name: remarkName },
          { forceOverride: true },
        );
      }
      prefs = await patchChatPrefs(chatId, {
        remarkName,
        relationLabel: String(container.querySelector('[data-relation]')?.value || '').trim(),
      });
    };
    container.querySelector('[data-remark]')?.addEventListener('change', async () => {
      try {
        await savePrefs({ syncRemark: true });
        showToast('备注已保存到当前身份');
      } catch (error) {
        showToast(`备注保存失败：${error?.message || error}`);
      }
    });
    container.querySelector('[data-relation]')?.addEventListener('change', async () => {
      try {
        await savePrefs();
        showToast('关系已保存');
      } catch (error) {
        showToast(`关系保存失败：${error?.message || error}`);
      }
    });
    container.querySelector('[data-go-character-phone]')?.addEventListener('click', () => {
      navigate('character-phone', { character: partnerId, from: 'chat', chatId });
    });
    container.querySelector('[data-go-schedule]')?.addEventListener('click', () => {
      navigate('character-phone', { character: partnerId, app: 'schedule', from: 'chat', chatId });
    });
    container.querySelector('[data-go-interests]')?.addEventListener('click', () => {
      navigate('character-phone', { character: partnerId, app: 'interests', from: 'chat', chatId });
    });
    container.querySelector('[data-go-contact-edit]')?.addEventListener('click', () => {
      navigate('contacts/edit', { id: partnerId, scope: 'identity', identityUserId: user.id });
    });
    container.querySelector('[data-go-video-media]')?.addEventListener('click', () => {
      navigate('contacts/edit', {
        id: partnerId,
        sheet: 'voice',
        scope: 'identity',
        identityUserId: user.id,
      });
    });
  }

  const savePartnerTranslation = async () => {
    if (!partner?.id) return;
    const profile = normalizeTranslationProfile({
      ...partner.translationProfile,
      mode: container.querySelector('.cd-partner-translation-mode')?.value,
      language: container.querySelector('.cd-partner-translation-language')?.value,
      dialectNote: container.querySelector('.cd-partner-translation-note')?.value,
    });
    try {
      partner = partner._lightweightNpc === true
        ? await updateLightweightNpcTranslationProfile(partner.id, profile, { userId: user.id })
        : await saveCharacterForUser(
          user.id,
          { ...partner, translationProfile: profile },
          { forceOverride: true },
        );
      showToast(profile.mode === 'off' ? '翻译已关闭' : '翻译设置已保存');
    } catch (error) {
      showToast(`翻译设置保存失败：${error?.message || error}`);
    }
  };
  container.querySelector('.cd-partner-translation-mode')?.addEventListener('change', savePartnerTranslation);
  container.querySelector('.cd-partner-translation-language')?.addEventListener('change', savePartnerTranslation);
  container.querySelector('.cd-partner-translation-note')?.addEventListener('change', savePartnerTranslation);

  container.querySelectorAll('[data-go-memory]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (partnerId && !anonShell) {
        navigate('memory/hall', { character: partnerId });
        return;
      }
      navigate('memory');
    });
  });
  container.querySelector('[data-go-anon-space]')?.addEventListener('click', () => {
    if (streamerSourced) {
      navigate('anon/streamer/space', chat.metadata?.streamerChannelId ? { channelId: chat.metadata.streamerChannelId } : {});
      return;
    }
    if (anonymousCounterpartId) navigate('anon/space', { actorId: anonymousCounterpartId });
  });
  container.querySelector('.cd-allow-offline-invite')?.addEventListener('change', async (e) => {
    chat.groupSettings = { ...(chat.groupSettings || {}), allowAiOfflineInvite: !!e.target.checked };
    await saveChat(chat);
    showToast(e.target.checked ? '已允许 TA 主动发起线下邀约' : '已关闭');
  });
  container.querySelector('.cd-allow-ai-voice-call')?.addEventListener('change', async (e) => {
    chat.groupSettings = { ...(chat.groupSettings || {}), allowAiVoiceCall: !!e.target.checked };
    await saveChat(chat);
    showToast(e.target.checked ? '已允许 TA 主动打电话/视频通话' : '已关闭');
  });
  container.querySelector('.cd-call-proactive-speech')?.addEventListener('change', async (e) => {
    const enabled = !!e.target.checked;
    prefs = await patchChatPrefs(chatId, { callProactiveSpeechEnabled: enabled });
    const interval = container.querySelector('.cd-call-proactive-interval');
    if (interval) interval.hidden = !enabled;
    showToast(enabled ? '通话中 TA 可以主动说话了' : '已恢复一问一答');
  });
  container.querySelector('.cd-call-proactive-interval select')?.addEventListener('change', async (e) => {
    const seconds = Math.max(30, Math.min(300, Number(e.target.value) || 60));
    prefs = await patchChatPrefs(chatId, { callProactiveIntervalSeconds: seconds });
  });
  container.querySelector('.cd-call-ai-hangup')?.addEventListener('change', async (e) => {
    const enabled = !!e.target.checked;
    prefs = await patchChatPrefs(chatId, { callAiHangupEnabled: enabled });
    showToast(enabled ? 'TA 可以在合适的时候结束通话' : 'TA 不会主动挂断');
  });
  container.querySelector('.cd-call-reply-display-mode')?.addEventListener('change', async (e) => {
    const mode = e.target.value === 'single' ? 'single' : 'segments';
    e.target.value = mode;
    prefs = await patchChatPrefs(chatId, { callReplyDisplayMode: mode });
  });
  container.querySelector('.cd-show-chat-spark')?.addEventListener('change', async (e) => {
    const enabled = !!e.target.checked;
    prefs = await patchChatPrefs(chatId, { showChatSpark: enabled });
    showToast(enabled ? '聊天火花已开启' : '聊天火花已关闭');
    await rerenderKeepScroll(container, params);
  });
  container.querySelector('.cd-blocked-by-user')?.addEventListener('change', async (e) => {
    const blocked = !!e.target.checked;
    const interval = Math.max(5, Math.min(1440, Number(container.querySelector('.cd-drift-bottle-interval')?.value || prefs.driftBottleIntervalMinutes || 30) || 30));
    await setChatBlockedByUser(chatId, blocked, {
      userId: user.id,
      characterIds: partnerId ? [partnerId] : [],
      driftBottleIntervalMinutes: interval,
    });
    showToast(blocked ? `已拉黑；TA 可约每 ${interval} 分钟再次尝试联系` : '已解除拉黑');
    await rerenderKeepScroll(container, params);
  });
  container.querySelector('.cd-drift-bottle-interval')?.addEventListener('change', async (e) => {
    const interval = Math.max(5, Math.min(1440, Number(e.target.value) || 30));
    e.target.value = String(interval);
    await setChatBlockedByUser(chatId, blockedState.blocked, {
      userId: user.id,
      characterIds: partnerId ? [partnerId] : [],
      driftBottleIntervalMinutes: interval,
    });
    prefs.driftBottleIntervalMinutes = interval;
    showToast('再次尝试间隔已保存');
  });
  container.querySelector('.cd-drift-bottle-scan-interval')?.addEventListener('change', async (e) => {
    const interval = clampDriftBottleScanIntervalMinutes(e.target.value);
    e.target.value = String(interval);
    driftBottleScan = await saveDriftBottleScanSettings(user.id, { scanIntervalMinutes: interval });
    await refreshDriftBottleScanTimerLazy().catch(() => {});
    showToast(`后台检查间隔已保存：每 ${interval} 分钟`);
  });

  const resolveName = async (id) => {
    if (!id || id === 'user') return currentUserName;
    const c = await getRecord('characters', id);
    return getCharacterAiContextName(c, id);
  };

  const summaryFromInput = container.querySelector('.cd-summary-from');
  const summaryToInput = container.querySelector('.cd-summary-to');
  const summarySelectionCount = container.querySelector('.cd-summary-selection span');
  const refreshSummarySelection = () => {
    if (!summaryFromInput || !summaryToInput || !summarySelectionCount) return;
    const max = Math.max(1, summaryStatus.totalCount);
    const from = Math.max(1, Math.min(max, Math.trunc(Number(summaryFromInput.value) || 1)));
    const to = Math.max(1, Math.min(max, Math.trunc(Number(summaryToInput.value) || max)));
    summarySelectionCount.textContent = String(Math.max(0, to - from + 1));
  };
  summaryFromInput?.addEventListener('input', refreshSummarySelection);
  summaryToInput?.addEventListener('input', refreshSummarySelection);

  container.querySelector('.cd-generate-summary')?.addEventListener('click', async () => {
    if (!hasUncoveredSummary) {
      showToast('没有尚未总结的新消息');
      return;
    }
    const btn = container.querySelector('.cd-generate-summary');
    const prev = btn?.textContent || '';
    const waitingForActiveSummary = isChatSummaryInFlight({ chatId, userId: user.id });
    if (btn) {
      btn.textContent = waitingForActiveSummary ? '等待当前摘要…' : '正在总结…';
      btn.disabled = true;
      btn.style.opacity = '0.5';
    }
    try {
      const max = summaryStatus.totalCount;
      const from = Math.max(1, Math.min(max, Math.trunc(Number(summaryFromInput?.value) || 1)));
      const to = Math.max(1, Math.min(max, Math.trunc(Number(summaryToInput?.value) || max)));
      if (from > to) {
        showToast('起始条数不能大于结束条数');
        return;
      }
      if (summaryFromInput) summaryFromInput.value = String(from);
      if (summaryToInput) summaryToInput.value = String(to);
      const result = await maybeSummarizeChatMemory({
        chat,
        userId: user.id,
        currentUserName,
        resolveName,
        force: true,
        messageRange: { from, to },
      });
      if (!result.ok) {
        showToast(describeChatSummaryFailure(result));
        return;
      }
      showToast(`总结完成（第 ${from}–${to} 条，共 ${result.deltaCount} 条）`);
      await rerenderKeepScroll(container, params);
    } catch (e) {
      showToast(`总结失败：${e?.message || e}`);
    } finally {
      if (btn) {
        btn.textContent = prev || '总结所选范围';
        btn.disabled = false;
        btn.style.opacity = '1';
      }
    }
  });

  container.querySelector('.cd-extract-shared-memory')?.addEventListener('click', async () => {
    const btn = container.querySelector('.cd-extract-shared-memory');
    const prev = btn?.textContent || '';
    const focusInput = window.prompt('这段里最希望角色记住什么？（可留空）', '');
    if (focusInput === null) return;
    const focusHint = String(focusInput || '').replace(/\s+/g, ' ').trim().slice(0, 240);
    if (btn) {
      btn.textContent = '正在补记…';
      btn.disabled = true;
    }
    try {
      const max = summaryStatus.totalCount;
      const from = Math.max(1, Math.min(max, Math.trunc(Number(summaryFromInput?.value) || 1)));
      const to = Math.max(1, Math.min(max, Math.trunc(Number(summaryToInput?.value) || max)));
      if (from > to) {
        showToast('起始条数不能大于结束条数');
        return;
      }
      if (summaryFromInput) summaryFromInput.value = String(from);
      if (summaryToInput) summaryToInput.value = String(to);
      const result = await extractChatSharedMemory({
        chat,
        userId: user.id,
        currentUserName,
        resolveName,
        messageRange: { from, to },
        focusHint,
      });
      if (!result.ok) {
        const reasonMsgMap = {
          'invalid-range': '请选择正确的消息范围',
          'no-messages': '暂无可提取消息',
          'in-flight': '这段聊天已有总结任务正在进行',
          'empty-api': '提取失败：模型未返回内容，请检查总结所用的 API/模型',
          'invalid-output': '提取失败：模型返回格式异常，请重试',
        };
        showToast(reasonMsgMap[result.reason] || '暂时无法提取共同回忆');
        return;
      }
      showToast(result.updated ? '共同回忆已刷新' : '已补记共同回忆');
      await rerenderKeepScroll(container, params);
    } catch (e) {
      showToast(`提取失败：${e?.message || e}`);
    } finally {
      if (btn) {
        btn.textContent = prev || '补记共同回忆';
        btn.disabled = false;
      }
    }
  });

  container.querySelector('[data-token-estimate]')?.addEventListener('click', async (event) => {
    const btn = event.currentTarget;
    const labelEl = btn.querySelector('[data-token-estimate-label]');
    const panel = container.querySelector('[data-token-panel]');
    const listEl = panel?.querySelector('[data-token-list]');
    const totalEl = panel?.querySelector('[data-token-total]');
    if (!panel || !listEl || !totalEl) return;

    if (panel.hidden === false && btn.getAttribute('aria-expanded') === 'true' && !btn.dataset.tokenLoading) {
      panel.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
      return;
    }

    const prevLabel = labelEl?.textContent?.trim() || '估算输入 tokens';
    btn.dataset.tokenLoading = '1';
    btn.disabled = true;
    if (labelEl) labelEl.textContent = '估算中…';
    try {
      const messages = await listMessagesForChat(chatId);
      const characters = {};
      if (isGroup) {
        const rows = await listCharacters({ includeInternal: true }).catch(() => []);
        const wanted = new Set((chat.participants || []).filter((id) => id && id !== 'user'));
        for (const row of rows) {
          if (row?.id && wanted.has(row.id)) characters[row.id] = row;
        }
      } else if (partnerId) {
        characters[partnerId] = partner;
      }
      const estimate = await estimateChatInputTokens({ chat, user, userId: user.id, messages, characters });
      totalEl.textContent = formatTokenCount(estimate.promptTokens);
      listEl.innerHTML = renderTokenBreakdownRows(estimate.breakdown || []);
      panel.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
      const statEl = container.querySelector('.cd-memory-stat');
      if (statEl) statEl.textContent = `本会话 ${memoryCount} 条 · 估算约 ${formatTokenCount(estimate.promptTokens)} tokens`;
      listEl.querySelectorAll('[data-token-toggle]').forEach((toggleBtn) => {
        toggleBtn.addEventListener('click', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          const row = toggleBtn.closest('.cd-token-row');
          const children = row?.querySelector(':scope > .cd-token-children');
          if (!children) return;
          const open = children.hidden;
          children.hidden = !open;
          toggleBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
          row.classList.toggle('is-open', open);
        });
      });
    } catch (err) {
      showToast(err?.message || '估算失败', 3500);
      panel.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
    } finally {
      delete btn.dataset.tokenLoading;
      btn.disabled = false;
      if (labelEl) labelEl.textContent = prevLabel;
    }
  });

  container.querySelector('[data-clear-history]')?.addEventListener('click', async () => {
    if (!window.confirm('清除全部聊天记录？此操作不可恢复。')) return;
    await clearChatHistory(chatId);
    showToast('聊天记录已清除');
  });

  let characterArchiveInspection = null;
  let characterArchiveInspectionPromise = null;
  const renderCharacterStorage = (inspection) => {
    const stat = container.querySelector('.cd-archive-stat');
    const panel = container.querySelector('[data-character-storage-breakdown]');
    const usage = inspection?.usage;
    const counts = inspection?.counts;
    if (!stat || !panel || !usage || !counts) return;
    stat.textContent = `${counts.chats} 个窗口 · ${counts.messages} 条消息 · 约 ${formatStorageSize(usage.totalBytes)}`;
    const audioBytes = Number(usage.audioBytes || 0) + Number(usage.cachedAudioBytes || 0);
    const otherBytes = Number(usage.videoBytes || 0) + Number(usage.otherBytes || 0);
    panel.innerHTML = `
      <div><span>文字与结构</span><strong>${formatStorageSize(usage.textBytes)}</strong></div>
      <div><span>图片</span><strong>${formatStorageSize(usage.imageBytes)}</strong></div>
      <div><span>语音与音频</span><strong>${formatStorageSize(audioBytes)}</strong></div>
      <div><span>视频与其他</span><strong>${formatStorageSize(otherBytes)}</strong></div>
    `;
    panel.hidden = false;
    const meta = container.querySelector('[data-cd-group="archive"] .chat-details-group-meta');
    if (meta) meta.textContent = formatStorageSize(usage.totalBytes);
    const clearVoice = container.querySelector('[data-clear-character-voice-cache]');
    if (clearVoice) clearVoice.disabled = counts.voiceCaches <= 0;
  };
  const ensureCharacterArchiveInspection = async () => {
    if (characterArchiveInspection) return characterArchiveInspection;
    if (!characterArchiveInspectionPromise) {
      characterArchiveInspectionPromise = characterTimeCapsuleModule.inspectCharacterTimeCapsule({
        userId: user.id,
        characterId: partnerId,
      }).then((inspection) => {
        characterArchiveInspection = inspection;
        renderCharacterStorage(inspection);
        return inspection;
      }).finally(() => {
        characterArchiveInspectionPromise = null;
      });
    }
    return characterArchiveInspectionPromise;
  };

  container.querySelector('[data-inspect-character-storage]')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const previous = button.innerHTML;
    button.disabled = true;
    button.textContent = '统计中…';
    try {
      await ensureCharacterArchiveInspection();
    } catch (error) {
      showToast(error?.message || '空间统计失败', 3500);
    } finally {
      button.disabled = false;
      button.innerHTML = previous;
    }
  });

  container.querySelectorAll('[data-export-character-archive]').forEach((button) => {
    button.addEventListener('click', async () => {
      const mode = button.getAttribute('data-export-character-archive') === 'complete' ? 'complete' : 'light';
      if (mode === 'complete' && !window.confirm('完整档案会包含 TA 参与的聊天窗口、相关群聊全文及其中已有的图片和语音缓存。继续导出？')) return;
      const characterName = String(partner?.name || partner?.customNickname || '角色').trim();
      const filename = characterTimeCapsuleModule.characterTimeCapsuleFilename(characterName, mode);
      let saveTarget = null;
      try {
        // 桌面浏览器的大文件保存器必须在这次点击手势内先打开。
        saveTarget = await pickWebSaveWritable(filename, { mimeType: 'application/zip' });
      } catch (error) {
        if (error?.message !== '已取消保存') showToast(error?.message || '无法选择保存位置');
        return;
      }
      const previous = button.innerHTML;
      button.disabled = true;
      button.textContent = mode === 'complete' ? '整理完整档案中…' : '整理轻量档案中…';
      try {
        const inspection = await ensureCharacterArchiveInspection();
        const result = await characterTimeCapsuleModule.exportCharacterTimeCapsule({
          userId: user.id,
          characterId: partnerId,
          mode,
          inspected: inspection,
          filename,
          webSaveTarget: saveTarget,
        });
        showToast(result.message || '角色时光档案已保存', 4200);
      } catch (error) {
        showToast(error?.message || '角色档案导出失败', 4200);
      } finally {
        button.disabled = false;
        button.innerHTML = previous;
      }
    });
  });

  const archiveFileInput = container.querySelector('.cd-character-archive-file');
  const openArchiveImportPreview = (parsed, file) => {
    const host = document.getElementById('modal-container');
    if (!host) return;
    const archiveName = String(parsed.manifest.characterName || parsed.data.character?.name || '未命名角色').trim();
    const exportedAt = parsed.manifest.exportedAt
      ? new Date(parsed.manifest.exportedAt).toLocaleString('zh-CN')
      : '未记录';
    const archiveMode = parsed.manifest.mode === 'complete' ? '完整档案' : '轻量档案';
    const offlineCount = Number(parsed.counts.offlineArchives || 0);
    const offlineScopeMatched = !!String(parsed.manifest.userId || '').trim()
      && String(parsed.manifest.userId) === String(user.id || '');
    host.classList.add('active');
    host.innerHTML = `
      <div class="modal-overlay cd-capsule-import-overlay" data-capsule-import-overlay>
        <div class="modal-sheet scrapbook-card cd-capsule-import-sheet" role="dialog" aria-modal="true" aria-labelledby="capsule-import-title">
          <header class="modal-header">
            <h3 id="capsule-import-title">导入角色档案</h3>
            <button type="button" class="navbar-btn modal-close-btn" data-capsule-import-close aria-label="关闭">${icon('back')}</button>
          </header>
          <div class="modal-body cd-capsule-import-body">
            <div class="cd-capsule-preview">
              <strong>${esc(archiveName)}</strong>
              <span>${esc(archiveMode)} · ${esc(exportedAt)}</span>
              <span>${parsed.counts.chats} 个窗口 · ${parsed.counts.messages} 条消息 · ${parsed.counts.memories} 条记忆</span>
              ${offlineCount ? `<span>${offlineScopeMatched
                ? `${offlineCount} 条线下记录`
                : `${offlineCount} 条线下记录来自其他档位，本次不导入`}</span>` : ''}
              <span class="cd-capsule-verified">✓ 格式与数量校验通过</span>
            </div>
            ${parsed.manifest.mode === 'light' ? '<div class="chat-details-stat">轻量档案会保留媒体占位，不含原图与已省略的音频文件。</div>' : ''}
            <div class="cd-capsule-import-options" role="radiogroup" aria-label="恢复方式">
              <label class="cd-capsule-import-option">
                <input type="radio" name="capsule-restore-mode" value="merge" checked />
                <span><strong>合并到当前角色</strong><small>保留当前角色卡，冲突记录双方都保留</small></span>
              </label>
              <label class="cd-capsule-import-option">
                <input type="radio" name="capsule-restore-mode" value="copy" />
                <span><strong>恢复为角色副本</strong><small>新建角色与聊天窗口，不改当前角色</small></span>
              </label>
            </div>
            <div class="modal-actions">
              <button type="button" class="btn btn-outline" data-capsule-import-close>取消</button>
              <button type="button" class="btn btn-primary" data-capsule-import-confirm>开始恢复</button>
            </div>
          </div>
        </div>
      </div>
    `;
    const close = () => {
      host.classList.remove('active');
      host.innerHTML = '';
      if (archiveFileInput) archiveFileInput.value = '';
    };
    host.querySelector('[data-capsule-import-overlay]')?.addEventListener('click', close);
    host.querySelector('.cd-capsule-import-sheet')?.addEventListener('click', (event) => event.stopPropagation());
    host.querySelectorAll('[data-capsule-import-close]').forEach((button) => button.addEventListener('click', close));
    host.querySelector('[data-capsule-import-confirm]')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      const restoreMode = host.querySelector('input[name="capsule-restore-mode"]:checked')?.value === 'copy'
        ? 'copy'
        : 'merge';
      button.disabled = true;
      button.textContent = '恢复中…';
      try {
        const result = await characterTimeCapsuleModule.restoreCharacterTimeCapsule({
          parsed,
          userId: user.id,
          targetCharacterId: partnerId,
          restoreMode,
        });
        invalidateKeepAlive('chat');
        invalidateKeepAlive('chat/thread');
        invalidateKeepAlive('character-phone');
        close();
        const offlineHint = result.offlineSkipped
          ? `；已隔离 ${result.offlineSkipped} 条其他档位的线下记录`
          : '';
        if (result.copied) {
          showToast(`已恢复角色副本，导入 ${result.messagesSaved} 条消息${offlineHint}`, 4500);
        } else {
          characterArchiveInspection = null;
          showToast(`已合并 ${result.messagesSaved} 条消息与 ${result.recordsSaved} 条关联记录${offlineHint}`, 4500);
          await rerenderKeepScroll(container, params);
        }
      } catch (error) {
        button.disabled = false;
        button.textContent = '开始恢复';
        showToast(error?.message || '角色档案恢复失败', 4500);
      }
    });
  };

  container.querySelector('[data-import-character-archive]')?.addEventListener('click', () => {
    archiveFileInput?.click();
  });
  archiveFileInput?.addEventListener('change', async () => {
    const file = archiveFileInput.files?.[0];
    if (!file) return;
    const trigger = container.querySelector('[data-import-character-archive]');
    const previous = trigger?.innerHTML || '';
    if (trigger) {
      trigger.disabled = true;
      trigger.textContent = '校验档案中…';
    }
    try {
      const parsed = await characterTimeCapsuleModule.parseCharacterTimeCapsuleFile(file);
      openArchiveImportPreview(parsed, file);
    } catch (error) {
      archiveFileInput.value = '';
      showToast(error?.message || '角色档案读取失败', 4500);
    } finally {
      if (trigger) {
        trigger.disabled = false;
        trigger.innerHTML = previous;
      }
    }
  });

  container.querySelector('[data-clear-character-voice-cache]')?.addEventListener('click', async (event) => {
    const inspection = await ensureCharacterArchiveInspection().catch((error) => {
      showToast(error?.message || '语音缓存读取失败');
      return null;
    });
    if (!inspection) return;
    if (!inspection.counts.voiceCaches) {
      showToast('本角色没有可清理的语音缓存');
      return;
    }
    if (!window.confirm(`清理本角色引用的 ${inspection.counts.voiceCaches} 条语音缓存？聊天文字和语音气泡会保留，再次播放时可重新生成。`)) return;
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const result = await characterTimeCapsuleModule.clearCharacterVoiceCache(inspection);
      characterArchiveInspection = null;
      const refreshed = await ensureCharacterArchiveInspection();
      showToast(result.deleted ? `已清理 ${result.deleted} 条语音缓存` : '没有找到可清理的语音缓存');
      renderCharacterStorage(refreshed);
    } catch (error) {
      showToast(error?.message || '语音缓存清理失败');
    } finally {
      button.disabled = false;
    }
  });

  container.querySelector('[data-prune-history]')?.addEventListener('click', async (event) => {
    if (!window.confirm('删除较早聊天记录，仅保留最近 500 条？系统提示也会一并按时间清理，此操作不可恢复。')) return;
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const result = await pruneChatHistory(chatId, 500);
      if (!result.deleted) {
        showToast('当前记录不超过 500 条，无需清理');
        return;
      }
      invalidateKeepAlive('chat/thread', { chatId });
      showToast(`已清理 ${result.deleted} 条较早记录`);
    } catch (err) {
      showToast(err?.message || '清理失败', 3500);
    } finally {
      button.disabled = false;
    }
  });

  container.querySelector('[data-export-chat-records]')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const previous = button.innerHTML;
    button.disabled = true;
    button.textContent = '导出中…';
    try {
      const result = await exportChatRecords(chatId, {
        name: isGroup ? chat.groupSettings?.name : (remarkName || partner?.name || partner?.customNickname),
      });
      showToast(result.count ? `已导出 ${result.count} 条聊天记录` : '已导出空聊天记录');
    } catch (error) {
      showToast(error?.message || '聊天记录导出失败', 4000);
    } finally {
      if (button.isConnected) {
        button.disabled = false;
        button.innerHTML = previous;
      }
    }
  });

  const chatRecordsFile = container.querySelector('.cd-chat-records-file');
  container.querySelector('[data-import-chat-records]')?.addEventListener('click', () => {
    triggerFileInput(chatRecordsFile);
  });
  chatRecordsFile?.addEventListener('change', async () => {
    const file = chatRecordsFile.files?.[0];
    chatRecordsFile.value = '';
    if (!file) return;
    const button = container.querySelector('[data-import-chat-records]');
    const previous = button?.innerHTML || '';
    if (button) {
      button.disabled = true;
      button.textContent = '导入中…';
    }
    try {
      const parsed = parseChatRecordJson(await file.text());
      if (!window.confirm(`将「${parsed.conversation.name}」的 ${parsed.messages.length} 条记录导入当前${isGroup ? '群聊' : '单聊'}窗口？`)) return;
      const result = await importChatRecordsIntoChat(chatId, parsed);
      invalidateKeepAlive('chat/thread', { chatId });
      invalidateKeepAlive('chat');
      showToast(result.imported
        ? `已导入 ${result.imported} 条${result.skipped ? `，跳过 ${result.skipped} 条重复记录` : ''}`
        : '没有新记录可导入');
    } catch (error) {
      showToast(error?.message || '聊天记录导入失败', 4000);
    } finally {
      if (button?.isConnected) {
        button.disabled = false;
        button.innerHTML = previous;
      }
    }
  });

  container.querySelector('[data-clear-memory]')?.addEventListener('click', async () => {
    if (!window.confirm('清除本会话的全部记忆条目？')) return;
    await clearChatMemories(chatId, user.id);
    showToast('记忆已清除');
    await rerenderKeepScroll(container, params);
  });

  container.querySelector('[data-reset-character-progress]')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const characterName = String(partner?.name || partner?.customNickname || '该角色').trim();
    if (!await confirmCharacterProgressReset(characterName)) return;
    const previousLabel = button.textContent;
    button.disabled = true;
    button.textContent = '清除中…';
    showToast('正在清除角色相关内容…', 1800);
    try {
      await resetCharacterSlotProgress({
        userId: user.id,
        characterId: partnerId,
        chatId,
      });
      invalidateKeepAlive('chat/thread', { chatId });
      invalidateKeepAlive('character-phone', { character: partnerId });
      invalidateKeepAlive('chat');
      showToast('角色相关内容已清空');
      await rerenderKeepScroll(container, params);
    } catch (error) {
      button.disabled = false;
      button.textContent = previousLabel;
      showToast(error?.message || '清除失败，请稍后重试');
    }
  });

  function notifyChatAppearanceChanged() {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('marshmallow-appearance-changed'));
    }
  }
  container.querySelector('.cd-wallpaper-pick')?.addEventListener('click', () => {
    container.querySelector('.cd-wallpaper-input')?.click();
  });
  const wallpaperLibrary = container.querySelector('.cd-wallpaper-library');
  async function refreshWallpaperLibrary() {
    const grid = wallpaperLibrary?.querySelector('.cd-wallpaper-library-grid');
    if (!grid) return;
    grid.innerHTML = '<span class="cd-wallpaper-library-loading">读取中…</span>';
    const assets = await listBeautifyAssets('image').catch(() => []);
    const images = assets
      .filter((asset) => /^(?:data:image\/|https:\/\/)/i.test(String(asset?.dataUrl || '')))
      .slice(0, 40);
    grid.innerHTML = images.length
      ? images.map((asset) => `
        <button type="button" class="cd-wallpaper-library-item" data-wallpaper-asset="${escAttr(asset.id)}" aria-label="使用 ${escAttr(asset.name || '壁纸')}">
          <img src="${esc(asset.dataUrl)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">
          <span>${esc(asset.name || '壁纸')}</span>
        </button>
      `).join('')
      : '<span class="cd-wallpaper-library-empty">还没有图片，先批量导入</span>';
    grid.querySelectorAll('[data-wallpaper-asset]').forEach((button) => {
      button.addEventListener('click', async () => {
        const asset = await getRecord('beautifyAssets', button.dataset.wallpaperAsset).catch(() => null);
        const dataUrl = String(asset?.dataUrl || '');
        if (!/^(?:data:image\/|https:\/\/)/i.test(dataUrl)) {
          showToast('这张图库图片已经失效');
          return;
        }
        chat.groupSettings = {
          ...(chat.groupSettings || {}),
          wallpaperAssetId: String(asset.id),
          wallpaper: dataUrl,
          appearanceGeneration: Math.max(0, Math.floor(Number(appearancePrefs.chatSessionAppearanceGeneration) || 0)),
        };
        await saveChat(chat);
        notifyChatAppearanceChanged();
        showToast('壁纸已从图库设置');
        await rerenderKeepScroll(container, params);
      });
    });
  }
  container.querySelector('.cd-wallpaper-library-toggle')?.addEventListener('click', async () => {
    if (!wallpaperLibrary) return;
    wallpaperLibrary.hidden = !wallpaperLibrary.hidden;
    if (!wallpaperLibrary.hidden) await refreshWallpaperLibrary();
  });
  container.querySelector('.cd-wallpaper-library-add')?.addEventListener('click', () => {
    container.querySelector('.cd-wallpaper-library-input')?.click();
  });
  container.querySelector('.cd-wallpaper-library-input')?.addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || [])
      .filter((file) => String(file?.type || '').startsWith('image/'))
      .slice(0, 30);
    if (!files.length) return;
    const button = container.querySelector('.cd-wallpaper-library-add');
    const originalText = button?.textContent || '批量导入';
    let savedCount = 0;
    let skippedCount = 0;
    try {
      const { downsampleLargeFileForCrop, compressFileToDataUrl } = await loadImageCropModule();
      if (button) button.disabled = true;
      for (let i = 0; i < files.length; i += 1) {
        const file = files[i];
        if (button) button.textContent = `${i + 1}/${files.length}`;
        if (Number(file.size || 0) > 40 * 1024 * 1024) {
          skippedCount += 1;
          continue;
        }
        try {
          const prepared = await downsampleLargeFileForCrop(file, {
            minBytes: 3 * 1024 * 1024,
            resizeWidth: 1800,
            quality: 0.84,
          });
          const dataUrl = await compressFileToDataUrl(prepared, {
            maxSize: 1600,
            quality: 0.82,
          });
          await saveBeautifyImageDataUrl(dataUrl, file.name, 'image/jpeg');
          savedCount += 1;
        } catch (_) {
          skippedCount += 1;
        }
      }
      if (savedCount) {
        if (wallpaperLibrary) wallpaperLibrary.hidden = false;
        await refreshWallpaperLibrary();
      }
      showToast(skippedCount
        ? `已加入 ${savedCount} 张，${skippedCount} 张未能处理`
        : `已加入壁纸库 ${savedCount} 张`);
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = originalText;
      }
      e.target.value = '';
    }
  });
  container.querySelector('.cd-wallpaper-input')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const { fileToCroppedCompressedDataUrl, IMAGE_CROP_PRESETS } = await loadImageCropModule();
      const dataUrl = await fileToCroppedCompressedDataUrl(file, IMAGE_CROP_PRESETS.wallpaper);
      if (!dataUrl) return;
      const asset = await saveBeautifyImageDataUrl(dataUrl, file.name, 'image/jpeg');
      chat.groupSettings = {
        ...(chat.groupSettings || {}),
        wallpaperAssetId: String(asset.id),
        wallpaper: dataUrl,
        appearanceGeneration: Math.max(0, Math.floor(Number(appearancePrefs.chatSessionAppearanceGeneration) || 0)),
      };
      await saveChat(chat);
      notifyChatAppearanceChanged();
      showToast('壁纸已设置');
      await rerenderKeepScroll(container, params);
    } catch (err) {
      showToast(err?.message || '壁纸读取失败');
    } finally {
      e.target.value = '';
    }
  });
  container.querySelector('.cd-wallpaper-clear')?.addEventListener('click', async () => {
    chat.groupSettings = { ...(chat.groupSettings || {}), wallpaper: '', wallpaperAssetId: '' };
    await saveChat(chat);
    notifyChatAppearanceChanged();
    showToast('壁纸已清除');
    await rerenderKeepScroll(container, params);
  });
  container.querySelector('.cd-wallpaper-url-apply')?.addEventListener('click', async () => {
    const input = container.querySelector('.cd-wallpaper-url');
    const url = input ? input.value.trim() : '';
    if (!url) { showToast('请先粘贴图片链接'); return; }
    if (/^http:\/\//i.test(url)) { showToast('请使用 https 链接（http 图片会被拦截）'); return; }
    if (!/^https:\/\//i.test(url)) { showToast('请粘贴 https:// 开头的图片链接'); return; }
    const asset = await saveBeautifyImageUrl(url, '外链壁纸');
    chat.groupSettings = {
      ...(chat.groupSettings || {}),
      wallpaperAssetId: String(asset.id),
      wallpaper: url,
      appearanceGeneration: Math.max(0, Math.floor(Number(appearancePrefs.chatSessionAppearanceGeneration) || 0)),
    };
    await saveChat(chat);
    notifyChatAppearanceChanged();
    showToast('壁纸已用链接设置');
    await rerenderKeepScroll(container, params);
  });

  // ── 消息界面美化（本会话） ──
  async function patchChatAppearance(patch) {
    const resolvedPatch = { ...patch };
    for (const key of ['customCss', 'userBubbleCss', 'charBubbleCss']) {
      if (Object.prototype.hasOwnProperty.call(resolvedPatch, key)) {
        resolvedPatch[key] = await resolveBeautifyCssAssets(resolvedPatch[key]);
      }
    }
    chat.groupSettings = markChatSessionAppearanceActive({
      ...(chat.groupSettings || {}),
      ...resolvedPatch,
    }, appearancePrefs.chatSessionAppearanceGeneration);
    await saveChat(chat);
    notifyChatAppearanceChanged();
  }
  function currentAppearanceFromForm() {
    const cssEl = container.querySelector('.cd-chat-css');
    const userCssEl = container.querySelector('.cd-user-bubble-css');
    const charCssEl = container.querySelector('.cd-char-bubble-css');
    return {
      customCss: cssEl ? cssEl.value : (chat.groupSettings?.customCss || ''),
      userBubbleCss: userCssEl ? userCssEl.value : (chat.groupSettings?.userBubbleCss || ''),
      charBubbleCss: charCssEl ? charCssEl.value : (chat.groupSettings?.charBubbleCss || ''),
      wallpaperOpacity: chat.groupSettings?.wallpaperOpacity,
      bubbleSelf: chat.groupSettings?.bubbleSelf || '',
      bubbleOther: chat.groupSettings?.bubbleOther || '',
      bubbleTextSelf: chat.groupSettings?.bubbleTextSelf || '',
      bubbleTextOther: chat.groupSettings?.bubbleTextOther || '',
      bubbleFontSize: Number(chat.groupSettings?.bubbleFontSize) || 0,
      avatarSize: Number(chat.groupSettings?.avatarSize) || 0,
      narrationFontSize: Number(chat.groupSettings?.narrationFontSize) || 0,
      narrationTextColor: chat.groupSettings?.narrationTextColor || '',
      bubbleGrouping: !!chat.groupSettings?.bubbleGrouping,
    };
  }

  function bindCssFieldActions({ areaSel, importFileSel, importBtnSel, exportBtnSel, shareBtnSel, resourceSubtype, resetBtnSel, bigeditBtnSel, fieldKey, title, placeholder, resetConfirm }) {
    const area = container.querySelector(areaSel);
    const importFile = container.querySelector(importFileSel);
    container.querySelector(bigeditBtnSel)?.addEventListener('click', () => {
      openTextEditorModal({
        title,
        value: area ? area.value : '',
        placeholder,
        confirmLabel: '保存',
        variant: anonEditorVariant(),
        onSave: async (text) => {
          if (area) area.value = text;
          await patchChatAppearance({ [fieldKey]: text });
          showToast('美化已保存，重新进入会话生效');
        },
      });
    });
    container.querySelector(exportBtnSel)?.addEventListener('click', async () => {
      try {
        await downloadTextFile(area ? area.value : '', `marshmallow-${fieldKey}-${Date.now()}.css`);
        showToast('CSS 已导出');
      } catch (err) {
        showToast(`导出失败：${err?.message || err}`);
      }
    });
    container.querySelector(shareBtnSel)?.addEventListener('click', () => {
      const cssText = area ? area.value : '';
      if (!cssText.trim()) { showToast('当前没有可分享的 CSS'); return; }
      shareToCommunityStore({
        source: cssText,
        fileName: `marshmallow-${fieldKey}.css`,
        resourceType: 'beautify',
        resourceSubtype,
        title: title.replace(/^编辑/, ''),
        originLabel: '会话美化',
      });
    });
    container.querySelector(importBtnSel)?.addEventListener('click', () => importFile?.click());
    importFile?.addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!file) return;
      try {
        const text = await file.text();
        if (area) area.value = text;
        await patchChatAppearance({ [fieldKey]: text });
        showToast('CSS 已导入，重新进入会话生效');
      } catch (err) {
        showToast(String(err?.message || '导入失败'));
      }
    });
    container.querySelector(resetBtnSel)?.addEventListener('click', async () => {
      if (area && !area.value.trim()) return;
      if (!window.confirm(resetConfirm)) return;
      if (area) area.value = '';
      await patchChatAppearance({ [fieldKey]: '' });
      showToast('已清空，重新进入会话生效');
    });
  }

  const wpOpacity = container.querySelector('.cd-wp-opacity');
  const wpOpacityVal = container.querySelector('.cd-wp-opacity-val');
  wpOpacity?.addEventListener('input', () => {
    if (wpOpacityVal) wpOpacityVal.textContent = `${wpOpacity.value}%`;
  });
  wpOpacity?.addEventListener('change', async () => {
    await patchChatAppearance({ wallpaperOpacity: clampWallpaperOpacity(wpOpacity.value) });
    showToast('壁纸透明度已保存');
  });

  // ── 气泡字号（本会话 / 全局）──
  const bubbleFs = container.querySelector('.cd-bubble-fs');
  const bubbleFsVal = container.querySelector('.cd-bubble-fs-val');
  const bubbleFsScope = container.querySelector('.cd-bubble-fs-scope');
  const bubbleFsGlobal = container.querySelector('.cd-bubble-fs-global');
  const syncBubbleFsLabel = () => {
    const useGlobal = !!bubbleFsGlobal?.checked;
    if (bubbleFsVal) bubbleFsVal.textContent = `${bubbleFs?.value || bubbleFontValue}px`;
    if (bubbleFsScope) bubbleFsScope.textContent = useGlobal ? '· 跟随全局' : '· 仅本会话';
  };
  const persistBubbleFs = async () => {
    const size = clampChatBubbleFontSize(bubbleFs?.value || bubbleFontValue);
    if (bubbleFsGlobal?.checked) {
      await setGlobalChatBubbleFontSize(size);
      await patchChatAppearance({ bubbleFontSize: 0 });
      showToast('全局字号已更新');
    } else {
      await patchChatAppearance({ bubbleFontSize: size });
      showToast('本会话字号已更新，重新进入会话生效');
    }
  };
  bubbleFs?.addEventListener('input', syncBubbleFsLabel);
  bubbleFs?.addEventListener('change', persistBubbleFs);
  bubbleFsGlobal?.addEventListener('change', async () => {
    syncBubbleFsLabel();
    await persistBubbleFs();
  });

  const avatarSize = container.querySelector('.cd-avatar-size');
  const avatarSizeVal = container.querySelector('.cd-avatar-size-val');
  avatarSize?.addEventListener('input', () => {
    if (avatarSizeVal) avatarSizeVal.textContent = `${avatarSize.value}px`;
  });
  avatarSize?.addEventListener('change', async () => {
    const size = clampChatAvatarSize(avatarSize.value);
    await patchChatAppearance({ avatarSize: size });
    showToast('头像尺寸已更新，重新进入会话生效');
  });

  const narrationFs = container.querySelector('.cd-narration-fs');
  const narrationFsVal = container.querySelector('.cd-narration-fs-val');
  narrationFs?.addEventListener('input', () => {
    if (narrationFsVal) narrationFsVal.textContent = `${narrationFs.value}px`;
  });
  narrationFs?.addEventListener('change', async () => {
    const size = Math.max(11, Math.min(18, Math.round(Number(narrationFs.value) || 12)));
    await patchChatAppearance({ narrationFontSize: size });
    showToast('旁白字号已更新，重新进入会话生效');
  });
  const narrationTextColor = container.querySelector('.cd-narration-text-color');
  const narrationTextColorText = container.querySelector('.cd-narration-text-color-text');
  narrationTextColor?.addEventListener('change', async () => {
    if (narrationTextColorText) narrationTextColorText.value = narrationTextColor.value;
    await patchChatAppearance({ narrationTextColor: narrationTextColor.value });
    showToast('提示字色已保存，重新进入会话生效');
  });
  narrationTextColorText?.addEventListener('change', async () => {
    const value = String(narrationTextColorText.value || '').trim();
    if (value && !/^#[0-9a-f]{6}$/i.test(value)) {
      showToast('请填 #RRGGBB 或留空');
      return;
    }
    if (value && narrationTextColor) narrationTextColor.value = value;
    await patchChatAppearance({ narrationTextColor: value });
    showToast('提示字色已保存，重新进入会话生效');
  });
  container.querySelector('.cd-narration-text-color-clear')?.addEventListener('click', async () => {
    await patchChatAppearance({ narrationTextColor: '' });
    showToast('提示字色已恢复主题默认');
    await rerenderKeepScroll(container, params);
  });

  container.querySelector('.cd-bubble-group')?.addEventListener('change', async (e) => {
    await patchChatAppearance({ bubbleGrouping: !!e.target.checked });
    showToast('已保存，回到会话即可看到效果');
  });

  container.querySelector('.cd-message-timestamp-mode')?.addEventListener('change', async (e) => {
    const mode = e.target.value === 'each' ? 'each' : 'last';
    prefs = await patchChatPrefs(chatId, { messageTimestampMode: mode });
    showToast(mode === 'each' ? '每条消息都会显示时间' : '连续消息只在末尾显示时间');
  });

  const chatBubbleSelf = container.querySelector('.cd-chat-bubble-self');
  const chatBubbleSelfText = container.querySelector('.cd-chat-bubble-self-text');
  chatBubbleSelf?.addEventListener('change', async () => {
    if (chatBubbleSelfText) chatBubbleSelfText.value = chatBubbleSelf.value;
    await patchChatAppearance({ bubbleSelf: chatBubbleSelf.value });
    showToast('本会话气泡色已保存');
  });
  chatBubbleSelfText?.addEventListener('change', async () => {
    const v = String(chatBubbleSelfText.value || '').trim();
    if (v && !/^#[0-9a-f]{6}$/i.test(v)) { showToast('请填 #RRGGBB 或留空'); return; }
    if (v && chatBubbleSelf) chatBubbleSelf.value = v;
    await patchChatAppearance({ bubbleSelf: v });
    showToast('本会话气泡色已保存');
  });
  container.querySelector('.cd-chat-bubble-self-clear')?.addEventListener('click', async () => {
    await patchChatAppearance({ bubbleSelf: '' });
    showToast('已恢复主题气泡色');
    await rerenderKeepScroll(container, params);
  });

  const chatBubbleOther = container.querySelector('.cd-chat-bubble-other');
  const chatBubbleOtherText = container.querySelector('.cd-chat-bubble-other-text');
  chatBubbleOther?.addEventListener('change', async () => {
    if (chatBubbleOtherText) chatBubbleOtherText.value = chatBubbleOther.value;
    await patchChatAppearance({ bubbleOther: chatBubbleOther.value });
    showToast('本会话对方气泡色已保存');
  });
  chatBubbleOtherText?.addEventListener('change', async () => {
    const v = String(chatBubbleOtherText.value || '').trim();
    if (v && !/^#[0-9a-f]{6}$/i.test(v)) { showToast('请填 #RRGGBB 或留空'); return; }
    if (v && chatBubbleOther) chatBubbleOther.value = v;
    await patchChatAppearance({ bubbleOther: v });
    showToast('本会话对方气泡色已保存');
  });
  container.querySelector('.cd-chat-bubble-other-clear')?.addEventListener('click', async () => {
    await patchChatAppearance({ bubbleOther: '' });
    showToast('已恢复主题气泡色');
    await rerenderKeepScroll(container, params);
  });

  const chatBubbleTextSelf = container.querySelector('.cd-chat-bubble-text-self');
  const chatBubbleTextSelfText = container.querySelector('.cd-chat-bubble-text-self-text');
  chatBubbleTextSelf?.addEventListener('change', async () => {
    if (chatBubbleTextSelfText) chatBubbleTextSelfText.value = chatBubbleTextSelf.value;
    await patchChatAppearance({ bubbleTextSelf: chatBubbleTextSelf.value });
    showToast('本会话字色已保存');
  });
  chatBubbleTextSelfText?.addEventListener('change', async () => {
    const v = String(chatBubbleTextSelfText.value || '').trim();
    if (v && !/^#[0-9a-f]{6}$/i.test(v)) { showToast('请填 #RRGGBB 或留空'); return; }
    if (v && chatBubbleTextSelf) chatBubbleTextSelf.value = v;
    await patchChatAppearance({ bubbleTextSelf: v });
    showToast('本会话字色已保存');
  });
  container.querySelector('.cd-chat-bubble-text-self-clear')?.addEventListener('click', async () => {
    await patchChatAppearance({ bubbleTextSelf: '' });
    showToast('已恢复主题字色');
    await rerenderKeepScroll(container, params);
  });

  const chatBubbleTextOther = container.querySelector('.cd-chat-bubble-text-other');
  const chatBubbleTextOtherText = container.querySelector('.cd-chat-bubble-text-other-text');
  chatBubbleTextOther?.addEventListener('change', async () => {
    if (chatBubbleTextOtherText) chatBubbleTextOtherText.value = chatBubbleTextOther.value;
    await patchChatAppearance({ bubbleTextOther: chatBubbleTextOther.value });
    showToast('本会话对方字色已保存');
  });
  chatBubbleTextOtherText?.addEventListener('change', async () => {
    const v = String(chatBubbleTextOtherText.value || '').trim();
    if (v && !/^#[0-9a-f]{6}$/i.test(v)) { showToast('请填 #RRGGBB 或留空'); return; }
    if (v && chatBubbleTextOther) chatBubbleTextOther.value = v;
    await patchChatAppearance({ bubbleTextOther: v });
    showToast('本会话对方字色已保存');
  });
  container.querySelector('.cd-chat-bubble-text-other-clear')?.addEventListener('click', async () => {
    await patchChatAppearance({ bubbleTextOther: '' });
    showToast('已恢复主题字色');
    await rerenderKeepScroll(container, params);
  });

  const chatCssArea = container.querySelector('.cd-chat-css');
  const userBubbleCssArea = container.querySelector('.cd-user-bubble-css');
  const charBubbleCssArea = container.querySelector('.cd-char-bubble-css');
  container.querySelector('.cd-chat-css-save')?.addEventListener('click', async () => {
    await patchChatAppearance({
      customCss: chatCssArea ? chatCssArea.value : '',
      userBubbleCss: userBubbleCssArea ? userBubbleCssArea.value : '',
      charBubbleCss: charBubbleCssArea ? charBubbleCssArea.value : '',
    });
    showToast('美化已保存，重新进入会话生效');
  });
  container.querySelector('.cd-chat-css-doc')?.addEventListener('click', async () => {
    try {
      await downloadTextFile(buildChatAppearanceReferenceMarkdown(), `marshmallow-chat-css-reference-${Date.now()}.md`);
      showToast('CSS 参考文档已下载');
    } catch (err) {
      showToast(`下载失败：${err?.message || err}`);
    }
  });
  container.querySelector('.cd-chat-css-sync-main')?.addEventListener('click', async () => {
    if (!strangerChat || !partnerId) return;
    const mainChat = await findPrivateChat(user.id, partnerId).catch(() => null);
    const inherited = pickChatAppearanceGroupSettings(mainChat);
    if (!Object.keys(inherited).length) {
      showToast('主会话还没有可同步的美化');
      return;
    }
    chat.groupSettings = {
      ...(chat.groupSettings || {}),
      ...inherited,
      appearanceInheritedFromMainAt: Date.now(),
    };
    await saveChat(chat);
    showToast('已从主会话同步美化，重新进入会话生效');
    await rerenderKeepScroll(container, params);
  });
  bindCssFieldActions({
    areaSel: '.cd-chat-css',
    importFileSel: '.cd-chat-css-import-file',
    importBtnSel: '.cd-chat-css-import',
    exportBtnSel: '.cd-chat-css-export',
    shareBtnSel: '.cd-chat-css-share',
    resourceSubtype: 'chat-style',
    resetBtnSel: '.cd-chat-css-reset',
    bigeditBtnSel: '.cd-chat-css-bigedit',
    fieldKey: 'customCss',
    title: '编辑整页 CSS',
    placeholder: '.chat-thread-page .chat-thread-composer{ ... }',
    resetConfirm: '清空本会话的整页 CSS？',
  });
  bindCssFieldActions({
    areaSel: '.cd-user-bubble-css',
    importFileSel: '.cd-user-bubble-css-import-file',
    importBtnSel: '.cd-user-bubble-css-import',
    exportBtnSel: '.cd-user-bubble-css-export',
    shareBtnSel: '.cd-user-bubble-css-share',
    resourceSubtype: 'chat-bubble',
    resetBtnSel: '.cd-user-bubble-css-reset',
    bigeditBtnSel: '.cd-user-bubble-css-bigedit',
    fieldKey: 'userBubbleCss',
    title: '编辑我方气泡 CSS',
    placeholder: '.chat-thread-page .chat-bubble-row.is-user .scrapbook-bubble{ ... }',
    resetConfirm: '清空本会话的我方气泡 CSS？',
  });
  bindCssFieldActions({
    areaSel: '.cd-char-bubble-css',
    importFileSel: '.cd-char-bubble-css-import-file',
    importBtnSel: '.cd-char-bubble-css-import',
    exportBtnSel: '.cd-char-bubble-css-export',
    shareBtnSel: '.cd-char-bubble-css-share',
    resourceSubtype: 'chat-bubble',
    resetBtnSel: '.cd-char-bubble-css-reset',
    bigeditBtnSel: '.cd-char-bubble-css-bigedit',
    fieldKey: 'charBubbleCss',
    title: '编辑对方气泡 CSS',
    placeholder: '.chat-thread-page .chat-bubble-row.is-them .scrapbook-bubble{ ... }',
    resetConfirm: '清空本会话的对方气泡 CSS？',
  });

  container.querySelector('.cd-chat-preset-save')?.addEventListener('click', async () => {
    const nameInput = container.querySelector('.cd-chat-preset-name');
    const name = nameInput ? nameInput.value.trim() : '';
    try {
      await patchChatAppearance({
        customCss: chatCssArea ? chatCssArea.value : (chat.groupSettings?.customCss || ''),
        userBubbleCss: userBubbleCssArea ? userBubbleCssArea.value : (chat.groupSettings?.userBubbleCss || ''),
        charBubbleCss: charBubbleCssArea ? charBubbleCssArea.value : (chat.groupSettings?.charBubbleCss || ''),
      });
      await saveChatAppearancePreset(name, currentAppearanceFromForm());
      showToast(`已存为预设「${name}」`);
      await rerenderKeepScroll(container, params);
    } catch (err) {
      showToast(String(err?.message || '保存失败'));
    }
  });
  container.querySelectorAll('.cd-chat-preset-apply').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.presetId;
      const presets = await loadChatAppearancePresets();
      const preset = presets.find((p) => p.id === id);
      if (!preset) { showToast('预设不存在'); return; }
      const appr = presetToAppearance(preset);
      await patchChatAppearance({
        customCss: appr.customCss,
        userBubbleCss: appr.userBubbleCss,
        charBubbleCss: appr.charBubbleCss,
        wallpaperOpacity: appr.wallpaperOpacity,
        bubbleSelf: appr.bubbleSelf,
        bubbleOther: appr.bubbleOther,
        bubbleTextSelf: appr.bubbleTextSelf,
        bubbleTextOther: appr.bubbleTextOther,
        bubbleFontSize: appr.bubbleFontSize,
        avatarSize: appr.avatarSize,
        narrationFontSize: appr.narrationFontSize,
        narrationTextColor: appr.narrationTextColor,
        bubbleGrouping: appr.bubbleGrouping,
      });
      showToast(`已应用预设「${preset.name}」`);
      await rerenderKeepScroll(container, params);
    });
  });
  container.querySelectorAll('.cd-chat-preset-del').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await deleteChatAppearancePreset(btn.dataset.presetId);
      showToast('预设已删除');
      await rerenderKeepScroll(container, params);
    });
  });

  // ── 心声样式（本会话） ──
  function currentInnerVoiceCard() {
    return normalizeInnerVoiceCard(chat.groupSettings?.innerVoiceCard, insHomeTheme ? 'ins' : 'diary');
  }
  async function patchInnerVoiceCard(patch) {
    // 合并用没经过默认值填充的原始存储值：如果一直没在 patch 里显式给过 template，
    // 就不要把 currentInnerVoiceCard() 解析出来的默认骨架顺手存死——否则随手改个位置/
    // 文案，就会把 ins 主题本该跟着主题走的默认小白卡永久锁成某一次点击时刚好解析出的值。
    const rawExisting = (chat.groupSettings?.innerVoiceCard && typeof chat.groupSettings.innerVoiceCard === 'object')
      ? chat.groupSettings.innerVoiceCard : {};
    const merged = { ...rawExisting, ...patch };
    chat.groupSettings = { ...(chat.groupSettings || {}), innerVoiceCard: normalizeInnerVoiceCard(merged, insHomeTheme ? 'ins' : 'diary') };
    await saveChat(chat);
    window.dispatchEvent(new CustomEvent(INNER_VOICE_CARD_CHANGED_EVENT, {
      detail: { chatId: chat.id, card: chat.groupSettings.innerVoiceCard },
    }));
  }
  async function resetInnerVoiceCard() {
    const nextGroupSettings = { ...(chat.groupSettings || {}) };
    delete nextGroupSettings.innerVoiceCard;
    chat.groupSettings = nextGroupSettings;
    await saveChat(chat);
    window.dispatchEvent(new CustomEvent(INNER_VOICE_CARD_CHANGED_EVENT, {
      detail: { chatId: chat.id, card: null },
    }));
  }

  container.querySelectorAll('.cd-ivc-template').forEach((btn) => {
    btn.addEventListener('click', async () => {
      // 骨架切换会整页重绘；先把文本区草稿一起落库，避免恢复成上次保存的内容。
      await patchInnerVoiceCard({ ...readInnerVoiceFormPatch(), template: btn.dataset.template });
      showToast('卡片骨架已保存');
      await rerenderKeepScroll(container, params);
    });
  });
  container.querySelectorAll('.cd-ivc-position').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await patchInnerVoiceCard({ ...readInnerVoiceFormPatch(), position: btn.dataset.position });
      showToast('弹出位置已保存');
      await rerenderKeepScroll(container, params);
    });
  });
  container.querySelectorAll('.cd-ivc-label').forEach((input) => {
    input.addEventListener('change', async () => {
      const key = input.dataset.labelKey;
      if (!key) return;
      const labels = { ...currentInnerVoiceCard().labels };
      const v = input.value.trim();
      if (v) labels[key] = v; else delete labels[key];
      await patchInnerVoiceCard({ labels });
      showToast('文案已保存');
    });
  });

  const ivcCssArea = container.querySelector('.cd-ivc-css');
  const ivcInlineCssArea = container.querySelector('.cd-ivc-inline-css');
  const ivcInlineEnabled = container.querySelector('.cd-ivc-inline-enabled');
  const ivcHtmlArea = container.querySelector('.cd-ivc-html');
  const ivcGenerationMode = container.querySelector('.cd-ivc-generation-mode');
  const ivcGenerationPrompt = container.querySelector('.cd-ivc-generation-prompt');
  const ivcGenerationFields = container.querySelector('.cd-ivc-generation-fields');
  function readInnerVoiceFormPatch() {
    return {
      generationMode: ivcGenerationMode?.value === 'custom' ? 'custom' : 'default',
      generationPrompt: ivcGenerationPrompt?.value || '',
      templateHtml: ivcHtmlArea?.value || '',
      css: ivcCssArea?.value || '',
      inlineEnabled: !!ivcInlineEnabled?.checked,
      inlineCss: ivcInlineCssArea?.value || '',
    };
  }
  ivcInlineEnabled?.addEventListener('change', async () => {
    await patchInnerVoiceCard(readInnerVoiceFormPatch());
    showToast(ivcInlineEnabled.checked ? '已在消息内显示心声' : '已关闭消息内心声');
  });
  ivcGenerationMode?.addEventListener('change', async () => {
    const mode = ivcGenerationMode.value === 'custom' ? 'custom' : 'default';
    if (ivcGenerationFields) ivcGenerationFields.hidden = mode !== 'custom';
    await patchInnerVoiceCard({ generationMode: mode });
    showToast(mode === 'custom' ? '已使用自定义心声规则' : '已恢复内置心声规则');
  });
  container.querySelector('.cd-ivc-css-save')?.addEventListener('click', async () => {
    await patchInnerVoiceCard(readInnerVoiceFormPatch());
    showToast('心声方案已保存');
  });
  container.querySelector('.cd-ivc-html-bigedit')?.addEventListener('click', () => {
    openTextEditorModal({
      title: '编辑心声内容 HTML',
      value: ivcHtmlArea?.value || '',
      placeholder: '<section class="my-state">{{customRows}}</section>',
      multiline: true,
      confirmLabel: '保存',
      variant: anonEditorVariant(),
      onSave: async (text) => {
        if (ivcHtmlArea) ivcHtmlArea.value = text;
        await patchInnerVoiceCard({ templateHtml: text });
        showToast('心声 HTML 已保存');
      },
    });
  });
  container.querySelector('.cd-ivc-css-bigedit')?.addEventListener('click', () => {
    openTextEditorModal({
      title: '编辑心声弹层 CSS',
      value: ivcCssArea ? ivcCssArea.value : '',
      placeholder: '#char-state-popover .char-state-card{ ... }',
      confirmLabel: '保存',
      variant: anonEditorVariant(),
      onSave: async (text) => {
        if (ivcCssArea) ivcCssArea.value = text;
        await patchInnerVoiceCard({ css: text });
        showToast('心声样式已保存');
      },
    });
  });
  container.querySelector('.cd-ivc-inline-css-bigedit')?.addEventListener('click', () => {
    openTextEditorModal({
      title: '编辑消息内心声 CSS',
      value: ivcInlineCssArea ? ivcInlineCssArea.value : '',
      placeholder: '.chat-inline-inner-voice-host .chat-inline-inner-voice{ ... }',
      confirmLabel: '保存',
      variant: anonEditorVariant(),
      onSave: async (text) => {
        if (ivcInlineCssArea) ivcInlineCssArea.value = text;
        await patchInnerVoiceCard({ inlineCss: text });
        showToast('消息内心声样式已保存');
      },
    });
  });
  container.querySelector('.cd-ivc-css-doc')?.addEventListener('click', async () => {
    try {
      await downloadTextFile(buildInnerVoiceCardReferenceMarkdown(), `marshmallow-inner-voice-css-reference-${Date.now()}.md`);
      showToast('CSS 参考文档已下载');
    } catch (err) {
      showToast(`下载失败：${err?.message || err}`);
    }
  });
  container.querySelector('.cd-ivc-css-export')?.addEventListener('click', async () => {
    const payload = buildInnerVoiceCardExportPayload(
      { ...currentInnerVoiceCard(), ...readInnerVoiceFormPatch() },
      insHomeTheme ? 'ins' : 'diary',
    );
    try {
      await downloadTextFile(JSON.stringify(payload, null, 2), `marshmallow-inner-voice-${Date.now()}.json`);
      showToast('心声方案已导出');
    } catch (err) {
      showToast(`导出失败：${err?.message || err}`);
    }
  });
  container.querySelector('.cd-ivc-css-share')?.addEventListener('click', () => {
    const payload = buildInnerVoiceCardExportPayload(
      { ...currentInnerVoiceCard(), ...readInnerVoiceFormPatch() },
      insHomeTheme ? 'ins' : 'diary',
    );
    shareToCommunityStore({
      source: payload,
      fileName: 'marshmallow-inner-voice.json',
      resourceType: 'inner-voice',
      title: '心声方案',
      originLabel: '会话心声',
    });
  });
  const ivcCssImportFile = container.querySelector('.cd-ivc-css-import-file');
  container.querySelector('.cd-ivc-css-import')?.addEventListener('click', () => {
    ivcCssImportFile?.click();
  });
  ivcCssImportFile?.addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      if (/\.css$/i.test(file.name || '')) {
        if (ivcCssArea) ivcCssArea.value = text;
        await patchInnerVoiceCard({ css: text });
        showToast('旧 CSS 已导入');
        return;
      }
      const card = parseInnerVoiceCardImportText(text, insHomeTheme ? 'ins' : 'diary');
      await patchInnerVoiceCard(card);
      showToast('心声方案已导入');
      await rerenderKeepScroll(container, params);
    } catch (err) {
      showToast(String(err?.message || '导入失败'));
    }
  });
  container.querySelector('.cd-ivc-css-reset')?.addEventListener('click', async () => {
    if (!window.confirm('恢复本会话的默认心声生成与弹层样式？已生成的心声内容不会改变。')) return;
    await resetInnerVoiceCard();
    showToast('已恢复默认心声');
    await rerenderKeepScroll(container, params);
  });

  container.querySelector('.cd-ivc-preset-save')?.addEventListener('click', async () => {
    const nameInput = container.querySelector('.cd-ivc-preset-name');
    const name = nameInput ? nameInput.value.trim() : '';
    try {
      await patchInnerVoiceCard(readInnerVoiceFormPatch());
      await saveInnerVoiceCardPreset(name, currentInnerVoiceCard());
      showToast(`已存为预设「${name}」`);
      await rerenderKeepScroll(container, params);
    } catch (err) {
      showToast(String(err?.message || '保存失败'));
    }
  });
  container.querySelectorAll('.cd-ivc-preset-apply').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.presetId;
      const presets = await loadInnerVoiceCardPresets();
      const preset = presets.find((p) => p.id === id);
      if (!preset) { showToast('预设不存在'); return; }
      await patchInnerVoiceCard(presetToCard(preset));
      showToast(`已应用预设「${preset.name}」`);
      await rerenderKeepScroll(container, params);
    });
  });
  container.querySelectorAll('.cd-ivc-preset-del').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await patchInnerVoiceCard(readInnerVoiceFormPatch());
      await deleteInnerVoiceCardPreset(btn.dataset.presetId);
      showToast('预设已删除');
      await rerenderKeepScroll(container, params);
    });
  });

  container.querySelector('.cd-user-topic-policy')?.addEventListener('change', async (e) => {
    const policy = ['normal', 'rare', 'off'].includes(e.target.value) ? e.target.value : 'rare';
    chat.groupSettings = { ...(chat.groupSettings || {}), userTopicPolicy: policy };
    await saveChat(chat);
    showToast('用户话题设置已保存');
  });
  container.querySelector('.cd-user-main-chat-context')?.addEventListener('change', async (e) => {
    chat.groupSettings = {
      ...(chat.groupSettings || {}),
      allowUserMainChatContext: !!e.target.checked,
    };
    await saveChat(chat);
    showToast('主窗关联设置已保存');
  });
  container.querySelector('.cd-allow-linkage')?.addEventListener('change', async (e) => {
    const checked = !!e.target.checked;
    chat.groupSettings = {
      ...(chat.groupSettings || {}),
      allowSocialLinkage: checked,
      // 私聊页面只有一个合并开关：同步私聊联动，避免两个字段各存一份、彼此打架。
      ...(isGroup ? {} : { allowPrivateLinkage: checked }),
    };
    await saveChat(chat);
    showToast('联动设置已保存');
  });
  container.querySelector('.cd-allow-private-linkage')?.addEventListener('change', async (e) => {
    chat.groupSettings = { ...(chat.groupSettings || {}), allowPrivateLinkage: !!e.target.checked };
    await saveChat(chat);
    showToast('私聊联动已保存');
  });
  container.querySelector('.cd-allow-ai-group-creation')?.addEventListener('change', async (e) => {
    chat.groupSettings = {
      ...(chat.groupSettings || {}),
      allowAiGroupCreation: !!e.target.checked,
    };
    await saveChat(chat);
    showToast(e.target.checked ? '已允许角色自主建群' : '已禁止角色自主建群');
  });
  container.querySelector('.cd-ai-group-creation-cooldown')?.addEventListener('change', async (e) => {
    const raw = parseInt(e.target.value, 10);
    const turns = Math.min(
      AI_GROUP_CREATION_COOLDOWN_TURNS_MAX,
      Math.max(
        AI_GROUP_CREATION_COOLDOWN_TURNS_MIN,
        Number.isFinite(raw) ? raw : DEFAULT_AI_GROUP_CREATION_COOLDOWN_TURNS,
      ),
    );
    e.target.value = String(turns);
    chat.groupSettings = { ...(chat.groupSettings || {}), aiGroupCreationCooldownTurns: turns };
    await saveChat(chat);
    showToast(turns > 0 ? `建群冷却已设为 ${turns} 个 AI 回合` : '已关闭建群冷却');
  });
  container.querySelector('.cd-linkage-nudge-turns')?.addEventListener('change', async (e) => {
    const turns = Math.min(
      LINKAGE_NUDGE_EVERY_MAX,
      Math.max(LINKAGE_NUDGE_EVERY_MIN, parseInt(e.target.value, 10) || DEFAULT_LINKAGE_NUDGE_EVERY),
    );
    e.target.value = String(turns);
    chat.groupSettings = { ...(chat.groupSettings || {}), linkageNudgeEvery: turns };
    await saveChat(chat);
    showToast('保底轮数已保存');
  });
  container.querySelector('.cd-linkage-interval-turns')?.addEventListener('change', async (e) => {
    const turns = Math.min(
      LINKAGE_MIN_INTERVAL_TURNS_MAX,
      Math.max(
        LINKAGE_MIN_INTERVAL_TURNS_MIN,
        parseInt(e.target.value, 10) || DEFAULT_LINKAGE_MIN_INTERVAL_TURNS,
      ),
    );
    e.target.value = String(turns);
    chat.groupSettings = { ...(chat.groupSettings || {}), linkageMinIntervalTurns: turns };
    chat.metadata = { ...(chat.metadata || {}) };
    delete chat.metadata.linkageLastOpportunityTurn;
    await saveChat(chat);
    showToast('联动间隔已保存');
  });
  container.querySelector('.cd-linkage-cadence-mode')?.addEventListener('change', async (e) => {
    const mode = e.target.value === 'custom' ? 'custom' : 'natural';
    chat.groupSettings = { ...(chat.groupSettings || {}), linkageCadenceMode: mode };
    chat.metadata = { ...(chat.metadata || {}) };
    delete chat.metadata.linkageLastOpportunityTurn;
    const intervalWrap = container.querySelector('.cd-linkage-interval-wrap');
    if (intervalWrap) intervalWrap.hidden = mode !== 'custom';
    await saveChat(chat);
    showToast(mode === 'custom' ? '已使用自定义间隔' : '已恢复自然联动');
  });
  container.querySelector('.cd-linkage-route-bias')?.addEventListener('change', async (e) => {
    const bias = ['private', 'balanced', 'group'].includes(e.target.value) ? e.target.value : 'balanced';
    chat.groupSettings = { ...(chat.groupSettings || {}), linkageRouteBias: bias };
    await saveChat(chat);
    showToast('跨窗去向已保存');
  });
  container.querySelector('.cd-linkage-group-pity')?.addEventListener('change', async (e) => {
    const count = Math.min(
      LINKAGE_GROUP_PITY_MAX,
      Math.max(LINKAGE_GROUP_PITY_MIN, parseInt(e.target.value, 10) || DEFAULT_LINKAGE_GROUP_PITY_EVERY),
    );
    e.target.value = String(count);
    chat.groupSettings = { ...(chat.groupSettings || {}), linkageGroupPityEvery: count };
    await saveChat(chat);
    showToast('群聊保底已保存');
  });
  container.querySelector('.cd-auto-active')?.addEventListener('change', async (e) => {
    chat.autoActive = !!e.target.checked;
    await saveChat(chat);
    if (chat.autoActive) await scheduleChatLazy(chat);
    else await unscheduleChatLazy(chat.id);
    showToast(chat.autoActive ? '后台自动推进已开启' : '后台自动推进已关闭');
  });
  container.querySelector('.cd-auto-interval')?.addEventListener('change', async (e) => {
    const mins = Math.max(1, Number(e.target.value) || 5);
    chat.autoInterval = mins * 60000;
    await saveChat(chat);
    if (chat.autoActive) await scheduleChatLazy(chat);
    showToast('间隔已更新');
  });
  container.querySelector('.cd-idle-continue')?.addEventListener('change', async (e) => {
    idleContinue = await saveIdleContinueSettings(chatId, { enabled: !!e.target.checked });
    import('../core/background-scheduler.js')
      .then((mod) => mod.resyncAllChatSchedules?.(user.id))
      .catch(() => {});
    const linkageMeta = container.querySelector('[data-cd-group="linkage"] .chat-details-group-meta');
    if (linkageMeta) {
      linkageMeta.textContent = proactiveEnabled ? '跨窗 · 闲置续聊' : '主动消息已关闭';
    }
    showToast(
      idleContinue.enabled && !proactiveEnabled
        ? '已保存；开启主动消息后生效'
        : (idleContinue.enabled ? '闲置后自动续聊已开启' : '闲置后自动续聊已关闭'),
    );
  });
  container.querySelector('.cd-mailbox-proactive')?.addEventListener('change', async (e) => {
    const enabled = !!e.target.checked;
    try {
      const { saveCharacterAutonomySettings } = await import('../core/character-autonomy-settings.js');
      await saveCharacterAutonomySettings(user.id, autonomyActorId || partnerId, {
        roleDefaults: { mailboxProactive: { enabled } },
      });
      mailboxProactiveEnabled = enabled;
      const interval = container.querySelector('.cd-mailbox-proactive-interval');
      if (interval) interval.hidden = !enabled;
      showToast(enabled && !proactiveEnabled ? '已保存；开启主动消息后生效' : (enabled ? '已允许 TA 偶尔写邮件' : '已关闭主动邮件'));
    } catch (err) {
      e.target.checked = !enabled;
      showToast(`保存失败：${err?.message || err}`);
    }
  });
  container.querySelector('.cd-mailbox-proactive-interval input')?.addEventListener('change', async (e) => {
    const hours = Math.max(12, Math.min(720, Math.round(Number(e.target.value) || 72)));
    e.target.value = String(hours);
    try {
      const { saveCharacterAutonomySettings } = await import('../core/character-autonomy-settings.js');
      await saveCharacterAutonomySettings(user.id, autonomyActorId || partnerId, {
        roleDefaults: { mailboxProactive: { intervalHours: hours } },
      });
      mailboxProactiveIntervalHours = hours;
      showToast('邮件间隔已更新');
    } catch (err) {
      e.target.value = String(mailboxProactiveIntervalHours);
      showToast(`保存失败：${err?.message || err}`);
    }
  });
  container.querySelector('.cd-idle-continue-minutes')?.addEventListener('change', async (e) => {
    const minutes = Math.max(
      IDLE_CONTINUE_MIN_MINUTES,
      Math.min(IDLE_CONTINUE_MAX_MINUTES, Number(e.target.value) || 3),
    );
    e.target.value = String(minutes);
    idleContinue = await saveIdleContinueSettings(chatId, { minutes });
    import('../core/background-scheduler.js')
      .then((mod) => mod.resyncAllChatSchedules?.(user.id))
      .catch(() => {});
    showToast('等待时长已更新');
  });
  container.querySelector('.cd-real-person')?.addEventListener('change', async (e) => {
    const enabled = !!e.target.checked;
    try {
      const { saveRealPersonExperienceEnabled } = await import('../core/character-autonomy-settings.js');
      await saveRealPersonExperienceEnabled(user.id, partnerId, enabled);
      if (enabled) {
        const { saveLifeGlimpseSettings } = await import('../core/chat/life-glimpse.js');
        const lifeSaved = await saveLifeGlimpseSettings(user.id, autonomyActorId || partnerId, {
          enabled: true,
          localCardsEnabled: false,
          aiStoryCardsEnabled: true,
        }).catch(() => null);
        if (lifeSaved?.enabled === true) {
          lifeGlimpseEnabled = true;
          const lifeInput = container.querySelector('.cd-life-glimpse');
          if (lifeInput) lifeInput.checked = true;
        }
      }
      if (!enabled) {
        await import('../core/chat/pending-actions.js')
          .then((module) => module.cancelPendingActions(user.id, (action) => (
            action.kind === 'life_glimpse'
            && action.characterId === (autonomyActorId || partnerId)
          )))
          .catch(() => null);
      }
      const { resyncAllChatSchedules } = await import('../core/background-scheduler.js');
      await resyncAllChatSchedules(user.id).catch(() => {});
      realPersonEnabled = enabled;
      const floorWrap = container.querySelector('.cd-real-person-floor');
      if (floorWrap) floorWrap.hidden = !enabled;
      const realPersonGroup = container.querySelector('[data-cd-group="real-person"]');
      const realPersonMeta = realPersonGroup?.querySelector('.chat-details-group-meta');
      if (realPersonMeta) realPersonMeta.textContent = enabled ? '已开启' : '推荐开启';
      const idleHint = container.querySelector('.cd-idle-continue-hint');
      if (idleHint) {
        idleHint.textContent = enabled
          ? '真人感已开启：续聊频率由 TA 决定，这里保持关闭即可，不用管等待时间。'
          : '你停止输入几分钟后 TA 自己接着说；只作用于当前会话。';
      }
      showToast(enabled ? '真人感回复已开启' : '真人感回复已关闭');
    } catch (err) {
      e.target.checked = !enabled;
      showToast(`保存失败：${err?.message || err}`);
    }
  });
  container.querySelector('.cd-proactive-enabled')?.addEventListener('change', async (e) => {
    const enabled = !!e.target.checked;
    try {
      const { saveCharacterProactiveEnabled } = await import('../core/character-autonomy-settings.js');
      await saveCharacterProactiveEnabled(user.id, autonomyActorId || partnerId, enabled);
      if (enabled) {
        const { saveCharacterPhoneAutomationConfig } = await import('../core/character-phone-automation-store.js');
        await saveCharacterPhoneAutomationConfig(user.id, autonomyActorId || partnerId, {
          scheduleProactive: { enabled: true },
        }).catch(() => {});
      }
      const { resyncAllChatSchedules } = await import('../core/background-scheduler.js');
      await resyncAllChatSchedules(user.id).catch(() => {});
      proactiveEnabled = enabled;
      const linkageMeta = container.querySelector('[data-cd-group="linkage"] .chat-details-group-meta');
      if (linkageMeta) {
        linkageMeta.textContent = enabled ? '跨窗 · 闲置续聊' : '主动消息已关闭';
      }
      const idleHint = container.querySelector('.cd-idle-continue-hint');
      if (idleHint) {
        idleHint.textContent = !enabled
          ? '先开启主动消息总开关；续聊设置会保留，开启后生效。'
          : (realPersonEnabled
            ? '真人感已开启：续聊频率由 TA 决定，这里保持关闭即可。'
            : '从你停止输入时开始计时；离开聊天后也照常计时。');
      }
      showToast(enabled ? '主动消息已开启' : '主动消息已关闭');
    } catch (err) {
      e.target.checked = !enabled;
      showToast(`保存失败：${err?.message || err}`);
    }
  });
  container.querySelector('.cd-system-auto-reply')?.addEventListener('change', async (e) => {
    const enabled = !!e.target.checked;
    try {
      const { saveCharacterAutonomySettings } = await import('../core/character-autonomy-settings.js');
      await saveCharacterAutonomySettings(user.id, partnerId, {
        roleDefaults: { realPersonMode: { systemAutoReplyEnabled: enabled } },
      });
      systemAutoReplyEnabled = enabled;
      showToast(enabled ? '已开启登记留言回复' : '已关闭登记留言回复');
    } catch (err) {
      e.target.checked = !enabled;
      showToast(`保存失败：${err?.message || err}`);
    }
  });
  container.querySelector('.cd-hard-offline')?.addEventListener('change', async (e) => {
    const enabled = !!e.target.checked;
    try {
      const { saveCharacterAutonomySettings } = await import('../core/character-autonomy-settings.js');
      await saveCharacterAutonomySettings(user.id, partnerId, {
        roleDefaults: { realPersonMode: { allowHardOffline: enabled } },
      });
      allowHardOffline = enabled;
      showToast(enabled ? '已允许 TA 自行完全下线' : '已关闭自主完全下线');
    } catch (err) {
      e.target.checked = !enabled;
      showToast(`保存失败：${err?.message || err}`);
    }
  });
  container.querySelector('.cd-life-glimpse')?.addEventListener('change', async (e) => {
    const enabled = !!e.target.checked;
    const characterId = autonomyActorId || partnerId;
    try {
      const { saveLifeGlimpseSettings } = await import('../core/chat/life-glimpse.js');
      await saveLifeGlimpseSettings(user.id, characterId, {
        enabled,
        localCardsEnabled: false,
        aiStoryCardsEnabled: true,
      });
      if (!enabled) {
        await import('../core/chat/pending-actions.js')
          .then((module) => module.cancelPendingActions(user.id, (action) => (
            action.kind === 'life_glimpse'
            && action.characterId === characterId
          )))
          .catch(() => null);
      }
      lifeGlimpseEnabled = enabled;
      showToast(enabled ? '生活侧面已开启（会调用 API）' : '已关闭生活侧面');
    } catch (err) {
      e.target.checked = !enabled;
      showToast(`保存失败：${err?.message || err}`);
    }
  });
  container.querySelector('.cd-status-activity-level')?.addEventListener('change', async (e) => {
    const level = ['quiet', 'natural', 'active'].includes(e.target.value) ? e.target.value : 'natural';
    try {
      const { saveCharacterAutonomySettings } = await import('../core/character-autonomy-settings.js');
      await saveCharacterAutonomySettings(user.id, partnerId, {
        roleDefaults: { realPersonMode: { statusActivityLevel: level } },
      });
      statusActivityLevel = level;
      showToast('顶栏状态活跃度已保存');
    } catch (err) {
      e.target.value = statusActivityLevel;
      showToast(`保存失败：${err?.message || err}`);
    }
  });
  container.querySelector('input.cd-real-person-floor')?.addEventListener('change', async (e) => {
    const enabled = !!e.target.checked;
    try {
      const { saveCharacterAutonomySettings } = await import('../core/character-autonomy-settings.js');
      await saveCharacterAutonomySettings(user.id, partnerId, {
        roleDefaults: { realPersonMode: { idleReplyFloorEnabled: enabled } },
      });
      realPersonIdleFloorEnabled = enabled;
      const secondsInput = container.querySelector('.cd-real-person-floor-seconds');
      if (secondsInput) secondsInput.disabled = !enabled;
      showToast(enabled ? '已开启自定义无输入等待' : '已恢复默认无输入等待');
    } catch (err) {
      e.target.checked = !enabled;
      showToast(`保存失败：${err?.message || err}`);
    }
  });
  container.querySelector('.cd-real-person-floor-seconds')?.addEventListener('change', async (e) => {
    const seconds = Math.max(
      idleReplyFloorMinSeconds,
      Math.min(idleReplyFloorMaxSeconds, Math.trunc(Number(e.target.value) || 3)),
    );
    e.target.value = String(seconds);
    try {
      const { saveCharacterAutonomySettings } = await import('../core/character-autonomy-settings.js');
      await saveCharacterAutonomySettings(user.id, partnerId, {
        roleDefaults: {
          realPersonMode: {
            idleReplyFloorEnabled: true,
            idleReplyFloorSeconds: seconds,
          },
        },
      });
      realPersonIdleFloorEnabled = true;
      realPersonIdleFloorSeconds = seconds;
      const floorToggle = container.querySelector('input.cd-real-person-floor');
      if (floorToggle) floorToggle.checked = true;
      e.target.disabled = false;
      showToast(`无输入后最少等待 ${seconds} 秒`);
    } catch (err) {
      showToast(`保存失败：${err?.message || err}`);
    }
  });
  container.querySelector('.cd-chase-beat-max')?.addEventListener('change', async (e) => {
    const raw = Number(e.target.value);
    const rounds = Number.isFinite(raw) ? Math.max(0, Math.min(5, Math.trunc(raw))) : 3;
    e.target.value = String(rounds);
    prefs = await patchChatPrefs(chatId, { chaseBeatMaxRounds: rounds });
    if (rounds === 0) {
      await import('../core/chat/real-person-chase-beat.js')
        .then((mod) => mod.cancelChaseBeatsForChat(user.id, chatId))
        .catch(() => {});
    }
    showToast(rounds > 0 ? `不回时最多追 ${rounds} 拍` : '已关闭不回追发');
  });
  container.querySelector('.cd-chase-min-interval')?.addEventListener('change', async (e) => {
    const raw = Number(e.target.value);
    const minutes = Number.isFinite(raw) && raw > 0
      ? Math.max(1, Math.min(1440, Math.trunc(raw)))
      : DEFAULT_CHASE_MIN_INTERVAL_MINUTES;
    e.target.value = String(minutes);
    prefs = await patchChatPrefs(chatId, { chaseMinIntervalMinutes: minutes });
    showToast(`追发之间至少隔 ${minutes} 分钟`);
  });
  container.querySelector('.cd-proactive-min-gap')?.addEventListener('change', async (e) => {
    const previous = proactiveMinGapMinutes;
    const raw = Number(e.target.value);
    const minutes = Number.isFinite(raw)
      ? Math.max(0, Math.min(1440, Math.trunc(raw)))
      : 0;
    e.target.value = String(minutes);
    try {
      const { saveCharacterAutonomySettings } = await import('../core/character-autonomy-settings.js');
      await saveCharacterAutonomySettings(user.id, autonomyActorId || partnerId, {
        roleDefaults: { scheduleProactive: { minGapMinutes: minutes } },
      });
      const { saveCharacterPhoneAutomationConfig } = await import('../core/character-phone-automation-store.js');
      await saveCharacterPhoneAutomationConfig(user.id, autonomyActorId || partnerId, {
        scheduleProactive: { minGapMinutes: minutes },
      }).catch(() => {});
      proactiveMinGapMinutes = minutes;
      showToast(minutes > 0 ? `全部主动消息至少间隔 ${minutes} 分钟` : '已按各功能自己的间隔执行');
    } catch (err) {
      e.target.value = String(previous);
      showToast(`保存失败：${err?.message || err}`);
    }
  });
  container.querySelector('.cd-open-autonomy-settings')?.addEventListener('click', () => {
    navigate('character-phone', { character: partnerId, app: 'settings', from: 'chat', chatId });
  });

  container.querySelector('.cd-auto-summary')?.addEventListener('change', async (e) => {
    prefs = await patchChatPrefs(chatId, { autoSummary: !!e.target.checked });
    showToast('自动摘要设置已保存');
  });

  container.querySelector('.cd-auto-freq')?.addEventListener('change', async (e) => {
    const freq = Math.min(2000, Math.max(10, parseInt(e.target.value, 10) || 100));
    e.target.value = String(freq);
    prefs = await patchChatPrefs(chatId, { autoSummaryFreq: freq });
    showToast('摘要频率已保存');
  });

  container.querySelector('.cd-context-depth')?.addEventListener('change', async (e) => {
    const depth = normalizeChatContextDepth(e.target.value, CHAT_CONTEXT_DEPTH_DEFAULT);
    e.target.value = String(depth);
    prefs = await patchChatPrefs(chatId, { contextDepth: depth });
    showToast('上下文条数已保存');
  });

  container.querySelector('.cd-memory-source-enabled')?.addEventListener('change', async (e) => {
    const enabled = !!e.target.checked;
    if (!enabled) {
      const linkedIds = normalizeMemoryInjectionSettings(prefs).explicitSharedChatIds;
      await Promise.all(linkedIds.map(async (otherChatId) => {
        const otherPrefs = await loadChatPrefs(otherChatId);
        const otherIds = new Set(normalizeMemoryInjectionSettings(otherPrefs).explicitSharedChatIds);
        otherIds.delete(chatId);
        await patchChatPrefs(otherChatId, { explicitSharedMemoryChatIds: [...otherIds] });
      }));
      container.querySelectorAll('.cd-memory-share-chat').forEach((input) => { input.checked = false; });
    }
    prefs = await patchChatPrefs(chatId, {
      allowAsCrossWindowMemorySource: enabled,
      ...(enabled ? {} : { explicitSharedMemoryChatIds: [] }),
    });
    showToast('跨窗来源设置已保存');
  });

  container.querySelector('.cd-related-memory-enabled')?.addEventListener('change', async (e) => {
    prefs = await patchChatPrefs(chatId, { relatedWindowMemoryEnabled: !!e.target.checked });
    showToast('同角色窗口设置已保存');
  });

  container.querySelector('.cd-memory-decay-enabled')?.addEventListener('change', async (e) => {
    const enabled = !!e.target.checked;
    prefs = await patchChatPrefs(chatId, { memoryDecayEnabled: enabled });
    const fields = container.querySelector('.cd-memory-decay-fields');
    if (fields) fields.hidden = !enabled;
    showToast(enabled ? '已开启记忆衰退' : '已关闭记忆衰退');
  });

  container.querySelectorAll('.cd-memory-decay-hours').forEach((input) => {
    input.addEventListener('change', async (e) => {
      const key = String(e.target.getAttribute('data-memory-decay-pref') || '').trim();
      if (!key) return;
      const normalized = normalizeMemoryInjectionSettings({ ...prefs, [key]: e.target.value });
      const fullPatch = memoryInjectionSettingsPatch(normalized);
      const value = fullPatch[key];
      e.target.value = String(value);
      prefs = await patchChatPrefs(chatId, { [key]: value });
      showToast('常驻时间已保存');
    });
  });

  container.querySelectorAll('.cd-memory-limit').forEach((input) => {
    input.addEventListener('change', async (e) => {
      const key = String(e.target.getAttribute('data-memory-pref') || '').trim();
      if (!key) return;
      const normalized = normalizeMemoryInjectionSettings({ ...prefs, [key]: e.target.value });
      const fullPatch = memoryInjectionSettingsPatch(normalized);
      const value = fullPatch[key];
      e.target.value = String(value);
      prefs = await patchChatPrefs(chatId, { [key]: value });
      showToast('记忆注入条数已保存');
    });
  });

  container.querySelectorAll('.cd-memory-share-chat').forEach((input) => {
    input.addEventListener('change', async (e) => {
      const otherChatId = String(e.target.getAttribute('data-chat-id') || '').trim();
      if (!otherChatId) return;
      const enabled = !!e.target.checked;
      const currentSettings = normalizeMemoryInjectionSettings(prefs);
      const currentIds = new Set(currentSettings.explicitSharedChatIds);
      if (enabled) currentIds.add(otherChatId);
      else currentIds.delete(otherChatId);
      prefs = await patchChatPrefs(chatId, {
        explicitSharedMemoryChatIds: [...currentIds],
        ...(enabled ? { allowAsCrossWindowMemorySource: true } : {}),
      });

      const otherPrefs = await loadChatPrefs(otherChatId);
      const otherSettings = normalizeMemoryInjectionSettings(otherPrefs);
      const otherIds = new Set(otherSettings.explicitSharedChatIds);
      if (enabled) otherIds.add(chatId);
      else otherIds.delete(chatId);
      await patchChatPrefs(otherChatId, {
        explicitSharedMemoryChatIds: [...otherIds],
        ...(enabled ? { allowAsCrossWindowMemorySource: true } : {}),
      });
      if (enabled) {
        const sourceToggle = container.querySelector('.cd-memory-source-enabled');
        if (sourceToggle) sourceToggle.checked = true;
      }
      showToast(enabled ? '已开启双向记忆互通' : '已关闭双向记忆互通');
    });
  });

  container.querySelectorAll('.cd-worldbook-id').forEach((input) => {
    input.addEventListener('change', async () => {
      const ids = [...container.querySelectorAll('.cd-worldbook-id:checked')]
        .map((el) => String(el.getAttribute('data-worldbook-id') || '').trim())
        .filter(Boolean);
      prefs = await patchChatPrefs(chatId, { worldBookIds: ids });
      showToast(ids.length ? `已额外启用 ${ids.length} 本世界书` : '已恢复默认世界书规则');
    });
  });

  container.querySelector('.cd-online-preset-override')?.addEventListener('change', async (event) => {
    const enabled = !!event.target.checked;
    const ids = enabled
      ? [...container.querySelectorAll('.cd-online-preset-id:checked')]
        .map((input) => String(input.getAttribute('data-preset-id') || '').trim())
        .filter(Boolean)
      : null;
    prefs = await patchChatPrefs(chatId, { onlinePresetIds: ids });
    showToast(enabled ? '已改为本会话单独绑定线上预设' : '已恢复跟随全局线上预设');
    await rerenderKeepScroll(container, params);
  });

  container.querySelectorAll('.cd-online-preset-id').forEach((input) => {
    input.addEventListener('change', async () => {
      const ids = [...container.querySelectorAll('.cd-online-preset-id:checked')]
        .map((item) => String(item.getAttribute('data-preset-id') || '').trim())
        .filter(Boolean);
      prefs = await patchChatPrefs(chatId, { onlinePresetIds: ids });
      showToast(ids.length ? `已单独绑定 ${ids.length} 条线上预设` : '本会话已关闭可选线上预设');
    });
  });

  container.querySelector('.cd-api-model-preset')?.addEventListener('change', async (e) => {
    const presetId = String(e.target.value || '').trim();
    prefs = await patchChatPrefs(chatId, { mainApiPresetId: presetId });
    showToast(presetId ? '已切换本会话使用的模型' : '已恢复跟随全局默认模型');
  });

  container.querySelector('.cd-short-bubble-reply')?.addEventListener('change', async (e) => {
    const enabled = !!e.target.checked;
    prefs = await patchChatPrefs(chatId, { shortBubbleReply: enabled });
    showToast(enabled ? '短气泡回复已开启' : '短气泡回复已关闭');
  });

  container.querySelector('.cd-voice-bubble-prefer')?.addEventListener('change', async (e) => {
    const enabled = !!e.target.checked;
    prefs = await patchChatPrefs(chatId, { voiceBubblePreference: enabled ? 'more' : '' });
    showToast(enabled ? 'TA 会更爱发语音条' : '语音条频率已恢复跟随人设');
  });

  container.querySelector('.cd-voice-performance-mode')?.addEventListener('change', async (e) => {
    const enabled = !!e.target.checked;
    prefs = await patchChatPrefs(chatId, { voicePerformanceMode: enabled });
    const options = container.querySelector('.cd-voice-performance-options');
    if (options) options.hidden = !enabled;
    showToast(enabled ? '语音演绎模式已开启' : '语音演绎模式已关闭');
  });

  container.querySelector('.cd-voice-performance-continuous')?.addEventListener('change', async (e) => {
    const enabled = !!e.target.checked;
    prefs = await patchChatPrefs(chatId, { voicePerformanceContinuous: enabled });
    const gapField = container.querySelector('.cd-voice-round-gap');
    if (gapField) gapField.hidden = !enabled;
    showToast(enabled ? '本轮连续播放已开启' : '已恢复逐条播放');
  });

  const voiceRoundGapInput = container.querySelector('.cd-voice-round-gap-input');
  const voiceRoundGapValue = container.querySelector('.cd-voice-round-gap-value');
  const syncVoiceRoundGapLabel = () => {
    const milliseconds = Math.max(200, Math.min(5000, Number(voiceRoundGapInput?.value) || 400));
    const seconds = (milliseconds / 1000).toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
    if (voiceRoundGapValue) voiceRoundGapValue.textContent = `${seconds} 秒`;
  };
  voiceRoundGapInput?.addEventListener('input', syncVoiceRoundGapLabel);
  voiceRoundGapInput?.addEventListener('change', async () => {
    const milliseconds = Math.max(200, Math.min(5000, Math.round((Number(voiceRoundGapInput.value) || 400) / 100) * 100));
    voiceRoundGapInput.value = String(milliseconds);
    syncVoiceRoundGapLabel();
    prefs = await patchChatPrefs(chatId, { voicePerformanceBubbleGapMs: milliseconds });
    showToast('气泡间隔已保存');
  });

  container.querySelector('.cd-narration-sound-effects')?.addEventListener('change', async (e) => {
    const enabled = !!e.target.checked;
    prefs = await patchChatPrefs(chatId, {
      narrationSoundEffectsEnabled: enabled,
      ...(enabled ? {
        narrationMode: true,
        dialoguePresentationMode: true,
        voicePerformanceContinuous: true,
      } : {}),
    });
    if (enabled) {
      const continuous = container.querySelector('.cd-voice-performance-continuous');
      const gapField = container.querySelector('.cd-voice-round-gap');
      const soundMix = container.querySelector('.cd-narration-sound-mix');
      const narration = container.querySelector('.cd-narration-mode');
      const narrationUserPersonField = container.querySelector('.cd-narration-user-person-field');
      const dialogue = container.querySelector('.cd-dialogue-presentation');
      if (continuous) continuous.checked = true;
      if (gapField) gapField.hidden = false;
      if (soundMix) soundMix.hidden = false;
      if (narration) narration.checked = true;
      if (narrationUserPersonField) narrationUserPersonField.hidden = false;
      if (dialogue) dialogue.checked = true;
    } else {
      const soundMix = container.querySelector('.cd-narration-sound-mix');
      if (soundMix) soundMix.hidden = true;
    }
    showToast(enabled ? '旁白音效已开启' : '旁白音效已关闭');
  });

  const narrationSoundVolume = container.querySelector('.cd-narration-sound-volume');
  const narrationSoundVolumeValue = container.querySelector('.cd-narration-sound-volume-value');
  narrationSoundVolume?.addEventListener('input', () => {
    if (narrationSoundVolumeValue) narrationSoundVolumeValue.textContent = `${narrationSoundVolume.value}%`;
  });
  narrationSoundVolume?.addEventListener('change', async () => {
    const value = Math.max(0, Math.min(100, Math.round(Number(narrationSoundVolume.value) || 0)));
    narrationSoundVolume.value = String(value);
    prefs = await patchChatPrefs(chatId, { narrationSoundEffectsVolume: value });
  });

  const narrationBackgroundVolumeInput = container.querySelector('.cd-narration-background-volume');
  const narrationBackgroundVolumeValue = container.querySelector('.cd-narration-background-volume-value');
  narrationBackgroundVolumeInput?.addEventListener('input', () => {
    if (narrationBackgroundVolumeValue) narrationBackgroundVolumeValue.textContent = `${narrationBackgroundVolumeInput.value}%`;
  });
  narrationBackgroundVolumeInput?.addEventListener('change', async () => {
    const value = Math.max(0, Math.min(100, Math.round(Number(narrationBackgroundVolumeInput.value) || 0)));
    narrationBackgroundVolumeInput.value = String(value);
    prefs = await patchChatPrefs(chatId, { narrationBackgroundVolume: value });
  });

  container.querySelector('.cd-open-sound-library')?.addEventListener('click', () => {
    navigate('sound-library', { from: 'chat-details', chatId });
  });

  container.querySelector('.cd-open-radio')?.addEventListener('click', () => {
    navigate('radio', { characterId: partnerId, from: 'chat-details', chatId });
  });

  container.querySelector('.cd-ai-status-updates')?.addEventListener('change', async (e) => {
    const enabled = !!e.target.checked;
    const previousEnabled = allowAiStatusUpdates;
    const previousManualLocked = statusManualLocked;
    try {
      if (partnerId) {
        await setCharacterStatusPolicy(user.id, partnerId, {
          aiUpdatesAllowed: enabled,
          manualLocked: !enabled,
        });
      }
      prefs = await patchChatPrefs(chatId, { allowAiStatusUpdates: enabled });
      allowAiStatusUpdates = enabled;
      statusManualLocked = !enabled;
    } catch (error) {
      e.target.checked = previousEnabled;
      if (partnerId) {
        await setCharacterStatusPolicy(user.id, partnerId, {
          aiUpdatesAllowed: previousEnabled,
          manualLocked: previousManualLocked,
        }).catch(() => null);
      }
      await patchChatPrefs(chatId, { allowAiStatusUpdates: previousEnabled }).catch(() => null);
      showToast(`保存失败：${error?.message || error}`);
      return;
    }
    const options = container.querySelector('.cd-ai-status-options');
    if (options) options.hidden = !enabled && !allowAiPresenceUpdates;
    const meta = container.querySelector('[data-cd-group="status"] .chat-details-group-meta');
    if (meta) meta.textContent = enabled || allowAiPresenceUpdates ? 'AI 可更新' : '仅手动';
    showToast(enabled ? 'AI 公开短句更新已开启' : 'AI 公开短句更新已关闭');
  });

  container.querySelector('.cd-ai-presence-updates')?.addEventListener('change', async (e) => {
    const enabled = !!e.target.checked;
    const previousEnabled = allowAiPresenceUpdates;
    try {
      if (partnerId) {
        await setCharacterStatusPolicy(user.id, partnerId, {
          presenceUpdatesAllowed: enabled,
          presenceManualLocked: !enabled,
        });
      }
      prefs = await patchChatPrefs(chatId, { allowAiPresenceUpdates: enabled });
      allowAiPresenceUpdates = enabled;
    } catch (error) {
      e.target.checked = previousEnabled;
      if (partnerId) {
        await setCharacterStatusPolicy(user.id, partnerId, {
          presenceUpdatesAllowed: previousEnabled,
          presenceManualLocked: !previousEnabled,
        }).catch(() => null);
      }
      await patchChatPrefs(chatId, { allowAiPresenceUpdates: previousEnabled }).catch(() => null);
      showToast(`保存失败：${error?.message || error}`);
      return;
    }
    const options = container.querySelector('.cd-ai-status-options');
    if (options) options.hidden = !enabled && !allowAiStatusUpdates;
    const meta = container.querySelector('[data-cd-group="status"] .chat-details-group-meta');
    if (meta) meta.textContent = enabled || allowAiStatusUpdates ? 'AI 可更新' : '仅手动';
    showToast(enabled ? 'AI 在线状态更新已开启' : 'AI 在线状态更新已关闭');
  });

  container.querySelector('.cd-manual-status-save')?.addEventListener('click', async () => {
    const input = container.querySelector('.cd-manual-status-line');
    const text = String(input?.value || '').trim().slice(0, 40);
    const presenceInput = container.querySelector('.cd-manual-presence-state');
    const presenceState = ['online', 'busy', 'offline'].includes(presenceInput?.value)
      ? presenceInput.value
      : 'online';
    if (!partnerId) return;
    try {
      await setManualCharacterStatus(user.id, partnerId, { text, presenceState }, {
        sourceChatId: chatId,
        lockAiUpdates: !allowAiStatusUpdates,
        lockPresenceUpdates: !allowAiPresenceUpdates,
      });
      prefs = await patchChatPrefs(chatId, {
        allowAiStatusUpdates,
        allowAiPresenceUpdates,
        presenceState,
        statusText: text,
        statusSource: 'manual',
        statusUpdatedAt: Date.now(),
        statusExpiresAt: 0,
      });
      statusManualLocked = !allowAiStatusUpdates;
      manualPresenceState = presenceState;
    } catch (error) {
      showToast(`保存失败：${error?.message || error}`);
      return;
    }
    const options = container.querySelector('.cd-ai-status-options');
    if (options) options.hidden = !allowAiStatusUpdates && !allowAiPresenceUpdates;
    const meta = container.querySelector('[data-cd-group="status"] .chat-details-group-meta');
    if (meta) meta.textContent = allowAiStatusUpdates || allowAiPresenceUpdates ? 'AI 可更新' : '仅手动';
    const presenceLabel = { online: '在线', busy: '忙碌', offline: '离线' }[presenceState];
    showToast(allowAiStatusUpdates
      ? `状态已设为${presenceLabel}，后续可由角色更新`
      : `状态已设为${presenceLabel}`);
  });

  container.querySelector('.cd-manual-status-clear')?.addEventListener('click', async () => {
    if (!partnerId) return;
    const presenceInput = container.querySelector('.cd-manual-presence-state');
    const presenceState = ['online', 'busy', 'offline'].includes(presenceInput?.value)
      ? presenceInput.value
      : manualPresenceState;
    try {
      await setManualCharacterStatus(user.id, partnerId, { text: '', presenceState }, {
        sourceChatId: chatId,
        lockAiUpdates: !allowAiStatusUpdates,
        lockPresenceUpdates: !allowAiPresenceUpdates,
      });
      prefs = await patchChatPrefs(chatId, {
        allowAiStatusUpdates,
        allowAiPresenceUpdates,
        presenceState,
        statusText: '',
        statusSource: 'manual',
        statusUpdatedAt: Date.now(),
        statusExpiresAt: 0,
      });
      statusManualLocked = !allowAiStatusUpdates;
      manualPresenceState = presenceState;
    } catch (error) {
      showToast(`清空失败：${error?.message || error}`);
      return;
    }
    const input = container.querySelector('.cd-manual-status-line');
    if (input) input.value = '';
    const options = container.querySelector('.cd-ai-status-options');
    if (options) options.hidden = !allowAiStatusUpdates && !allowAiPresenceUpdates;
    const meta = container.querySelector('[data-cd-group="status"] .chat-details-group-meta');
    if (meta) meta.textContent = allowAiStatusUpdates || allowAiPresenceUpdates ? 'AI 可更新' : '仅手动';
    showToast(allowAiStatusUpdates ? '公开短句已清空，后续可由角色更新' : '公开短句已清空');
  });

  container.querySelector('.cd-ai-status-schedule-override')?.addEventListener('change', async (e) => {
    const enabled = !!e.target.checked;
    prefs = await patchChatPrefs(chatId, { allowAiStatusScheduleOverride: enabled });
    if (partnerId) {
      await setCharacterStatusPolicy(user.id, partnerId, {
        sceneScheduleOverrideAllowed: enabled,
      }).catch(() => null);
    }
    if (!enabled && partnerId) {
      await import('../core/character-effective-state.js')
        .then((mod) => mod.clearCharacterRuntimeScheduleOverride?.(user.id, partnerId))
        .catch(() => {});
    }
    showToast(enabled ? '实时状态可以覆盖日程' : '实时状态不再覆盖日程');
  });

  container.querySelector('.cd-status-story-mode')?.addEventListener('change', async (e) => {
    const enabled = !!e.target.checked;
    prefs = await patchChatPrefs(chatId, { statusStoryMode: enabled });
    showToast(enabled ? '状态小剧场已开启' : '状态小剧场已关闭');
  });

  container.querySelector('.cd-chat-image-gen')?.addEventListener('change', async (e) => {
    const enabled = !!e.target.checked;
    prefs = await patchChatPrefs(chatId, { chatImageGenEnabled: enabled });
    showToast(enabled ? '本会话已允许 AI 生图' : '本会话已关闭 AI 生图');
  });

  container.querySelector('.cd-sticker-vision')?.addEventListener('change', async (e) => {
    const enabled = !!e.target.checked;
    prefs = await patchChatPrefs(chatId, { stickerVisionEnabled: enabled });
    const gifRow = container.querySelector('.cd-sticker-gif-first-frame');
    const gifInput = container.querySelector('.cd-sticker-gif-first-frame-input');
    if (gifInput) gifInput.disabled = !enabled;
    gifRow?.classList.toggle('is-disabled', !enabled);
    showToast(enabled ? '表情包识图已开启' : '表情包识图已关闭');
  });

  container.querySelector('.cd-sticker-gif-first-frame-input')?.addEventListener('change', async (e) => {
    const enabled = !!e.target.checked;
    prefs = await patchChatPrefs(chatId, { stickerGifFirstFrameEnabled: enabled });
    showToast(enabled ? 'GIF 识图将只发送第一帧' : 'GIF 识图将发送原图');
  });

  const syncEmoteFieldVisibility = () => {
    const allow = !!container.querySelector('.cd-allow-ai-react')?.checked;
    const kind = String(container.querySelector('.cd-ai-react-kind')?.value || AI_REACT_KIND_EMOJI).trim();
    const reactFields = container.querySelector('.cd-emote-react-fields');
    const emojiFields = container.querySelector('.cd-emote-emoji-fields');
    const kaomojiFields = container.querySelector('.cd-emote-kaomoji-fields');
    if (reactFields) reactFields.hidden = !allow;
    if (emojiFields) emojiFields.hidden = !allow || kind !== AI_REACT_KIND_EMOJI;
    if (kaomojiFields) kaomojiFields.hidden = !allow || kind !== AI_REACT_KIND_KAOMOJI;
    const meta = container.querySelector('[data-cd-group="emote"] .chat-details-group-meta');
    if (meta) {
      meta.textContent = chatEmoteSettingsMeta({
        allowAiReact: allow,
        aiReactKind: kind,
        aiReactFrequency: container.querySelector('.cd-ai-react-frequency')?.value,
        stickerFrequency: container.querySelector('.cd-sticker-frequency')?.value,
        inlineEmoteFrequency: container.querySelector('.cd-inline-emote-frequency')?.value,
        preferSafeEmoji: !!container.querySelector('.cd-prefer-safe-emoji')?.checked,
      });
    }
  };

  container.querySelector('.cd-sticker-frequency')?.addEventListener('change', async (e) => {
    const frequency = String(e.target.value || EXPRESSION_FREQUENCY_NORMAL).trim();
    prefs = await patchChatPrefs(chatId, { stickerFrequency: frequency });
    syncEmoteFieldVisibility();
    showToast('表情包频率已保存');
  });

  container.querySelector('.cd-inline-emote-frequency')?.addEventListener('change', async (e) => {
    const frequency = String(e.target.value || EXPRESSION_FREQUENCY_NORMAL).trim();
    prefs = await patchChatPrefs(chatId, { inlineEmoteFrequency: frequency });
    syncEmoteFieldVisibility();
    showToast('正文表情频率已保存');
  });

  container.querySelector('.cd-ai-react-frequency')?.addEventListener('change', async (e) => {
    const frequency = String(e.target.value || EXPRESSION_FREQUENCY_NORMAL).trim();
    prefs = await patchChatPrefs(chatId, { aiReactFrequency: frequency });
    syncEmoteFieldVisibility();
    showToast('贴表情频率已保存');
  });

  container.querySelector('.cd-allow-ai-react')?.addEventListener('change', async (e) => {
    const enabled = !!e.target.checked;
    prefs = await patchChatPrefs(chatId, { allowAiReact: enabled });
    syncEmoteFieldVisibility();
    showToast(enabled ? '已允许 TA 贴表情' : '已关闭 TA 贴表情');
  });

  container.querySelector('.cd-ai-react-kind')?.addEventListener('change', async (e) => {
    const kind = String(e.target.value || AI_REACT_KIND_EMOJI).trim() === AI_REACT_KIND_KAOMOJI
      ? AI_REACT_KIND_KAOMOJI
      : AI_REACT_KIND_EMOJI;
    prefs = await patchChatPrefs(chatId, { aiReactKind: kind });
    syncEmoteFieldVisibility();
    showToast(kind === AI_REACT_KIND_KAOMOJI ? '贴表情改为颜文字' : '贴表情改为 emoji');
  });

  container.querySelector('.cd-prefer-safe-emoji')?.addEventListener('change', async (e) => {
    const enabled = !!e.target.checked;
    prefs = await patchChatPrefs(chatId, { preferSafeEmoji: enabled });
    syncEmoteFieldVisibility();
    showToast(enabled ? '已优先使用安全 emoji' : '已关闭安全 emoji 优先');
  });

  container.querySelector('[data-manage-kaomoji]')?.addEventListener('click', () => {
    openTextEditorModal({
      title: '管理颜文字',
      value: kaomojiLibrary.join('\n'),
      placeholder: '每行一个，也可用 、 或 | 分隔',
      multiline: true,
      confirmLabel: '保存',
      variant: anonEditorVariant(),
      onSave: async (text) => {
        const next = parseKaomojiImportText(text);
        const saved = await saveKaomojiLibrary(next);
        showToast(`已保存 ${saved.length} 个颜文字`);
        await rerenderKeepScroll(container, params);
      },
    });
  });

  container.querySelector('[data-go-stickers]')?.addEventListener('click', () => {
    navigate('stickers');
  });

  container.querySelector('.cd-weibo-allow-stickers')?.addEventListener('change', async (event) => {
    if (!partnerId) return;
    const row = await getCharacter(partnerId, { userId: user.id });
    if (!row) {
      showToast('角色不存在');
      return;
    }
    const enabled = !!event.target.checked;
    await saveCharacterForUser(
      user.id,
      { ...row, id: partnerId, weiboAllowStickers: enabled },
      { forceOverride: true },
    );
    showToast(enabled ? '已允许 TA 在微博发表情包' : 'TA 的微博表情包已关闭');
  });

  container.querySelectorAll('.cd-bound-sticker-pack').forEach((box) => {
    box.addEventListener('change', async () => {
      if (!partnerId) return;
      const row = await getCharacter(partnerId, { userId: user.id });
      if (!row) {
        showToast('角色不存在');
        return;
      }
      const ids = [...container.querySelectorAll('.cd-bound-sticker-pack')]
        .filter((el) => el.checked)
        .map((el) => String(el.getAttribute('data-pack-id') || '').trim())
        .filter(Boolean);
      const next = { ...row, id: partnerId };
      delete next.boundStickerPackId;
      if (ids.length) next.boundStickerPackIds = ids;
      else delete next.boundStickerPackIds;
      await saveCharacterForUser(user.id, next, { forceOverride: true });
      showToast(ids.length ? `已绑定 ${ids.length} 个表情包分组` : '已解除全部表情包绑定');
    });
  });

  container.querySelector('.cd-varied-rhythm')?.addEventListener('change', async (e) => {
    const enabled = !!e.target.checked;
    prefs = await patchChatPrefs(chatId, { variedRhythmReply: enabled });
    showToast(enabled ? '错落节奏已开启' : '错落节奏已关闭');
  });

  container.querySelector('.cd-prompt-profile')?.addEventListener('change', async (e) => {
    const profile = String(e.target.value || 'v2');
    prefs = await patchChatPrefs(chatId, promptProfilePrefsPatch(profile));
    const label = profile === 'full' ? '全量版' : (profile === 'lightweight' ? '轻量版' : 'V2 优化版');
    showToast(`已切换到${label}`);
  });

  container.querySelector('.cd-bubble-range-enabled')?.addEventListener('change', async (e) => {
    const enabled = !!e.target.checked;
    const fields = container.querySelector('.cd-bubble-range-fields');
    if (fields) fields.hidden = !enabled;
    const range = normalizeChatBubbleRange({
      bubbleRangeMin: container.querySelector('.cd-bubble-range-min')?.value,
      bubbleRangeMax: container.querySelector('.cd-bubble-range-max')?.value,
    });
    prefs = await patchChatPrefs(chatId, {
      bubbleRangeEnabled: enabled,
      ...(enabled ? { bubbleRangeMin: range.min, bubbleRangeMax: range.max } : {}),
    });
    showToast(enabled ? '已限定每轮气泡条数' : '已取消气泡条数限定');
  });

  const saveBubbleRange = async () => {
    const minEl = container.querySelector('.cd-bubble-range-min');
    const maxEl = container.querySelector('.cd-bubble-range-max');
    const range = normalizeChatBubbleRange({
      bubbleRangeMin: minEl?.value,
      bubbleRangeMax: maxEl?.value,
    });
    const { min, max } = range;
    if (minEl) minEl.value = String(min);
    if (maxEl) maxEl.value = String(max);
    prefs = await patchChatPrefs(chatId, { bubbleRangeMin: min, bubbleRangeMax: max });
  };
  container.querySelector('.cd-bubble-range-min')?.addEventListener('change', saveBubbleRange);
  container.querySelector('.cd-bubble-range-max')?.addEventListener('change', saveBubbleRange);

  container.querySelector('.cd-parallel-world')?.addEventListener('change', async (e) => {
    const enabled = !!e.target.checked;
    // Parallel-world and long-distance both define "why we can't meet"; keep only one active.
    const patch = { parallelWorldMode: enabled };
    if (enabled && prefs.longDistanceMode === true) {
      patch.longDistanceMode = false;
      const other = container.querySelector('.cd-long-distance');
      if (other) other.checked = false;
    }
    prefs = await patchChatPrefs(chatId, patch);
    showToast(enabled ? '平行世界模式已开启：网络一线牵，各自安好' : '平行世界模式已关闭');
  });

  container.querySelector('.cd-long-distance')?.addEventListener('change', async (e) => {
    const enabled = !!e.target.checked;
    const patch = { longDistanceMode: enabled };
    if (enabled && prefs.parallelWorldMode === true) {
      patch.parallelWorldMode = false;
      const other = container.querySelector('.cd-parallel-world');
      if (other) other.checked = false;
    }
    prefs = await patchChatPrefs(chatId, patch);
    showToast(enabled ? '异地模式已开启：分隔两地，来日方长' : '异地模式已关闭');
  });

  container.querySelector('.cd-dialogue-presentation')?.addEventListener('change', async (e) => {
    const enabled = !!e.target.checked;
    const patch = { dialoguePresentationMode: enabled };
    if (!enabled && prefs.narrationMode === true) {
      patch.narrationMode = false;
      const narrationToggle = container.querySelector('.cd-narration-mode');
      const narrationUserPersonField = container.querySelector('.cd-narration-user-person-field');
      if (narrationToggle) narrationToggle.checked = false;
      if (narrationUserPersonField) narrationUserPersonField.hidden = true;
    }
    prefs = await patchChatPrefs(chatId, patch);
    showToast(enabled ? '对话表现模式已开启：剧情默认在气泡里走' : '对话表现模式已关闭');
  });

  container.querySelector('.cd-narration-mode')?.addEventListener('change', async (e) => {
    const enabled = !!e.target.checked;
    const patch = { narrationMode: enabled };
    if (enabled && prefs.dialoguePresentationMode !== true) {
      patch.dialoguePresentationMode = true;
      const dialogueToggle = container.querySelector('.cd-dialogue-presentation');
      if (dialogueToggle) dialogueToggle.checked = true;
    }
    prefs = await patchChatPrefs(chatId, patch);
    const narrationUserPersonField = container.querySelector('.cd-narration-user-person-field');
    if (narrationUserPersonField) narrationUserPersonField.hidden = !enabled;
    showToast(enabled ? '旁白模式已开启' : '旁白模式已关闭');
  });

  container.querySelector('.cd-narration-user-person')?.addEventListener('change', async (e) => {
    const value = normalizeNarrationUserPerson(e.target.value);
    e.target.value = value;
    prefs = await patchChatPrefs(chatId, { narrationUserPerson: value });
    showToast('旁白用户人称已保存');
  });

  container.querySelector('.cd-timezone-enabled')?.addEventListener('change', async (e) => {
    const enabled = !!e.target.checked;
    const fields = container.querySelector('.cd-timezone-fields');
    if (fields) fields.hidden = !enabled;
    let nextCharacterTimezone = normalizeTimezoneId(prefs.characterTimezone, '');
    if (enabled && !nextCharacterTimezone) {
      nextCharacterTimezone = resolveCharacterTimezone({}, partner);
    }
    prefs = await patchChatPrefs(chatId, {
      timezoneEnabled: enabled,
      characterTimezone: nextCharacterTimezone,
    });
    if (enabled && nextCharacterTimezone) {
      const select = container.querySelector('.cd-character-timezone');
      if (select) select.value = nextCharacterTimezone;
    }
    showToast(enabled ? '时差已开启' : '时差已关闭');
    refreshTimezonePreview();
  });

  container.querySelector('.cd-character-timezone')?.addEventListener('change', async (e) => {
    const tz = normalizeTimezoneId(e.target.value, '');
    e.target.value = tz;
    prefs = await patchChatPrefs(chatId, { characterTimezone: tz });
    showToast(tz ? '角色时区已保存' : '已清除角色时区');
    refreshTimezonePreview();
  });

  function refreshTimezonePreview() {
    const preview = container.querySelector('.cd-timezone-preview');
    if (!preview) return;
    const text = buildTimezoneSettingsPreview(
      prefs,
      user,
      partner,
      Date.now(),
      { userTimezone },
    );
    if (text) {
      preview.textContent = text;
      preview.hidden = false;
    } else {
      preview.textContent = '';
      preview.hidden = true;
    }
  }

  container.querySelector('.cd-inner-voice-disabled')?.addEventListener('change', async (e) => {
    const disabled = !!e.target.checked;
    const hiddenInput = container.querySelector('.cd-inner-voice-hidden');
    const injectInput = container.querySelector('.cd-inner-voice-inject-enabled');
    const inlineInput = container.querySelector('.cd-ivc-inline-enabled');
    const countInput = container.querySelector('.cd-inner-voice-inject-count');
    if (hiddenInput) hiddenInput.disabled = disabled;
    if (injectInput) injectInput.disabled = disabled;
    if (inlineInput) inlineInput.disabled = disabled;
    if (countInput) countInput.disabled = disabled || prefs.innerVoiceInjectEnabled === false;
    prefs = await patchChatPrefs(chatId, { innerVoiceDisabled: disabled });
    showToast(disabled ? '心声已关闭' : '心声已开启');
  });

  container.querySelector('.cd-inner-voice-hidden')?.addEventListener('change', async (e) => {
    const hidden = !!e.target.checked;
    prefs = await patchChatPrefs(chatId, { innerVoiceHidden: hidden });
    showToast(hidden ? '心声已隐藏' : '心声已显示');
  });

  container.querySelector('.cd-inner-voice-inject-enabled')?.addEventListener('change', async (e) => {
    const enabled = !!e.target.checked;
    const countInput = container.querySelector('.cd-inner-voice-inject-count');
    if (countInput) countInput.disabled = prefs.innerVoiceDisabled === true || !enabled;
    prefs = await patchChatPrefs(chatId, { innerVoiceInjectEnabled: enabled });
    showToast(enabled ? '原心声读取已开启' : '原心声读取已关闭');
  });

  container.querySelector('.cd-inner-voice-inject-count')?.addEventListener('change', async (e) => {
    const count = normalizeInnerVoiceInjectCount(e.target.value);
    e.target.value = String(count);
    prefs = await patchChatPrefs(chatId, { innerVoiceInjectCount: count });
    showToast('原心声参考条数已保存');
  });

  container.querySelector('.cd-see-user-avatar')?.addEventListener('change', async (e) => {
    const enabled = !!e.target.checked;
    prefs = await patchChatPrefs(chatId, { seeUserAvatar: enabled });
    showToast(enabled ? '已开启：换头像后 TA 会看到一次' : '已关闭：不再把你的头像给 TA 看');
  });

  container.querySelector('[data-edit-announcement]')?.addEventListener('click', () => {
    openTextEditorModal({
      title: '群公告',
      value: announcement,
      multiline: true,
      variant: anonEditorVariant(),
      onSave: async (text) => {
        chat.groupSettings = { ...(chat.groupSettings || {}), announcement: text };
        await saveChat(chat);
        showToast('群公告已保存');
        await rerenderKeepScroll(container, params);
      },
    });
  });

  container.querySelector('[data-add-group-todo]')?.addEventListener('click', () => {
    openTextEditorModal({
      title: '群待办',
      placeholder: '例如：周五前确认线下集合时间',
      multiline: false,
      variant: anonEditorVariant(),
      onSave: async (text) => {
        const body = String(text || '').trim();
        if (!body) return;
        const todos = Array.isArray(chat.groupSettings?.todos) ? [...chat.groupSettings.todos] : [];
        todos.unshift({ id: todoId(), text: body, done: false, createdAt: Date.now() });
        chat.groupSettings = { ...(chat.groupSettings || {}), todos: todos.slice(0, 20) };
        await saveChat(chat);
        showToast('群待办已添加');
        await rerenderKeepScroll(container, params);
      },
    });
  });

  container.querySelectorAll('.cd-group-todo-toggle').forEach((input) => {
    input.addEventListener('change', async () => {
      const id = input.getAttribute('data-todo-id');
      const todos = (Array.isArray(chat.groupSettings?.todos) ? chat.groupSettings.todos : []).map((item) => (
        String(item?.id || '') === id ? { ...item, done: !!input.checked, updatedAt: Date.now() } : item
      ));
      chat.groupSettings = { ...(chat.groupSettings || {}), todos };
      await saveChat(chat);
      showToast('群待办已更新');
      await rerenderKeepScroll(container, params);
    });
  });

  container.querySelectorAll('.cd-group-todo-delete').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-todo-id');
      const todos = (Array.isArray(chat.groupSettings?.todos) ? chat.groupSettings.todos : []).filter((item) => String(item?.id || '') !== id);
      chat.groupSettings = { ...(chat.groupSettings || {}), todos };
      await saveChat(chat);
      showToast('群待办已删除');
      await rerenderKeepScroll(container, params);
    });
  });

  container.querySelectorAll('[data-chat-app]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const app = btn.getAttribute('data-chat-app');
      if (app === 'redpacket') {
        navigate('chat/thread', { chatId, ...(anonShell ? { from: shellFrom } : {}) });
        showToast('回到聊天后点输入栏旁的 + 可发红包');
        return;
      }
      if (app === 'offline') {
        // 这个 chat 上如果还有没收纳的线下会话，直接回去继续，不再走一遍设置表单覆盖它。
        const existingSession = await import('../core/offline-session.js')
          .then((module) => module.loadOfflineSession(chatId))
          .catch(() => null);
        if (existingSession) {
          navigate('offline', { chatId });
        } else {
          const participantCount = (chat.participants || []).filter((id) => id && id !== 'user').length;
          const experienceMode = await chooseOfflineExperienceMode({
            allowAudio: participantCount === 1,
            title: '进入线下',
          });
          if (!experienceMode) return;
          navigate(experienceMode === 'audio' ? 'encounter/audio' : 'encounter/date', { chatId });
        }
        return;
      }
      if (app === 'vote') {
        navigate('chat/thread', { chatId, ...(anonShell ? { from: shellFrom } : {}) });
        showToast('回到聊天后点 + · 投票');
        return;
      }
      showToast('群应用预留中');
    });
  });

  container.querySelector('[data-invite-member]')?.addEventListener('click', async () => {
    const all = await listCharacters({ excludeAnonNpc: true });
    const existing = new Set(chat.participants || []);
    const items = all.filter((c) => c?.id && !existing.has(c.id)).map((c) => ({
      id: c.id,
      label: c.name || c.customNickname || c.id,
    })); 
    if (!items.length) { showToast('没有可邀请的角色'); return; }
    const picked = await openParticipantPicker({
      title: '邀请成员',
      items,
      searchable: true,
      multiple: true,
      confirmLabel: '邀请',
    });
    if (!Array.isArray(picked) || !picked.length) return;
    chat.participants = [...new Set([...(chat.participants || []), ...picked])];
    await saveChat(chat);
    showToast(`已邀请 ${picked.length} 位成员`);
    await rerenderKeepScroll(container, params);
  });

  container.querySelector('[data-transfer-owner]')?.addEventListener('click', async () => {
    const items = allGroupMembers
      .filter((m) => m.id && m.id !== ownerId)
      .map((m) => ({ id: m.id, label: m.name }));
    if (!items.length) {
      showToast('暂无可转让成员');
      return;
    }
    const picked = await openParticipantPicker({
      title: '群转让',
      items,
      searchable: true,
      confirmLabel: '转让',
    });
    if (!picked) return;
    const admins = (chat.groupSettings?.admins || []).filter((id) => id !== picked);
    chat.groupSettings = { ...(chat.groupSettings || {}), owner: picked, admins };
    await saveChat(chat);
    showToast('群主已转让');
    await rerenderKeepScroll(container, params);
  });

  container.querySelector('[data-leave-group]')?.addEventListener('click', async () => {
    const ok = window.confirm('退出后群会变成无你在场的旁观群，角色们会知道你退群了。确定退出？');
    if (!ok) return;
    try {
      const result = await leaveGroupAsUser(chat.id, { userId: user.id, userName: currentUserName });
      showToast(result.alreadyLeft ? '你已不在群里' : '已退出群聊');
      navigate('chat/backstage', {}, true);
    } catch (err) {
      showToast(String(err?.message || err));
    }
  });

  container.querySelector('.cd-anon-memory-mode')?.addEventListener('change', async (e) => {
    const next = String(e.target.value || 'inherit_full').trim() || 'inherit_full';
    chat.metadata = { ...(chat.metadata || {}), memoryMode: next };
    await saveChat(chat);
    showToast('匿名记忆档位已保存');
    await rerenderKeepScroll(container, params);
  });

  container.querySelector('.cd-anon-main-chat-inject')?.addEventListener('change', async (e) => {
    const next = String(e.target.value || 'separate').trim() || 'separate';
    chat.metadata = { ...(chat.metadata || {}), mainChatMemoryInject: next };
    await saveChat(chat);
    showToast('主聊天带回设置已保存');
  });

  async function openAnonymousPrivate(memberId) {
    try {
      const priv = await createAnonymousPrivateFromGroup({
        userId: user.id,
        userRow: user,
        sourceChat: chat,
        counterpartActorId: memberId,
      });
      await buildAnonymousContactEntry({
        userId: user.id,
        chat,
        actorId: memberId,
        privateChatId: priv.id,
      });
      showToast('已打开匿名私聊');
      navigate('chat/thread', { chatId: priv.id, from: 'anon' });
    } catch (err) {
      showToast(String(err?.message || '无法建立私聊'));
    }
  }

  function editMemberCard(id) {
    const cards = { ...(chat.groupSettings?.memberCards || {}) };
    openTextEditorModal({
      title: '群名片',
      value: String(cards[id] || ''),
      placeholder: '在本群里怎么称呼 TA（留空恢复本名）',
      multiline: false,
      variant: anonEditorVariant(),
      onSave: async (next) => {
        const v = String(next || '').trim();
        if (v) cards[id] = v; else delete cards[id];
        chat.groupSettings = { ...(chat.groupSettings || {}), memberCards: cards };
        await saveChat(chat);
        showToast('群名片已保存');
        await rerenderKeepScroll(container, params);
      },
    });
  }

  function editMemberTitle(id) {
    const t = { ...(chat.groupSettings?.titles || {}) };
    openTextEditorModal({
      title: '群头衔',
      value: String(t[id] || ''),
      placeholder: '给 TA 一个群头衔（留空清除）',
      multiline: false,
      variant: anonEditorVariant(),
      onSave: async (next) => {
        const v = String(next || '').trim();
        if (v) t[id] = v; else delete t[id];
        chat.groupSettings = { ...(chat.groupSettings || {}), titles: t };
        await saveChat(chat);
        showToast('群头衔已保存');
        await rerenderKeepScroll(container, params);
      },
    });
  }

  async function setMemberMuted(id, nextMuted) {
    const set = new Set(chat.groupSettings?.muted || []);
    if (nextMuted) set.add(id);
    else set.delete(id);
    chat.groupSettings = { ...(chat.groupSettings || {}), muted: [...set] };
    await saveChat(chat);
    showToast(nextMuted ? '已禁言' : '已解除禁言');
    await rerenderKeepScroll(container, params);
  }

  async function setMemberAdmin(id, nextAdmin) {
    const set = new Set(chat.groupSettings?.admins || []);
    if (nextAdmin) set.add(id);
    else set.delete(id);
    set.delete(getGroupOwnerId(chat));
    chat.groupSettings = { ...(chat.groupSettings || {}), admins: [...set] };
    await saveChat(chat);
    showToast(nextAdmin ? '已设为管理员' : '已取消管理员');
    await rerenderKeepScroll(container, params);
  }

  async function removeMember(id) {
    chat.participants = (chat.participants || []).filter((p) => p !== id);
    const muted = (chat.groupSettings?.muted || []).filter((m) => m !== id);
    const admins = (chat.groupSettings?.admins || []).filter((m) => m !== id);
    const cards = { ...(chat.groupSettings?.memberCards || {}) };
    const t = { ...(chat.groupSettings?.titles || {}) };
    delete cards[id];
    delete t[id];
    chat.groupSettings = { ...(chat.groupSettings || {}), muted, admins, memberCards: cards, titles: t };
    await saveChat(chat);
    // 快捷拉群同时有真实 chat 与手机侧轻量群定义。只改 chat 的话，下次从手机群入口
    // 打开会按旧 memberIds 再把人补回来；手动移除后立即把名单投影回绑定群。
    if (phoneOwnerId || chat.metadata?.phoneContactGroupId) {
      const synced = await syncPhoneContactGroupFromChat(user.id, chat, {
        ownerId: phoneOwnerId,
      }).catch(() => null);
      if (synced?.synced && (
        chat.metadata?.phoneOwnerId !== synced.ownerId
        || chat.metadata?.phoneContactGroupId !== synced.groupId
      )) {
        chat.metadata = {
          ...(chat.metadata || {}),
          phoneOwnerId: synced.ownerId,
          phoneContactGroupId: synced.groupId,
        };
        await saveChat(chat);
      }
    }
    showToast('成员已移除');
    await rerenderKeepScroll(container, params);
  }

  container.querySelector('[data-focus-member-grid]')?.addEventListener('click', () => {
    container.querySelector('.group-member-grid')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });

  container.querySelectorAll('[data-member-manage]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-member-manage');
      if (!id) return;
      const member = allGroupMembers.find((m) => m.id === id) || groupMembers.find((m) => m.id === id);
      const title = member?.name || id;
      const isOwner = id === getGroupOwnerId(chat);
      const isAdmin = (chat.groupSettings?.admins || []).includes(id);
      const isMuted = (chat.groupSettings?.muted || []).includes(id);
      const actions = [];
      if (anonShell && id !== 'user') {
        actions.push(
          { label: '匿名私聊', onClick: () => openAnonymousPrivate(id) },
          {
            label: '保存匿名联系人',
            onClick: async () => {
              await buildAnonymousContactEntry({ userId: user.id, chat, actorId: id });
              showToast('已保存匿名联系人');
            },
          },
        );
      }
      if (!anonShell) {
        if (member?.isLightweightNpc) {
          actions.push({
            label: '加入通讯录',
            onClick: async () => {
              if (!window.confirm(`把「${title}」加入通讯录？\n\n群聊记录与成员身份会原样保留。`)) return;
              try {
                await promoteLightweightNpcToCharacter(id);
                showToast(`已把「${title}」加入通讯录`);
                await rerenderKeepScroll(container, params);
              } catch (err) {
                showToast(`加入失败：${err?.message || err}`);
              }
            },
          });
        }
        actions.push({ label: '编辑群名片', onClick: () => editMemberCard(id) });
      }
      actions.push(
        { label: '编辑群头衔', onClick: () => editMemberTitle(id) },
        { label: isMuted ? '解除禁言' : '禁言', onClick: () => setMemberMuted(id, !isMuted) },
      );
      if (!isOwner) {
        actions.push(
          { label: isAdmin ? '取消管理员' : '设为管理员', onClick: () => setMemberAdmin(id, !isAdmin) },
          { label: '移除成员', variant: 'danger', onClick: () => removeMember(id) },
        );
      }
      openChatRowSheet({ chatTitle: title, actions });
    });
  });

  container.querySelector('.cd-observer-mode')?.addEventListener('change', async (e) => {
    const next = !!e.target.checked;
    if (next && (chat.participants || []).includes('user')) {
      const ok = window.confirm('开启旁观后你将退出群聊，群会变成无你在场的旁观群。确定？');
      if (!ok) {
        e.target.checked = false;
        return;
      }
      try {
        await leaveGroupAsUser(chat.id, { userId: user.id, userName: currentUserName });
        showToast('已转为旁观群');
        navigate('chat/backstage', {}, true);
      } catch (err) {
        e.target.checked = false;
        showToast(String(err?.message || err));
      }
      return;
    }
    if (!next && !(chat.participants || []).includes('user')) {
      const ok = window.confirm('关闭旁观后你将加入这个群聊，群内会显示入群提示。确定？');
      if (!ok) {
        e.target.checked = true;
        return;
      }
      try {
        const joined = await promoteBackstageChatToGroup(chat.id, {
          userName: currentUserName,
          source: 'observer-toggle',
        });
        if (!joined?.participants?.includes('user')) throw new Error('加入群聊失败');
        showToast('已加入群聊');
        navigate('chat/thread', { chatId: chat.id }, true);
        invalidateKeepAlive('chat/thread', { chatId: chat.id });
      } catch (err) {
        e.target.checked = true;
        showToast(String(err?.message || err));
      }
      return;
    }
    chat.groupSettings = { ...(chat.groupSettings || {}), isObserverMode: next };
    await saveChat(chat);
    showToast('旁观者模式已更新');
  });
  container.querySelector('.cd-all-muted')?.addEventListener('change', async (e) => {
    chat.groupSettings = { ...(chat.groupSettings || {}), allMuted: !!e.target.checked };
    await saveChat(chat);
    if (chat.groupSettings.allMuted) await unscheduleChatLazy(chat.id);
    else if (chat.autoActive) await scheduleChatLazy(chat);
    showToast('全员禁言已更新');
  });
  container.querySelector('.cd-ai-group-ops')?.addEventListener('change', async (e) => {
    chat.groupSettings = { ...(chat.groupSettings || {}), allowAiGroupOps: !!e.target.checked };
    await saveChat(chat);
    showToast('AI 群管设置已保存');
  });

  container.querySelectorAll('.cd-linkage-member').forEach((input) => {
    input.addEventListener('change', async () => {
      const ids = [...container.querySelectorAll('.cd-linkage-member:checked')].map((el) => el.getAttribute('data-member-id')).filter(Boolean);
      prefs = await patchChatPrefs(chatId, { privateLinkageIds: ids });
      chat.groupSettings = { ...(chat.groupSettings || {}), linkagePrivateMemberIds: ids };
      await saveChat(chat);
      showToast('联动白名单已保存');
    });
  });

  const hydrateMemoryStats = async () => {
    const nextSummaryStatus = await getChatSummaryStatus({ chatId, userId: user.id })
      .catch(() => ({ coveredCount: 0, totalCount: 0, uncoveredCount: 0, firstUncoveredIndex: 0, memoryCount: 0 }));
    const page = container.querySelector('.chat-details-scroll');
    if (!page || String(page.dataset.chatDetailsId || '') !== chatId) return;

    memoryCount = Math.max(0, Number(nextSummaryStatus.memoryCount || 0) || 0);
    summaryStatus = nextSummaryStatus || summaryStatus;
    memoryStatsPending = false;
    hasUncoveredSummary = Number(summaryStatus.uncoveredCount || 0) > 0;
    defaultSummaryFrom = hasUncoveredSummary
      ? Math.max(1, Number(summaryStatus.firstUncoveredIndex || 1) || 1)
      : (summaryStatus.totalCount ? 1 : 0);

    const memoryStat = container.querySelector('.cd-memory-stat');
    if (memoryStat) memoryStat.textContent = `本会话 ${memoryCount} 条记忆`;
    const summaryProgress = container.querySelector('.cd-summary-progress');
    if (summaryProgress) {
      summaryProgress.innerHTML = `已总结 <strong>${Number(summaryStatus.coveredCount || 0)}</strong> / ${Number(summaryStatus.totalCount || 0)} 条消息`;
    }

    const total = Math.max(0, Number(summaryStatus.totalCount || 0) || 0);
    const range = container.querySelector('.cd-summary-range');
    const selection = container.querySelector('.cd-summary-selection');
    if (range) range.hidden = total <= 0;
    if (selection) selection.hidden = total <= 0;
    if (summaryFromInput) {
      summaryFromInput.max = String(Math.max(1, total));
      summaryFromInput.value = String(defaultSummaryFrom || 1);
    }
    if (summaryToInput) {
      summaryToInput.max = String(Math.max(1, total));
      summaryToInput.value = String(Math.max(1, total));
    }
    refreshSummarySelection();

    const summaryButton = container.querySelector('.cd-generate-summary');
    if (summaryButton) {
      summaryButton.disabled = !hasUncoveredSummary;
      summaryButton.textContent = hasUncoveredSummary ? '总结所选范围' : '暂无新增消息';
    }
    const extractButton = container.querySelector('.cd-extract-shared-memory');
    if (extractButton) extractButton.disabled = total <= 0;
  };
  const scheduleIdleWork = (work, timeout = 1200) => {
    const run = () => {
      if (!container.isConnected) return;
      Promise.resolve().then(() => work()).catch((error) => {
        console.warn('[chat-details] idle hydration failed', error);
      });
    };
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(run, { timeout });
    } else {
      window.setTimeout(run, 180);
    }
  };
  if (openCdGroups.has('memory')) {
    scheduleIdleWork(hydrateMemoryStats);
  }
  if (showChatSpark && !isGroup && !anonShell) {
    scheduleIdleWork(async () => {
      const nextSparkStats = await computeSparkStatsForChat(chatId).catch(() => null);
      const page = container.querySelector('.chat-details-scroll');
      if (!nextSparkStats || !page || String(page.dataset.chatDetailsId || '') !== chatId) return;
      const stat = container.querySelector('[data-chat-spark-stat]');
      if (!stat) return;
      stat.textContent = `🔥 已聊 ${Number(nextSparkStats.activeDays || 0)} 天${Number(nextSparkStats.streak || 0) > 1 ? ` · 连续 ${Number(nextSparkStats.streak)} 天` : ''}`;
      stat.hidden = false;
    });
  }
}
