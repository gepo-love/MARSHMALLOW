import { appendDebugEvent } from './debug-log.js';
import { isChatHubInsChromeActiveSync } from './appearance-prefs.js';
import { parseHashRoute } from './router-utils.js';

const _routes = {};
let _currentPage = null;
let _currentParams = {};
let _history = [];
let _renderSeq = 0;
let _pendingNavMeta = null;
let _leaveGuard = null;
let _browserBackPending = false;
let _appearanceHomeRefreshScheduled = false;
const _routeModuleTiming = new Map();

/** 主路径 Keep-Alive：离开时不销毁 DOM，返回时秒开并保留滚动/输入状态 */
const MAX_KEEP_ALIVE_ENTRIES = 8;
const MOBILE_MAX_KEEP_ALIVE_ENTRIES = 4;
const MOBILE_CHAT_KEEP_ALIVE_LIMIT = 1;
const _keepAlivePool = new Map();
let _activePageEl = null;

function isIOSWebKitRuntime() {
  if (typeof navigator === 'undefined') return false;
  const ua = String(navigator.userAgent || '');
  const platform = String(navigator.platform || '');
  return /iPad|iPhone|iPod/i.test(ua)
    || (platform === 'MacIntel' && Number(navigator.maxTouchPoints || 0) > 1);
}

function isConstrainedMobileRuntime() {
  if (typeof navigator === 'undefined') return false;
  if (isIOSWebKitRuntime()) return true;
  const ua = String(navigator.userAgent || '');
  return /Android/i.test(ua)
    || !!globalThis.Capacitor?.isNativePlatform?.()
    || globalThis.Capacitor?.getPlatform?.() === 'android';
}

function dispatchRouteDisposed(entry, reason = 'route-change') {
  const pageEl = entry?.pageEl;
  if (!pageEl) return;
  try {
    window.dispatchEvent(new CustomEvent('marshmallow-route-disposed', {
      detail: {
        path: entry.path || '',
        params: { ...(entry.params || {}) },
        container: pageEl,
        reason,
      },
    }));
  } catch (_) {}
  try { pageEl.replaceChildren(); } catch (_) {}
  try { pageEl.remove(); } catch (_) {}
}

function disposeKeepAliveEntry(key, reason = 'cache-evicted') {
  const entry = _keepAlivePool.get(key);
  if (!entry) return;
  _keepAlivePool.delete(key);
  dispatchRouteDisposed(entry, reason);
}

/**
 * 挂起页面前要记下所有"真的在滚"的容器位置，但不能靠 querySelectorAll('*') 全树扫描——
 * 长聊天记录/联系人列表页 DOM 节点动辄几千个，切页那一下同步扫一遍在部分机型上会造成
 * 明显的卡顿感（表现为"进新页面之前像卡了一下/预加载了一下"）。这里换成全局被动收集：
 * 谁真的产生过 scroll 事件就记下来，挂起时只检查这个小得多的集合，不动其余节点。
 */
const _everScrolledElements = new Set();
let _scrollTrackerBound = false;
function bindScrollTracker() {
  if (_scrollTrackerBound || typeof document === 'undefined') return;
  _scrollTrackerBound = true;
  document.addEventListener('scroll', (e) => {
    const el = e.target;
    if (el && el.nodeType === 1) _everScrolledElements.add(el);
  }, { capture: true, passive: true });
}

/**
 * 非 Keep-Alive 页面（论坛、微博等）返回时仍会冷重建 DOM。只记真正滚动过的容器，
 * 用稳定的标签 + class + 同类序号在新 DOM 中找回对应元素；不扫描整棵长列表。
 */
const MAX_COLD_ROUTE_SCROLL_ENTRIES = 24;
const _coldRouteScrollPool = new Map();

function coldRouteScrollKey(path, params = {}) {
  const pairs = Object.entries(params && typeof params === 'object' ? params : {})
    .filter(([, value]) => value != null && String(value) !== '')
    .sort(([left], [right]) => left.localeCompare(right));
  return `${String(path || '').trim()}?${JSON.stringify(pairs)}`;
}

function captureColdRouteScrollPositions(pageEl) {
  const saved = [];
  try {
    for (const el of _everScrolledElements) {
      if (!el || !el.isConnected || !pageEl.contains(el)) continue;
      const top = Number(el.scrollTop || 0);
      const left = Number(el.scrollLeft || 0);
      if (top <= 0 && left <= 0) continue;
      const tag = String(el.tagName || '').toLowerCase();
      const className = typeof el.className === 'string' ? el.className.trim() : '';
      const id = String(el.id || '').trim();
      let ordinal = 0;
      if (!id && tag) {
        const matches = [...pageEl.getElementsByTagName(tag)]
          .filter((node) => (typeof node.className === 'string' ? node.className.trim() : '') === className);
        ordinal = Math.max(0, matches.indexOf(el));
      }
      saved.push({ tag, className, id, ordinal, top, left });
    }
  } catch (_) {}
  return saved;
}

function rememberColdRouteScroll(path, params, pageEl) {
  const positions = captureColdRouteScrollPositions(pageEl);
  if (!positions.length) return;
  const key = coldRouteScrollKey(path, params);
  _coldRouteScrollPool.delete(key);
  _coldRouteScrollPool.set(key, { positions, savedAt: Date.now() });
  while (_coldRouteScrollPool.size > MAX_COLD_ROUTE_SCROLL_ENTRIES) {
    _coldRouteScrollPool.delete(_coldRouteScrollPool.keys().next().value);
  }
}

function restoreColdRouteScroll(path, params, pageEl) {
  const entry = _coldRouteScrollPool.get(coldRouteScrollKey(path, params));
  if (!entry?.positions?.length) return;
  const apply = () => {
    if (!pageEl?.isConnected || pageEl.hidden) return;
    for (const saved of entry.positions) {
      let el = null;
      if (saved.id && typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
        el = pageEl.querySelector(`#${CSS.escape(saved.id)}`);
      }
      if (!el && saved.tag) {
        const matches = [...pageEl.getElementsByTagName(saved.tag)]
          .filter((node) => (typeof node.className === 'string' ? node.className.trim() : '') === saved.className);
        el = matches[saved.ordinal] || null;
      }
      if (!el) continue;
      el.scrollTop = Math.max(0, Number(saved.top) || 0);
      el.scrollLeft = Math.max(0, Number(saved.left) || 0);
    }
  };
  // 首次布局与图片/字体落位各补一次；同一帧内不做平滑滚动，避免返回时闪过顶部。
  apply();
  requestAnimationFrame(() => {
    apply();
    requestAnimationFrame(apply);
  });
}

export function keepAliveCacheKey(path, params = {}) {
  const p = String(path || '').trim();
  if (p === 'contacts') {
    if (String(params.scope || '').trim() !== 'identity') return p;
    // 通用通讯录与档位身份通讯录的列表、角色数据和点击保存行为都不同，不能复用
    // 同一个 Keep-Alive 页面。否则先打开通用通讯录后再从聊天侧栏进入，会直接恢复
    // 旧 DOM 和旧事件监听，表现为仍显示全部角色，并把编辑写回通用角色卡。
    const identityUserId = String(params.identityUserId || '').trim();
    const characterIds = String(params.characterIds || params.characterId || '').trim();
    const groupIds = String(params.groupIds || params.groupId || '').trim();
    const excludedCharacterIds = String(params.excludedCharacterIds || '').trim();
    const identityKey = [
      identityUserId,
      `groups:${groupIds}`,
      `characters:${characterIds}`,
      `excluded:${excludedCharacterIds}`,
    ]
      .filter(Boolean)
      .map((value) => encodeURIComponent(value))
      .join(':');
    return `contacts:identity:${identityKey || 'current'}`;
  }
  if (
    p === 'home'
    || p === 'chat'
    || p === 'chat/contacts'
    || p === 'chat/moments'
    || p === 'chat/intercepts'
    || p === 'presets'
    || p === 'user-space'
  ) return p;
  if (p === 'travel-char') {
    const char = String(params.character || params.characterId || '').trim();
    return char ? `travel-char:${char}` : 'travel-char';
  }
  if (p === 'chat/thread') {
    const from = String(params.from || '').trim();
    if (from === 'anon' || from === 'streamer') return null;
    const chatId = String(params.chatId || '').trim();
    if (!chatId) return null;
    // 角色手机视角：同一 chatId 在不同主人手机里气泡左右对调，必须按 viewer 分缓存，
    // 否则 Keep-Alive 会复用「先打开的那个人」的视角。
    const viewer = String(params.viewer || '').trim();
    if (from === 'phone' && viewer) return `chat/thread:${chatId}:phone:${viewer}`;
    return `chat/thread:${chatId}`;
  }
  // 陪伴几个子页来回跳很频繁（选场景→一起听→记录），不缓存会整页重建导致"跳一下"的观感。
  if (p === 'companion' || p === 'companion/listen') return p;
  if (p === 'companion/history') {
    const characterId = String(params.characterId || '').trim();
    return `${p}:${characterId ? encodeURIComponent(characterId) : 'all'}`;
  }
  if (p === 'companion/history/detail') {
    const id = String(params.id || '').trim();
    return id ? `companion/history/detail:${id}` : null;
  }
  // 线下沉浸长段多轮：切页再回不要整页重建，降低进行中会话被误覆盖的窗口。
  if (p === 'offline') {
    const chatId = String(params.chatId || '').trim();
    return chatId ? `offline:${chatId}` : null;
  }
  return null;
}

function trimMobileChatKeepAliveEntries(keepKey = '', limit = MOBILE_CHAT_KEEP_ALIVE_LIMIT) {
  if (!isConstrainedMobileRuntime()) return;
  const entries = [..._keepAlivePool.entries()]
    .filter(([, entry]) => entry?.path === 'chat/thread')
    .sort((left, right) => Number(right[1]?.lastUsed || 0) - Number(left[1]?.lastUsed || 0));
  let kept = 0;
  for (const [key] of entries) {
    if (key === keepKey || kept < limit) {
      kept += 1;
      continue;
    }
    disposeKeepAliveEntry(key, 'ios-chat-cache-limit');
  }
}

function trimKeepAlivePool() {
  const limit = isConstrainedMobileRuntime()
    ? MOBILE_MAX_KEEP_ALIVE_ENTRIES
    : MAX_KEEP_ALIVE_ENTRIES;
  if (_keepAlivePool.size <= limit) return;
  const entries = [..._keepAlivePool.entries()]
    .sort((a, b) => (a[1].lastUsed || 0) - (b[1].lastUsed || 0));
  while (_keepAlivePool.size > limit && entries.length) {
    const [key] = entries.shift();
    disposeKeepAliveEntry(key, 'cache-limit');
  }
}

/**
 * DOM 被从文档里摘下来（或 display:none）时浏览器会把所有元素的 scrollTop 清零，
 * 恢复时页面就停在顶部——聊天页表现为「进页先看到"加载更早"的顶端，等异步刷新才
 * 跳回底部，翻着历史离开的话干脆停在顶上不动」。挂起前把每个滚动容器的位置记下来，
 * 恢复时在浏览器绘制之前同步写回去。
 */
function captureScrollPositions(pageEl) {
  const saved = [];
  try {
    for (const el of _everScrolledElements) {
      if (!el || !el.isConnected || !pageEl.contains(el)) continue;
      const top = el.scrollTop;
      const left = el.scrollLeft;
      if (top > 0 || left > 0) saved.push({ el, top, left });
    }
  } catch (_) {}
  return saved;
}

function restoreScrollPositions(saved) {
  if (!Array.isArray(saved)) return;
  for (const entry of saved) {
    try {
      if (entry.el && entry.el.isConnected) {
        entry.el.scrollTop = entry.top;
        entry.el.scrollLeft = entry.left;
      }
    } catch (_) {}
  }
}

/** Keep-Alive 页面复挂后在下一帧广播稳定事件，不切换整页合成层。 */
function settleResumedPage(page, path, params) {
  if (!page) return;
  try {
    // 读取真实几何，让 DOM 复挂和滚动恢复在首帧前提交。
    page.getBoundingClientRect();
  } catch (_) {}
  requestAnimationFrame(() => {
    if (!page.isConnected || page.hidden) return;
    try { page.getBoundingClientRect(); } catch (_) {}
    window.dispatchEvent(new CustomEvent('marshmallow-route-settled', {
      detail: {
        path,
        params: { ...params },
        resumed: true,
        container: page,
      },
    }));
  });
}

function suspendActivePageToPool(preserveKey = '') {
  if (!_activePageEl) return;
  const prevKey = keepAliveCacheKey(_currentPage, _currentParams);
  const renderState = _activePageEl.dataset.routeRenderState || '';
  const renderIncomplete = ['pending', 'failed', 'interrupted', 'stale'].includes(renderState);
  if (prevKey && !renderIncomplete) {
    // 必须在 hidden/removeChild 之前抓滚动位置：一旦脱离布局，scrollTop 就读不到了。
    const scrollPositions = captureScrollPositions(_activePageEl);
    _activePageEl.classList.add('page--suspended');
    _activePageEl.hidden = true;
    if (_activePageEl.parentNode) _activePageEl.parentNode.removeChild(_activePageEl);
    _keepAlivePool.set(prevKey, {
      pageEl: _activePageEl,
      path: _currentPage,
      params: { ..._currentParams },
      scrollPositions,
      lastUsed: Date.now(),
    });
    // 跳往一个已缓存聊天时，目标页会在本函数之后立刻恢复。移动端只能保留一个
    // 后台聊天，因此淘汰时必须优先保护目标缓存；否则会出现「先确认缓存存在，
    // 挂起当前页时又把目标删掉」的竞态，主容器清空后恢复 undefined 直接白屏。
    trimMobileChatKeepAliveEntries(preserveKey || prevKey);
    trimKeepAlivePool();
  } else {
    // 尚未完成的异步页面不能进入 Keep-Alive。快速连点时若缓存半成品 DOM，切回会
    // 被误判为“秒开成功”，实际仍由上一次已过期的 Promise 在后台继续改页面。
    if (!renderIncomplete) rememberColdRouteScroll(_currentPage, _currentParams, _activePageEl);
    else _activePageEl.dataset.routeRenderState = 'interrupted';
    dispatchRouteDisposed({
      pageEl: _activePageEl,
      path: _currentPage,
      params: { ..._currentParams },
    }, renderIncomplete ? 'render-interrupted' : 'route-change');
  }
  _activePageEl = null;
}

/** 会话删除等场景下主动清掉缓存的聊天页实例 */
export function invalidateKeepAlive(path, params = {}) {
  const key = keepAliveCacheKey(path, params);
  if (key) disposeKeepAliveEntry(key, 'invalidated');
  // chat/thread 还有 phone:viewer 变体；按 chatId 前缀一并清掉，避免删会话后残留旧视角。
  if (String(path || '').trim() === 'chat/thread') {
    const chatId = String(params.chatId || '').trim();
    if (chatId) {
      const prefix = `chat/thread:${chatId}`;
      for (const k of [..._keepAlivePool.keys()]) {
        if (k === prefix || k.startsWith(`${prefix}:`)) disposeKeepAliveEntry(k, 'chat-invalidated');
      }
    }
  }
  // 角色手机存在 app/from/chatId 等多个复进变体。按角色清理内容后必须全部失效，
  // 否则 IndexedDB 已经删净，旧 Keep-Alive DOM 仍会让用户看到原手机记录。
  if (String(path || '').trim() === 'character-phone') {
    const characterId = String(params.character || '').trim();
    if (characterId) {
      for (const [k, entry] of [..._keepAlivePool.entries()]) {
        if (
          entry?.path === 'character-phone'
          && String(entry?.params?.character || '').trim() === characterId
        ) {
          disposeKeepAliveEntry(k, 'character-phone-invalidated');
        }
      }
    }
  }
}

/** 线下收纳后清掉所有带该现场标记的 Chat 页面，避免恢复旧 DOM 时仍显示“正在线下”。 */
export function invalidateOfflinePresenceKeepAlive(offlineChatId) {
  const id = String(offlineChatId || '').trim();
  if (!id) return;
  for (const [key, entry] of [..._keepAlivePool.entries()]) {
    if (
      entry?.path === 'chat'
      || String(entry?.params?.offlineChatId || '').trim() === id
    ) {
      disposeKeepAliveEntry(key, 'offline-invalidated');
    }
  }
}

/** 美化/壁纸变更后：主屏、消息列表与所有已缓存的聊天页都必须重绘，不能继续用 Keep-Alive 里的旧 DOM */
export function invalidateAppearanceKeepAlive() {
  invalidateKeepAlive('home');
  invalidateKeepAlive('chat');
  invalidateKeepAlive('contacts');
  invalidateKeepAlive('chat/contacts');
  invalidateKeepAlive('chat/moments');
  invalidateKeepAlive('chat/intercepts');
  for (const key of [..._keepAlivePool.keys()]) {
    if (key.startsWith('chat/thread:')) disposeKeepAliveEntry(key, 'appearance-invalidated');
  }
}

/** 切换档位（用户槽位）后：几乎所有页面的数据都按 userId 隔离，缓存里的旧 DOM 全部作废 */
export function invalidateAllKeepAlive() {
  for (const key of [..._keepAlivePool.keys()]) {
    disposeKeepAliveEntry(key, 'all-invalidated');
  }
  _coldRouteScrollPool.clear();
}

function dispatchRouteActivated(path, params, container, resumed) {
  window.dispatchEvent(new CustomEvent('marshmallow-route-activated', {
    detail: {
      path,
      params: { ...params },
      resumed: !!resumed,
      container,
    },
  }));
  window.dispatchEvent(new CustomEvent('marshmallow-route-rendered', {
    detail: { path, params: { ...params }, resumed: !!resumed },
  }));
}

/** app.js 在 import() 页面模块后上报耗时，慢日志里区分「模块加载慢」与「数据/渲染慢」 */
export function reportRouteModuleTiming(path, moduleMs) {
  _routeModuleTiming.set(String(path || ''), Math.round(Number(moduleMs) || 0));
}

const _container = () => document.getElementById('page-container');

/**
 * 页面弹层共用 #modal-container；若从悬浮入口、深链或系统返回直接切路由，
 * 页面自己的 close 回调可能没有机会执行，留下的 active 全屏层会继续吞掉触摸。
 * 通话层有意跨页悬浮，必须保留；其它页面级弹层在路由切换时统一收口。
 */
function prepareGlobalUiForRouteChange() {
  const modal = document.getElementById('modal-container');
  const preservesVoiceCall = !!modal?.querySelector('.voice-call-overlay');
  const active = document.activeElement;

  if (active && active !== document.body) {
    const focusBelongsToPage = !!_activePageEl?.contains(active);
    const focusBelongsToDismissedModal = !!(modal?.contains(active) && !preservesVoiceCall);
    if (focusBelongsToPage || focusBelongsToDismissedModal) {
      try { active.blur(); } catch (_) {}
    }
  }

  if (!modal || preservesVoiceCall) return;
  modal.classList.remove('active', 'has-floating-call');
  modal.replaceChildren();
}

/**
 * 给当前页面注册一个"离开前确认"钩子：切路由前会传入目标 path/params 调用它，
 * 返回 false 会中止本次导航
 * （popstate 场景下会把地址栏状态还原回去，避免出现"URL 变了但页面没变"的错位）。
 * 页面卸载/确认放行时应自行调用 clearLeaveGuard() 清掉，避免钩子残留影响下次导航。
 */
export function setLeaveGuard(fn) {
  _leaveGuard = typeof fn === 'function' ? fn : null;
}

export function clearLeaveGuard() {
  _leaveGuard = null;
}

function checkLeaveGuard(nextPath, nextParams) {
  if (!_leaveGuard) return true;
  if (sameRoute({ path: _currentPage, params: _currentParams }, { path: nextPath, params: nextParams || {} })) return true;
  let ok = true;
  try {
    ok = !!_leaveGuard(nextPath, nextParams || {});
  } catch (_) {
    ok = true;
  }
  if (ok) _leaveGuard = null;
  return ok;
}

function isAnonShellRoute(path, params = {}) {
  const p = String(path || '').trim();
  if (p === 'anon-chat' || p.startsWith('anon/')) return true;
  if ((p === 'chat/thread' || p === 'chat/details') && ['anon', 'streamer'].includes(String(params.from || '').trim())) return true;
  return false;
}

function isChatHubRoute(path) {
  const p = String(path || '').trim();
  return p === 'chat'
    || p === 'chat/contacts'
    || p === 'chat/wechat-contacts'
    || p === 'chat/wechat-discover'
    || p === 'chat/wechat-me'
    || p === 'chat/wechat-feature'
    || p === 'chat/moments'
    || p === 'moments/profile'
    || p === 'chat/backstage';
}

function installWechatEdgeBackGesture() {
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  // iOS Safari / 主屏 PWA 已有系统级边缘返回。再绑一套 touch 手势会让同一次滑动
  // 同时触发 JS back 与原生 popstate，表现成连退两页或历史重复；这里只给没有
  // 原生交互式返回的 WebView / Android 浏览器补手势。
  if (isIOSWebKitRuntime()) return;
  const primaryRoutes = new Set([
    'chat',
    'chat/wechat-contacts',
    'chat/wechat-discover',
    'chat/wechat-me',
  ]);
  const ignoredSelector = [
    'input',
    'textarea',
    'select',
    '[contenteditable="true"]',
    '[data-swipe-row]',
    '.image-lightbox',
    '.moments-images',
    '.chat-tools-sheet',
    '.modal-overlay',
    '[role="dialog"]',
  ].join(', ');
  let gesture = null;

  document.addEventListener('touchstart', (event) => {
    const touch = event.touches?.[0];
    const platform = String(document.documentElement.dataset.chatPlatform || '').trim();
    if (
      platform !== 'wechat'
      || primaryRoutes.has(String(_currentPage || '').trim())
      || !touch
      || event.touches.length !== 1
      || touch.clientX > 24
      || event.target?.closest?.(ignoredSelector)
    ) {
      gesture = null;
      return;
    }
    gesture = {
      route: _currentPage,
      x: touch.clientX,
      y: touch.clientY,
      latestX: touch.clientX,
      latestY: touch.clientY,
      horizontal: false,
    };
  }, { capture: true, passive: true });

  document.addEventListener('touchmove', (event) => {
    if (!gesture || !event.touches?.length) return;
    const touch = event.touches[0];
    gesture.latestX = touch.clientX;
    gesture.latestY = touch.clientY;
    const dx = touch.clientX - gesture.x;
    const dy = touch.clientY - gesture.y;
    if (!gesture.horizontal) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      if (dx <= 0 || Math.abs(dx) <= Math.abs(dy) * 1.2) {
        gesture = null;
        return;
      }
      gesture.horizontal = true;
      document.documentElement.classList.add('wechat-edge-back-active');
    }
    event.preventDefault();
  }, { capture: true, passive: false });

  const finish = () => {
    if (!gesture) return;
    const current = gesture;
    gesture = null;
    document.documentElement.classList.remove('wechat-edge-back-active');
    const dx = current.latestX - current.x;
    const dy = current.latestY - current.y;
    if (
      current.horizontal
      && dx >= 72
      && Math.abs(dx) > Math.abs(dy) * 1.25
      && current.route === _currentPage
    ) back();
  };
  document.addEventListener('touchend', finish, { capture: true, passive: true });
  document.addEventListener('touchcancel', () => {
    gesture = null;
    document.documentElement.classList.remove('wechat-edge-back-active');
  }, { capture: true, passive: true });
}

function applyRouteShellTheme(path, params = {}) {
  const container = _container();
  if (!container) return;
  const root = document.documentElement;
  const isHome = path === 'home';
  root.dataset.appShell = isHome ? 'home' : 'app';
  const nativeScheme = root.dataset.colorMode === 'dark' && !isHome ? 'dark' : 'light';
  root.style.colorScheme = nativeScheme;
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', nativeScheme);
  if (isAnonShellRoute(path, params)) {
    container.dataset.shell = 'anon';
  } else if (isChatHubRoute(path) && isChatHubInsChromeActiveSync()) {
    container.dataset.shell = 'chat-ins';
  } else {
    delete container.dataset.shell;
  }
}

function buildHash(path, params = {}) {
  let hash = '#' + path;
  const keys = params && typeof params === 'object' ? Object.keys(params) : [];
  if (keys.length) {
    const sp = new URLSearchParams();
    for (let i = 0; i < keys.length; i += 1) {
      const k = keys[i];
      const v = params[k];
      if (v != null && v !== '') sp.set(k, String(v));
    }
    const q = sp.toString();
    if (q) hash += '?' + q;
  }
  return hash;
}

function sameRoute(a, b) {
  if (!a || !b) return false;
  if (a.path !== b.path) return false;
  const pa = a.params && typeof a.params === 'object' ? a.params : {};
  const pb = b.params && typeof b.params === 'object' ? b.params : {};
  const keys = new Set([...Object.keys(pa), ...Object.keys(pb)]);
  for (const k of keys) {
    if (String(pa[k] != null ? pa[k] : '') !== String(pb[k] != null ? pb[k] : '')) return false;
  }
  return true;
}

function escErrMsg(s) {
  return String(s != null ? s : '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function perfNow() {
  try {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
      return performance.now();
    }
  } catch (_) {}
  return Date.now();
}

function markPendingNav(kind, path, params = {}) {
  _pendingNavMeta = {
    kind: String(kind || 'unknown'),
    path: String(path || '').trim(),
    fromPath: String(_currentPage || '').trim(),
    params: params && typeof params === 'object' ? { ...params } : {},
    startedAt: perfNow(),
    startedWallAt: Date.now(),
  };
}

function consumePendingNav(path) {
  if (!_pendingNavMeta) return null;
  if (String(_pendingNavMeta.path || '') !== String(path || '')) return null;
  const meta = _pendingNavMeta;
  _pendingNavMeta = null;
  return meta;
}

function renderRouteLoading(page) {
  if (!page || !page.isConnected) return;
  if (page.firstElementChild || String(page.textContent || '').trim()) return;
  const isAnonShell = _container()?.dataset?.shell === 'anon';
  page.classList.add('page--route-loading');
  if (isAnonShell) page.classList.add('page--route-loading-anon');
  page.innerHTML = isAnonShell
    ? `
    <div class="route-loading route-loading--anon" role="status" aria-live="polite">
      <div class="route-loading-dots" aria-hidden="true">
        <span></span><span></span><span></span>
      </div>
      <div class="route-loading-text">加载中…</div>
    </div>
  `
    : `
    <div class="route-loading" role="status" aria-live="polite">
      <div class="route-loading-paper" aria-hidden="true">
        <span></span><span></span><span></span>
      </div>
      <div class="route-loading-text">加载中…</div>
    </div>
  `;
}

export { parseHashRoute };

export function register(path, renderFn) {
  _routes[path] = renderFn;
}

function isEmbeddedFrame() {
  try {
    return typeof window !== 'undefined' && window.top !== window.self;
  } catch (_) {
    return true;
  }
}

export function navigate(path, params = {}, replace = false) {
  if (!checkLeaveGuard(path, params)) return;
  // 内嵌预览（美化工作室小窗）里的跳转一律 replace，
  // 否则 iframe 会往共享会话历史里塞条目，外层实体返回键要连按多次才退得动。
  if (!replace && isEmbeddedFrame()) replace = true;
  const next = { path, params };
  const current = _history[_history.length - 1]
    || (_currentPage ? { path: _currentPage, params: _currentParams } : null);
  // 双击入口、触摸 click 合成或异步回调重复到达时，同一路由不能再 push 一份。
  // 否则系统侧滑看似回去了，实际只是从“详情副本”退到“详情副本”。
  if (!replace && sameRoute(current, next)) return;

  _browserBackPending = false;
  const hash = buildHash(path, params);
  markPendingNav(replace ? 'replace' : 'push', path, params);
  if (replace) {
    window.history.replaceState({ path, params }, '', hash);
    if (_history.length) {
      _history[_history.length - 1] = { path, params };
    } else {
      _history.push({ path, params });
    }
  } else {
    window.history.pushState({ path, params }, '', hash);
    _history.push({ path, params });
  }
  _render(path, params);
}

/**
 * 关掉当前页及中间叠加页后回到目标路由。
 * 典型场景：聊天 → 设定 → 他的手机 → 关机回聊天。
 * 若只用 navigate(..., true) replace，设定页仍留在栈里，聊天页返回会先掉进设定。
 */
export function compactDismissibleRouteHistory(history = [], dismissPaths = [], matchChatId = '') {
  const next = Array.isArray(history) ? history.slice() : [];
  const paths = dismissPaths instanceof Set ? dismissPaths : new Set(dismissPaths);
  const wantedChatId = String(matchChatId || '').trim();
  if (next.length) next.pop();
  while (next.length) {
    const top = next[next.length - 1];
    const topPath = String(top?.path || '').trim();
    if (!paths.has(topPath)) break;
    if (wantedChatId) {
      const topChatId = String(top?.params?.chatId || '').trim();
      if (topChatId && topChatId !== wantedChatId) break;
    }
    next.pop();
  }
  return next;
}

export function navigateDismissing(path, params = {}, options = {}) {
  if (!checkLeaveGuard(path, params)) return;
  const dismissPaths = new Set(
    (Array.isArray(options.dismissPaths) ? options.dismissPaths : [])
      .map((p) => String(p || '').trim())
      .filter(Boolean),
  );
  // 某些跨会话流程（如“线下 → 掏出手机 → 任意聊天 → 返回现场”）
  // 本来就会经过不同 chatId；显式传 false 时按路由类型整体收束，不能被目标
  // 线下 chatId 卡住，否则每次往返都会在历史栈里再套一层 Chat。
  const matchChatId = options.matchChatId === false
    ? ''
    : String(options.matchChatId || params.chatId || '').trim();

  const previousHistory = _history.slice();
  const compactedHistory = compactDismissibleRouteHistory(previousHistory, dismissPaths, matchChatId);

  const top = compactedHistory[compactedHistory.length - 1];
  const topFrom = String(top?.params?.from || '').trim();
  const reuseTop = !!top
    && String(top.path || '') === String(path || '')
    && topFrom !== 'phone'
    && (!matchChatId || String(top.params?.chatId || '').trim() === matchChatId)
    && String(top.params?.viewer || '').trim() === String(params.viewer || '').trim();

  const finalPath = reuseTop ? top.path : path;
  const finalParams = reuseTop
    ? (top.params && typeof top.params === 'object' ? top.params : {})
    : params;

  // 目标本来就在历史里时，真实跨过中间页，而不是只把当前地址改成目标地址。
  // 后者会把被“关闭”的设定/手机/聊天页继续留在浏览器栈里，iOS 侧滑时又翻出来。
  const browserSteps = Math.max(0, previousHistory.length - compactedHistory.length);
  if (reuseTop && browserSteps > 0 && typeof window.history.go === 'function') {
    markPendingNav('back', finalPath, finalParams);
    _browserBackPending = true;
    window.history.go(-browserSteps);
    return;
  }

  _history = compactedHistory;
  _browserBackPending = false;
  markPendingNav('replace', finalPath, finalParams);
  window.history.replaceState(
    { path: finalPath, params: finalParams },
    '',
    buildHash(finalPath, finalParams),
  );
  if (!reuseTop) {
    _history.push({ path: finalPath, params: finalParams });
  }
  _render(finalPath, finalParams);
}

export function isTogetherReadingRootRoute(path, params = {}) {
  if (String(path || '').trim() !== 'together-reading') return false;
  const view = String(params?.view || 'library').trim();
  return !['book', 'reader', 'reviews', 'card'].includes(view);
}

function previousHomeHistoryIndex() {
  for (let i = _history.length - 2; i >= 0; i -= 1) {
    if (String(_history[i]?.path || '').trim() === 'home') return i;
  }
  return -1;
}

function backFromTogetherReadingRoot() {
  const homeIndex = previousHomeHistoryIndex();
  if (!checkLeaveGuard('home', {})) return;
  if (homeIndex >= 0 && typeof window.history.go === 'function') {
    markPendingNav('back', 'home', {});
    _browserBackPending = true;
    window.history.go(-(Math.max(1, _history.length - 1 - homeIndex)));
    return;
  }
  navigate('home', {}, true);
}

export function back() {
  if (isTogetherReadingRootRoute(_currentPage, _currentParams)) {
    if (_browserBackPending) return;
    backFromTogetherReadingRoot();
    return;
  }
  if (_history.length > 1) {
    if (_browserBackPending) return;
    const prev = _history[_history.length - 2];
    if (!checkLeaveGuard(prev.path, prev.params)) return;
    markPendingNav('back', prev.path, prev.params || {});
    _browserBackPending = true;
    window.history.back();
    return;
  }
  const curPath = String(_currentPage || '').trim();
  const curParams = _currentParams && typeof _currentParams === 'object' ? _currentParams : {};
  const curFrom = String(curParams.from || '').trim();
  if ((curPath === 'chat/thread' || curPath === 'chat/details') && curFrom === 'anon') {
    navigate('anon-chat', {}, true);
    return;
  }
  if ((curPath === 'chat/thread' || curPath === 'chat/details') && curFrom === 'streamer') {
    navigate('anon/streamer/space', curParams.streamerChannelId ? { channelId: curParams.streamerChannelId } : {}, true);
    return;
  }
  if (isAnonShellRoute(curPath, curParams) && curPath !== 'anon-chat') {
    navigate('anon-chat', {}, true);
    return;
  }
  navigate('home', {}, true);
}

/**
 * Android 原生返回手势的统一入口。
 *
 * 原生壳不能只看 WebView.canGoBack()：冷启动恢复到聊天/详情页时，浏览器历史里
 * 可能只有当前文档，但业务路由仍应像页面返回按钮一样先回首页。只有真正位于
 * 应用根页时才把返回交还 Android（退出或切到后台）。
 */
export function handleNativeBackRequest() {
  if (!_currentPage) return false;
  if (_browserBackPending) return true;
  if (String(_currentPage || '').trim() === 'home' && _history.length <= 1) return false;
  back();
  return true;
}

/**
 * 页面内部切换子状态（如角色手机里选人/开 app）时同步当前路由，不触发重渲染。
 * 这样从这里 navigate 出去再 back，能回到子状态而不是页面初始参数。
 */
export function syncCurrentRoute(path, params = {}) {
  if (!path || _currentPage !== path) return;
  window.history.replaceState({ path, params }, '', buildHash(path, params));
  if (_history.length) _history[_history.length - 1] = { path, params };
  else _history.push({ path, params });
  _currentParams = params;
}

export function currentRoute() {
  return _currentPage;
}

export function currentRouteParams() {
  return { ..._currentParams };
}

async function _render(path, params = {}, options = {}) {
  const renderSeq = ++_renderSeq;
  const navMeta = consumePendingNav(path);
  const renderStartedAt = perfNow();
  const container = _container();
  if (!container) return;
  prepareGlobalUiForRouteChange();
  const renderFn = _routes[path];
  if (!renderFn) {
    suspendActivePageToPool();
    container.innerHTML = '<div class="placeholder-page"><div class="placeholder-icon">🚧</div><div class="placeholder-text">页面不存在</div></div>';
    return;
  }

  const cacheKey = keepAliveCacheKey(path, params);
  const forceCold = options?.forceCold === true;
  const wantsResume = !!(!forceCold && cacheKey && _keepAlivePool.has(cacheKey));

  suspendActivePageToPool(wantsResume ? cacheKey : '');
  // 外观保存完成时若用户已经回到主屏，当前主屏刚刚才被挂入缓存；必须立即销毁
  // 这份旧 DOM 再冷绘制。只让显式 forceCold 走这里，避免普通返回丢失滚动与输入状态。
  if (forceCold && cacheKey) disposeKeepAliveEntry(cacheKey, 'forced-refresh');
  // 缓存失效事件可能在挂起期间同步触发。恢复前重新取一次；拿不到就按普通页面
  // 冷渲染，绝不能继续解引用旧判断留下的空项。
  const resumeEntry = wantsResume ? _keepAlivePool.get(cacheKey) : null;
  const isResume = !!resumeEntry;
  if (wantsResume && !isResume) {
    appendDebugEvent({
      type: 'route_resume_cache_miss',
      level: 'warn',
      message: `Route resume cache disappeared: ${path}`,
      context: { path, params, cacheKey },
    }).catch(() => {});
  }
  // iOS 只允许一个聊天 DOM 存活：从列表返回最近会话可秒开；进入另一个会话前，
  // 先销毁旧聊天，避免“当前聊天 + 后台多个聊天”重新把 WebKit 内存顶满。
  if (isIOSWebKitRuntime() && path === 'chat/thread') {
    trimMobileChatKeepAliveEntries(isResume ? cacheKey : '', isResume ? MOBILE_CHAT_KEEP_ALIVE_LIMIT : 0);
  }
  container.innerHTML = '';

  _currentPage = path;
  _currentParams = params && typeof params === 'object' ? { ...params } : {};
  applyRouteShellTheme(path, _currentParams);
  document.documentElement.classList.remove('chat-scroll-capture-mode');

  if (isResume) {
    const entry = resumeEntry;
    // 复挂后由 _activePageEl 持有，不再同时算作池内条目；离开时会重新放回。
    // 否则失效缓存会把当前正在显示的页面也当成后台缓存销毁。
    _keepAlivePool.delete(cacheKey);
    entry.lastUsed = Date.now();
    const page = entry.pageEl;
    page.hidden = false;
    page.classList.remove('page--suspended', 'page--route-loading', 'page--route-loading-anon');
    container.appendChild(page);
    // 全局主题与页面级自定义 CSS 要在恢复滚动之前重建，否则旧样式算出的 scrollHeight
    // 会把位置写错；该事件只负责同步副作用，不在这里等待异步数据刷新。
    window.dispatchEvent(new CustomEvent('marshmallow-route-resuming', {
      detail: {
        path,
        params: { ..._currentParams },
        resumed: true,
        container: page,
      },
    }));
    // 重新入树后浏览器把 scrollTop 全部清零了，绘制前同步写回挂起时的位置，
    // 否则聊天页会先闪一下顶部、再等异步逻辑把它拽回去（有时根本拽不回去）。
    restoreScrollPositions(entry.scrollPositions);
    entry.scrollPositions = null;
    _activePageEl = page;

    const durationMs = Math.round(perfNow() - renderStartedAt);
    if (durationMs >= 80) {
      appendDebugEvent({
        type: 'route_render_resumed',
        level: 'info',
        message: `Route resumed: ${path} (${durationMs}ms)`,
        context: {
          path,
          params: _currentParams,
          durationMs,
          navKind: navMeta?.kind || 'unknown',
          cacheKey,
        },
      }).catch(() => {});
    }

    if (renderSeq !== _renderSeq) return;
    dispatchRouteActivated(path, _currentParams, page, true);
    settleResumedPage(page, path, _currentParams);
    return;
  }

  const page = document.createElement('div');
  if (isAnonShellRoute(path, params)) {
    page.className = 'page anon-page';
    if (path === 'chat/thread') page.classList.add('chat-thread-page', 'chat-thread-page--anon');
    if (path === 'chat/details') page.classList.add('chat-details-page', 'chat-details-page--anon');
    if (path === 'anon-chat') page.classList.add('anon-hub-page');
    if (path === 'anon/space') page.classList.add('anon-space-page');
  } else {
    page.className = 'page';
    if (isChatHubRoute(path) && isChatHubInsChromeActiveSync()) {
      page.classList.add('chat-hub-page', 'chat-hub-page--ins');
    }
  }
  page.dataset.page = path;
  page.dataset.routeRenderState = 'pending';
  page.setAttribute('aria-busy', 'true');
  container.appendChild(page);
  _activePageEl = page;
  // 280ms 起跳太久：模块没预热时（比如刚开 App 就点进聊天）这段时间页面是纯白的，
  // 缩短到 120ms 让「加载中」占位更快接上，避免被当成卡死。
  let loadingTimer = window.setTimeout(() => {
    if (renderSeq !== _renderSeq) return;
    renderRouteLoading(page);
  }, 120);
  let renderFailed = false;

  try {
    await renderFn(page, params);
  } catch (e) {
    if (renderSeq !== _renderSeq) return;
    renderFailed = true;
    const errMsg = e && e.message != null ? String(e.message) : String(e || '');
    const errStack = e && e.stack ? String(e.stack) : '';
    console.error('Page render error:', path, e);
    if (typeof window !== 'undefined' && typeof window.__mmlog === 'function') {
      window.__mmlog('error', 'Page render error: ' + path + ' ' + (errStack || errMsg || e));
    }
    appendDebugEvent({
      type: 'page_render_error',
      level: 'error',
      message: `Page render error: ${path} — ${errMsg || 'unknown'}`,
      stack: errStack,
      context: { path, params: _currentParams },
    }).catch(() => {});
    // 动态 import 拿到旧缓存脚本（缺 export / JS 被回成 HTML）时交给 index.html
    // 的自愈器清缓存重载；命中时给用户看修复中而不是裸报错。
    const healing = typeof window !== 'undefined'
      && typeof window.__mmSelfHeal === 'function'
      && window.__mmSelfHeal(errMsg);
    if (healing) {
      page.innerHTML = '<div class="placeholder-page"><div class="placeholder-icon">🔄</div><div class="placeholder-text">正在更新页面…</div><div class="placeholder-sub">检测到旧版本缓存，正在自动刷新，请稍候</div></div>';
    } else {
      const msg = escErrMsg(errMsg || e);
      page.innerHTML = `<div class="placeholder-page"><div class="placeholder-icon">❌</div><div class="placeholder-text">页面加载失败</div><div class="placeholder-sub">${msg}</div><button type="button" class="btn btn-primary" data-route-retry>重新尝试</button></div>`;
      page.querySelector('[data-route-retry]')?.addEventListener('click', () => {
        if (renderSeq !== _renderSeq) return;
        void _render(path, { ..._currentParams }, { forceCold: true });
      }, { once: true });
    }
    if (cacheKey) _keepAlivePool.delete(cacheKey);
  } finally {
    if (loadingTimer) {
      window.clearTimeout(loadingTimer);
      loadingTimer = null;
    }
    page.removeAttribute('aria-busy');
    page.dataset.routeRenderState = renderSeq !== _renderSeq
      ? 'stale'
      : (renderFailed ? 'failed' : 'settled');
    if (renderSeq === _renderSeq) {
      page.classList.remove('page--route-loading', 'page--route-loading-anon');
    } else {
      // renderFn 没有统一的 AbortSignal，过期任务仍可能在第一次 disposed 事件后追加
      // DOM 或监听器；完成时再按同一 container 广播一次，确保迟到副作用也被释放。
      dispatchRouteDisposed({ pageEl: page, path, params }, 'stale-render-finished');
    }
    const moduleMs = _routeModuleTiming.get(path);
    _routeModuleTiming.delete(path);
    if (renderSeq === _renderSeq) {
      const durationMs = Math.round(perfNow() - renderStartedAt);
      const threshold = navMeta?.kind === 'back' || navMeta?.kind === 'popstate' ? 180 : 420;
      if (durationMs >= threshold) {
        appendDebugEvent({
          type: 'route_render_slow',
          level: 'warn',
          message: `Route render slow: ${path} (${durationMs}ms, module ${moduleMs != null ? moduleMs : '?'}ms)`,
          context: {
            path,
            params: _currentParams,
            durationMs,
            moduleMs: moduleMs != null ? moduleMs : -1,
            dataRenderMs: moduleMs != null ? Math.max(0, durationMs - moduleMs) : -1,
            navKind: navMeta?.kind || 'unknown',
            fromPath: navMeta?.fromPath || '',
            loadingShown: durationMs >= 120,
          },
        }).catch(() => {});
      }
    }
  }

  if (renderSeq !== _renderSeq) return;
  if (navMeta?.kind === 'back' || navMeta?.kind === 'popstate') {
    restoreColdRouteScroll(path, _currentParams, page);
  }
  dispatchRouteActivated(path, _currentParams, page, false);
}

export function init() {
  bindScrollTracker();
  installWechatEdgeBackGesture();
  window.addEventListener('marshmallow-app-foreground', () => {
    const page = _activePageEl;
    if (!page || !page.isConnected || page.hidden) return;
    // App 回前台不会经过 _render，也就不会命中普通 Keep-Alive resume 分支。
    // 复用同一恢复协议，让全局/会话 CSS、viewport、媒体和 WebView 合成层一起失效。
    window.dispatchEvent(new CustomEvent('marshmallow-route-resuming', {
      detail: {
        path: _currentPage,
        params: { ..._currentParams },
        resumed: true,
        foreground: true,
        container: page,
      },
    }));
    settleResumedPage(page, _currentPage, _currentParams);
  });
  window.addEventListener('marshmallow-appearance-changed', (event) => {
    invalidateAppearanceKeepAlive();
    if (event?.detail?.refreshActiveHome !== true || _currentPage !== 'home') return;
    if (_appearanceHomeRefreshScheduled) return;
    _appearanceHomeRefreshScheduled = true;
    queueMicrotask(() => {
      _appearanceHomeRefreshScheduled = false;
      if (_currentPage !== 'home') return;
      void _render('home', { ..._currentParams }, { forceCold: true });
    });
  });

  window.addEventListener('marshmallow-user-slot-changed', () => {
    const activePage = _activePageEl;
    const activePath = _currentPage;
    const activeParams = { ..._currentParams };
    invalidateAllKeepAlive();
    // 当前正在显示的页面不属于 Keep-Alive 池，只清池会继续展示旧档位 DOM。
    // 给触发切换的控件一次完成自身回调的机会；若期间没有导航，则强制冷绘制当前页。
    window.setTimeout(() => {
      if (!activePage || _activePageEl !== activePage || _currentPage !== activePath) return;
      void _render(activePath, activeParams, { forceCold: true });
    }, 0);
  });

  window.addEventListener('popstate', (e) => {
    const requestedBack = _browserBackPending;
    _browserBackPending = false;
    const state = e.state;
    let path;
    let params;
    if (state && state.path) {
      path = state.path;
      params = state.params || {};
    } else {
      const parsed = parseHashRoute(location.hash.slice(1));
      path = parsed.path;
      params = parsed.params || {};
    }
    // 一起读是从 Home 上的应用分组打开的独立应用。它的根页返回语义始终是
    // 回主屏，不能因打开分组前浏览过聊天/设置等页面而把那些旧页面翻出来。
    // Android 的页面侧滑会走 back()；iOS 原生侧滑直接触发 popstate，因此这里
    // 也要把已经开始的浏览器后退继续收束到最近一份 Home 历史。
    if (isTogetherReadingRootRoute(_currentPage, _currentParams) && path !== 'home') {
      const homeIndex = previousHomeHistoryIndex();
      const remainingSteps = homeIndex >= 0 ? Math.max(0, _history.length - 2 - homeIndex) : 0;
      if (!checkLeaveGuard('home', {})) {
        window.history.pushState(
          { path: _currentPage, params: _currentParams },
          '',
          buildHash(_currentPage, _currentParams),
        );
        return;
      }
      if (remainingSteps > 0 && typeof window.history.go === 'function') {
        markPendingNav('back', 'home', {});
        _browserBackPending = true;
        window.history.go(-remainingSteps);
        return;
      }
      path = 'home';
      params = {};
      window.history.replaceState({ path, params }, '', buildHash(path, params));
    }
    const next = { path, params };
    if (!checkLeaveGuard(path, params)) {
      // 浏览器已经把地址栏切走了，钩子拒绝时把地址栏还原回当前页，避免"URL 变了但页面没变"。
      window.history.pushState(
        { path: _currentPage, params: _currentParams },
        '',
        buildHash(_currentPage, _currentParams),
      );
      return;
    }
    if (!requestedBack) markPendingNav('popstate', path, params);
    // 从栈顶向前找最近一份，而不是命中最早的同路由。来回打开同一详情页时，
    // findIndex 会一次切掉过多记录，让侧滑像随机跳页。
    let idx = -1;
    for (let i = _history.length - 2; i >= 0; i -= 1) {
      if (sameRoute(_history[i], next)) {
        idx = i;
        break;
      }
    }
    if (idx >= 0) {
      _history = _history.slice(0, idx + 1);
    } else if (_history.length) {
      _history[_history.length - 1] = next;
    } else {
      _history.push(next);
    }
    _render(path, params);
  });

  // Service Worker / 外部深链有时只改 hash、不走 pushState，补一层 hashchange 同步路由。
  window.addEventListener('hashchange', () => {
    const parsed = parseHashRoute(location.hash.slice(1) || 'home');
    const next = { path: parsed.path, params: parsed.params || {} };
    if (sameRoute({ path: _currentPage, params: _currentParams }, next)) return;
    if (!checkLeaveGuard(next.path, next.params)) {
      window.history.replaceState(
        { path: _currentPage, params: _currentParams },
        '',
        buildHash(_currentPage, _currentParams),
      );
      return;
    }
    markPendingNav('hashchange', next.path, next.params);
    if (_history.length) _history[_history.length - 1] = next;
    else _history.push(next);
    window.history.replaceState({ path: next.path, params: next.params }, '', buildHash(next.path, next.params));
    _render(next.path, next.params);
  });

  if (typeof navigator !== 'undefined' && navigator.serviceWorker?.addEventListener) {
    navigator.serviceWorker.addEventListener('message', (event) => {
      const data = event?.data || {};
      if (data.type === 'relay-push') {
        // 云端中继 Web Push：趁页面还活着立刻对账落库；点通知再走 open-chat。
        import('./cloud-background-coordinator.js')
          .then((mod) => mod.reconcileCloudBackgroundEvents?.('relay-push'))
          .catch(() => {});
        return;
      }
      if (data.type !== 'open-chat') return;
      const chatId = String(data.chatId || '').trim();
      if (!chatId) return;
      const entry = String(data.entry || 'notify').trim() || 'notify';
      navigate('chat/thread', { chatId, entry }, true);
      import('./cloud-background-coordinator.js')
        .then((mod) => mod.reconcileCloudBackgroundEvents?.('notify-open'))
        .catch(() => {});
    });
  }

  const parsed = parseHashRoute(location.hash.slice(1) || 'home');
  const state = window.history.state;
  const path = (state && state.path) || parsed.path;
  const params = (state && state.params) || parsed.params || {};
  _history = [{ path, params }];
  window.history.replaceState({ path, params }, '', buildHash(path, params));
  // MainActivity 的全面屏侧滑 / 系统返回从这里进入，与页面返回按钮共用 back()。
  // 返回 false 只表示已经位于应用根页，可由 Android 执行系统级返回。
  window.__marshmallowHandleNativeBack = handleNativeBackRequest;
  _render(path, params);
}
