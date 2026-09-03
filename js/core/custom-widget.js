/**
 * 自定义小组件（用户可写 HTML/CSS 代码）
 * - 渲染时用 Shadow DOM 隔离：组件内 CSS 不会泄漏到主屏，主屏样式也不会污染组件
 * - 注入前做基础清洗：去掉 <script>/<iframe> 等可执行/越权标签、on* 事件属性、javascript: 协议
 * - 纯文本便签（无 html）保持旧渲染：标题 + 内容
 * - 交互钩子（组件 HTML 里可用的 data 属性，注水时接线）：
 *   data-widget-image-slot="key" → 点按上传图片，存进该组件的 imageSlots
 *   data-widget-clock / data-widget-clock-date → 实时时间 / 日期
 */

import {
  loadAppearancePrefs,
  saveAppearancePrefs,
  getHomeWidgetLibraryItems,
  upsertHomeWidgetLibraryItem,
} from './appearance-prefs.js';
import { compressFileToDataUrl } from '../components/image-crop-modal.js';
import { getHomeWorldDate } from './home-world-time.js';
import { TIME_SCHEDULE_CHANGED_EVENT } from './time-mode.js';

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function isCodeWidget(item) {
  return !!(item && String(item.html || '').trim());
}

export function clampWidgetHtml(html) {
  return String(html == null ? '' : html);
}

function quickSurfaceStyle(colors = {}) {
  const hex = /^#[0-9a-f]{6}$/i.test(String(colors.background || '')) ? colors.background : '#ffffff';
  const opacity = Math.max(0, Math.min(100, Math.round(Number(colors.opacity ?? 100) || 0))) / 100;
  const surface = String(colors.surface || 'solid');
  const alpha = surface === 'transparent' ? 0 : opacity;
  const rgb = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
  const filter = surface === 'glass'
    ? 'blur(18px) saturate(120%)'
    : (surface === 'light-glass' ? 'blur(10px) saturate(112%)' : 'none');
  return {
    background: `rgba(${rgb.join(',')},${alpha})`,
    filter,
  };
}

const DANGEROUS_TAGS = 'script,iframe,object,embed,base,meta,link,form';

function isSafeWidgetUrl(value = '', attrName = '') {
  const raw = String(value || '').trim();
  if (!raw || raw.startsWith('#') || raw.startsWith('/')) return true;
  if (/^(?:https?:|mailto:|tel:)/i.test(raw)) return true;
  if (attrName === 'src' && /^data:image\/(?:png|jpe?g|gif|webp);base64,/i.test(raw)) return true;
  return false;
}

export function sanitizeWidgetHtml(html) {
  const raw = clampWidgetHtml(html);
  if (!raw.trim() || typeof document === 'undefined') return '';
  let doc;
  try {
    doc = new DOMParser().parseFromString(`<body>${raw}</body>`, 'text/html');
  } catch {
    return '';
  }
  const body = doc.body;
  if (!body) return '';
  body.querySelectorAll(DANGEROUS_TAGS).forEach((node) => node.remove());
  body.querySelectorAll('*').forEach((el) => {
    Array.from(el.attributes).forEach((attr) => {
      const name = String(attr.name || '').toLowerCase();
      const val = String(attr.value || '');
      if (name.startsWith('on')) {
        el.removeAttribute(attr.name);
      } else if ((name === 'href' || name === 'src' || name === 'xlink:href')
        && !isSafeWidgetUrl(val, name)) {
        el.removeAttribute(attr.name);
      } else if (name === 'srcset') {
        el.removeAttribute(attr.name);
      } else if (name === 'style' && /expression\s*\(|(?:javascript|vbscript|data):/i.test(val)) {
        el.removeAttribute(attr.name);
      }
    });
  });
  return body.innerHTML;
}

/** 渲染外壳（内容稍后由 hydrateCustomWidgets 填充）。
 * 默认按图标网格占位：grid-column/row span = size.cols × size.rows。 */
export function customWidgetCardHtml(item, opts = {}) {
  if (!item || !item.id) return '';
  const extraClass = isCodeWidget(item) ? ' home-code-widget' : '';
  const cols = Math.max(1, Math.min(4, Math.round(Number(item.size?.cols) || 2)));
  const rows = Math.max(1, Math.min(4, Math.round(Number(item.size?.rows) || 1)));
  const widgetStyle = `grid-column:span ${cols};grid-row:span ${rows};`;
  const editBtn = opts.editable
    ? `<button type="button" class="home-edit-delete" data-real-remove="${esc(item.id)}">−</button>`
    : '';
  const moveBtns = opts.movable
    ? `<span class="home-widget-move"><button type="button" data-widget-move="${esc(item.id)}:-1" aria-label="移到上一页">◀</button><button type="button" data-widget-move="${esc(item.id)}:1" aria-label="移到下一页">▶</button></span>`
    : '';
  // 控制按钮放进具名 slot：代码组件的 Shadow DOM 会遮住普通 light DOM 子节点，
  // 只有 slot 投影出来的内容才能在编辑模式显示删除/换页按钮。
  const controls = (editBtn || moveBtns)
    ? `<span class="home-widget-controls" slot="mm-controls" data-mm-widget-controls>${editBtn}${moveBtns}</span>`
    : '';
  const colors = item.quickColors?.enabled ? item.quickColors : null;
  const surface = colors ? quickSurfaceStyle(colors) : null;
  const quickColorStyle = colors
    ? `--mm-widget-shell-bg:${esc(surface.background)};--mm-widget-shell-filter:${esc(surface.filter)};--mm-widget-text:${esc(colors.text)};--mm-widget-accent:${esc(colors.accent)};`
    : '';
  return `<div class="widget-card home-custom-widget${extraClass}" data-custom-widget-id="${esc(item.id)}" data-home-longpress-item="${esc(item.id)}" data-widget-cols="${cols}" data-widget-rows="${rows}" style="${widgetStyle}${quickColorStyle}">${controls}</div>`;
}

// 组件契约要求根节点用 border-box，但主屏宿主的高度必须继续由外层网格按照
// data-widget-rows 计算。这里不能再写 height/max-height:100%!important：隐式网格行
// 遇到循环百分比会把多行组件压成一条横条。内容裁切仍由宿主 overflow 负责。
const HOST_RESET_CSS = ':host{display:block!important;width:100%!important;min-width:0!important;min-height:0!important;max-width:100%!important;box-sizing:border-box!important;overflow:hidden!important;position:relative!important;}:host *,:host *::before,:host *::after{box-sizing:border-box;}';
const QUICK_COLOR_CSS = `:host{color:var(--mm-widget-text)}
:host>:not(style):not(slot){color:inherit;background:var(--mm-widget-shell-bg)!important;-webkit-backdrop-filter:var(--mm-widget-shell-filter,none);backdrop-filter:var(--mm-widget-shell-filter,none)}
:host :where(p,span,small,strong,em,b,i,u,h1,h2,h3,h4,li,summary){color:var(--mm-widget-text)!important}
:host :where(a,button,[data-accent]){color:var(--mm-widget-accent)!important}`;

// ── 世界时钟：所有带 data-widget-clock 的元素共用一个定时器 ──
const clockEls = new Set();
const clockUserIds = new WeakMap();
let clockTimer = 0;
let clockEventsBound = false;

function pad2(n) { return String(n).padStart(2, '0'); }

async function updateClockEl(el) {
  const now = await getHomeWorldDate(clockUserIds.get(el)).catch(() => new Date());
  if (!el.isConnected && el.getRootNode({ composed: true }) !== document) return;
  if (el.hasAttribute('data-widget-clock-date')) {
    const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()];
    el.textContent = `${now.getMonth() + 1}月${now.getDate()}日 ${week}`;
  } else {
    el.textContent = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
  }
}

function registerClockEl(el, userId = '') {
  clockUserIds.set(el, String(userId || '').trim());
  void updateClockEl(el);
  clockEls.add(el);
  if (clockEls.size > 60) {
    clockEls.forEach((item) => { if (!item.isConnected) clockEls.delete(item); });
  }
  if (!clockTimer && typeof window !== 'undefined') {
    clockTimer = window.setInterval(() => {
      clockEls.forEach((item) => {
        // Keep-Alive 挂起时元素会暂时离开 document，跳过但别删——回来还要继续走
        if (item.getRootNode({ composed: true }) !== document) return;
        void updateClockEl(item);
      });
    }, 15000);
  }
  if (!clockEventsBound && typeof window !== 'undefined') {
    clockEventsBound = true;
    window.addEventListener(TIME_SCHEDULE_CHANGED_EVENT, (event) => {
      const changedUserId = String(event.detail?.userId || '').trim();
      clockEls.forEach((item) => {
        if (changedUserId && clockUserIds.get(item) !== changedUserId) return;
        if (item.getRootNode({ composed: true }) !== document) return;
        void updateClockEl(item);
      });
    });
  }
}

async function persistWidgetImageSlot(widgetId, slotKey, dataUrl) {
  const fresh = await loadAppearancePrefs();
  const item = getHomeWidgetLibraryItems(fresh)[widgetId];
  if (!item) return;
  const next = upsertHomeWidgetLibraryItem(fresh, {
    ...item,
    imageSlots: { ...(item.imageSlots || {}), [slotKey]: dataUrl },
  });
  await saveAppearancePrefs(next);
}

/** 组件内部交互接线：图片槽点按上传、实时时钟 */
function wireWidgetInteractions(root, item, options = {}) {
  root.querySelectorAll('[data-widget-clock], [data-widget-clock-date]')
    .forEach((el) => registerClockEl(el, options.userId));
  root.querySelectorAll('[data-widget-image-slot]').forEach((slotEl) => {
    const key = String(slotEl.getAttribute('data-widget-image-slot') || '').trim();
    if (!key) return;
    const applyImage = (url) => {
      if (!url) return;
      slotEl.style.backgroundImage = `url("${String(url).replace(/"/g, '\\"')}")`;
      slotEl.classList.add('has-image');
      slotEl.textContent = '';
    };
    applyImage(item.imageSlots?.[key]);
    slotEl.style.cursor = 'pointer';
    slotEl.addEventListener('click', (e) => {
      e.stopPropagation();
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.addEventListener('change', async () => {
        const file = input.files?.[0];
        if (!file) return;
        try {
          const dataUrl = await compressFileToDataUrl(file, { maxSize: 1024, preserveAlpha: true });
          if (!dataUrl) return;
          applyImage(dataUrl);
          await persistWidgetImageSlot(item.id, key, dataUrl);
        } catch (_) {}
      });
      input.click();
    });
  });
}

/** 在 root 内查找所有自定义组件外壳并填充内容（代码组件走 Shadow DOM） */
export function hydrateCustomWidgets(root, customItems, options = {}) {
  if (!root || typeof document === 'undefined') return;
  const map = customItems && typeof customItems === 'object' ? customItems : {};
  root.querySelectorAll('[data-custom-widget-id]').forEach((el) => {
    const id = el.getAttribute('data-custom-widget-id');
    const item = map[id];
    if (!item) return;
    const controls = el.querySelector('[data-mm-widget-controls]');
    if (isCodeWidget(item)) {
      let shadow = el.shadowRoot;
      if (!shadow) {
        try {
          shadow = el.attachShadow({ mode: 'open' });
        } catch {
          shadow = null;
        }
      }
      const safeHtml = sanitizeWidgetHtml(item.html);
      if (shadow) {
        const quickColors = item.quickColors?.enabled ? `<style>${QUICK_COLOR_CSS}</style>` : '';
        // 宿主几何重置放在用户样式之后，避免组件里的 :host / 100vh 把主屏网格撑开。
        shadow.innerHTML = `<slot name="mm-controls"></slot>${safeHtml}${quickColors}<style>${HOST_RESET_CSS}</style>`;
        wireWidgetInteractions(shadow, item, options);
      } else {
        el.innerHTML = safeHtml;
        if (controls) el.appendChild(controls);
        wireWidgetInteractions(el, item, options);
      }
    } else {
      const title = item.title || item.label || '便签';
      const body = item.body || '';
      el.innerHTML = `<div class="home-custom-widget-title">${esc(title)}</div>${body ? `<div class="home-custom-widget-body">${esc(body)}</div>` : ''}`;
      if (controls) el.appendChild(controls);
    }
  });
}

/** @deprecated 自定义组件已并入图标网格拖动，保留空实现以免旧调用报错。 */
export function bindCustomWidgetDrag() {
  return () => {};
}
