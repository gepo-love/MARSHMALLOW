// 棉花糖之窗 · 首页渲染
// 设计：一扇横跨三页、毛玻璃质感的大窗。划过去三页拼成一扇圆满的窗户。
// 关键架构：本文件只负责「窗骨架 + 装饰」，所有交互（长按编辑、拖拽换位、
// 动态分页、图片槽上传、文字保存、壁纸层、Dock）直接复用「棉花糖之海」的
// 引擎 bindSeaHome —— 不重写任何拖拽逻辑。窗只是海引擎之上的另一层皮。

import {
  loadAppearancePrefs,
  saveAppearancePrefs,
  getActiveTheme,
  getAppLabel,
  applyThemeWallpaperToElement,
  normalizeHomeLayout,
  BUILTIN_HOME_WIDGET_DEFS,
  isHomeEmptySlotId,
  createHomeEmptySlotId,
  isHomeGridBuiltinId,
  isWidgetVisible,
  MAX_HOME_PAGES,
} from '../core/appearance-prefs.js';
import {
  getAppRoute,
  getLayoutAppPages,
  getLayoutPageGridItems,
  PAGE_ONE_APPS,
  PAGE_TWO_APPS,
  PAGE_THREE_APPS,
  DOCK_APPS,
  getWindowIconSvg,
  isComingSoonApp,
  isCommercialHomeIcon,
} from '../data/home-layout.js';
import {
  bindSeaHome,
  disposeHomeBindings,
  renderSeaWallpaperLayer,
  preloadHomeWallpapers,
  registerHomeCleanup,
  formatClock,
  formatDateUpper,
  rememberSeaHomePageBeforeNavigate,
} from './home-sea.js';
import { customWidgetCardHtml, hydrateCustomWidgets } from '../core/custom-widget.js';
import {
  getMusicPlayerState,
  subscribeMusicPlayer,
  hasMusicController,
  commandTogglePlay,
} from '../core/companion/music-player-bridge.js';
import { normalizeRemoteCoverUrl } from '../core/music-library.js';
import { navigate } from '../core/router.js';
import { getCurrentUser } from '../core/user-slot.js';
import { bindChatUnreadIndicator } from '../core/chat-unread-indicator.js';
import { bindMailboxUnreadIndicator } from '../core/mailbox-unread-indicator.js';
import {
  fetchWeatherForCity,
  getEffectiveWeatherCityForUser,
  summarizeWeatherDisplay,
} from '../core/weather-location.js';
import { getHomeWorldDate } from '../core/home-world-time.js';
import {
  getHomeCustomIconSource,
  hydrateHomeCustomIconFallbacks,
  installHomeNativeDragGuard,
  renderHomeIconLayers,
} from '../core/home-custom-icons.js';

// 热更切换的极短窗口里，WebView 可能先拿到新版页面模块、仍持有上一版主题 CSS。
// 第四页组件必须自带占格骨架，否则会退化成单个 App 格并把文案挤成竖排。
const WINDOW_FOURTH_CRITICAL_LAYOUT = [
  'grid-column:1 / -1',
  'grid-row:span 2',
  'box-sizing:border-box',
  'width:calc(100% - 12px)',
  'height:166px',
  'justify-self:center',
  'display:grid',
  'grid-template-columns:112px minmax(0,1fr)',
  'align-items:stretch',
  'overflow:hidden',
].join(';');

function esc(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderIconInner(appId, theme) {
  const fallback = getWindowIconSvg(appId);
  return renderHomeIconLayers(getHomeCustomIconSource(theme, appId), fallback, {
    className: 'sea-custom-icon',
    escape: esc,
  });
}

// 图标按钮：复用海引擎绑定的 .sea-app[data-app-id] + .ic 结构。
function renderApp(appId, prefs, theme, options = {}) {
  const dock = !!options.dock;
  const comingSoon = isComingSoonApp(appId);
  const testing = appId === 'together-reading';
  const commercialIcon = isCommercialHomeIcon(appId);
  const cls = `${dock ? 'sea-dock-ic mw-dock-ic' : 'sea-app mw-app'}${commercialIcon ? ' is-commercial-icon' : ''}${comingSoon ? ' is-coming-soon' : ''}${testing ? ' is-testing' : ''}`;
  const label = getAppLabel(prefs, appId) || appId;
  return `
    <button type="button" class="${cls}" data-sea-route="${esc(getAppRoute(appId))}" data-app-id="${esc(appId)}" aria-label="${esc(comingSoon ? `${label}，未来开发` : testing ? `${label}，测试中` : label)}">
      <span class="ic">${renderIconInner(appId, theme)}${comingSoon ? '<span class="future-app-mark" aria-hidden="true">未来开发</span>' : ''}${testing ? '<span class="test-app-mark" aria-hidden="true">测试中</span>' : ''}</span>
      ${dock ? '' : `<span class="lb">${esc(label)}</span>`}
    </button>`;
}

function renderGridItem(itemId, prefs, theme, customItems = {}) {
  if (isHomeEmptySlotId(itemId)) {
    return `<span class="sea-drop-slot sea-layout-empty-slot" data-sea-empty-slot="${esc(itemId)}" aria-hidden="true"></span>`;
  }
  if (customItems[itemId]) {
    return customWidgetCardHtml(customItems[itemId], { editable: true, movable: true });
  }
  if (itemId === 'windowFourthDecor') {
    const widgets = theme?.widgets || {};
    const title = String(widgets.windowFourthTitle || '').trim() || '光落在室内';
    const text = String(widgets.windowFourthText || '').trim() || '留一格给今天安静的片段。';
    const controls = `<span class="home-widget-controls" data-mm-widget-controls><button type="button" class="home-edit-delete" data-real-remove="windowFourthDecor" aria-label="删除组件">−</button><span class="home-widget-move"><button type="button" data-widget-move="windowFourthDecor:-1" aria-label="移到上一页">◀</button><button type="button" data-widget-move="windowFourthDecor:1" aria-label="移到下一页">▶</button></span></span>`;
    return `<div class="home-grid-builtin mw-fourth-decor" data-home-longpress-item="windowFourthDecor" data-widget-cols="4" data-widget-rows="2" style="${WINDOW_FOURTH_CRITICAL_LAYOUT}">${controls}
      <div class="mw-fourth-photo">${renderSlot('windowFourthImage', widgets.windowFourthImage || '', '上传', 'mw-fourth-slot')}</div>
      <div class="mw-fourth-copy"><span class="mw-fourth-kicker">WINDOW LIGHT / 04</span><b class="sea-editable" contenteditable="true" data-sea-field="windowFourthTitle" data-placeholder="标题">${esc(title)}</b><p class="sea-editable" contenteditable="true" data-sea-field="windowFourthText" data-placeholder="写一句话">${esc(text)}</p></div>
      <i class="mw-fourth-glare" aria-hidden="true"></i>
    </div>`;
  }
  return renderApp(itemId, prefs, theme);
}

function renderGrid(items, prefs, theme, extraClass = '', customItems = {}) {
  return `<div class="sea-apps mw-grid ${extraClass}">${items.map((id) => renderGridItem(id, prefs, theme, customItems)).join('')}</div>`;
}

// 图片上传槽：复用海引擎绑定的 .sea-slot + [data-sea-slot]/[data-sea-slot-file] + .hint，
// 额外加一个清除按钮（清除逻辑在 bindWindowExtras 里绑定，引擎不动）。
function renderSlot(field, src, hint, extraClass = '') {
  const filled = !!String(src || '').trim();
  return `
    <div class="sea-slot mw-slot ${extraClass} ${filled ? '' : 'empty'}" data-sea-slot="${esc(field)}">
      ${filled ? `<img src="${esc(src)}" alt="">` : `<span class="hint">${esc(hint)}</span>`}
      <button type="button" class="mw-slot-clear" data-mw-slot-clear aria-label="清除图片">×</button>
      <input type="file" accept="image/*" data-sea-slot-file="${esc(field)}" hidden>
    </div>`;
}

// 跨页窗框：竖边只在首/尾页画 → 左右收口，随页面滚动。
function pageEdgeHtml(page) {
  if (page === 1) return '<i class="mw-frame-edge mw-edge-left" aria-hidden="true"></i>';
  if (page === 3) return '<i class="mw-frame-edge mw-edge-right" aria-hidden="true"></i>';
  return '';
}

// 黑胶唱片风音乐卡（窗专属，呼应参考图：极简黑白、唱片环、可传图的圆形碟心）。
// 碟心是可上传图片槽（windowMusicCover），唱片随播放旋转。文字/进度用定点刷新，
// 不整段重写 innerHTML，避免把上传槽和它绑定的 file input 冲掉。
function windowMusicHtml(ms, coverSrc, titleText) {
  const track = (ms && ms.track) || {};
  const playing = !!(ms && ms.isPlaying);
  const pct = ms && ms.durationMs ? Math.min(1, ms.positionMs / ms.durationMs) : 0;
  const rawCover = String(coverSrc || track.coverUrl || '').trim();
  // 用户上传槽可走 data:；跟播封面则升 https，避免 APK mixed-content 裂图
  const cover = coverSrc
    ? rawCover
    : (normalizeRemoteCoverUrl(rawCover) || (/^data:image\//i.test(rawCover) ? rawCover : ''));
  const title = titleText || '棉花糖之窗';
  return `
    <div class="mw-vinyl ${playing ? 'spin' : ''}" data-mw-vinyl aria-hidden="true">
      <div class="mw-vinyl-disc"></div>
      <div class="mw-vinyl-label">
        ${renderSlot('windowMusicCover', cover, '+', 'mw-vinyl-slot')}
      </div>
      <span class="mw-vinyl-hole"></span>
    </div>
    <span class="mw-music-t sea-editable" contenteditable="true" data-sea-field="windowMusicTitle" data-placeholder="标题">${esc(title)}</span>
    <span class="mw-music-bar"><i data-mw-prog style="transform:scaleX(${pct.toFixed(3)})"></i></span>
    <div class="mw-music-ctls" aria-hidden="true">
      <i class="mw-ctl">↺</i>
      <i class="mw-ctl">◅◅</i>
      <i class="mw-ctl mw-ctl-play" data-mw-play>${playing ? '❚❚' : '▶'}</i>
      <i class="mw-ctl">▻▻</i>
      <i class="mw-ctl">≡</i>
    </div>`;
}

// 挂式小拍立得：白边相框 + 顶部小胶带，内部是可上传图片槽（复用引擎 .sea-slot）。
function filmHtml(field, src, rotClass) {
  return `
    <div class="mw-film ${rotClass}">
      <i class="mw-film-tape" aria-hidden="true"></i>
      ${renderSlot(field, src, '照片', 'mw-film-slot')}
    </div>`;
}

function weatherClass(weather = {}) {
  const line = `${summarizeWeatherDisplay(weather)} ${String(weather.condition || '')}`.trim();
  if (/雾|霾/u.test(line)) return 'mw-weather-fog';
  if (/雨|阵雨|毛毛雨|雷阵雨/u.test(line)) return 'mw-weather-rain';
  return 'mw-weather-clear';
}

async function buildWeatherClass(profile) {
  const info = getEffectiveWeatherCityForUser(profile || {});
  if (!info.weatherCity) return 'mw-weather-clear';
  const weather = await fetchWeatherForCity(info.weatherCity).catch(() => null);
  return weatherClass(weather || {});
}

export default async function renderWindowHome(container) {
  const prefs = await loadAppearancePrefs();
  const { theme } = getActiveTheme(prefs);
  await preloadHomeWallpapers(theme);
  disposeHomeBindings(container);
  const layout = normalizeHomeLayout(theme.homeLayout, theme.widgetVisibility);
  const appPages = getLayoutAppPages(layout);
  const pageGridItems = appPages.map((_, index) => getLayoutPageGridItems(layout, index)
    .filter((id) => id === 'windowFourthDecor' || !isHomeGridBuiltinId(id)));
  const [page1Items = [], page2Items = [], page3Items = []] = pageGridItems;
  const extraPages = pageGridItems.slice(3);
  const dockApps = layout.dock;
  const customItems = layout.customItems || {};
  const widgets = theme.widgets || {};
  const profile = await getCurrentUser().catch(() => null);
  // 先用默认天气直接渲染，天气接口在渲染后异步更新，避免网络请求阻塞首页加载。
  const weatherCls = 'mw-weather-clear';
  const now = await getHomeWorldDate(profile?.id).catch(() => new Date());

  const img = (k) => (typeof widgets[k] === 'string' ? widgets[k] : '');
  const show = (key) => isWidgetVisible(theme, key);
  const showClock = show('userHeader');
  const showCircle = show('polaroidP1');
  const showPortrait = show('polaroidP3');
  const showMusic = show('filmWidget');

  // 窗第二页短句拆两行：第一句靠左、第二句靠右，像诗行错落。两行各自独立可编辑。
  const CAP1_DEFAULT = 'Once we dreamt';
  const CAP2_DEFAULT = 'that we were strangers.';
  const rawCap1 = typeof widgets.polaroidCaptionP1 === 'string' ? widgets.polaroidCaptionP1 : '';
  const captionLine1 = (!rawCap1 || rawCap1 === '今日份的开心 ☁️' || rawCap1 === 'Once we dreamt that we were strangers.') ? CAP1_DEFAULT : rawCap1;
  const rawCap2 = typeof widgets.windowCaptionP2 === 'string' ? widgets.windowCaptionP2 : '';
  const captionLine2 = rawCap2 || CAP2_DEFAULT;
  const musicCover = img('windowMusicCover');
  const musicTitle = typeof widgets.windowMusicTitle === 'string' && widgets.windowMusicTitle.trim() ? widgets.windowMusicTitle : '棉花糖之窗';

  container.className = `page home-window-shell ${weatherCls}`;
  // 底图交给壁纸层（高斯模糊），shell 本身不铺底，避免边缘模糊露白。
  applyThemeWallpaperToElement(container, { ...theme, wallpaper: '__none__', wallpaperOpacity: 0 });
  const winOpacity = Number(theme.wallpaperOpacity);
  container.style.setProperty('--mw-veil', Number.isFinite(winOpacity) ? String(Math.max(0, Math.min(1, winOpacity / 0.14))) : '1');

  container.innerHTML = `
    <div class="sea-wallpaper-layer mw-wallpaper" data-sea-wallpaper-layer aria-hidden="true"></div>
    <div class="mw-weather-skin" aria-hidden="true"><i class="mw-fog"></i><i class="mw-rain"></i></div>

    <div class="mw-fixed-frame" aria-hidden="true">
      <i class="mw-frame-bar mw-bar-top"></i>
      <i class="mw-frame-bar mw-bar-mid"></i>
      <i class="mw-frame-bar mw-bar-bottom"></i>
      <i class="mw-glare"></i>
    </div>

    <div class="sea-pages mw-pages" data-sea-pages>
      ${appPages.length > 0 ? `
      <section class="sea-page mw-page mw-page-1" data-sea-page="0">
        ${pageEdgeHtml(1)}
        <span class="mw-mask mw-mask-tl" aria-hidden="true"></span>
        <span class="mw-mask mw-mask-br" aria-hidden="true"></span>
        <div class="mw-p1-stage">
          <div class="mw-p1-head">
            ${showClock ? `
            <div class="mw-clock">
              <span class="mw-date" data-sea-clock-date>${esc(formatDateUpper(now))}</span>
              <strong class="mw-time" data-sea-clock>${formatClock(now)}</strong>
            </div>` : ''}
            ${showCircle ? `<div class="mw-circle-wrap">${renderSlot('windowCircleImage', img('windowCircleImage'), '上传', 'mw-circle')}</div>` : ''}
          </div>
          ${renderGrid(page1Items, prefs, theme, 'mw-grid-1', customItems)}
        </div>
      </section>
      ` : ''}

      ${appPages.length > 1 ? `
      <section class="sea-page mw-page mw-page-2" data-sea-page="1">
        ${pageEdgeHtml(2)}
        <span class="mw-mask mw-mask-p2" aria-hidden="true"></span>
        <div class="mw-p2-stage">
          ${showPortrait ? `
          <div class="mw-portrait">
            ${renderSlot('windowPortraitImage', img('windowPortraitImage'), '上传', 'mw-portrait-slot')}
            <span class="mw-portrait-mask" aria-hidden="true"></span>
          </div>` : ''}
          <div class="mw-caption">
            <span class="mw-cap-l sea-editable" contenteditable="true" data-sea-field="polaroidCaptionP1" data-placeholder="第一句">${esc(captionLine1)}</span>
            <span class="mw-cap-r sea-editable" contenteditable="true" data-sea-field="windowCaptionP2" data-placeholder="第二句">${esc(captionLine2)}</span>
          </div>
          ${renderGrid(page2Items, prefs, theme, 'mw-grid-2', customItems)}
        </div>
      </section>
      ` : ''}

      ${appPages.length > 2 ? `
      <section class="sea-page mw-page mw-page-3" data-sea-page="2">
        ${pageEdgeHtml(3)}
        <div class="mw-p3-stage">
          <div class="mw-shelf">
            ${showMusic ? `<div class="mw-music-sq" data-mw-music role="button" tabindex="0" aria-label="音乐">${windowMusicHtml(getMusicPlayerState(), musicCover, musicTitle)}</div>` : ''}
            <div class="mw-films">
              ${filmHtml('windowFilmA', img('windowFilmA'), 'mw-film-a')}
              ${filmHtml('windowFilmB', img('windowFilmB'), 'mw-film-b')}
            </div>
          </div>
          ${renderGrid(page3Items, prefs, theme, 'mw-grid-3', customItems)}
        </div>
      </section>
      ` : ''}

      ${extraPages.map((items, i) => `
      <section class="sea-page sea-page-extra mw-page mw-page-extra" data-sea-page="${i + 3}">
        ${pageEdgeHtml(0)}
        <div class="sea-extra-head mw-extra-head">分页 ${i + 4}</div>
        <div class="sea-apps sea-apps-extra mw-grid mw-grid-extra">
          ${items.map((id) => renderGridItem(id, prefs, theme, customItems)).join('')}
        </div>
      </section>`).join('')}
    </div>

    <div class="sea-edit-bar mw-edit-bar" data-sea-edit-bar hidden>
      <button type="button" class="sea-edit-btn mw-edit-btn" data-sea-edit-reset>复位</button>
      <button type="button" class="sea-edit-btn mw-edit-btn" data-sea-edit-widget-library>组件库</button>
      <button type="button" class="sea-edit-btn mw-edit-btn" data-sea-edit-remove>删页</button>
      <button type="button" class="sea-edit-btn mw-edit-btn" data-sea-edit-add>＋页</button>
      <button type="button" class="sea-edit-btn mw-edit-btn primary" data-sea-edit-done>完成</button>
    </div>

    <div class="sea-bottom mw-bottom">
      <div class="sea-dots mw-dots" data-sea-dots>${appPages.map((_, i) => `<i${i === 0 ? ' class="on"' : ''}></i>`).join('')}</div>
      <div class="sea-dock mw-dock">
        ${dockApps.map((id) => renderApp(id, prefs, theme, { dock: true })).join('')}
      </div>
    </div>`;

  registerHomeCleanup(container, installHomeNativeDragGuard(container));
  hydrateHomeCustomIconFallbacks(container);
  hydrateCustomWidgets(container, layout.customItems, { userId: profile?.id });
  renderSeaWallpaperLayer(container, theme);

  // 异步拉天气，拿到后只替换 mw-weather-* class，不阻塞渲染。
  void buildWeatherClass(profile).then((cls) => {
    if (!container.isConnected) return;
    const next = String(cls || 'mw-weather-clear');
    [...container.classList]
      .filter((c) => c.startsWith('mw-weather-'))
      .forEach((c) => container.classList.remove(c));
    container.classList.add(next);
  }).catch(() => {});

  // 复用海引擎：拖拽换位、动态分页、图片槽上传、文字保存、时钟/音乐刷新、Dock。
  // rerender 指回窗渲染器，编辑完成后重绘的是「窗」而不是「海」。
  bindSeaHome(container, {
    prefs,
    rerender: () => renderWindowHome(container),
    userId: profile?.id,
  });

  if (profile?.id) {
    bindChatUnreadIndicator(container, profile.id, registerHomeCleanup);
    bindMailboxUnreadIndicator(container, profile.id, registerHomeCleanup);
  }
  bindWindowExtras(container);
}

// 窗专属增强：图片槽清除按钮（引擎只管上传，不管清除）。
function bindWindowExtras(container) {
  container.querySelectorAll('[data-mw-slot-clear]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const slot = btn.closest('[data-sea-slot]');
      const field = String(slot?.getAttribute('data-sea-slot') || '').trim();
      if (!slot || !field) return;
      const fresh = await loadAppearancePrefs();
      const active = getActiveTheme(fresh);
      await saveAppearancePrefs({
        ...fresh,
        themes: {
          ...fresh.themes,
          [active.id]: {
            ...active.theme,
            widgets: { ...(active.theme.widgets || {}), [field]: '' },
          },
        },
      });
      slot.querySelector('img')?.remove();
      slot.classList.add('empty');
      if (!slot.querySelector('.hint')) {
        slot.insertAdjacentHTML('afterbegin', '<span class="hint">上传</span>');
      }
    });
  });

  bindWindowMusic(container);

  if (container.querySelector('[data-app-id="travel-char"]')) bindTravelBadge(container);
}

// 黑胶音乐卡：定点刷新（不整段重写，保住可上传碟心）+ 点击切播放/进音乐模块。
// 点在碟心上传槽 / 清除按钮时不触发跳转，留给上传逻辑。
function bindWindowMusic(container) {
  const el = container.querySelector('[data-mw-music]');
  if (!el) return;
  let navigating = false;
  const refresh = () => {
    const ms = getMusicPlayerState();
    const playing = !!(ms && ms.isPlaying);
    const pct = ms && ms.durationMs ? Math.min(1, ms.positionMs / ms.durationMs) : 0;
    const vinyl = el.querySelector('[data-mw-vinyl]');
    if (vinyl) vinyl.classList.toggle('spin', playing);
    const progEl = el.querySelector('[data-mw-prog]');
    if (progEl) progEl.style.transform = `scaleX(${pct.toFixed(3)})`;
    const playEl = el.querySelector('[data-mw-play]');
    if (playEl) playEl.textContent = playing ? '❚❚' : '▶';
  };
  el.addEventListener('click', async (e) => {
    if (container.classList.contains('is-sea-editing')) return;
    // 点在碟心上传槽 / 清除按钮 / 可编辑标题上：交给各自逻辑，不切歌不跳转
    if (e.target.closest('.mw-vinyl-slot') || e.target.closest('[data-mw-slot-clear]') || e.target.closest('.sea-editable')) return;
    if (hasMusicController()) {
      const ok = await commandTogglePlay().catch(() => false);
      if (ok) { refresh(); return; }
    }
    if (navigating) return;
    navigating = true;
    rememberSeaHomePageBeforeNavigate(container);
    navigate('music');
  });
  // Keep-Alive 挂起会 removeChild，不能在这里清掉定时器/订阅，否则回主屏后黑胶卡不再同步。
  const tick = () => {
    if (!container.isConnected) return;
    refresh();
  };
  const unsubscribeMusic = subscribeMusicPlayer(tick);
  tick();
  const tickTimer = setInterval(tick, 1000);

  const onRouteActivated = (ev) => {
    const detail = ev.detail || {};
    if (detail.container !== container || detail.path !== 'home' || !detail.resumed) return;
    navigating = false;
    tick();
  };
  window.addEventListener('marshmallow-route-activated', onRouteActivated);
  registerHomeCleanup(container, () => {
    unsubscribeMusic();
    window.clearInterval(tickTimer);
    window.removeEventListener('marshmallow-route-activated', onRouteActivated);
  });
}

async function bindTravelBadge(container) {
  const profile = await getCurrentUser().catch(() => null);
  if (!profile?.id) return;
  const refresh = async () => {
    if (!document.body.contains(container)) {
      window.removeEventListener('travel-char-notifications', refresh);
      return;
    }
    // 动态加载：避免首页静态导入 travel-char 整条聊天上下文链
    const { listTravelCharNotifications } = await import('../core/travel-char.js');
    const count = (await listTravelCharNotifications(profile.id, { unreadOnly: true }).catch(() => [])).length;
    container.querySelectorAll('[data-app-id="travel-char"]').forEach((btn) => {
      const ic = btn.querySelector('.ic');
      const old = btn.querySelector('.sea-app-badge');
      if (!count) { old?.remove(); return; }
      const text = count > 99 ? '99+' : String(count);
      if (old) old.textContent = text;
      else ic?.insertAdjacentHTML('beforeend', `<span class="sea-app-badge">${text}</span>`);
    });
  };
  window.addEventListener('travel-char-notifications', refresh);
  registerHomeCleanup(container, () => {
    window.removeEventListener('travel-char-notifications', refresh);
  });
  refresh().catch(() => null);
}
