// 棉花糖之海 · 首页专属渲染（与默认棉花糖手账完全不同的版式与组件）
// 三页：氛围首页（大时钟+柔边图卡+常用图标+音乐胶囊）/ char 相册页 / 记录页。
// 编辑方式：图片槽点按上传、文字 contenteditable 失焦保存、打卡行可改；不走拖拽网格。

import { navigate } from '../core/router.js';
import { prefetchRoute } from '../core/route-prefetch.js';
import {
  loadAppearancePrefs,
  saveAppearancePrefs,
  getActiveTheme,
  getAppLabel,
  resolveWallpaperUrl,
  getWallpaperOverlayAlpha,
  applySeaGradientOverlayToElement,
  applySeaMusicColorsToElement,
  WALLPAPER_NONE,
  resolveHomePageWallpaperUrl,
  resolveHomePageWallpaperLayer,
  normalizeHomeLayout,
  BUILTIN_HOME_WIDGET_DEFS,
  DEFAULT_WIDGET_VISIBILITY,
  createHomeEmptySlotId,
  isHomeEmptySlotId,
  isHomeGridBuiltinId,
  isSeaLooseBuiltinId,
  isWindowHomeTheme,
  getBuiltinHomeWidgetDef,
  isWidgetVisible,
  removeHomeLayoutPage,
  removeHomePageWallpaper,
  MAX_HOME_PAGES,
} from '../core/appearance-prefs.js';
import {
  getAppRoute,
  getLayoutAppPages,
  getLayoutPageGridItems,
  PAGE_ONE_APPS,
  PAGE_TWO_APPS,
  PAGE_THREE_APPS,
  PAGE_FOUR_APPS,
  PAGE_FIVE_APPS,
  DOCK_APPS,
  isHomeAppGroup,
  isComingSoonApp,
  isCommercialHomeIcon,
} from '../data/home-layout.js';
import { getSeaIcon } from '../data/home-sea-icons.js';
import {
  getHomeCustomIconSource,
  hydrateHomeCustomIconFallbacks,
  installHomeNativeDragGuard,
  renderHomeIconLayers,
} from '../core/home-custom-icons.js';
import { customWidgetCardHtml, hydrateCustomWidgets } from '../core/custom-widget.js';
import { compressFileToDataUrl } from '../components/image-crop-modal.js';
import { installHomePagedScrollGuard } from '../core/home-page-scroll.js';
import { bindChatUnreadIndicator } from '../core/chat-unread-indicator.js';
import { bindMailboxUnreadIndicator } from '../core/mailbox-unread-indicator.js';
import { getCurrentUser } from '../core/user-slot.js';
import { normalizeRemoteCoverUrl } from '../core/music-library.js';
import {
  getMusicPlayerState,
  subscribeMusicPlayer,
  commandTogglePlay,
  hasMusicController,
} from '../core/companion/music-player-bridge.js';
import { getHomeWorldDate } from '../core/home-world-time.js';
import { TIME_SCHEDULE_CHANGED_EVENT } from '../core/time-mode.js';

// 记住主屏当前所在的横向分页，返回主页时恢复，避免每次都跳回第一页
let lastSeaPageIndex = 0;

const DEFAULTS = {
  seaWeather: '海风 24° · 波光正好',
  seaPortraitLine1: '与你相遇的每一天',
  seaPortraitLine2: '今天也想见到你 🌊',
  seaCharCaption: '今天想见的人',
  seaP2FloatLine1: '金光铺在海面上',
  seaP2FloatLine2: 'tides keep the quiet things',
  seaPolaroidBackCaption: '退潮的下午',
  seaPolaroidFrontCaption: '我的小记',
  seaFourthTitle: '潮汐来信',
  seaFourthText: '把今天没有说完的话，交给海风。',
  seaPostcardCaption: '来自海边的一页',
  seaAtmoSub: '· 停泊在海边',
};

const SEA_PORTRAIT_SVG = '<svg viewBox="0 0 100 100" aria-hidden="true"><defs><linearGradient id="seaPortraitG" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#bfe3f2"/><stop offset="1" stop-color="#f0cf86"/></linearGradient></defs><circle cx="50" cy="50" r="50" fill="url(#seaPortraitG)"/><circle cx="50" cy="42" r="14" fill="none" stroke="#fff" stroke-width="4"/><path d="M24 80c3-16 14-23 26-23s23 7 26 23" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round"/><circle cx="72" cy="28" r="3.4" fill="#fff"/></svg>';

const DEFAULT_STREAKS = [
  { label: '看海', value: '07 天', on: true },
  { label: '写日记', value: '03 天', on: false },
  { label: '早睡', value: '12 天', on: true },
];

function esc(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function pad2(n) { return String(n).padStart(2, '0'); }

export function formatClock(date) {
  return `${pad2(date.getHours())}<b>:</b>${pad2(date.getMinutes())}`;
}

const EN_MONTHS = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];
const EN_DAYS = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];

export function formatDateUpper(date) {
  return `${EN_DAYS[date.getDay()]}, ${EN_MONTHS[date.getMonth()]} ${date.getDate()}`;
}

function formatDateNice(date) {
  const m = EN_MONTHS[date.getMonth()];
  const mm = m.charAt(0) + m.slice(1).toLowerCase();
  return `${EN_DAYS[date.getDay()].charAt(0) + EN_DAYS[date.getDay()].slice(1).toLowerCase()}, ${mm} ${date.getDate()}`;
}

function dayOfYearInfo(date) {
  const start = new Date(date.getFullYear(), 0, 0);
  const diff = date - start;
  const day = Math.floor(diff / 86400000);
  const isLeap = (date.getFullYear() % 4 === 0 && date.getFullYear() % 100 !== 0) || date.getFullYear() % 400 === 0;
  const total = isLeap ? 366 : 365;
  return { day, total, pct: Math.min(1, day / total) };
}

function renderSeaIconInner(appId, theme) {
  const fallback = getSeaIcon(appId);
  return renderHomeIconLayers(getHomeCustomIconSource(theme, appId), fallback, {
    className: 'sea-custom-icon',
    escape: esc,
  });
}

function renderAppItem(appId, prefs, theme, options = {}) {
  const dock = !!options.dock;
  const badgeCount = Math.max(0, Number(options.badges && options.badges[appId]) || 0);
  const label = getAppLabel(prefs, appId) || appId;
  const cls = dock ? 'sea-dock-ic' : 'sea-app';
  const comingSoon = isComingSoonApp(appId);
  const testing = appId === 'together-reading';
  const commercialIcon = isCommercialHomeIcon(appId);
  return `
    <button type="button" class="${cls}${commercialIcon ? ' is-commercial-icon' : ''}${comingSoon ? ' is-coming-soon' : ''}${testing ? ' is-testing' : ''}" data-sea-route="${esc(getAppRoute(appId))}" data-app-id="${esc(appId)}" aria-label="${esc(comingSoon ? `${label}，未来开发` : testing ? `${label}，测试中` : label)}">
      <span class="ic">${renderSeaIconInner(appId, theme)}${badgeCount ? `<span class="sea-app-badge${appId === 'chat' ? ' chat-unread-badge' : ''}">${badgeCount > 99 ? '99+' : badgeCount}</span>` : ''}${comingSoon ? '<span class="future-app-mark" aria-hidden="true">未来开发</span>' : ''}${testing ? '<span class="test-app-mark" aria-hidden="true">测试中</span>' : ''}</span>
      ${dock ? '' : `<span class="lb">${esc(label)}</span>`}
    </button>`;
}

function ensureSeaLooseBuiltins(layout, theme) {
  const pages = (layout.pages || []).map((page) => (Array.isArray(page) ? page.slice() : []));
  if (!pages.length) pages.push([]);
  const byPage = [
    [1, ['seaFloatNote']],
    [2, ['seaStreaks', 'seaPolaroid', 'seaPostcard']],
    [3, ['seaFourthDecor']],
  ];
  byPage.forEach(([pageIndex, ids]) => {
    const toAdd = [];
    ids.forEach((id) => {
      const visible = isWidgetVisible(theme, id);
      if (!visible) {
        pages.forEach((_, i) => { pages[i] = pages[i].filter((item) => item !== id); });
        return;
      }
      const present = pages.some((page) => page.includes(id));
      if (!present) toAdd.push(id);
    });
    const targetIndex = Math.min(pageIndex, pages.length - 1);
    if (toAdd.length) pages[targetIndex] = [...toAdd, ...pages[targetIndex]];
  });
  return { ...layout, pages };
}

function seaWidgetControls(itemId) {
  const del = `<button type="button" class="home-edit-delete" data-real-remove="${esc(itemId)}" aria-label="删除组件">−</button>`;
  const move = `<span class="home-widget-move"><button type="button" data-widget-move="${esc(itemId)}:-1" aria-label="移到上一页">◀</button><button type="button" data-widget-move="${esc(itemId)}:1" aria-label="移到下一页">▶</button></span>`;
  return `<span class="home-widget-controls" data-mm-widget-controls>${del}${move}</span>`;
}

function homePageOfBuiltin(id) {
  const page = Number(getBuiltinHomeWidgetDef(id)?.page);
  return Number.isFinite(page) ? page : -1;
}

function pageHasBuiltin(layout, pageIndex, id) {
  return (layout.pages[pageIndex] || []).includes(id);
}

function isAnchoredBuiltin(layout, pageIndex, id) {
  return isSeaLooseBuiltinId(id) && pageHasBuiltin(layout, pageIndex, id) && homePageOfBuiltin(id) === pageIndex;
}

function renderSeaLooseInner(itemId, ctx = {}) {
  if (itemId === 'seaFloatNote') {
    return `<div class="sea-p2-mid sea-loose-float">
      ${ctx.editable?.('seaP2FloatLine1', ctx.val?.('seaP2FloatLine1'), '写一句海主题文案', 'sea-p2-line-a') || ''}
      ${ctx.editable?.('seaP2FloatLine2', ctx.val?.('seaP2FloatLine2'), '英文或诗句', 'sea-p2-line-b') || ''}
      <div class="sea-p2-orb-wrap">${ctx.renderSlot?.('seaP2Orb', ctx.img?.('seaP2Orb'), '上传') || ''}</div>
    </div>`;
  }
  if (itemId === 'seaStreaks') {
    const streaks = Array.isArray(ctx.streaks) ? ctx.streaks : [];
    return `<div class="sea-streak-bars" data-sea-streaks>
      ${streaks.map((s, i) => `
        <div class="sea-bar ${s.on ? 'on' : ''}" data-sea-streak-row="${i}">
          <span class="dot" data-sea-streak-dot="${i}"></span>
          ${ctx.editable?.('streak-label-' + i, s.label, '习惯', 'sea-bar-label') || ''}
          ${ctx.editable?.('streak-value-' + i, s.value, '0 天', 'sea-bar-val') || ''}
        </div>`).join('')}
    </div>`;
  }
  if (itemId === 'seaPolaroid') {
    return `<div class="sea-card sea-p3-polaroid">
      ${ctx.renderSlot?.('seaPolaroidFront', ctx.img?.('seaPolaroidFront'), '照片') || ''}
      <div class="cap">${ctx.editable?.('seaPolaroidFrontCaption', ctx.val?.('seaPolaroidFrontCaption'), '我的小记') || ''}</div>
    </div>`;
  }
  if (itemId === 'seaPostcard') {
    return `<div class="sea-card sea-p3-postcard">
      <span class="sea-postcard-stamp" aria-hidden="true">✦</span>
      ${ctx.renderSlot?.('seaPostcard', ctx.img?.('seaPostcard'), '上传照片') || ''}
      <div class="cap">${ctx.editable?.('seaPostcardCaption', ctx.val?.('seaPostcardCaption'), '来自海边的一页') || ''}</div>
    </div>`;
  }
  if (itemId === 'seaFourthDecor') {
    return `<div class="sea-fourth-decor">
      <div class="sea-fourth-orb">${ctx.renderSlot?.('seaFourthImage', ctx.img?.('seaFourthImage'), '上传') || ''}</div>
      <div class="sea-fourth-copy">
        <span class="sea-fourth-kicker">TIDE NOTE · 04</span>
        ${ctx.editable?.('seaFourthTitle', ctx.val?.('seaFourthTitle'), '潮汐来信', 'sea-fourth-title') || ''}
        ${ctx.editable?.('seaFourthText', ctx.val?.('seaFourthText'), '写一句留给海风的话', 'sea-fourth-text') || ''}
      </div>
    </div>`;
  }
  return '';
}

/** 换到非锚点页时的独立组件带：不进图标网格，避免破坏分栏构图 */
function renderSeaLooseStrip(layout, pageIndex, ctx, show) {
  const ids = (layout.pages[pageIndex] || []).filter((id) => (
    isSeaLooseBuiltinId(id)
      && show(id)
      && (id === 'seaFourthDecor' || homePageOfBuiltin(id) !== pageIndex)
  ));
  if (!ids.length) return '';
  return `<div class="sea-loose-widgets">${ids.map((id) => `
    <div class="sea-loose-card" data-sea-builtin="${esc(id)}" data-home-longpress-item="${esc(id)}">
      ${seaWidgetControls(id)}
      ${renderSeaLooseInner(id, ctx)}
    </div>`).join('')}</div>`;
}

function renderSeaGridItem(itemId, prefs, theme, options = {}) {
  if (isHomeEmptySlotId(itemId)) {
    return `<span class="sea-drop-slot sea-layout-empty-slot" data-sea-empty-slot="${esc(itemId)}" aria-hidden="true"></span>`;
  }
  const custom = options.customItems?.[itemId];
  if (custom) {
    return customWidgetCardHtml(custom, { editable: true, movable: true });
  }
  // 海主题卡片组件不进图标网格
  if (isSeaLooseBuiltinId(itemId) || isHomeGridBuiltinId(itemId)) return '';
  return renderAppItem(itemId, prefs, theme, options);
}

function renderSlot(field, value, hintText, extraHintStyle = '') {
  const filled = !!value;
  return `
    <div class="sea-slot ${filled ? '' : 'empty'}" data-sea-slot="${esc(field)}">
      ${filled ? `<img src="${esc(value)}" alt="">` : `<span class="hint"${extraHintStyle ? ` style="${extraHintStyle}"` : ''}>${esc(hintText)}</span>`}
      <input type="file" accept="image/*" data-sea-slot-file="${esc(field)}" hidden>
    </div>`;
}

function editable(field, value, placeholder, extraClass = '') {
  return `<span class="sea-editable ${extraClass}" contenteditable="true" data-sea-field="${esc(field)}" data-placeholder="${esc(placeholder)}">${esc(value)}</span>`;
}

export function musicInnerHtml(ms) {
  const track = ms.track || {};
  const hasTrack = !!(ms.trackId || track.title);
  const title = track.title || (hasTrack ? '未知曲目' : '未在播放');
  const artist = track.artist || (hasTrack ? 'Marshmallow Sea' : '点这里去音乐模块');
  const pct = ms.durationMs ? Math.min(1, ms.positionMs / ms.durationMs) : 0;
  const nowTag = ms.isPlaying ? '<span class="now">♪ 正在播放</span>' : (hasTrack ? '<span class="now">已暂停</span>' : '');
  const cover = normalizeRemoteCoverUrl(track.coverUrl);
  const discStyle = cover ? ` style="background-image:url('${esc(cover)}')"` : '';
  return `
    <div class="info">
      <div class="t">${nowTag}${esc(title)}</div>
      <div class="a">${esc(artist)}</div>
      <div class="bar"><i style="transform:scaleX(${pct.toFixed(3)})"></i></div>
    </div>
    <div class="disc ${ms.isPlaying ? 'playing' : ''}"${discStyle}></div>`;
}

export default async function renderSeaHome(container) {
  const prefs = await loadAppearancePrefs();
  const { theme } = getActiveTheme(prefs);
  await preloadHomeWallpapers(theme);
  disposeHomeBindings(container);
  const layout = ensureSeaLooseBuiltins(
    normalizeHomeLayout(theme.homeLayout, theme.widgetVisibility),
    theme,
  );
  const appPages = getLayoutAppPages(layout);
  const pageGridItems = appPages.map((_, index) => getLayoutPageGridItems(layout, index));
  const [page1Items = [], page2Items = [], page3Items = []] = pageGridItems;
  const extraPages = pageGridItems.slice(3);
  const dockApps = layout.dock;
  const profile = await getCurrentUser().catch(() => null);
  const appBadges = {};
  const widgets = (theme && theme.widgets) || {};
  const pageHasCustom = (i) => (layout.pages[i] || []).some((id) => layout.customItems?.[id]);
  const val = (k) => (widgets[k] != null && widgets[k] !== '' ? widgets[k] : (DEFAULTS[k] || ''));
  const img = (k) => (typeof widgets[k] === 'string' ? widgets[k] : '');
  const show = (key) => isWidgetVisible(theme, key);
  const showHero = show('seaHero');
  const showPortrait = show('seaPortrait');
  const showMusicP1 = show('seaMusicP1');
  const showMusicP2 = show('seaMusicP2');
  const showCharGallery = show('seaCharGallery');
  const showFloatNote = show('seaFloatNote') && isAnchoredBuiltin(layout, 1, 'seaFloatNote');
  const showAtmo = show('seaAtmo');
  const showStreaks = show('seaStreaks') && isAnchoredBuiltin(layout, 2, 'seaStreaks');
  const showPolaroid = show('seaPolaroid') && isAnchoredBuiltin(layout, 2, 'seaPolaroid');
  const showPostcard = show('seaPostcard') && isAnchoredBuiltin(layout, 2, 'seaPostcard');
  const ambientClasses = [
    'sea-page',
    'sea-ambient',
    (!showHero || !showPortrait) ? 'is-open-layout' : '',
    (!showHero && !showPortrait) ? 'is-apps-first' : '',
    !showMusicP1 ? 'is-no-music' : '',
  ].filter(Boolean).join(' ');
  const pageTwoClasses = [
    'sea-page',
    'sea-page-two',
    !showMusicP2 ? 'is-no-music' : '',
  ].filter(Boolean).join(' ');
  const pageThreeClasses = [
    'sea-page',
    'sea-page-three',
    (!showAtmo || !showStreaks || !showPolaroid || !showPostcard) ? 'is-open-layout' : '',
    !showPostcard ? 'is-no-postcard' : '',
  ].filter(Boolean).join(' ');
  let streaks = Array.isArray(widgets.seaStreaks) && widgets.seaStreaks.length ? widgets.seaStreaks : DEFAULT_STREAKS;
  const builtinCtx = {
    editable,
    val,
    img,
    renderSlot,
    streaks,
  };
  const gridOpts = { badges: appBadges, customItems: layout.customItems };

  const now = await getHomeWorldDate(profile?.id).catch(() => new Date());
  const di = dayOfYearInfo(now);

  container.className = 'page home-sea-shell';
  // 壁纸只走 crossfade 层，避免 shell 自身铺一张全局底图后在 dock 下方露一条不随分页切换的色带。
  container.style.removeProperty('background-image');
  container.style.removeProperty('background-size');
  container.style.removeProperty('background-position');
  // 海主题顶/底渐变遮罩：强度与暖/冷色可在「美化设置 → 海主题渐变遮罩」调节。
  applySeaGradientOverlayToElement(container, theme);
  applySeaMusicColorsToElement(container, theme);

  container.innerHTML = `
    <div class="sea-wallpaper-layer" data-sea-wallpaper-layer aria-hidden="true"></div>
    <div class="sea-pages" data-sea-pages>
      ${appPages.length > 0 ? `
      <!-- 页1 · 氛围 -->
      <section class="${ambientClasses}" data-sea-page="0">
        ${(showHero || showPortrait) ? `<div class="sea-top-block">
          ${showHero ? `
          <div class="sea-date" data-sea-clock-date>${esc(formatDateUpper(now))}</div>
          <div class="sea-clock" data-sea-clock>${formatClock(now)}</div>
          <div class="sea-sub"><span class="gold-dot"></span>${editable('seaWeather', val('seaWeather'), '写点天气/心情')}</div>
          ` : ''}

          ${showPortrait ? `
          <div class="sea-portrait">
            <div class="sea-slot sea-portrait-avatar" data-sea-slot="seaPortraitAvatar" aria-label="上传头像">
              ${img('seaPortraitAvatar')
                ? `<img src="${esc(img('seaPortraitAvatar'))}" alt="">`
                : `<span class="sea-portrait-default">${SEA_PORTRAIT_SVG}</span>`}
              <input type="file" accept="image/*" data-sea-slot-file="seaPortraitAvatar" hidden>
            </div>
            <div class="sea-portrait-lines">
              ${editable('seaPortraitLine1', val('seaPortraitLine1'), '写一行字')}
              ${editable('seaPortraitLine2', val('seaPortraitLine2'), '再写一行')}
            </div>
          </div>
          ` : ''}
        </div>` : ''}

        <div class="sea-apps sea-apps-p1">
          ${page1Items.map((id) => renderSeaGridItem(id, prefs, theme, gridOpts)).join('')}
        </div>
        ${renderSeaLooseStrip(layout, 0, builtinCtx, show)}

        ${showMusicP1 ? `
        <div class="sea-glass sea-music" data-sea-music>
          ${musicInnerHtml(getMusicPlayerState())}
        </div>
        ` : ''}
      </section>
      ` : ''}

      ${appPages.length > 1 ? `
      <!-- 页2 · char 相册：左图标 + 右立绘固定构图；海风文案在下方中空位 -->
      <section class="${pageTwoClasses}" data-sea-page="1">
        <div class="sea-row stretch sea-p2-top ${showCharGallery ? '' : 'is-apps-only'}">
          <div class="sea-apps ${(showCharGallery && !pageHasCustom(1)) ? 'col2' : ''}" style="flex:1;">
            ${page2Items.map((id) => renderSeaGridItem(id, prefs, theme, gridOpts)).join('')}
          </div>
          ${showCharGallery ? `
          <div class="sea-card sea-photo-tall">
            ${renderSlot('seaCharTall', img('seaCharTall'), '上传 char 立绘')}
            <div class="cap">${editable('seaCharCaption', val('seaCharCaption'), '今天想见的人')}</div>
          </div>
          ` : ''}
        </div>

        ${showFloatNote ? `
        <div class="sea-p2-mid" data-sea-builtin="seaFloatNote" data-home-longpress-item="seaFloatNote">
          ${seaWidgetControls('seaFloatNote')}
          ${editable('seaP2FloatLine1', val('seaP2FloatLine1'), '写一句海主题文案', 'sea-p2-line-a')}
          ${editable('seaP2FloatLine2', val('seaP2FloatLine2'), '英文或诗句', 'sea-p2-line-b')}
          <div class="sea-p2-orb-wrap">
            ${renderSlot('seaP2Orb', img('seaP2Orb'), '上传')}
          </div>
        </div>
        ` : ''}
        ${renderSeaLooseStrip(layout, 1, builtinCtx, show)}

        ${showMusicP2 ? `
        <div class="sea-glass sea-music" data-sea-music>
          ${musicInnerHtml(getMusicPlayerState())}
        </div>
        ` : ''}
      </section>
      ` : ''}

      ${appPages.length > 2 ? `
      <!-- 页3 · 记录：顶卡 / 打卡+拍立得 / 明信片固定构图，不进图标网格 -->
      <section class="${pageThreeClasses}" data-sea-page="2">
        ${showAtmo ? `
        <div class="sea-card sea-atmo sea-atmo-compact">
          <div class="h">ATMOSPHERE <em>${editable('seaAtmoSub', val('seaAtmoSub'), '· 停泊在海边')}</em></div>
          <div class="big" data-sea-atmo-clock>${pad2(now.getHours())}:${pad2(now.getMinutes())}</div>
          <div class="d" data-sea-atmo-date>${esc(formatDateNice(now))}</div>
          <div class="prog"><span>YEAR</span><span class="bar"><i data-sea-year-progress style="transform:scaleX(${di.pct.toFixed(3)})"></i></span><span data-sea-year-remaining>${di.total - di.day} 天</span></div>
        </div>
        ` : ''}

        ${(showStreaks || showPolaroid) ? `<div class="sea-p3-mid ${showStreaks && showPolaroid ? '' : 'is-single'}">
          ${showStreaks ? `
          <div class="sea-streak-bars" data-sea-streaks data-sea-builtin="seaStreaks" data-home-longpress-item="seaStreaks">
            ${seaWidgetControls('seaStreaks')}
            ${streaks.map((s, i) => `
              <div class="sea-bar ${s.on ? 'on' : ''}" data-sea-streak-row="${i}">
                <span class="dot" data-sea-streak-dot="${i}"></span>
                ${editable('streak-label-' + i, s.label, '习惯', 'sea-bar-label')}
                ${editable('streak-value-' + i, s.value, '0 天', 'sea-bar-val')}
              </div>`).join('')}
          </div>
          ` : ''}
          ${showPolaroid ? `
          <div class="sea-card sea-p3-polaroid" data-sea-builtin="seaPolaroid" data-home-longpress-item="seaPolaroid">
            ${seaWidgetControls('seaPolaroid')}
            ${renderSlot('seaPolaroidFront', img('seaPolaroidFront'), '照片')}
            <div class="cap">${editable('seaPolaroidFrontCaption', val('seaPolaroidFrontCaption'), '我的小记')}</div>
          </div>
          ` : ''}
        </div>` : ''}

        ${showPostcard ? `
        <div class="sea-card sea-p3-postcard" data-sea-builtin="seaPostcard" data-home-longpress-item="seaPostcard">
          ${seaWidgetControls('seaPostcard')}
          <span class="sea-postcard-stamp" aria-hidden="true">✦</span>
          ${renderSlot('seaPostcard', img('seaPostcard'), '上传照片')}
          <div class="cap">${editable('seaPostcardCaption', val('seaPostcardCaption'), '来自海边的一页')}</div>
        </div>
        ` : ''}
        ${renderSeaLooseStrip(layout, 2, builtinCtx, show)}

        <div class="sea-apps sea-apps-p3">
          ${page3Items.map((id) => renderSeaGridItem(id, prefs, theme, gridOpts)).join('')}
        </div>
      </section>
      ` : ''}
      ${extraPages.map((items, i) => `
      <section class="sea-page sea-page-extra" data-sea-page="${i + 3}">
        <div class="sea-extra-head">分页 ${i + 4}</div>
        ${renderSeaLooseStrip(layout, i + 3, builtinCtx, show)}
        <div class="sea-apps sea-apps-extra">
          ${items.map((id) => renderSeaGridItem(id, prefs, theme, gridOpts)).join('')}
        </div>
      </section>`).join('')}
    </div>

    <div class="sea-edit-bar" data-sea-edit-bar hidden>
      <button type="button" class="sea-edit-btn" data-sea-edit-reset>复位</button>
      <button type="button" class="sea-edit-btn" data-sea-edit-clear>清空</button>
      <button type="button" class="sea-edit-btn" data-sea-edit-widget-library>组件库</button>
      <button type="button" class="sea-edit-btn" data-sea-edit-remove>删页</button>
      <button type="button" class="sea-edit-btn" data-sea-edit-add>＋页</button>
      <button type="button" class="sea-edit-btn primary" data-sea-edit-done>完成</button>
    </div>

    <div class="sea-bottom">
      <div class="sea-dots" data-sea-dots>${appPages.map((_, i) => `<i${i === 0 ? ' class="on"' : ''}></i>`).join('')}</div>
      <div class="sea-dock">
        ${dockApps.map((id) => renderAppItem(id, prefs, theme, { dock: true, badges: appBadges })).join('')}
      </div>
    </div>`;

  registerHomeCleanup(container, installHomeNativeDragGuard(container));
  hydrateHomeCustomIconFallbacks(container);
  hydrateCustomWidgets(container, layout.customItems, { userId: profile?.id });
  // 壁纸 crossfade 层：每个分页一张叠放的壁纸 slide，随滚动进度淡入淡出，单壁纸时完全无缝。
  // 不再给每个 .sea-page 单独铺 cover 背景（那会导致横滑时整张图硬切的拼贴感）。
  renderSeaWallpaperLayer(container, theme);

  bindSeaHome(container, {
    prefs,
    getStreaks: () => streaks,
    setStreaks: (next) => { streaks = next; },
    rerender: () => renderSeaHome(container),
    userId: profile?.id,
  });
  if (profile?.id) {
    const refreshTravelBadge = async () => {
      if (!document.body.contains(container)) {
        window.removeEventListener('travel-char-notifications', refreshTravelBadge);
        return;
      }
      // 动态加载：避免首页静态导入 travel-char 整条聊天上下文链
      const { listTravelCharNotifications } = await import('../core/travel-char.js');
      const count = (await listTravelCharNotifications(profile.id, { unreadOnly: true }).catch(() => [])).length;
      container.querySelectorAll('[data-sea-route]').forEach((btn) => {
        if (String(btn.getAttribute('data-app-id') || '').trim() !== 'travel-char') return;
        const old = btn.querySelector('.sea-app-badge');
        if (!count) {
          old?.remove();
          return;
        }
        const text = count > 99 ? '99+' : String(count);
        if (old) old.textContent = text;
        else btn.querySelector('.ic')?.insertAdjacentHTML('beforeend', `<span class="sea-app-badge">${esc(text)}</span>`);
      });
    };
    window.addEventListener('travel-char-notifications', refreshTravelBadge);
    registerHomeCleanup(container, () => {
      window.removeEventListener('travel-char-notifications', refreshTravelBadge);
    });
    bindChatUnreadIndicator(container, profile.id, registerHomeCleanup);
    bindMailboxUnreadIndicator(container, profile.id, registerHomeCleanup);
    if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(() => { refreshTravelBadge().catch(() => null); }, { timeout: 1200 });
    } else {
      setTimeout(() => { refreshTravelBadge().catch(() => null); }, 120);
    }
  }
}

// ──────────────────────────────────────────────────────────
// 壁纸 crossfade 层
// 单壁纸：一层 <img> 铺满，无 slide，横滑完全无缝。
// 多壁纸 / 分页自定义：每页一张 opaque slide（<img>），滚动时下层保持不透明、
//   上层淡入——避免旧实现「base 默认图 + 半透明 slide」透出默认壁纸、块状闪烁。
// 全景模式：base/slide 留空让 pano 透出；仅显式分页壁纸建 slide。
// 手账主题的「壁纸透明度」蒙版改为独立 overlay，不再画进 background-image。
// ──────────────────────────────────────────────────────────
const PAPER_FALLBACK = 'var(--bg-paper, #fbf6f0)';
const wpScrollRaf = new WeakMap();
const wallpaperDecodeCache = new Map();

function wallpaperUrls(theme) {
  const urls = new Set();
  const globalUrl = resolveWallpaperUrl(theme);
  if (globalUrl) urls.add(globalUrl);
  const pano = getHomePanorama(theme);
  if (pano?.src) urls.add(pano.src);
  const pageMap = theme?.homePageWallpapers;
  if (pageMap && typeof pageMap === 'object') {
    Object.values(pageMap).forEach((value) => {
      const url = String(value || '').trim();
      if (url && url !== WALLPAPER_NONE) urls.add(url);
    });
  }
  return [...urls];
}

function decodeWallpaper(url) {
  if (!url) return Promise.resolve();
  if (wallpaperDecodeCache.has(url)) return wallpaperDecodeCache.get(url);
  const promise = new Promise((resolve) => {
    const img = new Image();
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const timer = window.setTimeout(finish, 1200);
    img.onload = async () => {
      try {
        if (typeof img.decode === 'function') await img.decode();
      } catch (_) {
        // onload 已证明图片可用；个别 WebView 的 decode() 会错误拒绝。
      }
      window.clearTimeout(timer);
      finish();
    };
    img.onerror = () => {
      window.clearTimeout(timer);
      finish();
    };
    img.decoding = 'async';
    img.src = url;
  });
  wallpaperDecodeCache.set(url, promise);
  return promise;
}

/** 重建主屏前先把壁纸解码进浏览器缓存，避免新 DOM 首帧露底后再闪出图片。 */
export async function preloadHomeWallpapers(theme) {
  const urls = wallpaperUrls(theme);
  const pano = getHomePanorama(theme);
  const criticalUrl = pano?.src || resolveHomePageWallpaperUrl(theme, 1) || resolveWallpaperUrl(theme);
  if (criticalUrl) await decodeWallpaper(criticalUrl);
  const rest = urls.filter((url) => url !== criticalUrl);
  if (!rest.length) return;
  const warmRest = () => { rest.forEach((url) => { void decodeWallpaper(url); }); };
  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(warmRest, { timeout: 1500 });
  } else {
    window.setTimeout(warmRest, 180);
  }
}

function homeCleanupSet(container) {
  if (!container.__homeCleanupFns) container.__homeCleanupFns = new Set();
  return container.__homeCleanupFns;
}

export function registerHomeCleanup(container, cleanup) {
  if (typeof cleanup === 'function') homeCleanupSet(container).add(cleanup);
}

/** 主屏整页重绘前清掉旧 DOM 闭包留下的 interval / 订阅 / window 事件。 */
export function disposeHomeBindings(container) {
  const cleanups = container?.__homeCleanupFns;
  if (cleanups) {
    cleanups.forEach((cleanup) => {
      try { cleanup(); } catch (_) { /* noop */ }
    });
    cleanups.clear();
  }
  // 图槽 file input 可能已被挪到 #mm-file-input-host，innerHTML 清不掉，需一并移除。
  try {
    document.querySelectorAll('#mm-file-input-host input[data-sea-slot-file]').forEach((el) => el.remove());
  } catch (_) { /* noop */ }
}

// 读取「横图全景」配置：整张横图横跨 N 页、随滑动 1:1 平移，无缝拼成一张图。
function getHomePanorama(theme) {
  const p = theme && theme.homePanorama;
  if (p && typeof p === 'object' && p.src) {
    const pages = Math.max(2, Math.min(6, Math.round(Number(p.pages) || 3)));
    return { src: String(p.src), pages };
  }
  return null;
}

// 全景层：一条 (pages × 视口宽) 的长条贴整张横图，按滚动量整体平移，
// 让相邻页共享同一张连续图像，划过去严丝合缝无断层（设备无关，不预切图）。
function renderHomePanorama(container, pano) {
  let node = container.querySelector('[data-home-pano]');
  if (!pano) {
    if (node) node.remove();
    return;
  }
  if (!node) {
    node = document.createElement('div');
    node.className = 'home-pano-layer';
    node.setAttribute('data-home-pano', '1');
    node.setAttribute('aria-hidden', 'true');
    const strip = document.createElement('div');
    strip.className = 'home-pano-strip';
    strip.setAttribute('data-home-pano-strip', '1');
    // 全景也走 <img>：超长 data URL 在 Android 上比 background-image 稳，避免分块解码闪底。
    const img = document.createElement('img');
    img.className = 'home-wallpaper-img home-pano-img';
    img.alt = '';
    img.decoding = 'async';
    img.loading = 'eager';
    img.fetchPriority = 'high';
    img.draggable = false;
    img.setAttribute('aria-hidden', 'true');
    strip.appendChild(img);
    node.appendChild(strip);
    container.insertBefore(node, container.firstChild);
  }
  node.dataset.pages = String(pano.pages);
  const strip = node.querySelector('[data-home-pano-strip]');
  let img = strip && strip.querySelector('.home-pano-img');
  if (strip && !img) {
    img = document.createElement('img');
    img.className = 'home-wallpaper-img home-pano-img';
    img.alt = '';
    img.decoding = 'async';
    img.loading = 'eager';
    img.fetchPriority = 'high';
    img.draggable = false;
    img.setAttribute('aria-hidden', 'true');
    strip.appendChild(img);
  }
  const src = String(pano.src);
  if (img && img.getAttribute('src') !== src) {
    img.setAttribute('src', src);
    if (typeof img.decode === 'function') img.decode().catch(() => {});
  }
  if (strip) strip.style.removeProperty('background-image');
  // 立即按当前滚动量摆正，避免首帧 0 宽闪一下
  const pagesEl = getHomePagesScroller(container);
  if (pagesEl && pagesEl.clientWidth) {
    updateHomePanorama(container, pagesEl.scrollLeft, pagesEl.clientWidth);
  }
}

function getHomePagesScroller(container) {
  return container.querySelector('[data-sea-pages]') || container.querySelector('.home-pages-container');
}

export function rememberSeaHomePageBeforeNavigate(container) {
  const scroller = getHomePagesScroller(container);
  if (!scroller) return -1;
  const liveDots = container.querySelectorAll('[data-sea-dots] i');
  const width = scroller.clientWidth;
  const fromScroll = width > 1 ? Math.round(scroller.scrollLeft / width) : lastSeaPageIndex;
  const idx = Math.max(0, Math.min(Math.max(0, liveDots.length - 1), fromScroll));
  lastSeaPageIndex = idx;
  return idx;
}

function countHomePages(container) {
  const seaPages = container.querySelectorAll('[data-sea-pages] > .sea-page');
  if (seaPages.length) return seaPages.length;
  return container.querySelectorAll('.home-pages-container > .home-page').length || 1;
}

function getHomeWallpaperLayer(container) {
  return container.querySelector('[data-sea-wallpaper-layer], [data-home-wallpaper-layer]');
}

function updateHomePanorama(container, scrollLeft, pageWidth) {
  const node = container.querySelector('[data-home-pano]');
  if (!node || !pageWidth) return;
  const strip = node.querySelector('[data-home-pano-strip]');
  if (!strip) return;
  const pages = Math.max(2, Math.round(Number(node.dataset.pages) || 3));
  const stripWidth = Math.max(1, Math.round(pages * pageWidth));
  if (strip.dataset.panoWidth !== String(stripWidth)) {
    strip.dataset.panoWidth = String(stripWidth);
    strip.style.width = `${stripWidth}px`;
  }
  // 整像素 3D 平移能稳定落到合成层，避免横图在小数像素上反复重采样发虚/闪烁。
  const offset = -Math.round(scrollLeft);
  if (strip.dataset.panoOffset !== String(offset)) {
    strip.dataset.panoOffset = String(offset);
    strip.style.transform = `translate3d(${offset}px,0,0)`;
  }
}

function clearLayerBackgroundImage(layer) {
  layer.style.removeProperty('background-image');
  layer.style.removeProperty('background-size');
  layer.style.removeProperty('background-position');
  layer.style.removeProperty('background');
}

function ensureWallpaperImg(host) {
  let img = host.querySelector(':scope > .home-wallpaper-img');
  if (!img) {
    img = document.createElement('img');
    img.className = 'home-wallpaper-img';
    img.alt = '';
    img.decoding = 'async';
    img.setAttribute('aria-hidden', 'true');
    host.insertBefore(img, host.firstChild);
  }
  return img;
}

function setWallpaperImgSrc(img, url) {
  const next = String(url || '');
  if (img.getAttribute('src') === next) return;
  img.setAttribute('src', next);
  if (typeof img.decode === 'function') img.decode().catch(() => {});
}

function syncHandWallpaperOverlay(layer, alpha) {
  let overlay = layer.querySelector(':scope > .home-wallpaper-overlay');
  const a = Math.max(0, Math.min(1, Number(alpha) || 0));
  if (a <= 0.001) {
    if (overlay) overlay.remove();
    return;
  }
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.className = 'home-wallpaper-overlay';
    overlay.setAttribute('aria-hidden', 'true');
    layer.appendChild(overlay);
  }
  overlay.style.background = `rgba(251,246,240,${a})`;
}

function themeHasPageWallpapers(map) {
  if (!map || typeof map !== 'object') return false;
  return Object.keys(map).some((key) => String(map[key] != null ? map[key] : '').trim() !== '');
}

function ensureWallpaperSlide(layer, index) {
  let slide = layer.querySelector(`[data-sea-wp-slide="${index}"]`);
  if (slide) return slide;
  slide = document.createElement('div');
  slide.className = 'sea-wallpaper-slide';
  slide.setAttribute('data-sea-wp-slide', String(index));
  slide.style.opacity = '0';
  const overlay = layer.querySelector(':scope > .home-wallpaper-overlay');
  if (overlay) layer.insertBefore(slide, overlay);
  else layer.appendChild(slide);
  return slide;
}

function paintSlideContent(slide, mode, url) {
  if (mode === 'solid') {
    slide.style.background = PAPER_FALLBACK;
    slide.removeAttribute('data-wp-src');
    const img = slide.querySelector(':scope > .home-wallpaper-img');
    if (img) img.remove();
    return;
  }
  slide.style.removeProperty('background');
  const img = ensureWallpaperImg(slide);
  slide.setAttribute('data-wp-src', url);
  setWallpaperImgSrc(img, url);
}

export function renderSeaWallpaperLayer(container, theme) {
  const layer = getHomeWallpaperLayer(container);
  if (!layer) return;
  // 记住主题，动态新建/回收分页时无需再异步读 prefs。
  container.__homeWpTheme = theme;
  // 海/窗主题壁纸图原样渲染；手账主题沿用「壁纸透明度」蒙版。
  const alpha = container.classList.contains('home-shell-page')
    ? getWallpaperOverlayAlpha(theme)
    : 0;
  const pano = getHomePanorama(theme);
  // pano 与普通壁纸层是同级节点；三主题壁纸层默认都有不透明兜底色。
  // 全景启用时必须让这一层透出，否则横图已加载也会被整层底色完全盖住。
  layer.classList.toggle('has-home-pano', !!pano);
  renderHomePanorama(container, pano);
  const map = (theme && typeof theme.homePageWallpapers === 'object' && theme.homePageWallpapers) || {};
  const pageCount = countHomePages(container);
  const hasPageWp = themeHasPageWallpapers(map);

  clearLayerBackgroundImage(layer);

  // 单壁纸且无全景：一层 <img> 铺满即可，横滑零开销。
  if (!pano && !hasPageWp) {
    layer.querySelectorAll('[data-sea-wp-slide]').forEach((slide) => slide.remove());
    const globalUrl = resolveWallpaperUrl(theme);
    if (globalUrl) {
      const img = ensureWallpaperImg(layer);
      img.classList.add('home-wallpaper-img--base');
      setWallpaperImgSrc(img, globalUrl);
    } else {
      const img = layer.querySelector(':scope > .home-wallpaper-img--base, :scope > .home-wallpaper-img');
      if (img) img.remove();
    }
    syncHandWallpaperOverlay(layer, alpha);
    return;
  }

  // 多壁纸 / 全景：去掉单图 base，改用分页 slide。
  layer.querySelectorAll(':scope > .home-wallpaper-img').forEach((img) => img.remove());

  const keep = new Set();
  for (let i = 0; i < pageCount; i += 1) {
    const resolved = resolveHomePageWallpaperLayer(theme, i + 1, pano?.pages || 0);
    const { mode, url } = resolved;
    if (mode === 'panorama') continue;
    keep.add(String(i));
    const slide = ensureWallpaperSlide(layer, i);
    paintSlideContent(slide, mode, url);
  }

  layer.querySelectorAll('[data-sea-wp-slide]').forEach((slide) => {
    const idx = slide.getAttribute('data-sea-wp-slide');
    if (!keep.has(idx)) slide.remove();
  });

  syncHandWallpaperOverlay(layer, alpha);

  // 增量更新后立刻按当前滚动校正透明度，避免新建 slide 停在 opacity:0。
  const pagesEl = getHomePagesScroller(container);
  if (pagesEl && pagesEl.clientWidth) {
    updateSeaWallpaperCrossfade(container, pagesEl.scrollLeft, pagesEl.clientWidth);
  }
}

// 按滚动进度更新各 slide：下层页保持不透明，上层页淡入，避免半透明叠出底色/默认图。
export function updateSeaWallpaperCrossfade(container, scrollLeft, pageWidth) {
  const layer = getHomeWallpaperLayer(container);
  if (!layer) return;
  // 全景层随滚动平移（不依赖 slide，先于下面的早退处理）
  updateHomePanorama(container, scrollLeft, pageWidth);
  const slides = layer.querySelectorAll('[data-sea-wp-slide]');
  if (!slides.length || !pageWidth) return;
  const pos = Math.max(0, scrollLeft / pageWidth);
  const from = Math.floor(pos);
  const to = Math.ceil(pos);
  const t = pos - from;
  const hasToSlide = to !== from && !!layer.querySelector(`[data-sea-wp-slide="${to}"]`);
  slides.forEach((slide) => {
    const idx = Number(slide.getAttribute('data-sea-wp-slide')) || 0;
    let opacity = 0;
    if (to === from) {
      if (idx === from) opacity = 1;
    } else if (idx === from) {
      opacity = hasToSlide ? 1 : (1 - t);
    } else if (idx === to) {
      opacity = t;
    }
    slide.style.opacity = String(opacity);
  });
}

/** scroll 高频路径：合并到每帧最多一次，减轻主线程改 style 的压力。 */
export function scheduleSeaWallpaperCrossfade(container, scrollLeft, pageWidth) {
  let pending = wpScrollRaf.get(container);
  if (!pending) {
    pending = { raf: 0, scrollLeft: 0, pageWidth: 0 };
    wpScrollRaf.set(container, pending);
  }
  pending.scrollLeft = scrollLeft;
  pending.pageWidth = pageWidth;
  if (pending.raf) return;
  pending.raf = requestAnimationFrame(() => {
    pending.raf = 0;
    updateSeaWallpaperCrossfade(container, pending.scrollLeft, pending.pageWidth);
  });
}

export function bindSeaHome(container, options = {}) {
  let prefs = options.prefs && typeof options.prefs === 'object' ? options.prefs : {};
  const getStreaks = typeof options.getStreaks === 'function' ? options.getStreaks : () => [];
  const setStreaks = typeof options.setStreaks === 'function' ? options.setStreaks : () => {};
  const rerender = typeof options.rerender === 'function' ? options.rerender : () => renderSeaHome(container);
  const homeClockUserId = String(options.userId || '').trim();
  let navigating = false;
  let pageScrollGuard = null;

  function resetSeaNavLock() {
    navigating = false;
  }

  // Keep-Alive 恢复时 DOM 不会重新渲染，但 `hidden` 切换 + scroll-snap 会让移动端浏览器
  // 把横向分页重新吸附回第 0 页——挂起前后都强制把 scrollLeft 摆回记住的分页，双 rAF 等布局稳定。
  function restoreSeaPageScroll() {
    const scroller = getHomePagesScroller(container);
    const liveDots = container.querySelectorAll('[data-sea-dots] i');
    if (!scroller || !liveDots.length) return;
    // 模块级 lastSeaPageIndex 是权威来源（进 App 前会 pin）
    const restoreIndex = Math.min(liveDots.length - 1, Math.max(0, lastSeaPageIndex || 0));
    const width = scroller.clientWidth;
    if (!width) return;
    pageScrollGuard?.setAnchor(restoreIndex);
    scroller.scrollLeft = restoreIndex * width;
    liveDots.forEach((d, k) => d.classList.toggle('on', k === restoreIndex));
    updateSeaWallpaperCrossfade(container, scroller.scrollLeft, width);
  }

  /** 进 App 前锁住当前分页，避免 touchend + Keep-Alive 摘树把 scrollLeft 清零后误结算成 N-1 */
  function pinSeaPageBeforeNavigate() {
    const idx = rememberSeaHomePageBeforeNavigate(container);
    if (idx >= 0) pageScrollGuard?.setAnchor(idx);
  }

  let tickLiveChrome = null;

  const onRouteActivated = (ev) => {
    const detail = ev.detail || {};
    if (detail.container !== container || detail.path !== 'home') return;
    resetSeaNavLock();
    if (detail.resumed) {
      restoreSeaPageScroll();
      requestAnimationFrame(restoreSeaPageScroll);
      // Keep-Alive 恢复后立刻补一帧时钟/音乐（挂起期间定时器只跳过、不销毁）
      if (typeof tickLiveChrome === 'function') tickLiveChrome();
    }
  };
  window.addEventListener('marshmallow-route-activated', onRouteActivated);
  registerHomeCleanup(container, () => {
    window.removeEventListener('marshmallow-route-activated', onRouteActivated);
  });

  async function saveWidgets(patch) {
    const fresh = await loadAppearancePrefs();
    const active = getActiveTheme(fresh);
    const activeTheme = active.theme;
    await saveAppearancePrefs({
      ...fresh,
      themes: {
        ...fresh.themes,
        [active.id]: {
          ...activeTheme,
          widgets: { ...(activeTheme.widgets || {}), ...patch },
        },
      },
    });
  }

  // 导航：app 图标 + dock（编辑态不跳转，留给长按/拖拽）
  container.querySelectorAll('[data-sea-route]').forEach((btn) => {
    btn.addEventListener('pointerdown', () => {
      if (navigating || container.classList.contains('is-sea-editing')) return;
      if (isComingSoonApp(btn.getAttribute('data-app-id'))) return;
      if (isHomeAppGroup(btn.getAttribute('data-app-id'))) return;
      const route = String(btn.getAttribute('data-sea-route') || '').trim();
      if (route) prefetchRoute(route);
    });
    btn.addEventListener('click', async () => {
      if (navigating || container.classList.contains('is-sea-editing')) return;
      const appId = btn.getAttribute('data-app-id');
      if (isComingSoonApp(appId)) {
        const { showToast } = await import('../components/toast.js');
        showToast(`${getAppLabel(prefs, appId)} · 未来开发中，暂未开放`);
        return;
      }
      if (isHomeAppGroup(appId)) {
        const build = encodeURIComponent(String(globalThis.__MARSHMALLOW_BUILD__ || 'dev'));
        const { openAppGroupOverlay } = await import(`../components/app-group-overlay.js?v=${build}`);
        await openAppGroupOverlay(appId, { anchor: btn });
        return;
      }
      navigating = true;
      pinSeaPageBeforeNavigate();
      navigate(String(btn.getAttribute('data-sea-route') || 'tutorial'));
    });
  });

  // 分页指示点（分页数量会随新建/回收变化，滚动时实时查 dot）
  const pages = getHomePagesScroller(container);
  const dots = container.querySelectorAll('[data-sea-dots] i');
  let paintedDotIndex = -1;
  if (pages) {
    pages.addEventListener('scroll', () => {
      const i = Math.round(pages.scrollLeft / pages.clientWidth);
      if (i !== paintedDotIndex) {
        paintedDotIndex = i;
        container.querySelectorAll('[data-sea-dots] i').forEach((d, k) => d.classList.toggle('on', k === i));
      }
      scheduleSeaWallpaperCrossfade(container, pages.scrollLeft, pages.clientWidth);
    }, { passive: true });
    pageScrollGuard = installHomePagedScrollGuard(pages, '.sea-page, .sea-page-extra', {
      onSettled(index) {
        const liveDots = container.querySelectorAll('[data-sea-dots] i');
        lastSeaPageIndex = Math.min(liveDots.length - 1, Math.max(0, index));
      },
    });
    registerHomeCleanup(container, () => pageScrollGuard?.dispose?.());
    // 初始进度
    requestAnimationFrame(() => updateSeaWallpaperCrossfade(container, pages.scrollLeft, pages.clientWidth));
  }
  if (pages && dots.length && lastSeaPageIndex > 0) {
    restoreSeaPageScroll();
    requestAnimationFrame(restoreSeaPageScroll);
  }

  // ──────────────────────────────────────────────────────────
  // 图标长按编辑 + 插入挤开换位 + 动态分页（与默认手账 home.js 同源算法，海主题选择器）
  // ──────────────────────────────────────────────────────────
  let layoutPersistQueue = Promise.resolve();

  async function persistLayoutNow(nextLayout, nextVisibility, themePatch = {}) {
    const fresh = await loadAppearancePrefs();
    const active = getActiveTheme(fresh);
    const activeTheme = active.theme;
    const visibility = nextVisibility || activeTheme.widgetVisibility;
    const saved = await saveAppearancePrefs({
      ...fresh,
      themes: {
        ...fresh.themes,
        [active.id]: {
          ...activeTheme,
          ...themePatch,
          ...(nextVisibility ? { widgetVisibility: nextVisibility } : {}),
          homeLayout: normalizeHomeLayout(nextLayout, visibility),
        },
      },
    });
    prefs = saved;
  }

  function persistLayout(nextLayout, nextVisibility, themePatch = {}) {
    // 抬手保存与“完成”保存必须按触发顺序落库，避免旧快照后写覆盖新布局。
    const queued = layoutPersistQueue.catch(() => {}).then(() => (
      persistLayoutNow(nextLayout, nextVisibility, themePatch)
    ));
    layoutPersistQueue = queued;
    return queued;
  }

  async function waitForLayoutPersistence() {
    await layoutPersistQueue.catch(() => {});
  }

  function seaEditBar() { return container.querySelector('[data-sea-edit-bar]'); }
  function openEditMode() {
    const bar = seaEditBar();
    if (bar) bar.hidden = false;
    container.classList.add('is-sea-editing');
    ensureDropSlots();
    const removePage = bar?.querySelector('[data-sea-edit-remove]');
    if (removePage) removePage.disabled = seaPageEls().length <= 1;
  }
  function exitEditUi() {
    const bar = seaEditBar();
    if (bar) bar.hidden = true;
    clearTransientDropSlots();
    container.classList.remove('is-sea-editing');
  }
  async function closeEditMode({ rerender: shouldRerender = false, persist = true } = {}) {
    // 顶栏先即时收起，保存与重绘随后完成，避免“完成”像点不动。
    materializeDropSlotGaps();
    exitEditUi();
    await abortRealDrag();
    await waitForLayoutPersistence();
    if (persist) {
      pruneEmptyExtraPages();
      const fresh = await loadAppearancePrefs();
      const active = getActiveTheme(fresh);
      const current = normalizeHomeLayout(active.theme.homeLayout, active.theme.widgetVisibility);
      await persistLayout(deriveLayoutFromDom(current));
    }
    if (shouldRerender) rerender();
  }

  let holdTimer = 0;
  let pressedPointerId = null;
  let pressStartX = 0;
  let pressStartY = 0;
  let suppressNextClick = false;
  let drag = null;
  const LONG_PRESS_MOVE_TOLERANCE = 10;

  // iOS：长按拖拽的触摸序列在进入编辑态之前就已开始，编辑态才加的 touch-action
  // 对这根手指无效，pointermove.preventDefault() 也取消不了原生滚动；只有直接
  // 取消 touchmove 才能拦住向下拖时触发的整页下拉刷新。拖拽期间全量拦截。
  const blockNativeTouchDuringDrag = (e) => {
    if (drag) e.preventDefault();
  };

  function clearPendingPress(e) {
    if (e?.pointerId != null && pressedPointerId != null && e.pointerId !== pressedPointerId) return;
    window.clearTimeout(holdTimer);
    holdTimer = 0;
    if (e?.type === 'pointerup' || e?.type === 'pointercancel' || !e) {
      pressedPointerId = null;
    }
  }
  function cancelPendingPressOnMove(e) {
    if (!holdTimer || pressedPointerId == null || e.pointerId !== pressedPointerId) return;
    const dx = e.clientX - pressStartX;
    const dy = e.clientY - pressStartY;
    if ((dx * dx) + (dy * dy) <= LONG_PRESS_MOVE_TOLERANCE * LONG_PRESS_MOVE_TOLERANCE) return;
    window.clearTimeout(holdTimer);
    holdTimer = 0;
  }

  const sourceIsInDock = () => !!drag?.source?.closest('.sea-dock');
  const sourceIsCustomWidget = () => !!drag?.source?.matches?.('.home-custom-widget, .home-grid-builtin');
  const slotSelectorFor = (gridEl) => (gridEl?.matches?.('.sea-dock')
    ? '.sea-dock-ic[data-app-id]'
    : '.sea-app[data-app-id], .home-custom-widget[data-custom-widget-id], .home-grid-builtin[data-home-longpress-item]');
  const dropSlotSelector = '.sea-app[data-app-id], .home-custom-widget[data-custom-widget-id], .home-grid-builtin[data-home-longpress-item], .sea-drop-slot';

  function siblingSlots(gridEl) {
    if (!gridEl) return [];
    return Array.from(gridEl.querySelectorAll(slotSelectorFor(gridEl))).filter((el) => el !== drag.source);
  }
  function gridUnderPoint(x, y) {
    const dockEl = container.querySelector('.sea-dock');
    if (dockEl && !sourceIsCustomWidget()) {
      const r = dockEl.getBoundingClientRect();
      if (x >= r.left - 6 && x <= r.right + 6 && y >= r.top - 18 && y <= r.bottom + 18) return dockEl;
    }
    let hit = null;
    let bestWidgetOverlap = 0;
    const ghostRect = drag?.kind === 'widget' ? drag.ghost?.getBoundingClientRect?.() : null;
    container.querySelectorAll('[data-sea-pages] .sea-apps').forEach((g) => {
      const r = g.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return;
      if (ghostRect) {
        const overlapWidth = Math.max(0, Math.min(ghostRect.right, r.right + 6) - Math.max(ghostRect.left, r.left - 6));
        const overlapHeight = Math.max(0, Math.min(ghostRect.bottom, r.bottom + 44) - Math.max(ghostRect.top, r.top - 28));
        const overlap = overlapWidth * overlapHeight;
        if (overlap > bestWidgetOverlap) {
          bestWidgetOverlap = overlap;
          hit = g;
        }
        return;
      }
      if (x >= r.left - 6 && x <= r.right + 6 && y >= r.top - 28 && y <= r.bottom + 44) hit = g;
    });
    return hit;
  }
  function clearTransientDropSlots() {
    container.querySelectorAll('.sea-drop-slot[data-transient-drop-slot]').forEach((el) => el.remove());
  }
  function materializeDropSlotGaps() {
    container.querySelectorAll('.sea-page .sea-apps').forEach((grid) => {
      const children = Array.from(grid.children);
      let lastContentIndex = -1;
      children.forEach((el, index) => {
        if (!el.matches?.('.sea-drop-slot[data-transient-drop-slot]')) lastContentIndex = index;
      });
      children.forEach((el, index) => {
        if (index > lastContentIndex || !el.matches?.('.sea-drop-slot[data-transient-drop-slot]')) return;
        el.removeAttribute('data-transient-drop-slot');
        el.setAttribute('data-sea-empty-slot', createHomeEmptySlotId());
      });
    });
  }
  function gridCellWeight(el) {
    if (!el || el.matches?.('[data-transient-drop-slot]')) return 0;
    if (el.matches?.('.home-custom-widget, .home-grid-builtin')) {
      const cols = Math.max(1, Number(el.getAttribute('data-widget-cols')) || 1);
      const rows = Math.max(1, Number(el.getAttribute('data-widget-rows')) || 1);
      return cols * rows;
    }
    if (el.matches?.('.sea-app[data-app-id], .sea-drop-slot')) return 1;
    return 0;
  }
  function ensureDropSlots() {
    clearTransientDropSlots();
    container.querySelectorAll('[data-sea-pages] .sea-apps').forEach((grid) => {
      const cols = gridColumnCount(grid);
      const minimum = cols * 5;
      const occupied = Array.from(grid.children).reduce((sum, el) => sum + gridCellWeight(el), 0);
      const count = Math.max(0, minimum - occupied);
      for (let i = 0; i < count; i += 1) {
        const slot = document.createElement('span');
        slot.className = 'sea-drop-slot';
        slot.setAttribute('data-transient-drop-slot', '1');
        slot.setAttribute('aria-hidden', 'true');
        grid.appendChild(slot);
      }
    });
  }
  function slotUnderPoint(gridEl, x, y) {
    const selector = gridEl?.matches?.('.sea-dock') ? slotSelectorFor(gridEl) : dropSlotSelector;
    const items = Array.from(gridEl.querySelectorAll(selector));
    for (let i = 0; i < items.length; i += 1) {
      const r = items[i].getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return items[i];
    }
    return null;
  }
  function nextSlotAfter(el) {
    let node = el.nextElementSibling;
    const selector = slotSelectorFor(el?.parentElement);
    while (node && (node === drag.source || !node.matches(selector))) node = node.nextElementSibling;
    return node || null;
  }
  function gridColumnCount(gridEl) {
    if (!gridEl || gridEl.matches?.('.sea-dock')) return 1;
    const columns = String(window.getComputedStyle(gridEl).gridTemplateColumns || '')
      .split(/\s+/)
      .filter((item) => item && item !== 'none');
    return Math.max(1, columns.length || 4);
  }
  function emptyGridRefFromPoint(gridEl, x, y) {
    if (!gridEl || gridEl.matches?.('.sea-dock')) return null;
    const items = Array.from(gridEl.querySelectorAll(dropSlotSelector)).filter((el) => el !== drag.source);
    if (!items.length) return null;
    const rect = gridEl.getBoundingClientRect();
    const first = items[0].getBoundingClientRect();
    const style = window.getComputedStyle(gridEl);
    const cols = gridColumnCount(gridEl);
    const colWidth = Math.max(1, rect.width / cols);
    const rowGap = Number.parseFloat(style.rowGap || style.gap || '0') || 0;
    const rowHeight = Math.max(1, first.height + rowGap);
    const col = Math.max(0, Math.min(cols - 1, Math.floor((x - rect.left) / colWidth)));
    const row = Math.max(0, Math.floor((y - rect.top) / rowHeight));
    const index = row * cols + col;
    return items[index] || null;
  }
  function widgetPlacementFor(gridEl) {
    if (!drag?.ghost || !gridEl || gridEl.matches?.('.sea-dock')) return null;
    const gridRect = gridEl.getBoundingClientRect();
    const ghostRect = drag.ghost.getBoundingClientRect();
    const style = window.getComputedStyle(gridEl);
    const cols = gridColumnCount(gridEl);
    const spanCols = Math.max(1, Math.min(cols, Number(drag.source.getAttribute('data-widget-cols')) || 1));
    const spanRows = Math.max(1, Number(drag.source.getAttribute('data-widget-rows')) || 1);
    const colGap = Number.parseFloat(style.columnGap || style.gap || '0') || 0;
    const rowGap = Number.parseFloat(style.rowGap || style.gap || '0') || 0;
    const colSize = Math.max(1, (gridRect.width - colGap * (cols - 1)) / cols);
    const rowSize = Math.max(1, Number.parseFloat(style.getPropertyValue('--mm-widget-grid-row-size')) || 78);
    const colStep = colSize + colGap;
    const rowStep = rowSize + rowGap;
    const col = Math.max(0, Math.min(cols - spanCols, Math.round((ghostRect.left - gridRect.left) / colStep)));
    const row = Math.max(0, Math.round((ghostRect.top - gridRect.top) / rowStep));
    const page = seaPageEls().indexOf(gridEl.closest('.sea-page'));
    return {
      col,
      row,
      key: `${page}:${col}:${row}`,
      left: gridRect.left + col * colStep,
      top: gridRect.top + row * rowStep,
      right: gridRect.left + col * colStep + spanCols * colSize + (spanCols - 1) * colGap,
      bottom: gridRect.top + row * rowStep + spanRows * rowSize + (spanRows - 1) * rowGap,
    };
  }
  function flipReorder(targetGrid, mutate) {
    const movers = siblingSlots(targetGrid).map((el) => [el, el.getBoundingClientRect()]);
    const prevGrid = drag.source.parentElement;
    if (prevGrid && prevGrid !== targetGrid) {
      siblingSlots(prevGrid).forEach((el) => movers.push([el, el.getBoundingClientRect()]));
    }
    mutate();
    movers.forEach(([el, first]) => {
      const last = el.getBoundingClientRect();
      const dx = first.left - last.left;
      const dy = first.top - last.top;
      if (!dx && !dy) return;
      el.style.transition = 'none';
      el.style.transform = `translate(${dx}px, ${dy}px)`;
      requestAnimationFrame(() => {
        el.style.transition = 'transform 0.18s ease';
        el.style.transform = '';
      });
    });
  }
  function currentNextSlot() {
    let n = drag.source.nextElementSibling;
    const selector = slotSelectorFor(drag.source.parentElement);
    while (n && !n.matches(selector) && !n.matches('.sea-drop-slot')) n = n.nextElementSibling;
    return n;
  }

  function setSeaItemDockPresentation(item, inDock) {
    if (!item) return;
    const isWindow = container.classList.contains('home-window-shell');
    item.classList.toggle('sea-dock-ic', inDock);
    item.classList.toggle('sea-app', !inDock);
    item.classList.toggle('mw-dock-ic', inDock && isWindow);
    item.classList.toggle('mw-app', !inDock && isWindow);
    const label = item.querySelector('.lb');
    if (inDock) {
      label?.remove();
    } else if (!label) {
      const nextLabel = document.createElement('span');
      nextLabel.className = 'lb';
      nextLabel.textContent = item.getAttribute('aria-label') || item.getAttribute('data-app-id') || '';
      item.appendChild(nextLabel);
    }
  }

  function swapAcrossDock(target) {
    const source = drag?.source;
    if (!source || !target || source === target) return;
    const sourceParent = source.parentElement;
    const targetParent = target.parentElement;
    if (!sourceParent || !targetParent || sourceParent === targetParent) return;
    const sourceMarker = document.createComment('sea-dock-source');
    const targetMarker = document.createComment('sea-dock-target');
    sourceParent.insertBefore(sourceMarker, source);
    targetParent.insertBefore(targetMarker, target);
    sourceMarker.replaceWith(target);
    targetMarker.replaceWith(source);
    setSeaItemDockPresentation(source, !!source.closest('.sea-dock'));
    setSeaItemDockPresentation(target, !!target.closest('.sea-dock'));
    drag.dock = sourceIsInDock();
  }

  function swapSourceWithTarget(gridEl, target) {
    const source = drag?.source;
    if (!source || !target || source === target) return;
    const sourceParent = source.parentElement;
    const targetParent = target.parentElement;
    if (!sourceParent || !targetParent) return;
    flipReorder(gridEl, () => {
      const sourceMarker = document.createComment('sea-grid-source');
      const targetMarker = document.createComment('sea-grid-target');
      sourceParent.insertBefore(sourceMarker, source);
      targetParent.insertBefore(targetMarker, target);
      sourceMarker.replaceWith(target);
      targetMarker.replaceWith(source);
    });
  }
  function moveSourceTo(gridEl, ref) {
    if (ref === drag.source) return;
    if (drag.source.nextElementSibling === ref) return;
    if (drag.source.parentElement === gridEl && currentNextSlot() === ref) return;
    flipReorder(gridEl, () => {
      if (ref) gridEl.insertBefore(drag.source, ref);
      else {
        const firstDrop = gridEl.querySelector('.sea-drop-slot');
        if (firstDrop) gridEl.insertBefore(drag.source, firstDrop);
        else gridEl.appendChild(drag.source);
      }
    });
  }

  function moveSourceIntoDropSlot(gridEl, slot) {
    if (!slot || slot === drag.source) return;
    const source = drag.source;
    const sourceParent = source.parentElement;
    const slotParent = slot.parentElement;
    if (!sourceParent || !slotParent) return;
    if (sourceParent === slotParent && source.nextElementSibling === slot) {
      flipReorder(gridEl, () => sourceParent.insertBefore(slot, source));
      return;
    }
    if (sourceParent === slotParent && slot.nextElementSibling === source) {
      flipReorder(gridEl, () => sourceParent.insertBefore(source, slot));
      return;
    }
    flipReorder(gridEl, () => {
      const marker = document.createComment('sea-drop-swap');
      sourceParent.insertBefore(marker, source);
      slotParent.insertBefore(source, slot);
      marker.parentNode.insertBefore(slot, marker);
      marker.remove();
    });
  }
  function moveWidgetToPlacement(gridEl, placement) {
    if (!placement || drag.lastWidgetPlacement === placement.key) return;
    const source = drag.source;
    const sourceParent = source.parentElement;
    if (!sourceParent) return;
    const candidates = Array.from(gridEl.querySelectorAll(dropSlotSelector)).filter((el) => el !== source);
    const conflicts = candidates.filter((el) => {
      const r = el.getBoundingClientRect();
      return r.right > placement.left + 3
        && r.left < placement.right - 3
        && r.bottom > placement.top + 3
        && r.top < placement.bottom - 3;
    });
    if (!conflicts.length) return;
    drag.lastWidgetPlacement = placement.key;
    const target = conflicts[0];
    flipReorder(gridEl, () => {
      const marker = document.createComment('sea-widget-origin');
      sourceParent.insertBefore(marker, source);
      gridEl.insertBefore(source, target);
      conflicts.forEach((el) => marker.parentNode?.insertBefore(el, marker));
      marker.remove();
    });
  }
  const CROSS_PAGE_DROP_DWELL_MS = 280;
  const TARGET_DROP_DWELL_MS = 120;
  function pointerInPagingBand(x) {
    if (!pages || sourceIsInDock()) return false;
    const rect = pages.getBoundingClientRect();
    return x > rect.right - 24 || x < rect.left + 24;
  }
  function pageIndexForGrid(gridEl) {
    return seaPageEls().indexOf(gridEl?.closest?.('.sea-page'));
  }
  function resetDropIntent() {
    if (!drag) return;
    drag.crossPageCandidate = -1;
    drag.crossPageSince = 0;
    drag.hoverTarget = null;
    drag.hoverSince = 0;
  }
  function crossPageDropReady(gridEl, force) {
    if (force || sourceIsInDock() || gridEl.matches?.('.sea-dock')) return true;
    const sourcePage = pageIndexForGrid(drag.source.closest('.sea-apps'));
    const targetPage = pageIndexForGrid(gridEl);
    if (sourcePage < 0 || targetPage < 0 || sourcePage === targetPage) {
      drag.crossPageCandidate = -1;
      drag.crossPageSince = 0;
      return true;
    }
    const now = performance.now();
    if (drag.crossPageCandidate !== targetPage) {
      drag.crossPageCandidate = targetPage;
      drag.crossPageSince = now;
      drag.hoverTarget = null;
      return false;
    }
    return now - drag.crossPageSince >= CROSS_PAGE_DROP_DWELL_MS;
  }
  function targetDropReady(target, force) {
    if (force || !target || target.matches?.('.sea-drop-slot')) return true;
    const now = performance.now();
    if (drag.hoverTarget !== target) {
      drag.hoverTarget = target;
      drag.hoverSince = now;
      return false;
    }
    return now - drag.hoverSince >= TARGET_DROP_DWELL_MS;
  }
  function reorderToPoint(x, y, { force = false } = {}) {
    if (!drag) return;
    if (!force && pointerInPagingBand(x)) {
      resetDropIntent();
      return;
    }
    const gridEl = gridUnderPoint(x, y);
    if (!gridEl) return;
    const over = slotUnderPoint(gridEl, x, y);
    const targetIsDock = !!gridEl.matches?.('.sea-dock');
    // 自定义组件不进 Dock；Dock 图标也不和图标网格外的组件互换
    if (sourceIsCustomWidget() && targetIsDock) return;
    if (sourceIsInDock() && over?.matches?.('.home-custom-widget, .home-grid-builtin')) return;
    const pageReady = crossPageDropReady(gridEl, force);
    const targetReady = targetDropReady(over, force);
    if (!pageReady || !targetReady) return;
    if (sourceIsCustomWidget() && !targetIsDock) {
      moveWidgetToPlacement(gridEl, widgetPlacementFor(gridEl));
      return;
    }
    if (sourceIsInDock() !== targetIsDock) {
      if (over && !over.matches('.sea-drop-slot') && !over.matches('.home-custom-widget, .home-grid-builtin')) swapAcrossDock(over);
      return;
    }
    if (over === drag.source) return;
    if (over) {
      if (over.matches('.sea-drop-slot') || over.matches('.home-custom-widget') || over.matches('.sea-app') || drag.source.matches('.home-custom-widget')) {
        if (over.matches('.sea-drop-slot') || over.matches('.home-custom-widget, .home-grid-builtin') || drag.source.matches('.home-custom-widget, .home-grid-builtin')) {
          moveSourceIntoDropSlot(gridEl, over);
          return;
        }
      }
      // App 图标只与命中的目标交换，避免插入排序牵动中间整段图标。
      swapSourceWithTarget(gridEl, over);
      return;
    }
    const rest = siblingSlots(gridEl);
    if (!rest.length) { moveSourceTo(gridEl, null); return; }
    const emptyRef = emptyGridRefFromPoint(gridEl, x, y);
    if (emptyRef) {
      if (emptyRef.matches('.sea-drop-slot') || emptyRef.matches('.home-custom-widget, .home-grid-builtin')) moveSourceIntoDropSlot(gridEl, emptyRef);
      else swapSourceWithTarget(gridEl, emptyRef);
      return;
    }
    const last = rest[rest.length - 1].getBoundingClientRect();
    if (y > last.bottom || (y >= last.top && x > last.right)) moveSourceTo(gridEl, null);
  }

  function seaPageEls() { return Array.from(container.querySelectorAll('[data-sea-pages] > .sea-page')); }
  function setDotCount(n) {
    const row = container.querySelector('[data-sea-dots]');
    if (!row) return;
    let cur = row.querySelectorAll('i').length;
    while (cur < n) { row.appendChild(document.createElement('i')); cur += 1; }
    while (cur > n && row.lastElementChild) { row.lastElementChild.remove(); cur -= 1; }
  }
  function appendExtraPage() {
    const count = seaPageEls().length;
    if (count >= MAX_HOME_PAGES) return null;
    const wrap = container.querySelector('[data-sea-pages]');
    if (!wrap) return null;
    const pageEl = document.createElement('section');
    pageEl.className = 'sea-page sea-page-extra';
    pageEl.setAttribute('data-sea-page', String(count));
    const head = document.createElement('div');
    head.className = 'sea-extra-head';
    head.textContent = `分页 ${count + 1}`;
    const grid = document.createElement('div');
    grid.className = 'sea-apps sea-apps-extra';
    pageEl.appendChild(head);
    pageEl.appendChild(grid);
    wrap.appendChild(pageEl);
    if (container.classList.contains('is-sea-editing')) ensureDropSlots();
    setDotCount(count + 1);
    renderSeaWallpaperLayer(container, container.__homeWpTheme || {});
    return pageEl;
  }
  function pruneEmptyExtraPages() {
    const els = seaPageEls();
    for (let i = els.length - 1; i >= 1; i -= 1) {
      const grid = els[i].querySelector('.sea-apps');
      if (grid && (grid.querySelector('.sea-app[data-app-id]') || grid.querySelector('.home-custom-widget') || grid.querySelector('.home-grid-builtin'))) break;
      els[i].remove();
    }
    setDotCount(seaPageEls().length);
    renderSeaWallpaperLayer(container, container.__homeWpTheme || {});
    if (pages) {
      const w = pages.clientWidth || 1;
      const maxIndex = seaPageEls().length - 1;
      const idx = Math.max(0, Math.min(maxIndex, Math.round(pages.scrollLeft / w)));
      pageScrollGuard?.setAnchor(idx);
      pages.scrollTo({ left: idx * w });
      container.querySelectorAll('[data-sea-dots] i').forEach((d, i) => d.classList.toggle('on', i === idx));
      lastSeaPageIndex = idx;
      updateSeaWallpaperCrossfade(container, pages.scrollLeft, w);
    }
  }

  const autoPage = { dir: 0, timer: 0 };
  function cancelAutoPage() {
    if (autoPage.timer) window.clearTimeout(autoPage.timer);
    autoPage.timer = 0;
    autoPage.dir = 0;
  }
  function maybeAutoPage(x) {
    if (!pages || !drag || sourceIsInDock()) { cancelAutoPage(); return; }
    const rect = pages.getBoundingClientRect();
    const band = 24;
    let dir = 0;
    if (x > rect.right - band) dir = 1;
    else if (x < rect.left + band) dir = -1;
    if (!dir) { cancelAutoPage(); return; }
    if (autoPage.dir === dir && autoPage.timer) return;
    cancelAutoPage();
    autoPage.dir = dir;
    autoPage.timer = window.setTimeout(() => {
      autoPage.timer = 0;
      resetDropIntent();
      const pageWidth = pages.clientWidth || rect.width || 1;
      const cur = Math.round(pages.scrollLeft / pageWidth);
      const total = seaPageEls().length;
      if (dir > 0 && cur >= total - 1) {
        const lastGrid = seaPageEls()[total - 1]?.querySelector('.sea-apps');
        const lastApps = lastGrid
          ? Array.from(lastGrid.querySelectorAll('.sea-app[data-app-id]')).filter((el) => el !== drag.source)
          : [];
        if (lastApps.length && appendExtraPage()) {
          pageScrollGuard?.setAnchor(total);
          pages.scrollTo({ left: total * pageWidth, behavior: 'smooth' });
        }
        return;
      }
      const target = Math.max(0, Math.min(total - 1, cur + dir));
      if (target !== cur) {
        pageScrollGuard?.setAnchor(target);
        pages.scrollTo({ left: target * pageWidth, behavior: 'smooth' });
      }
    }, 520);
  }

  function deriveLayoutFromDom(current) {
    const nextPages = seaPageEls().map((pageEl, i) => {
      const skeletonIds = (current.pages[i] || []).filter((id) => BUILTIN_HOME_WIDGET_DEFS[id] && !isHomeGridBuiltinId(id));
      const grid = pageEl.querySelector('.sea-apps');
      const gridIds = grid ? Array.from(grid.children).map((el) => {
        if (el.matches('.home-custom-widget[data-custom-widget-id]')) {
          return String(el.getAttribute('data-custom-widget-id') || '').trim();
        }
        if (el.matches('.home-grid-builtin[data-home-longpress-item]')) {
          return String(el.getAttribute('data-home-longpress-item') || '').trim();
        }
        if (el.matches('.sea-app[data-app-id]')) {
          return String(el.getAttribute('data-app-id') || '').trim();
        }
        if (el.matches('.sea-drop-slot')) {
          if (el.hasAttribute('data-transient-drop-slot')) return '';
          return String(el.getAttribute('data-sea-empty-slot') || createHomeEmptySlotId()).trim();
        }
        return '';
      }).filter(Boolean) : [];
      while (gridIds.length && isHomeEmptySlotId(gridIds[gridIds.length - 1])) gridIds.pop();
      return [...skeletonIds, ...gridIds];
    });
    const dock = Array.from(container.querySelectorAll('.sea-dock .sea-dock-ic[data-app-id]'))
      .map((el) => String(el.getAttribute('data-app-id') || '').trim())
      .filter(Boolean);
    return { ...current, pages: nextPages, dock };
  }
  function clearReorderInlineStyles() {
    container.querySelectorAll('.sea-app, .sea-dock-ic, .home-custom-widget, .home-grid-builtin').forEach((el) => {
      el.style.transition = '';
      el.style.transform = '';
    });
  }

  async function abortRealDrag({ persist = false } = {}) {
    window.clearTimeout(holdTimer);
    if (!drag) return;
    const abandoned = drag;
    drag = null;
    container.removeEventListener('lostpointercapture', handleLostPointerCapture);
    try {
      if (container.hasPointerCapture?.(abandoned.pointerId)) {
        container.releasePointerCapture(abandoned.pointerId);
      }
    } catch (_) {}
    abandoned.source.classList.remove('is-real-dragging');
    abandoned.ghost?.remove();
    container.classList.remove('is-sea-reordering');
    cancelAutoPage();
    window.removeEventListener('pointermove', moveRealDrag);
    window.removeEventListener('pointerup', finishRealDrag);
    window.removeEventListener('pointercancel', cancelRealDrag);
    document.removeEventListener('touchmove', blockNativeTouchDuringDrag, true);
    clearReorderInlineStyles();
    if (persist) {
      pruneEmptyExtraPages();
      const fresh = await loadAppearancePrefs();
      const active = getActiveTheme(fresh);
      const current = normalizeHomeLayout(active.theme.homeLayout, active.theme.widgetVisibility);
      await persistLayout(deriveLayoutFromDom(current));
    }
  }

  function startRealDrag(source, e) {
    if (!container.classList.contains('is-sea-editing')) return;
    if (e.button != null && e.button !== 0) return;
    if (pressedPointerId !== e.pointerId) return;
    if (e.target.closest('[data-mm-widget-controls], .home-widget-controls')) return;
    window.clearTimeout(holdTimer);
    if (drag) void abortRealDrag();
    e.preventDefault();
    const rect = source.getBoundingClientRect();
    const ghost = source.cloneNode(true);
    ghost.classList.add('sea-real-drag-ghost');
    ghost.style.width = `${rect.width}px`;
    ghost.style.height = `${rect.height}px`;
    ghost.style.left = `${rect.left}px`;
    ghost.style.top = `${rect.top}px`;
    document.body.appendChild(ghost);
    drag = {
      source,
      ghost,
      dock: !!source.closest('.sea-dock'),
      kind: source.matches('.home-custom-widget, .home-grid-builtin') ? 'widget' : 'app',
      pointerId: e.pointerId,
      offsetX: e.clientX - rect.left,
      offsetY: e.clientY - rect.top,
      lastWidgetPlacement: '',
      crossPageCandidate: -1,
      crossPageSince: 0,
      hoverTarget: null,
      hoverSince: 0,
    };
    if (drag.kind === 'widget') {
      drag.lastWidgetPlacement = widgetPlacementFor(source.parentElement)?.key || '';
    }
    // 捕获必须挂在不会参与换位的稳定容器上。挂在 source 上时，拖进另一个格子
    // 的 insertBefore 会让 iOS 丢失/取消指针，随后误走“完成拖拽”并提交半成品。
    try { container.setPointerCapture?.(e.pointerId); } catch (_) {}
    container.addEventListener('lostpointercapture', handleLostPointerCapture);
    source.classList.add('is-real-dragging');
    container.classList.add('is-sea-reordering');
    window.addEventListener('pointermove', moveRealDrag, { passive: false });
    window.addEventListener('pointerup', finishRealDrag, { passive: false });
    window.addEventListener('pointercancel', cancelRealDrag, { passive: false });
    document.addEventListener('touchmove', blockNativeTouchDuringDrag, { capture: true, passive: false });
  }
  function moveRealDrag(e) {
    if (!drag) return;
    if (e.pointerId != null && e.pointerId !== drag.pointerId) return;
    e.preventDefault();
    drag.ghost.style.left = `${e.clientX - drag.offsetX}px`;
    drag.ghost.style.top = `${e.clientY - drag.offsetY}px`;
    maybeAutoPage(e.clientX);
    reorderToPoint(e.clientX, e.clientY);
  }
  function handleLostPointerCapture(e) {
    if (!drag || e.pointerId !== drag.pointerId || e.currentTarget !== container) return;
    try {
      container.setPointerCapture?.(drag.pointerId);
      return;
    } catch (_) {}
    void cancelRealDrag(e);
  }
  async function cancelRealDrag(e) {
    if (!drag) return;
    if (e?.pointerId != null && e.pointerId !== drag.pointerId) return;
    try { e?.preventDefault?.(); } catch (_) {}
    await abortRealDrag({ persist: false });
    // 丢失指针时从已保存布局重绘，撤销内存中的半成品换位。
    rerender();
  }
  async function finishRealDrag(e) {
    if (!drag) return;
    if (e.pointerId != null && e.pointerId !== drag.pointerId) return;
    e.preventDefault();
    reorderToPoint(e.clientX, e.clientY, { force: true });
    materializeDropSlotGaps();
    const finished = drag;
    drag = null;
    container.removeEventListener('lostpointercapture', handleLostPointerCapture);
    try {
      if (container.hasPointerCapture?.(finished.pointerId)) {
        container.releasePointerCapture(finished.pointerId);
      }
    } catch (_) {}
    finished.source.classList.remove('is-real-dragging');
    finished.ghost.remove();
    container.classList.remove('is-sea-reordering');
    cancelAutoPage();
    window.removeEventListener('pointermove', moveRealDrag);
    window.removeEventListener('pointerup', finishRealDrag);
    window.removeEventListener('pointercancel', cancelRealDrag);
    document.removeEventListener('touchmove', blockNativeTouchDuringDrag, true);
    clearReorderInlineStyles();
    pruneEmptyExtraPages();
    const fresh = await loadAppearancePrefs();
    const active = getActiveTheme(fresh);
    const current = normalizeHomeLayout(active.theme.homeLayout, active.theme.widgetVisibility);
    await persistLayout(deriveLayoutFromDom(current));
  }

  container.querySelectorAll('.sea-app[data-app-id], .sea-dock-ic[data-app-id], .sea-apps .home-custom-widget[data-custom-widget-id], .sea-apps .home-grid-builtin[data-home-longpress-item]').forEach((el) => {
    el.addEventListener('pointerdown', (e) => {
      if (e.target.closest('[data-mm-widget-controls], .home-widget-controls')) return;
      window.clearTimeout(holdTimer);
      pressedPointerId = e.pointerId;
      pressStartX = e.clientX;
      pressStartY = e.clientY;
      if (container.classList.contains('is-sea-editing')) {
        startRealDrag(el, e);
        return;
      }
      holdTimer = window.setTimeout(() => {
        holdTimer = 0;
        if (pressedPointerId !== e.pointerId) return;
        suppressNextClick = true;
        openEditMode();
        startRealDrag(el, e);
      }, 520);
    });
    el.addEventListener('pointerleave', () => {
      if (drag) return;
      window.clearTimeout(holdTimer);
      holdTimer = 0;
    });
  });
  window.addEventListener('pointerup', clearPendingPress, true);
  window.addEventListener('pointercancel', clearPendingPress, true);
  window.addEventListener('pointermove', cancelPendingPressOnMove, true);
  function abortDragOnInterruption() {
    clearPendingPress();
    // 原生滚动抢手势、切后台或系统中断时，DOM 可能正处在 FLIP 换位的中间态。
    // 绝不能把这个瞬时结构写回布局，否则下次重绘可能出现重复图标。
    if (drag) void abortRealDrag({ persist: false });
  }
  window.addEventListener('blur', abortDragOnInterruption);
  document.addEventListener('visibilitychange', abortDragOnInterruption);
  registerHomeCleanup(container, () => {
    window.removeEventListener('pointerup', clearPendingPress, true);
    window.removeEventListener('pointercancel', clearPendingPress, true);
    window.removeEventListener('pointermove', cancelPendingPressOnMove, true);
    window.removeEventListener('blur', abortDragOnInterruption);
    document.removeEventListener('visibilitychange', abortDragOnInterruption);
    void abortRealDrag();
  });
  container.addEventListener('click', (e) => {
    if (!suppressNextClick) return;
    e.preventDefault();
    e.stopPropagation();
    suppressNextClick = false;
  }, true);

  seaEditBar()?.querySelector('[data-sea-edit-done]')?.addEventListener('click', () => {
    void closeEditMode({ rerender: true });
  });
  seaEditBar()?.querySelector('[data-sea-edit-widget-library]')?.addEventListener('click', () => {
    void closeEditMode().then(() => navigate('beautify', { target: 'home', mode: 'widget' }));
  });
  seaEditBar()?.querySelector('[data-sea-edit-add]')?.addEventListener('click', () => {
    const created = appendExtraPage();
    if (!created || !pages) return;
    const total = seaPageEls().length;
    const targetIndex = total - 1;
    pageScrollGuard?.setAnchor(targetIndex);
    const go = () => pages.scrollTo({ left: targetIndex * (pages.clientWidth || 1), behavior: 'smooth' });
    go();
    requestAnimationFrame(go);
  });
  seaEditBar()?.querySelector('[data-sea-edit-remove]')?.addEventListener('click', async () => {
    const pageEls = seaPageEls();
    if (pageEls.length <= 1) {
      const { showToast } = await import('../components/toast.js');
      showToast('主屏至少保留一页');
      return;
    }
    const width = pages?.clientWidth || 1;
    const pageIndex = Math.max(0, Math.min(pageEls.length - 1, Math.round((pages?.scrollLeft || 0) / width)));
    if (!window.confirm(`删除第 ${pageIndex + 1} 页？本页内容会移到相邻页。`)) return;
    exitEditUi();
    const fresh = await loadAppearancePrefs();
    const active = getActiveTheme(fresh);
    const current = normalizeHomeLayout(active.theme.homeLayout, active.theme.widgetVisibility);
    const nextLayout = removeHomeLayoutPage(deriveLayoutFromDom(current), pageIndex);
    await persistLayout(nextLayout, null, {
      homePageWallpapers: removeHomePageWallpaper(active.theme.homePageWallpapers, pageIndex),
    });
    lastSeaPageIndex = Math.max(0, Math.min(pageIndex, nextLayout.pages.length - 1));
    void closeEditMode({ rerender: true, persist: false });
  });
  seaEditBar()?.querySelector('[data-sea-edit-reset]')?.addEventListener('click', async () => {
    if (!window.confirm('复位主屏布局？图标顺序和 Dock 会回到默认。')) return;
    exitEditUi();
    const fresh = await loadAppearancePrefs();
    const active = getActiveTheme(fresh);
    const current = normalizeHomeLayout(active.theme.homeLayout, active.theme.widgetVisibility);
    const fourthDecorId = isWindowHomeTheme(active.id, active.theme) ? 'windowFourthDecor' : 'seaFourthDecor';
    const placedCustomIds = current.pages.flat().filter((id) => current.customItems?.[id]);
    const resetPages = [PAGE_ONE_APPS.slice(), PAGE_TWO_APPS.slice(), PAGE_THREE_APPS.slice(), [fourthDecorId, ...PAGE_FOUR_APPS], PAGE_FIVE_APPS.slice()];
    if (placedCustomIds.length) resetPages[resetPages.length - 1].push(...placedCustomIds);
    await persistLayout({
      ...current,
      version: 6,
      pages: resetPages,
      dock: DOCK_APPS.slice(),
    });
    void closeEditMode({ rerender: true, persist: false });
  });
  // 清空布局：给想从零开始做主屏的用户一块白板——内置组件全隐藏、图标集中到最后一页
  seaEditBar()?.querySelector('[data-sea-edit-clear]')?.addEventListener('click', async () => {
    if (!window.confirm('清空主屏布局？内置组件会全部隐藏、App 图标集中到最后一页（Dock 保留），适合从零开始重新排版。想找回内置组件去「美化设置 → 主屏组件」。')) return;
    exitEditUi();
    const fresh = await loadAppearancePrefs();
    const active = getActiveTheme(fresh);
    const current = normalizeHomeLayout(active.theme.homeLayout, active.theme.widgetVisibility);
    const nextVisibility = { ...(active.theme.widgetVisibility || {}) };
    Object.keys(DEFAULT_WIDGET_VISIBILITY).forEach((key) => { nextVisibility[key] = false; });
    await persistLayout({
      ...current,
      pages: [current.pages.flat().filter((id) => current.customItems?.[id])],
    }, nextVisibility);
    void closeEditMode({ rerender: true, persist: false });
  });
  // 自定义组件：编辑模式里的删除与换页（同页位置靠拖动，跨页用 ◀▶）
  container.querySelectorAll('[data-real-remove]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const itemId = String(btn.getAttribute('data-real-remove') || '').trim();
      if (!itemId) return;
      const fresh = await loadAppearancePrefs();
      const active = getActiveTheme(fresh);
      const current = normalizeHomeLayout(active.theme.homeLayout, active.theme.widgetVisibility);
      const nextVisibility = { ...(active.theme.widgetVisibility || {}) };
      if (BUILTIN_HOME_WIDGET_DEFS[itemId]) nextVisibility[itemId] = false;
      await persistLayout({
        ...current,
        pages: current.pages.map((page) => page.filter((id) => id !== itemId)),
        dock: current.dock.filter((id) => id !== itemId),
      }, nextVisibility);
      if (current.customItems[itemId]) showToast('已移出当前主题，组件仍保留在组件库');
      void closeEditMode({ rerender: true, persist: false });
    });
  });
  container.querySelectorAll('[data-widget-move]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const [itemId, dirRaw] = String(btn.getAttribute('data-widget-move') || '').split(':');
      const dir = Number(dirRaw) || 0;
      if (!itemId || !dir) return;
      const fresh = await loadAppearancePrefs();
      const active = getActiveTheme(fresh);
      const current = normalizeHomeLayout(active.theme.homeLayout, active.theme.widgetVisibility);
      const fromIndex = current.pages.findIndex((page) => page.includes(itemId));
      if (fromIndex < 0) return;
      const toIndex = Math.max(0, Math.min(current.pages.length - 1, fromIndex + dir));
      if (toIndex === fromIndex) return;
      const pages = current.pages.map((page) => page.filter((id) => id !== itemId));
      pages[toIndex] = [itemId, ...pages[toIndex]];
      await persistLayout({ ...current, pages });
      lastSeaPageIndex = toIndex;
      rerender();
      // 挪完还在编辑模式里，方便连续调整
      requestAnimationFrame(() => {
        const bar = container.querySelector('[data-sea-edit-bar]');
        if (bar) bar.hidden = false;
        container.classList.add('is-sea-editing');
      });
    });
  });

  // 可编辑文字：失焦保存
  container.querySelectorAll('.sea-editable[data-sea-field]').forEach((el) => {
    el.addEventListener('blur', () => {
      const field = String(el.getAttribute('data-sea-field') || '');
      const text = el.textContent.trim();
      if (field.startsWith('streak-')) {
        const [, kind, idxStr] = field.split('-');
        const idx = Number(idxStr);
        const streaks = getStreaks().map((s) => ({ ...s }));
        if (streaks[idx]) {
          if (kind === 'label') streaks[idx].label = text;
          else streaks[idx].value = text;
          setStreaks(streaks);
          saveWidgets({ seaStreaks: streaks });
        }
        return;
      }
      saveWidgets({ [field]: text });
    });
    // 回车结束编辑
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
    });
  });

  // 打卡点：切换 on/off
  container.querySelectorAll('[data-sea-streak-dot]').forEach((dot) => {
    dot.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = Number(dot.getAttribute('data-sea-streak-dot'));
      const streaks = getStreaks().map((s) => ({ ...s }));
      if (!streaks[idx]) return;
      streaks[idx].on = !streaks[idx].on;
      setStreaks(streaks);
      const row = container.querySelector(`[data-sea-streak-row="${idx}"]`);
      if (row) row.classList.toggle('on', streaks[idx].on);
      saveWidgets({ seaStreaks: streaks });
    });
  });

  // 图片槽位：点按上传（无 × 清除按钮，再次点按可换图）
  // file input 可能被 open-file-picker 挪到 #mm-file-input-host，不能只在 slot 内查。
  container.querySelectorAll('[data-sea-slot]').forEach((slot) => {
    const field = String(slot.getAttribute('data-sea-slot') || '');
    const fieldSel = (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(field) : field.replace(/"/g, '\\"');
    const findSlotFileInput = () => (
      slot.querySelector('[data-sea-slot-file]')
      || document.querySelector(`#mm-file-input-host [data-sea-slot-file="${fieldSel}"]`)
      || document.querySelector(`[data-sea-slot-file="${fieldSel}"]`)
    );
    let fileInput = findSlotFileInput();
    slot.addEventListener('click', () => {
      fileInput = fileInput || findSlotFileInput();
      fileInput && fileInput.click();
    });
    if (fileInput) {
      fileInput.addEventListener('change', async () => {
        const file = fileInput.files && fileInput.files[0];
        if (!file) return;
        // PNG/WebP keep alpha so cutouts stay transparent after save/refresh.
        const preserveAlpha = /image\/(png|webp)/i.test(String(file.type || ''));
        const dataUrl = await compressFileToDataUrl(file, {
          maxSize: 1400,
          quality: 0.85,
          preserveAlpha,
        }).catch(() => '');
        fileInput.value = '';
        if (!dataUrl) return;
        slot.classList.remove('empty');
        const hint = slot.querySelector('.hint');
        if (hint) hint.remove();
        const portraitDefault = slot.querySelector('.sea-portrait-default');
        if (portraitDefault) portraitDefault.remove();
        let imgEl = slot.querySelector('img');
        if (!imgEl) {
          imgEl = document.createElement('img');
          slot.insertBefore(imgEl, slot.firstChild);
        }
        imgEl.src = dataUrl;
        await saveWidgets({ [field]: dataUrl });
      });
    }
  });

  // 时钟 + 音乐：实时刷新。
  // Keep-Alive 挂起会把页面从 document 摘掉（removeChild），不能当成销毁去 clearInterval/unsubscribe，
  // 否则回到主屏后时间停住、音乐 pill 也不再同步（看起来像纯装饰）。
  const clockEl = container.querySelector('[data-sea-clock]');
  const dateEl = container.querySelector('[data-sea-clock-date]');
  const atmoClock = container.querySelector('[data-sea-atmo-clock]');
  const atmoDate = container.querySelector('[data-sea-atmo-date]');
  const yearProgress = container.querySelector('[data-sea-year-progress]');
  const yearRemaining = container.querySelector('[data-sea-year-remaining]');
  const musicEls = container.querySelectorAll('[data-sea-music]');

  function refreshMusic() {
    if (!container.isConnected) return;
    const ms = getMusicPlayerState();
    musicEls.forEach((el) => {
      const track = ms.track || {};
      const hasTrack = !!(ms.trackId || track.title);
      const title = track.title || (hasTrack ? '未知曲目' : '未在播放');
      const artist = track.artist || (hasTrack ? 'Marshmallow Sea' : '点这里去音乐模块');
      const pct = ms.durationMs ? Math.min(1, ms.positionMs / ms.durationMs) : 0;
      const playing = !!ms.isPlaying;
      const cover = String(track.coverUrl || '').trim();
      // 曲目/封面变了才重建；进度与播放态定点改，避免每秒 innerHTML 把胶片旋转打断回 0°
      const trackKey = `${ms.trackId || ''}|${cover}|${hasTrack ? 1 : 0}`;
      let info = el.querySelector('.info');
      let disc = el.querySelector('.disc');
      if (!info || !disc || el.dataset.musicTrackKey !== trackKey) {
        el.innerHTML = musicInnerHtml(ms);
        el.dataset.musicTrackKey = trackKey;
        return;
      }
      const nowTag = playing
        ? '<span class="now">♪ 正在播放</span>'
        : (hasTrack ? '<span class="now">已暂停</span>' : '');
      const tEl = info.querySelector('.t');
      const aEl = info.querySelector('.a');
      const barI = info.querySelector('.bar > i');
      if (tEl) tEl.innerHTML = `${nowTag}${esc(title)}`;
      if (aEl) aEl.textContent = artist;
      if (barI) barI.style.transform = `scaleX(${pct.toFixed(3)})`;
      disc.classList.toggle('playing', playing);
    });
  }
  musicEls.forEach((el) => {
    el.addEventListener('click', async (e) => {
      if (container.classList.contains('is-sea-editing')) return;
      // 点曲名/进度区进音乐页；点唱片切播放/暂停（与窗主题黑胶卡一致）
      if (e.target.closest('.info')) {
        if (navigating) return;
        navigating = true;
        pinSeaPageBeforeNavigate();
        navigate('music');
        return;
      }
      if (e.target.closest('.disc') && hasMusicController()) {
        const ok = await commandTogglePlay().catch(() => false);
        if (ok) { refreshMusic(); return; }
      }
      if (navigating) return;
      navigating = true;
      pinSeaPageBeforeNavigate();
      navigate('music');
    });
  });

  let clockTickRunning = false;
  async function tickLiveChromeFn() {
    // 挂起中：跳过本帧，保留定时器与订阅，等 Keep-Alive 恢复后再画
    if (!container.isConnected || clockTickRunning) return;
    clockTickRunning = true;
    try {
      const d = await getHomeWorldDate(homeClockUserId).catch(() => new Date());
      if (!container.isConnected) return;
      if (clockEl) clockEl.innerHTML = formatClock(d);
      if (dateEl) dateEl.textContent = formatDateUpper(d);
      if (atmoClock) atmoClock.textContent = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
      if (atmoDate) atmoDate.textContent = formatDateNice(d);
      if (yearProgress || yearRemaining) {
        const info = dayOfYearInfo(d);
        if (yearProgress) yearProgress.style.transform = `scaleX(${info.pct.toFixed(3)})`;
        if (yearRemaining) yearRemaining.textContent = `${info.total - info.day} 天`;
      }
      refreshMusic();
    } finally {
      clockTickRunning = false;
    }
  }
  tickLiveChrome = tickLiveChromeFn;

  const unsubscribeMusic = subscribeMusicPlayer(() => refreshMusic());
  void tickLiveChromeFn();
  const liveChromeTimer = setInterval(() => { void tickLiveChromeFn(); }, 1000);
  const onTimeScheduleChanged = (event) => {
    const changedUserId = String(event.detail?.userId || '').trim();
    if (changedUserId && changedUserId !== homeClockUserId) return;
    void tickLiveChromeFn();
  };
  window.addEventListener(TIME_SCHEDULE_CHANGED_EVENT, onTimeScheduleChanged);
  registerHomeCleanup(container, () => {
    unsubscribeMusic();
    window.clearInterval(liveChromeTimer);
    window.removeEventListener(TIME_SCHEDULE_CHANGED_EVENT, onTimeScheduleChanged);
  });
}
