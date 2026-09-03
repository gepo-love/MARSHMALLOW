import { register, init as routerInit, navigate, reportRouteModuleTiming } from './core/router.js';
import {
  bindRoutePrefetch,
  getOrCreateRetryablePageModule,
} from './core/route-prefetch.js';
import { open as dbOpen, trySalvageDumpStores } from './core/db.js';
import { ensureDefaultUser } from './core/user-slot.js';
import { applyAppearanceThemeFromPrefs, compactOversizedAppearanceImages } from './core/appearance-prefs.js';
import { initializeBeautifySafeMode } from './core/beautify-studio-store.js';
import { compactOversizedContactAvatars } from './core/avatar-compaction.js';
import { installGlobalDebugHandlers, appendDebugEvent } from './core/debug-log.js';
import { showToast } from './components/toast.js';
import { SHELL_ROUTE_IDS } from './data/shell-pages.js';
import { initializeMemoryRegionIndicator } from './core/memory/memory-region-indicator.js';
import { initializeAutoExpandTranslations } from './core/auto-expand-translations.js';
import { rebuildIndexedDbCacheIfNeeded } from './core/native-data-store.js';
import { initializeAppLock } from './components/app-lock-screen.js';
import { installReplyIntentOutboxRecovery } from './core/chat/reply-intent-outbox.js';
import {
  acknowledgeBackupImportNotice,
  acknowledgeBackupImportSkippedNotice,
  getBackupImportSkippedNotice,
  markBackupImportInterruptedOnBoot,
} from './core/backup-import-session.js';

const interruptedBackupImport = markBackupImportInterruptedOnBoot();
const skippedBackupImportNotice = getBackupImportSkippedNotice();

function showBackupImportFailureNotice(session) {
  if (!session || !['interrupted', 'failed'].includes(session.status)) return;
  const host = document.getElementById('modal-container');
  if (!host || host.classList.contains('active')) return;
  const esc = (value) => String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  const completed = Array.isArray(session.completedStores) ? session.completedStores.length : 0;
  const fileName = session.file?.name || '上次选择的搬家包';
  const phase = session.storeName || session.phase || '未知阶段';
  const error = session.error || '导入页面或渲染进程在任务完成前中断';
  const totalBytes = Number(session.totalBytes || session.file?.size || 0);
  const bytesRead = Number(session.bytesRead || 0);
  const progress = totalBytes > 0 ? Math.min(99, Math.round((bytesRead / totalBytes) * 100)) : 0;
  const hasNativeCheckpoint = Number(session.generation || 0) > 0;
  const stoppedInBeautifyAssets = String(phase).includes('beautifyAssets');
  const recoveryMessage = stoppedInBeautifyAssets
    ? '重新选择同一个文件后，会优先恢复聊天、角色与记忆；主数据完成后可在备份页分批继续补导美化资源。'
    : hasNativeCheckpoint
      ? '原数据仍然保留。重新选择同一个文件时，会先核对原生暂存现场；能安全续用才继续，否则会明确从头导入。'
      : '搬家包尚未完整恢复，已完成的数据表可能已经写入。请先不要新增重要内容；重新选择同一个文件后会从头导入并恢复成完整备份。';
  const stoppedAt = new Date(Number(session.updatedAt || session.interruptedAt || 0));
  const stoppedAtLabel = Number.isFinite(stoppedAt.getTime()) ? stoppedAt.toLocaleString() : '未记录';
  host.innerHTML = `
    <div class="modal-overlay" data-import-failure-overlay style="z-index:99999;">
      <div class="modal-sheet scrapbook-card" role="alertdialog" aria-modal="true" aria-labelledby="import-failure-title" style="max-width:420px;" data-import-failure-sheet>
        <div class="modal-header"><h3 id="import-failure-title">上次搬家导入未完成</h3></div>
        <div class="modal-body" style="font-size:14px;line-height:1.65;color:var(--text-secondary);">
          <p>${esc(recoveryMessage)}</p>
          <p style="font-size:12px;margin-top:10px;word-break:break-all;">文件：${esc(fileName)}<br>失败时间：${esc(stoppedAtLabel)}<br>停止位置：${esc(phase)}${progress ? ` · 文件 ${progress}%` : ''}${completed ? `<br>已完成数据表：${completed} 个` : ''}<br>原因：${esc(error)}</p>
        </div>
        <div class="modal-body" style="display:flex;flex-direction:column;gap:8px;padding-top:0;">
          <button type="button" class="btn btn-primary btn-block" data-import-failure-settings>到设置重新选择文件</button>
          <button type="button" class="btn btn-sm btn-soft" data-import-failure-close>知道了</button>
        </div>
      </div>
    </div>`;
  host.classList.add('active');
  const close = () => {
    acknowledgeBackupImportNotice();
    host.classList.remove('active');
    host.innerHTML = '';
  };
  host.querySelector('[data-import-failure-sheet]')?.addEventListener('click', (event) => event.stopPropagation());
  host.querySelector('[data-import-failure-close]')?.addEventListener('click', close);
  host.querySelector('[data-import-failure-settings]')?.addEventListener('click', () => {
    close();
    navigate('settings/backup');
  });
}

function installBackupImportFailureUi() {
  globalThis.addEventListener('marshmallow-backup-import-failed', (event) => {
    showBackupImportFailureNotice(event.detail);
  });
}

function showBackupImportSkippedNotice(notice) {
  if (!notice?.skipped?.length) return;
  const host = document.getElementById('modal-container');
  if (!host || host.classList.contains('active')) return;
  const esc = (value) => String(value || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const labels = { soundAssets: '音频库音效', musicAssets: '本地音乐', nativeCache: '本地媒体缓存', rows: '设置资源', characterAssets: '角色资源', userAssets: '用户资源', chatAssets: '聊天资源', beautifyAssets: '美化资源' };
  const rows = notice.skipped.slice(0, 30).map((item) => (
    `<li><strong>${esc(labels[item.assetName] || item.assetName)}</strong> · ${esc(item.id)}<br><small>${esc(item.reason)}</small></li>`
  )).join('');
  const more = notice.skipped.length > 30 ? `<p>另有 ${notice.skipped.length - 30} 项未展开。</p>` : '';
  host.innerHTML = `
    <div class="modal-overlay" style="z-index:99999;">
      <div class="modal-sheet scrapbook-card" role="alertdialog" aria-modal="true" aria-labelledby="import-skipped-title" style="max-width:420px;" data-import-skipped-sheet>
        <div class="modal-header"><h3 id="import-skipped-title">搬家完成，有 ${notice.skipped.length} 项未恢复</h3></div>
        <div class="modal-body" style="font-size:14px;line-height:1.6;color:var(--text-secondary);max-height:55vh;overflow:auto;">
          <p>主数据已经完成导入。以下损坏或无法匹配的可选资源已跳过，不影响其余聊天、角色和设置。</p>
          <ul style="padding-left:20px;word-break:break-all;">${rows}</ul>${more}
        </div>
        <div class="modal-body" style="padding-top:0;"><button type="button" class="btn btn-primary btn-block" data-import-skipped-close>知道了</button></div>
      </div>
    </div>`;
  host.classList.add('active');
  host.querySelector('[data-import-skipped-sheet]')?.addEventListener('click', (event) => event.stopPropagation());
  host.querySelector('[data-import-skipped-close]')?.addEventListener('click', () => {
    acknowledgeBackupImportSkippedNotice();
    host.classList.remove('active');
    host.innerHTML = '';
  });
}

const CORE_ROUTES = [
  'home',
  'settings',
  'settings/backup',
  'settings/api',
  'settings/debug-log',
  'settings/data-hygiene',
  'generation-error',
  'support',
  'settings/appearance',
  'settings/lock-screen',
  'beautify',
  'identity/appearance',
  'tutorial',
  'contacts',
  'contacts/card',
  'contacts/edit',
  'contacts/import',
  'contacts/export',
  'relationship/network',
  'user-space',
  'user-space/edit',
  'chat',
  'chat/contacts',
  'chat/wechat-contacts',
  'chat/wechat-discover',
  'chat/wechat-me',
  'chat/wechat-feature',
  'chat/moments',
  'chat/backstage',
  'chat/intercepts',
  'chat/pick',
  'chat/thread',
  'chat/details',
  'chat/aliases',
  'offline',
  'offline/archive',
  'encounter',
  'encounter/first',
  'encounter/date',
  'encounter/audio',
  'encounter/date-log',
  'encounter/trip',
  'encounter/time-machine',
  'encounter/au-theater',
  'his-space',
  'narration-archive',
  'character-phone',
  'mailbox',
  'travel-char',
  'travel-char/event',
  'display-regex',
  'display-regex/edit',
  'extensions',
  'mcp',
  'calendar',
  'anon-chat',
  'anon/match',
  'anon/match/group',
  'anon/room/create',
  'anon/wall',
  'anon/confession',
  'anon/space',
  'anon/streamer',
  'anon/streamer/create',
  'anon/streamer/room',
  'anon/streamer/match',
  'anon/streamer/space',
  'anon/streamer/persona-edit',
  'moments/profile',
  'memory',
  'memory/hall',
  'memory/region',
  'memory/travel-album',
  'worldbook',
  'mini-wiki',
  'presets',
  'au',
  'stickers',
  'music',
  'radio',
  'sound-library',
  'together-reading',
  'weibo',
  'weibo-detail',
  'weibo-interactions',
  'weibo-hot-rank',
  'weibo-profile',
  'weibo-relations',
  'weibo-dm',
  'weibo-messages',
  'weibo-search',
  'weibo-topic',
  'forum',
  'forum-detail',
  'forum-vest-home',
  'forum-actor-profile',
  'forum-inbox',
];

const PAGE_LOADERS = {
  home: () => import('./pages/home.js'),
  settings: () => import('./pages/settings-hub-entry.js'),
  'settings/backup': () => import('./pages/backup-migration.js'),
  'settings/api': () => import('./pages/api-manager-entry.js'),
  'settings/debug-log': () => import('./pages/settings-debug-log.js'),
  'settings/data-hygiene': () => import('./pages/settings-data-hygiene-entry.js'),
  'generation-error': () => import('./pages/generation-error-detail.js'),
  support: () => import('./pages/support-assistant.js'),
  'settings/appearance': () => import('./pages/settings-appearance.js'),
  'settings/lock-screen': () => import('./pages/settings-lock-screen.js'),
  beautify: () => import('./pages/beautify-studio.js'),
  'identity/appearance': () => import('./pages/identity-appearance.js'),
  tutorial: () => import('./pages/tutorial.js'),
  contacts: () => import('./pages/contacts.js'),
  'contacts/card': () => import('./pages/contacts-card.js'),
  'contacts/edit': () => import('./pages/contacts-edit.js'),
  'contacts/import': () => import('./pages/contacts-import.js'),
  'contacts/export': () => import('./pages/contacts-export.js'),
  'relationship/network': () => import('./pages/relationship-network.js'),
  'user-space': () => import('./pages/user-space.js'),
  'user-space/edit': () => import('./pages/user-space-edit.js'),
  chat: () => import('./pages/chat-hub.js'),
  'chat/contacts': () => import('./pages/chat-contacts.js'),
  'chat/wechat-contacts': () => import('./pages/chat-wechat-contacts.js'),
  'chat/wechat-discover': () => import('./pages/chat-wechat-discover.js'),
  'chat/wechat-me': () => import('./pages/chat-wechat-me.js'),
  'chat/wechat-feature': () => import('./pages/chat-wechat-feature.js'),
  'chat/moments': () => import('./pages/chat-moments.js'),
  'chat/backstage': () => import('./pages/chat-backstage.js'),
  'chat/intercepts': () => import('./pages/chat-intercepts.js'),
  'chat/pick': () => import('./pages/chat-pick.js'),
  'chat/thread': () => import('./pages/chat-thread.js'),
  'chat/details': () => import('./pages/chat-details.js'),
  'chat/aliases': () => import('./pages/chat-aliases.js'),
  offline: () => import('./pages/offline-session.js'),
  'offline/archive': () => import('./pages/offline-date-archive.js'),
  encounter: () => import('./pages/encounter.js'),
  'encounter/first': () => import('./pages/encounter-first.js'),
  'encounter/date': () => import('./pages/offline-date.js'),
  'encounter/audio': () => import('./pages/offline-audio-date.js'),
  'encounter/date-log': () => import('./pages/offline-date-log.js'),
  'encounter/trip': () => import('./pages/together-trip.js'),
  'encounter/time-machine': () => import('./pages/time-machine.js'),
  'encounter/au-theater': () => import('./pages/au-theater.js'),
  'his-space': () => import('./pages/his-space.js'),
  'narration-archive': () => import('./pages/narration-archive.js'),
  'character-phone': () => import('./pages/character-phone.js'),
  mailbox: () => import('./pages/mailbox.js'),
  'travel-char': () => import('./pages/travel-char.js'),
  'travel-char/event': () => import('./pages/travel-char-event.js'),
  'display-regex': () => import('./pages/display-regex.js'),
  'display-regex/edit': () => import('./pages/display-regex-edit.js'),
  extensions: () => import('./pages/extensions.js'),
  mcp: () => import('./pages/mcp.js'),
  calendar: () => import('./pages/calendar.js'),
  'anon-chat': () => import('./pages/anon-chat.js'),
  'anon/match': () => import('./pages/anon-match.js'),
  'anon/match/group': () => import('./pages/anon-match-group.js'),
  'anon/room/create': () => import('./pages/anon-room-create.js'),
  'anon/wall': () => import('./pages/anon-wall.js'),
  'anon/confession': () => import('./pages/anon-confession-lobby.js'),
  'anon/space': () => import('./pages/anon-space.js'),
  'anon/streamer': () => import('./pages/streamer-hub.js'),
  'anon/streamer/create': () => import('./pages/streamer-create.js'),
  'anon/streamer/room': () => import('./pages/streamer-room.js'),
  'anon/streamer/match': () => import('./pages/streamer-match.js'),
  'anon/streamer/space': () => import('./pages/streamer-space.js'),
  'anon/streamer/persona-edit': () => import('./pages/streamer-persona-edit.js'),
  'moments/profile': () => import('./pages/moments-profile.js'),
  memory: () => import('./pages/memory.js'),
  'memory/hall': () => import('./pages/memory-hall.js'),
  'memory/region': () => import('./pages/memory-region.js'),
  'memory/travel-album': () => import('./pages/memory-travel-album.js'),
  worldbook: () => import('./pages/worldbook.js'),
  'mini-wiki': () => import('./pages/mini-wiki.js'),
  presets: () => import('./pages/presets.js'),
  au: () => import('./pages/au-panel.js'),
  stickers: () => import('./pages/stickers.js'),
  music: () => import('./pages/music.js'),
  radio: () => import('./pages/radio.js'),
  'sound-library': () => import('./pages/sound-library.js'),
  'together-reading': () => import('./pages/together-reading.js'),
  weibo: () => import('./pages/weibo.js'),
  'weibo-detail': () => import('./pages/weibo-detail.js'),
  'weibo-interactions': () => import('./pages/weibo-interactions.js'),
  'weibo-hot-rank': () => import('./pages/weibo-hot-rank.js'),
  'weibo-profile': () => import('./pages/weibo-profile.js'),
  'weibo-relations': () => import('./pages/weibo-relations.js'),
  'weibo-dm': () => import('./pages/weibo-dm.js'),
  'weibo-messages': () => import('./pages/weibo-messages.js'),
  'weibo-search': () => import('./pages/weibo-search.js'),
  'weibo-topic': () => import('./pages/weibo-topic.js'),
  forum: () => import('./pages/forum.js'),
  'forum-detail': () => import('./pages/forum-detail.js'),
  'forum-vest-home': () => import('./pages/forum-vest-home.js'),
  'forum-actor-profile': () => import('./pages/forum-actor-profile.js'),
  'forum-inbox': () => import('./pages/forum-inbox.js'),
};

const pageModuleCache = new Map();
const MOBILE_RECENT_ROUTES_KEY = '__mm_mobile_recent_routes__';
const MOBILE_WARM_ROUTE_LIMIT = 4;

async function loadPage(path) {
  const loader = PAGE_LOADERS[path];
  if (loader) {
    return getOrCreateRetryablePageModule(
      pageModuleCache,
      path,
      () => loader().then((mod) => mod.default),
    );
  }
  if (SHELL_ROUTE_IDS.includes(path)) {
    const cacheKey = `shell:${path}`;
    return getOrCreateRetryablePageModule(
      pageModuleCache,
      cacheKey,
      () => import('./pages/shell-page.js')
        .then((mod) => (container, params) => mod.default(container, path)),
    );
  }
  return null;
}

function warmCommonRoutes() {
  // 只预热高频入口。SW 已负责网络缓存；把全部页面 import 一遍会让浏览器继续解析、
  // 编译并常驻整站模块，低内存电脑也会在启动后几秒与首轮点击争抢主线程。
  const priority = ['home', 'settings/api', 'chat', 'chat/thread', 'chat/details', 'settings', 'contacts', 'presets', 'travel-char', 'anon-chat', 'weibo', 'forum', 'memory', 'chat/contacts', 'chat/wechat-contacts', 'chat/wechat-discover', 'chat/wechat-me', 'chat/moments'];
  const shellSample = SHELL_ROUTE_IDS.length ? [SHELL_ROUTE_IDS[0]] : [];
  const routes = [...priority, ...shellSample];
  let idx = 0;
  const warmNext = () => {
    // 用户刚点了图标或正在操作时先让路；否则 iOS 会把页面 import 与点击后的
    // 路由 import 挤在同一段主线程，反而放大“点了以后一直加载”的观感。
    const activity = globalThis.__mm_update_safety_state__;
    const recentlyActive = activity
      && Date.now() - Number(activity.lastInteractionAt || 0) < 1200;
    if (document.hidden || recentlyActive) {
      setTimeout(warmNext, 500);
      return;
    }
    const path = routes[idx];
    idx += 1;
    if (!path) return;
    // 串行等待本次 import 完成；否则慢磁盘/首次编译超过 80ms 时会叠起多份解析任务。
    const warmJob = path === 'settings/api'
      ? Promise.all([
        loadPage(path),
        import('./pages/api-manager.js'),
      ])
      : loadPage(path);
    warmJob
      .catch(() => {})
      .finally(() => setTimeout(warmNext, 80));
  };
  warmNext();
}

function isWarmablePagePath(path) {
  return !!PAGE_LOADERS[path] || SHELL_ROUTE_IDS.includes(path);
}

function readRecentMobileRoutes() {
  try {
    const parsed = JSON.parse(localStorage.getItem(MOBILE_RECENT_ROUTES_KEY) || '[]');
    return Array.isArray(parsed)
      ? parsed.map((path) => String(path || '').trim()).filter((path) => isWarmablePagePath(path) && path !== 'home')
      : [];
  } catch (_) {
    return [];
  }
}

function rememberMobileRoute(path) {
  if (!isConstrainedMobileRuntime()) return;
  const route = String(path || '').trim();
  if (!isWarmablePagePath(route) || route === 'home') return;
  const next = [route, ...readRecentMobileRoutes().filter((item) => item !== route)]
    .slice(0, MOBILE_WARM_ROUTE_LIMIT);
  try {
    localStorage.setItem(MOBILE_RECENT_ROUTES_KEY, JSON.stringify(next));
  } catch (_) {}
}

function warmRecentMobileRoutes() {
  // 杀后台会清空 JS 编译缓存，但 Cache Storage 里的模块仍在。只恢复最近使用的少量
  // 页面，并把聊天作为兜底；不再像旧实现那样一次解析 9～82 个页面常驻 JS 堆。
  const routes = [
    ...readRecentMobileRoutes(),
    'chat',
    'chat/thread',
    'chat/details',
    'settings',
  ].filter((path, index, list) => isWarmablePagePath(path) && list.indexOf(path) === index)
    .slice(0, MOBILE_WARM_ROUTE_LIMIT);
  const isIos = /iPhone|iPad|iPod/i.test(String(navigator.userAgent || ''))
    || (/Mac/i.test(String(navigator.platform || '')) && Number(navigator.maxTouchPoints || 0) > 1);
  let idx = 0;

  const warmNext = () => {
    const path = routes[idx];
    if (!path) return;
    const activity = globalThis.__mm_update_safety_state__;
    const recentlyActive = activity
      && Date.now() - Number(activity.lastInteractionAt || 0) < 2500;
    const busy = Number(activity?.criticalCount || 0) > 0
      || !!document.querySelector('[aria-busy="true"], .is-loading, .generation-activity.is-running');
    if (document.hidden || recentlyActive || busy) {
      window.setTimeout(warmNext, 1500);
      return;
    }
    const run = () => {
      idx += 1;
      loadPage(path)
        .catch(() => {})
        .finally(() => window.setTimeout(warmNext, isIos ? 2800 : 1600));
    };
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(run, { timeout: 4000 });
    } else {
      run();
    }
  };
  warmNext();
}

function isConstrainedMobileRuntime() {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  if (window.Capacitor?.isNativePlatform?.() || window.Capacitor?.getPlatform?.() === 'android') {
    return true;
  }
  const ua = String(navigator.userAgent || '');
  const platform = String(navigator.platform || '');
  const touchPoints = Number(navigator.maxTouchPoints || 0);
  return /Android|iPhone|iPad|iPod/i.test(ua)
    || (/Mac/i.test(platform) && touchPoints > 1);
}

function scheduleStableIdleTask(task, {
  mobileDelayMs = 60_000,
  desktopDelayMs = 0,
  activeWindowMs = 12_000,
} = {}) {
  if (typeof window === 'undefined' || typeof task !== 'function') return;
  const mobile = isConstrainedMobileRuntime();
  let finished = false;
  const isBlocked = () => {
    const activity = globalThis.__mm_update_safety_state__;
    const recentlyActive = activity
      && Date.now() - Number(activity.lastInteractionAt || 0) < activeWindowMs;
    const busy = Number(activity?.criticalCount || 0) > 0
      || !!document.querySelector(
        '[aria-busy="true"], .is-loading, .app-busy-overlay.is-visible, .generation-activity.is-running',
      );
    return document.hidden || recentlyActive || busy;
  };
  const invoke = () => {
    if (finished) return;
    // requestIdleCallback 的 timeout 可能在用户重新开始操作后强制触发；执行前再查一次，
    // 否则延后的模块解析仍可能恰好撞上下一轮点按。
    if (isBlocked()) {
      window.setTimeout(run, 5000);
      return;
    }
    finished = true;
    // 可选启动任务不能制造全局 unhandledrejection；各模块自己的失败提示/日志仍照常执行。
    Promise.resolve().then(() => task()).catch(() => {});
  };
  const run = () => {
    if (finished) return;
    if (isBlocked()) {
      window.setTimeout(run, 5000);
      return;
    }
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(invoke, { timeout: mobile ? 8000 : 2500 });
    } else {
      invoke();
    }
  };
  window.setTimeout(run, mobile ? mobileDelayMs : desktopDelayMs);
}

function scheduleRouteWarmup() {
  if (typeof window === 'undefined') return;
  // 新域名 / 新装设备没有完整构建快照时，后台 import 会与用户真正点开的
  // 页面争抢网络、JS 解析和 Cache Storage。只有完整 sw.js 已经接管后才做
  // 路由预热；首次访问交给入口 pointerdown 精确预取，不扫全站。
  const controller = navigator.serviceWorker && navigator.serviceWorker.controller;
  const controllerUrl = String((controller && controller.scriptURL) || '');
  if (!/\/sw\.js(?:[?#]|$)/i.test(controllerUrl)) return;
  if (isConstrainedMobileRuntime()) {
    // 首屏与壁纸先稳定，再按用户最近使用顺序串行恢复至多四个模块。用户一操作即暂停。
    window.setTimeout(warmRecentMobileRoutes, 1800);
    return;
  }
  const run = () => warmCommonRoutes();
  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(run, { timeout: 400 });
  } else {
    setTimeout(run, 300);
  }
}

function escAttr(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;');
}

function installCompanionDockFallback(reason = '') {
  if (typeof document === 'undefined') return;
  const status = (typeof window !== 'undefined' && window.__COMPANION_DOCK_STATUS__) || {};
  const shouldShow = status.settingsVisible === true || Number(status.activeCount || 0) > 0;
  if (!shouldShow) return;
  if (document.getElementById('companion-dock')) return;
  if (document.getElementById('companion-dock-fallback')) return;
  const el = document.createElement('button');
  el.type = 'button';
  el.id = 'companion-dock-fallback';
  el.className = 'companion-dock-fallback';
  el.setAttribute('aria-label', '陪伴');
  el.setAttribute('data-reason', String(reason || '').slice(0, 120));
  el.innerHTML = '<span>陪</span>';
  el.addEventListener('click', () => {
    try {
      window.location.hash = '#companion';
    } catch (_) {}
  });
  document.body.appendChild(el);
  if (typeof window !== 'undefined') {
    window.__COMPANION_DOCK_STATUS__ = {
      ...(window.__COMPANION_DOCK_STATUS__ || {}),
      phase: 'fallback_installed',
      visible: true,
      reason: String(reason || ''),
      updatedAt: Date.now(),
    };
  }
  appendDebugEvent({
    type: 'companion_dock_fallback_installed',
    level: 'warn',
    message: escAttr(reason || 'dock missing after boot'),
  }).catch(() => {});
}

function verifyCompanionDockMounted() {
  if (typeof window === 'undefined') return;
  setTimeout(() => {
    const dock = document.getElementById('companion-dock');
    const status = window.__COMPANION_DOCK_STATUS__ || {};
    if (!dock) {
      if (status.settingsVisible === true || Number(status.activeCount || 0) > 0) {
        installCompanionDockFallback(status.error || status.phase || 'dock missing after boot');
      }
      return;
    }
    if (dock.classList.contains('is-hidden') && (status.error || status.phase === 'mount_error')) {
      installCompanionDockFallback(status.error || 'dock init failed after boot');
      return;
    }
    if (dock.classList.contains('is-hidden') && status.settingsVisible === true) {
      installCompanionDockFallback(status.error || status.phase || 'dock hidden after boot');
    }
  }, 1800);
}

function registerRoutes() {
  // PAGE_LOADERS 才是页面模块的完整来源。与手写的核心路由合并注册，避免新增页面时
  // 只添加 loader、忘记同步 CORE_ROUTES，最终点击后落进“页面不存在”。
  const paths = [...new Set([...CORE_ROUTES, ...Object.keys(PAGE_LOADERS), ...SHELL_ROUTE_IDS])];
  for (const path of paths) {
    register(path, async (container, params) => {
      const moduleStartedAt = performance.now();
      const renderFn = await loadPage(path);
      reportRouteModuleTiming(path, performance.now() - moduleStartedAt);
      if (!renderFn) {
        container.innerHTML = '<div class="placeholder-page"><div class="placeholder-text">页面不存在</div></div>';
        return;
      }
      await renderFn(container, params);
    });
  }
}

function clearBootLoading() {
  const loading = document.getElementById('boot-loading');
  if (loading && loading.parentNode) {
    loading.parentNode.removeChild(loading);
  }
}

function isEmbeddedBeautifyPreview() {
  try {
    return window.top !== window.self
      && /(?:^|[?&])beautifyPreview=1(?:&|$)/.test(String(window.location?.search || ''));
  } catch (_) {
    return false;
  }
}

function markAppReady() {
  if (typeof window === 'undefined') return;
  window.__MARSHMALLOW_BOOT_OK = true;
  try {
    navigator.serviceWorker?.controller?.postMessage({
      type: 'CONFIRM_BUILD_BOOT',
      build: String(globalThis.__MARSHMALLOW_BUILD__ || ''),
    });
  } catch (_) {}
  try {
    window.dispatchEvent(new CustomEvent('marshmallow-app-ready'));
  } catch (_) {}
}

function isServiceWorkerRepairCooldown() {
  try {
    const until = Number(globalThis.localStorage?.getItem('__mm_sw_repair_until__') || 0);
    return until > Date.now();
  } catch (_) {
    return false;
  }
}

function installIdbRecoveryUi() {
  globalThis.addEventListener('marshmallow-idb-delete-blocked', () => {
    showToast('其它页面仍占用本地库，请关闭本站其它标签页或主屏 App', 9000);
  });
  globalThis.addEventListener('marshmallow-idb-needs-recovery', (ev) => {
    const detail = ev.detail || {};
    const resolve = typeof detail.resolve === 'function' ? detail.resolve : () => {};
    const err = detail.error;
    const msg = String(err?.message || err || '未知错误');
    const repairCooldown = isServiceWorkerRepairCooldown();
    const host = document.getElementById('modal-container');
    if (!host) {
      if (globalThis.confirm(`本地存储无法读取：${msg}\n\n将尝试重新加载页面。点「取消」则仅关闭提示。`)) {
        globalThis.location.reload();
      }
      resolve('abort');
      return;
    }
    const esc = (s) => String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/"/g, '&quot;');
    const resetButtonHtml = repairCooldown
      ? ''
      : '<button type="button" class="btn btn-outline btn-block" style="border-color:var(--danger);color:var(--danger);" data-idb-reset>清空本地库并重建</button>';
    const guideHtml = repairCooldown
      ? '<p style="margin-top:12px;">刚做过一键修复时，本地库偶发打不开。请先<strong>重新加载</strong>或<strong>尝试导出</strong>；兼容启动期内不提供清空重建，以免误删。</p>'
      : '<p style="margin-top:12px;">建议：先<strong>重新加载</strong> → 仍失败再<strong>尝试导出</strong> → 最后再<strong>清空并重建</strong>（重建会删除全部本地数据，请慎点）。</p>';
    host.innerHTML = `
      <div class="modal-overlay" data-idb-overlay style="z-index:99999;">
        <div class="modal-sheet scrapbook-card" role="alertdialog" aria-modal="true" style="max-width:420px;" data-idb-sheet>
          <div class="modal-header">
            <h3>本地存储异常</h3>
          </div>
          <div class="modal-body" style="font-size:14px;line-height:1.65;color:var(--text-secondary);">
            <p>浏览器报告无法读取 IndexedDB。<strong>不会自动清空。</strong></p>
            <p style="font-size:12px;opacity:.9;margin-top:8px;">${esc(msg)}</p>
            ${guideHtml}
            <p style="font-size:12px;opacity:.85;margin-top:8px;">若电脑用 localhost、手机用 192.168 地址，两边是<strong>两套独立存档</strong>，互不相通。</p>
          </div>
          <div class="modal-body" style="display:flex;flex-direction:column;gap:8px;padding-top:0;">
            <button type="button" class="btn btn-primary btn-block" data-idb-reload>重新加载页面</button>
            <button type="button" class="btn btn-outline btn-block" data-idb-salvage>尝试导出备份（尽力读取）</button>
            ${resetButtonHtml}
            <button type="button" class="btn btn-sm btn-soft" data-idb-close>关闭</button>
          </div>
        </div>
      </div>
    `;
    host.classList.add('active');
    const close = () => {
      host.classList.remove('active');
      host.innerHTML = '';
    };
    host.querySelector('[data-idb-overlay]')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) {
        close();
        resolve('abort');
      }
    });
    host.querySelector('[data-idb-sheet]')?.addEventListener('click', (e) => e.stopPropagation());
    host.querySelector('[data-idb-reload]')?.addEventListener('click', () => {
      close();
      resolve('reload');
    });
    host.querySelector('[data-idb-salvage]')?.addEventListener('click', async () => {
      showToast('正在尝试读取各表…', 3000);
      try {
        const r = await trySalvageDumpStores();
        if (r.ok && r.dump) {
          const { downloadJson } = await import('./core/native-download.js');
          await downloadJson(r.dump, `marshmallow-phone-salvage-${Date.now()}.json`);
          showToast('已下载抢救备份', 5000);
        } else {
          showToast(`导出失败：${r.error?.message || '未知'}`, 5000);
        }
      } catch (ex) {
        showToast(`导出异常：${ex?.message || ex}`, 5000);
      }
    });
    host.querySelector('[data-idb-reset]')?.addEventListener('click', () => {
      if (!globalThis.confirm('确定清空本地库并重建？未导出的数据将不可恢复。')) return;
      close();
      resolve('reset');
    });
    host.querySelector('[data-idb-close]')?.addEventListener('click', () => {
      close();
      resolve('abort');
    });
  });

  globalThis.addEventListener('marshmallow-idb-recovered', () => {
    showToast('本地库已重建，请从备份导入或重新配置', 6000);
  });
}

let nativeCacheReloadScheduled = false;
function installNativeCacheRecoveryUi() {
  globalThis.addEventListener('marshmallow-native-cache-needs-rebuild', () => {
    if (nativeCacheReloadScheduled) return;
    nativeCacheReloadScheduled = true;
    showToast('数据已保存，正在检查本地缓存', 4000);
    const repairWhenSafe = async () => {
      const safety = globalThis.__mm_update_safety_state__ || {};
      if (Number(safety.criticalCount || 0) > 0 || document.hidden) {
        globalThis.setTimeout(repairWhenSafe, 800);
        return;
      }
      try {
        const result = await rebuildIndexedDbCacheIfNeeded({ allowFullRebuild: false });
        if (result?.repaired) showToast(`本地缓存已补齐 ${result.restored || 0} 项`, 3500);
        else if (result?.fullRebuildDeferred) {
          showToast('数据已安全保存；缓存将在下次打开应用时续接修复', 8000);
        }
      } catch (error) {
        console.error('[app] 本地缓存增量修复失败', error);
        showToast('本地缓存修复失败；数据已保存在原生主库，请稍后重启重试', 8000);
      } finally {
        nativeCacheReloadScheduled = false;
      }
    };
    globalThis.setTimeout(repairWhenSafe, 500);
  });
}

function mmlog(level, msg) {
  try {
    if (typeof window !== 'undefined' && typeof window.__mmlog === 'function') {
      window.__mmlog(level, msg);
    }
  } catch (_) {}
}

async function boot() {
  const embeddedBeautifyPreview = isEmbeddedBeautifyPreview();
  mmlog('info', 'boot() 开始');
  installGlobalDebugHandlers();
  installBackupImportFailureUi();
  installIdbRecoveryUi();
  installNativeCacheRecoveryUi();
  import('./core/user-activity.js').then((m) => {
    const mark = () => m.markUserActivity?.();
    ['pointerdown', 'keydown', 'touchstart'].forEach((evt) => {
      window.addEventListener(evt, mark, { passive: true, capture: true });
    });
  }).catch(() => {});
  mmlog('info', '正在打开本地数据库…');
  await dbOpen();
  mmlog('info', '本地数据库就绪');
  const nativeCache = embeddedBeautifyPreview
    ? { rebuilt: false, reason: 'beautify-preview-frame' }
    : await rebuildIndexedDbCacheIfNeeded();
  if (nativeCache?.rebuilt) {
    mmlog('info', `已从原生主库重建网页缓存（${nativeCache.restored || 0} 条）`);
  }
  // 先完成空库保护，再允许任何外观迁移或其它启动模块读写 settings。
  // 浏览器若刚丢失 IndexedDB，不能让并行初始化先往新空库写入记录、污染故障现场。
  await ensureDefaultUser();
  // A send tap stages its message/reply identity synchronously. Recover this tiny
  // outbox immediately after the user slot exists; the normal background scheduler
  // is intentionally delayed on mobile and is too late for a killed send pipeline.
  installReplyIntentOutboxRecovery({ reason: 'app-boot' });
  await Promise.all([
    applyAppearanceThemeFromPrefs()
      .then(() => initializeBeautifySafeMode())
      .catch(() => {}),
    initializeAutoExpandTranslations().catch(() => {}),
  ]);
  initializeMemoryRegionIndicator();
  mmlog('info', '默认档位就绪');
  registerRoutes();
  bindRoutePrefetch(loadPage);
  routerInit();
  // 美化工作室与社区美化详情会在同源 iframe 中启动一份只读真实页面。
  // 这里若复用顶层 App 的启动锁屏，预览就只会拍到密码键盘而不是目标页面。
  if (!embeddedBeautifyPreview) initializeAppLock();
  mmlog('info', '路由就绪，首屏渲染中');
  if (interruptedBackupImport
    && ['interrupted', 'failed'].includes(interruptedBackupImport.status)
    && !interruptedBackupImport.noticeAcknowledgedAt) {
    showBackupImportFailureNotice(interruptedBackupImport);
  } else if (skippedBackupImportNotice) {
    showBackupImportSkippedNotice(skippedBackupImportNotice);
  } else if (nativeCache?.skippedRecords?.length) {
    showBackupImportSkippedNotice({
      skipped: nativeCache.skippedRecords.map((item) => ({
        assetName: item.storeName === 'soundAssets' ? 'soundAssets' : 'nativeCache',
        id: item.recordKey,
        reason: item.reason,
      })),
    });
  }
  clearBootLoading();
  try {
    localStorage.removeItem('__mm_boot_pending__');
    localStorage.setItem('__mm_boot_failures__', '0');
  } catch (_) {}
  if (embeddedBeautifyPreview) {
    // 预览只需要真实路由与主题。原生桥、后台调度、悬浮窗、版本公告均由顶层 App 负责；
    // 子 frame 重复启动既浪费内存，也会在部分 Android WebView 中等不到插件回调。
    markAppReady();
    return;
  }
  window.addEventListener('marshmallow-route-activated', (event) => {
    rememberMobileRoute(event?.detail?.path);
  });
  scheduleRouteWarmup();
  import('./core/native-system-ui.js').then((m) => m.initNativeSystemUi?.()).catch(() => {});
  // 首屏路由启动后不要立刻并发解析所有可选系统。它们并非点开当前页面所必需，
  // 在低端 WebView 上与首个页面 import/IndexedDB 读取撞在一起会直接表现为首点迟钝。
  scheduleStableIdleTask(() => {
    import('./core/capabilities/runtime.js')
      .then((module) => module.initializeCapabilityRuntime?.())
      .catch((error) => appendDebugEvent({
        type: 'capability_runtime_init_failed',
        level: 'warn',
        message: String(error?.message || error || 'capability runtime init failed'),
      }).catch(() => {}));
  }, { mobileDelayMs: 8_000, desktopDelayMs: 2_500, activeWindowMs: 1_500 });
  scheduleStableIdleTask(() => {
    import('./core/storage-persistence.js')
      .then((m) => m.ensureStoragePersistenceOnBoot?.())
      .catch(() => {});
  }, { mobileDelayMs: 12_000, desktopDelayMs: 3_500, activeWindowMs: 2_000 });
  // 历史遗留的未压缩大图（壁纸/头像/图标）会拖慢每次冷启动的美化配置读取，
  // 且容易在美化设置页把渲染进程闷死；空闲时一次性收敛，不占首屏路径。
  // 历史大图整理需要解码原图。Android/iOS WebView 即使处于“空闲”，也可能因单张
  // 高像素图或多份 base64 副本被系统终止。手机端新上传已在写入前压缩，不再在普通启动
  // 后无提示迁移历史图片，避免“闪退—重启—再次处理同一张”。
  if (!isConstrainedMobileRuntime()) {
    const compactAppearanceLater = () => compactOversizedAppearanceImages({
      priorityActiveTheme: true,
      yieldEvery: 1,
    }).catch(() => {});
    const compactAvatarsLater = () => compactOversizedContactAvatars().catch(() => {});
    scheduleStableIdleTask(async () => {
      // 两类图片整理串行执行，避免壁纸与头像同时解码形成双倍峰值。
      await compactAppearanceLater();
      await compactAvatarsLater();
    }, { desktopDelayMs: 2500 });
  }
  scheduleStableIdleTask(() => {
    import('./core/preset-store.js').then((m) => m.loadPresetsPageSnapshot?.()).catch(() => {});
  }, { mobileDelayMs: 30_000, desktopDelayMs: 0 });
  scheduleStableIdleTask(() => {
    import('./core/background-scheduler.js')
      .then((m) => m.initBackgroundScheduler?.())
      .catch(() => {});
  }, { mobileDelayMs: 60_000, desktopDelayMs: 0 });
  const runCloudBackupLater = () => {
    import('./core/cloud-backup.js')
      .then((m) => m.runAutomaticCloudBackupIfDue?.())
      .then((result) => {
        if (result?.reason !== 'busy') return;
        scheduleStableIdleTask(runCloudBackupLater, {
          mobileDelayMs: 10 * 60_000,
          desktopDelayMs: 2 * 60_000,
          activeWindowMs: 2 * 60_000,
        });
      })
      .catch(() => {});
  };
  scheduleStableIdleTask(runCloudBackupLater, {
    mobileDelayMs: 180_000,
    desktopDelayMs: 12_000,
  });
  // APK 点系统通知进会话：不依赖 companion-dock 是否加载成功。
  import('./core/native-notification-open.js')
    .then((m) => m.initNativeNotificationOpenBridge?.())
    .catch(() => {});
  // 快捷悬浮球承担卡死自救，不能和普通可选模块一起等待“用户停止操作”。
  // 动态 import 本身不会阻塞首屏；立即发起后，持续点按、生成中或刚从后台回来
  // 都不会把挂载无限顺延到下一轮 5 秒空闲检查。
  import('./components/quick-ball.js')
    .then((m) => m.mountQuickBall?.())
    .catch((err) => {
      console.error('[quick-ball] load failed', err);
      appendDebugEvent({
        type: 'quick_ball_load_error',
        level: 'error',
        message: err?.message || 'quick-ball load failed',
        stack: err?.stack || '',
      }).catch(() => {});
    });
  scheduleStableIdleTask(() => {
    import('./core/time-mode.js')
      .then((m) => m.initTimeVisibilityPause?.())
      .catch(() => {});
  }, { mobileDelayMs: 9_000, desktopDelayMs: 4_000, activeWindowMs: 2_000 });
  markAppReady();
  // 浏览器 / PWA 没有 APK filesDir。把两代完整快照旁路到 OPFS，避免浏览器
  // 只丢 IndexedDB、localStorage 标记仍在时，急救页没有可恢复的数据副本。
  scheduleStableIdleTask(() => {
    import('./core/browser-safety-backup.js')
      .then((m) => m.installBrowserSafetyBackupScheduler?.())
      .catch((err) => {
        try {
          mmlog('warn', `browser safety backup scheduler unavailable: ${err?.message || err}`);
        } catch (_) {}
      });
  }, { mobileDelayMs: 25_000, desktopDelayMs: 9_000, activeWindowMs: 2_000 });
  mmlog('info', 'boot() 完成，启动成功');
}

boot().catch((err) => {
  mmlog('error', 'boot() 失败: ' + ((err && err.stack) || (err && err.message) || err));
  console.error('[app] boot failed:', err);
  appendDebugEvent({
    type: 'boot_error',
    level: 'error',
    message: err?.message || err,
    stack: err?.stack || '',
  }).catch(() => {});
  if (typeof window !== 'undefined') {
    window.__MARSHMALLOW_BOOT_FAILED = true;
  }
  const loading = document.getElementById('boot-loading');
  const msg = (err && err.message) || String(err || '未知错误');
  const esc = (value) => String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  if (loading) {
    const localDataSlow = /IndexedDB|本地数据库/.test(msg);
    loading.innerHTML = `
      <div class="placeholder-page">
        <div class="placeholder-icon">${localDataSlow ? '⏳' : '❌'}</div>
        <div class="placeholder-text">${localDataSlow ? '本地数据启动较慢' : '启动失败'}</div>
        <div class="placeholder-sub">${esc(msg)}</div>
        <div style="display:flex;flex-wrap:wrap;justify-content:center;gap:8px;margin-top:16px;">
          <button class="btn btn-primary" type="button" data-boot-retry>重新尝试</button>
          <a class="btn btn-outline" href="recovery.html" style="text-decoration:none;">打开急救诊断</a>
        </div>
      </div>`;
    loading.querySelector('[data-boot-retry]')?.addEventListener('click', () => {
      globalThis.location.reload();
    });
  }
});
