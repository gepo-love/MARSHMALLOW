import {
  applySectionPreset,
  listApiSectionPresetOptions,
  syncSectionActivePreset,
} from '../core/api-presets.js';
import {
  fetchModelsWithError,
  getConfig as getApiConfig,
  getSceneConfig,
  saveConfig as saveApiConfig,
  saveSceneConfig,
} from '../core/api.js';
import { copyTextToClipboard } from '../core/chat-helpers.js';
import { listMessagesForChat } from '../core/chat-store.js';
import {
  buildGenerationErrorCopyText,
  loadLastGenerationError,
  openGenerationErrorDetail,
} from '../core/generation-error-guide.js';
import {
  getDefaultQuickBallPosition,
  loadQuickBallPrefs,
  QUICK_BALL_ACTION_DEFS,
  QUICK_BALL_POSITION_KEY,
  QUICK_BALL_POSITION_RESET_EVENT,
  QUICK_BALL_PREFS_EVENT,
} from '../core/quick-ball-prefs.js';
import { currentRoute, currentRouteParams, navigate } from '../core/router.js';
import { captureSupportIncident } from '../core/support/support-context.js';
import {
  advanceVirtualTime,
  ensureTimeSchedule,
  formatGapHint,
  formatPromptTimeLine,
  getNowForUser,
  getUserTimezone,
  setVirtualNow,
  setVirtualTimePaused,
} from '../core/time-mode.js';
import { getCurrentUserId } from '../core/user-slot.js';
import { icon } from './svg-icons.js';
import { showToast } from './toast.js';

const BALL_SIZE = 46;
const EDGE_INSET = 8;
const BOTTOM_GUARD = 82;
const API_SWITCH_SECTIONS = {
  main: { id: 'main', title: '主 API', empty: '还没有主 API 预设' },
  scene: { id: 'scene', title: '线下 API', empty: '还没有场景叙事预设' },
};

let rootEl = null;
let panelEl = null;
let modalObserver = null;
let observedModalEl = null;
let bodyObserver = null;
let observedAppEl = null;
let repairFrame = 0;
let repairTimer = 0;
let healthTimer = 0;
let emptyModalCleanupTimer = 0;
let globalEventsBound = false;
let state = {
  prefs: null,
  pos: null,
  open: false,
  dragging: false,
  presetMode: false,
  timeModePanel: false,
  presetSection: 'main',
  models: [],
  selectedModel: '',
  modelsLoading: false,
};

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function loadPosition() {
  try {
    const raw = JSON.parse(localStorage.getItem(QUICK_BALL_POSITION_KEY) || '');
    if (!raw || (raw.side !== 'left' && raw.side !== 'right')) return null;
    const topRatio = Number(raw.topRatio);
    return { side: raw.side, topRatio: Number.isFinite(topRatio) ? Math.max(0, Math.min(1, topRatio)) : 0.42 };
  } catch (_) {
    return null;
  }
}

function savePosition() {
  try { localStorage.setItem(QUICK_BALL_POSITION_KEY, JSON.stringify(state.pos)); } catch (_) {}
}

function maxTop() {
  const safeBottom = Number.parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue('--safe-bottom') || '',
  ) || 0;
  return Math.max(EDGE_INSET, window.innerHeight - BALL_SIZE - BOTTOM_GUARD - safeBottom);
}

function topForPosition(pos = state.pos) {
  return Math.round(EDGE_INSET + ((maxTop() - EDGE_INSET) * (pos?.topRatio ?? 0.42)));
}

function avoidDockOverlap(pos) {
  if (pos?.side !== 'right') return pos;
  try {
    const dock = JSON.parse(localStorage.getItem('companionDockPos') || '');
    const dockTop = window.innerHeight - (Number(dock?.bottom) || 96) - 72;
    if (Math.abs(topForPosition(pos) - dockTop) < 86) {
      return { ...pos, topRatio: topForPosition(pos) < dockTop ? 0.22 : 0.68 };
    }
  } catch (_) {}
  return pos;
}

function applyPosition() {
  if (!rootEl || !state.pos) return;
  rootEl.classList.toggle('quick-ball--left', state.pos.side === 'left');
  rootEl.classList.toggle('quick-ball--right', state.pos.side === 'right');
  rootEl.style.top = `${topForPosition()}px`;
}

function runQuickBallRepair() {
  if (repairFrame) window.cancelAnimationFrame(repairFrame);
  if (repairTimer) window.clearTimeout(repairTimer);
  repairFrame = 0;
  repairTimer = 0;
  bindBodyObserver();
  bindModalObserver();
  syncModalVisibility();
  applyPosition();
}

function scheduleQuickBallRepair() {
  if (document.visibilityState === 'hidden') return;
  // Android WebView 在页面恢复、键盘收起或主线程繁忙时偶尔会把 rAF 延后很久。
  // 同时保留短 timeout 兜底，任一路径先执行都会取消另一条，不重复修复。
  if (!repairFrame) repairFrame = window.requestAnimationFrame(runQuickBallRepair);
  if (!repairTimer) repairTimer = window.setTimeout(runQuickBallRepair, 400);
}

function startQuickBallHealthCheck() {
  if (healthTimer) return;
  healthTimer = window.setInterval(() => {
    if (document.visibilityState !== 'hidden' && state.prefs?.enabled) {
      scheduleQuickBallRepair();
    }
  }, 5000);
}

function enabledActions() {
  return QUICK_BALL_ACTION_DEFS.filter((item) => state.prefs?.actions?.[item.id] !== false);
}

function renderPanel() {
  if (!panelEl) return;
  const isLeft = state.pos?.side === 'left';
  panelEl.className = `quick-ball-panel ${isLeft ? 'quick-ball-panel--left' : 'quick-ball-panel--right'}`;
  panelEl.hidden = !state.open;
  if (!state.open) return;

  if (state.timeModePanel) {
    panelEl.innerHTML = `
      <div class="quick-ball-panel-head">
        <button type="button" class="quick-ball-back" data-quick-ball-back aria-label="返回">${icon('back')}</button>
        <strong>剧情时间</strong>
      </div>
      <div class="quick-ball-time-panel" data-quick-ball-time>正在读取时间…</div>
    `;
    panelEl.querySelector('[data-quick-ball-back]')?.addEventListener('click', () => {
      state.timeModePanel = false;
      renderPanel();
    });
    renderTimePanel();
    return;
  }

  if (state.presetMode) {
    const section = API_SWITCH_SECTIONS[state.presetSection] || API_SWITCH_SECTIONS.main;
    panelEl.innerHTML = `
      <div class="quick-ball-panel-head">
        <button type="button" class="quick-ball-back" data-quick-ball-back aria-label="返回">${icon('back')}</button>
        <strong>${section.title}</strong>
      </div>
      <div class="quick-ball-preset-list" data-quick-ball-presets>正在读取配置…</div>
    `;
    panelEl.querySelector('[data-quick-ball-back]')?.addEventListener('click', () => {
      state.presetMode = false;
      renderPanel();
    });
    renderPresetList();
    return;
  }

  const actions = enabledActions();
  panelEl.innerHTML = actions.length
    ? actions.map((item) => `
      <button type="button" class="quick-ball-action" data-quick-ball-action="${item.id}">
        ${icon(item.icon)}
        <span>${escapeHtml(item.label)}</span>
      </button>
    `).join('')
    : '<div class="quick-ball-empty">请先在设置里选择快捷项</div>';
  panelEl.querySelectorAll('[data-quick-ball-action]').forEach((button) => {
    button.addEventListener('click', () => runAction(button.dataset.quickBallAction));
  });
}

function latestStoryMessageTimestamp(messages = []) {
  return (Array.isArray(messages) ? messages : []).reduce((latest, message) => {
    if (!message || message.deleted || message.recalled || message.metadata?.aiPlaceholder === true) return latest;
    if (message.senderId === 'system' || message.type === 'system' || message.type === 'storyCard') return latest;
    return Math.max(latest, Number(message.timestamp || 0) || 0);
  }, 0);
}

async function renderTimePanel() {
  const host = panelEl?.querySelector('[data-quick-ball-time]');
  if (!host || !state.timeModePanel) return;
  const userId = await getCurrentUserId().catch(() => '');
  if (!userId) {
    host.innerHTML = '<div class="quick-ball-empty">当前没有可用档位</div>';
    return;
  }
  const route = currentRoute();
  const routeParams = currentRouteParams();
  const chatId = route === 'chat/thread' ? String(routeParams?.chatId || '').trim() : '';
  const [schedule, now, timeZone, messages] = await Promise.all([
    ensureTimeSchedule(userId),
    getNowForUser(userId),
    getUserTimezone(userId),
    // 这里只需要末条剧情时间。禁止为了打开快捷球克隆整窗聊天；少量尾页足以
    // 跨过常见的系统提示、故事卡和占位消息，同时让三万条会话保持 O(1) 读取。
    chatId ? listMessagesForChat(chatId, 40).catch(() => []) : Promise.resolve([]),
  ]);
  if (!host.isConnected || !state.timeModePanel) return;
  const lastMessageTs = latestStoryMessageTimestamp(messages);
  const paused = schedule.timeMode === 'virtual' && schedule.paused === true;
  host.innerHTML = `
    <div class="quick-ball-time-current">
      <strong>${escapeHtml(formatPromptTimeLine(now, timeZone))}</strong>
      <small>${paused ? '剧情时间已暂停' : (schedule.timeMode === 'virtual' ? '虚拟时间随现实流逝' : '现实同步')}</small>
    </div>
    <div class="quick-ball-time-actions">
      <button type="button" class="quick-ball-preset" data-time-action="pause">
        <strong>${paused ? '继续流逝' : '暂停剧情时间'}</strong>
        <small>${paused ? '从当前剧情时刻继续' : '离开屏幕也不再跳过几小时'}</small>
      </button>
      <button type="button" class="quick-ball-preset" data-time-action="align" ${lastMessageTs ? '' : 'disabled'}>
        <strong>接到本窗末条</strong>
        <small>${lastMessageTs ? '自动定位到最后一条消息之后' : '请先打开一个聊天窗口'}</small>
      </button>
    </div>
    <div class="quick-ball-time-step-row">
      <button type="button" class="quick-ball-model-button" data-time-action="advance" data-delta="900000">+15 分</button>
      <button type="button" class="quick-ball-model-button" data-time-action="advance" data-delta="3600000">+1 小时</button>
    </div>
    <button type="button" class="quick-ball-manage" data-time-action="settings">完整时间设置</button>
  `;
  host.querySelectorAll('[data-time-action]').forEach((button) => {
    button.addEventListener('click', async () => {
      if (button.disabled) return;
      const action = String(button.dataset.timeAction || '');
      if (action === 'settings') {
        closePanel();
        navigate('calendar');
        return;
      }
      button.disabled = true;
      try {
        if (action === 'pause') {
          await setVirtualTimePaused(userId, !paused);
          showToast(paused ? '剧情时间已继续流逝' : '剧情时间已暂停');
        } else if (action === 'advance') {
          const next = await advanceVirtualTime(userId, Number(button.dataset.delta || 0));
          showToast(`已推进至 ${formatPromptTimeLine(next, timeZone)}`);
        } else if (action === 'align' && lastMessageTs) {
          const target = lastMessageTs + 60 * 1000;
          const current = await getNowForUser(userId);
          if (
            target < current - 5 * 60 * 1000
            && !window.confirm(`世界时间将回拨约 ${formatGapHint(current - target)}，并影响这个档位下的全部聊天。确定接到本窗末条吗？`)
          ) return;
          await setVirtualNow(userId, target);
          showToast('已接到本窗最后一条消息之后');
        }
        await renderTimePanel();
      } finally {
        if (button.isConnected) button.disabled = false;
      }
    });
  });
}

async function renderPresetList() {
  const host = panelEl?.querySelector('[data-quick-ball-presets]');
  if (!host || !state.presetMode) return;
  const section = API_SWITCH_SECTIONS[state.presetSection] || API_SWITCH_SECTIONS.main;
  const [config, options] = await Promise.all([
    (section.id === 'scene' ? getSceneConfig() : getApiConfig()).catch(() => ({})),
    listApiSectionPresetOptions(section.id).catch(() => []),
  ]);
  if (!host.isConnected || !state.presetMode || state.presetSection !== section.id) return;
  const currentModel = String(config?.model || '').trim();
  if (!state.selectedModel) state.selectedModel = currentModel;
  const models = [...new Set([currentModel, ...state.models].filter(Boolean))];
  const modelOptions = models.length
    ? models.map((model) => `<option value="${escapeHtml(model)}" ${model === state.selectedModel ? 'selected' : ''}>${escapeHtml(model)}</option>`).join('')
    : '<option value="">请先读取模型</option>';
  const presetHtml = options.length
    ? options.map((item) => `
        <button type="button" class="quick-ball-preset" data-quick-ball-preset="${escapeHtml(item.id)}">
          <strong>${escapeHtml(item.name || '未命名预设')}</strong>
          <small>${escapeHtml(item.model || '未填写模型')}</small>
        </button>
      `).join('')
    : `<div class="quick-ball-empty">${section.empty}</div>`;
  const currentSceneHtml = section.id === 'scene'
    ? `
      <div class="quick-ball-list-label">当前：${escapeHtml(config?.useCustom ? (currentModel || '独立 API') : '跟随主 API')}</div>
      ${config?.useCustom ? `
        <button type="button" class="quick-ball-preset" data-quick-ball-follow-main>
          <strong>跟随主 API</strong>
          <small>停用线下独立配置</small>
        </button>
      ` : ''}
    `
    : '';
  const modelEditorHtml = section.id === 'main'
    ? `
      <div class="quick-ball-model-editor">
        <label for="quick-ball-model-select">当前配置的模型</label>
        <select id="quick-ball-model-select" class="quick-ball-model-select" data-quick-ball-model ${models.length ? '' : 'disabled'}>
          ${modelOptions}
        </select>
        <div class="quick-ball-model-actions">
          <button type="button" class="quick-ball-model-button" data-quick-ball-fetch-models ${state.modelsLoading ? 'disabled' : ''}>${state.modelsLoading ? '读取中…' : '读取模型'}</button>
          <button type="button" class="quick-ball-model-button is-primary" data-quick-ball-save-model ${state.selectedModel ? '' : 'disabled'}>保存</button>
        </div>
      </div>
    `
    : currentSceneHtml;
  host.innerHTML = `
    ${modelEditorHtml}
    <div class="quick-ball-list-label">或切换预设</div>
    ${presetHtml}
    <button type="button" class="quick-ball-manage" data-quick-ball-manage>API 管理</button>
  `;
  host.querySelector('[data-quick-ball-model]')?.addEventListener('change', (event) => {
    state.selectedModel = String(event.currentTarget.value || '').trim();
    const save = host.querySelector('[data-quick-ball-save-model]');
    if (save) save.disabled = !state.selectedModel;
  });
  host.querySelector('[data-quick-ball-fetch-models]')?.addEventListener('click', async () => {
    if (state.modelsLoading) return;
    state.modelsLoading = true;
    await renderPresetList();
    try {
      const result = await fetchModelsWithError();
      state.models = Array.isArray(result?.models)
        ? result.models.filter(Boolean).slice().sort((a, b) => String(a).localeCompare(String(b)))
        : [];
      if (!state.selectedModel && state.models.length) state.selectedModel = state.models[0];
      showToast(state.models.length ? `已读取 ${state.models.length} 个模型` : (result?.error || '未读取到模型'));
    } catch (err) {
      showToast(`读取失败：${String(err?.message || err).slice(0, 80)}`);
    } finally {
      state.modelsLoading = false;
      await renderPresetList();
    }
  });
  host.querySelector('[data-quick-ball-follow-main]')?.addEventListener('click', async () => {
    try {
      const next = { ...config, useCustom: false };
      await saveSceneConfig(next);
      await syncSectionActivePreset('scene', next);
      showToast('线下 API 已改为跟随主 API');
      closePanel();
    } catch (err) {
      showToast(err?.message || '切换失败');
    }
  });
  host.querySelector('[data-quick-ball-save-model]')?.addEventListener('click', async () => {
    const model = String(host.querySelector('[data-quick-ball-model]')?.value || state.selectedModel || '').trim();
    if (!model) return;
    try {
      const next = { ...config, model };
      await saveApiConfig(next);
      await syncSectionActivePreset('main', next);
      state.selectedModel = model;
      showToast(`已保存模型：${model}`);
      closePanel();
    } catch (err) {
      showToast(err?.message || '保存失败');
    }
  });
  host.querySelector('[data-quick-ball-manage]')?.addEventListener('click', () => {
    closePanel();
    navigate('settings/api');
  });
  host.querySelectorAll('[data-quick-ball-preset]').forEach((button) => {
    button.addEventListener('click', async () => {
      const preset = await applySectionPreset(section.id, button.dataset.quickBallPreset).catch((err) => {
        showToast(err?.message || '切换失败');
        return null;
      });
      if (!preset) return;
      state.selectedModel = String(preset.value?.model || '').trim();
      state.models = [];
      showToast(`已切换至 ${preset.name || `${section.title} 预设`}`);
      closePanel();
    });
  });
}

function closePanel() {
  state.open = false;
  state.presetMode = false;
  state.modelsLoading = false;
  rootEl?.classList.remove('is-open');
  rootEl?.querySelector('.quick-ball-trigger')?.setAttribute('aria-expanded', 'false');
  renderPanel();
}

function hasVisibleModalContent(modal) {
  if (!modal?.classList.contains('active')) return false;
  return [...modal.children].some((child) => (
    child instanceof HTMLElement
    && !child.hidden
    && child.getAttribute('aria-hidden') !== 'true'
    && getComputedStyle(child).display !== 'none'
    && getComputedStyle(child).visibility !== 'hidden'
  ));
}

function clearEmptyModalCleanup() {
  if (!emptyModalCleanupTimer) return;
  window.clearTimeout(emptyModalCleanupTimer);
  emptyModalCleanupTimer = 0;
}

function scheduleEmptyModalCleanup(modal) {
  if (emptyModalCleanupTimer) return;
  emptyModalCleanupTimer = window.setTimeout(() => {
    emptyModalCleanupTimer = 0;
    if (!modal?.classList.contains('active') || hasVisibleModalContent(modal)) return;
    modal.classList.remove('active', 'has-floating-call', 'has-app-group-overlay');
    syncModalVisibility();
  }, 250);
}

function syncModalVisibility() {
  if (rootEl && !rootEl.isConnected) {
    rootEl = null;
    panelEl = null;
    state.open = false;
    state.dragging = false;
    state.presetMode = false;
    state.timeModePanel = false;
  }
  if (!rootEl && state.prefs?.enabled) renderRoot();
  if (!rootEl) return;
  const modal = document.getElementById('modal-container');
  const blocked = hasVisibleModalContent(modal);
  // 异步弹层异常退出时可能只留下 active 空壳。它既不该继续吞触摸，也不该让
  // 悬浮球永久消失。给正常异步挂载留出一小段时间，子节点出现后观察器会立刻复核。
  if (modal?.classList.contains('active') && !blocked) scheduleEmptyModalCleanup(modal);
  else clearEmptyModalCleanup();
  if (blocked && state.open) closePanel();
  rootEl.hidden = blocked;
  rootEl.dataset.quickBallVisibility = blocked ? 'modal' : 'visible';
}

function togglePanel() {
  state.open = !state.open;
  state.presetMode = false;
  state.timeModePanel = false;
  rootEl?.classList.toggle('is-open', state.open);
  rootEl?.querySelector('.quick-ball-trigger')?.setAttribute('aria-expanded', String(state.open));
  renderPanel();
}

async function runAction(actionId) {
  if (actionId === 'feedback') {
    closePanel();
    const diagnostic = captureSupportIncident({
      code: 'quick-feedback',
      scope: '快捷悬浮球',
      message: '用户从当前页面快速反馈问题',
      operation: '提交问题反馈',
    });
    navigate('support', { incidentId: diagnostic.incidentId, feedback: '1' });
    return;
  }
  if (actionId === 'support') {
    closePanel();
    const diagnostic = captureSupportIncident({
      code: 'support-opened',
      scope: '快捷悬浮球',
      message: '用户从当前页面打开芥末棉花糖',
      operation: '从当前场景呼出芥末棉花糖',
    });
    navigate('support', { incidentId: diagnostic.incidentId });
    return;
  }
  if (actionId === 'rescue') {
    const error = loadLastGenerationError();
    if (!error) return showToast('最近没有捕获到报错');
    closePanel();
    await openGenerationErrorDetail(error);
    return;
  }
  if (actionId === 'copyFeedback') {
    const error = loadLastGenerationError();
    if (!error) return showToast('最近没有可复制的报错');
    const ok = await copyTextToClipboard(buildGenerationErrorCopyText(error));
    showToast(ok ? '反馈包已复制' : '复制失败');
    return;
  }
  if (actionId === 'apiSwitch') {
    state.models = [];
    state.selectedModel = '';
    state.presetSection = 'main';
    state.presetMode = true;
    renderPanel();
    return;
  }
  if (actionId === 'offlineApiSwitch') {
    state.models = [];
    state.selectedModel = '';
    state.presetSection = 'scene';
    state.presetMode = true;
    renderPanel();
    return;
  }
  if (actionId === 'worldTime') {
    state.timeModePanel = true;
    state.presetMode = false;
    renderPanel();
    return;
  }
  if (actionId === 'reload') {
    window.location.reload();
  }
}

function bindDrag(button) {
  let startX = 0;
  let startY = 0;
  let moved = false;
  let activePointerId = null;

  button.addEventListener('pointerdown', (event) => {
    if (event.button != null && event.button !== 0) return;
    if (activePointerId != null) return;
    activePointerId = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;
    moved = false;
    state.dragging = true;
    button.setPointerCapture?.(event.pointerId);
  });
  button.addEventListener('pointermove', (event) => {
    if (!state.dragging || event.pointerId !== activePointerId) return;
    if (Math.hypot(event.clientX - startX, event.clientY - startY) < 6) return;
    moved = true;
    const top = Math.max(EDGE_INSET, Math.min(maxTop(), event.clientY - (BALL_SIZE / 2)));
    state.pos = {
      side: event.clientX < window.innerWidth / 2 ? 'left' : 'right',
      topRatio: (top - EDGE_INSET) / Math.max(1, maxTop() - EDGE_INSET),
    };
    applyPosition();
  });
  const finish = (event) => {
    if (event?.pointerId != null && event.pointerId !== activePointerId) return;
    if (!state.dragging) return;
    state.dragging = false;
    activePointerId = null;
    if (moved) {
      state.pos = avoidDockOverlap(state.pos);
      savePosition();
      applyPosition();
    }
  };
  button.addEventListener('pointerup', finish);
  button.addEventListener('pointercancel', finish);
  button.addEventListener('lostpointercapture', finish);
  button.addEventListener('click', (event) => {
    if (moved) {
      event.preventDefault();
      return;
    }
    togglePanel();
  });
}

function bindModalObserver() {
  if (typeof MutationObserver === 'undefined') return;
  const modal = document.getElementById('modal-container');
  if (modalObserver && observedModalEl === modal) return;
  modalObserver?.disconnect();
  modalObserver = null;
  observedModalEl = modal;
  if (!modal) return;
  modalObserver = new MutationObserver(scheduleQuickBallRepair);
  modalObserver.observe(modal, {
    attributes: true,
    attributeFilter: ['class', 'style', 'hidden', 'aria-hidden'],
    childList: true,
    subtree: true,
  });
}

function bindBodyObserver() {
  if (typeof MutationObserver === 'undefined' || !document.body) return;
  const app = document.getElementById('app');
  if (bodyObserver && observedAppEl === app) return;
  bodyObserver?.disconnect();
  observedAppEl = app;
  bodyObserver = new MutationObserver(() => {
    if (!rootEl?.isConnected || observedModalEl !== document.getElementById('modal-container')) {
      scheduleQuickBallRepair();
    }
  });
  // 悬浮球是 body 直属节点，#modal-container 是 #app 直属节点；分别观察这两层
  // 即可覆盖重建，同时避免聊天消息变化不断触发全 body 子树观察器。
  bodyObserver.observe(document.body, { childList: true });
  if (app) bodyObserver.observe(app, { childList: true });
}

function bindGlobalEvents() {
  if (globalEventsBound) return;
  globalEventsBound = true;
  window.addEventListener('resize', scheduleQuickBallRepair);
  window.addEventListener('orientationchange', scheduleQuickBallRepair);
  window.visualViewport?.addEventListener('resize', scheduleQuickBallRepair);
  window.visualViewport?.addEventListener('scroll', scheduleQuickBallRepair);
  document.addEventListener('pointerdown', (event) => {
    if (state.open && rootEl && !rootEl.contains(event.target)) closePanel();
  }, true);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.open) closePanel();
  });
  window.addEventListener(QUICK_BALL_PREFS_EVENT, (event) => {
    state.prefs = event.detail;
    if (!state.prefs?.enabled) {
      closePanel();
      rootEl?.remove();
      rootEl = null;
      panelEl = null;
      return;
    }
    if (rootEl && !rootEl.isConnected) {
      rootEl = null;
      panelEl = null;
    }
    if (!rootEl) renderRoot();
    renderPanel();
    scheduleQuickBallRepair();
  });
  window.addEventListener(QUICK_BALL_POSITION_RESET_EVENT, (event) => {
    state.pos = avoidDockOverlap(event.detail || getDefaultQuickBallPosition());
    closePanel();
    // “重置位置”同时也是用户主动发出的恢复请求：节点若被页面重建误删，
    // 不能只改一份坐标然后提示成功，必须当场重新挂载并复核显隐。
    if (state.prefs?.enabled !== false) {
      if (!state.prefs) state.prefs = { enabled: true, actions: {} };
      runQuickBallRepair();
    } else {
      applyPosition();
    }
  });
  window.addEventListener('marshmallow-route-activated', scheduleQuickBallRepair);
  window.addEventListener('pageshow', scheduleQuickBallRepair);
  window.addEventListener('focus', scheduleQuickBallRepair);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') scheduleQuickBallRepair();
  });
  bindModalObserver();
  bindBodyObserver();
  syncModalVisibility();
}

function renderRoot() {
  if (rootEl || !state.prefs?.enabled) return;
  rootEl = document.createElement('aside');
  rootEl.className = 'quick-ball quick-ball--left';
  rootEl.setAttribute('aria-label', '快捷工具');
  rootEl.innerHTML = `
    <button type="button" class="quick-ball-trigger" aria-label="打开快捷工具" aria-expanded="false">
      <span class="quick-ball-orb" aria-hidden="true"></span>
    </button>
    <div class="quick-ball-panel" hidden></div>
  `;
  document.body.appendChild(rootEl);
  panelEl = rootEl.querySelector('.quick-ball-panel');
  state.pos = avoidDockOverlap(loadPosition() || getDefaultQuickBallPosition());
  applyPosition();
  syncModalVisibility();
  const trigger = rootEl.querySelector('.quick-ball-trigger');
  bindDrag(trigger);
}

export async function mountQuickBall() {
  // 偏好读取异常不能把默认开启的自救入口误判成“用户明确关闭”。
  state.prefs = await loadQuickBallPrefs().catch(() => ({ enabled: true, actions: {} }));
  if (state.prefs?.enabled) renderRoot();
  bindGlobalEvents();
  startQuickBallHealthCheck();
  scheduleQuickBallRepair();
}
