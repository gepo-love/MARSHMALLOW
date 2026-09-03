/**
 * 打开系统文件/相册选择器。
 *
 * 小米默认浏览器等环境会对未挂载或 display:none / [hidden] 的 file input
 * 静默忽略 .click() 与 label 激活；统一走视觉隐藏 + 挂到 document 再同步触发。
 *
 * 注意：按钮通常带 transform，position:fixed 会改为相对按钮定位。过去再配合
 * left:-10000px 时，部分 Android WebView 会把这段超远坐标算进布局视口并自动缩放，
 * 表现为选图后整页比例突变。现在只在原位裁成 1px，不再制造屏外几何尺寸。
 * 已挂载的业务 input 仍留在原容器，避免破坏容器查询和 change 事件冒泡；仅临时
 * input 挂到宿主。
 */

let clickPatched = false;
/** @type {((this: HTMLInputElement) => void) | null} */
let nativeInputClick = null;

const HIDE_STYLE = {
  position: 'absolute',
  left: '0',
  top: '0',
  width: '1px',
  height: '1px',
  margin: '0',
  padding: '0',
  overflow: 'hidden',
  clip: 'rect(0, 0, 0, 0)',
  clipPath: 'inset(50%)',
  whiteSpace: 'nowrap',
  border: '0',
  opacity: '0.01',
  display: 'block',
  visibility: 'visible',
  pointerEvents: 'none',
  zIndex: '-1',
};

function applyInlineHide(input) {
  if (!input || !input.style) return;
  input.style.removeProperty('display');
  input.style.removeProperty('visibility');
  Object.keys(HIDE_STYLE).forEach((key) => {
    input.style[key] = HIDE_STYLE[key];
  });
}

function cssEscape(value) {
  const raw = String(value ?? '');
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(raw);
  return raw.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function getFileInputHost() {
  if (typeof document === 'undefined') return null;
  let host = document.getElementById('mm-file-input-host');
  if (!host && document.body) {
    host = document.createElement('div');
    host.id = 'mm-file-input-host';
    host.setAttribute('aria-hidden', 'true');
    document.body.appendChild(host);
  }
  return host;
}

/** 页面重渲染后旧 input 会留在宿主里；按 data-* / 业务 class 清掉孪生节点。 */
function pruneHostTwins(host, input) {
  if (!host || !input) return;
  const attrs = input.attributes ? Array.from(input.attributes) : [];
  for (let i = 0; i < attrs.length; i += 1) {
    const attr = attrs[i];
    if (!attr || !attr.name.startsWith('data-') || !attr.value) continue;
    const sel = `input[type="file"][${attr.name}="${cssEscape(attr.value)}"]`;
    host.querySelectorAll(sel).forEach((el) => {
      if (el !== input) {
        try { el.remove(); } catch (_) { /* ignore */ }
      }
    });
  }
  const classes = input.classList ? Array.from(input.classList).filter((c) => c && c !== 'mm-file-input') : [];
  for (let i = 0; i < classes.length; i += 1) {
    const sel = `input[type="file"].${cssEscape(classes[i])}`;
    host.querySelectorAll(sel).forEach((el) => {
      if (el !== input) {
        try { el.remove(); } catch (_) { /* ignore */ }
      }
    });
  }
}

function relocateToHost(input) {
  const host = getFileInputHost();
  if (!host) return;
  pruneHostTwins(host, input);
  if (input.parentElement !== host) host.appendChild(input);
}

function preparePickableInput(input) {
  if (!input) return null;
  input.classList.add('mm-file-input');
  input.removeAttribute('hidden');
  applyInlineHide(input);

  // 已在页面里的业务 input 必须保留原父级：大量入口会从页面容器查找它，
  // change 也依赖向原容器冒泡。临时创建的 input 才挂到屏外宿主。
  if (!input.isConnected) {
    relocateToHost(input);
  }
  return input;
}

function prepareFileInputsIn(root) {
  if (!root || !root.querySelectorAll) return;
  const list = root.querySelectorAll('input[type="file"][hidden], input[type="file"].mm-file-input');
  for (let i = 0; i < list.length; i += 1) {
    preparePickableInput(list[i]);
  }
}

function invokeNativeClick(input) {
  if (!input) return false;
  try {
    if (nativeInputClick) {
      nativeInputClick.call(input);
    } else {
      HTMLInputElement.prototype.click.call(input);
    }
    return true;
  } catch (_) {
    return false;
  }
}

/** 同步触发已有 file input（须在用户手势回调内调用）。 */
export function triggerFileInput(input) {
  const el = preparePickableInput(input);
  if (!el) return false;
  return invokeNativeClick(el);
}

/**
 * 启动时安装：包装 file input 的 .click()，并扫掉模板里的 [hidden]。
 * 应尽早调用（boot），这样聊天头像/发图/导入等无需逐个改调用点。
 */
export function installFilePickerCompat() {
  if (typeof document === 'undefined') return;
  prepareFileInputsIn(document);

  if (!clickPatched && typeof HTMLInputElement !== 'undefined') {
    clickPatched = true;
    nativeInputClick = HTMLInputElement.prototype.click;
    HTMLInputElement.prototype.click = function mmFileInputClick() {
      if (String(this.type || '').toLowerCase() === 'file') {
        preparePickableInput(this);
      }
      return nativeInputClick.apply(this, arguments);
    };
  }

  if (typeof MutationObserver !== 'undefined') {
    const obs = new MutationObserver((mutations) => {
      for (let i = 0; i < mutations.length; i += 1) {
        const nodes = mutations[i].addedNodes;
        for (let j = 0; j < nodes.length; j += 1) {
          const node = nodes[j];
          if (!node || node.nodeType !== 1) continue;
          if (node.matches && node.matches('input[type="file"]')) {
            if (node.hasAttribute('hidden') || node.classList.contains('mm-file-input')) {
              preparePickableInput(node);
            }
          } else if (node.id !== 'mm-file-input-host') {
            prepareFileInputsIn(node);
          }
        }
      }
    });
    obs.observe(document.documentElement || document.body, { childList: true, subtree: true });
  }
}

/**
 * 临时创建 file input 并打开选择器。
 * @param {{ accept?: string, multiple?: boolean, onChange?: (files: FileList|null) => void }} [options]
 * @returns {HTMLInputElement|null}
 */
export function openFilePicker(options = {}) {
  const input = document.createElement('input');
  input.type = 'file';
  if (options.accept) input.accept = String(options.accept);
  if (options.multiple) input.multiple = true;
  preparePickableInput(input);

  const cleanup = () => {
    try { input.remove(); } catch (_) { /* ignore */ }
  };

  input.addEventListener('change', () => {
    try {
      if (typeof options.onChange === 'function') options.onChange(input.files);
    } finally {
      cleanup();
    }
  }, { once: true });

  // 部分浏览器取消选择不会触发 change；延迟清掉以免残留
  window.setTimeout(() => {
    if (input.isConnected && !(input.files && input.files.length)) cleanup();
  }, 60_000);

  if (!invokeNativeClick(input)) {
    cleanup();
    return null;
  }
  return input;
}
