import { back } from '../core/router.js';
import { icon } from '../components/svg-icons.js';
import { showToast } from '../components/toast.js';
import { copyTextToClipboard } from '../core/chat-helpers.js';
import {
  buildFeedbackBundle,
  clearDebugEvents,
  listDebugEvents,
} from '../core/debug-log.js';
import { loadAppearancePrefs, getActiveTheme, applySettingsWallpaperPreview } from '../core/appearance-prefs.js';
import { captureScrollerTop, restoreScrollerTop } from '../core/scroll-state.js';

function esc(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatTime(ts = 0) {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleString('zh-CN');
  } catch (_) {
    return '';
  }
}

function formatDuration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 1000) return `${Math.round(n)}ms`;
  return `${Math.round(n / 100) / 10}s`;
}

function renderMeta(event = {}) {
  const finishReason = event.context?.finishReason || event.finishReason || '';
  const reasoningLength = Number(event.context?.reasoningLength ?? event.reasoningLength ?? 0);
  const bits = [
    event.errorKind ? `[${event.errorKind}]` : '',
    event.status ? `HTTP ${event.status}` : '',
    event.durationMs != null ? `耗时 ${formatDuration(event.durationMs)}` : '',
    finishReason ? `finish=${finishReason}` : '',
    reasoningLength > 0 ? `推理 ${reasoningLength} 字` : '',
    event.usedUrl || '',
    event.model || '',
    event.stream === true ? 'stream' : event.stream === false ? 'non-stream' : '',
    event.correlationId || '',
  ].filter(Boolean);
  return bits.length ? `<div class="debug-log-meta">${bits.map(esc).join(' · ')}</div>` : '';
}

function formatContext(context = {}) {
  if (!context || typeof context !== 'object' || !Object.keys(context).length) return '';
  try {
    return JSON.stringify(context, null, 2);
  } catch (_) {
    return String(context);
  }
}

function topTimingEntries(value = {}, { exclude = [] } = {}) {
  const excluded = new Set(exclude);
  return Object.entries(value && typeof value === 'object' ? value : {})
    .filter(([name, ms]) => !excluded.has(name) && Number.isFinite(Number(ms)) && Number(ms) > 0)
    .sort((left, right) => Number(right[1]) - Number(left[1]))
    .slice(0, 3);
}

function renderTimingEntries(label, entries = []) {
  if (!entries.length) return '';
  const text = entries
    .map(([name, ms]) => `${name} ${formatDuration(ms)}`)
    .join(' · ');
  return `<div><span>${esc(label)}</span><strong>${esc(text)}</strong></div>`;
}

function renderSlowContextSummary(event = {}) {
  if (String(event.type || '') !== 'chat_context_build_slow') return '';
  const context = event.context && typeof event.context === 'object' ? event.context : {};
  const elapsedMs = Math.max(0, Number(context.elapsedMs || 0));
  const hiddenMs = Math.min(elapsedMs, Math.max(0, Number(context.hiddenMs || 0)));
  const activeMs = Math.max(0, Number(event.durationMs || (elapsedMs - hiddenMs) || 0));
  const phaseEntries = topTimingEntries(context.systemPromptPhaseMs);
  // socialAndState / layeredAndTimeline / characterCards 是包住并行子任务的汇总项；
  // 首屏摘要优先展示可继续定位的叶子任务，完整 map 仍保留在 context 中。
  const taskEntries = topTimingEntries(context.systemPromptTaskMs, {
    exclude: ['socialAndState', 'socialLinkage', 'layeredAndTimeline', 'characterCards'],
  });
  const durationBits = [
    activeMs > 0 ? `前台活跃 ${formatDuration(activeMs)}` : '',
    elapsedMs > 0 ? `墙钟总等待 ${formatDuration(elapsedMs)}` : '',
    hiddenMs > 0 ? `后台/锁屏 ${formatDuration(hiddenMs)}` : '',
  ].filter(Boolean).join(' · ');
  if (!durationBits && !phaseEntries.length && !taskEntries.length) return '';
  return `
    <div class="debug-log-timing-summary">
      ${durationBits ? `<div><span>计时</span><strong>${esc(durationBits)}</strong></div>` : ''}
      ${renderTimingEntries('最慢阶段', phaseEntries)}
      ${renderTimingEntries('最慢任务', taskEntries)}
    </div>
  `;
}

function renderEvent(event = {}) {
  const type = String(event.type || 'event');
  const tone = event.level === 'warn' ? ' is-warn' : event.level === 'error' ? ' is-error' : '';
  const raw = String(event.raw || '').trim();
  const prompt = String(event.prompt || '').trim();
  const stack = String(event.stack || '').trim();
  const context = formatContext(event.context);
  return `
    <details class="debug-log-item${tone}">
      <summary>
        <span class="debug-log-type">${esc(type)}</span>
        <span class="debug-log-time">${esc(formatTime(event.timestamp))}</span>
      </summary>
      <div class="debug-log-message">${esc(event.message || '无消息')}</div>
      ${renderMeta(event)}
      ${renderSlowContextSummary(event)}
      ${context ? `<div class="debug-log-label">context</div><pre>${esc(context)}</pre>` : ''}
      ${raw ? `<div class="debug-log-label">raw</div><pre>${esc(raw)}</pre>` : ''}
      ${prompt ? `<div class="debug-log-label">prompt</div><pre>${esc(prompt)}</pre>` : ''}
      ${stack ? `<div class="debug-log-label">stack</div><pre>${esc(stack)}</pre>` : ''}
    </details>
  `;
}

async function loadTheme() {
  const prefs = await loadAppearancePrefs();
  return getActiveTheme(prefs).theme;
}

export default async function render(container) {
  const [theme, events] = await Promise.all([
    loadTheme(),
    listDebugEvents(100),
  ]);
  const prevScroll = captureScrollerTop(container, '.settings-scroll');
  container.className = 'page scrapbook-page settings-debug-page';
  applySettingsWallpaperPreview(container, theme);
  container.innerHTML = `
    <header class="navbar">
      <button type="button" class="navbar-btn debug-log-back" aria-label="返回">${icon('back')}</button>
      <h1 class="navbar-title">错误日志</h1>
      <button type="button" class="navbar-btn debug-log-copy" aria-label="复制反馈包">${icon('message')}</button>
    </header>
    <main class="settings-scroll scrapbook-scroll">
      <section class="settings-group">
        <div class="settings-group-title">反馈</div>
        <div class="debug-log-actions">
          <button type="button" class="btn btn-primary debug-log-copy-main">复制反馈包</button>
          <button type="button" class="btn btn-outline debug-log-refresh">刷新</button>
          <button type="button" class="btn btn-soft debug-log-clear">清空</button>
        </div>
      </section>
      <section class="settings-group">
        <div class="settings-group-title">最近 ${events.length} 条</div>
        <div class="debug-log-list">
          ${events.length ? events.map(renderEvent).join('') : `<div class="scrapbook-list-item settings-row is-static"><span class="scrapbook-list-icon is-cream">${icon('check')}</span><span class="settings-row-main"><strong>暂无错误</strong></span></div>`}
        </div>
      </section>
    </main>
  `;
  restoreScrollerTop(container, '.settings-scroll', prevScroll);

  async function copyBundle() {
    const text = await buildFeedbackBundle();
    const ok = await copyTextToClipboard(text);
    showToast(ok ? '反馈包已复制（开头是拒因摘要 highlights）' : '复制失败');
  }

  container.querySelector('.debug-log-back')?.addEventListener('click', () => back());
  container.querySelector('.debug-log-copy')?.addEventListener('click', copyBundle);
  container.querySelector('.debug-log-copy-main')?.addEventListener('click', copyBundle);
  container.querySelector('.debug-log-refresh')?.addEventListener('click', () => render(container));
  container.querySelector('.debug-log-clear')?.addEventListener('click', async () => {
    // 不用 window.confirm：部分国产浏览器会静默吞掉系统确认框，看起来像「清空点了没反应」。
    const host = document.getElementById('modal-container');
    if (!host) {
      await clearDebugEvents();
      showToast('已清空');
      render(container);
      return;
    }
    const close = () => {
      host.classList.remove('active');
      host.innerHTML = '';
    };
    host.classList.add('active');
    host.innerHTML = `
      <div class="modal-overlay modal-sheet-center" data-debug-clear-overlay>
        <div class="modal-sheet scrapbook-card" role="alertdialog" aria-modal="true" data-debug-clear-sheet>
          <div class="modal-header"><h3>清空错误日志</h3></div>
          <div class="modal-body" style="font-size:14px;line-height:1.65;color:var(--text-secondary);">清空当前错误日志？此操作不可恢复。</div>
          <div class="modal-body" style="display:flex;gap:8px;padding-top:0;">
            <button type="button" class="btn btn-outline" data-debug-clear-cancel style="flex:1;">取消</button>
            <button type="button" class="btn btn-primary" data-debug-clear-ok style="flex:1;">清空</button>
          </div>
        </div>
      </div>
    `;
    host.querySelector('[data-debug-clear-sheet]')?.addEventListener('click', (e) => e.stopPropagation());
    host.querySelector('[data-debug-clear-overlay]')?.addEventListener('click', close);
    host.querySelector('[data-debug-clear-cancel]')?.addEventListener('click', close);
    host.querySelector('[data-debug-clear-ok]')?.addEventListener('click', async () => {
      close();
      await clearDebugEvents();
      showToast('已清空');
      render(container);
    });
  });
}
