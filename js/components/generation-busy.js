/**
 * 社交/论坛等 AI 生成：统一按钮 loading 与页面 busy overlay。
 */

export const GEN_IMAGE_HINT = '内容较多（含配图生成），可能需要较长时间，请耐心等待';

function announceGenerationActivity(source, active) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('marshmallow-generation-activity', {
    detail: { source, active: active ? 1 : 0 },
  }));
}

function escText(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** 模板内联：加载中按钮内容 */
export function loadingBtnContent(label = '生成中…') {
  return `<span class="btn-loading-spinner" aria-hidden="true"></span><span class="btn-loading-label">${escText(label)}</span>`;
}

/** DOM 按钮切换 loading */
export function setButtonLoading(btn, loading, options = {}) {
  if (!btn || !(btn instanceof Element)) return;
  const label = options.label ?? '生成中…';

  if (loading) {
    if (!btn.dataset.genLoadingOrigHtml) {
      btn.dataset.genLoadingOrigHtml = btn.innerHTML;
      btn.dataset.genLoadingOrigLabel = btn.getAttribute('aria-label') || '';
    }
    btn.classList.add('is-loading');
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    if (btn.classList.contains('navbar-btn') || options.preserveIcon) {
      if (label) btn.setAttribute('aria-label', label);
    } else if (options.label !== false) {
      btn.innerHTML = loadingBtnContent(label);
    }
  } else {
    btn.classList.remove('is-loading');
    btn.disabled = false;
    btn.removeAttribute('aria-busy');
    if (btn.dataset.genLoadingOrigHtml != null) {
      btn.innerHTML = btn.dataset.genLoadingOrigHtml;
      const origLabel = btn.dataset.genLoadingOrigLabel;
      if (origLabel) btn.setAttribute('aria-label', origLabel);
      else btn.removeAttribute('aria-label');
      delete btn.dataset.genLoadingOrigHtml;
      delete btn.dataset.genLoadingOrigLabel;
    }
  }
  announceGenerationActivity('button', loading);
}

export function lockButtons(root, loading, selector = '[data-gen-busy-lock]') {
  root?.querySelectorAll?.(selector)?.forEach((el) => {
    if (loading) {
      el.disabled = true;
      el.setAttribute('aria-disabled', 'true');
    } else if (!el.classList.contains('is-loading')) {
      el.disabled = false;
      el.removeAttribute('aria-disabled');
    }
  });
}

const OVERLAY_INNER = `
  <div class="app-busy-spinner" aria-hidden="true"></div>
  <div class="app-busy-text"></div>
  <div class="app-busy-hint" hidden></div>
`;

export function ensurePageBusyOverlay(root, className = 'app-busy-overlay') {
  if (!root) return null;
  let overlay = root.querySelector(`.${className}`);
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.className = className;
    overlay.setAttribute('aria-hidden', 'true');
    overlay.innerHTML = OVERLAY_INNER;
    root.appendChild(overlay);
  }
  return overlay;
}

export function setPageBusy(root, on, options = {}) {
  const className = options.overlayClass || 'app-busy-overlay';
  const overlay = ensurePageBusyOverlay(root, className);
  if (!overlay) return;

  overlay.classList.toggle('is-visible', !!on);
  overlay.setAttribute('aria-hidden', on ? 'false' : 'true');

  const textEl = overlay.querySelector('.app-busy-text');
  const hintEl = overlay.querySelector('.app-busy-hint');
  if (textEl) textEl.textContent = options.message || (on ? '正在生成…' : '');

  const hint = options.imageGen ? GEN_IMAGE_HINT : (options.hint || '');
  if (hintEl) {
    hintEl.textContent = hint;
    hintEl.hidden = !hint;
  }

  lockButtons(root, on, options.lockSelector || '[data-gen-busy-lock]');
  announceGenerationActivity('page', on);
}

/** 状态条（论坛/匿名墙等）：带转圈与可选生图提示 */
export function setGenStatus(el, text, options = {}) {
  if (!el) return;
  if (!text) {
    el.hidden = true;
    el.textContent = '';
    el.classList.remove('is-active', 'has-image-hint');
    return;
  }
  el.hidden = false;
  el.classList.add('is-active');
  const hint = options.imageGen ? GEN_IMAGE_HINT : (options.hint || '');
  const row = `<span class="social-gen-status-row"><span class="btn-loading-spinner social-gen-status-spinner" aria-hidden="true"></span><span>${escText(text)}</span></span>`;
  if (hint) {
    el.classList.add('has-image-hint');
    el.innerHTML = `${row}<span class="social-gen-status-hint">${escText(hint)}</span>`;
  } else {
    el.classList.remove('has-image-hint');
    el.innerHTML = row;
  }
}

/** 页面内常驻生成状态：不遮挡页面，离开再返回时可按任务状态重绘。 */
export function setGenerationActivity(el, state) {
  if (!el) return;
  const status = String(state?.status || '');
  if (!status) {
    el.hidden = true;
    el.innerHTML = '';
    el.classList.remove('is-running', 'is-success', 'is-error');
    return;
  }
  const running = status === 'running';
  el.hidden = false;
  el.classList.toggle('is-running', running);
  el.classList.toggle('is-success', status === 'success');
  el.classList.toggle('is-error', status === 'error');
  const icon = running
    ? '<span class="btn-loading-spinner social-gen-status-spinner" aria-hidden="true"></span>'
    : `<span class="generation-activity-mark" aria-hidden="true">${status === 'success' ? '✓' : '!'}</span>`;
  const hint = String(state?.hint || '');
  el.innerHTML = `<span class="generation-activity-main">${icon}<span>${escText(state.message || '正在生成…')}</span></span>`
    + (hint ? `<span class="generation-activity-hint">${escText(hint)}</span>` : '');
}
