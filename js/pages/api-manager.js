import { back, navigate } from '../core/router.js';
import { downloadBlob } from '../core/native-download.js';
import { isNativeShell } from '../core/native-update-bridge.js';
import { openFilePicker } from '../core/open-file-picker.js';
import * as api from '../core/api.js';
import { loadWebSearchConfig, saveWebSearchConfig } from '../core/web-search-tools.js';
import { loadAmapConfig, saveAmapConfig } from '../core/amap-tools.js';
import {
  MEITUAN_COUPON_VENUE_URL,
  loadMeituanCouponReminderConfig,
  saveMeituanCouponReminderConfig,
} from '../core/meituan-coupon-reminder.js';
import { listCharacters } from '../core/character-store.js';
import { ensureDefaultUser } from '../core/user-slot.js';
import { isSelectableContactCharacter } from '../models/character.js';
import {
  fetchRealisticImageModelsWithError,
  loadImageToolConfig,
  saveImageToolConfig,
  testRealisticImageGeneration,
  testNovelAiImageGeneration,
  NOVELAI_MODELS,
  NOVELAI_SIZE_OPTIONS,
  REALISTIC_SIZE_OPTIONS,
} from '../core/image-generation-tools.js';
import { listImageStylePresets, listScenePresets } from '../core/image-style-presets.js';
import {
  clearVoiceCache,
  createVoicePlaybackUrl,
  DEFAULT_VOICE_TOOL_CONFIG,
  deleteVoiceCachedAudio,
  getVoiceCacheStats,
  listVoiceCacheEntries,
  loadVoiceToolConfig,
  saveVoiceToolConfig,
} from '../core/voice-tools.js';
import { exportCachedVoicePayload } from '../core/voice-audio-export.js';
import {
  audioFromGestureOrNew,
  captureMediaGesture,
} from '../core/media-playback.js';
import {
  FISH_AUDIO_API_KEYS_URL,
  FISH_AUDIO_OFFICIAL_SITE_URL,
  isKnownUnofficialFishAudioSite,
  normalizeFishAudioEndpoint,
  testFishAudioConnectivity,
} from '../core/fish-audio-connectivity.js';
import {
  DEFAULT_VOICE_INPUT_CONFIG,
  VOICE_INPUT_MODEL_PREFERENCES,
  fetchVoiceInputModels,
  formatVoiceInputError,
  isBrowserSpeechSupported,
  loadVoiceInputConfig,
  requestMicrophonePermission,
  saveVoiceInputConfig,
  startVoiceInputSession,
} from '../core/companion/voice-input.js';
import {
  API_SECTIONS,
  applyComboPreset,
  buildSnapshotFromState,
  deleteComboPreset,
  deleteSectionPreset,
  exportApiSettingsPayload,
  importApiSettingsPayload,
  loadAllActiveConfigs,
  loadPresetLibrary,
  saveComboPreset,
  saveSectionPreset,
  applySectionPreset,
  applySnapshot,
  findMatchingSectionPreset,
  getActiveCombo,
  resolveSectionActiveDisplay,
  setActiveSectionPreset,
  syncAllSectionActivePresets,
  syncSectionActivePreset,
  summarizeCombo,
} from '../core/api-presets.js';
import { icon } from '../components/svg-icons.js';
import { showToast } from '../components/toast.js';
import { renderWeiboHotDebugPanel, bindWeiboHotDebugPanel } from '../core/weibo/weibo-hot-debug.js';
import { loadSocialLinkConfig, saveSocialLinkConfig } from '../core/social-link-tools.js';
import { testSocialLinkResolve } from '../core/social-link-resolver.js';
import { isWebSnapshotSupported } from '../core/native-web-snapshot.js';
import {
  listSearchCallLog, summarizeSearchCallLog, searchLogDayKey, reasonLabel,
} from '../core/search-usage-log.js';
import {
  captureScrollerTop,
  lockScrollerToVerticalAxis,
  restoreScrollerTop,
} from '../core/scroll-state.js';
import {
  loadSupportConfig,
  saveSupportConfig,
} from '../core/support/support-config.js';
import {
  listSupportModels,
  testSupportConnection,
} from '../core/support/support-client.js';
import { saveSupportIncident } from '../core/support/support-context.js';
import { generationErrorFromCatch } from '../core/generation-error-guide.js';
import { showGenerationErrorReport } from '../components/generation-error-report.js';
import { listApiRequestStats } from '../core/debug-log.js';
import {
  DEFAULT_EMBEDDING_CONFIG,
  filterEmbeddingModelNames,
  isRerankerModelName,
  saveEmbeddingConfig,
  testEmbeddingConnection,
} from '../core/embedding-tools.js';

const TABS = [
  { id: 'llm', label: '模型' },
  { id: 'embedding', label: '向量' },
  { id: 'search', label: '搜索' },
  { id: 'map', label: '地图' },
  { id: 'life', label: '生活' },
  { id: 'voice', label: '语音' },
  { id: 'image', label: '生图' },
  { id: 'support', label: '助手' },
  { id: 'profiles', label: '组合' },
];

const VOICE_TTS_MODEL_OPTIONS = [
  { value: 'speech-2.8-hd', label: 'speech-2.8-hd' },
  { value: 'speech-2.8-turbo', label: 'speech-2.8-turbo' },
  { value: 'speech-2.6-hd', label: 'speech-2.6-hd' },
  { value: 'speech-2.6-turbo', label: 'speech-2.6-turbo' },
  { value: 'speech-02-hd', label: 'speech-02-hd' },
  { value: 'speech-02-turbo', label: 'speech-02-turbo' },
];

const FISH_TTS_MODEL_OPTIONS = [
  { value: 's2.1-pro-free', label: 'S2.1 Pro Free' },
  { value: 's2.1-pro', label: 'S2.1 Pro' },
  { value: 's2-pro', label: 'S2 Pro' },
  { value: 's1', label: 's1' },
];

const VOICE_LANGUAGE_BOOST_OPTIONS = [
  ['auto', '自动识别'],
  ['Chinese', '普通话'],
  ['Chinese,Yue', '粤语'],
  ['English', '英语'],
  ['Japanese', '日语'],
  ['Korean', '韩语'],
];

const API_BASE_URL_HINT = '填根地址即可，不用加 /v1；例如 https://api.xxx.com';
const SILICONFLOW_EMBEDDING_ENDPOINT = 'https://api.siliconflow.cn';

function hasOpenAiVersionSuffix(value = '') {
  try {
    const url = new URL(String(value || '').trim());
    return url.pathname.replace(/\/+$/, '') === '/v1';
  } catch (_) {
    return /\/v1\/?$/i.test(String(value || '').trim());
  }
}

function needsOpenAiBaseUrlCleanup(config = {}) {
  return String(config.endpointType || 'openai').toLowerCase() === 'openai'
    && hasOpenAiVersionSuffix(config.baseUrl);
}

function voiceEndpointForRegion(region = '') {
  if (region === 'china') return 'https://api.minimaxi.com';
  if (region === 'uw') return 'https://api-uw.minimax.io';
  return 'https://api.minimax.io';
}

function embeddingProviderForEndpoint(value = '') {
  const endpoint = String(value || '').replace(/\/+$/, '').trim().toLowerCase();
  return endpoint === SILICONFLOW_EMBEDDING_ENDPOINT ? 'siliconflow' : 'custom';
}

function isKnownVoiceEndpoint(value = '') {
  const text = String(value || '').replace(/\/+$/, '').trim();
  return ['global', 'china', 'uw'].some((region) => voiceEndpointForRegion(region) === text);
}

function esc(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function boolAttr(value) {
  return value ? 'checked' : '';
}

function getInput(container, selector, fallback = '') {
  const el = container.querySelector(selector);
  return el ? String(el.value ?? '').trim() : fallback;
}

function blockKnownUnofficialFishEndpoint(container) {
  const endpoint = container.querySelector('.api-fish-endpoint');
  if (!endpoint || !isKnownUnofficialFishAudioSite(endpoint.value)) return false;
  showToast('已阻止：fishaudio.org 不是 Fish Audio 官方站，请使用 api.fish.audio');
  endpoint.focus();
  endpoint.select?.();
  return true;
}

function getNumber(container, selector, fallback = 0, min = -Infinity, max = Infinity) {
  return clampNumber(getInput(container, selector, fallback), min, max, fallback);
}

function getChecked(container, selector) {
  return !!container.querySelector(selector)?.checked;
}

function mask(value = '') {
  const text = String(value || '').trim();
  if (!text) return '未填写';
  if (text.length <= 8) return '已填写';
  return `${text.slice(0, 4)}…${text.slice(-3)}`;
}

function formatBytesLabel(bytes = 0) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 面板标题旁的「?」教程入口：点了跳教程页对应章节，不占正文空间。 */
function helpBtn(section, label = '') {
  const title = label ? `${label}说明` : '说明';
  return `<button type="button" class="api-help-btn" data-tutorial-section="${esc(section)}" aria-label="${esc(title)}" title="${esc(title)}">${icon('help')}</button>`;
}

function panelHead(title, trailing = '', helpSection = '') {
  return `
    <div class="api-panel-header">
      <h3>${esc(title)}</h3>
      <div class="api-panel-header-actions">
        ${helpSection ? helpBtn(helpSection, title) : ''}
        ${trailing}
      </div>
    </div>
  `;
}

function field({ label, input, hint = '', target = '', className = '' }) {
  return `
    <label class="api-field${className ? ` ${esc(className)}` : ''}"${target ? ` data-support-target="${esc(target)}"` : ''}>
      <span class="api-field-label">${esc(label)}</span>
      ${input}
      ${hint ? `<small>${esc(hint)}</small>` : ''}
    </label>
  `;
}

function textInput(cls, value = '', attrs = '') {
  return `<input type="text" class="form-input ${cls}" value="${esc(value)}" ${attrs} />`;
}

function passwordInput(cls, value = '', attrs = '') {
  return `<input type="password" class="form-input ${cls}" value="${esc(value)}" autocomplete="off" ${attrs} />`;
}

function numberInput(cls, value = '', attrs = '') {
  return `<input type="number" class="form-input ${cls}" value="${esc(value)}" ${attrs} />`;
}

function textareaInput(cls, value = '', rows = 4, attrs = '') {
  return `<textarea class="form-input ${cls}" rows="${rows}" ${attrs}>${esc(value)}</textarea>`;
}

function toggleInput(cls, checked, label = '启用') {
  return `
    <label class="api-toggle">
      <input type="checkbox" class="${cls}" ${boolAttr(checked)} />
      <span>${esc(label)}</span>
    </label>
  `;
}

function renderModelSelectRow(selectClass, fetchClass) {
  return `
    <div class="api-model-select-row">
      <select class="form-input ${selectClass}" disabled>
        <option value="">拉取后可从列表选择</option>
      </select>
      <button type="button" class="btn btn-outline btn-sm ${fetchClass}">${icon('search')}拉取模型</button>
    </div>
  `;
}

function bindModelSelect(container, selectSelector, inputSelector) {
  const select = container.querySelector(selectSelector);
  select?.addEventListener('change', () => {
    const model = String(select.value || '').trim();
    const input = container.querySelector(inputSelector);
    if (input && model) {
      input.value = model;
      showToast(`已选择：${model}`);
    }
  });
}

function fillModelSelect(select, models = [], current = '') {
  if (!select) return;
  const list = Array.isArray(models) ? models.filter(Boolean) : [];
  const cur = String(current || '').trim();
  select.innerHTML = [
    '<option value="">选择模型…</option>',
    ...list.map((m) => `<option value="${esc(m)}"${m === cur ? ' selected' : ''}>${esc(m)}</option>`),
  ].join('');
  select.disabled = !list.length;
}

function renderActivePresetBadge(library, sectionId, config = {}) {
  const display = resolveSectionActiveDisplay(library, sectionId, config);
  const name = String(display?.name || '').trim() || '未绑定预设';
  const isPresetLike = ['preset', 'combo-ref', 'combo-snapshot', 'matched'].includes(display?.kind);
  if (isPresetLike) {
    const suffix = display.kind === 'combo-snapshot' ? '（快照组合）' : '';
    return `<span class="api-active-preset">正在使用：${esc(name)}${suffix}</span>`;
  }
  if (display.kind === 'scene-follow') {
    return `<span class="api-active-preset api-active-preset--custom">跟随聊天模型</span>`;
  }
  if (display.kind === 'model') {
    return `<span class="api-active-preset api-active-preset--custom">未绑定预设 · ${esc(name)}</span>`;
  }
  return `<span class="api-active-preset api-active-preset--custom">${esc(name)}</span>`;
}

function resolveSectionActivePresetId(library, sectionId, config = {}) {
  const display = resolveSectionActiveDisplay(library, sectionId, config);
  if (display.kind === 'combo-ref') {
    return String(getActiveCombo(library)?.refs?.[sectionId] || '').trim();
  }
  if (['preset', 'matched'].includes(display.kind)) {
    const activeId = String(library?.activeSectionPresetIds?.[sectionId] || '').trim();
    if (activeId) return activeId;
    return findMatchingSectionPreset(library, sectionId, config)?.id || '';
  }
  return '';
}

function renderSectionPresetBlock(sectionId, library, label, config = {}) {
  const presets = library?.sectionPresets?.[sectionId] || [];
  const activePresetId = resolveSectionActivePresetId(library, sectionId, config);
  const display = resolveSectionActiveDisplay(library, sectionId, config);
  const displayName = String(display?.name || '').trim();
  const headHint = display?.kind === 'combo-snapshot' && displayName
    ? `快照组合：${displayName}`
    : (activePresetId && displayName ? `正在使用：${displayName}` : (displayName || '未绑定预设'));
  return `
    <div class="api-section-presets" data-section-presets="${esc(sectionId)}">
      <div class="api-section-presets-head">
        <strong>${esc(label)} 预设</strong>
        <span class="text-hint">${presets.length} 套 · ${esc(headHint)}</span>
      </div>
      <div class="api-profile-save-row">
        <input type="text" class="form-input api-section-preset-name" placeholder="预设名称" />
        <button type="button" class="btn btn-outline btn-sm api-section-preset-save" data-section="${esc(sectionId)}">保存</button>
      </div>
      <div class="api-profile-list">
        ${presets.length ? presets.map((preset) => `
          <article class="api-profile-item${preset.id === activePresetId ? ' is-active' : ''}" data-section-preset-id="${esc(preset.id)}" data-section="${esc(sectionId)}">
            <div>
              <strong>${esc(preset.name)}${preset.id === activePresetId ? '<span class="api-preset-active-tag">使用中</span>' : ''}</strong>
              <small>${esc(new Date(preset.updatedAt || preset.createdAt || 0).toLocaleDateString('zh-CN'))}</small>
            </div>
            <div class="api-profile-actions">
              <button type="button" class="btn btn-outline btn-sm api-section-preset-apply">应用</button>
              <button type="button" class="btn btn-outline btn-sm api-section-preset-delete">删除</button>
            </div>
          </article>
        `).join('') : '<div class="api-empty">暂无</div>'}
      </div>
    </div>
  `;
}

function renderTabs(activeTab) {
  return `
    <nav class="api-manager-tabs" aria-label="API 分类">
      ${TABS.map((tab) => `
        <button type="button" class="api-manager-tab ${activeTab === tab.id ? 'is-active' : ''}" data-api-tab="${tab.id}">
          ${esc(tab.label)}
        </button>
      `).join('')}
    </nav>
  `;
}

const MODEL_CALL_OPERATION_LABELS = {
  'chat-round': '聊天回复',
  chatSummary: '聊天摘要',
  memoryFacts: '记忆整理',
  searchRefine: '搜索润色',
  memeExplain: '梗图解释',
  materialCompress: '素材压缩',
  characterFill: '角色资料补全',
  translationRepair: '外语翻译补全',
  capabilityRoute: 'MCP 工具选择',
  'api-probe-stream': '接口测试（流式）',
  'api-probe-nonstream': '接口测试（一次性）',
  'character-phone-messages': '角色手机记录生成',
  'character-phone-moments': '角色手机动态生成',
  'character-phone-intercept': '角色手机拦截箱生成',
  'daily-schedule-generation': '日程生成',
  'daily-schedule-auto': '后台自动生成日程',
  'blocked-contact-alternative': '拉黑后的站外联系',
  'user-intercept-auto': '陌生消息自动生成',
  'user-intercept-alias-reuse': '陌生消息续写',
  'moments-posts': '朋友圈动态生成',
  'moments-reactions': '朋友圈互动生成',
  'weibo-posts': '微博新帖生成',
  'weibo-batch-comments': '微博评论生成',
  'event-slot-weibo': '微博事件联动',
  'forum-posts': '论坛帖子生成',
  'forum-replies': '论坛楼层生成',
  'offline-beat': '线下剧情生成',
  'offline-reroll': '线下重生成',
  'offline-guided-revision': '线下指导重修',
  'offline-expert-revision': '线下专家会诊',
  'offline-continuation': '线下断点续写',
  offlineEditorialAudit: '线下补审重写',
  'offline-required-html-extension-repair': '线下格式补全',
};

const MODEL_CALL_TRIGGER_LABELS = {
  'schedule-proactive': '按日程主动',
  'share-impulse-proactive': '主动分享',
  'memo-proactive': '备忘主动提醒',
  'fixed-fallback': '固定间隔兜底',
  'user-advance': '用户推进',
  'user-reroll': '用户重生成',
};

function modelCallOperationLabel(entry = {}) {
  const audit = entry.audit || {};
  if (audit.proactiveChannel === 'schedule') return '按日程主动';
  if (audit.proactiveChannel === 'share-impulse') return '主动分享';
  if (audit.proactiveChannel === 'memo') return '备忘主动提醒';
  if (audit.proactiveChannel === 'fixed-fallback') return '固定间隔兜底';
  if (audit.proactiveChannel === 'blocked-contact') return '拉黑后的站外联系';
  return MODEL_CALL_OPERATION_LABELS[audit.operation]
    || MODEL_CALL_TRIGGER_LABELS[audit.trigger]
    || audit.operation
    || '模型调用';
}

function formatModelCallDuration(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return '';
  if (value < 1000) return `${Math.round(value)} ms`;
  return `${Math.round(value / 100) / 10} s`;
}

function renderModelCallAuditBlock(entries = []) {
  if (entries == null) {
    return `
      <details class="api-panel api-model-audit">
        <summary>
          <span>模型调用记录</span>
          <em>正在读取…</em>
        </summary>
      </details>`;
  }
  const allEntries = Array.isArray(entries) ? entries : [];
  const list = allEntries.slice(0, 80);
  const todayKey = new Date().toDateString();
  const today = allEntries.filter((entry) => new Date(Number(entry.at || 0)).toDateString() === todayKey);
  const logicalRoundIds = new Set(today.map((entry) => entry.audit?.logicalRoundId).filter(Boolean));
  const groupMembers = new Map();
  for (const entry of list) {
    const groupId = String(entry.audit?.logicalRoundId || entry.correlationId || '');
    if (!groupMembers.has(groupId)) groupMembers.set(groupId, []);
    groupMembers.get(groupId).push(entry);
  }
  for (const rows of groupMembers.values()) rows.sort((a, b) => Number(a.at || 0) - Number(b.at || 0));
  const rows = list.map((entry) => {
    const audit = entry.audit || {};
    const time = new Date(Number(entry.at || 0));
    const timeLabel = Number.isNaN(time.getTime())
      ? ''
      : time.toLocaleString('zh-CN', {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      });
    const actors = (audit.actorNames || []).join('、')
      || (audit.initiator === 'user'
        ? '用户操作'
        : (audit.initiator === 'background'
          ? '后台任务'
          : (audit.initiator === 'feature' ? '功能调用' : '来源未标记')));
    const groupId = String(audit.logicalRoundId || entry.correlationId || '');
    const siblings = groupMembers.get(groupId) || [entry];
    const callIndex = Math.max(0, siblings.findIndex((row) => row.correlationId === entry.correlationId)) + 1;
    const grouping = audit.logicalRoundId
      ? (siblings.length > 1 ? `同一回合 · 请求 ${callIndex}/${siblings.length}` : '单次回合')
      : '独立调用';
    const statusLabel = entry.errorKind === 'background_stream_switch'
      ? '已切换'
      : (entry.ok === false ? '失败' : '成功');
    const transportLabel = entry.viaGenerationRelay === true
      ? `${entry.requestStream === true ? '上游流式' : '上游一次性'} · 中继整包领取`
      : (entry.requestStream === true ? '流式' : '一次性');
    const meta = [
      audit.apiSection === 'tool' ? '工具模型' : audit.apiSection === 'main' ? '聊天模型' : audit.apiSection,
      entry.model,
      transportLabel,
      formatModelCallDuration(entry.durationMs),
      audit.fallbackFrom ? '工具失败后转主模型' : '',
    ].filter(Boolean).join(' · ');
    const error = entry.ok === false
      ? (entry.errorMessage || entry.errorKind || `HTTP ${entry.status || '错误'}`)
      : '';
    return `
      <div class="api-model-audit-row${entry.ok === false ? ' is-fail' : ''}">
        <div class="api-model-audit-head">
          <span>${esc(timeLabel)}</span>
          <strong>${esc(actors)}</strong>
          <b>${esc(statusLabel)}</b>
        </div>
        <div class="api-model-audit-operation">${esc(modelCallOperationLabel(entry))}<em>${esc(grouping)}</em></div>
        <div class="api-model-audit-meta">${esc(meta || '调用信息未标记')}</div>
        ${error ? `<div class="api-model-audit-error">${esc(error)}</div>` : ''}
      </div>`;
  }).join('');
  return `
    <details class="api-panel api-model-audit">
      <summary>
        <span>模型调用记录</span>
        <em>今日 ${today.length} 次请求 · ${logicalRoundIds.size || today.length} 个回合</em>
      </summary>
      <div class="api-model-audit-list">
        ${rows || '<div class="api-usage-stats-empty">还没有模型调用记录</div>'}
      </div>
    </details>`;
}

function renderLlmTab(state, library) {
  const toolTasks = { ...(api.DEFAULT_TOOL_API_CONFIG?.tasks || {}), ...(state.tool?.tasks || {}) };
  const endpointTypeSelect = (className, value = 'openai') => `
    <select class="form-input ${className}">
      <option value="openai" ${value !== 'google_gemini' && value !== 'anthropic' ? 'selected' : ''}>OpenAI 兼容</option>
      <option value="google_gemini" ${value === 'google_gemini' ? 'selected' : ''}>Google Gemini 原生</option>
      <option value="anthropic" ${value === 'anthropic' ? 'selected' : ''}>Claude 官方原生</option>
    </select>
  `;
  const samplingModeSelect = (className, value = 'auto') => `
    <select class="form-input ${className}">
      <option value="auto" ${!['temperature', 'top_p'].includes(value) ? 'selected' : ''}>自动（推荐）</option>
      <option value="temperature" ${value === 'temperature' ? 'selected' : ''}>Temperature</option>
      <option value="top_p" ${value === 'top_p' ? 'selected' : ''}>Top P</option>
    </select>
  `;
  return `
    <section class="api-panel">
      ${panelHead('聊天模型', renderActivePresetBadge(library, 'main', state.main), 'api')}
      <div class="api-form-grid">
        ${field({
          label: '接口协议',
          input: endpointTypeSelect('api-main-endpoint-type', state.main?.endpointType),
          hint: '选择官方原生协议时，API 地址可留空。',
          target: 'main.endpointType',
        })}
        ${field({
          label: 'API 地址',
          input: textInput('api-main-base', state.main?.baseUrl || '', 'placeholder="https://api.xxx.com"'),
          hint: API_BASE_URL_HINT,
          target: 'main.baseUrl',
        })}
        ${field({ label: 'API 密钥', input: passwordInput('api-main-key', state.main?.apiKey || ''), hint: `当前：${mask(state.main?.apiKey)}`, target: 'main.apiKey' })}
        ${field({
          label: '模型',
          input: `${textInput('api-main-model', state.main?.model || '')}${renderModelSelectRow('api-main-model-select', 'api-fetch-main-models')}`,
          target: 'main.model',
        })}
        ${field({
          label: '采样方式',
          input: samplingModeSelect('api-main-sampling-mode', state.main?.samplingMode),
          hint: '自动模式下 Claude 不发送采样参数，其他模型只发 Temperature。',
        })}
        ${field({ label: 'Temperature', input: numberInput('api-main-temp', Number(state.main?.temperature ?? 0.8), 'min="0" max="2" step="0.05"') })}
        ${field({ label: 'Top P', input: numberInput('api-main-top-p', Number(state.main?.topP ?? 1), 'min="0" max="1" step="0.05"') })}
        ${field({
          label: 'Max Tokens',
          input: numberInput('api-main-max', Number(state.main?.maxTokens ?? api.DEFAULT_CHAT_CONFIG.maxTokens), 'min="1" step="1"'),
          hint: '日程、朋友圈等模块单次生成量较大，默认调高以防截断；可按模型上限自行调整。',
        })}
        ${field({
          label: '输出方式',
          input: toggleInput('api-main-stream', state.main?.preferStream !== false, '流式输出'),
          hint: '影响聊天推进、语音/视频通话、陪伴等主 API 请求。关闭后改为非流式一次性返回；工具模型可单独设置。',
          target: 'main.preferStream',
        })}
        ${field({
          label: '兼容模式',
          input: toggleInput('api-main-single-user', state.main?.singleUserCompat === true, '将 system 合并到首条 user'),
          hint: '仅兼容不接受 system 的中转；会保留多轮对话，默认关闭。识图消息不受影响。',
          target: 'main.singleUserCompat',
        })}
        ${field({
          label: '结构化输出',
          input: toggleInput('api-main-structure-strengthening', state.main?.structureStrengthening === true, '结构强化'),
          hint: '微博、朋友圈、论坛等掉格式时开启；首轮加强 JSON 校验，不会额外调用。',
          target: 'main.structureStrengthening',
        })}
        ${field({
          label: '回复加速',
          input: toggleInput('api-main-context-prewarm', state.main?.contextPrewarmEnabled === true, '预热聊天上下文'),
          hint: '默认关闭。开启后会提前在本地拼接下一轮上下文，回复可能更快，但大资料库或部分手机可能卡顿、发热或重载。',
          target: 'main.contextPrewarmEnabled',
        })}
        ${field({
          label: '推理强度',
          input: `
            <select class="form-input api-main-reasoning-effort">
              <option value="" ${!state.main?.reasoningEffort ? 'selected' : ''}>跟随模型</option>
              <option value="none" ${state.main?.reasoningEffort === 'none' ? 'selected' : ''}>关闭（none）</option>
              <option value="minimal" ${state.main?.reasoningEffort === 'minimal' ? 'selected' : ''}>极低（minimal）</option>
              <option value="low" ${state.main?.reasoningEffort === 'low' ? 'selected' : ''}>低（low）</option>
            </select>
          `,
          hint: 'Gemini 2.5 Flash 可关闭原生推理；2.5 Pro / Gemini 3 通常只能降低。需要中转支持 reasoning_effort。',
        })}
      </div>
      <div class="api-actions">
        <button type="button" class="btn btn-primary btn-sm api-save-main">保存聊天模型</button>
        <button type="button" class="btn btn-outline btn-sm api-probe-nonstream">测试一次性</button>
        <button type="button" class="btn btn-outline btn-sm api-probe-stream">测试流式</button>
      </div>
      <div class="api-probe-result text-hint" role="status" aria-live="polite" hidden></div>
      ${renderSectionPresetBlock('main', library, '聊天模型', state.main)}
    </section>
    <section class="api-panel">
      ${panelHead('场景叙事', `${renderActivePresetBadge(library, 'scene', state.scene)}<button type="button" class="btn btn-outline btn-sm api-scene-copy-main">套用聊天模型</button>`, 'api')}
      <p class="api-field-hint" style="margin:0 0 8px;">线下相遇、旅行 char、时光机等长叙事专用；默认跟随聊天模型，开启后可单独指定 API 与模型。</p>
      <div class="api-form-grid">
        ${field({
          label: '单独配置',
          input: toggleInput('api-scene-custom', !!state.scene?.useCustom, '启用独立 API'),
        })}
        ${field({
          label: '接口协议',
          input: endpointTypeSelect('api-scene-endpoint-type', state.scene?.endpointType),
        })}
        ${field({
          label: 'API 地址',
          input: textInput('api-scene-base', state.scene?.baseUrl || '', 'placeholder="https://api.xxx.com"'),
          hint: API_BASE_URL_HINT,
        })}
        ${field({ label: 'API 密钥', input: passwordInput('api-scene-key', state.scene?.apiKey || ''), hint: `当前：${mask(state.scene?.apiKey)}` })}
        ${field({
          label: '模型',
          input: `${textInput('api-scene-model', state.scene?.model || '')}${renderModelSelectRow('api-scene-model-select', 'api-fetch-scene-models')}`,
        })}
        ${field({
          label: '采样方式',
          input: samplingModeSelect('api-scene-sampling-mode', state.scene?.samplingMode),
          hint: 'Temperature 与 Top P 二选一；自动最适合 Claude 兼容线路。',
        })}
        ${field({ label: 'Temperature', input: numberInput('api-scene-temp', Number(state.scene?.temperature ?? 0.9), 'min="0" max="2" step="0.05"') })}
        ${field({ label: 'Top P', input: numberInput('api-scene-top-p', Number(state.scene?.topP ?? 1), 'min="0" max="1" step="0.05"') })}
        ${field({
          label: 'Max Tokens',
          input: numberInput('api-scene-max', Number(state.scene?.maxTokens ?? api.DEFAULT_SCENE_API_CONFIG.maxTokens), 'min="1" step="1"'),
          hint: '日程、朋友圈等模块单次生成量较大，默认调高以防截断；可按模型上限自行调整。',
        })}
        ${field({
          label: '输出方式',
          input: toggleInput('api-scene-stream', state.scene?.preferStream !== false, '流式输出'),
        })}
        ${field({
          label: '推理强度',
          input: `
            <select class="form-input api-scene-reasoning-effort">
              <option value="" ${!state.scene?.reasoningEffort ? 'selected' : ''}>跟随模型</option>
              <option value="none" ${state.scene?.reasoningEffort === 'none' ? 'selected' : ''}>关闭（none）</option>
              <option value="minimal" ${state.scene?.reasoningEffort === 'minimal' ? 'selected' : ''}>极低（minimal）</option>
              <option value="low" ${state.scene?.reasoningEffort === 'low' ? 'selected' : ''}>低（low）</option>
            </select>
          `,
        })}
      </div>
      <div class="api-actions">
        <button type="button" class="btn btn-primary btn-sm api-save-scene">保存场景叙事</button>
      </div>
      ${renderSectionPresetBlock('scene', library, '场景叙事', state.scene)}
    </section>
    <section class="api-panel">
      ${panelHead('工具模型', `${renderActivePresetBadge(library, 'tool', state.tool)}${toggleInput('api-tool-enabled', !!state.tool?.enabled, '启用')}`, 'api')}
      <div class="api-form-grid">
        ${field({
          label: '接口协议',
          input: endpointTypeSelect('api-tool-endpoint-type', state.tool?.endpointType),
        })}
        ${field({
          label: '工具 API 地址',
          input: textInput('api-tool-base', state.tool?.baseUrl || '', 'placeholder="https://api.xxx.com"'),
          hint: API_BASE_URL_HINT,
        })}
        ${field({ label: '工具 API 密钥', input: passwordInput('api-tool-key', state.tool?.apiKey || ''), hint: `当前：${mask(state.tool?.apiKey)}` })}
        ${field({
          label: '工具模型',
          input: `${textInput('api-tool-model', state.tool?.model || '')}${renderModelSelectRow('api-tool-model-select', 'api-fetch-tool-models')}`,
        })}
        ${field({
          label: '采样方式',
          input: samplingModeSelect('api-tool-sampling-mode', state.tool?.samplingMode),
          hint: '自动会避免 Claude 的 Temperature / Top P 冲突。',
        })}
        ${field({ label: 'Temperature', input: numberInput('api-tool-temp', Number(state.tool?.temperature ?? 0.25), 'min="0" max="2" step="0.05"') })}
        ${field({ label: 'Top P', input: numberInput('api-tool-top-p', Number(state.tool?.topP ?? 1), 'min="0" max="1" step="0.05"') })}
        ${field({
          label: '工具 Max Tokens',
          input: numberInput('api-tool-max', Number(state.tool?.maxTokens ?? api.DEFAULT_TOOL_API_CONFIG.maxTokens), 'min="1" step="1"'),
          hint: '日程、朋友圈等模块单次生成量较大，默认调高以防截断；可按模型上限自行调整。',
        })}
        ${field({
          label: '输出方式',
          input: toggleInput('api-tool-stream', state.tool?.preferStream === true, '流式输出'),
          hint: '默认关闭。开启后可在断流时保留已收到的部分；不兼容流式的中转请保持关闭。',
        })}
        ${field({
          label: '结构化输出',
          input: toggleInput('api-tool-structure-strengthening', state.tool?.structureStrengthening === true, '结构强化'),
          hint: '摘要、记忆、翻译、资料补全等掉格式时开启；不会额外调用。',
          target: 'tool.structureStrengthening',
        })}
        ${field({
          label: '缺失译文',
          input: toggleInput('api-tool-auto-translation-repair', state.tool?.autoTranslationRepair === true, '自动补译'),
          hint: '默认关闭；开启后生成结果漏译时，每个批次最多额外调用一次翻译补全模型。',
          target: 'tool.autoTranslationRepair',
        })}
      </div>
      <div class="api-task-grid">
        ${Object.entries({
          chatSummary: '聊天摘要',
          memoryFacts: '记忆事实',
          searchRefine: '搜索润色',
          memeExplain: '梗图解释',
          materialCompress: '素材压缩',
          characterFill: '角色资料补全',
          translationRepair: '外语翻译补全',
          capabilityRoute: 'MCP 工具选择',
          offlineEditorialAudit: '线下补审重写',
        }).map(([key, label]) => toggleInput(`api-tool-task-${key}`, toolTasks[key] !== false, label)).join('')}
      </div>
      <div class="api-actions">
        <button type="button" class="btn btn-primary btn-sm api-save-tool">保存工具模型</button>
      </div>
      ${renderSectionPresetBlock('tool', library, '工具模型', state.tool)}
    </section>
    ${renderModelCallAuditBlock(state.modelCallAudit)}
  `;
}

function renderEmbeddingTab(state, library) {
  const embeddingProvider = embeddingProviderForEndpoint(state.embedding?.baseUrl);
  return `
    <section class="api-panel">
      ${panelHead('向量模型', `${renderActivePresetBadge(library, 'embedding', state.embedding)}${toggleInput('api-embedding-enabled', !!state.embedding?.enabled, '启用')}`, 'memory')}
      <div class="api-form-grid">
        ${field({
          label: '服务商',
          input: `
            <select class="form-input api-embedding-provider">
              <option value="siliconflow" ${embeddingProvider === 'siliconflow' ? 'selected' : ''}>硅基流动</option>
              <option value="custom" ${embeddingProvider === 'custom' ? 'selected' : ''}>自定义</option>
            </select>
          `,
        })}
        ${field({
          label: 'API 地址',
          input: textInput('api-embedding-base', state.embedding?.baseUrl || '', 'placeholder="https://api.xxx.com"'),
          hint: '填根地址，不用加 /v1；支持 OpenAI 兼容向量接口',
        })}
        ${field({
          label: 'API 密钥',
          input: passwordInput('api-embedding-key', state.embedding?.apiKey || ''),
          hint: `当前：${mask(state.embedding?.apiKey)}`,
        })}
        ${field({
          label: 'Embedding 模型',
          input: `${textInput('api-embedding-model', state.embedding?.model || '', 'placeholder="填写或拉取模型名"')}${renderModelSelectRow('api-embedding-model-select', 'api-fetch-embedding-models')}`,
        })}
        ${field({
          label: '向量维度',
          input: numberInput('api-embedding-dimensions', Number(state.embedding?.dimensions || 0), 'min="0" step="1"'),
          hint: '填 0 则由模型决定',
        })}
      </div>
      <div class="api-actions">
        <button type="button" class="btn btn-primary btn-sm api-save-embedding">保存向量模型</button>
        <button type="button" class="btn btn-outline btn-sm api-test-embedding">测试连接</button>
      </div>
      <div class="api-embedding-result text-hint" role="status" aria-live="polite" hidden></div>
      ${renderSectionPresetBlock('embedding', library, '向量模型', state.embedding)}
    </section>
  `;
}

function renderSearchTab(state, library) {
  return `
    <section class="api-panel">
      ${panelHead('搜索', `${renderActivePresetBadge(library, 'search', state.search)}${toggleInput('api-web-enabled', !!state.search?.enabled, '启用')}`, 'search')}
      <div class="api-form-grid">
        ${field({ label: '默认 Provider', input: `
          <select class="form-input api-web-provider">
            <option value="tavily" ${state.search?.provider === 'tavily' ? 'selected' : ''}>Tavily</option>
            <option value="exa" ${state.search?.provider === 'exa' ? 'selected' : ''}>Exa</option>
            <option value="brave" ${state.search?.provider === 'brave' ? 'selected' : ''}>Brave</option>
            <option value="serpapi" ${state.search?.provider === 'serpapi' ? 'selected' : ''}>SerpAPI</option>
            <option value="searchapi" ${state.search?.provider === 'searchapi' ? 'selected' : ''}>SearchApi.io</option>
          </select>
        ` })}
        ${field({ label: 'Tavily API Key', input: passwordInput('api-tavily-key', state.search?.tavilyApiKey || ''), hint: `当前：${mask(state.search?.tavilyApiKey)}` })}
        ${field({ label: 'Exa API Key', input: passwordInput('api-exa-key', state.search?.exaApiKey || ''), hint: `当前：${mask(state.search?.exaApiKey)}` })}
        ${field({ label: 'Brave API Key', input: passwordInput('api-brave-key', state.search?.braveApiKey || ''), hint: `当前：${mask(state.search?.braveApiKey)}` })}
        ${field({ label: 'SerpAPI Key', input: passwordInput('api-serpapi-key', state.search?.serpApiKey || ''), hint: `当前：${mask(state.search?.serpApiKey)}` })}
        ${field({ label: 'SearchApi.io Key', input: passwordInput('api-searchapi-key', state.search?.searchApiKey || ''), hint: `当前：${mask(state.search?.searchApiKey)}` })}
        ${field({ label: '搜索模式', input: `
          <select class="form-input api-web-mode">
            <option value="local_plus_web" ${state.search?.mode === 'local_plus_web' ? 'selected' : ''}>本地优先 + 联网</option>
            <option value="web_only" ${state.search?.mode === 'web_only' ? 'selected' : ''}>只联网</option>
            <option value="local_only" ${state.search?.mode === 'local_only' ? 'selected' : ''}>只本地</option>
          </select>
        ` })}
        ${field({ label: '每日上限', input: numberInput('api-web-daily', Number(state.search?.dailyLimit ?? 10), 'min="0" step="1"') })}
        ${field({ label: '缓存天数', input: numberInput('api-web-cache', Number(state.search?.cacheDays ?? 3), 'min="0" step="1"') })}
        ${field({ label: '单次结果数', input: numberInput('api-web-max-results', Number(state.search?.maxResults ?? 5), 'min="1" max="20" step="1"') })}
        ${field({ label: '聊天查证每日上限', input: numberInput('api-need-search-daily', Number(state.search?.needSearchDailyLimit ?? 12), 'min="0" step="1"') })}
      </div>
      <div class="api-task-grid">
        ${toggleInput('api-provider-pool-enabled', state.search?.providerPoolEnabled !== false, '搜索池瀑布流')}
        ${toggleInput('api-need-search-enabled', state.search?.needSearchEnabled === true, '聊天联网查证')}
        ${toggleInput('api-exa-enabled', !!state.search?.exaEnabled, '并入 Exa')}
        ${toggleInput('api-brave-enabled', !!state.search?.braveEnabled, '允许 Brave')}
        ${toggleInput('api-serpapi-enabled', !!state.search?.serpApiEnabled, '允许 SerpAPI')}
        ${toggleInput('api-searchapi-enabled', !!state.search?.searchApiEnabled, '允许 SearchApi')}
        ${toggleInput('api-web-images', !!state.search?.includeImages, '搜索图片')}
        ${toggleInput('api-web-link-card', !!state.search?.enhanceLinkCards, '增强链接卡片')}
        ${toggleInput('api-web-material-curation', state.search?.materialCurationEnabled !== false, 'LLM 素材整理')}
      </div>
      <div class="api-actions">
        <button type="button" class="btn btn-primary btn-sm api-save-search">保存搜索 API</button>
      </div>
      ${renderSectionPresetBlock('search', library, '搜索', state.search)}
    </section>
    ${renderSocialLinkBlock(state.social || {})}
    ${renderMaterialSourcesNavBlock()}
    ${renderSearchUsageStatsBlock(state.searchUsageStats)}
    ${renderWeiboHotDebugPanel()}
  `;
}

/**
 * 素材来源速查：不是新面板，只是把散在各处的"抓没抓到/去哪管理"指路指清楚——
 * 具体次数/成败看下面的搜索调用统计，各来源自己的详细列表/开关在各自原本的位置。
 */
function renderMaterialSourcesNavBlock() {
  return `
    <section class="api-panel api-usage-stats-panel">
      ${panelHead('素材来源速查', '')}
      <div class="api-usage-stats-grid">
        <div class="api-usage-stats-row"><span>微博热搜（Tavily 抓取）</span><span>见下方"微博热搜调试"</span></div>
        <div class="api-usage-stats-row"><span>兴趣素材池 / 分享精搜</span><span>角色手机页「素材池 ▾」「今日调用 ▾」，按角色查看</span></div>
        <div class="api-usage-stats-row"><span>TA 关注你的小红书</span><span>角色手机页对应开关区，可手动「立即看一次」</span></div>
      </div>
      <p class="text-hint" style="font-size:11px;line-height:1.4;margin:6px 0 0;">具体抓取次数、成败原因看下方"搜索调用统计"按来源展开。</p>
    </section>
  `;
}

const SEARCH_USAGE_CATEGORY_LABEL = {
  interest_orchestrator: '兴趣自动轮转',
  interest_social: '兴趣自动轮转 · 社媒',
  interest_manual: '兴趣手动补充',
  interest_split: '大类词裂变',
  interest_xhs: '兴趣 · 小红书',
  share_post_search: '分享帖精搜 · 搜列表',
  share_post_detail: '分享帖精搜 · 取正文',
  need_search: '聊天联网查证',
  travel_char: '旅行char搜索',
  offline_date: '线下场景搜索',
  forum: '论坛素材',
  user_social_watch: 'TA 关注你的小红书',
};

function searchUsageCategoryLabel(cat = '') {
  return SEARCH_USAGE_CATEGORY_LABEL[cat] || cat || '其他';
}

function renderSearchUsageStatsBlock(stats) {
  if (stats == null) {
    return `
      <section class="api-panel api-usage-stats-panel">
        ${panelHead('搜索调用统计', '')}
        <div class="api-usage-stats-empty">正在读取…</div>
      </section>`;
  }
  const today = stats?.today || {
    total: 0, actual: 0, ok: 0, fail: 0, skipped: 0, manual: 0,
    byCategory: {}, byProvider: {}, byReason: {},
  };
  const recent = Array.isArray(stats?.recent) ? stats.recent : [];
  const categoryRows = Object.entries(today.byCategory)
    .sort((a, b) => b[1] - a[1])
    .map(([cat, count]) => `<div class="api-usage-stats-row"><span>${searchUsageCategoryLabel(cat)}</span><span>${count}</span></div>`)
    .join('') || '<div class="api-usage-stats-row api-usage-stats-empty">今天还没有调用记录</div>';
  const providerRows = Object.entries(today.byProvider)
    .sort((a, b) => b[1] - a[1])
    .map(([p, count]) => `<div class="api-usage-stats-row"><span>${p}</span><span>${count}</span></div>`)
    .join('');
  const reasonRows = Object.entries(today.byReason || {})
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => `<div class="api-usage-stats-row"><span>${esc(reasonLabel(reason) || reason)}</span><span>${count}</span></div>`)
    .join('');
  const recentRows = recent.map((e) => {
    const time = new Date(e.at);
    const hh = `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`;
    const okMark = e.ok ? '✓' : '✕';
    const reason = e.ok ? '' : (reasonLabel(e.reason) || '未记录具体原因');
    const failDetail = e.ok ? '' : [
      reason,
      e.query ? `关键词：${e.query}` : '',
      e.error,
      e.diagnostic ? `响应摘要：${e.diagnostic}` : '',
    ].filter(Boolean).join(' · ');
    return `<div class="api-usage-recent-row ${e.ok ? '' : 'is-fail'}"><span>${hh}</span><span>${searchUsageCategoryLabel(e.category)}</span><span>${e.provider || (e.reason === 'quota_exceeded' ? '未发出请求' : '')}${e.manual ? ' · 手动' : ''}</span><span>${okMark}</span>${failDetail ? `<span class="api-usage-recent-detail">${esc(failDetail)}</span>` : ''}</div>`;
  }).join('') || '<div class="api-usage-recent-row api-usage-stats-empty"><span>暂无记录</span></div>';

  return `
    <section class="api-panel api-usage-stats-panel">
      ${panelHead('搜索调用统计', '')}
      <div class="api-usage-stats-summary">
        <span>实际调用 <b>${today.actual ?? today.total}</b> 次</span>
        <span>成功 <b>${today.ok}</b></span>
        <span>失败 <b>${today.fail}</b></span>
        <span>额度跳过 <b>${today.skipped || 0}</b></span>
        <span>手动 <b>${today.manual}</b></span>
      </div>
      <details class="api-usage-stats-details">
        <summary>按来源 / 渠道展开</summary>
        <div class="api-usage-stats-grid">
          <div><div class="api-usage-stats-title">按来源</div>${categoryRows}</div>
          <div><div class="api-usage-stats-title">按渠道</div>${providerRows || '<div class="api-usage-stats-row api-usage-stats-empty">今天还没有调用记录</div>'}</div>
          <div><div class="api-usage-stats-title">按未成功原因</div>${reasonRows || '<div class="api-usage-stats-row api-usage-stats-empty">今天没有未成功记录</div>'}</div>
        </div>
        <div class="api-usage-stats-title" style="margin-top:8px;">最近调用（跨全部角色，滚动保留最近 500 条）</div>
        <div class="api-usage-recent-list">${recentRows}</div>
      </details>
    </section>
  `;
}

function renderSocialLinkBlock(cfg = {}) {
  const webviewFallbackBlock = isWebSnapshotSupported() ? `
      <div class="api-task-grid">
        ${toggleInput('api-social-webview-fallback', cfg.webviewFallbackEnabled === true, 'APK 用页面截图让角色读取分享详情')}
      </div>
      <p class="api-field-hint" style="margin:0 0 8px;">支持小红书、微博与B站。淘宝发送时只静默生成商品卡；点卡片里的“让角色看看”才会读取一次商品页。截图会发送给当前识图模型，识图成功后临时截图会清理。</p>
  ` : '';
  return `
    <section class="api-panel">
      ${panelHead('分享链接深度解析', toggleInput('api-social-enabled', !!cfg.enabled, '启用'), 'interest')}
      <div class="api-form-grid">
        ${field({
          label: 'TikHub API Key',
          input: passwordInput('api-social-key', cfg.apiKey || ''),
          hint: `当前：${mask(cfg.apiKey)} · 去 tikhub.io 注册获取自己的 Key`,
        })}
        ${field({ label: '带热评数量', input: numberInput('api-social-comment-count', Number(cfg.commentCount ?? 3), 'min="0" max="20" step="1"') })}
        ${field({ label: '缓存天数', input: numberInput('api-social-cache-days', Number(cfg.cacheDays ?? 3), 'min="1" max="30" step="1"') })}
      </div>
      <div class="api-task-grid">
        ${toggleInput('api-social-comments-enabled', cfg.includeComments === true, '带热评（额外 1 次 API）')}
      </div>
      <p class="api-field-hint" style="margin:0 0 8px;">小红书只调 1 次图文详情接口（标题/正文/封面/tag 都在同一条返回里）；开热评再多 1 次。不再调视频详情接口。</p>
      ${webviewFallbackBlock}
      <div class="api-form-grid">
        ${field({ label: '测试链接', input: textInput('api-social-test-url', '', 'placeholder="粘贴一条小红书或微博链接"') })}
      </div>
      <div class="api-actions">
        <button type="button" class="btn btn-outline btn-sm api-test-social-link">${icon('search')}测试解析</button>
        <button type="button" class="btn btn-primary btn-sm api-save-social">保存深度解析设置</button>
      </div>
      <div class="api-social-test-result" style="display:none;margin-top:10px;font-size:13px;line-height:1.5;"></div>
    </section>
  `;
}

function renderMapTab(state, library) {
  return `
    <section class="api-panel">
      ${panelHead('地图', `${renderActivePresetBadge(library, 'map', state.map)}${toggleInput('api-amap-enabled', !!state.map?.enabled, '启用')}`, 'map')}
      <div class="api-form-grid">
        ${field({ label: 'Web 服务 Key', input: passwordInput('api-amap-key', state.map?.apiKey || ''), hint: `当前：${mask(state.map?.apiKey)}` })}
        ${field({ label: 'JS API Key', input: passwordInput('api-amap-js-key', state.map?.jsApiKey || '', 'placeholder="留空则复用 Web Key"') })}
        ${field({ label: 'JS 安全密钥', input: passwordInput('api-amap-security', state.map?.securityJsCode || '') })}
        ${field({ label: '默认搜索半径', input: numberInput('api-amap-radius', Number(state.map?.radius || 1500), 'min="100" max="50000" step="100"') })}
        ${field({ label: '地图默认条数', input: numberInput('api-amap-max', Number(state.map?.maxResults || 6), 'min="1" max="20" step="1"') })}
      </div>
      <div class="api-task-grid">
        ${toggleInput('api-amap-js-enabled', state.map?.jsMapEnabled !== false, '启用 JS 地图')}
        ${toggleInput('api-amap-auto-grow', state.map?.autoGrowEnabled !== false, '角色自主选择真实地点')}
      </div>
      <div class="api-actions">
        <button type="button" class="btn btn-primary btn-sm api-save-map">保存地图 API</button>
      </div>
      ${renderSectionPresetBlock('map', library, '地图', state.map)}
    </section>
  `;
}

function renderLifeTab(state) {
  const config = state.couponReminder || {};
  const characters = Array.isArray(state.couponReminderCharacters)
    ? state.couponReminderCharacters
    : [];
  const selectedId = String(config.characterId || '').trim();
  return `
    <section class="api-panel">
      ${panelHead('美团优惠', toggleInput('api-meituan-coupon-enabled', config.enabled === true, '自然分享'), 'interest')}
      <div class="api-form-grid">
        ${field({
          label: '分享门槛',
          input: `
            <select class="form-input api-meituan-coupon-score">
              <option value="80"${Number(config.minimumOfferScore || 65) === 80 ? ' selected' : ''}>力度较大</option>
              <option value="65"${Number(config.minimumOfferScore || 65) === 65 ? ' selected' : ''}>明显优惠</option>
              <option value="45"${Number(config.minimumOfferScore || 65) === 45 ? ' selected' : ''}>一般优惠也可以</option>
            </select>
          `,
        })}
        ${field({
          label: '定时提醒角色',
          input: `
            <select class="form-input api-meituan-coupon-character">
              <option value="">选择角色</option>
              ${characters.map((character) => {
                const id = String(character.id || '').trim();
                const name = character.customNickname || character.name || '未命名角色';
                return `<option value="${esc(id)}"${id === selectedId ? ' selected' : ''}>${esc(name)}</option>`;
              }).join('')}
            </select>
          `,
        })}
        ${field({
          label: '提醒时间',
          input: `<input type="time" class="form-input api-meituan-coupon-time" value="${esc(config.time || '10:00')}" />`,
        })}
      </div>
      <div class="api-task-grid">
        ${toggleInput('api-meituan-coupon-scheduled', config.scheduledReminderEnabled === true, '每天定时提醒')}
      </div>
      <div class="api-actions">
        <button type="button" class="btn btn-primary btn-sm api-save-meituan-coupon">保存</button>
        <a class="btn btn-outline btn-sm" href="${esc(MEITUAN_COUPON_VENUE_URL)}" target="_blank" rel="noopener noreferrer">打开领券会场</a>
      </div>
      <p class="api-field-hint" style="margin:8px 0 0;">只分享接口核验过的活动；定时提醒默认关闭。</p>
    </section>
  `;
}

function renderVoiceTab(state, library) {
  const cfg = state.voice || {};
  const provider = cfg.provider === 'fish' ? 'fish' : 'minimax';
  const fish = { ...DEFAULT_VOICE_TOOL_CONFIG.fish, ...(cfg.fish || {}) };
  const cache = { ...DEFAULT_VOICE_TOOL_CONFIG.cache, ...(cfg.cache || {}) };
  const stats = state.voiceCacheStats;
  const known = VOICE_TTS_MODEL_OPTIONS.some((item) => item.value === cfg.model);
  const fishKnown = FISH_TTS_MODEL_OPTIONS.some((item) => item.value === fish.model);
  const endpointValue = String(cfg.endpoint || '').trim() || voiceEndpointForRegion(cfg.region);
  const fishEndpointValue = normalizeFishAudioEndpoint(fish.endpoint);
  const fishEndpointIsUnofficial = isKnownUnofficialFishAudioSite(fishEndpointValue);
  const fishOfficialNotice = provider === 'fish' ? `
    <div class="api-fish-official-notice${fishEndpointIsUnofficial ? ' is-warning' : ''}" role="note">
      <div>
        <strong>${fishEndpointIsUnofficial ? '当前地址不是 Fish Audio 官方站' : '只认准 Fish Audio 官方域名：fish.audio'}</strong>
        <span><code>fishaudio.org</code> 不是官方站，请勿在那里登录或充值。</span>
      </div>
      <div class="api-fish-official-links">
        <a href="${FISH_AUDIO_OFFICIAL_SITE_URL}" target="_blank" rel="noopener noreferrer">打开官网</a>
        <a href="${FISH_AUDIO_API_KEYS_URL}" target="_blank" rel="noopener noreferrer">获取官方 API Key</a>
      </div>
    </div>
  ` : '';
  const providerFields = provider === 'fish'
    ? `
      ${field({ label: '接口地址', input: textInput('api-fish-endpoint', fishEndpointValue), hint: '默认直连 Fish Audio 官方接口' })}
      ${field({ label: 'Fish Audio API Key', input: passwordInput('api-fish-key', fish.apiKey || ''), hint: `当前：${mask(fish.apiKey)}` })}
      ${field({ label: 'TTS 模型', input: `
        <select class="form-input api-fish-model-select">
          ${FISH_TTS_MODEL_OPTIONS.map((item) => `<option value="${item.value}" ${fish.model === item.value ? 'selected' : ''}>${item.label}</option>`).join('')}
          <option value="__custom" ${fishKnown ? '' : 'selected'}>自定义</option>
        </select>
        <input type="text" class="form-input api-fish-model" value="${esc(fishKnown ? '' : (fish.model || ''))}" placeholder="s2.1-pro-free" style="${fishKnown ? 'display:none;' : ''}" />
      ` })}
      ${field({ label: '温度', input: numberInput('api-fish-temperature', Number(fish.temperature ?? 0.7), 'min="0" max="1" step="0.05"') })}
      ${field({ label: 'Top P', input: numberInput('api-fish-top-p', Number(fish.topP ?? 0.7), 'min="0" max="1" step="0.05"') })}
      ${field({ label: '默认语速', input: numberInput('api-fish-speed', Number(fish.speed || 1), 'min="0.5" max="2" step="0.05"') })}
      ${field({ label: '默认音量（dB）', input: numberInput('api-fish-volume', Number(fish.volume ?? 0), 'min="-20" max="20" step="1"') })}
      ${field({ label: '分块长度', input: numberInput('api-fish-chunk-length', Number(fish.chunkLength || 300), 'min="100" max="300" step="10"') })}
      ${field({ label: '最小分块', input: numberInput('api-fish-min-chunk-length', Number(fish.minChunkLength ?? 50), 'min="0" max="100" step="5"') })}
      ${field({ label: '延迟档位', input: `
        <select class="form-input api-fish-latency">
          <option value="normal" ${fish.latency === 'normal' ? 'selected' : ''}>质量优先</option>
          <option value="balanced" ${fish.latency === 'balanced' ? 'selected' : ''}>平衡</option>
          <option value="low" ${fish.latency === 'low' ? 'selected' : ''}>低延迟</option>
        </select>
      ` })}
      ${field({ label: '音频格式', input: `
        <select class="form-input api-fish-format">
          <option value="wav" ${fish.format === 'wav' ? 'selected' : ''}>WAV（高清）</option>
          <option value="mp3" ${fish.format === 'mp3' ? 'selected' : ''}>MP3（省空间）</option>
        </select>
      ` })}
      ${field({
        label: 'MP3 码率',
        className: `api-fish-mp3-bitrate-field${fish.format === 'mp3' ? '' : ' is-hidden'}`,
        input: `
          <select class="form-input api-fish-mp3-bitrate">
            <option value="64" ${Number(fish.mp3Bitrate) === 64 ? 'selected' : ''}>64 kbps</option>
            <option value="128" ${Number(fish.mp3Bitrate) === 128 ? 'selected' : ''}>128 kbps</option>
            <option value="192" ${Number(fish.mp3Bitrate) === 192 ? 'selected' : ''}>192 kbps</option>
          </select>
        `,
      })}
    `
    : `
      ${field({ label: '接口区域', input: `
        <select class="form-input api-voice-region">
          <option value="global" ${cfg.region === 'global' ? 'selected' : ''}>Global</option>
          <option value="china" ${cfg.region === 'china' ? 'selected' : ''}>中国站</option>
          <option value="uw" ${cfg.region === 'uw' ? 'selected' : ''}>US West</option>
        </select>
      ` })}
      ${field({ label: '接口地址', input: textInput('api-voice-endpoint', endpointValue, `placeholder="${API_BASE_URL_HINT}"`) })}
      ${field({ label: '语言增强', input: `
        <select class="form-input api-voice-language">
          ${VOICE_LANGUAGE_BOOST_OPTIONS.map(([value, label]) => `<option value="${esc(value)}" ${(cfg.languageBoost || 'auto') === value ? 'selected' : ''}>${esc(label)}</option>`).join('')}
        </select>
      ` })}
      ${field({ label: 'MiniMax API Key', input: passwordInput('api-voice-key', cfg.apiKey || ''), hint: `当前：${mask(cfg.apiKey)}` })}
      ${field({ label: 'TTS 模型', input: `
        <select class="form-input api-voice-model-select">
          ${VOICE_TTS_MODEL_OPTIONS.map((item) => `<option value="${item.value}" ${cfg.model === item.value ? 'selected' : ''}>${item.label}</option>`).join('')}
          <option value="__custom" ${known ? '' : 'selected'}>自定义</option>
        </select>
        <input type="text" class="form-input api-voice-model" value="${esc(known ? '' : (cfg.model || ''))}" placeholder="speech-2.8-hd" style="${known ? 'display:none;' : ''}" />
      ` })}
      ${field({ label: '默认语速', input: numberInput('api-voice-speed', Number(cfg.speed || 1), 'min="0.5" max="2" step="0.05"') })}
      ${field({ label: '默认音量', input: numberInput('api-voice-vol', Number(cfg.vol || 1), 'min="0.1" max="10" step="0.1"') })}
      ${field({ label: '默认音调', input: numberInput('api-voice-pitch', Number(cfg.pitch || 0), 'min="-12" max="12" step="1"') })}
    `;
  return `
    <section class="api-panel">
      ${panelHead('语音', `${renderActivePresetBadge(library, 'voice', cfg)}${cfg.enabled ? '<span class="api-active-preset">已启用</span>' : '<span class="api-active-preset api-active-preset--custom">未启用</span>'}`, 'voice')}
      ${fishOfficialNotice}
      <div class="api-form-grid">
        ${field({
          label: '启用语音接口',
          input: toggleInput('api-voice-enabled', !!cfg.enabled, '启用'),
          hint: '勾选后会立刻保存；切到其他页或返回前不必再点保存。',
        })}
        ${field({ label: '语音提供商', input: `
          <select class="form-input api-voice-provider">
            <option value="minimax" ${provider === 'minimax' ? 'selected' : ''}>MiniMax</option>
            <option value="fish" ${provider === 'fish' ? 'selected' : ''}>Fish Audio</option>
          </select>
        ` })}
        ${providerFields}
        ${field({ label: '缓存上限', input: numberInput('api-voice-cache-max', Number(cache.maxEntries || 120), 'min="10" max="1000" step="10"') })}
      </div>
      <label class="api-field api-field-wide">
        <span class="api-field-label">${provider === 'fish' ? 'Fish' : 'MiniMax'} 语音世界书内容</span>
        <textarea class="form-input api-voice-style-text" rows="5" spellcheck="false" placeholder="留空使用内置指导；这里填写你的补充规则">${esc(cfg.styleBook?.text || '')}</textarea>
      </label>
      <div class="api-voice-cache-card">
        <div class="api-voice-cache-meta">
          <strong>语音缓存</strong>
          <small>${stats ? esc(`${stats.count || 0} 条 / ${formatBytesLabel(stats.totalBytes)}`) : '统计中…'}</small>
        </div>
        <div class="api-voice-cache-actions">
          ${toggleInput('api-voice-cache-enabled', cache.enabled !== false, '缓存')}
          <button type="button" class="btn btn-outline btn-sm api-manage-voice-cache">管理缓存</button>
        </div>
      </div>
      <div class="api-task-grid">
        ${toggleInput('api-voice-style-enabled', !!cfg.styleBook?.enabled, '语音世界书')}
        ${toggleInput('api-voice-natural-pauses', cfg.styleBook?.naturalPauses !== false, '自然停顿')}
        ${toggleInput('api-voice-subtle-emotion', cfg.styleBook?.subtleEmotion !== false, '轻微情绪')}
        ${provider === 'minimax' ? toggleInput('api-voice-native-emotion', cfg.styleBook?.nativeEmotion === true, '原生情绪') : ''}
        ${toggleInput('api-voice-strip-stage', cfg.styleBook?.stripStageDirections !== false, '过滤括号动作')}
        ${provider === 'fish' ? toggleInput('api-fish-normalize', fish.normalize !== false, '文本归一化') : ''}
        ${provider === 'fish' ? toggleInput('api-fish-normalize-loudness', fish.normalizeLoudness !== false, '统一响度') : ''}
        ${provider === 'fish' ? toggleInput('api-fish-condition-previous', fish.conditionOnPreviousChunks !== false, '保持分块连续') : ''}
        ${provider === 'fish' ? toggleInput('api-fish-quality-guard', fish.qualityGuard !== false, '音质保护') : ''}
        <label class="api-toggle">
          <span>停顿力度</span>
          <select class="form-input api-voice-pause-scale">
            <option value="0.75" ${Number(cfg.styleBook?.pauseScale || 1) === 0.75 ? 'selected' : ''}>紧凑</option>
            <option value="1" ${Number(cfg.styleBook?.pauseScale || 1) === 1 ? 'selected' : ''}>自然</option>
            <option value="1.25" ${Number(cfg.styleBook?.pauseScale || 1) === 1.25 ? 'selected' : ''}>松弛</option>
            <option value="1.5" ${Number(cfg.styleBook?.pauseScale || 1) === 1.5 ? 'selected' : ''}>更慢</option>
          </select>
        </label>
      </div>
      <div class="api-actions">
        <button type="button" class="btn btn-primary btn-sm api-save-voice">保存语音 API</button>
        ${provider === 'fish' ? '<button type="button" class="btn btn-outline btn-sm api-test-fish-connectivity">测试连通性</button>' : ''}
      </div>
      ${provider === 'fish' ? '<div class="api-fish-connectivity-result" role="status" aria-live="polite" hidden></div>' : ''}
      ${renderSectionPresetBlock('voice', library, '语音', cfg)}
    </section>
    ${renderSttBlock(state.voiceInput || {})}
  `;
}

function renderSttBlock(cfg = {}) {
  const browserOk = isBrowserSpeechSupported();
  const nativeImeDictation = isNativeShell();
  return `
    <section class="api-panel">
      ${panelHead('语音输入（听写）', '', 'voice')}
      ${nativeImeDictation ? '<p class="api-apk-voice-note">APK 使用输入法听写，不读取麦克风；以下接口设置仅供网页端使用。</p>' : ''}
      <div class="api-form-grid">
        ${field({ label: '识别方式', input: `
          <select class="form-input api-stt-provider">
            <option value="browser" ${cfg.provider !== 'custom' ? 'selected' : ''}>浏览器原生优先${browserOk ? '' : '（当前环境不可用）'}</option>
            <option value="custom" ${cfg.provider === 'custom' ? 'selected' : ''}>录音 + 转写接口</option>
          </select>
        `, hint: browserOk
          ? '原生听写走 Google 语音服务，需 HTTPS 且能访问 Google；不稳定时请改用下方转写接口'
          : '当前环境没有可用的原生听写（Edge/Brave 等只有接口没有识别服务），会自动走下面的转写接口' })}
        ${field({ label: '接口地址', input: textInput('api-stt-endpoint', cfg.endpoint || '', `placeholder="${API_BASE_URL_HINT}"`), hint: '需要 OpenAI 兼容的 /audio/transcriptions 转写能力' })}
        ${field({ label: 'API Key', input: passwordInput('api-stt-key', cfg.apiKey || ''), hint: `当前：${mask(cfg.apiKey)}` })}
        ${field({ label: '模型', input: `${textInput('api-stt-model', cfg.model || DEFAULT_VOICE_INPUT_CONFIG.model, 'placeholder="whisper-1"')}${renderModelSelectRow('api-stt-model-select', 'api-fetch-stt-models')}` })}
        ${field({ label: '语言', input: textInput('api-stt-language', cfg.language || 'zh', 'placeholder="zh"') })}
      </div>
      <div class="api-actions">
        <button type="button" class="btn btn-outline btn-sm api-test-stt" ${nativeImeDictation ? 'disabled title="APK 请直接使用输入法听写"' : ''}>${icon('voice')}${nativeImeDictation ? 'APK 使用输入法听写' : '测试听写'}</button>
        <button type="button" class="btn btn-primary btn-sm api-save-stt">保存语音输入</button>
      </div>
      <div class="api-stt-test-result" style="display:none;margin-top:10px;font-size:13px;line-height:1.5;"></div>
    </section>
  `;
}

function collectSttConfig(container, prev = {}) {
  const typedKey = getInput(container, '.api-stt-key');
  return {
    ...prev,
    provider: getInput(container, '.api-stt-provider', prev.provider || 'browser') || 'browser',
    endpoint: getInput(container, '.api-stt-endpoint'),
    apiKey: typedKey || prev.apiKey || '',
    model: getInput(container, '.api-stt-model', DEFAULT_VOICE_INPUT_CONFIG.model) || DEFAULT_VOICE_INPUT_CONFIG.model,
    language: getInput(container, '.api-stt-language', 'zh') || 'zh',
  };
}

function renderImageTab(state, library) {
  const cfg = state.image || {};
  return `
    <section class="api-panel">
      ${panelHead('生图', renderActivePresetBadge(library, 'image', cfg), 'image')}
      <div class="api-form-grid">
        ${field({ label: '人物图 Provider', input: `
          <select class="form-input api-image-character-provider">
            <option value="off" ${cfg.characterProvider === 'off' ? 'selected' : ''}>关闭</option>
            <option value="novelai" ${cfg.characterProvider === 'novelai' ? 'selected' : ''}>NovelAI</option>
          </select>
        ` })}
        ${field({
          label: 'NovelAI 地址',
          input: textInput('api-novelai-endpoint', cfg.novelAi?.endpoint || '', 'placeholder="本站官方部署可留空；中转填站点根或完整端点"'),
          hint: '用本站官方链接：地址留空即可（本站自带 NovelAI 直连代理），填官方 Key 就能出图。中转分两种：①官方协议中转——只填站点根（自动拼 /ai/generate-image）或粘贴完整端点；② OpenAI 兼容 NovelAI——填 https://中转/v1，中转明确给出的 /api Base URL 也可原样填写（自动补全 Images 端点）。',
        })}
        ${field({ label: 'NovelAI Key', input: passwordInput('api-novelai-key', cfg.novelAi?.apiKey || ''), hint: `当前：${mask(cfg.novelAi?.apiKey)}` })}
        ${field({
          label: 'NovelAI 模型',
          input: `${textInput('api-novelai-model', cfg.novelAi?.model || '')}
            <select class="form-input api-novelai-model-select" style="margin-top:6px;">
              <option value="">— 选择常用模型 —</option>
              ${NOVELAI_MODELS.map((m) => `<option value="${esc(m)}" ${cfg.novelAi?.model === m ? 'selected' : ''}>${esc(m)}</option>`).join('')}
            </select>`,
        })}
        ${field({
          label: 'NovelAI 尺寸',
          input: `<select class="form-input api-novelai-size">
            ${NOVELAI_SIZE_OPTIONS.map((o) => `<option value="${esc(o.value)}" ${(cfg.novelAi?.size || '832x1216') === o.value ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
          </select>`,
          hint: '固定尺寸；聊天生图也会优先使用这里的选择',
        })}
        <label class="api-field api-field-wide">
          <span class="api-field-label">NovelAI 正向提示词前缀</span>
          ${textareaInput('api-novelai-prompt-prefix', cfg.novelAi?.promptPrefix || '', 2, 'spellcheck="false" placeholder="每次生图都会拼在最前，如画风/质感 tag"')}
        </label>
        <label class="api-field api-field-wide">
          <span class="api-field-label">NovelAI 正向质量词（后缀）</span>
          ${textareaInput('api-novelai-prompt-suffix', cfg.novelAi?.promptSuffix || '', 2, 'spellcheck="false" placeholder="留空用默认：best quality, very aesthetic, masterpiece"')}
        </label>
        <label class="api-field api-field-wide">
          <span class="api-field-label">NovelAI 负面提示词</span>
          ${textareaInput('api-novelai-negative', cfg.novelAi?.negativePrompt || '', 3, 'spellcheck="false" placeholder="留空用默认负面词（去低质/坏手等）"')}
        </label>
        <label class="api-field api-field-wide">
          <span class="api-field-label">NovelAI 提示词模板（高级）</span>
          ${textareaInput('api-novelai-prompt-template', cfg.novelAi?.promptTemplate || '', 3, 'spellcheck="false" placeholder="填写则覆盖前缀/质量词；可用 {prompt} 插入本次内容"')}
        </label>
        ${field({
          label: 'NovelAI 默认画风',
          input: `<select class="form-input api-style-nai">
            <option value="" ${!(cfg.styles?.novelAiStyleId) ? 'selected' : ''}>不套用（用上方前缀/模板）</option>
            ${listImageStylePresets('novelai').filter((p) => p.id !== 'nai_custom').map((p) => `<option value="${esc(p.id)}" ${cfg.styles?.novelAiStyleId === p.id ? 'selected' : ''}>${esc(p.label)}（${esc(p.hint)}）</option>`).join('')}
          </select>`,
          hint: '内置画师串保底；角色「专属画风」会覆盖这里',
        })}
        <div class="api-actions">
          <button type="button" class="btn btn-outline btn-sm api-test-novelai">${icon('image')}测试 NovelAI</button>
        </div>
        ${field({ label: '兼容生图 Provider', input: `
          <select class="form-input api-real-provider">
            <option value="off" ${cfg.realisticProvider === 'off' ? 'selected' : ''}>关闭</option>
            <option value="openai_compatible" ${cfg.realisticProvider === 'openai_compatible' ? 'selected' : ''}>OpenAI Compatible</option>
            <option value="openai_chat" ${cfg.realisticProvider === 'openai_chat' ? 'selected' : ''}>Gemini 中转（Chat Completions）</option>
            <option value="google_gemini" ${cfg.realisticProvider === 'google_gemini' ? 'selected' : ''}>Google Gemini 原生</option>
          </select>
        ` })}
        ${field({
          label: '兼容生图地址',
          input: textInput('api-real-endpoint', cfg.realistic?.endpoint || '', 'placeholder="https://api.xxx.com"'),
          hint: '中转填根地址或 Chat Completions 地址；Gemini 原生留空则直连 Google AI Studio',
        })}
        ${field({ label: '兼容生图 Key', input: passwordInput('api-real-key', cfg.realistic?.apiKey || ''), hint: `当前：${mask(cfg.realistic?.apiKey)}` })}
        ${field({
          label: '兼容生图模型',
          input: `${textInput('api-real-model', cfg.realistic?.model || '')}${renderModelSelectRow('api-real-model-select', 'api-fetch-image-models')}`,
        })}
        ${field({
          label: '兼容生图尺寸',
          input: `<select class="form-input api-real-size">
            ${REALISTIC_SIZE_OPTIONS.map((o) => `<option value="${esc(o.value)}" ${(cfg.realistic?.size || '1024x1024') === o.value ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
          </select>`,
          hint: '固定尺寸；聊天生图也会优先使用这里的选择',
        })}
        ${field({
          label: '图片返回方式',
          input: `<select class="form-input api-real-response-format">
            <option value="" ${!cfg.realistic?.responseFormat ? 'selected' : ''}>自动（兼容优先）</option>
            <option value="url" ${cfg.realistic?.responseFormat === 'url' ? 'selected' : ''}>链接优先（弱网推荐）</option>
            <option value="b64_json" ${cfg.realistic?.responseFormat === 'b64_json' ? 'selected' : ''}>Base64（单次直传）</option>
          </select>`,
          hint: '仅 OpenAI Images 生效；长响应常断线时选“链接优先”',
        })}
        <label class="api-field api-field-wide">
          <span class="api-field-label">兼容生图提示词模板</span>
          ${textareaInput('api-real-prompt-template', cfg.realistic?.promptTemplate || '', 5, 'spellcheck="false" placeholder="留空使用系统默认；可用 {prompt} 插入本次内容"')}
          <span class="api-field-hint">填写后聊天与测试均用模板包裹 {prompt}，不再叠加默认无脸生活图规则；可与「兼容人物画风」档位叠加。</span>
        </label>
        <label class="api-field api-field-wide">
          <span class="api-field-label">兼容生图负面提示词</span>
          ${textareaInput('api-real-negative', cfg.realistic?.negativePrompt || '', 3, 'spellcheck="false" placeholder="留空不附加；填写后每次生图都会追加 Avoid 引导"')}
        </label>
        ${field({
          label: '兼容人物画风',
          input: `<select class="form-input api-style-real-person">
            <option value="" ${!(cfg.styles?.realisticPersonStyleId) ? 'selected' : ''}>关（人物仍是无脸生活图）</option>
            ${listImageStylePresets('realistic').map((p) => `<option value="${esc(p.id)}" ${cfg.styles?.realisticPersonStyleId === p.id ? 'selected' : ''}>${esc(p.label)}（${esc(p.hint)}）</option>`).join('')}
          </select>`,
          hint: '选「自定义」或档位后，兼容引擎画人物可露脸，画风含日系/韩系/2.5D 等；不强制真人。写实/摄影质感由预设与保底提供。「自定义」只用你自己写的外观描述。生活证据图不受影响。角色「专属画风」会覆盖这里',
        })}
        ${field({
          label: '朋友圈/匿名空间/微博画风滤镜',
          input: `<select class="form-input api-style-scene">
            <option value="" ${!(cfg.styles?.sceneStyleId) ? 'selected' : ''}>不限定（跟随角色外观/默认画质）</option>
            ${listScenePresets().map((p) => `<option value="${esc(p.id)}" ${cfg.styles?.sceneStyleId === p.id ? 'selected' : ''}>${esc(p.label)}（${esc(p.hint)}）</option>`).join('')}
          </select>`,
          hint: '朋友圈生成前的弹窗可以单独覆盖这里；旅行创建未选手动风格时也会回落这里；线下场景滤镜在自己页面选',
        })}
        ${field({
          label: '聊天生图引擎',
          input: (() => {
            const sc = ['novelai', 'realistic', 'smart'].includes(cfg.scenes?.chatImages) ? cfg.scenes.chatImages : 'smart';
            return `<select class="form-input api-scene-chat-provider">
              <option value="smart" ${sc === 'smart' ? 'selected' : ''}>人物用 NovelAI，其余用兼容生图</option>
              <option value="novelai" ${sc === 'novelai' ? 'selected' : ''}>全部 NovelAI</option>
              <option value="realistic" ${sc === 'realistic' ? 'selected' : ''}>全部兼容生图</option>
            </select>`;
          })(),
          hint: '聊天里角色发图用哪个引擎',
        })}
        ${field({
          label: '朋友圈生图引擎',
          input: (() => {
            const sc = ['novelai', 'realistic', 'smart'].includes(cfg.scenes?.momentsImages) ? cfg.scenes.momentsImages : (cfg.scenes?.chatImages || 'smart');
            return `<select class="form-input api-scene-moments-provider">
              <option value="smart" ${sc === 'smart' ? 'selected' : ''}>人物用 NovelAI，其余用兼容生图</option>
              <option value="novelai" ${sc === 'novelai' ? 'selected' : ''}>全部 NovelAI</option>
              <option value="realistic" ${sc === 'realistic' ? 'selected' : ''}>全部兼容生图</option>
            </select>`;
          })(),
        })}
        ${field({
          label: '微博生图引擎',
          input: (() => {
            const sc = ['novelai', 'realistic', 'smart'].includes(cfg.scenes?.weiboImages) ? cfg.scenes.weiboImages : (cfg.scenes?.chatImages || 'smart');
            return `<select class="form-input api-scene-weibo-provider">
              <option value="smart" ${sc === 'smart' ? 'selected' : ''}>人物用 NovelAI，其余用兼容生图</option>
              <option value="novelai" ${sc === 'novelai' ? 'selected' : ''}>全部 NovelAI</option>
              <option value="realistic" ${sc === 'realistic' ? 'selected' : ''}>全部兼容生图</option>
            </select>`;
          })(),
        })}
        ${field({
          label: '线下场景生图引擎',
          input: (() => {
            const sc = ['novelai', 'realistic', 'smart'].includes(cfg.scenes?.offlineScene) ? cfg.scenes.offlineScene : 'smart';
            return `<select class="form-input api-scene-offline-provider">
              <option value="smart" ${sc === 'smart' ? 'selected' : ''}>人物用 NovelAI，其余用兼容生图</option>
              <option value="novelai" ${sc === 'novelai' ? 'selected' : ''}>全部 NovelAI</option>
              <option value="realistic" ${sc === 'realistic' ? 'selected' : ''}>全部兼容生图</option>
            </select>`;
          })(),
          hint: '线下场景未在叙事设置里单独选择时使用',
        })}
        ${field({
          label: '旅行明信片生图引擎',
          input: (() => {
            const sc = ['novelai', 'realistic', 'smart'].includes(cfg.scenes?.travelImages) ? cfg.scenes.travelImages : 'realistic';
            return `<select class="form-input api-scene-travel-provider">
              <option value="realistic" ${sc === 'realistic' ? 'selected' : ''}>全部兼容生图（推荐）</option>
              <option value="smart" ${sc === 'smart' ? 'selected' : ''}>人物用 NovelAI，其余用兼容生图</option>
              <option value="novelai" ${sc === 'novelai' ? 'selected' : ''}>全部 NovelAI</option>
            </select>`;
          })(),
          hint: '旅行char明信片/途中拍照用哪个引擎；风格滤镜在旅行页里单独选',
        })}
      </div>
      <div class="api-task-grid">
        ${toggleInput('api-novelai-enabled', !!cfg.novelAi?.enabled, '启用 NovelAI')}
        ${toggleInput('api-real-enabled', !!cfg.realistic?.enabled, '启用兼容生图')}
        ${toggleInput('api-image-chat-images', !!cfg.usage?.chatImages, '聊天生图')}
        ${toggleInput('api-image-moments-images', !!cfg.usage?.momentsImages, '朋友圈生图')}
        ${toggleInput('api-image-weibo-images', !!cfg.usage?.weiboImages, '微博生图')}
        ${toggleInput('api-image-link-covers', !!cfg.usage?.linkCardCovers, '链接卡片封面')}
      </div>
      <div class="api-actions">
        <button type="button" class="btn btn-outline btn-sm api-test-image-generation">${icon('image')}测试生图</button>
        <button type="button" class="btn btn-primary btn-sm api-save-image">保存生图 API</button>
      </div>
      ${renderSectionPresetBlock('image', library, '生图', cfg)}
    </section>
  `;
}

function renderComboSectionSelects(library, state = {}) {
  const activeCombo = getActiveCombo(library);
  return API_SECTIONS.map((section) => {
    const presets = library?.sectionPresets?.[section.id] || [];
    const sectionConfig = state?.[section.id] || {};
    const display = resolveSectionActiveDisplay(library, section.id, sectionConfig);
    const activePresetId = resolveSectionActivePresetId(library, section.id, sectionConfig);
    const activePreset = presets.find((item) => item.id === activePresetId);
    const selectedId = activeCombo?.mode === 'reference'
      ? String(activeCombo.refs?.[section.id] || activePresetId || '').trim()
      : activePresetId;
    const hint = display.kind === 'combo-snapshot'
      ? `当前使用：${display.name}（快照组合）`
      : (display.kind === 'none' || display.kind === 'model'
        ? (display.kind === 'model' ? `未绑定预设 · 当前模型 ${display.name}` : '未绑定预设')
        : `当前使用：${display.name}`);
    return `
      <label class="api-field">
        <span class="api-field-label">${esc(section.label)}</span>
        <select class="form-input api-combo-ref" data-section="${esc(section.id)}">
          <option value="">不切换此项</option>
          ${presets.map((preset) => `<option value="${esc(preset.id)}"${preset.id === selectedId ? ' selected' : ''}>${esc(preset.name)}</option>`).join('')}
        </select>
        <small class="api-combo-ref-active">${esc(hint)}</small>
      </label>
    `;
  }).join('');
}

function renderProfilesTab(state, library) {
  const combos = Array.isArray(library.comboPresets) ? library.comboPresets : [];
  const activeComboId = String(library?.activeComboId || '').trim();
  return `
    <section class="api-panel">
      ${panelHead('引用组合')}
      <p class="api-field-hint" style="margin:0 0 8px;">给每个分类各自挑一套已保存的分节预设，组合成一个名字；应用后各分类会显示正在使用的预设名称。</p>
      <div class="api-form-grid">${renderComboSectionSelects(library, state)}</div>
      <div class="api-profile-save-row">
        <input type="text" class="form-input api-combo-ref-name" placeholder="组合名称" />
        <button type="button" class="btn btn-primary btn-sm api-combo-ref-save">保存</button>
      </div>
    </section>
    <section class="api-panel">
      ${panelHead('快照组合')}
      <p class="api-field-hint" style="margin:0 0 8px;">把当前所有分类的完整配置拍一张「快照」存成一套；之后改动其它设置不会影响它，适合先把整套配置存好，随时切回来。</p>
      <div class="api-profile-save-row">
        <input type="text" class="form-input api-combo-snapshot-name" placeholder="组合名称" />
        <button type="button" class="btn btn-primary btn-sm api-combo-snapshot-save">保存当前</button>
      </div>
      <div class="api-profile-list">
        ${combos.length ? combos.map((combo) => `
          <article class="api-profile-item${combo.id === activeComboId ? ' is-active' : ''}" data-combo-id="${esc(combo.id)}">
            <div>
              <strong>${esc(combo.name || '未命名')}${combo.id === activeComboId ? '<span class="api-preset-active-tag">使用中</span>' : ''}</strong>
              <small>${esc(combo.updatedAt ? new Date(combo.updatedAt).toLocaleDateString('zh-CN') : '')} · ${esc(summarizeCombo(combo, library))}</small>
            </div>
            <div class="api-profile-actions">
              <button type="button" class="btn btn-outline btn-sm api-combo-apply">应用</button>
              <button type="button" class="btn btn-outline btn-sm api-combo-delete">删除</button>
            </div>
          </article>
        `).join('') : '<div class="api-empty">暂无</div>'}
      </div>
    </section>
    <section class="api-panel">
      ${panelHead('导入 / 导出')}
      <div class="api-actions">
        <button type="button" class="btn btn-outline btn-sm api-export-settings">${icon('folder')}导出 JSON</button>
        <button type="button" class="btn btn-outline btn-sm api-import-settings">${icon('plus')}导入 JSON</button>
      </div>
    </section>
  `;
}

function renderSupportTab(state) {
  const config = state.support || {};
  return `
    <section class="api-panel">
      ${panelHead('芥末棉花糖')}
      <div class="api-form-grid">
        ${field({
          label: '启用',
          input: toggleInput('api-support-enabled', config.enabled === true, '启用芥末棉花糖 API'),
          target: 'support.enabled',
        })}
        ${field({
          label: 'API 地址',
          input: textInput('api-support-base', config.baseUrl || '', 'placeholder="https://api.xxx.com"'),
          hint: API_BASE_URL_HINT,
          target: 'support.baseUrl',
        })}
        ${field({
          label: 'API 密钥',
          input: passwordInput('api-support-key', config.apiKey || ''),
          hint: `当前：${mask(config.apiKey)}`,
          target: 'support.apiKey',
        })}
        ${field({
          label: '模型',
          input: `${textInput('api-support-model', config.model || '')}${renderModelSelectRow('api-support-model-select', 'api-fetch-support-models')}`,
          target: 'support.model',
        })}
      </div>
      <div class="api-actions">
        <button type="button" class="btn btn-primary btn-sm api-save-support">保存助手 API</button>
        <button type="button" class="btn btn-outline btn-sm api-test-support">测试连接</button>
      </div>
      <div class="api-support-result text-hint" role="status" aria-live="polite" hidden></div>
    </section>
  `;
}

function collectSupportConfig(container, prev = {}) {
  const typedKey = getInput(container, '.api-support-key');
  return {
    ...prev,
    enabled: getChecked(container, '.api-support-enabled'),
    baseUrl: getInput(container, '.api-support-base'),
    apiKey: typedKey || prev.apiKey || '',
    model: getInput(container, '.api-support-model'),
  };
}

function renderActiveTab(state, library, activeTab) {
  if (activeTab === 'embedding') return renderEmbeddingTab(state, library);
  if (activeTab === 'search') return renderSearchTab(state, library);
  if (activeTab === 'map') return renderMapTab(state, library);
  if (activeTab === 'life') return renderLifeTab(state);
  if (activeTab === 'voice') return renderVoiceTab(state, library);
  if (activeTab === 'image') return renderImageTab(state, library);
  if (activeTab === 'support') return renderSupportTab(state);
  if (activeTab === 'profiles') return renderProfilesTab(state, library);
  return renderLlmTab(state, library);
}

function collectMeituanCouponReminderConfig(container, previous = {}) {
  return {
    ...previous,
    enabled: getChecked(container, '.api-meituan-coupon-enabled'),
    scheduledReminderEnabled: getChecked(container, '.api-meituan-coupon-scheduled'),
    minimumOfferScore: Number(getInput(container, '.api-meituan-coupon-score', '65')) || 65,
    characterId: getInput(container, '.api-meituan-coupon-character'),
    time: getInput(container, '.api-meituan-coupon-time', '10:00'),
  };
}

function collectSceneConfig(container, prev = {}) {
  return {
    ...prev,
    useCustom: getChecked(container, '.api-scene-custom'),
    endpointType: getInput(container, '.api-scene-endpoint-type', 'openai') || 'openai',
    baseUrl: getInput(container, '.api-scene-base'),
    apiKey: getInput(container, '.api-scene-key'),
    model: getInput(container, '.api-scene-model'),
    samplingMode: getInput(container, '.api-scene-sampling-mode', 'auto') || 'auto',
    temperature: getNumber(container, '.api-scene-temp', 0.9, 0, 2),
    topP: getNumber(container, '.api-scene-top-p', 1, 0, 1),
    maxTokens: Math.max(1, Math.floor(getNumber(container, '.api-scene-max', api.DEFAULT_SCENE_API_CONFIG.maxTokens, 1))),
    preferStream: getChecked(container, '.api-scene-stream'),
    retryOnFailure: false,
    reasoningEffort: getInput(container, '.api-scene-reasoning-effort'),
  };
}

function collectMainConfig(container, prev = {}) {
  return {
    ...prev,
    endpointType: getInput(container, '.api-main-endpoint-type', 'openai') || 'openai',
    baseUrl: getInput(container, '.api-main-base'),
    apiKey: getInput(container, '.api-main-key'),
    model: getInput(container, '.api-main-model'),
    samplingMode: getInput(container, '.api-main-sampling-mode', 'auto') || 'auto',
    temperature: getNumber(container, '.api-main-temp', 0.8, 0, 2),
    topP: getNumber(container, '.api-main-top-p', 1, 0, 1),
    maxTokens: Math.max(1, Math.floor(getNumber(container, '.api-main-max', api.DEFAULT_CHAT_CONFIG.maxTokens, 1))),
    preferStream: getChecked(container, '.api-main-stream'),
    retryOnFailure: false,
    singleUserCompat: getChecked(container, '.api-main-single-user'),
    structureStrengthening: getChecked(container, '.api-main-structure-strengthening'),
    contextPrewarmEnabled: getChecked(container, '.api-main-context-prewarm'),
    reasoningEffort: getInput(container, '.api-main-reasoning-effort'),
  };
}

function collectToolConfig(container, prev = {}) {
  return {
    ...prev,
    enabled: getChecked(container, '.api-tool-enabled'),
    endpointType: getInput(container, '.api-tool-endpoint-type', 'openai') || 'openai',
    baseUrl: getInput(container, '.api-tool-base'),
    apiKey: getInput(container, '.api-tool-key'),
    model: getInput(container, '.api-tool-model'),
    samplingMode: getInput(container, '.api-tool-sampling-mode', 'auto') || 'auto',
    temperature: getNumber(container, '.api-tool-temp', 0.25, 0, 2),
    topP: getNumber(container, '.api-tool-top-p', 1, 0, 1),
    maxTokens: Math.max(1, Math.floor(getNumber(container, '.api-tool-max', api.DEFAULT_TOOL_API_CONFIG.maxTokens, 1))),
    preferStream: getChecked(container, '.api-tool-stream'),
    retryOnFailure: false,
    structureStrengthening: getChecked(container, '.api-tool-structure-strengthening'),
    autoTranslationRepair: getChecked(container, '.api-tool-auto-translation-repair'),
    tasks: {
      ...(prev.tasks || {}),
      chatSummary: getChecked(container, '.api-tool-task-chatSummary'),
      memoryFacts: getChecked(container, '.api-tool-task-memoryFacts'),
      searchRefine: getChecked(container, '.api-tool-task-searchRefine'),
      memeExplain: getChecked(container, '.api-tool-task-memeExplain'),
      materialCompress: getChecked(container, '.api-tool-task-materialCompress'),
      characterFill: getChecked(container, '.api-tool-task-characterFill'),
      translationRepair: getChecked(container, '.api-tool-task-translationRepair'),
      capabilityRoute: getChecked(container, '.api-tool-task-capabilityRoute'),
      offlineEditorialAudit: getChecked(container, '.api-tool-task-offlineEditorialAudit'),
    },
  };
}

function collectEmbeddingConfig(container, prev = {}) {
  const typedKey = getInput(container, '.api-embedding-key');
  return {
    ...DEFAULT_EMBEDDING_CONFIG,
    ...prev,
    enabled: getChecked(container, '.api-embedding-enabled'),
    baseUrl: getInput(container, '.api-embedding-base'),
    apiKey: typedKey || prev.apiKey || '',
    model: getInput(container, '.api-embedding-model'),
    dimensions: Math.max(0, Math.floor(getNumber(container, '.api-embedding-dimensions', 0, 0))),
  };
}

function collectSearchConfig(container, prev = {}) {
  return {
    ...prev,
    enabled: getChecked(container, '.api-web-enabled'),
    provider: getInput(container, '.api-web-provider', 'tavily') || 'tavily',
    tavilyApiKey: getInput(container, '.api-tavily-key'),
    exaApiKey: getInput(container, '.api-exa-key'),
    braveApiKey: getInput(container, '.api-brave-key'),
    serpApiKey: getInput(container, '.api-serpapi-key'),
    searchApiKey: getInput(container, '.api-searchapi-key'),
    providerPoolEnabled: getChecked(container, '.api-provider-pool-enabled'),
    exaEnabled: getChecked(container, '.api-exa-enabled'),
    braveEnabled: getChecked(container, '.api-brave-enabled'),
    serpApiEnabled: getChecked(container, '.api-serpapi-enabled'),
    searchApiEnabled: getChecked(container, '.api-searchapi-enabled'),
    mode: getInput(container, '.api-web-mode', 'local_plus_web') || 'local_plus_web',
    dailyLimit: Math.max(0, Math.floor(getNumber(container, '.api-web-daily', 10, 0, 9999))),
    cacheDays: Math.max(0, Math.floor(getNumber(container, '.api-web-cache', 3, 0, 365))),
    maxResults: Math.max(1, Math.floor(getNumber(container, '.api-web-max-results', 5, 1, 20))),
    includeImages: getChecked(container, '.api-web-images'),
    enhanceLinkCards: getChecked(container, '.api-web-link-card'),
    materialCurationEnabled: getChecked(container, '.api-web-material-curation'),
    needSearchEnabled: getChecked(container, '.api-need-search-enabled'),
    needSearchDailyLimit: Math.max(0, Math.floor(getNumber(container, '.api-need-search-daily', 12, 0, 999))),
  };
}

function collectSocialLinkConfig(container, prev = {}) {
  return {
    ...prev,
    enabled: getChecked(container, '.api-social-enabled'),
    apiKey: getInput(container, '.api-social-key'),
    includeComments: getChecked(container, '.api-social-comments-enabled'),
    commentCount: Math.max(0, Math.floor(getNumber(container, '.api-social-comment-count', 5, 0, 20))),
    cacheDays: Math.max(1, Math.floor(getNumber(container, '.api-social-cache-days', 3, 1, 30))),
    webviewFallbackEnabled: container.querySelector('.api-social-webview-fallback')
      ? getChecked(container, '.api-social-webview-fallback')
      : prev?.webviewFallbackEnabled === true,
  };
}

function collectMapConfig(container, prev = {}) {
  return {
    ...prev,
    enabled: getChecked(container, '.api-amap-enabled'),
    apiKey: getInput(container, '.api-amap-key'),
    jsApiKey: getInput(container, '.api-amap-js-key'),
    securityJsCode: getInput(container, '.api-amap-security'),
    jsMapEnabled: getChecked(container, '.api-amap-js-enabled'),
    radius: Math.floor(getNumber(container, '.api-amap-radius', 1500, 100, 50000)),
    maxResults: Math.floor(getNumber(container, '.api-amap-max', 6, 1, 20)),
    autoGrowEnabled: getChecked(container, '.api-amap-auto-grow'),
  };
}

function collectVoiceConfig(container, prev = {}) {
  const provider = getInput(container, '.api-voice-provider', prev.provider || 'minimax') === 'fish'
    ? 'fish'
    : 'minimax';
  const activeStyleBook = {
    ...(prev.styleBooks?.[provider] || prev.styleBook || {}),
    text: String(container.querySelector('.api-voice-style-text')?.value || '').slice(0, 12000),
    enabled: getChecked(container, '.api-voice-style-enabled'),
    naturalPauses: getChecked(container, '.api-voice-natural-pauses'),
    subtleEmotion: getChecked(container, '.api-voice-subtle-emotion'),
    nativeEmotion: provider === 'minimax'
      ? getChecked(container, '.api-voice-native-emotion')
      : prev.styleBooks?.minimax?.nativeEmotion === true,
    stripStageDirections: getChecked(container, '.api-voice-strip-stage'),
    pauseScale: getNumber(container, '.api-voice-pause-scale', 1, 0.5, 1.8),
  };
  const next = {
    ...prev,
    enabled: getChecked(container, '.api-voice-enabled'),
    provider,
    cache: {
      ...(prev.cache || {}),
      enabled: getChecked(container, '.api-voice-cache-enabled'),
      maxEntries: Math.floor(getNumber(container, '.api-voice-cache-max', DEFAULT_VOICE_TOOL_CONFIG.cache.maxEntries, 10, 1000)),
    },
    styleBooks: {
      ...(prev.styleBooks || {}),
      [provider]: activeStyleBook,
    },
    styleBook: activeStyleBook,
  };
  if (provider === 'fish') {
    const fishPrev = { ...DEFAULT_VOICE_TOOL_CONFIG.fish, ...(prev.fish || {}) };
    const selectedFishModel = getInput(container, '.api-fish-model-select', fishPrev.model);
    const customFishModel = getInput(container, '.api-fish-model');
    // iOS Safari / PWA 可能清空 password 输入值；空值保留已保存的 Fish Key。
    const typedFishKey = getInput(container, '.api-fish-key');
    next.fish = {
      ...fishPrev,
      endpoint: normalizeFishAudioEndpoint(getInput(container, '.api-fish-endpoint', fishPrev.endpoint)),
      apiKey: typedFishKey || fishPrev.apiKey || '',
      model: selectedFishModel === '__custom' ? customFishModel : selectedFishModel,
      temperature: getNumber(container, '.api-fish-temperature', fishPrev.temperature, 0, 1),
      topP: getNumber(container, '.api-fish-top-p', fishPrev.topP, 0, 1),
      speed: getNumber(container, '.api-fish-speed', fishPrev.speed, 0.5, 2),
      volume: getNumber(container, '.api-fish-volume', fishPrev.volume, -20, 20),
      chunkLength: Math.round(getNumber(container, '.api-fish-chunk-length', fishPrev.chunkLength, 100, 300)),
      minChunkLength: Math.round(getNumber(container, '.api-fish-min-chunk-length', fishPrev.minChunkLength, 0, 100)),
      latency: getInput(container, '.api-fish-latency', fishPrev.latency) || 'normal',
      format: getInput(container, '.api-fish-format', fishPrev.format) === 'mp3' ? 'mp3' : 'wav',
      mp3Bitrate: [64, 128, 192].includes(Number(getInput(container, '.api-fish-mp3-bitrate', fishPrev.mp3Bitrate)))
        ? Number(getInput(container, '.api-fish-mp3-bitrate', fishPrev.mp3Bitrate))
        : DEFAULT_VOICE_TOOL_CONFIG.fish.mp3Bitrate,
      normalize: getChecked(container, '.api-fish-normalize'),
      normalizeLoudness: getChecked(container, '.api-fish-normalize-loudness'),
      conditionOnPreviousChunks: getChecked(container, '.api-fish-condition-previous'),
      qualityGuard: getChecked(container, '.api-fish-quality-guard'),
    };
  } else {
    const selectedModel = getInput(container, '.api-voice-model-select', DEFAULT_VOICE_TOOL_CONFIG.model);
    const customModel = getInput(container, '.api-voice-model');
    // iOS Safari / PWA 常会把 password 输入框显示成空；空值时保留已保存的 Key。
    const typedKey = getInput(container, '.api-voice-key');
    next.region = getInput(container, '.api-voice-region', 'global') || 'global';
    next.endpoint = getInput(container, '.api-voice-endpoint');
    next.apiKey = typedKey || prev.apiKey || '';
    next.model = selectedModel === '__custom' ? customModel : selectedModel;
    next.languageBoost = getInput(container, '.api-voice-language', prev.languageBoost || 'auto') || 'auto';
    next.speed = getNumber(container, '.api-voice-speed', 1, 0.5, 2);
    next.vol = getNumber(container, '.api-voice-vol', 1, 0.1, 10);
    next.pitch = getNumber(container, '.api-voice-pitch', 0, -12, 12);
  }
  return next;
}

function collectImageConfig(container, prev = {}) {
  // 「启用」与 Provider 二选一冗余：以启用开关为准，避免只勾启用却 Provider=关闭导致测试失败
  const novelAiEnabled = getChecked(container, '.api-novelai-enabled');
  const realisticEnabled = getChecked(container, '.api-real-enabled');
  const characterProvider = novelAiEnabled ? 'novelai' : 'off';
  const selectedRealisticProvider = getInput(container, '.api-real-provider');
  const realisticProvider = realisticEnabled
    ? (['openai_compatible', 'openai_chat', 'google_gemini'].includes(selectedRealisticProvider)
      ? selectedRealisticProvider
      : 'openai_compatible')
    : 'off';
  return {
    ...prev,
    characterProvider,
    realisticProvider,
    novelAi: {
      ...(prev.novelAi || {}),
      enabled: novelAiEnabled,
      endpoint: getInput(container, '.api-novelai-endpoint') ?? (prev.novelAi?.endpoint || ''),
      apiKey: getInput(container, '.api-novelai-key') || prev.novelAi?.apiKey || '',
      model: getInput(container, '.api-novelai-model') || prev.novelAi?.model || '',
      size: getInput(container, '.api-novelai-size') || prev.novelAi?.size || '832x1216',
      promptPrefix: getInput(container, '.api-novelai-prompt-prefix') ?? (prev.novelAi?.promptPrefix || ''),
      promptSuffix: getInput(container, '.api-novelai-prompt-suffix') ?? (prev.novelAi?.promptSuffix || ''),
      negativePrompt: getInput(container, '.api-novelai-negative') ?? (prev.novelAi?.negativePrompt || ''),
      promptTemplate: getInput(container, '.api-novelai-prompt-template'),
    },
    realistic: {
      ...(prev.realistic || {}),
      enabled: realisticEnabled,
      provider: ['openai_chat', 'google_gemini'].includes(realisticProvider)
        ? realisticProvider
        : 'openai_compatible',
      endpoint: getInput(container, '.api-real-endpoint') ?? (prev.realistic?.endpoint || ''),
      apiKey: getInput(container, '.api-real-key') || prev.realistic?.apiKey || '',
      model: getInput(container, '.api-real-model') || prev.realistic?.model || '',
      size: getInput(container, '.api-real-size') || prev.realistic?.size || '1024x1024',
      responseFormat: getInput(container, '.api-real-response-format'),
      promptTemplate: getInput(container, '.api-real-prompt-template'),
      negativePrompt: getInput(container, '.api-real-negative') ?? (prev.realistic?.negativePrompt || ''),
    },
    usage: {
      ...(prev.usage || {}),
      chatImages: getChecked(container, '.api-image-chat-images'),
      momentsImages: getChecked(container, '.api-image-moments-images'),
      weiboImages: getChecked(container, '.api-image-weibo-images'),
      linkCardCovers: getChecked(container, '.api-image-link-covers'),
    },
    scenes: {
      ...(prev.scenes || {}),
      chatImages: getInput(container, '.api-scene-chat-provider') || prev.scenes?.chatImages || 'smart',
      momentsImages: getInput(container, '.api-scene-moments-provider') || prev.scenes?.momentsImages || prev.scenes?.chatImages || 'smart',
      weiboImages: getInput(container, '.api-scene-weibo-provider') || prev.scenes?.weiboImages || prev.scenes?.chatImages || 'smart',
      offlineScene: getInput(container, '.api-scene-offline-provider') || prev.scenes?.offlineScene || 'smart',
      travelImages: getInput(container, '.api-scene-travel-provider') || prev.scenes?.travelImages || 'realistic',
    },
    styles: {
      ...(prev.styles || {}),
      novelAiStyleId: getInput(container, '.api-style-nai', prev.styles?.novelAiStyleId || ''),
      realisticPersonStyleId: getInput(container, '.api-style-real-person', prev.styles?.realisticPersonStyleId || ''),
      sceneStyleId: getInput(container, '.api-style-scene', prev.styles?.sceneStyleId || ''),
    },
  };
}

function openImagePreviewModal(url, title = '生图测试结果') {
  const host = document.getElementById('modal-container');
  if (!host || !url) return;
  host.innerHTML = `
    <div class="modal-overlay" data-img-overlay>
      <div class="modal-sheet scrapbook-card" role="dialog" aria-modal="true" style="max-width:360px;" data-img-sheet>
        <div class="modal-header"><h3>${esc(title)}</h3></div>
        <div class="modal-body" style="padding-top:0;">
          <img src="${esc(url)}" alt="${esc(title)}" style="width:100%;border-radius:12px;display:block;" />
        </div>
        <div class="modal-body" style="padding-top:0;">
          <button type="button" class="btn btn-outline btn-block" data-img-close>关闭</button>
        </div>
      </div>
    </div>
  `;
  host.classList.add('active');
  const close = () => {
    host.classList.remove('active');
    host.innerHTML = '';
  };
  host.querySelector('[data-img-overlay]')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) close();
  });
  host.querySelector('[data-img-sheet]')?.addEventListener('click', (e) => e.stopPropagation());
  host.querySelector('[data-img-close]')?.addEventListener('click', close);
}

function formatVoiceCacheTime(value = 0) {
  const date = new Date(Number(value || 0));
  if (!Number.isFinite(date.getTime()) || date.getTime() <= 0) return '';
  return date.toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function voiceCacheProviderLabel(entry = {}) {
  if (entry.provider === 'fish') return 'Fish';
  if (entry.provider === 'minimax') return 'MiniMax';
  if (/^s2/i.test(entry.model || '')) return 'Fish';
  if (/^speech-/i.test(entry.model || '')) return 'MiniMax';
  return '语音';
}

function voiceCacheScopeLabel(entry = {}) {
  if (entry.scope === 'call') return '通话';
  if (entry.scope === 'streamer') return '主播';
  return '通用';
}

function voiceCacheFilenameBase(entry = {}) {
  const date = new Date(Number(entry.createdAt || entry.updatedAt || Date.now()));
  const stamp = Number.isFinite(date.getTime())
    ? `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}-${String(date.getHours()).padStart(2, '0')}${String(date.getMinutes()).padStart(2, '0')}`
    : '缓存';
  return `语音缓存-${stamp}-${entry.textPreview || voiceCacheProviderLabel(entry)}`;
}

async function openVoiceCacheManager({ onChanged } = {}) {
  const host = document.getElementById('modal-container');
  if (!host) return;
  const returnFocus = document.activeElement;
  let entries = await listVoiceCacheEntries();
  let activePreview = null;

  host.innerHTML = `
    <div class="modal-overlay voice-cache-manager-overlay" data-voice-cache-overlay>
      <div class="modal-sheet voice-cache-manager-sheet" role="dialog" aria-modal="true" aria-labelledby="voice-cache-manager-title" data-voice-cache-sheet>
        <div class="modal-header">
          <div class="voice-cache-manager-heading">
            <h3 id="voice-cache-manager-title">语音缓存</h3>
            <small data-voice-cache-summary></small>
          </div>
          <button type="button" class="navbar-btn modal-close-btn" data-voice-cache-close aria-label="关闭">${icon('close')}</button>
        </div>
        <div class="modal-body voice-cache-manager-body" data-voice-cache-list></div>
        <div class="modal-footer voice-cache-manager-footer">
          <button type="button" class="btn btn-outline voice-cache-clear-all" data-voice-cache-clear>清空全部</button>
          <button type="button" class="btn btn-primary" data-voice-cache-close>完成</button>
        </div>
      </div>
    </div>
  `;
  host.classList.add('active');

  const summary = host.querySelector('[data-voice-cache-summary]');
  const list = host.querySelector('[data-voice-cache-list]');
  const clearButton = host.querySelector('[data-voice-cache-clear]');

  const stopPreview = () => {
    if (!activePreview) return;
    try {
      activePreview.audio.pause();
      activePreview.audio.currentTime = 0;
    } catch (_) {}
    activePreview.playback?.revoke?.();
    if (activePreview.button?.isConnected) activePreview.button.textContent = '试听';
    activePreview = null;
  };

  const renderEntries = () => {
    const totalBytes = entries.reduce((sum, entry) => sum + (Number(entry.bytes || 0) || 0), 0);
    if (summary) summary.textContent = `${entries.length} 条 / ${formatBytesLabel(totalBytes)}`;
    if (clearButton) clearButton.disabled = entries.length === 0;
    if (!list) return;
    if (!entries.length) {
      list.innerHTML = '<div class="voice-cache-empty">还没有缓存语音</div>';
      return;
    }
    list.innerHTML = entries.map((entry) => {
      const format = String(entry.format || 'audio').toUpperCase();
      const meta = [
        voiceCacheScopeLabel(entry),
        voiceCacheProviderLabel(entry),
        format,
        formatBytesLabel(entry.bytes),
        formatVoiceCacheTime(entry.updatedAt || entry.createdAt),
      ].filter(Boolean).join(' · ');
      return `
        <article class="voice-cache-item${entry.available ? '' : ' is-missing'}" data-voice-cache-key="${esc(entry.storageKey || entry.key)}">
          <div class="voice-cache-item-copy">
            <strong>${esc(entry.textPreview || '未命名语音')}</strong>
            <small>${esc(entry.available ? meta : `${meta} · 缓存已失效`)}</small>
          </div>
          <div class="voice-cache-item-actions">
            <button type="button" class="btn btn-soft btn-sm" data-voice-cache-action="play" ${entry.available ? '' : 'disabled'}>试听</button>
            <button type="button" class="btn btn-outline btn-sm" data-voice-cache-action="export" ${entry.available ? '' : 'disabled'}>导出</button>
            <button type="button" class="btn btn-soft btn-sm voice-cache-delete" data-voice-cache-action="delete">删除</button>
          </div>
        </article>
      `;
    }).join('');
  };

  const notifyChanged = async () => {
    if (typeof onChanged === 'function') await onChanged();
  };

  const close = () => {
    stopPreview();
    document.removeEventListener('keydown', onKeydown);
    host.classList.remove('active');
    host.innerHTML = '';
    try { returnFocus?.focus?.({ preventScroll: true }); } catch (_) {}
  };
  const onKeydown = (event) => {
    if (event.key === 'Escape') close();
  };

  host.querySelector('[data-voice-cache-overlay]')?.addEventListener('click', (event) => {
    if (event.target === event.currentTarget) close();
  });
  host.querySelector('[data-voice-cache-sheet]')?.addEventListener('click', (event) => event.stopPropagation());
  host.querySelectorAll('[data-voice-cache-close]').forEach((button) => button.addEventListener('click', close));
  document.addEventListener('keydown', onKeydown);

  list?.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-voice-cache-action]');
    if (!button || button.disabled) return;
    const row = button.closest('[data-voice-cache-key]');
    const key = String(row?.dataset.voiceCacheKey || '');
    const entry = entries.find((item) => String(item.storageKey || item.key) === key);
    if (!entry) return;
    const action = String(button.dataset.voiceCacheAction || '');

    if (action === 'play') {
      if (activePreview?.key === key) {
        stopPreview();
        return;
      }
      stopPreview();
      const gesture = captureMediaGesture(event);
      const playback = createVoicePlaybackUrl(entry.payload || {});
      const audio = audioFromGestureOrNew(playback.url, gesture);
      if (!audio) {
        gesture?.dispose?.();
        playback.revoke?.();
        showToast('这条缓存暂时无法播放');
        return;
      }
      activePreview = { key, audio, playback, button };
      button.textContent = '停止';
      audio.addEventListener('ended', stopPreview, { once: true });
      audio.addEventListener('error', () => {
        stopPreview();
        showToast('这条缓存暂时无法播放');
      }, { once: true });
      await audio.play().catch(() => {
        stopPreview();
        showToast('播放失败，请再点一次试听');
      });
      return;
    }

    if (action === 'export') {
      button.disabled = true;
      const previousText = button.textContent;
      button.textContent = '导出中';
      try {
        const result = await exportCachedVoicePayload(entry.payload || {}, {
          filenameBase: voiceCacheFilenameBase(entry),
        });
        showToast(result.message || '语音已导出');
      } catch (error) {
        showToast(String(error?.message || error || '导出失败'));
      } finally {
        if (button.isConnected) {
          button.disabled = false;
          button.textContent = previousText;
        }
      }
      return;
    }

    if (action === 'delete') {
      if (!window.confirm(`删除这条本机语音缓存？\n${entry.textPreview || '未命名语音'}`)) return;
      if (activePreview?.key === key) stopPreview();
      button.disabled = true;
      await deleteVoiceCachedAudio(key);
      entries = entries.filter((item) => String(item.storageKey || item.key) !== key);
      renderEntries();
      await notifyChanged();
      showToast('已删除这条语音缓存');
    }
  });

  clearButton?.addEventListener('click', async () => {
    if (!entries.length || !window.confirm(`清空本机全部 ${entries.length} 条语音缓存？`)) return;
    stopPreview();
    clearButton.disabled = true;
    await clearVoiceCache();
    entries = [];
    renderEntries();
    await notifyChanged();
    showToast('语音缓存已清空');
  });

  renderEntries();
  host.querySelector('[data-voice-cache-close]')?.focus({ preventScroll: true });
}

function downloadText(text, filename) {
  return downloadBlob(new Blob([text], { type: 'application/json' }), filename, { mimeType: 'application/json', directory: 'downloads' });
}

async function importApiSettingsFile() {
  return new Promise((resolve, reject) => {
    openFilePicker({
      accept: '.json,application/json',
      onChange: async (files) => {
        const file = files?.[0];
        if (!file) {
          resolve(false);
          return;
        }
        try {
          const payload = JSON.parse(await file.text());
          await importApiSettingsPayload(payload);
          resolve(true);
        } catch (err) {
          reject(err);
        }
      },
    });
  });
}

async function loadSearchUsageStats() {
  const today = searchLogDayKey();
  const todayEntries = await listSearchCallLog({ dateKey: today, limit: 500 }).catch(() => []);
  const recent = await listSearchCallLog({ limit: 15 }).catch(() => []);
  return { today: summarizeSearchCallLog(todayEntries), recent };
}

async function loadMeituanCouponReminderState() {
  const user = await ensureDefaultUser();
  const [config, characters] = await Promise.all([
    loadMeituanCouponReminderConfig(user.id),
    listCharacters({ excludeAnonNpc: true, userId: user.id }).catch(() => []),
  ]);
  return {
    user,
    config,
    characters: (Array.isArray(characters) ? characters : [])
      .filter((character) => isSelectableContactCharacter(character)),
  };
}

function deferApiManagerIdleWork(work) {
  if (typeof globalThis.requestIdleCallback === 'function') {
    globalThis.requestIdleCallback(() => work(), { timeout: 1200 });
    return;
  }
  setTimeout(work, 80);
}

export default async function render(container, params = {}) {
  let activeTab = TABS.some((tab) => tab.id === params.tab) ? params.tab : 'llm';
  let pendingFocus = String(params.focus || '').trim();
  const [initialState, initialLibrary] = await Promise.all([
    loadAllActiveConfigs(),
    loadPresetLibrary(),
  ]);
  let state = {
    ...initialState,
    support: {},
    voiceCacheStats: null,
    social: {},
    voiceInput: {},
    searchUsageStats: null,
    modelCallAudit: null,
    couponReminderUser: null,
    couponReminder: {},
    couponReminderCharacters: [],
  };
  let library = initialLibrary;
  let voiceCacheStatsPromise = null;
  const auxiliaryTasks = new Map();

  function runAuxiliaryTask(key, work) {
    if (auxiliaryTasks.has(key)) return auxiliaryTasks.get(key);
    const task = Promise.resolve()
      .then(work)
      .then(() => true)
      .catch(() => {
        auxiliaryTasks.delete(key);
        return false;
      });
    auxiliaryTasks.set(key, task);
    return task;
  }

  function ensureTabAuxiliary(tab) {
    if (tab === 'support') {
      return runAuxiliaryTask('support', async () => {
        state.support = await loadSupportConfig();
      });
    }
    if (tab === 'search') {
      return runAuxiliaryTask('social', async () => {
        state.social = await loadSocialLinkConfig();
      });
    }
    if (tab === 'voice') {
      return runAuxiliaryTask('voice-input', async () => {
        state.voiceInput = await loadVoiceInputConfig();
      });
    }
    if (tab === 'life') {
      return runAuxiliaryTask('coupon-reminder', async () => {
        const couponReminderState = await loadMeituanCouponReminderState();
        if (!couponReminderState) return;
        state.couponReminderUser = couponReminderState.user;
        state.couponReminder = couponReminderState.config;
        state.couponReminderCharacters = couponReminderState.characters;
      });
    }
    return Promise.resolve(true);
  }

  function loadTabDiagnostics(tab) {
    if (tab === 'llm') {
      return runAuxiliaryTask('model-call-audit', async () => {
        state.modelCallAudit = await listApiRequestStats(300).catch(() => []);
        if (activeTab !== 'llm' || !container.isConnected) return;
        const current = container.querySelector('.api-model-audit');
        if (current) current.outerHTML = renderModelCallAuditBlock(state.modelCallAudit);
      });
    }
    if (tab === 'search') {
      return runAuxiliaryTask('search-usage', async () => {
        state.searchUsageStats = await loadSearchUsageStats();
        if (activeTab !== 'search' || !container.isConnected) return;
        const current = container.querySelector('.api-usage-stats-panel');
        if (current) current.outerHTML = renderSearchUsageStatsBlock(state.searchUsageStats);
      });
    }
    return Promise.resolve(true);
  }

  function rejectOpenAiVersionSuffix(config, inputSelector) {
    if (!needsOpenAiBaseUrlCleanup(config)) return false;
    showToast('接口地址末尾的 /v1 会被自动拼接；请去掉 /v1 后再保存或拉取模型', 7000);
    container.querySelector(inputSelector)?.focus({ preventScroll: true });
    return true;
  }

  function offerApiHelp(error, {
    apiKind = activeTab,
    operation = 'api-test',
    config = {},
    reason = '',
    title = '',
    responseText = '',
    usedUrl = '',
    transport = '',
  } = {}) {
    const safeUsedUrl = usedUrl || error?.usedUrl || '';
    const requestMethod = String(error?.requestMethod || '').trim();
    const requestPath = String(error?.requestPath || '').trim();
    let baseUrlHost = '';
    const baseUrl = config.baseUrl || config.endpoint || config.url || '';
    try {
      baseUrlHost = baseUrl ? new URL(String(baseUrl)).host : '';
    } catch (_) {
      baseUrlHost = '[invalid-url]';
    }
    const status = Number(error?.status || error?.httpStatus || 0) || undefined;
    const errorScope = operation === 'novelai-test' ? 'NovelAI 生图测试' : 'API 管理';
    const generationError = generationErrorFromCatch(error, {
      scope: errorScope,
      title,
      reason,
      status,
      responseText,
      usedUrl: safeUsedUrl,
      detail: responseText || error?.message || '',
      operation,
      apiKind,
      requestModel: String(config.model || ''),
      evidence: {
        baseUrlHost,
        hasApiKey: !!config.apiKey,
        model: String(config.model || ''),
        testStage: operation,
        transport,
        requestMethod,
        requestPath,
      },
    });
    const diagnostic = saveSupportIncident({
      ...generationError.diagnostic,
      evidence: {
        ...(generationError.diagnostic?.evidence || {}),
        baseUrlHost,
        hasApiKey: !!config.apiKey,
        model: String(config.model || ''),
        testStage: operation,
        transport,
        requestMethod,
        requestPath,
      },
    });
    showGenerationErrorReport(generationError);
    const scroll = container.querySelector('.api-manager-scroll');
    if (!scroll) return diagnostic;
    scroll.querySelector('.api-help-offer')?.remove();
    const offer = document.createElement('div');
    offer.className = 'api-help-offer';
    offer.innerHTML = `
      <span><strong>${esc(generationError.title)}</strong><br>${esc(generationError.message)}</span>
      <button type="button" class="btn btn-outline btn-sm">问芥末棉花糖</button>
    `;
    offer.querySelector('button')?.addEventListener('click', () => {
      navigate('support', { incidentId: diagnostic.incidentId });
    });
    scroll.appendChild(offer);
    offer.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    return diagnostic;
  }

  async function syncActivePresetsIfNeeded() {
    if (getActiveCombo(library)) return;
    library = await syncAllSectionActivePresets(state, { clearCombo: false });
  }

  async function reload() {
    const [
      nextState,
      nextSupport,
      nextVoiceCacheStats,
      nextSocial,
      nextVoiceInput,
      nextSearchUsageStats,
      nextModelCallAudit,
      nextLibrary,
      nextCouponReminderState,
    ] = await Promise.all([
      loadAllActiveConfigs(),
      loadSupportConfig(),
      Promise.resolve(state.voiceCacheStats || null),
      loadSocialLinkConfig(),
      loadVoiceInputConfig(),
      loadSearchUsageStats(),
      listApiRequestStats(300).catch(() => []),
      loadPresetLibrary(),
      loadMeituanCouponReminderState(),
    ]);
    state = {
      ...nextState,
      support: nextSupport,
      voiceCacheStats: nextVoiceCacheStats,
      social: nextSocial,
      voiceInput: nextVoiceInput,
      searchUsageStats: nextSearchUsageStats,
      modelCallAudit: nextModelCallAudit,
      couponReminderUser: nextCouponReminderState.user,
      couponReminder: nextCouponReminderState.config,
      couponReminderCharacters: nextCouponReminderState.characters,
    };
    library = nextLibrary;
    await syncActivePresetsIfNeeded();
  }

  function refreshVoiceCacheStatsInBackground() {
    if (state.voiceCacheStats || voiceCacheStatsPromise) return voiceCacheStatsPromise;
    voiceCacheStatsPromise = getVoiceCacheStats()
      .then((stats) => {
        state.voiceCacheStats = stats;
        if (activeTab === 'voice' && container.isConnected) {
          const label = container.querySelector('.api-voice-cache-meta small');
          if (label) label.textContent = `${stats.count || 0} 条 / ${formatBytesLabel(stats.totalBytes)}`;
        }
        return stats;
      })
      .catch(() => null)
      .finally(() => {
        voiceCacheStatsPromise = null;
      });
    return voiceCacheStatsPromise;
  }

  /** 切页/返回前把当前标签未点保存的草稿落盘，避免启用开关之类的勾选一退出就丢。 */
  async function flushActiveTabDraft() {
    if (activeTab === 'embedding' && container.querySelector('.api-embedding-enabled')) {
      const next = collectEmbeddingConfig(container, state.embedding);
      state.embedding = await saveEmbeddingConfig(next);
      await syncSectionActivePreset('embedding', state.embedding, { clearCombo: false });
      library = await loadPresetLibrary();
    }
    if (activeTab === 'voice' && container.querySelector('.api-voice-enabled')) {
      const next = collectVoiceConfig(container, state.voice);
      await saveVoiceToolConfig(next);
      state.voice = next;
      await syncSectionActivePreset('voice', next, { clearCombo: false });
      library = await loadPresetLibrary();
    }
  }

  async function draw() {
    const prevScroll = captureScrollerTop(container, '.api-manager-scroll');
    container.className = 'page scrapbook-page api-manager-page';
    container.innerHTML = `
      <header class="navbar">
        <button type="button" class="navbar-btn api-manager-back" aria-label="返回">${icon('back')}</button>
        <h1 class="navbar-title">API 管理</h1>
        <span class="navbar-btn" style="visibility:hidden" aria-hidden="true"></span>
      </header>
      <main class="api-manager-scroll scrapbook-scroll">
        ${renderTabs(activeTab)}
        ${renderActiveTab(state, library, activeTab)}
      </main>
    `;
    restoreScrollerTop(container, '.api-manager-scroll', prevScroll);
    lockScrollerToVerticalAxis(container, '.api-manager-scroll');

    container.querySelector('.api-manager-back')?.addEventListener('click', async () => {
      await flushActiveTabDraft().catch(() => {});
      back();
    });
    container.querySelectorAll('[data-tutorial-section]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const section = String(btn.getAttribute('data-tutorial-section') || '').trim();
        if (section) navigate('tutorial', { section });
      });
    });
    container.querySelectorAll('.api-manager-tab').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const nextTab = String(btn.dataset.apiTab || 'llm');
        if (nextTab === activeTab) return;
        btn.disabled = true;
        btn.setAttribute('aria-busy', 'true');
        await flushActiveTabDraft().catch(() => {});
        const auxiliaryReady = await ensureTabAuxiliary(nextTab);
        if (!auxiliaryReady) {
          btn.disabled = false;
          btn.removeAttribute('aria-busy');
          showToast('读取该分类设置失败，请稍后重试');
          return;
        }
        activeTab = nextTab;
        await draw();
        void loadTabDiagnostics(nextTab);
      });
    });
    bindCurrentTab();
    if (activeTab === 'voice' && !state.voiceCacheStats) {
      void refreshVoiceCacheStatsInBackground();
    }
    if (pendingFocus) {
      const target = [...container.querySelectorAll('[data-support-target]')]
        .find((item) => item.getAttribute('data-support-target') === pendingFocus);
      pendingFocus = '';
      if (target) {
        requestAnimationFrame(() => {
          target.scrollIntoView({ block: 'center', behavior: 'smooth' });
          target.classList.add('api-support-focus');
          target.querySelector('input, select, textarea, button')?.focus({ preventScroll: true });
          setTimeout(() => target.classList.remove('api-support-focus'), 1800);
        });
      }
    }
  }

  async function handleFetchModels({
    button,
    saveDraft,
    fetchFn,
    selectSelector,
    modelInputSelector,
    filterModels = null,
    preferredModels = [],
    supportMeta = {},
  }) {
    const btn = button;
    const prevHtml = btn.innerHTML;
    try {
      btn.disabled = true;
      btn.textContent = '拉取中...';
      if (await saveDraft() === false) return;
      const result = await fetchFn();
      const fetchedModels = Array.isArray(result.models) ? result.models.filter(Boolean) : [];
      const list = (typeof filterModels === 'function' ? filterModels(fetchedModels) : fetchedModels)
        .slice()
        .sort((a, b) => String(a).localeCompare(String(b)));
      const modelInput = container.querySelector(modelInputSelector);
      const currentModel = String(modelInput?.value || '').trim();
      const preferredModel = (Array.isArray(preferredModels) ? preferredModels : [])
        .find((model) => list.includes(model));
      const selectedModel = list.includes(currentModel) ? currentModel : (preferredModel || '');
      if (modelInput && selectedModel && selectedModel !== currentModel) modelInput.value = selectedModel;
      fillModelSelect(container.querySelector(selectSelector), list, selectedModel);
      if (list.length) {
        showToast(selectedModel && selectedModel !== currentModel
          ? `已获取 ${list.length} 个模型，已选择 ${selectedModel}`
          : `已获取 ${list.length} 个模型，请从下拉列表选择`);
      } else {
        showToast(result.error || '未获取到模型');
        if (result.error) offerApiHelp(new Error(result.error), supportMeta);
      }
    } catch (err) {
      showToast(`拉取失败：${String(err?.message || err).slice(0, 80)}`);
      offerApiHelp(err, supportMeta);
    } finally {
      btn.disabled = false;
      btn.innerHTML = prevHtml;
    }
  }

  function bindCurrentTab() {
    const bindPersistedToggle = (selector, persist, labels = {}) => {
      const checkbox = container.querySelector(selector);
      if (!checkbox) return;
      checkbox.addEventListener('change', async () => {
        const enabled = !!checkbox.checked;
        checkbox.disabled = true;
        try {
          await persist(enabled);
          showToast(enabled
            ? (labels.enabled || '已启用并保存')
            : (labels.disabled || '已关闭并保存'));
        } catch (error) {
          checkbox.checked = !enabled;
          try { labels.onRevert?.(!enabled); } catch (_) {}
          showToast(`启用状态保存失败：${String(error?.message || error).slice(0, 80)}`);
        } finally {
          if (checkbox.isConnected) checkbox.disabled = false;
        }
      });
    };

    bindPersistedToggle('.api-support-enabled', async () => {
      state.support = await saveSupportConfig(collectSupportConfig(container, state.support));
    }, {
      enabled: '芥末棉花糖 API 已启用',
      disabled: '芥末棉花糖 API 已关闭',
    });
    bindPersistedToggle('.api-scene-custom', async () => {
      const next = collectSceneConfig(container, state.scene);
      await api.saveSceneConfig(next);
      state.scene = next;
      await syncSectionActivePreset('scene', next, { clearCombo: false });
      library = await loadPresetLibrary();
    }, {
      enabled: '场景叙事独立 API 已启用',
      disabled: '场景叙事已改为跟随聊天模型',
    });
    bindPersistedToggle('.api-tool-enabled', async () => {
      const next = collectToolConfig(container, state.tool);
      await api.saveToolConfig(next);
      state.tool = next;
      await syncSectionActivePreset('tool', next, { clearCombo: false });
      library = await loadPresetLibrary();
    }, {
      enabled: '工具模型已启用',
      disabled: '工具模型已关闭',
    });
    bindPersistedToggle('.api-web-enabled', async () => {
      const next = await saveWebSearchConfig(collectSearchConfig(container, state.search));
      state.search = next;
      await syncSectionActivePreset('search', next, { clearCombo: false });
      library = await loadPresetLibrary();
    }, {
      enabled: '搜索 API 已启用',
      disabled: '搜索 API 已关闭',
    });
    bindPersistedToggle('.api-social-enabled', async () => {
      state.social = await saveSocialLinkConfig(collectSocialLinkConfig(container, state.social));
    }, {
      enabled: '深度解析 API 已启用',
      disabled: '深度解析 API 已关闭',
    });
    bindPersistedToggle('.api-amap-enabled', async () => {
      const next = await saveAmapConfig(collectMapConfig(container, state.map));
      state.map = next;
      await syncSectionActivePreset('map', next, { clearCombo: false });
      library = await loadPresetLibrary();
    }, {
      enabled: '地图 API 已启用',
      disabled: '地图 API 已关闭',
    });
    bindPersistedToggle('.api-meituan-coupon-enabled', async () => {
      state.couponReminder = await saveMeituanCouponReminderConfig(
        state.couponReminderUser?.id,
        collectMeituanCouponReminderConfig(container, state.couponReminder),
      );
    }, {
      enabled: '优惠自然分享已开启',
      disabled: '优惠自然分享已关闭',
    });
    bindPersistedToggle('.api-meituan-coupon-scheduled', async () => {
      state.couponReminder = await saveMeituanCouponReminderConfig(
        state.couponReminderUser?.id,
        collectMeituanCouponReminderConfig(container, state.couponReminder),
      );
    }, {
      enabled: '定时提醒已开启',
      disabled: '定时提醒已关闭',
    });
    bindPersistedToggle('.api-novelai-enabled', async () => {
      const next = collectImageConfig(container, state.image);
      await saveImageToolConfig(next);
      state.image = next;
      await syncSectionActivePreset('image', next, { clearCombo: false });
      library = await loadPresetLibrary();
    }, {
      enabled: 'NovelAI 已启用',
      disabled: 'NovelAI 已关闭',
      onRevert: (enabled) => {
        const provider = container.querySelector('.api-image-character-provider');
        if (provider) provider.value = enabled ? 'novelai' : 'off';
      },
    });
    bindPersistedToggle('.api-real-enabled', async () => {
      const next = collectImageConfig(container, state.image);
      await saveImageToolConfig(next);
      state.image = next;
      await syncSectionActivePreset('image', next, { clearCombo: false });
      library = await loadPresetLibrary();
    }, {
      enabled: '兼容生图 API 已启用',
      disabled: '兼容生图 API 已关闭',
      onRevert: (enabled) => {
        const provider = container.querySelector('.api-real-provider');
        if (provider) provider.value = enabled ? 'openai_compatible' : 'off';
      },
    });

    container.querySelector('.api-save-support')?.addEventListener('click', async () => {
      const next = collectSupportConfig(container, state.support);
      if (rejectOpenAiVersionSuffix(next, '.api-support-base')) return;
      state.support = await saveSupportConfig(next);
      showToast('芥末棉花糖 API 已保存');
      await draw();
    });
    bindModelSelect(container, '.api-support-model-select', '.api-support-model');
    container.querySelector('.api-fetch-support-models')?.addEventListener('click', (event) => {
      handleFetchModels({
        button: event.currentTarget,
        saveDraft: async () => {
          const next = collectSupportConfig(container, state.support);
          if (rejectOpenAiVersionSuffix(next, '.api-support-base')) return false;
          state.support = await saveSupportConfig(next);
        },
        fetchFn: async () => ({ models: await listSupportModels() }),
        selectSelector: '.api-support-model-select',
        modelInputSelector: '.api-support-model',
        supportMeta: {
          apiKind: 'support',
          operation: 'fetch-models',
          config: collectSupportConfig(container, state.support),
        },
      });
    });
    container.querySelector('.api-test-support')?.addEventListener('click', async () => {
      const button = container.querySelector('.api-test-support');
      const result = container.querySelector('.api-support-result');
      if (!button || !result) return;
      try {
        button.disabled = true;
        button.textContent = '测试中…';
        state.support = await saveSupportConfig(collectSupportConfig(container, state.support));
        const reply = await testSupportConnection(state.support);
        result.hidden = false;
        result.textContent = reply || '连接成功';
      } catch (error) {
        result.hidden = false;
        result.textContent = `测试失败：${String(error?.message || error).slice(0, 200)}`;
        offerApiHelp(error, {
          apiKind: 'support',
          operation: 'connection-test',
          config: collectSupportConfig(container, state.support),
        });
      } finally {
        button.disabled = false;
        button.textContent = '测试连接';
      }
    });
    container.querySelector('.api-save-main')?.addEventListener('click', async () => {
      const next = collectMainConfig(container, state.main);
      if (rejectOpenAiVersionSuffix(next, '.api-main-base')) return;
      await api.saveConfig(next);
      await syncSectionActivePreset('main', next);
      await reload();
      showToast('聊天模型已保存');
      await draw();
    });
    async function runMainProbe(stream) {
      const button = container.querySelector(stream ? '.api-probe-stream' : '.api-probe-nonstream');
      const resultBox = container.querySelector('.api-probe-result');
      if (!button || !resultBox) return;
      const originalText = button.textContent;
      try {
        button.disabled = true;
        button.textContent = '测试中…';
        await api.saveConfig(collectMainConfig(container, state.main));
        const result = await api.runChatApiProbe({ stream });
        const formatMs = (value) => Number.isFinite(Number(value))
          ? `${Math.round(Number(value))}ms`
          : '—';
        const parts = [
          result.ok ? '成功' : '正文为空',
          `实际${result.requestStream ? '流式' : '一次性'}`,
          result.viaNativeHttp
            ? `原生通道${result.nativeHttpTransport ? `（${result.nativeHttpTransport}）` : ''}`
            : (result.viaProxyFallback ? '网页代理' : '浏览器直连'),
          result.status ? `HTTP ${result.status}` : '',
          `首包 ${formatMs(result.ttfbMs)}`,
          `总耗时 ${formatMs(result.durationMs)}`,
          `chunk ${Number(result.chunkCount || 0)}`,
          result.finishReason ? `finish=${result.finishReason}` : '',
          result.reasoningLength ? `推理 ${result.reasoningLength} 字` : '',
        ].filter(Boolean);
        resultBox.hidden = false;
        resultBox.textContent = parts.join(' · ');
      } catch (error) {
        const stat = error?.probeStat || {};
        resultBox.hidden = false;
        resultBox.textContent = [
          `失败：${String(error?.message || error).slice(0, 180)}`,
          stat.errorKind ? `[${stat.errorKind}]` : '',
          stat.durationMs != null ? `耗时 ${Math.round(Number(stat.durationMs))}ms` : '',
        ].filter(Boolean).join(' · ');
        offerApiHelp(error, {
          apiKind: 'chat',
          operation: stream ? 'stream-probe' : 'nonstream-probe',
          config: collectMainConfig(container, state.main),
        });
      } finally {
        button.disabled = false;
        button.textContent = originalText;
      }
    }
    container.querySelector('.api-probe-nonstream')?.addEventListener('click', () => runMainProbe(false));
    container.querySelector('.api-probe-stream')?.addEventListener('click', () => runMainProbe(true));
    container.querySelector('.api-save-scene')?.addEventListener('click', async () => {
      const next = collectSceneConfig(container, state.scene);
      if (rejectOpenAiVersionSuffix(next, '.api-scene-base')) return;
      await api.saveSceneConfig(next);
      await syncSectionActivePreset('scene', next);
      await reload();
      showToast('场景叙事已保存');
      await draw();
    });
    container.querySelector('.api-scene-copy-main')?.addEventListener('click', () => {
      const main = collectMainConfig(container, state.main);
      const fields = [
        ['.api-scene-endpoint-type', main.endpointType],
        ['.api-scene-base', main.baseUrl],
        ['.api-scene-key', main.apiKey],
        ['.api-scene-model', main.model],
        ['.api-scene-sampling-mode', main.samplingMode],
        ['.api-scene-temp', main.temperature],
        ['.api-scene-top-p', main.topP],
        ['.api-scene-max', main.maxTokens],
        ['.api-scene-reasoning-effort', main.reasoningEffort],
      ];
      fields.forEach(([sel, val]) => {
        const el = container.querySelector(sel);
        if (el) el.value = val ?? '';
      });
      const custom = container.querySelector('.api-scene-custom');
      if (custom) custom.checked = true;
      const stream = container.querySelector('.api-scene-stream');
      if (stream) stream.checked = main.preferStream !== false;
      showToast('已套用聊天模型，可修改后保存');
    });
    container.querySelector('.api-save-tool')?.addEventListener('click', async () => {
      const next = collectToolConfig(container, state.tool);
      if (rejectOpenAiVersionSuffix(next, '.api-tool-base')) return;
      await api.saveToolConfig(next);
      await syncSectionActivePreset('tool', next);
      await reload();
      showToast('工具模型已保存');
      await draw();
    });
    container.querySelector('.api-save-embedding')?.addEventListener('click', async () => {
      const draft = collectEmbeddingConfig(container, state.embedding);
      if (rejectOpenAiVersionSuffix(draft, '.api-embedding-base')) return;
      if (isRerankerModelName(draft.model)) {
        showToast('这是 Reranker 重排序模型，请选择名称包含 Embedding 的向量模型');
        return;
      }
      const next = await saveEmbeddingConfig(draft);
      await syncSectionActivePreset('embedding', next);
      await reload();
      showToast('向量模型已保存');
      await draw();
    });
    container.querySelector('.api-embedding-enabled')?.addEventListener('change', async () => {
      const checkbox = container.querySelector('.api-embedding-enabled');
      if (!checkbox) return;
      try {
        checkbox.disabled = true;
        state.embedding = await saveEmbeddingConfig(collectEmbeddingConfig(container, state.embedding));
        await syncSectionActivePreset('embedding', state.embedding, { clearCombo: false });
        library = await loadPresetLibrary();
        showToast(state.embedding.enabled
          ? (state.embedding.model ? '向量记忆已启用' : '已开启；填写向量模型后生效')
          : '向量记忆已关闭');
      } catch (error) {
        checkbox.checked = !checkbox.checked;
        showToast(`保存失败：${String(error?.message || error).slice(0, 80)}`);
      } finally {
        checkbox.disabled = false;
      }
    });
    bindModelSelect(container, '.api-embedding-model-select', '.api-embedding-model');
    container.querySelector('.api-embedding-provider')?.addEventListener('change', (event) => {
      if (event.target.value !== 'siliconflow') return;
      const endpoint = container.querySelector('.api-embedding-base');
      if (endpoint) endpoint.value = SILICONFLOW_EMBEDDING_ENDPOINT;
    });
    container.querySelector('.api-embedding-base')?.addEventListener('input', (event) => {
      const provider = container.querySelector('.api-embedding-provider');
      if (provider) provider.value = embeddingProviderForEndpoint(event.target.value);
    });
    container.querySelector('.api-fetch-embedding-models')?.addEventListener('click', (event) => {
      handleFetchModels({
        button: event.currentTarget,
        saveDraft: async () => {
          const next = collectEmbeddingConfig(container, state.embedding);
          if (rejectOpenAiVersionSuffix(next, '.api-embedding-base')) return false;
          state.embedding = await saveEmbeddingConfig(next);
        },
        fetchFn: () => api.fetchModelsForConfig(state.embedding),
        selectSelector: '.api-embedding-model-select',
        modelInputSelector: '.api-embedding-model',
        filterModels: filterEmbeddingModelNames,
        supportMeta: {
          apiKind: 'embedding',
          operation: 'fetch-models',
          config: collectEmbeddingConfig(container, state.embedding),
        },
      });
    });
    container.querySelector('.api-test-embedding')?.addEventListener('click', async () => {
      const button = container.querySelector('.api-test-embedding');
      const resultBox = container.querySelector('.api-embedding-result');
      if (!button || !resultBox) return;
      const originalText = button.textContent;
      try {
        button.disabled = true;
        button.textContent = '测试中…';
        const next = await saveEmbeddingConfig(collectEmbeddingConfig(container, state.embedding));
        const result = await testEmbeddingConnection(next);
        resultBox.hidden = false;
        const durationSeconds = Math.max(0.1, Number(result.durationMs || 0) / 1000);
        resultBox.textContent = `连接成功 · ${result.dimensions} 维 · ${durationSeconds.toFixed(1)} 秒`;
      } catch (error) {
        resultBox.hidden = false;
        resultBox.textContent = `测试失败：${String(error?.message || error).slice(0, 180)}`;
      } finally {
        button.disabled = false;
        button.textContent = originalText;
      }
    });

    const mainFetchOpts = {
      saveDraft: async () => {
        const next = collectMainConfig(container, state.main);
        if (rejectOpenAiVersionSuffix(next, '.api-main-base')) return false;
        await api.saveConfig(next);
      },
      fetchFn: () => api.fetchModelsWithError(),
      selectSelector: '.api-main-model-select',
      modelInputSelector: '.api-main-model',
      supportMeta: { apiKind: 'chat', operation: 'fetch-models', config: collectMainConfig(container, state.main) },
    };
    bindModelSelect(container, '.api-main-model-select', '.api-main-model');
    container.querySelector('.api-fetch-main-models')?.addEventListener('click', (e) => {
      handleFetchModels({ button: e.currentTarget, ...mainFetchOpts });
    });

    const toolFetchOpts = {
      saveDraft: async () => {
        const next = collectToolConfig(container, state.tool);
        if (rejectOpenAiVersionSuffix(next, '.api-tool-base')) return false;
        await api.saveToolConfig(next);
      },
      fetchFn: () => api.fetchToolModelsWithError(),
      selectSelector: '.api-tool-model-select',
      modelInputSelector: '.api-tool-model',
      supportMeta: { apiKind: 'tool', operation: 'fetch-models', config: collectToolConfig(container, state.tool) },
    };
    bindModelSelect(container, '.api-tool-model-select', '.api-tool-model');
    container.querySelector('.api-fetch-tool-models')?.addEventListener('click', (e) => {
      handleFetchModels({ button: e.currentTarget, ...toolFetchOpts });
    });

    const sceneFetchOpts = {
      saveDraft: async () => {
        const next = collectSceneConfig(container, state.scene);
        if (rejectOpenAiVersionSuffix(next, '.api-scene-base')) return false;
        await api.saveSceneConfig(next);
      },
      fetchFn: () => api.fetchSceneModelsWithError(),
      selectSelector: '.api-scene-model-select',
      modelInputSelector: '.api-scene-model',
      supportMeta: { apiKind: 'scene', operation: 'fetch-models', config: collectSceneConfig(container, state.scene) },
    };
    bindModelSelect(container, '.api-scene-model-select', '.api-scene-model');
    container.querySelector('.api-fetch-scene-models')?.addEventListener('click', (e) => {
      handleFetchModels({ button: e.currentTarget, ...sceneFetchOpts });
    });

    container.querySelector('.api-save-search')?.addEventListener('click', async () => {
      const next = collectSearchConfig(container, state.search);
      await saveWebSearchConfig(next);
      await syncSectionActivePreset('search', next);
      await reload();
      showToast('搜索 API 已保存');
      await draw();
    });
    if (activeTab === 'search') bindWeiboHotDebugPanel(container);
    container.querySelector('.api-test-social-link')?.addEventListener('click', async () => {
      const btn = container.querySelector('.api-test-social-link');
      const draft = collectSocialLinkConfig(container, state.social);
      const testUrl = getInput(container, '.api-social-test-url');
      const resultBox = container.querySelector('.api-social-test-result');
      if (!testUrl) {
        showToast('请先粘贴一条小红书或微博链接');
        return;
      }
      if (!draft.apiKey) {
        showToast('请先填写 TikHub API Key');
        return;
      }
      if (!draft.enabled) {
        showToast('请先打开「启用」开关');
        return;
      }
      const prevHtml = btn.innerHTML;
      try {
        btn.disabled = true;
        btn.textContent = '解析中...';
        await saveSocialLinkConfig(draft);
        state.social = await loadSocialLinkConfig();
        const result = await testSocialLinkResolve(testUrl, draft);
        if (resultBox) {
          resultBox.style.display = 'block';
          if (result.ok) {
            const d = result.data;
            resultBox.innerHTML = `
              <div><strong>${esc(d.title || '(无标题)')}</strong></div>
              <div style="margin-top:4px;">${esc((d.desc || '').slice(0, 200))}</div>
              ${d.cover ? `<img src="${esc(d.cover)}" style="max-width:160px;border-radius:8px;margin-top:6px;display:block;" />` : ''}
              <div style="margin-top:6px;font-size:12px;color:#8a9299;">作者：${esc(d.author?.name || '-')} · 赞${d.stats?.like ?? 0} 评${d.stats?.comment ?? 0} · 热评 ${(d.comments || []).length} 条${result.cached ? ' · 命中缓存' : ''}</div>
            `;
            showToast(result.cached ? '解析成功（缓存）' : '解析成功，设置已保存');
          } else {
            resultBox.innerHTML = `<div style="color:#c0525f;">${esc(result.error || '解析失败')}</div>`;
            showToast('解析失败');
            const error = new Error(result.error || '解析失败');
            if (result.status) error.status = result.status;
            offerApiHelp(error, {
              apiKind: 'search',
              operation: 'social-link-test',
              config: draft,
            });
          }
        }
      } finally {
        btn.disabled = false;
        btn.innerHTML = prevHtml;
      }
    });
    container.querySelector('.api-save-social')?.addEventListener('click', async () => {
      await saveSocialLinkConfig(collectSocialLinkConfig(container, state.social));
      await reload();
      showToast('深度解析设置已保存');
      await draw();
    });
    container.querySelector('.api-save-map')?.addEventListener('click', async () => {
      const next = collectMapConfig(container, state.map);
      await saveAmapConfig(next);
      await syncSectionActivePreset('map', next);
      await reload();
      showToast('地图 API 已保存');
      await draw();
    });
    container.querySelector('.api-save-meituan-coupon')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        state.couponReminder = await saveMeituanCouponReminderConfig(
          state.couponReminderUser?.id,
          collectMeituanCouponReminderConfig(container, state.couponReminder),
        );
        showToast('美团优惠设置已保存');
        await draw();
      } catch (error) {
        showToast(String(error?.message || error || '保存失败'));
      } finally {
        if (button.isConnected) button.disabled = false;
      }
    });
    container.querySelector('.api-voice-model-select')?.addEventListener('change', (e) => {
      const input = container.querySelector('.api-voice-model');
      if (input) input.style.display = e.target.value === '__custom' ? '' : 'none';
    });
    container.querySelector('.api-fish-model-select')?.addEventListener('change', (e) => {
      const input = container.querySelector('.api-fish-model');
      if (input) input.style.display = e.target.value === '__custom' ? '' : 'none';
    });
    container.querySelector('.api-fish-format')?.addEventListener('change', (e) => {
      const bitrateField = container.querySelector('.api-fish-mp3-bitrate-field');
      bitrateField?.classList.toggle('is-hidden', e.target.value !== 'mp3');
    });
    container.querySelector('.api-voice-provider')?.addEventListener('change', async (e) => {
      const selectedProvider = e.target.value === 'fish' ? 'fish' : 'minimax';
      const previousProvider = state.voice?.provider === 'fish' ? 'fish' : 'minimax';
      e.target.value = previousProvider;
      const next = collectVoiceConfig(container, state.voice);
      next.provider = selectedProvider;
      state.voice = await saveVoiceToolConfig(next);
      await syncSectionActivePreset('voice', state.voice, { clearCombo: false });
      library = await loadPresetLibrary();
      await draw();
    });
    container.querySelector('.api-voice-region')?.addEventListener('change', (e) => {
      const endpoint = container.querySelector('.api-voice-endpoint');
      if (!endpoint) return;
      if (!String(endpoint.value || '').trim() || isKnownVoiceEndpoint(endpoint.value)) {
        endpoint.value = voiceEndpointForRegion(e.target.value);
      }
    });
    container.querySelector('.api-voice-enabled')?.addEventListener('change', async (e) => {
      const checkbox = e.target;
      const enabled = !!checkbox.checked;
      if (enabled && blockKnownUnofficialFishEndpoint(container)) {
        checkbox.checked = false;
        return;
      }
      checkbox.disabled = true;
      try {
        const next = collectVoiceConfig(container, state.voice);
        next.enabled = enabled;
        await saveVoiceToolConfig(next);
        state.voice = await loadVoiceToolConfig();
        await syncSectionActivePreset('voice', state.voice, { clearCombo: false });
        library = await loadPresetLibrary();
        showToast(enabled ? '语音 API 已启用并保存' : '语音 API 已关闭并保存');
        await draw();
      } catch (err) {
        checkbox.checked = !enabled;
        showToast(`启用状态保存失败：${String(err?.message || err).slice(0, 80)}`);
      } finally {
        checkbox.disabled = false;
      }
    });
    container.querySelector('.api-save-voice')?.addEventListener('click', async () => {
      if (blockKnownUnofficialFishEndpoint(container)) return;
      const next = collectVoiceConfig(container, state.voice);
      await saveVoiceToolConfig(next);
      await syncSectionActivePreset('voice', next);
      await reload();
      showToast('语音 API 已保存');
      await draw();
    });
    container.querySelector('.api-test-fish-connectivity')?.addEventListener('click', async () => {
      if (blockKnownUnofficialFishEndpoint(container)) return;
      const btn = container.querySelector('.api-test-fish-connectivity');
      const resultBox = container.querySelector('.api-fish-connectivity-result');
      const draft = collectVoiceConfig(container, state.voice);
      const fishDraft = draft.fish || {};
      const previousText = btn?.textContent || '测试连通性';
      const showResult = (text, isError = false) => {
        if (!resultBox) return;
        resultBox.hidden = false;
        resultBox.textContent = text;
        resultBox.classList.toggle('is-error', isError);
      };
      try {
        if (btn) {
          btn.disabled = true;
          btn.textContent = '正在测试…';
        }
        showResult('正在连接 Fish Audio…');
        const result = await testFishAudioConnectivity({
          endpoint: fishDraft.endpoint,
          apiKey: fishDraft.apiKey,
        });
        const seconds = Math.max(0.1, result.durationMs / 1000).toFixed(1);
        const authText = result.authVerified
          ? 'API Key 有效'
          : (result.status === 401 || result.status === 403 ? '线路可达，填写 Key 后可验证鉴权' : '线路可达');
        showResult(`${authText} · ${result.transport} · HTTP ${result.status} · ${seconds} 秒`);
      } catch (err) {
        const seconds = Math.max(0.1, Number(err?.durationMs || 0) / 1000).toFixed(1);
        showResult(`测试失败 · ${err?.transport || '网络'} · ${seconds} 秒 · ${String(err?.message || err)}`, true);
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.textContent = previousText;
        }
      }
    });
    container.querySelector('.api-manage-voice-cache')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        await openVoiceCacheManager({
          onChanged: async () => {
            state.voiceCacheStats = await getVoiceCacheStats();
            const stats = state.voiceCacheStats || { count: 0, totalBytes: 0 };
            const label = container.querySelector('.api-voice-cache-meta small');
            if (label) label.textContent = `${stats.count || 0} 条 / ${formatBytesLabel(stats.totalBytes)}`;
          },
        });
      } finally {
        if (button.isConnected) button.disabled = false;
      }
    });
    bindModelSelect(container, '.api-stt-model-select', '.api-stt-model');
    container.querySelector('.api-fetch-stt-models')?.addEventListener('click', (event) => {
      handleFetchModels({
        button: event.currentTarget,
        saveDraft: async () => {
          state.voiceInput = await saveVoiceInputConfig(collectSttConfig(container, state.voiceInput));
        },
        fetchFn: () => fetchVoiceInputModels(state.voiceInput),
        selectSelector: '.api-stt-model-select',
        modelInputSelector: '.api-stt-model',
        preferredModels: VOICE_INPUT_MODEL_PREFERENCES,
        supportMeta: {
          apiKind: 'voice',
          operation: 'fetch-transcription-models',
          config: collectSttConfig(container, state.voiceInput),
        },
      });
    });
    container.querySelector('.api-save-stt')?.addEventListener('click', async () => {
      await saveVoiceInputConfig(collectSttConfig(container, state.voiceInput));
      await reload();
      showToast('语音输入已保存');
      await draw();
    });
    container.querySelector('.api-test-stt')?.addEventListener('click', async () => {
      const btn = container.querySelector('.api-test-stt');
      const resultBox = container.querySelector('.api-stt-test-result');
      const draft = collectSttConfig(container, state.voiceInput);
      const prevHtml = btn.innerHTML;
      const showResult = (text, isError = false) => {
        if (!resultBox) return;
        resultBox.style.display = 'block';
        resultBox.innerHTML = isError
          ? `<div style="color:#c0525f;">${esc(text)}</div>`
          : `<div><strong>识别结果：</strong>${esc(text || '(空)')}</div>`;
      };
      try {
        btn.disabled = true;
        const browserNative = draft.provider !== 'custom' && isBrowserSpeechSupported();
        if (!browserNative) {
          btn.textContent = '申请麦克风…';
          await requestMicrophonePermission();
        }
        btn.textContent = '请说话…（最长 8 秒）';
        const session = await startVoiceInputSession({
          config: draft,
          maxMs: 8000,
          skipMicWarmup: true,
          onPartial: (partial) => {
            const chunk = String(partial || '').trim();
            if (!chunk) return;
            btn.textContent = `正在听… ${chunk.slice(0, 12)}${chunk.length > 12 ? '…' : ''}`;
          },
        });
        let text = '';
        try {
          text = await session.promise;
        } catch (err) {
          if (draft.endpoint && draft.provider !== 'custom') {
            showResult('浏览器原生未识别到文字，正在改走转写接口…', true);
            btn.textContent = '转写接口录音中…';
            await requestMicrophonePermission();
            const fallback = await startVoiceInputSession({
              config: { ...draft, provider: 'custom' },
              maxMs: 8000,
              skipMicWarmup: true,
            });
            text = await fallback.promise;
          } else {
            throw err;
          }
        }
        if (text) {
          showResult(text);
          showToast('听写测试成功');
        } else {
          showResult('没有听到可用文字，请靠近麦克风重试', true);
        }
      } catch (err) {
        showResult(formatVoiceInputError(err, draft), true);
        offerApiHelp(err, {
          apiKind: 'voice',
          operation: 'speech-recognition-test',
          config: draft,
        });
      } finally {
        btn.disabled = false;
        btn.innerHTML = prevHtml;
      }
    });

    bindModelSelect(container, '.api-real-model-select', '.api-real-model');
    // Provider 与启用开关双向同步，避免「启用开着但 Provider=关闭」再测失败
    const syncImageProviderToggle = (providerSel, enabledSel, onValue) => {
      const provider = container.querySelector(providerSel);
      const enabled = container.querySelector(enabledSel);
      if (!provider || !enabled) return;
      enabled.addEventListener('change', () => {
        provider.value = enabled.checked ? onValue : 'off';
      });
      provider.addEventListener('change', () => {
        enabled.checked = provider.value === onValue;
      });
      // 仅修复「启用已开、Provider 仍关闭」；不要把用户关掉的启用又打开
      if (enabled.checked && provider.value === 'off') provider.value = onValue;
    };
    syncImageProviderToggle('.api-real-provider', '.api-real-enabled', 'openai_compatible');
    syncImageProviderToggle('.api-image-character-provider', '.api-novelai-enabled', 'novelai');
    container.querySelector('.api-fetch-image-models')?.addEventListener('click', (e) => {
      const draft = collectImageConfig(container, state.image);
      handleFetchModels({
        button: e.currentTarget,
        saveDraft: async () => {},
        fetchFn: () => fetchRealisticImageModelsWithError({
          config: draft,
          endpoint: draft.realistic?.endpoint,
          apiKey: draft.realistic?.apiKey,
        }),
        selectSelector: '.api-real-model-select',
        modelInputSelector: '.api-real-model',
        supportMeta: {
          apiKind: 'image',
          operation: 'fetch-models',
          config: {
            endpoint: draft.realistic?.endpoint,
            apiKey: draft.realistic?.apiKey,
            model: draft.realistic?.model,
          },
        },
      });
    });
    bindModelSelect(container, '.api-novelai-model-select', '.api-novelai-model');
    container.querySelector('.api-test-novelai')?.addEventListener('click', async () => {
      const btn = container.querySelector('.api-test-novelai');
      const draft = collectImageConfig(container, state.image);
      try {
        btn.disabled = true;
        btn.textContent = '测试中...';
        const result = await testNovelAiImageGeneration({ config: draft });
        if (result.ok) {
          showToast(`NovelAI 测试成功：${[result.model, result.size].filter(Boolean).join(' / ')}`);
          openImagePreviewModal(result.url, 'NovelAI 测试结果');
        } else {
          showToast(`NovelAI 测试失败：${String(result.error || '').slice(0, 300)}`, 8000);
          const failure = result.errorObject instanceof Error
            ? result.errorObject
            : new Error(result.error || 'NovelAI 测试失败');
          offerApiHelp(failure, {
            apiKind: 'image',
            operation: 'novelai-test',
            reason: result.reason || '',
            title: 'NovelAI 测试失败',
            responseText: result.responseText || '',
            usedUrl: result.usedUrl || '',
            transport: result.transport || '',
            config: {
              endpoint: draft.novelAi?.endpoint,
              apiKey: draft.novelAi?.apiKey,
              model: draft.novelAi?.model,
            },
          });
        }
      } finally {
        btn.disabled = false;
        btn.innerHTML = `${icon('image')}测试 NovelAI`;
      }
    });
    container.querySelector('.api-test-image-generation')?.addEventListener('click', async () => {
      const btn = container.querySelector('.api-test-image-generation');
      const draft = collectImageConfig(container, state.image);
      try {
        btn.disabled = true;
        btn.textContent = '测试中...';
        const result = await testRealisticImageGeneration({ config: draft });
        if (result.ok) {
          showToast(`生图测试成功：${[result.model, result.size].filter(Boolean).join(' / ')}`);
          openImagePreviewModal(result.url, '兼容生图测试结果');
        } else {
          showToast(`生图测试失败：${String(result.error || '').slice(0, 120)}`);
          offerApiHelp(result.errorObject || new Error(result.error || '生图测试失败'), {
            apiKind: 'image',
            operation: 'generation-test',
            config: {
              endpoint: draft.realistic?.endpoint,
              apiKey: draft.realistic?.apiKey,
              model: draft.realistic?.model,
            },
          });
        }
      } finally {
        btn.disabled = false;
        btn.innerHTML = `${icon('image')}测试生图`;
      }
    });
    container.querySelector('.api-save-image')?.addEventListener('click', async () => {
      const next = collectImageConfig(container, state.image);
      await saveImageToolConfig(next);
      await syncSectionActivePreset('image', next);
      await reload();
      showToast('生图 API 已保存');
      await draw();
    });

    container.querySelectorAll('.api-section-preset-save').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const sectionId = String(btn.dataset.section || '');
        const block = btn.closest('[data-section-presets]');
        const name = block?.querySelector('.api-section-preset-name')?.value?.trim();
        if (!name) {
          showToast('请先填写预设名称');
          return;
        }
        let value = {};
        if (sectionId === 'main') value = collectMainConfig(container, state.main);
        else if (sectionId === 'scene') value = collectSceneConfig(container, state.scene);
        else if (sectionId === 'tool') value = collectToolConfig(container, state.tool);
        else if (sectionId === 'embedding') value = collectEmbeddingConfig(container, state.embedding);
        else if (sectionId === 'search') value = collectSearchConfig(container, state.search);
        else if (sectionId === 'map') value = collectMapConfig(container, state.map);
        else if (sectionId === 'voice') value = collectVoiceConfig(container, state.voice);
        else if (sectionId === 'image') value = collectImageConfig(container, state.image);
        const preset = await saveSectionPreset(sectionId, name, value);
        await applySnapshot({ [sectionId]: value });
        await setActiveSectionPreset(sectionId, preset.id);
        state[sectionId] = { ...(value || {}) };
        library = await loadPresetLibrary();
        showToast(`已保存并应用：${name}`);
        await draw();
      });
    });
    container.querySelectorAll('.api-section-preset-apply').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const item = btn.closest('[data-section-preset-id]');
        const sectionId = String(item?.dataset.section || '');
        const presetId = String(item?.dataset.sectionPresetId || '');
        const idleText = btn.textContent;
        btn.disabled = true;
        btn.textContent = '应用中…';
        try {
          const preset = await applySectionPreset(sectionId, presetId);
          state[sectionId] = { ...(preset.value || {}) };
          library = await loadPresetLibrary();
          showToast(`已应用：${preset.name}`);
          await draw();
        } catch (err) {
          btn.disabled = false;
          btn.textContent = idleText;
          showToast(String(err?.message || err));
        }
      });
    });
    container.querySelectorAll('.api-section-preset-delete').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const item = btn.closest('[data-section-preset-id]');
        const sectionId = String(item?.dataset.section || '');
        const presetId = String(item?.dataset.sectionPresetId || '');
        await deleteSectionPreset(sectionId, presetId);
        library = await loadPresetLibrary();
        showToast('预设已删除');
        await draw();
      });
    });

    container.querySelector('.api-combo-ref-save')?.addEventListener('click', async () => {
      const name = getInput(container, '.api-combo-ref-name');
      if (!name) {
        showToast('请填写组合名称');
        return;
      }
      const refs = {};
      container.querySelectorAll('.api-combo-ref').forEach((sel) => {
        const sectionId = String(sel.dataset.section || '');
        const value = String(sel.value || '').trim();
        if (sectionId && value) refs[sectionId] = value;
      });
      if (!Object.keys(refs).length) {
        showToast('请至少选择一项分类预设');
        return;
      }
      await saveComboPreset({ name, mode: 'reference', refs });
      await reload();
      showToast(`已保存引用组合：${name}`);
      await draw();
    });
    container.querySelector('.api-combo-snapshot-save')?.addEventListener('click', async () => {
      const name = getInput(container, '.api-combo-snapshot-name');
      if (!name) {
        showToast('请填写组合名称');
        return;
      }
      const snapshot = buildSnapshotFromState({
        main: collectMainConfig(container, state.main),
        scene: collectSceneConfig(container, state.scene),
        tool: collectToolConfig(container, state.tool),
        embedding: collectEmbeddingConfig(container, state.embedding),
        search: collectSearchConfig(container, state.search),
        map: collectMapConfig(container, state.map),
        voice: collectVoiceConfig(container, state.voice),
        image: collectImageConfig(container, state.image),
      });
      await saveComboPreset({ name, mode: 'snapshot', snapshot });
      await reload();
      showToast(`已保存全套：${name}`);
      await draw();
    });
    container.querySelectorAll('.api-combo-apply').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const comboId = String(btn.closest('[data-combo-id]')?.dataset.comboId || '');
        try {
          const combo = await applyComboPreset(comboId);
          await reload();
          showToast(`已应用组合：${combo.name}`);
          await draw();
        } catch (err) {
          showToast(String(err?.message || err));
        }
      });
    });
    container.querySelectorAll('.api-combo-delete').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const comboId = String(btn.closest('[data-combo-id]')?.dataset.comboId || '');
        await deleteComboPreset(comboId);
        await reload();
        showToast('组合已删除');
        await draw();
      });
    });

    container.querySelector('.api-export-settings')?.addEventListener('click', async () => {
      const payload = await exportApiSettingsPayload(state);
      downloadText(JSON.stringify(payload, null, 2), `marshmallow-api-settings-${Date.now()}.json`);
      showToast('API 设置已导出');
    });
    container.querySelector('.api-import-settings')?.addEventListener('click', async () => {
      if (!window.confirm('导入会覆盖当前 API 设置与预设库。继续？')) return;
      try {
        const ok = await importApiSettingsFile();
        if (ok) {
          await reload();
          showToast('API 设置已导入');
          await draw();
        }
      } catch (err) {
        showToast(`导入失败：${String(err?.message || err).slice(0, 100)}`);
      }
    });
  }

  await ensureTabAuxiliary(activeTab);
  await draw();
  void loadTabDiagnostics(activeTab);
  deferApiManagerIdleWork(() => {
    void syncActivePresetsIfNeeded();
    void ensureTabAuxiliary('support');
    void ensureTabAuxiliary('search');
    void ensureTabAuxiliary('voice');
    void ensureTabAuxiliary('life');
    void loadTabDiagnostics('llm');
    void loadTabDiagnostics('search');
  });
}
