/** 站内小窗预览外链：原生壳用顶层 WebView；社媒链接在网页端改走系统浏览器（与 QQ 一致，iframe 会被平台拦截）。 */
import { isWebSnapshotSupported, openNativeWebViewer } from '../core/native-web-snapshot.js';
import { resolveSocialOpenUrl } from '../core/social-link-resolver.js';

function esc(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function isLikelySocialUrl(url) {
  return /xiaohongshu\.com|xhslink\.(?:com|cn)|weibo\.(cn|com)|bilibili\.com|b23\.tv/i.test(String(url || ''));
}

function normalizeUrl(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  if (/^https?:\/\//i.test(text)) return text;
  if (/^\/\//.test(text)) return `https:${text}`;
  return '';
}

let activeRoot = null;

function closeSheet() {
  if (!activeRoot) return;
  activeRoot.remove();
  activeRoot = null;
  document.documentElement.classList.remove('link-preview-open');
}

function openExternal(url) {
  const target = normalizeUrl(url);
  if (!target) return;
  try {
    const cap = window.Capacitor?.Plugins?.Browser;
    if (cap?.open) {
      cap.open({ url: target, presentationStyle: 'popover' }).catch(() => {
        window.open(target, '_blank', 'noopener,noreferrer');
      });
      return;
    }
  } catch (_) {}
  window.open(target, '_blank', 'noopener,noreferrer');
}

/**
 * 短链（xhslink/t.cn）解析是异步网络请求；如果先 await 解析结果再 window.open，
 * 等待期间会跌出浏览器的"用户手势"窗口，多数移动端浏览器会把这次 open 当成非用户触发的
 * 弹窗直接静默拦掉——表现就是用户点了完全没反应。这里先在点击的同一时刻同步开一个空白页
 * 占住手势名额，短链解析回来后再改写这个页面的地址；拿不到解析结果就直接跳原始链接，交给
 * 浏览器自己处理落地页跳转。
 */
function openExternalDeferred(target) {
  let win = null;
  try {
    win = window.open('about:blank', '_blank');
    if (win) {
      try { win.opener = null; } catch (_) {}
    }
  } catch (_) {
    win = null;
  }
  const finish = (finalUrl) => {
    if (win && !win.closed) {
      try {
        win.location.href = finalUrl;
        return;
      } catch (_) {}
    }
    openExternal(finalUrl);
  };
  resolveSocialOpenUrl(target).then((resolved) => finish(resolved || target)).catch(() => finish(target));
}

/**
 * @param {string} url
 * @param {{ title?: string }} [options]
 */
export async function openLinkPreview(url, options = {}) {
  let target = normalizeUrl(url);
  if (!target) return;

  // 原生壳：直接用顶层 WebView 打开，不塞 iframe，小红书/微博等也能正常显示。
  if (isWebSnapshotSupported()) {
    const title = String(options.title || '').trim() || '链接预览';
    const resolved = await resolveSocialOpenUrl(target).catch(() => target);
    const res = await openNativeWebViewer(resolved || target, { title });
    if (res?.ok) return;
    openExternal(resolved || target);
    return;
  }

  // 网页 / PWA：社媒页禁止 iframe 内嵌，直接交给系统浏览器（xhslink 会先解析短链，
  // 但不能等解析结果再开窗，见 openExternalDeferred 注释）。
  if (isLikelySocialUrl(target)) {
    openExternalDeferred(target);
    return;
  }

  openLinkPreviewSheet(target, options);
}

function openLinkPreviewSheet(target, options = {}) {
  closeSheet();

  const title = String(options.title || '').trim() || '链接预览';
  const root = document.createElement('div');
  root.className = 'link-preview-sheet';
  root.innerHTML = `
    <div class="link-preview-backdrop" data-close></div>
    <section class="link-preview-card" role="dialog" aria-label="${esc(title)}">
      <header class="link-preview-head">
        <strong>${esc(title)}</strong>
        <div class="link-preview-head-actions">
          <button type="button" class="btn btn-xs btn-soft" data-open-external>浏览器打开</button>
          <button type="button" class="link-preview-close" data-close aria-label="关闭">×</button>
        </div>
      </header>
      <div class="link-preview-body">
        <div class="link-preview-loading">加载中…</div>
        <iframe class="link-preview-frame" src="${esc(target)}" title="${esc(title)}" referrerpolicy="no-referrer-when-downgrade"></iframe>
        <div class="link-preview-fallback" hidden>
          <p>此页面可能不允许内嵌预览。</p>
          <button type="button" class="btn btn-primary btn-sm" data-open-external>在浏览器 / App 中打开</button>
        </div>
      </div>
    </section>
  `;

  document.body.appendChild(root);
  activeRoot = root;
  document.documentElement.classList.add('link-preview-open');

  const frame = root.querySelector('.link-preview-frame');
  const loading = root.querySelector('.link-preview-loading');
  const fallback = root.querySelector('.link-preview-fallback');
  let settled = false;

  const showFallback = () => {
    if (settled) return;
    settled = true;
    if (loading) loading.hidden = true;
    if (frame) frame.hidden = true;
    if (fallback) fallback.hidden = false;
  };

  root.querySelectorAll('[data-close]').forEach((el) => {
    el.addEventListener('click', closeSheet);
  });
  root.querySelectorAll('[data-open-external]').forEach((el) => {
    el.addEventListener('click', () => openExternal(target));
  });

  if (frame) {
    frame.addEventListener('load', () => {
      if (settled) return;
      settled = true;
      if (loading) loading.hidden = true;
    });
    frame.addEventListener('error', showFallback);
  }

  if (isLikelySocialUrl(target)) {
    window.setTimeout(showFallback, 2200);
  } else {
    window.setTimeout(showFallback, 4500);
  }
}

export function bindLinkPreviewAnchors(root, selector = 'a[data-link-preview], a.cphone-link-preview') {
  if (!root) return;
  root.querySelectorAll(selector).forEach((anchor) => {
    if (anchor.dataset.linkPreviewBound === '1') return;
    anchor.dataset.linkPreviewBound = '1';
    anchor.addEventListener('click', (event) => {
      const href = anchor.getAttribute('href') || anchor.dataset.href || '';
      if (!href || href.startsWith('#')) return;
      event.preventDefault();
      openLinkPreview(href, { title: anchor.textContent?.trim() || '链接预览' });
    });
  });
}
