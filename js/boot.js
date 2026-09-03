/**
 * 带版本号加载 app.js + 注册 Service Worker。
 * 禁止 top-level await —— iOS 14 及更早 Safari 无法解析带 TLA 的模块，会整页白屏。
 */
import {
  notifyNativeAppReady,
  verifyNativeBundleCompatibilityBeforeBoot,
} from './core/native-update-bridge.js';
import { installFilePickerCompat } from './core/open-file-picker.js';
import { hasPendingCloudBackupInteraction } from './core/cloud-backup-interaction.js';

// 只有数据库、路由和首屏真正完成后才确认热更新可用。旧实现刚解析 boot.js 就确认，
// 后续即使卡死或白屏也会把坏包标成成功，Capgo 无法自动回滚。
let nativeReadyNotified = false;
function notifyNativeReadyOnce() {
  if (nativeReadyNotified) return;
  if (isEmbeddedBeautifyPreview()) return;
  nativeReadyNotified = true;
  notifyNativeAppReady().catch(function () {});
}
if (typeof window !== 'undefined') {
  window.addEventListener('marshmallow-app-ready', notifyNativeReadyOnce, { once: true });
}

// 小米默认浏览器等：hidden/display:none 的 file input 打不开相册；尽早装兼容层
try { installFilePickerCompat(); } catch (_) {}

/** @type {string} 避免 ?? / globalThis，兼容更旧 WebKit */
const BUILD =
  (typeof window !== 'undefined' && window.__MARSHMALLOW_BUILD__)
    ? String(window.__MARSHMALLOW_BUILD__)
    : '140';

function mmlog(level, msg) {
  try {
    if (typeof window !== 'undefined' && typeof window.__mmlog === 'function') {
      window.__mmlog(level, msg);
    }
  } catch (_) {}
}

mmlog('info', 'boot.js 开始执行 build ' + BUILD);

function isResettingPage() {
  try {
    return !!(typeof window !== 'undefined' && window.__MARSHMALLOW_RESETTING__);
  } catch (_) {
    return false;
  }
}

function isDiagnosticsPage() {
  try {
    return !!(typeof window !== 'undefined' && window.__MARSHMALLOW_DIAGNOSTICS__);
  } catch (_) {
    return false;
  }
}

function isEmbeddedBeautifyPreview() {
  try {
    return typeof window !== 'undefined'
      && window.top !== window.self
      && /(?:^|[?&])beautifyPreview=1(?:&|$)/.test(String((window.location && window.location.search) || ''));
  } catch (_) {
    return false;
  }
}

function isIosWebKitDevice() {
  try {
    var nav = window.navigator || {};
    var ua = String(nav.userAgent || '');
    return /iPad|iPhone|iPod/i.test(ua)
      || (nav.platform === 'MacIntel' && Number(nav.maxTouchPoints || 0) > 1);
  } catch (_) {
    return false;
  }
}

function installMobileViewportVars() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const root = document.documentElement;
  let pending = false;
  let foregroundPending = false;
  let lastViewportKey = '';
  let stableViewportHeight = 0;
  let keyboardSettleTimers = [];
  const update = function () {
    pending = false;
    const vv = window.visualViewport;
    const innerH = Number(window.innerHeight || 0) || 0;
    const clientH = Number(document.documentElement.clientHeight || 0) || innerH;
    let viewportHeight = innerH;
    let offsetTop = 0;
    let offsetLeft = 0;
    if (vv) {
      viewportHeight = Number(vv.height || 0) || innerH;
      offsetTop = Number(vv.offsetTop || 0) || 0;
      offsetLeft = Number(vv.offsetLeft || 0) || 0;
      // 浏览器底栏/顶栏出现时 innerHeight 常大于 visualViewport，取较小值保证 Dock 不被挡
      viewportHeight = Math.min(viewportHeight, innerH || viewportHeight, clientH || viewportHeight);
    }
    viewportHeight = Math.max(320, Math.round(viewportHeight));
    const vvOffsetTop = offsetTop;
    let keyboardInset = vv && innerH
      ? Math.max(0, innerH - viewportHeight - vvOffsetTop)
      : 0;
    const softFieldFocused = isSoftKeyboardField(document.activeElement);
    // 部分 Capacitor / Android WebView 在 adjustResize 下会让 innerHeight 与
    // visualViewport.height 同时缩小，二者相减恒为 0。保留聚焦前的稳定高度，
    // 作为第二条实测依据；收键盘后即使 textarea 残留焦点，高度恢复也会归零。
    if (!softFieldFocused && keyboardInset < 80) {
      stableViewportHeight = viewportHeight;
    } else if (softFieldFocused && stableViewportHeight > 0) {
      keyboardInset = Math.max(
        keyboardInset,
        stableViewportHeight - viewportHeight - vvOffsetTop,
      );
    }
    const viewportKey = `${viewportHeight}|${Math.round(vvOffsetTop)}|${Math.round(keyboardInset)}|${Math.round(offsetLeft)}`;
    if (viewportKey === lastViewportKey) return;
    lastViewportKey = viewportKey;
    root.style.setProperty('--app-height', `${viewportHeight}px`);
    root.style.setProperty('--app-offset-top', `${Math.round(vvOffsetTop)}px`);
    root.style.setProperty('--app-offset-left', `${Math.round(offsetLeft)}px`);
    root.style.setProperty('--keyboard-inset', `${Math.round(keyboardInset)}px`);
    root.style.setProperty('--viewport-keyboard-inset', `${Math.round(keyboardInset)}px`);
    root.classList.toggle('keyboard-visible', keyboardInset >= 80);
    window.__marshmallowViewportKeyboardInset = Math.round(keyboardInset);
    // 页面级功能不要各自监听 visualViewport 后再猜一次键盘状态。统一在 CSS 变量、
    // class 与全局 inset 已经同步后广播，确保“键盘已收起”使用的是这一帧的真实值。
    window.dispatchEvent(new CustomEvent('marshmallow-viewport-change', {
      detail: {
        viewportHeight: viewportHeight,
        offsetTop: Math.round(vvOffsetTop),
        keyboardInset: Math.round(keyboardInset),
        keyboardVisible: keyboardInset >= 80,
      },
    }));
  };
  // 之前给原生壳单独加过 48ms 节流，想法是键盘频繁 resize 事件太密集会抢主线程；
  // 实测反而是这个节流让输入框慢半拍跟不上键盘动画——已验证过用同样技术栈（Capacitor
  // WebView + visualViewport）的兄弟项目全程不节流也很跟手，这里去掉，全端统一走
  // requestAnimationFrame 直更新。
  const scheduleUpdate = function () {
    if (pending) return;
    pending = true;
    requestAnimationFrame(update);
  };
  const scheduleKeyboardSettles = function () {
    for (let i = 0; i < keyboardSettleTimers.length; i += 1) {
      clearTimeout(keyboardSettleTimers[i]);
    }
    keyboardSettleTimers = [];
    // 部分 OriginOS / Android Edge 安装版不会为键盘动画的每一帧派发
    // visualViewport.resize。聚焦后短时间补采样，仍只读取 visualViewport，
    // 不猜键盘高度，也不依赖 UA 中是否带 EdgA。
    const delays = [0, 80, 180, 320, 520];
    for (let i = 0; i < delays.length; i += 1) {
      keyboardSettleTimers.push(setTimeout(scheduleUpdate, delays[i]));
    }
  };
  const refreshAfterForeground = function () {
    if (document.hidden) return;
    // Android WebView 回前台时尺寸值可能完全相同，但旧 layout/compositor 已失效；
    // 清掉去重键，确保 viewport 变量也重新提交一次。
    lastViewportKey = '';
    scheduleUpdate();
    if (foregroundPending) return;
    foregroundPending = true;
    requestAnimationFrame(function () {
      foregroundPending = false;
      window.dispatchEvent(new CustomEvent('marshmallow-app-foreground'));
    });
  };
  update();
  window.addEventListener('resize', scheduleUpdate, { passive: true });
  window.addEventListener('orientationchange', scheduleUpdate, { passive: true });
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', scheduleUpdate, { passive: true });
    window.visualViewport.addEventListener('scroll', scheduleUpdate, { passive: true });
  }
  document.addEventListener('focusin', function (event) {
    if (!isSoftKeyboardField(event.target)) return;
    scheduleKeyboardSettles();
  }, true);
  document.addEventListener('focusout', function (event) {
    if (!isSoftKeyboardField(event.target)) return;
    scheduleKeyboardSettles();
  }, true);
  window.addEventListener('pageshow', refreshAfterForeground, { passive: true });
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) refreshAfterForeground();
  });
  document.addEventListener('resume', refreshAfterForeground);
  window.addEventListener('marshmallow-native-resume', refreshAfterForeground);
}

installMobileViewportVars();

function installStandaloneModeClass() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const root = document.documentElement;
  const nativeShell = !!(window.Capacitor && window.Capacitor.isNativePlatform?.());
  // Capacitor 原生壳（Android APK）单独打个 class：和参考项目（同设备上键盘手感
  // 完全跟手）对齐——只用 installMobileViewportVars 算出的 --app-height 驱动整页
  // resize，不叠加任何原生高度桥接 / padding 顶位 / 强制回全高。那一整套原生
  // WindowInsetsAnimation 逐帧同步方案在这台设备（鸿蒙）上被证实会互相打架，
  // 表现为键盘动画中途卡住不动、松开后又跳一下、甚至反复上下弹跳。
  if (nativeShell) root.classList.add('capacitor-native');
  const apply = function () {
    const nav = window.navigator || {};
    let standalone = nativeShell;
    try {
      standalone = standalone
        || window.matchMedia('(display-mode: standalone)').matches
        || window.matchMedia('(display-mode: fullscreen)').matches
        || window.matchMedia('(display-mode: minimal-ui)').matches;
    } catch (_) {}
    if (nav.standalone === true) standalone = true;
    if (standalone) root.classList.add('pwa-standalone');
    else root.classList.remove('pwa-standalone');
  };
  apply();
  try {
    const modes = ['standalone', 'fullscreen', 'minimal-ui'];
    for (let i = 0; i < modes.length; i += 1) {
      const mq = window.matchMedia('(display-mode: ' + modes[i] + ')');
      if (!mq) continue;
      if (typeof mq.addEventListener === 'function') mq.addEventListener('change', apply);
      else if (typeof mq.addListener === 'function') mq.addListener(apply);
    }
  } catch (_) {}
  window.addEventListener('pageshow', apply, { passive: true });
}

installStandaloneModeClass();

function installNativeSafeAreaVars() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const root = document.documentElement;
  const isNative = !!(window.Capacitor && window.Capacitor.isNativePlatform?.());
  const systemUi = window.Capacitor?.Plugins?.MarshmallowSystemUi;
  if (!isNative) return;
  if (!systemUi?.getInsets) {
    root.classList.add('native-safe-bottom-missing');
    return;
  }
  root.classList.add('native-safe-area-pending');
  let requestSeq = 0;
  const sync = function () {
    const seq = ++requestSeq;
    systemUi.getInsets().then(function (result) {
      if (seq !== requestSeq || !result?.ok) return;
      const px = function (value) { return `${Math.max(0, Math.round(Number(value) || 0))}px`; };
      root.style.setProperty('--native-safe-top', px(result.top));
      root.style.setProperty('--native-safe-right', px(result.right));
      root.style.setProperty('--native-safe-bottom', px(result.bottom));
      root.style.setProperty('--native-safe-left', px(result.left));
      // getInsets 成功后 bottom=0 也是合法结果：手势导航、导航栏暂时隐藏，
      // 以及某些已经缩短 WebView 的 ROM 都会返回 0。不能再把它当成缺失
      // 并硬塞 48px，否则 chat 等自带底栏的页面会叠出第二层空白。
      root.classList.remove('native-safe-bottom-missing');
      root.classList.remove('native-safe-area-pending');
    }).catch(function () {});
  };
  sync();
  window.setTimeout(sync, 300);
  window.setTimeout(function () {
    if (!root.classList.contains('native-safe-area-pending')) return;
    root.classList.remove('native-safe-area-pending');
    root.classList.add('native-safe-bottom-missing');
  }, 1200);
  window.addEventListener('orientationchange', sync, { passive: true });
  window.addEventListener('marshmallow-native-resume', sync);
}

installNativeSafeAreaVars();

/**
 * iOS 对根层 overscroll-behavior 的执行并非所有版本都稳定。standalone 为了软键盘
 * 保留了 html/body overflow:auto，因此在内层列表顶端继续下拉时，用触摸边界兜底
 * 阻止手势落到 document root。只拦纵向向下越界，不影响正常滚动、横滑和长截图。
 */
function installStandalonePullToRefreshGuard() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  var gesture = null;
  var touchOpts = { capture: true, passive: false };
  // 首页整壳（手账/海/窗）都不该把纵向下拉交给根层：图标、组件、图标间空隙一视同仁。
  // 非 standalone 的 Safari 里 guardActive() 为 false，这个选择器就是首页唯一的防线。
  var homeDragSelector = [
    '.home-shell-page',
    '.home-sea-shell',
    '.home-window-shell',
  ].join(', ');
  var scrollRegionSelector = [
    '.scrapbook-scroll',
    '[data-ime-scroll-region]',
    '.page-scroll',
    '.offline-scroll',
    '.cphone-chat-section',
    '.cphone-subpage-body',
    '.chat-thread-messages',
    '.modal-body',
    '.wb-sheet-body',
  ].join(', ');

  function guardActive() {
    var root = document.documentElement;
    return root.classList.contains('pwa-standalone')
      && !root.classList.contains('capacitor-native')
      && !root.classList.contains('chat-scroll-capture-mode');
  }

  function isHomeDragTarget(target) {
    if (document.documentElement.classList.contains('capacitor-native')) return false;
    return !!(target && typeof target.closest === 'function' && target.closest(homeDragSelector));
  }

  function isScrollableY(node) {
    if (!node) return false;
    try {
      var style = window.getComputedStyle(node);
      var overflowY = String(style.overflowY || '');
      if (overflowY !== 'auto' && overflowY !== 'scroll') return false;
      return Number(node.scrollHeight || 0) > Number(node.clientHeight || 0) + 1;
    } catch (_) {
      return false;
    }
  }

  function findScrollRegion(target) {
    if (!target || typeof target.closest !== 'function') return null;
    // Chat 通讯录等：.cphone-subpage-body 在 is-chat 下是 overflow:hidden，
    // 真正滚动的是内部 .cphone-chat-section。必须只认「当前可纵向滚动」的节点，
    // 否则 scrollTop 恒为 0，上滑（手指向下）会被误判成顶部下拉刷新而 preventDefault。
    var known = target.closest(scrollRegionSelector);
    if (known && isScrollableY(known)) return known;
    var node = target;
    var app = document.getElementById('app');
    while (node && node !== document.body && node !== document.documentElement) {
      if (isScrollableY(node)) return node;
      if (node === app) break;
      node = node.parentElement;
    }
    return null;
  }

  document.addEventListener('touchstart', function (event) {
    var homeDrag = isHomeDragTarget(event.target);
    if ((!guardActive() && !homeDrag) || !event.touches || event.touches.length !== 1) {
      gesture = null;
      return;
    }
    var touch = event.touches[0];
    gesture = {
      x: touch.clientX,
      y: touch.clientY,
      region: findScrollRegion(event.target),
      homeDrag: homeDrag,
    };
  }, touchOpts);

  document.addEventListener('touchmove', function (event) {
    if (
      !gesture
      || (!guardActive() && !gesture.homeDrag)
      || !event.touches
      || event.touches.length !== 1
    ) return;
    var touch = event.touches[0];
    var dx = touch.clientX - gesture.x;
    var dy = touch.clientY - gesture.y;
    // 手指向下且纵向位移占主导：内容已在顶部时，这部分只会造成根层回弹/刷新。
    // 首页图标手势没有 2px 死区：iOS 第一帧 touchmove 不 preventDefault 的话，
    // 原生下拉刷新一旦启动，后续拦截全部无效。
    var moveDeadzone = gesture.homeDrag ? 0 : 2;
    if (dy <= moveDeadzone || Math.abs(dy) <= Math.abs(dx)) return;
    var region = gesture.region;
    if (!region || Number(region.scrollTop || 0) <= 0) {
      event.preventDefault();
    }
  }, touchOpts);

  document.addEventListener('touchend', function () {
    gesture = null;
  }, touchOpts);
  document.addEventListener('touchcancel', function () {
    gesture = null;
  }, touchOpts);
}

installStandalonePullToRefreshGuard();

/* 原生壳保持透明边到边；静态系统栏安全区由 CSS env() 处理，键盘遮挡由
 * MainActivity 的 IME-only inset 单独处理，二者不要混成同一组变量。 */

/**
 * Soft-keyboard fields only. Checkbox / range / file 等不会弹键盘，不必拦。
 */
function isSoftKeyboardField(el) {
  if (!el || typeof el.matches !== 'function') return false;
  if (el.disabled) return false;
  if (el.matches('textarea')) return !el.readOnly;
  if (el.matches('[contenteditable="true"]')) return true;
  if (!el.matches('input')) return false;
  if (el.readOnly) return false;
  var type = String(el.type || 'text').toLowerCase();
  if (
    type === 'button' || type === 'checkbox' || type === 'radio' || type === 'file'
    || type === 'range' || type === 'submit' || type === 'reset' || type === 'image'
    || type === 'hidden' || type === 'color'
  ) return false;
  return true;
}

function installNativeSelectionGuard() {
  if (typeof document === 'undefined') return;
  document.addEventListener('contextmenu', function (event) {
    var root = document.documentElement;
    if (!root.classList.contains('pwa-standalone') && !root.classList.contains('capacitor-native')) return;
    var target = event.target;
    var editable = target && typeof target.closest === 'function'
      ? target.closest('input, textarea, [contenteditable="true"]')
      : null;
    if (editable && isSoftKeyboardField(editable)) return;
    event.preventDefault();
  }, { capture: true });
}

installNativeSelectionGuard();

/**
 * 滑动经过输入框时不要弹键盘：手指位移超过阈值，或本轮手势已判定为拖动，
 * 则立刻 blur，并在随后很短窗口内吞掉 click 合成带来的二次聚焦。
 * 真正的点按（几乎无位移）不受影响。
 */
function installAccidentalInputFocusGuard() {
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  var MOVE_THRESHOLD = 12;
  var SUPPRESS_MS = 450;
  var gesture = null;
  var suppressUntil = 0;
  var suppressExemptField = null;
  var touchOpts = { capture: true, passive: true };

  function activeSoftField() {
    var el = document.activeElement;
    return isSoftKeyboardField(el) ? el : null;
  }

  function blurIfAccidental(field) {
    if (!field || !isSoftKeyboardField(field)) return;
    if (gesture && gesture.focusedAtStart === field) return;
    if (suppressExemptField && field === suppressExemptField && Date.now() < suppressUntil) return;
    try { field.blur(); } catch (_) {}
  }

  function markMoved(clientX, clientY) {
    if (!gesture || gesture.moved) return;
    var dx = Math.abs(clientX - gesture.x);
    var dy = Math.abs(clientY - gesture.y);
    if (dx <= MOVE_THRESHOLD && dy <= MOVE_THRESHOLD) return;
    gesture.moved = true;
    blurIfAccidental(activeSoftField());
  }

  function endGesture() {
    if (gesture && gesture.moved) {
      // 抑制窗只给安卓 WebView：那里滚动手势结束后可能仍合成 click→focus。
      // iOS 的滚动不会合成 click，误触已由 PWA 聚焦路径的位移取消覆盖；
      // 若在 iOS 也开这个 450ms 窗，橡皮筋/吸附动画带来的微小位移会把
      // 紧跟着的正常点按一起吞掉，表现为「所有输入框键盘都不弹」。
      if (!isIosWebKitDevice()) {
        suppressUntil = Date.now() + SUPPRESS_MS;
        suppressExemptField = gesture.focusedAtStart;
      }
      blurIfAccidental(activeSoftField());
    } else {
      suppressExemptField = null;
    }
    gesture = null;
  }

  function shouldSuppressFocus() {
    return !!(gesture && gesture.moved) || Date.now() < suppressUntil;
  }

  document.addEventListener('touchstart', function (e) {
    if (!e.touches || e.touches.length !== 1) {
      gesture = null;
      return;
    }
    // 新一轮触摸覆盖上一轮「拖动后的短抑制」，避免划完立刻点输入框仍被误拦。
    suppressUntil = 0;
    suppressExemptField = null;
    var t = e.touches[0];
    gesture = {
      x: t.clientX,
      y: t.clientY,
      moved: false,
      focusedAtStart: activeSoftField(),
    };
  }, touchOpts);

  document.addEventListener('touchmove', function (e) {
    if (!gesture || !e.touches || e.touches.length !== 1) return;
    var t = e.touches[0];
    markMoved(t.clientX, t.clientY);
  }, touchOpts);

  document.addEventListener('touchend', endGesture, touchOpts);
  document.addEventListener('touchcancel', endGesture, touchOpts);

  document.addEventListener('focusin', function (e) {
    if (!shouldSuppressFocus()) return;
    blurIfAccidental(e.target);
  }, true);

  // 部分安卓 WebView 在 touchend 之后才合成 click→focus；拖动后点到输入框上也不该弹键盘。
  document.addEventListener('click', function (e) {
    if (!shouldSuppressFocus()) return;
    var target = e.target;
    if (!target || typeof target.closest !== 'function') return;
    var field = target.closest('input, textarea, [contenteditable="true"]');
    if (!isSoftKeyboardField(field)) return;
    if (suppressExemptField && field === suppressExemptField) return;
    e.preventDefault();
    e.stopPropagation();
    blurIfAccidental(field);
  }, true);
}

installAccidentalInputFocusGuard();

function installIosPwaInputFix() {
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  if (!isIosWebKitDevice()) return;
  document.documentElement.classList.add('ios-webkit');

  function isStandalonePwa() {
    var root = document.documentElement;
    if (root && root.classList.contains('pwa-standalone')) return true;
    var nav = window.navigator || {};
    return nav.standalone === true;
  }

  // 旧实现在 touchstart 立刻 focus，灵敏屏上「划过输入框」会先弹键盘再被 blur，闪一下。
  // 改为确认是点按（位移未超阈值）后在 touchend 再 focus，仍落在同一次用户手势里，键盘可正常唤起。
  var MOVE_THRESHOLD = 12;
  var pending = null;
  var touchOpts = { capture: true, passive: true };

  document.addEventListener('touchstart', function (e) {
    if (!isStandalonePwa()) return;
    if (!e.touches || e.touches.length !== 1) {
      pending = null;
      return;
    }
    var target = e.target;
    if (!target || typeof target.closest !== 'function') {
      pending = null;
      return;
    }
    var field = target.closest('input, textarea, select, [contenteditable="true"]');
    if (!field || field.disabled || field.readOnly) {
      pending = null;
      return;
    }
    if (document.activeElement === field) {
      pending = null;
      return;
    }
    var t = e.touches[0];
    pending = {
      field: field,
      x: t.clientX,
      y: t.clientY,
      cancelled: false,
      managedScroll: !!field.closest('.wb-sheet-body, .modal-body, .scrapbook-scroll, [data-ime-scroll-region]'),
    };
  }, touchOpts);

  document.addEventListener('touchmove', function (e) {
    if (!pending || !e.touches || e.touches.length !== 1) return;
    var t = e.touches[0];
    if (
      Math.abs(t.clientX - pending.x) > MOVE_THRESHOLD
      || Math.abs(t.clientY - pending.y) > MOVE_THRESHOLD
    ) {
      pending.cancelled = true;
    }
  }, touchOpts);

  document.addEventListener('touchend', function () {
    if (!pending || pending.cancelled) {
      pending = null;
      return;
    }
    var field = pending.field;
    var managedScroll = pending.managedScroll;
    pending = null;
    if (!field || !field.isConnected || field.disabled || field.readOnly) return;
    if (document.activeElement === field) return;
    try {
      field.focus({ preventScroll: !!managedScroll });
    } catch (_) {
      try { field.focus(); } catch (__) {}
    }
  }, touchOpts);

  document.addEventListener('touchcancel', function () {
    pending = null;
  }, touchOpts);

  // 兜底：touchend 聚焦可能被橡皮筋 / scroll-snap 引起的十几像素位移误判成滑动而取消。
  // 真正的点按即便带微小位移仍会合成 click（真滚动不会），click 同属这次用户手势，
  // 在这里补一次 focus 既能唤起键盘，也不会把误触问题带回来。
  document.addEventListener('click', function (e) {
    if (!isStandalonePwa()) return;
    var target = e.target;
    if (!target || typeof target.closest !== 'function') return;
    var field = target.closest('input, textarea, select, [contenteditable="true"]');
    if (!field || field.disabled || field.readOnly) return;
    if (document.activeElement === field) return;
    try { field.focus(); } catch (_) {}
  }, true);
}

installIosPwaInputFix();

/**
 * iOS form fields: keep the focused control inside its nearest real scroll region.
 * WebKit can otherwise scroll the document root behind a fixed 100dvh PWA shell,
 * leaving the visual field and its hit target out of sync.
 */
function installEditableFieldFocusScroll() {
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  if (!isIosWebKitDevice()) return;
  var timer = 0;
  var followupTimer = 0;
  var activeRegion = null;
  var activePanel = null;

  function findScrollRegion(field) {
    if (!field || typeof field.closest !== 'function') return null;
    return field.closest('.wb-sheet-body, .modal-body, .offline-settings-sheet-body, .scrapbook-scroll, [data-ime-scroll-region]');
  }

  function scrollField(field) {
    var region = findScrollRegion(field);
    if (!region || !field.isConnected || document.activeElement !== field) return;
    try {
      var fieldRect = field.getBoundingClientRect();
      var regionRect = region.getBoundingClientRect();
      var vv = window.visualViewport;
      var viewportTop = vv ? Number(vv.offsetTop || 0) : 0;
      var viewportBottom = viewportTop + (vv ? Number(vv.height || 0) : Number(window.innerHeight || 0));
      var visibleTop = Math.max(regionRect.top, viewportTop) + 14;
      var visibleBottom = Math.min(regionRect.bottom, viewportBottom) - 18;
      var delta = 0;
      if (fieldRect.bottom > visibleBottom) delta = fieldRect.bottom - visibleBottom;
      else if (fieldRect.top < visibleTop) delta = fieldRect.top - visibleTop;
      if (Math.abs(delta) > 1) region.scrollTop += delta;
    } catch (_) {
      try { field.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' }); } catch (__) {}
    }
  }

  function activateRegion(region) {
    if (!region || activeRegion === region) return;
    if (activeRegion) {
      activeRegion.classList.remove('ime-scroll-active');
      activeRegion.style.removeProperty('--ime-base-padding-bottom');
    }
    if (activePanel) activePanel.classList.remove('ime-panel-active');
    activeRegion = region;
    activePanel = region.closest('.modal-sheet, .wb-sheet-panel, .offline-settings-sheet-panel');
    try {
      var basePadding = getComputedStyle(region).paddingBottom || '0px';
      region.style.setProperty('--ime-base-padding-bottom', basePadding);
    } catch (_) {}
    region.classList.add('ime-scroll-active');
    if (activePanel) activePanel.classList.add('ime-panel-active');
  }

  document.addEventListener('focusin', function (e) {
    var field = e.target;
    if (!field || typeof field.matches !== 'function') return;
    if (!field.matches('input, textarea, select, [contenteditable="true"]')) return;
    var region = findScrollRegion(field);
    if (!region) return;
    activateRegion(region);
    if (timer) clearTimeout(timer);
    if (followupTimer) clearTimeout(followupTimer);
    // Run after the first keyboard frame, then once more near the end of the
    // iOS keyboard animation. Use instant region scrolling to avoid fighting IME.
    timer = setTimeout(function () {
      timer = 0;
      scrollField(field);
      followupTimer = setTimeout(function () {
        followupTimer = 0;
        scrollField(field);
      }, 260);
    }, 80);
  }, true);

  document.addEventListener('focusout', function () {
    setTimeout(function () {
      if (!activeRegion) return;
      var next = document.activeElement;
      if (next && activeRegion.contains(next)
        && typeof next.matches === 'function'
        && next.matches('input, textarea, select, [contenteditable="true"]')) return;
      activeRegion.classList.remove('ime-scroll-active');
      activeRegion.style.removeProperty('--ime-base-padding-bottom');
      if (activePanel) activePanel.classList.remove('ime-panel-active');
      activeRegion = null;
      activePanel = null;
    }, 0);
  }, true);
}

installEditableFieldFocusScroll();

if (!isDiagnosticsPage()) {
  import('./core/pwa-install.js').then(function (mod) {
    if (mod && typeof mod.initPwaInstall === 'function') mod.initPwaInstall();
  }).catch(function () {});
}

function showBootError(title, detail) {
  if (typeof window !== 'undefined') {
    window.__MARSHMALLOW_BOOT_FAILED = true;
  }
  const esc = function (s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  };
  const app = document.getElementById('app');
  const html = `
    <div style="min-height:100vh;padding:24px 18px;box-sizing:border-box;font-family:system-ui,-apple-system,sans-serif;background:#fbf6f0;color:#5c7b8f;">
      <p style="font-size:17px;font-weight:600;margin:0 0 12px;">${esc(title)}</p>
      <p style="font-size:14px;line-height:1.55;margin:0 0 8px;word-break:break-word;">${esc(detail)}</p>
      <p style="font-size:12px;line-height:1.5;margin:12px 0 0;opacity:.75;">可尝试：切换 Wi‑Fi / 蜂窝网络、关闭 VPN；打开急救诊断页完整校验更新（不会删聊天或先删旧版本）。不要用系统里的「清除网站数据」。若主屏幕版异常，可先用 Safari 标签页打开。建议 iOS 15+。${inAppBrowserHint() ? (' ' + esc(inAppBrowserHint())) : ''}</p>
      <p style="font-size:13px;line-height:1.5;margin:14px 0 0;"><a href="recovery.html" style="color:#c0563f;font-weight:700;">▶ 打开急救诊断页（校验更新 / 定位原因）</a></p>
    </div>`;
  if (app) {
    app.innerHTML = html;
  } else {
    document.body.innerHTML = html;
  }
}

function isLocalPreviewHost() {
  try {
    const h = (typeof location !== 'undefined' && location.hostname) ? String(location.hostname) : '';
    if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return true;
    // 手机局域网预览（如 192.168.x.x:3000）与 localhost 同样跳过 SW，避免 IDB/SW 竞态
    if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
    if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
    return false;
  } catch (_) {
    return false;
  }
}

/**
 * QQ / 微信等 App 内置 WebView：SW 易触发反复刷新或缓存错乱，跳过注册并清理旧 SW。
 * 同样适用于 Capacitor 原生壳——那边网页资源本来就是本地打包 + Capgo 热更新在管，
 * 叠加一层 SW 自己的 Cache Storage 只会导致「明明 Capgo 换了新文件，SW 还在吐旧缓存」。
 */
function isInAppEmbeddedBrowser() {
  try {
    if (typeof window !== 'undefined' && window.Capacitor) return true;
    const ua = String((typeof navigator !== 'undefined' && navigator.userAgent) || '');
    if (/MicroMessenger/i.test(ua)) return true;
    if (/MQQBrowser/i.test(ua)) return true;
    if (/\bQQ\//i.test(ua)) return true;
    if (/Weibo/i.test(ua)) return true;
    if (/DingTalk/i.test(ua)) return true;
    if (/AlipayClient/i.test(ua)) return true;
    if (/baiduboxapp/i.test(ua)) return true;
    if (/BytedanceWebview|NewsArticle/i.test(ua)) return true;
    return false;
  } catch (_) {
    return false;
  }
}

function isCapacitorNative() {
  try {
    return typeof window !== 'undefined' && !!window.Capacitor;
  } catch (_) {
    return false;
  }
}

function inAppBrowserHint() {
  // 「在浏览器中打开」这条提示是给 QQ/微信这类第三方内置浏览器逃生用的，
  // 我们自己的原生壳没有这个逃生按钮，提示反而会误导用户。
  if (isCapacitorNative()) return '';
  if (!isInAppEmbeddedBrowser()) return '';
  return '当前为 App 内置浏览器（如 QQ / 微信）。若页面空白或一直加载，请点右上角「在浏览器中打开」，用系统 Chrome 或 Safari 访问。';
}

function cleanupLocalServiceWorkerAndCaches() {
  if (!('serviceWorker' in navigator)) return Promise.resolve();
  let chain = navigator.serviceWorker.getRegistrations()
    .then(function (regs) {
      return Promise.all((regs || []).map(function (r) { return r.unregister(); }));
    })
    .catch(function () {});
  if (!('caches' in window)) return chain;
  return chain.then(function () {
    return caches.keys()
      .then(function (keys) {
        return Promise.all(
          (keys || [])
            .filter(function (k) { return /^marshmallow-phone-v\d+$/i.test(String(k)); })
            .map(function (k) { return caches.delete(k); }),
        );
      })
      .catch(function () {});
  });
}

const SW_REPAIR_UNTIL_KEY = '__mm_sw_repair_until__';
const SW_REPAIR_MAX_COOLDOWN_MS = 15 * 60 * 1000;

function isServiceWorkerRepairCooldown() {
  try {
    const until = Number(window.localStorage.getItem(SW_REPAIR_UNTIL_KEY) || 0);
    const now = Date.now();
    if (until > now) {
      // 旧版急救页会停用正式缓存 24 小时。成功更新到新版后把遗留窗口收紧，
      // 避免这批用户整天都在冷启动时重新走页面模块网络请求。
      if (until - now > SW_REPAIR_MAX_COOLDOWN_MS) {
        window.localStorage.setItem(SW_REPAIR_UNTIL_KEY, String(now + SW_REPAIR_MAX_COOLDOWN_MS));
      }
      return true;
    }
    if (until) window.localStorage.removeItem(SW_REPAIR_UNTIL_KEY);
  } catch (_) {}
  return false;
}

function loadApp() {
  mmlog('info', '开始加载 app.js?v=' + BUILD);
  return import(`./app.js?v=${encodeURIComponent(BUILD)}`).then(function (mod) {
    mmlog('info', 'app.js 加载成功');
    return mod;
  }).catch(function (err) {
    mmlog('error', 'app.js 加载失败: ' + ((err && err.stack) || (err && err.message) || err));
    console.error('[boot] app.js load failed:', err);
    showBootError(
      '页面脚本加载失败',
      (err && err.message) || String(err) || '请检查网络后刷新；若持续失败请联系站点维护者。',
    );
    throw err;
  });
}

function loadVerifiedApp() {
  return verifyNativeBundleCompatibilityBeforeBoot()
    .then(function () { return loadApp(); })
    .catch(function (err) {
      mmlog('error', '原生资源包兼容校验失败: ' + ((err && err.message) || err));
      showBootError(
        '资源包兼容校验失败',
        (err && err.message) || '已停止打开本地数据库，请刷新页面或打开急救页。',
      );
      throw err;
    });
}

const localPreview = isLocalPreviewHost();
const embeddedInApp = isInAppEmbeddedBrowser();
const embeddedBeautifyPreview = isEmbeddedBeautifyPreview();
const serviceWorkerRepairCooldown = isServiceWorkerRepairCooldown();
let appPromise;
if (isDiagnosticsPage() || isResettingPage()) {
  appPromise = Promise.resolve();
} else if (embeddedBeautifyPreview) {
  // 美化工作室 iframe 只渲染真实页面；原生热更新校验必须由顶层 App 独占。
  // Capacitor 插件桥在子 frame 里可能拿不到回调，继续校验会把预览永久卡在启动页。
  appPromise = loadApp();
} else if (localPreview) {
  // index.html 已在任何模块加载前安装 network-only 预览 Worker 并清理旧静态缓存。
  // 保留该 Worker 才能保证后续动态 import 也持续直读磁盘，不能在这里再次注销。
  appPromise = loadVerifiedApp();
} else {
  // ?reset=1 / recovery.html 已经执行过一次限时清理。兼容期内不能每次启动都再次
  // 调 getRegistrations()/caches.keys()：华为浏览器可能长期不返回，甚至与后续
  // 安装占位 SW 竞态。这里只直接启动，并保持正式离线 SW 停用。
  appPromise = loadVerifiedApp();
}

function shouldRegisterServiceWorker() {
  if (isDiagnosticsPage() || isResettingPage() || localPreview || embeddedInApp || embeddedBeautifyPreview || serviceWorkerRepairCooldown) return false;
  return 'serviceWorker' in navigator;
}

if (embeddedInApp) {
  mmlog('warn', '检测到 App 内置浏览器，已跳过 Service Worker 注册');
}
if (serviceWorkerRepairCooldown) {
  mmlog('warn', '急救兼容启动生效中，已暂时停用 Service Worker');
}
if (embeddedInApp && !embeddedBeautifyPreview && 'serviceWorker' in navigator) {
  cleanupLocalServiceWorkerAndCaches().catch(function () {});
}

const updateSafetyState = globalThis.__mm_update_safety_state__
  || { criticalCount: 0, labels: {}, lastInteractionAt: Date.now() };
globalThis.__mm_update_safety_state__ = updateSafetyState;
const riskyActivityKey = '__mm_risky_activity__';
const interruptedRiskKey = '__mm_last_interrupted_risky_activity__';
const chatMediaQuarantineKey = '__mm_chat_media_decode_quarantine__';
try {
  const previousRisk = JSON.parse(localStorage.getItem(riskyActivityKey) || 'null');
  if (previousRisk?.label && Date.now() - Number(previousRisk.startedAt || 0) < 24 * 60 * 60 * 1000) {
    const interruptedRisk = {
      ...previousRisk,
      detectedAt: Date.now(),
      detectedByBuild: BUILD,
    };
    localStorage.setItem(interruptedRiskKey, JSON.stringify(interruptedRisk));
    if (previousRisk.label === 'chat-media-decode' && previousRisk.detail?.messageId) {
      // 下次进入同一会话时先保留占位，由用户明确点击后再恢复这张媒体，
      // 避免 WebKit 在自动恢复路由时反复解码同一张图形成崩溃循环。
      localStorage.setItem(chatMediaQuarantineKey, JSON.stringify(interruptedRisk));
    }
    mmlog(
      'warn',
      `上次页面在高内存阶段中断：${String(previousRisk.label)} `
        + `${JSON.stringify(previousRisk.detail || {}).slice(0, 600)}`,
    );
  }
  localStorage.removeItem(riskyActivityKey);
} catch (_) {}

// “上次中断”是事故线索而不是永久状态。新构建稳定运行一段时间且当前没有
// 高风险任务时清掉历史记录，避免数周前的构建号被急救页误当成本次闪退。
window.addEventListener('marshmallow-app-ready', function () {
  window.setTimeout(function () {
    try {
      if (!localStorage.getItem(riskyActivityKey)) localStorage.removeItem(interruptedRiskKey);
    } catch (_) {}
  }, 60 * 1000);
}, { once: true });
globalThis.__mm_mark_risky_activity__ = function (label, detail = {}) {
  const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    localStorage.setItem(riskyActivityKey, JSON.stringify({
      token,
      label: String(label || 'operation'),
      detail: detail && typeof detail === 'object' ? detail : { value: String(detail || '') },
      startedAt: Date.now(),
      build: BUILD,
    }));
  } catch (_) {}
  return token;
};
globalThis.__mm_clear_risky_activity__ = function (token) {
  try {
    const current = JSON.parse(localStorage.getItem(riskyActivityKey) || 'null');
    if (!token || current?.token === token) localStorage.removeItem(riskyActivityKey);
  } catch (_) {}
};
globalThis.__mm_begin_critical_activity__ = function (label) {
  const key = String(label || 'operation');
  updateSafetyState.criticalCount += 1;
  updateSafetyState.labels[key] = Number(updateSafetyState.labels[key] || 0) + 1;
  let released = false;
  try {
    window.dispatchEvent(new CustomEvent('marshmallow-critical-activity', {
      detail: { active: true, label: key, count: updateSafetyState.criticalCount },
    }));
  } catch (_) {}
  return function () {
    if (released) return;
    released = true;
    updateSafetyState.criticalCount = Math.max(0, updateSafetyState.criticalCount - 1);
    updateSafetyState.labels[key] = Math.max(0, Number(updateSafetyState.labels[key] || 0) - 1);
    try {
      window.dispatchEvent(new CustomEvent('marshmallow-critical-activity', {
        detail: { active: updateSafetyState.criticalCount > 0, label: key, count: updateSafetyState.criticalCount },
      }));
    } catch (_) {}
  };
};
['pointerdown', 'touchstart', 'keydown', 'input'].forEach(function (type) {
  document.addEventListener(type, function () {
    updateSafetyState.lastInteractionAt = Date.now();
  }, { capture: true, passive: type !== 'keydown' && type !== 'input' });
});
if (shouldRegisterServiceWorker()) {
  const hasFreshPendingChatStream = function () {
    try {
      const raw = localStorage.getItem('mm_chat_stream_pending_v1');
      const rows = raw ? JSON.parse(raw) : null;
      const now = Date.now();
      return !!(rows && typeof rows === 'object' && Object.values(rows).some(function (row) {
        const startedAt = Number(row && row.startedAt || 0);
        return startedAt > 0 && now - startedAt < 20 * 60 * 1000;
      }));
    } catch (_) {
      return false;
    }
  };
  const hasActiveForegroundGeneration = function () {
    try {
      if (Number(globalThis.__mm_chat_generation_active__ || 0) > 0) return true;
      if (Number(globalThis.__mm_manual_generation_active__ || 0) > 0) return true;
      if (hasFreshPendingChatStream()) return true;
      return !!document.querySelector(
        '[aria-busy="true"], .is-loading, .app-busy-overlay.is-visible, .generation-activity.is-running',
      );
    } catch (_) {
      return false;
    }
  };
  const hasUnsafeUpdateActivity = function () {
    try {
      if (Number(updateSafetyState.criticalCount || 0) > 0) return true;
      // iOS 从 GitHub 授权页切回来时可能恰逢 Worker 接管。云备份弹窗即使还没来得及
      // 聚焦密码框，也属于未完成操作；页面被 WebKit 重建后仍用短时 marker 延后换版。
      if (hasPendingCloudBackupInteraction()) return true;
      if (Date.now() - Number(updateSafetyState.lastInteractionAt || 0) < 4000) return true;
      const active = document.activeElement;
      if (active && (
        /^(INPUT|TEXTAREA|SELECT)$/i.test(String(active.tagName || ''))
        || active.isContentEditable
      )) return true;
      return !!document.querySelector(
        '.cloud-backup-sheet, .chat-bubble-select:not([hidden]), [data-edit-bubble-sheet], [data-edit-bubble-overlay]',
      );
    } catch (_) {
      return false;
    }
  };
  const warmModuleCache = function (worker) {
    try {
      if (worker) worker.postMessage({ type: 'WARM_MODULE_CACHE' });
    } catch (_) {}
  };
  const scheduleModuleCacheRepair = function (worker) {
    if (!worker) return;
    const key = '__mm_module_cache_repair__';
    const intervalMs = 7 * 24 * 60 * 60 * 1000;
    try {
      const previous = JSON.parse(localStorage.getItem(key) || 'null');
      if (previous
        && previous.build === BUILD
        && Date.now() - Number(previous.checkedAt || 0) < intervalMs) return;
    } catch (_) {}

    let timer = 0;
    const runWhenIdle = function () {
      if (timer) window.clearTimeout(timer);
      if (document.hidden || hasActiveForegroundGeneration() || hasUnsafeUpdateActivity()) {
        timer = window.setTimeout(runWhenIdle, 5000);
        return;
      }
      try {
        localStorage.setItem(key, JSON.stringify({ build: BUILD, checkedAt: Date.now() }));
      } catch (_) {}
      warmModuleCache(worker);
    };
    // 安装阶段已经原子缓存全部模块；这次扫描只负责长期使用后被系统回收的少数条目，
    // 不应在每次冷启动时立刻和用户点页面争用 iOS Cache Storage。
    timer = window.setTimeout(runWhenIdle, 5 * 60 * 1000);
  };
  const isLoginBootstrapController = function () {
    try {
      const controller = navigator.serviceWorker.controller;
      if (!controller || !controller.scriptURL) return false;
      return /\/install-sw\.js(?:[?#]|$)/i.test(String(controller.scriptURL));
    } catch (_) {
      return false;
    }
  };
  let loginBootstrapTakeoverStarted = false;
  const activateLoginBootstrapWorker = function (worker) {
    if (!worker || !isLoginBootstrapController() || loginBootstrapTakeoverStarted) return false;
    loginBootstrapTakeoverStarted = true;
    mmlog('info', '登录占位 Service Worker 已完成使命，切换到完整离线资源');

    let reloadTimer = 0;
    const reloadWhenSafe = function () {
      if (reloadTimer) window.clearTimeout(reloadTimer);
      if (document.hidden || hasActiveForegroundGeneration() || hasUnsafeUpdateActivity()) {
        reloadTimer = window.setTimeout(reloadWhenSafe, 500);
        return;
      }
      try { sessionStorage.setItem('__mm_intentional_update_reload__', '1'); } catch (_) {}
      mmlog('info', '完整离线资源已接管，重新载入首次启动页');
      reloadTimer = window.setTimeout(function () { window.location.reload(); }, 100);
    };
    const handleState = function () {
      if (worker.state !== 'activated') return;
      worker.removeEventListener('statechange', handleState);
      reloadTimer = window.setTimeout(reloadWhenSafe, 100);
    };
    worker.addEventListener('statechange', handleState);
    try {
      worker.postMessage({ type: 'ACTIVATE_LOGIN_BOOTSTRAP' });
      handleState();
    } catch (error) {
      loginBootstrapTakeoverStarted = false;
      worker.removeEventListener('statechange', handleState);
      mmlog('warn', '登录占位 Service Worker 切换失败，将在下次打开时重试');
    }
    return true;
  };
  const watchedInstallingWorkers = new Set();
  const watchInstallingWorker = function (nextWorker) {
    if (!nextWorker || watchedInstallingWorkers.has(nextWorker)) return;
    watchedInstallingWorkers.add(nextWorker);
    const handleInstallingState = function () {
      if (nextWorker.state !== 'installed' || !navigator.serviceWorker.controller) return;
      if (!activateLoginBootstrapWorker(nextWorker)) {
        mmlog('info', '新版 Service Worker 安装完成，保留当前页面的旧构建快照');
      }
    };
    nextWorker.addEventListener('statechange', handleInstallingState);
    handleInstallingState();
  };
  let fullServiceWorkerRegistrationPromise = null;
  const registerFullServiceWorker = function () {
    if (fullServiceWorkerRegistrationPromise) return fullServiceWorkerRegistrationPromise;
    mmlog('info', '首屏已稳定，开始检查完整离线资源');
    fullServiceWorkerRegistrationPromise = navigator.serviceWorker
      .register(`sw.js?v=${encodeURIComponent(BUILD)}`)
      .then(function (registration) {
        scheduleModuleCacheRepair(registration.active);
        if (registration.waiting) {
          if (!activateLoginBootstrapWorker(registration.waiting)) {
            mmlog('info', '新版 Service Worker 已完整下载，将在关闭旧页面后接管');
          }
        }
        // updatefound 可能早于 register() Promise 回调；同时观察当前 installing，
        // 避免首次登录恰好错过事件后仍停留在纯网络占位 Worker。
        watchInstallingWorker(registration.installing);
        registration.addEventListener('updatefound', function () {
          watchInstallingWorker(registration.installing);
        });
        return registration;
      })
      .catch(function () {
        fullServiceWorkerRegistrationPromise = null;
        return null;
      });
    return fullServiceWorkerRegistrationPromise;
  };
  // 默认延后整站快照，通知、Push 等明确依赖 SW 的操作可以按需立即启动。
  globalThis.__mm_ensure_full_service_worker__ = registerFullServiceWorker;
  const scheduleFullServiceWorkerRegistration = function () {
    let timer = 0;
    const mobile = /Android|iPhone|iPad|iPod/i.test(String(navigator.userAgent || ''))
      || (/Mac/i.test(String(navigator.platform || '')) && Number(navigator.maxTouchPoints || 0) > 1);
    const controller = navigator.serviceWorker && navigator.serviceWorker.controller;
    const controllerUrl = String((controller && controller.scriptURL) || '');
    const hasCompleteSnapshot = /\/sw\.js(?:[?#]|$)/i.test(controllerUrl);
    const retryWhenIdle = function () {
      if (timer) window.clearTimeout(timer);
      if (document.hidden || hasActiveForegroundGeneration() || hasUnsafeUpdateActivity()) {
        timer = window.setTimeout(retryWhenIdle, 5000);
        return;
      }
      const start = function () {
        if (document.hidden || hasActiveForegroundGeneration() || hasUnsafeUpdateActivity()) {
          timer = window.setTimeout(retryWhenIdle, 5000);
          return;
        }
        registerFullServiceWorker();
      };
      if (typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(start, { timeout: 4000 });
      } else {
        start();
      }
    };
    const initialDelayMs = hasCompleteSnapshot
      ? (mobile ? 20_000 : 8_000)
      : (mobile ? 60_000 : 30_000);
    timer = window.setTimeout(retryWhenIdle, initialDelayMs);
  };
  if (window.__MARSHMALLOW_BOOT_OK) {
    scheduleFullServiceWorkerRegistration();
  } else {
    window.addEventListener('marshmallow-app-ready', scheduleFullServiceWorkerRegistration, { once: true });
  }
  navigator.serviceWorker.addEventListener('controllerchange', function () {
    // 正常更新不会在旧页面存活时接管；若浏览器或未来代码意外强制接管，继续运行会把
    // 内存中的旧模块与新 Worker 混用。这里只做一次受控重载，不清 IndexedDB。
    // iOS Safari 主屏幕 PWA 可能把 controllerchange 推迟到下一次用户手势；如果这个
    // 手势恰好是「回复 / 生成」，立即 reload 会直接掐断流式请求。生成期间必须延期，
    // 等会话真正结束且页面可见后再换版。
    try {
      if (sessionStorage.getItem('__mm_force_update_in_progress__') === '1') {
        mmlog('info', '用户确认的强制更新已切换控制器，交由更新页完成重载');
        return;
      }
    } catch (_) {}
    let shouldReload = true;
    try {
      const key = '__mm_controller_reload_build__';
      if (sessionStorage.getItem(key) === BUILD) shouldReload = false;
      else sessionStorage.setItem(key, BUILD);
    } catch (_) {}
    if (!shouldReload) return;
    let reloadTimer = 0;
    let deferredLogged = false;
    const reloadWhenSafe = function () {
      if (reloadTimer) window.clearTimeout(reloadTimer);
      if (document.hidden || hasActiveForegroundGeneration() || hasUnsafeUpdateActivity()) {
        if (!deferredLogged) {
          deferredLogged = true;
          mmlog('warn', 'Service Worker 控制器已切换；检测到用户操作进行中，延期到安全时机重载');
        }
        reloadTimer = window.setTimeout(reloadWhenSafe, 800);
        return;
      }
      mmlog('warn', deferredLogged
        ? '用户操作已结束，重载以完成 Service Worker 换版'
        : 'Service Worker 控制器发生切换，重载以保持模块版本一致');
      try { sessionStorage.setItem('__mm_intentional_update_reload__', '1'); } catch (_) {}
      reloadTimer = window.setTimeout(function () { window.location.reload(); }, 250);
    };
    window.addEventListener('marshmallow-generation-activity', reloadWhenSafe);
    window.addEventListener('marshmallow-critical-activity', reloadWhenSafe);
    reloadTimer = window.setTimeout(reloadWhenSafe, 250);
  });
}

appPromise.then(function () {
  // 急救后的这次启动已经完整成功，说明当前构建可解析。立即解除 24 小时遗留标记，
  // 再等用户空闲时后台装回正式缓存；不在首屏或刚点页面时下载整份模块图。
  if (serviceWorkerRepairCooldown && !localPreview && !embeddedInApp && 'serviceWorker' in navigator) {
    try { localStorage.removeItem(SW_REPAIR_UNTIL_KEY); } catch (_) {}
    let restoreTimer = 0;
    const restoreWhenIdle = function () {
      if (restoreTimer) window.clearTimeout(restoreTimer);
      const recentlyActive = Date.now() - Number(updateSafetyState.lastInteractionAt || 0) < 4000;
      const visiblyBusy = !!document.querySelector(
        '[aria-busy="true"], .is-loading, .app-busy-overlay.is-visible, .generation-activity.is-running',
      );
      if (document.hidden || recentlyActive || visiblyBusy || Number(updateSafetyState.criticalCount || 0) > 0) {
        restoreTimer = window.setTimeout(restoreWhenIdle, 5000);
        return;
      }
      navigator.serviceWorker.register(`sw.js?v=${encodeURIComponent(BUILD)}`).catch(function () {});
    };
    restoreTimer = window.setTimeout(restoreWhenIdle, 2 * 60 * 1000);
  }
}).catch(function () {});
