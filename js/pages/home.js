import { navigate } from '../core/router.js';
import { prefetchRoute } from '../core/route-prefetch.js';
import { getCurrentUser } from '../core/user-slot.js';
import { getUserDisplayName } from '../models/user.js';
import {
  loadAppearancePrefs,
  saveAppearancePrefs,
  getActiveTheme,
  getAppLabel,
  getWidgetValue,
  formatCalendarHeader,
  buildCalendarCells,
  isWidgetVisible,
  normalizeHomeLayout,
  BUILTIN_HOME_WIDGET_DEFS,
  getBuiltinHomeWidgetDef,
  isHomeGridBuiltinId,
  createHomeEmptySlotId,
  isHomeEmptySlotId,
  isSeaHomeTheme,
  isWindowHomeTheme,
  isAlbumHomeTheme,
  getHomeWidgetDefsForTheme,
  replaceThemeHomeWallpaper,
  removeHomeLayoutPage,
  removeHomePageWallpaper,
  MAX_HOME_PAGES,
} from '../core/appearance-prefs.js';
import renderSeaHome, {
  disposeHomeBindings,
  preloadHomeWallpapers,
  registerHomeCleanup,
  renderSeaWallpaperLayer,
  updateSeaWallpaperCrossfade,
  scheduleSeaWallpaperCrossfade,
} from './home-sea.js';
import renderWindowHome from './home-window.js';
import { customWidgetCardHtml, hydrateCustomWidgets } from '../core/custom-widget.js';
import { fileToCroppedCompressedDataUrl, IMAGE_CROP_PRESETS } from '../components/image-crop-modal.js';
import { openTextEditorModal } from '../components/text-editor-modal.js';
import { showToast } from '../components/toast.js';
import {
  PAGE_ONE_APPS,
  PAGE_TWO_APPS,
  PAGE_THREE_APPS,
  PAGE_FOUR_APPS,
  PAGE_FIVE_APPS,
  DOCK_APPS,
  getIconSvg,
  getIconBg,
  getAppRoute,
  isHomeAppGroup,
  isComingSoonApp,
  isCommercialHomeIcon,
  getLayoutAppPages,
  getLayoutPageGridItems,
  DEFAULT_POLAROID_SVG,
  DEFAULT_POLAROID_SVG_P3,
} from '../data/home-layout.js';
import { resolveDefaultAvatar } from '../core/default-avatar.js';
import { getAlbumHomeIcon, hasAlbumHomeIcon } from '../data/home-commercial-icons.js';
import { installHomePagedScrollGuard } from '../core/home-page-scroll.js';
import { bindChatUnreadIndicator } from '../core/chat-unread-indicator.js';
import { bindMailboxUnreadIndicator } from '../core/mailbox-unread-indicator.js';
import { getHomeWorldDate } from '../core/home-world-time.js';
import { TIME_SCHEDULE_CHANGED_EVENT } from '../core/time-mode.js';
import {
  getHomeCustomIconSource,
  hydrateHomeCustomIconFallbacks,
  installHomeNativeDragGuard,
  renderHomeIconLayers,
} from '../core/home-custom-icons.js';

// 记住主屏当前所在的横向分页，返回主页时恢复，避免每次都跳回第一页
let lastHomePageIndex = 0;

function esc(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderIconInner(appId, theme, albumTheme = false) {
  const fallback = albumTheme ? getAlbumHomeIcon(appId) : getIconSvg(appId);
  return renderHomeIconLayers(getHomeCustomIconSource(theme, appId), fallback, {
    className: 'custom-img',
    escape: esc,
  });
}

function renderAppItem(appId, prefs, theme, options = {}) {
  const dock = !!options.dock;
  const badges = options.badges || {};
  const badgeCount = Math.max(0, Number(badges[appId] || 0) || 0);
  const label = getAppLabel(prefs, appId);
  const bg = getIconBg(appId);
  const route = getAppRoute(appId);
  const hasCustomIcon = !!getHomeCustomIconSource(theme, appId);
  const comingSoon = isComingSoonApp(appId);
  const testing = appId === 'together-reading';
  const commercialIcon = isCommercialHomeIcon(appId);
  const albumObjectIcon = !!options.albumTheme && hasAlbumHomeIcon(appId);
  return `
    <button type="button" class="app-icon ${bg}${dock ? ' home-dock-icon' : ''}${hasCustomIcon ? ' has-custom-icon' : ''}${commercialIcon ? ' is-commercial-icon' : ''}${albumObjectIcon ? ' has-album-object-icon' : ''}${comingSoon ? ' is-coming-soon' : ''}${testing ? ' is-testing' : ''}" data-app-id="${esc(appId)}" data-app-route="${esc(route)}" aria-label="${esc(comingSoon ? `${label}，未来开发` : testing ? `${label}，测试中` : label)}">
      ${renderIconInner(appId, theme, !!options.albumTheme)}
      ${badgeCount ? `<span class="app-badge${appId === 'chat' ? ' chat-unread-badge' : ''}">${badgeCount > 99 ? '99+' : badgeCount}</span>` : ''}
      ${comingSoon ? '<span class="future-app-mark" aria-hidden="true">未来开发</span>' : ''}
      ${testing ? '<span class="test-app-mark" aria-hidden="true">测试中</span>' : ''}
    </button>
    ${dock ? '' : `<span class="app-label">${esc(label)}</span>`}
  `;
}

function builtinGridStyle(itemId, widgetDefs) {
  const def = widgetDefs?.[itemId] || getBuiltinHomeWidgetDef(itemId);
  const cols = Math.max(1, Math.min(4, Number(def?.size?.cols) || 2));
  const rows = Math.max(1, Math.min(4, Number(def?.size?.rows) || 1));
  return `grid-column:span ${cols};grid-row:span ${rows};`;
}

function renderBuiltinGridCard(itemId, ctx = {}) {
  const def = ctx.widgetDefs?.[itemId] || getBuiltinHomeWidgetDef(itemId);
  const cols = Math.max(1, Math.min(4, Number(def?.size?.cols) || 2));
  const rows = Math.max(1, Math.min(4, Number(def?.size?.rows) || 1));
  const style = builtinGridStyle(itemId, ctx.widgetDefs);
  const del = `<button type="button" class="home-edit-delete" data-real-remove="${esc(itemId)}" aria-label="删除组件">−</button>`;
  const move = `<span class="home-widget-move"><button type="button" data-widget-move="${esc(itemId)}:-1" aria-label="移到上一页">◀</button><button type="button" data-widget-move="${esc(itemId)}:1" aria-label="移到下一页">▶</button></span>`;
  const controls = `<span class="home-widget-controls" data-mm-widget-controls>${del}${move}</span>`;
  if (itemId === 'userHeader') {
    const user = ctx.user || {};
    return `<div class="widget-card grid-paper user-header home-grid-builtin" data-widget="user-header" data-home-longpress-item="userHeader" data-widget-cols="${cols}" data-widget-rows="${rows}" style="${style}">${controls}
      <div class="deco-tape home-tape-top-center"></div>
      <div class="avatar-placeholder"><img class="avatar-custom" src="${esc(user.avatarDataUrl || resolveDefaultAvatar('chat'))}" alt=""></div>
      <div class="user-info">
        <div class="greeting home-inline-editable" contenteditable="true" data-home-user-field="greeting">${esc(user.greeting || '')}</div>
        <div class="status-text home-inline-editable" contenteditable="true" data-home-user-field="statusText">${esc(user.statusText || '')}</div>
      </div>
    </div>`;
  }
  if (itemId === 'polaroidP1') {
    const photo = ctx.widgets?.polaroidPhotoP1;
    return `<div class="widget-card polaroid-widget home-polaroid-feature home-grid-builtin" data-widget="polaroid-p1" data-home-longpress-item="polaroidP1" data-widget-cols="${cols}" data-widget-rows="${rows}" style="${style}">${controls}
      <div class="deco-tape home-tape-polaroid-p1"></div>
      <div class="photo-area"${ctx.albumTheme ? ' data-album-image-slot="polaroidPhotoP1" role="button" tabindex="0" aria-label="更换拍立得照片"' : ''}>${renderPhotoArea(photo, ctx.albumTheme ? '' : DEFAULT_POLAROID_SVG)}${ctx.albumTheme && !photo ? '<span class="album-photo-hint">添加图片</span>' : ''}</div>
      <div class="caption home-inline-editable" contenteditable="true" data-home-widget-field="polaroidCaptionP1">${esc(ctx.polaroidCaptionP1 || '今日份的开心 ☁️')}</div>
    </div>`;
  }
  if (itemId === 'polaroidP3') {
    const photo = ctx.widgets?.polaroidPhotoP3;
    return `<div class="widget-card polaroid-widget home-grid-builtin" data-widget="polaroid-p3" data-home-longpress-item="polaroidP3" data-widget-cols="${cols}" data-widget-rows="${rows}" style="${style}">${controls}
      <div class="deco-tape home-tape-polaroid-p3"></div>
      <div class="photo-area"${ctx.albumTheme ? ' data-album-image-slot="polaroidPhotoP3" role="button" tabindex="0" aria-label="更换拍立得照片"' : ''}>${renderPhotoArea(photo, ctx.albumTheme ? '' : DEFAULT_POLAROID_SVG_P3)}${ctx.albumTheme && !photo ? '<span class="album-photo-hint">添加图片</span>' : ''}</div>
      <div class="caption home-inline-editable" contenteditable="true" data-home-widget-field="polaroidCaptionP3">${esc(ctx.polaroidCaptionP3 || '我的小记')}</div>
    </div>`;
  }
  if (itemId === 'noteMemo') {
    const noteItems = Array.isArray(ctx.noteItems) ? ctx.noteItems : [];
    return `<div class="widget-card torn-paper home-grid-builtin" data-widget="note-memo" data-home-longpress-item="noteMemo" data-widget-cols="${cols}" data-widget-rows="${rows}" style="${style}">${controls}
      <div class="deco-tape home-tape-note"></div>
      <div class="note-title home-inline-editable" contenteditable="true" data-home-widget-field="noteTitle">${esc(ctx.noteTitle || '备忘录')}</div>
      <ul class="note-list home-inline-editable" contenteditable="true" data-home-note-items>${noteItems.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>
    </div>`;
  }
  if (itemId === 'albumLeadCard') {
    const leadPhoto = String(ctx.widgets?.albumLeadPhoto || '').trim();
    const leadAvatar = String(ctx.widgets?.albumLeadAvatar || ctx.user?.avatarDataUrl || resolveDefaultAvatar('chat')).trim();
    const field = (key, fallback, className = '', label = '') => `<span class="home-inline-editable${className ? ` ${className}` : ''}" contenteditable="true" data-home-widget-field="${key}"${label ? ` aria-label="${label}"` : ''}>${esc(ctx.widgets?.[key] || fallback)}</span>`;
    return `<div class="album-lead-card home-grid-builtin" data-widget="album-lead-card" data-home-longpress-item="albumLeadCard" data-widget-cols="${cols}" data-widget-rows="${rows}" style="${style}">${controls}
      <section class="album-lead-photo-pane">
        <button type="button" class="album-lead-photo" data-album-image-slot="albumLeadPhoto" aria-label="更换大卡照片">${leadPhoto ? `<img src="${esc(leadPhoto)}" alt="">` : '<span class="album-photo-hint">添加图片</span>'}</button>
        <span class="album-lead-tape" aria-hidden="true"></span>
        <div class="album-lead-statusbar" aria-label="可编辑状态信息">
          <span class="album-lead-status-side"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9.6a14 14 0 0 1 18 0M6.4 13a9 9 0 0 1 11.2 0M9.8 16.4a4 4 0 0 1 4.4 0"/><circle cx="12" cy="20" r="1.2"/></svg>${field('albumLeadBattery', '75%', 'album-lead-metric', '电量')}</span>
          <i class="album-lead-status-divider" aria-hidden="true"></i>
          ${field('albumLeadTime', '11:58', 'album-lead-time', '时间')}
          <i class="album-lead-status-divider" aria-hidden="true"></i>
          <span class="album-lead-status-side"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.2 18.2h9.6a4.2 4.2 0 0 0 .5-8.4A6.2 6.2 0 0 0 5.5 12a3.2 3.2 0 0 0 1.7 6.2Z"/></svg>${field('albumLeadWeather', '28°C', 'album-lead-metric', '天气')}</span>
        </div>
      </section>
      <section class="album-lead-info">
        <header class="album-lead-header">
          <button type="button" class="album-lead-avatar" data-album-image-slot="albumLeadAvatar" aria-label="更换大卡头像"><img src="${esc(leadAvatar)}" alt=""></button>
          <span class="album-lead-now-dot" aria-hidden="true"></span>
          ${field('albumLeadStatus', 'Now', 'album-lead-now', '状态')}
          <span class="album-lead-more" aria-hidden="true">•••</span>
        </header>
        <div class="album-lead-copy">
          <b class="home-inline-editable album-lead-title" contenteditable="true" data-home-widget-field="albumLeadTitle" aria-label="大卡标题">${esc(ctx.widgets?.albumLeadTitle || '测试优化中')}</b>
          <i class="album-lead-rule" aria-hidden="true"></i>
          <p class="home-inline-editable album-lead-subtitle" contenteditable="true" data-home-widget-field="albumLeadSubtitle" aria-label="大卡短句">${esc(ctx.widgets?.albumLeadSubtitle || '今天也有风')}</p>
        </div>
        <footer class="album-lead-actions">
          <span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.8 4.7a5.5 5.5 0 0 0-7.8 0L12 5.8l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.5a5.5 5.5 0 0 0 0-7.8Z"/></svg>${field('albumLeadLikes', '26', 'album-lead-count', '点赞数量')}</span>
          <span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a8 8 0 0 1-8 8H6l-4 2 1.4-4.2A9 9 0 1 1 21 12Z"/><path d="M8 12h.01M12 12h.01M16 12h.01"/></svg>${field('albumLeadComments', '8', 'album-lead-count', '评论数量')}</span>
        </footer>
      </section>
    </div>`;
  }
  if (itemId === 'albumHeroMain') {
    return `<div class="album-hero-photo album-hero-photo-main album-hero-piece home-grid-builtin" data-widget="album-hero-main" data-home-longpress-item="albumHeroMain" data-widget-cols="${cols}" data-widget-rows="${rows}" style="${style}" data-album-image-slot="filmRingDataUrl" role="button" tabindex="0" aria-label="上传主照片">${controls}${ctx.widgets?.filmRingDataUrl ? `<img src="${esc(ctx.widgets.filmRingDataUrl)}" alt="">` : '<span class="album-photo-hint">上传图片</span>'}<small>09 / 08</small></div>`;
  }
  if (itemId === 'albumHeroNote') {
    const noteItems = Array.isArray(ctx.noteItems) ? ctx.noteItems : [];
    return `<div class="album-hero-note album-hero-piece home-grid-builtin" data-widget="album-hero-note" data-home-longpress-item="albumHeroNote" data-widget-cols="${cols}" data-widget-rows="${rows}" style="${style}">${controls}<b class="home-inline-editable" contenteditable="true" data-home-widget-field="noteTitle">${esc(ctx.noteTitle || '今天也有风')}</b><div class="home-inline-editable" contenteditable="true" data-home-note-items>${noteItems.map((item) => `<p>${esc(item)}</p>`).join('')}</div><i>AUG 09</i></div>`;
  }
  if (itemId === 'albumHeroSmall') {
    return `<div class="album-hero-photo album-hero-photo-small album-hero-piece home-grid-builtin" data-widget="album-hero-small" data-home-longpress-item="albumHeroSmall" data-widget-cols="${cols}" data-widget-rows="${rows}" style="${style}" data-album-image-slot="filmStickerDataUrl" role="button" tabindex="0" aria-label="上传副照片">${controls}${ctx.widgets?.filmStickerDataUrl ? `<img src="${esc(ctx.widgets.filmStickerDataUrl)}" alt="">` : '<span class="album-photo-hint">上传图片</span>'}<small>09 / 09</small></div>`;
  }
  if (itemId === 'filmWidget') {
    if (ctx.albumTheme) {
      // 仅作极短暂的旧布局兜底；正常读取时会迁移为三个 albumHero* 组件。
      return `<div class="album-hero-photo album-hero-photo-main album-hero-piece home-grid-builtin" data-widget="album-hero-main" data-home-longpress-item="filmWidget" data-widget-cols="${cols}" data-widget-rows="${rows}" style="${style}" data-album-image-slot="filmRingDataUrl" role="button" tabindex="0" aria-label="上传主照片">${controls}${ctx.widgets?.filmRingDataUrl ? `<img src="${esc(ctx.widgets.filmRingDataUrl)}" alt="">` : '<span class="album-photo-hint">上传图片</span>'}<small>09 / 08</small></div>`;
    }
    return `<div class="widget-card film-widget home-grid-builtin" data-widget="film-widget" data-home-longpress-item="filmWidget" data-widget-cols="${cols}" data-widget-rows="${rows}" style="${style}">${controls}
      <div class="film-layout">
        ${renderFilmSurface(ctx.widgets?.filmRingDataUrl, 'film-ring')}
        ${renderFilmSurface(ctx.widgets?.filmStickerDataUrl, 'film-sticker')}
      </div>
    </div>`;
  }
  if (itemId === 'calendarWidget') {
    const calendarCells = Array.isArray(ctx.calendarCells) ? ctx.calendarCells : [];
    return `<div class="widget-card calendar-widget home-grid-builtin" data-widget="calendar-widget" data-home-longpress-item="calendarWidget" data-widget-cols="${cols}" data-widget-rows="${rows}" style="${style}">${controls}
      <div class="cal-header home-inline-editable" contenteditable="true" data-home-widget-field="calendarHeader"${ctx.calendarHeaderAuto ? ' data-home-calendar-auto="1"' : ''}>${esc(ctx.calendarHeader || '')}</div>
      <div class="cal-grid" data-home-calendar-grid>
        <span class="day-name">日</span><span class="day-name">一</span><span class="day-name">二</span><span class="day-name">三</span><span class="day-name">四</span><span class="day-name">五</span><span class="day-name">六</span>
        ${renderCalendarCells(calendarCells)}
      </div>
    </div>`;
  }
  if (itemId === 'scrapbookFourthDecor') {
    return `<div class="widget-card scrapbook-fourth-decor home-grid-builtin" data-widget="scrapbook-fourth-decor" data-home-longpress-item="scrapbookFourthDecor" data-widget-cols="${cols}" data-widget-rows="${rows}" style="${style}">${controls}
      <span class="scrapbook-fourth-index" aria-hidden="true">04 / COLLECTION</span>
      <span class="scrapbook-fourth-tape" aria-hidden="true"></span>
      <b class="home-inline-editable" contenteditable="true" data-home-widget-field="pageFourTitle">${esc(ctx.widgets?.pageFourTitle || '今天的收藏')}</b>
      <p class="home-inline-editable" contenteditable="true" data-home-widget-field="pageFourText">${esc(ctx.widgets?.pageFourText || '把喜欢的颜色，留在这一页。')}</p>
      <span class="scrapbook-fourth-swatches" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
    </div>`;
  }
  if (itemId === 'albumDate') {
    const date = ctx.homeDate || new Date();
    return `<div class="widget-card album-date-widget home-grid-builtin" data-widget="album-date" data-home-longpress-item="albumDate" data-widget-cols="${cols}" data-widget-rows="${rows}" style="${style}">${controls}<div class="album-date-photo" data-album-image-slot="albumDatePhoto" role="button" tabindex="0" aria-label="上传日期卡照片">${ctx.widgets?.albumDatePhoto ? `<img src="${esc(ctx.widgets.albumDatePhoto)}" alt="">` : '<span class="album-photo-hint">上传图片</span>'}<em aria-hidden="true">DAILY / 02</em></div><div class="album-date-copy"><small>ARCHIVE</small><b>${esc(new Intl.DateTimeFormat('en', { month: 'short' }).format(date).toUpperCase())} ${esc(String(date.getDate()).padStart(2, '0'))}</b><span>${esc(new Intl.DateTimeFormat('en', { weekday: 'long' }).format(date))}</span><i>${esc(new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(date))}</i></div></div>`;
  }
  if (itemId === 'albumMusic') {
    return `<div class="widget-card album-music-widget home-grid-builtin" data-widget="album-music" data-home-longpress-item="albumMusic" data-widget-cols="${cols}" data-widget-rows="${rows}" style="${style}">${controls}<span class="album-component-kicker">NOW PLAYING <i>03</i></span><div class="album-music-cover" data-album-image-slot="albumMusicCover" role="button" tabindex="0" aria-label="上传播放器封面">${ctx.widgets?.albumMusicCover ? `<img src="${esc(ctx.widgets.albumMusicCover)}" alt="">` : '<span class="album-photo-hint">上传封面</span>'}</div><b>Soft Hours</b><div class="album-music-line"><i></i></div><small>01:32 <span>03:45</span></small><button type="button" class="album-music-play" data-album-open-music aria-label="打开音乐">▶</button></div>`;
  }
  if (itemId === 'albumNotes') {
    return `<div class="album-notes-widget home-grid-builtin" data-widget="album-notes" data-home-longpress-item="albumNotes" data-widget-cols="${cols}" data-widget-rows="${rows}" style="${style}">${controls}<section><small>01 / NOTES</small><b>READING</b><i></i><i></i><i></i></section><section><small>02 / LIST</small><b>TO DO</b><i></i><i></i><i></i></section></div>`;
  }
  if (itemId === 'albumStrip') {
    const date = ctx.homeDate || new Date();
    const archiveImage = ctx.widgets?.albumStripLeft || ctx.widgets?.albumStripRight || '';
    const archiveDate = new Intl.DateTimeFormat('en', { month: 'short', day: '2-digit', year: 'numeric' }).format(date).toUpperCase();
    return `<div class="widget-card album-strip-widget home-grid-builtin" data-widget="album-strip" data-home-longpress-item="albumStrip" data-widget-cols="${cols}" data-widget-rows="${rows}" style="${style}">${controls}<div class="album-archive-thumb" data-album-image-slot="albumStripLeft" role="button" tabindex="0" aria-label="上传归档照片">${archiveImage ? `<img src="${esc(archiveImage)}" alt="">` : '<span class="album-archive-photo-empty" aria-hidden="true">＋ PHOTO</span>'}</div><div class="album-archive-copy"><small>ARCHIVE NOTE <i>02</i></small><p class="home-inline-editable" contenteditable="true" data-home-widget-field="albumArchiveText">${esc(ctx.widgets?.albumArchiveText || '把今天想留下的，收进这一页。')}</p><span>${esc(archiveDate)}</span></div></div>`;
  }
  if (itemId === 'albumFuture') {
    return `<div class="album-future-widget home-grid-builtin" data-widget="album-future" data-home-longpress-item="albumFuture" data-widget-cols="${cols}" data-widget-rows="${rows}" style="${style}">${controls}<b class="home-inline-editable" contenteditable="true" data-home-widget-field="albumFutureTitle">${esc(ctx.widgets?.albumFutureTitle || 'NEXT')}</b><span class="home-inline-editable" contenteditable="true" data-home-widget-field="albumFutureText">${esc(ctx.widgets?.albumFutureText || '下一页故事，还在慢慢发生。')}</span></div>`;
  }
  return '';
}

function renderCalendarCells(cells = []) {
  return (Array.isArray(cells) ? cells : []).map((cell) => {
    if (!cell || typeof cell === 'string') return '<span></span>';
    return `<span class="${cell.marked ? 'marked' : ''}">${cell.day}</span>`;
  }).join('');
}

function renderAppGrid(itemIds, prefs, theme, extraClass = '', badges = {}, customItems = {}, builtinCtx = {}) {
  return `
    <div class="app-grid ${extraClass}">
      ${itemIds.map((itemId) => {
    if (isHomeEmptySlotId(itemId)) {
      return `<span class="app-drop-slot app-layout-empty-slot" data-home-empty-slot="${esc(itemId)}" aria-hidden="true"></span>`;
    }
    if (customItems[itemId]) {
      return customWidgetCardHtml(customItems[itemId], { editable: true, movable: true });
    }
    if (isHomeGridBuiltinId(itemId)) {
      return renderBuiltinGridCard(itemId, builtinCtx);
    }
    return `
        <div class="app-item" data-home-longpress-item="${esc(itemId)}">
          ${renderAppItem(itemId, prefs, theme, { badges, albumTheme: builtinCtx.albumTheme })}
        </div>
      `;
  }).join('')}
    </div>
  `;
}

function renderPhotoArea(dataUrl, fallbackSvg) {
  if (dataUrl) return `<img class="photo-custom" src="${esc(dataUrl)}" alt="">`;
  return fallbackSvg;
}

function renderFilmSurface(dataUrl, className) {
  if (dataUrl) return `<div class="${className}"><img class="film-custom" src="${esc(dataUrl)}" alt=""></div>`;
  return `<div class="${className}"></div>`;
}

function resolveHomeGreeting(profile, themedGreeting = '') {
  const displayName = profile ? getUserDisplayName(profile) : '我';
  const fallback = `${displayName}的手账本`;
  const raw = String(themedGreeting || '').trim();
  const legacyDefaultGreeting = ['Us', 'er'].join('') + ' 的手账本';
  if (!raw || raw === legacyDefaultGreeting) return fallback;
  return raw
    .replace(/\bUser\b/g, displayName)
    .replace(/\buser\b/g, displayName)
    .replace(/用户/g, displayName);
}

function formatAlbumPageMeta(date, pageNumber = 1, pageCount = 1) {
  const value = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const week = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'][value.getDay()];
  const month = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'][value.getMonth()];
  const day = String(value.getDate()).padStart(2, '0');
  const current = String(Math.max(1, Number(pageNumber) || 1)).padStart(2, '0');
  const total = String(Math.max(1, Number(pageCount) || 1)).padStart(2, '0');
  return `<div class="album-page-meta" aria-hidden="true"><span>${week}&nbsp;&nbsp;·&nbsp;&nbsp;${day}&nbsp;&nbsp;${month}</span><i>${current}&nbsp;/&nbsp;${total}</i></div>`;
}

function renderCustomWidget(item) {
  return customWidgetCardHtml(item, { editable: true, movable: true });
}

function buildDefaultLayoutPatch(albumTheme = false) {
  return {
    version: 9,
    pages: albumTheme ? [
      [
        'albumLeadCard',
        'weibo', 'forum', 'stickers', 'anon-chat',
        'memory', 'mailbox', 'together-reading',
      ],
      [
        'chat', 'character-phone', 'albumHeroSmall',
        'albumHeroMain', 'encounter', 'worldbook', 'albumHeroNote',
        'preset', 'beautify', 'radio',
      ],
      ['albumMusic', 'albumNotes', 'music', 'appearance', 'mcp', 'albumStrip'],
      ['calendarWidget', 'polaroidP1', 'polaroidP3', 'au', 'travel-char', 'extensions'],
      ['albumFuture', ...PAGE_FIVE_APPS.filter((id) => id !== 'together-reading')],
    ] : [
      ['userHeader', ...PAGE_ONE_APPS, 'polaroidP1'],
      ['noteMemo', ...PAGE_TWO_APPS, 'filmWidget'],
      ['calendarWidget', 'polaroidP3', ...PAGE_THREE_APPS],
      ['scrapbookFourthDecor', ...PAGE_FOUR_APPS],
      PAGE_FIVE_APPS.slice(),
    ],
    dock: DOCK_APPS.slice(),
    customItems: {},
  };
}

export default async function render(container) {
  let prefs = await loadAppearancePrefs();
  const active = getActiveTheme(prefs);
  // 海 / 窗：各自走独立渲染器，不复用默认手账的固定网格
  if (isSeaHomeTheme(active.id, active.theme)) {
    return renderSeaHome(container);
  }
  if (isWindowHomeTheme(active.id, active.theme)) {
    return renderWindowHome(container);
  }
  const { theme } = active;
  const albumTheme = isAlbumHomeTheme(active.id, theme);
  await preloadHomeWallpapers(theme);
  disposeHomeBindings(container);
  const layout = normalizeHomeLayout(theme.homeLayout, theme.widgetVisibility);
  const appPages = getLayoutAppPages(layout);
  const pageGridItems = appPages.map((_, index) => getLayoutPageGridItems(layout, index));
  const profile = await getCurrentUser().catch(() => null);
  const appBadges = {};
  const userCardTheme = theme?.userCard || {};
  const user = {
    greeting: resolveHomeGreeting(profile, userCardTheme.greeting),
    statusText: profile?.statusText || profile?.signature || userCardTheme.statusText || '今天也要开开心心呀 ✨',
    avatarDataUrl: profile?.avatar || userCardTheme.avatarDataUrl || '',
  };
  const widgets = theme?.widgets || {};
  const noteItems = Array.isArray(widgets.noteItems) && widgets.noteItems.length
    ? widgets.noteItems
    : ['整理设定集', '给盆栽浇水 🌱', '晚上看电影'];
  const homeNow = await getHomeWorldDate(profile?.id).catch(() => new Date());
  const calendarHeaderAuto = !String(widgets.calendarHeader || '').trim();
  const calendarHeader = getWidgetValue(prefs, 'calendarHeader', formatCalendarHeader(homeNow));
  const calendarCells = buildCalendarCells(homeNow);
  const show = (key) => isWidgetVisible(theme, key);
  const customItems = layout.customItems || {};
  const builtinCtx = {
    albumTheme,
    widgetDefs: getHomeWidgetDefsForTheme(active.id, theme),
    user,
    widgets,
    noteItems,
    noteTitle: getWidgetValue(prefs, 'noteTitle', '备忘录'),
    polaroidCaptionP1: getWidgetValue(prefs, 'polaroidCaptionP1', '今日份的开心 ☁️'),
    polaroidCaptionP3: getWidgetValue(prefs, 'polaroidCaptionP3', '我的小记'),
    calendarHeader,
    calendarHeaderAuto,
    calendarCells,
    homeDate: homeNow,
  };
  const filterVisibleGrid = (items) => items.filter((id) => {
    if (!isHomeGridBuiltinId(id)) return true;
    return show(id);
  });
  const pagesHtml = pageGridItems.map((items, index) => {
    const visibleItems = filterVisibleGrid(items);
    const matchesVisibleItems = (expected) => visibleItems.length === expected.length
      && expected.every((id, itemIndex) => visibleItems[itemIndex] === id);
    const leadAppGrid = albumTheme
      && index === 0
      && visibleItems.length === 9
      && visibleItems[0] === 'albumLeadCard'
      && visibleItems.slice(1).every((id) => !isHomeGridBuiltinId(id) && !customItems[id]);
    const editorialToolsGrid = albumTheme
      && index === 2
      && matchesVisibleItems(['albumMusic', 'albumNotes', 'music', 'beautify', 'mcp', 'albumStrip']);
    const editorialArchiveGrid = albumTheme
      && index === 3
      && matchesVisibleItems(['calendarWidget', 'polaroidP1', 'polaroidP3', 'au', 'travel-char', 'extensions']);
    const pageClass = ['page-one', 'page-two', 'page-three'][index] || 'page-extra';
    const gridClass = [
      index === 1 ? 'page-two-grid' : (index >= 3 ? 'page-extra-grid' : ''),
      leadAppGrid ? 'album-lead-app-grid' : '',
      editorialToolsGrid ? 'album-editorial-tools-grid' : '',
      editorialArchiveGrid ? 'album-editorial-archive-grid' : '',
    ].filter(Boolean).join(' ');
    return `
      <div class="home-page ${pageClass}" data-home-page="${index + 1}">
        ${albumTheme ? formatAlbumPageMeta(homeNow, index + 1, pageGridItems.length) : ''}
        ${renderAppGrid(visibleItems, prefs, theme, gridClass, appBadges, customItems, builtinCtx)}
      </div>`;
  }).join('');
  const dotsHtml = pageGridItems.map((_, i) => `<div class="dot${i === 0 ? ' active' : ''}"></div>`).join('');

  container.className = `page home-shell-page${albumTheme ? ' home-album-shell' : ''}`;
  container.style.removeProperty('background-image');
  container.style.removeProperty('background-size');
  container.style.removeProperty('background-position');

  container.innerHTML = `
    <div class="home-wallpaper-layer sea-wallpaper-layer" data-home-wallpaper-layer aria-hidden="true"></div>
    <div class="home-pages-container">
      ${pagesHtml}
    </div>

    <div class="home-bottom-chrome" data-home-chrome>
      <div class="page-indicators home-indicators" aria-hidden="true">
        ${dotsHtml}
      </div>
      <div class="dock home-dock" data-home-dock aria-label="Dock">
        ${layout.dock.map((appId) => `
          <div class="home-dock-slot" data-home-longpress-item="${esc(appId)}">
            ${renderAppItem(appId, prefs, theme, { dock: true, badges: appBadges, albumTheme })}
            ${albumTheme ? `<span class="app-label album-dock-label">${esc(getAppLabel(prefs, appId))}</span>` : ''}
          </div>
        `).join('')}
      </div>
    </div>
    <div class="home-real-edit-bar" data-real-edit-bar hidden>
      <button type="button" class="home-real-edit-action" data-edit-reset>复位</button>
      <button type="button" class="home-real-edit-action" data-edit-clear>清空</button>
      <button type="button" class="home-real-edit-action home-real-edit-wide" data-edit-widget-library>组件库</button>
      <label class="home-real-edit-action home-wallpaper-pick">壁纸<input type="file" accept="image/*" data-home-wallpaper-file hidden></label>
      <button type="button" class="home-real-edit-action" data-edit-remove-page>删页</button>
      <button type="button" class="home-real-edit-action" data-edit-add-page>＋页</button>
      <button type="button" class="home-real-edit-done" data-edit-finish>完成</button>
    </div>
    ${albumTheme ? '<input type="file" accept="image/*" data-album-image-input hidden>' : ''}
  `;

  registerHomeCleanup(container, installHomeNativeDragGuard(container));
  hydrateHomeCustomIconFallbacks(container);
  hydrateCustomWidgets(container, layout.customItems, { userId: profile?.id });
  renderSeaWallpaperLayer(container, theme);

  let calendarDateKey = '';
  async function refreshHomeCalendar() {
    if (!container.isConnected || !profile?.id) return;
    const date = await getHomeWorldDate(profile.id).catch(() => null);
    if (!date || !container.isConnected) return;
    const nextKey = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
    if (nextKey === calendarDateKey) return;
    calendarDateKey = nextKey;
    const header = container.querySelector('[data-home-calendar-auto="1"]');
    if (header) header.textContent = formatCalendarHeader(date);
    const grid = container.querySelector('[data-home-calendar-grid]');
    if (grid) {
      grid.innerHTML = `
        <span class="day-name">日</span><span class="day-name">一</span><span class="day-name">二</span><span class="day-name">三</span><span class="day-name">四</span><span class="day-name">五</span><span class="day-name">六</span>
        ${renderCalendarCells(buildCalendarCells(date))}
      `;
    }
  }
  void refreshHomeCalendar();
  const homeCalendarTimer = window.setInterval(() => { void refreshHomeCalendar(); }, 15000);
  const onTimeScheduleChanged = (event) => {
    const changedUserId = String(event.detail?.userId || '').trim();
    if (changedUserId && changedUserId !== String(profile?.id || '').trim()) return;
    calendarDateKey = '';
    void refreshHomeCalendar();
  };
  window.addEventListener(TIME_SCHEDULE_CHANGED_EVENT, onTimeScheduleChanged);
  registerHomeCleanup(container, () => {
    window.clearInterval(homeCalendarTimer);
    window.removeEventListener(TIME_SCHEDULE_CHANGED_EVENT, onTimeScheduleChanged);
  });

  async function refreshTravelBadge() {
    if (!document.body.contains(container) || !profile?.id) {
      window.removeEventListener('travel-char-notifications', refreshTravelBadge);
      return;
    }
    // 动态加载：避免首页静态导入 travel-char 整条聊天上下文链（易拖进 iOS 不兼容语法）
    const { listTravelCharNotifications } = await import('../core/travel-char.js');
    const count = (await listTravelCharNotifications(profile.id, { unreadOnly: true }).catch(() => [])).length;
    const btn = container.querySelector('[data-app-route="travel-char"]');
    if (!btn) return;
    const old = btn.querySelector('.app-badge');
    if (!count) {
      old?.remove();
      return;
    }
    const text = count > 99 ? '99+' : String(count);
    if (old) old.textContent = text;
    else btn.insertAdjacentHTML('beforeend', `<span class="app-badge">${esc(text)}</span>`);
  }

  window.addEventListener('travel-char-notifications', refreshTravelBadge);
  registerHomeCleanup(container, () => {
    window.removeEventListener('travel-char-notifications', refreshTravelBadge);
  });
  if (profile?.id) {
    bindChatUnreadIndicator(container, profile.id, registerHomeCleanup);
    bindMailboxUnreadIndicator(container, profile.id, registerHomeCleanup);
    if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(() => {
        refreshTravelBadge().catch(() => null);
      }, { timeout: 1200 });
    } else {
      setTimeout(() => {
        refreshTravelBadge().catch(() => null);
      }, 120);
    }
  }

  let appNavigating = false;

  function resetHomeNavLock() {
    appNavigating = false;
    container.querySelectorAll('[data-app-route]').forEach((item) => {
      item.removeAttribute('aria-disabled');
    });
  }

  const pages = container.querySelector('.home-pages-container');
  const dots = container.querySelectorAll('.home-indicators .dot');
  let pageScrollGuard = null;
  let paintedDotIndex = -1;

  // Keep-Alive 恢复时 DOM 没有重新渲染，但 `hidden` 切换 + scroll-snap 会让移动端浏览器
  // 把横向分页重新吸附回第 0 页——挂起前后都强制把 scrollLeft 摆回记住的分页，双 rAF 等布局稳定。
  function restoreHomePageScroll() {
    if (!pages || !dots.length) return;
    // 模块级 lastHomePageIndex 是权威来源（进 App 前会 pin）；勿用 `x || last` 把合法的 0 丢掉
    const restoreIndex = Math.max(0, Math.min(dots.length - 1, lastHomePageIndex || 0));
    const width = pages.clientWidth;
    if (!width) return;
    pageScrollGuard?.setAnchor(restoreIndex);
    pages.scrollLeft = restoreIndex * width;
    dots.forEach((dot, i) => dot.classList.toggle('active', i === restoreIndex));
    updateSeaWallpaperCrossfade(container, pages.scrollLeft, width);
  }

  /** 进 App 前锁住当前分页，避免 touchend + Keep-Alive 摘树把 scrollLeft 清零后误结算成 N-1 */
  function pinHomePageBeforeNavigate() {
    if (!pages) return;
    const width = pages.clientWidth;
    const fromScroll = width > 1 ? Math.round(pages.scrollLeft / width) : NaN;
    const fromGuard = pageScrollGuard?.getAnchor?.();
    // 点击发生在 navigate 摘树之前，此刻 scrollLeft 才是用户眼前的真实页。
    // settle guard 有 180ms 空闲延迟，快速翻到第三页后立刻点图标时仍可能停在第 0 页。
    const candidate = Number.isFinite(fromScroll) ? fromScroll : fromGuard;
    const idx = Math.max(
      0,
      Math.min(
        Math.max(0, (container.querySelectorAll('.home-indicators .dot').length || 1) - 1),
        Number.isFinite(Number(candidate)) ? Number(candidate) : lastHomePageIndex,
      ),
    );
    lastHomePageIndex = idx;
    pageScrollGuard?.setAnchor(idx);
  }

  const onRouteActivated = (ev) => {
    const detail = ev.detail || {};
    if (detail.container !== container || detail.path !== 'home') return;
    resetHomeNavLock();
    void refreshHomeCalendar();
    if (detail.resumed) {
      restoreHomePageScroll();
      requestAnimationFrame(restoreHomePageScroll);
    }
  };
  window.addEventListener('marshmallow-route-activated', onRouteActivated);
  registerHomeCleanup(container, () => {
    window.removeEventListener('marshmallow-route-activated', onRouteActivated);
  });

  if (pages && dots.length) {
    pages.addEventListener('scroll', () => {
      const index = Math.round(pages.scrollLeft / pages.clientWidth);
      if (index !== paintedDotIndex) {
        paintedDotIndex = index;
        container.querySelectorAll('.home-indicators .dot').forEach((dot, i) => dot.classList.toggle('active', i === index));
      }
      scheduleSeaWallpaperCrossfade(container, pages.scrollLeft, pages.clientWidth);
    }, { passive: true });
    pageScrollGuard = installHomePagedScrollGuard(pages, '.home-page, .page-extra', {
      onSettled(index) {
        const liveDots = container.querySelectorAll('.home-indicators .dot');
        lastHomePageIndex = Math.max(0, Math.min(liveDots.length - 1, index));
      },
    });
    registerHomeCleanup(container, () => pageScrollGuard?.dispose?.());
    requestAnimationFrame(() => updateSeaWallpaperCrossfade(container, pages.scrollLeft, pages.clientWidth));
  }
  if (pages && lastHomePageIndex > 0) {
    restoreHomePageScroll();
    requestAnimationFrame(restoreHomePageScroll);
  }

  container.querySelectorAll('[data-app-route]').forEach((btn) => {
    btn.addEventListener('pointerdown', () => {
      if (appNavigating || container.classList.contains('is-home-editing')) return;
      if (isComingSoonApp(btn.getAttribute('data-app-id'))) return;
      if (isHomeAppGroup(btn.getAttribute('data-app-id'))) return;
      const route = String(btn.getAttribute('data-app-route') || '').trim();
      if (route) prefetchRoute(route);
    });
    btn.addEventListener('click', async () => {
      if (appNavigating || container.classList.contains('is-home-editing')) return;
      const appId = btn.getAttribute('data-app-id');
      if (isComingSoonApp(appId)) {
        showToast(`${getAppLabel(prefs, appId)} · 未来开发中，暂未开放`);
        return;
      }
      if (isHomeAppGroup(appId)) {
        const build = encodeURIComponent(String(globalThis.__MARSHMALLOW_BUILD__ || 'dev'));
        const { openAppGroupOverlay } = await import(`../components/app-group-overlay.js?v=${build}`);
        await openAppGroupOverlay(appId, { anchor: btn });
        return;
      }
      appNavigating = true;
      pinHomePageBeforeNavigate();
      container.querySelectorAll('[data-app-route]').forEach((item) => {
        item.setAttribute('aria-disabled', 'true');
      });
      navigate(String(btn.getAttribute('data-app-route') || 'tutorial'));
    });
  });

  let layoutPersistQueue = Promise.resolve();

  async function persistLayoutNow(nextLayout, nextVisibility, themePatch = {}) {
    const freshPrefs = await loadAppearancePrefs();
    const active = getActiveTheme(freshPrefs);
    const activeTheme = active.theme;
    const saved = await saveAppearancePrefs({
      ...freshPrefs,
      themes: {
        ...freshPrefs.themes,
        [active.id]: {
          ...activeTheme,
          ...themePatch,
          widgetVisibility: nextVisibility || activeTheme.widgetVisibility || {},
          homeLayout: normalizeHomeLayout(nextLayout, nextVisibility || activeTheme.widgetVisibility),
        },
      },
    });
    prefs = saved;
  }

  function persistLayout(nextLayout, nextVisibility, themePatch = {}) {
    // pointerup 与紧随其后的“完成”可能在同一帧各触发一次保存。串行写入可避免
    // 较早的异步写操作晚完成，反过来覆盖用户最后看到的布局。
    const queued = layoutPersistQueue.catch(() => {}).then(() => (
      persistLayoutNow(nextLayout, nextVisibility, themePatch)
    ));
    layoutPersistQueue = queued;
    return queued;
  }

  async function waitForLayoutPersistence() {
    await layoutPersistQueue.catch(() => {});
  }

  async function persistHomeContent({ userField = '', widgetField = '', value = null } = {}) {
    const freshPrefs = await loadAppearancePrefs();
    const activeTheme = getActiveTheme(freshPrefs);
    const nextTheme = {
      ...activeTheme.theme,
      userCard: { ...(activeTheme.theme.userCard || {}) },
      widgets: { ...(activeTheme.theme.widgets || {}) },
    };
    if (userField) nextTheme.userCard[userField] = String(value || '').trim();
    if (widgetField) nextTheme.widgets[widgetField] = value;
    prefs = await saveAppearancePrefs({
      ...freshPrefs,
      themes: {
        ...freshPrefs.themes,
        [activeTheme.id]: nextTheme,
      },
    });
  }

  container.querySelectorAll('[data-home-user-field], [data-home-widget-field]').forEach((el) => {
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        el.blur();
      }
    });
    el.addEventListener('blur', () => {
      const userField = String(el.getAttribute('data-home-user-field') || '').trim();
      const widgetField = String(el.getAttribute('data-home-widget-field') || '').trim();
      void persistHomeContent({
        userField,
        widgetField,
        value: String(el.textContent || '').trim(),
      }).catch(() => showToast('文字保存失败'));
    });
  });

  container.querySelector('[data-home-note-items]')?.addEventListener('blur', (e) => {
    const value = String(e.currentTarget.innerText || '')
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean);
    void persistHomeContent({ widgetField: 'noteItems', value }).catch(() => showToast('文字保存失败'));
  });

  const albumImageInput = container.querySelector('[data-album-image-input]');
  let pendingAlbumImageSlot = '';
  const closeAlbumImageSourcePicker = () => {
    const host = document.getElementById('modal-container');
    if (!host) return;
    host.classList.remove('active');
    host.innerHTML = '';
  };
  const openAlbumImageUrlEditor = (slot) => {
    openTextEditorModal({
      title: '图片链接',
      value: '',
      placeholder: 'https://…',
      multiline: false,
      centered: true,
      confirmLabel: '使用',
      onSave: async (value) => {
        const url = String(value || '').trim();
        if (!/^(?:https?:\/\/|data:image\/)/i.test(url)) {
          showToast('请填写可访问的图片链接');
          return;
        }
        try {
          await persistHomeContent({ widgetField: slot, value: url });
          showToast('图片已更新');
          render(container);
        } catch (error) {
          showToast(`图片保存失败：${error?.message || error}`);
        }
      },
    });
  };
  const openAlbumImagePicker = (el) => {
    if (!albumImageInput || container.classList.contains('is-home-editing')) return;
    pendingAlbumImageSlot = String(el?.getAttribute('data-album-image-slot') || '').trim();
    if (!pendingAlbumImageSlot) return;
    const host = document.getElementById('modal-container');
    if (!host) {
      albumImageInput.click();
      return;
    }
    const slot = pendingAlbumImageSlot;
    host.classList.add('active');
    host.innerHTML = `
      <div class="modal-overlay modal-sheet-center" data-album-image-source-overlay>
        <div class="modal-sheet scrapbook-card album-image-source-sheet" role="dialog" aria-modal="true" aria-label="更换图片">
          <p class="album-image-source-title">添加图片</p>
          <div class="album-image-source-actions">
            <button type="button" class="btn btn-primary" data-album-image-upload>本地上传</button>
            <button type="button" class="btn" data-album-image-url>填写链接</button>
          </div>
          <button type="button" class="album-image-source-cancel" data-album-image-source-close>取消</button>
        </div>
      </div>`;
    host.querySelector('[data-album-image-source-overlay]')?.addEventListener('click', closeAlbumImageSourcePicker);
    host.querySelector('.album-image-source-sheet')?.addEventListener('click', (event) => event.stopPropagation());
    host.querySelector('[data-album-image-source-close]')?.addEventListener('click', closeAlbumImageSourcePicker);
    host.querySelector('[data-album-image-upload]')?.addEventListener('click', () => {
      closeAlbumImageSourcePicker();
      albumImageInput.click();
    });
    host.querySelector('[data-album-image-url]')?.addEventListener('click', () => {
      closeAlbumImageSourcePicker();
      openAlbumImageUrlEditor(slot);
    });
  };
  container.querySelectorAll('[data-album-image-slot]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      openAlbumImagePicker(el);
    });
    el.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      openAlbumImagePicker(el);
    });
  });
  albumImageInput?.addEventListener('change', async () => {
    const file = albumImageInput.files?.[0];
    const slot = pendingAlbumImageSlot;
    albumImageInput.value = '';
    pendingAlbumImageSlot = '';
    if (!file || !slot) return;
    try {
      const dataUrl = await fileToCroppedCompressedDataUrl(file, IMAGE_CROP_PRESETS.photo);
      if (!dataUrl) return;
      await persistHomeContent({ widgetField: slot, value: dataUrl });
      showToast('图片已更新');
      render(container);
    } catch (err) {
      showToast(`图片上传失败：${err?.message || err}`);
    }
  });

  const editBar = container.querySelector('[data-real-edit-bar]');

  function openEditMode() {
    if (editBar) editBar.hidden = false;
    container.classList.add('is-home-editing');
    ensureDropSlots();
    const removePage = container.querySelector('[data-edit-remove-page]');
    if (removePage) removePage.disabled = homePageEls().length <= 1;
  }

  function exitEditUi() {
    if (editBar) editBar.hidden = true;
    clearTransientDropSlots();
    container.classList.remove('is-home-editing');
  }

  async function closeEditMode({ rerender = false, persist = true } = {}) {
    // 点击“完成”后先在当前帧退出编辑态；布局落库与整页重绘放到后面，
    // 避免 IndexedDB 或大组件注水让按钮看起来几百毫秒都没反应。
    materializeDropSlotGaps();
    exitEditUi();
    await abortRealDrag();
    await waitForLayoutPersistence();
    if (persist) {
      pruneEmptyExtraPages();
      await persistLayout(deriveLayoutFromDom());
    }
    if (rerender) render(container);
  }

  container.querySelector('[data-edit-finish]')?.addEventListener('click', () => {
    void closeEditMode({ rerender: true });
  });
  container.querySelector('[data-edit-widget-library]')?.addEventListener('click', () => {
    void closeEditMode().then(() => navigate('beautify', { target: 'home', mode: 'widget' }));
  });
  container.querySelector('[data-album-open-music]')?.addEventListener('click', () => navigate('music'));
  container.querySelector('[data-home-wallpaper-file]')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const dataUrl = await fileToCroppedCompressedDataUrl(file, IMAGE_CROP_PRESETS.wallpaper);
      if (!dataUrl) return;
      const freshPrefs = await loadAppearancePrefs();
      const activeTheme = getActiveTheme(freshPrefs);
      prefs = await saveAppearancePrefs({
        ...freshPrefs,
        themes: {
          ...freshPrefs.themes,
          [activeTheme.id]: replaceThemeHomeWallpaper(activeTheme.theme, dataUrl),
        },
      });
      showToast('壁纸已替换');
      render(container);
    } catch (err) {
      showToast(`壁纸替换失败：${err?.message || err}`);
    }
  });
  container.querySelector('[data-edit-reset]')?.addEventListener('click', async () => {
    if (!window.confirm('复位主屏布局？图标顺序、Dock 和自定义组件位置会回到默认。')) return;
    exitEditUi();
    const currentTheme = getActiveTheme(prefs).theme;
    const current = normalizeHomeLayout(currentTheme.homeLayout, currentTheme.widgetVisibility);
    const placedCustomIds = current.pages.flat().filter((id) => current.customItems?.[id]);
    const resetLayout = buildDefaultLayoutPatch(albumTheme);
    if (placedCustomIds.length) resetLayout.pages[resetLayout.pages.length - 1].push(...placedCustomIds);
    const nextVisibility = { ...(currentTheme.widgetVisibility || {}) };
    Object.keys(BUILTIN_HOME_WIDGET_DEFS).forEach((id) => { nextVisibility[id] = albumTheme ? !['userHeader', 'noteMemo'].includes(id) : true; });
    await persistLayout({ ...resetLayout, customItems: current.customItems }, nextVisibility);
    void closeEditMode({ rerender: true, persist: false });
  });
  // 清空布局：从零开始做主屏用——内置组件全隐藏、图标集中到最后一页
  container.querySelector('[data-edit-clear]')?.addEventListener('click', async () => {
    if (!window.confirm('清空主屏布局？内置组件会全部隐藏、App 图标集中到最后一页（Dock 保留）。想找回内置组件去「美化设置 → 主屏组件」。')) return;
    exitEditUi();
    const active = getActiveTheme(prefs).theme;
    const current = normalizeHomeLayout(active.homeLayout, active.widgetVisibility);
    const nextVisibility = { ...(active.widgetVisibility || {}) };
    Object.keys(BUILTIN_HOME_WIDGET_DEFS).forEach((id) => { nextVisibility[id] = false; });
    await persistLayout({
      ...current,
      pages: [current.pages.flat().filter((id) => current.customItems?.[id])],
    }, nextVisibility);
    void closeEditMode({ rerender: true, persist: false });
  });

  // 编辑态「新建分页」：建一页空白页并滑过去，拖图标进去后才会保存（空页会自动回收）
  container.querySelector('[data-edit-add-page]')?.addEventListener('click', () => {
    const created = appendExtraPage();
    if (!created || !pages) return;
    const total = homePageEls().length;
    const targetIndex = total - 1;
    pageScrollGuard?.setAnchor(targetIndex);
    const go = () => pages.scrollTo({ left: targetIndex * (pages.clientWidth || 1), behavior: 'smooth' });
    go();
    requestAnimationFrame(go);
  });
  container.querySelector('[data-edit-remove-page]')?.addEventListener('click', async () => {
    const pageEls = homePageEls();
    if (pageEls.length <= 1) {
      showToast('主屏至少保留一页');
      return;
    }
    const width = pages?.clientWidth || 1;
    const pageIndex = Math.max(0, Math.min(pageEls.length - 1, Math.round((pages?.scrollLeft || 0) / width)));
    if (!window.confirm(`删除第 ${pageIndex + 1} 页？本页内容会移到相邻页。`)) return;
    exitEditUi();
    const activeTheme = getActiveTheme(prefs).theme;
    const nextLayout = removeHomeLayoutPage(deriveLayoutFromDom(), pageIndex);
    await persistLayout(nextLayout, null, {
      homePageWallpapers: removeHomePageWallpaper(activeTheme.homePageWallpapers, pageIndex),
    });
    lastHomePageIndex = Math.max(0, Math.min(pageIndex, nextLayout.pages.length - 1));
    void closeEditMode({ rerender: true, persist: false });
  });

  container.querySelectorAll('[data-real-remove]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const itemId = String(btn.getAttribute('data-real-remove') || '').trim();
      if (!itemId) return;
      const active = getActiveTheme(prefs).theme;
      const current = normalizeHomeLayout(active.homeLayout, active.widgetVisibility);
      const nextVisibility = { ...(active.widgetVisibility || {}) };
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

  // 自定义组件换页：同页位置靠拖动，跨页用 ◀▶
  container.querySelectorAll('[data-widget-move]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const [itemId, dirRaw] = String(btn.getAttribute('data-widget-move') || '').split(':');
      const dir = Number(dirRaw) || 0;
      if (!itemId || !dir) return;
      const active = getActiveTheme(prefs).theme;
      const current = normalizeHomeLayout(active.homeLayout, active.widgetVisibility);
      const fromIndex = current.pages.findIndex((page) => page.includes(itemId));
      if (fromIndex < 0) return;
      const toIndex = Math.max(0, Math.min(current.pages.length - 1, fromIndex + dir));
      if (toIndex === fromIndex) return;
      const nextPages = current.pages.map((page) => page.filter((id) => id !== itemId));
      nextPages[toIndex] = [itemId, ...nextPages[toIndex]];
      await persistLayout({ ...current, pages: nextPages });
      void closeEditMode({ rerender: true, persist: false });
    });
  });

  let holdTimer = 0;
  let pressedPointerId = null;
  let pressStartX = 0;
  let pressStartY = 0;
  let suppressNextClick = false;
  const LONG_PRESS_MOVE_TOLERANCE = 10;
  function clearPendingPress(e) {
    if (e?.pointerId != null && pressedPointerId != null && e.pointerId !== pressedPointerId) return;
    window.clearTimeout(holdTimer);
    holdTimer = 0;
    // pointerup/cancel 才清 pressedPointerId；pointerleave 只取消长按计时，
    // 避免手指微移出图标就打断「已进入编辑后的立刻拖动」
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
  container.querySelectorAll('.app-item[data-home-longpress-item], .home-dock-slot[data-home-longpress-item], .app-grid .home-custom-widget[data-home-longpress-item], .app-grid .home-grid-builtin[data-home-longpress-item]').forEach((el) => {
    el.addEventListener('pointerdown', (e) => {
      if (e.target.closest('[data-mm-widget-controls], .home-widget-controls')) return;
      window.clearTimeout(holdTimer);
      pressedPointerId = e.pointerId;
      pressStartX = e.clientX;
      pressStartY = e.clientY;
      if (container.classList.contains('is-home-editing')) {
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
    el.addEventListener('pointerleave', (e) => {
      if (drag) return;
      window.clearTimeout(holdTimer);
      holdTimer = 0;
    });
  });
  window.addEventListener('pointerup', clearPendingPress, true);
  window.addEventListener('pointercancel', clearPendingPress, true);
  window.addEventListener('pointermove', cancelPendingPressOnMove, true);

  container.addEventListener('click', (e) => {
    if (!suppressNextClick) return;
    e.preventDefault();
    e.stopPropagation();
    suppressNextClick = false;
  }, true);

  let drag = null;

  // iOS：长按拖拽的触摸序列在进入编辑态之前就已开始，编辑态才加的 touch-action
  // 对这根手指无效，pointermove.preventDefault() 也取消不了原生滚动；只有直接
  // 取消 touchmove 才能拦住向下拖时触发的整页下拉刷新。拖拽期间全量拦截。
  const blockNativeTouchDuringDrag = (e) => {
    if (drag) e.preventDefault();
  };

  const sourceIsInDock = () => !!drag?.source?.closest('[data-home-dock]');
  const sourceIsCustomWidget = () => !!drag?.source?.matches?.('.home-custom-widget, .home-grid-builtin');
  const slotSelectorFor = (gridEl) => (gridEl?.matches?.('[data-home-dock]')
    ? '.home-dock-slot[data-home-longpress-item]'
    : '.app-item[data-home-longpress-item], .home-custom-widget[data-custom-widget-id], .home-grid-builtin[data-home-longpress-item]');
  const dropSlotSelector = '.app-item[data-home-longpress-item], .home-custom-widget[data-custom-widget-id], .home-grid-builtin[data-home-longpress-item], .app-drop-slot';

  // 收集某容器内可参与重排的兄弟槽位（排除正在拖动的源）
  function siblingSlots(gridEl) {
    if (!gridEl) return [];
    return Array.from(gridEl.querySelectorAll(slotSelectorFor(gridEl))).filter((el) => el !== drag.source);
  }

  // 指针下方可放置的网格：Dock 与桌面双向开放；跨区域时执行等量交换。
  function gridUnderPoint(x, y) {
    const dockEl = container.querySelector('[data-home-dock]');
    if (dockEl && !sourceIsCustomWidget()) {
      const r = dockEl.getBoundingClientRect();
      if (x >= r.left - 6 && x <= r.right + 6 && y >= r.top - 18 && y <= r.bottom + 18) return dockEl;
    }
    let hit = null;
    let bestWidgetOverlap = 0;
    const ghostRect = drag?.kind === 'widget' ? drag.ghost?.getBoundingClientRect?.() : null;
    container.querySelectorAll('.home-page .app-grid').forEach((g) => {
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
      // 上下各放宽一点，让靠近网格边缘也能落入
      if (x >= r.left - 6 && x <= r.right + 6 && y >= r.top - 28 && y <= r.bottom + 44) hit = g;
    });
    return hit;
  }

  function clearTransientDropSlots() {
    container.querySelectorAll('.app-drop-slot[data-transient-drop-slot]').forEach((el) => el.remove());
  }

  function materializeDropSlotGaps() {
    container.querySelectorAll('.home-page .app-grid').forEach((grid) => {
      const children = Array.from(grid.children);
      let lastContentIndex = -1;
      children.forEach((el, index) => {
        if (!el.matches?.('.app-drop-slot[data-transient-drop-slot]')) lastContentIndex = index;
      });
      children.forEach((el, index) => {
        if (index > lastContentIndex || !el.matches?.('.app-drop-slot[data-transient-drop-slot]')) return;
        el.removeAttribute('data-transient-drop-slot');
        if (!el.getAttribute('data-home-empty-slot')) el.setAttribute('data-home-empty-slot', createHomeEmptySlotId());
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
    if (el.matches?.('.app-item[data-home-longpress-item], .app-drop-slot')) return 1;
    return 0;
  }

  function ensureDropSlots() {
    clearTransientDropSlots();
    container.querySelectorAll('.home-page .app-grid').forEach((grid) => {
      const cols = gridColumnCount(grid);
      const minimum = cols * 5;
      const occupied = Array.from(grid.children).reduce((sum, el) => sum + gridCellWeight(el), 0);
      const count = Math.max(0, minimum - occupied);
      for (let i = 0; i < count; i += 1) {
        const slot = document.createElement('span');
        slot.className = 'app-drop-slot';
        slot.setAttribute('data-transient-drop-slot', '1');
        slot.setAttribute('aria-hidden', 'true');
        grid.appendChild(slot);
      }
    });
  }

  // 指针正下方的槽位（含源本身）。命中源时用于“保持不动”，根治来回抖
  function slotUnderPoint(gridEl, x, y) {
    const selector = gridEl?.matches?.('[data-home-dock]') ? slotSelectorFor(gridEl) : dropSlotSelector;
    const items = Array.from(gridEl.querySelectorAll(selector));
    for (let i = 0; i < items.length; i += 1) {
      const r = items[i].getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return items[i];
    }
    return null;
  }

  // 某槽位之后的下一个可排序兄弟（跳过源与非槽位节点）；null = 末尾
  function nextSlotAfter(el) {
    let node = el.nextElementSibling;
    const selector = slotSelectorFor(el?.parentElement);
    while (node && (node === drag.source || !node.matches(selector))) {
      node = node.nextElementSibling;
    }
    return node || null;
  }

  function gridColumnCount(gridEl) {
    if (!gridEl || gridEl.matches?.('[data-home-dock]')) return 1;
    const columns = String(window.getComputedStyle(gridEl).gridTemplateColumns || '')
      .split(/\s+/)
      .filter((item) => item && item !== 'none');
    return Math.max(1, columns.length || 4);
  }

  function emptyGridRefFromPoint(gridEl, x, y) {
    if (!gridEl || gridEl.matches?.('[data-home-dock]')) return null;
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
    if (!drag?.ghost || !gridEl || gridEl.matches?.('[data-home-dock]')) return null;
    const gridRect = gridEl.getBoundingClientRect();
    const ghostRect = drag.ghost.getBoundingClientRect();
    const style = window.getComputedStyle(gridEl);
    const cols = gridColumnCount(gridEl);
    const spanCols = Math.max(1, Math.min(cols, Number(drag.source.getAttribute('data-widget-cols')) || 1));
    const spanRows = Math.max(1, Number(drag.source.getAttribute('data-widget-rows')) || 1);
    const colGap = Number.parseFloat(style.columnGap || style.gap || '0') || 0;
    const rowGap = Number.parseFloat(style.rowGap || style.gap || '0') || 0;
    const colSize = Math.max(1, (gridRect.width - colGap * (cols - 1)) / cols);
    const rowSize = Math.max(1, Number.parseFloat(style.getPropertyValue('--mm-widget-grid-row-size')) || 82);
    const colStep = colSize + colGap;
    const rowStep = rowSize + rowGap;
    // 以预览组件的轮廓对格，而不是用手指坐标。大组件即使抓在中下部，也能一步放进首行。
    const col = Math.max(0, Math.min(cols - spanCols, Math.round((ghostRect.left - gridRect.left) / colStep)));
    const row = Math.max(0, Math.round((ghostRect.top - gridRect.top) / rowStep));
    const page = homePageEls().indexOf(gridEl.closest('.home-page'));
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

  // FLIP：记录旧位 → 改 DOM → 反向位移再过渡，制造“挤开 / 排齐”的滑动
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
    while (n && !n.matches(selector) && !n.matches('.app-drop-slot')) n = n.nextElementSibling;
    return n;
  }

  function setHandItemDockPresentation(item, inDock) {
    if (!item) return;
    item.classList.toggle('home-dock-slot', inDock);
    item.classList.toggle('app-item', !inDock);
    const btn = item.querySelector('.app-icon[data-app-id]');
    if (!btn) return;
    btn.classList.toggle('home-dock-icon', inDock);
    const label = item.querySelector('.app-label');
    if (inDock) {
      label?.remove();
    } else if (!label) {
      const nextLabel = document.createElement('span');
      nextLabel.className = 'app-label';
      nextLabel.textContent = btn.getAttribute('aria-label') || btn.getAttribute('data-app-id') || '';
      item.appendChild(nextLabel);
    }
  }

  function swapAcrossDock(target) {
    const source = drag?.source;
    if (!source || !target || source === target) return;
    const sourceParent = source.parentElement;
    const targetParent = target.parentElement;
    if (!sourceParent || !targetParent || sourceParent === targetParent) return;
    const sourceMarker = document.createComment('home-dock-source');
    const targetMarker = document.createComment('home-dock-target');
    sourceParent.insertBefore(sourceMarker, source);
    targetParent.insertBefore(targetMarker, target);
    sourceMarker.replaceWith(target);
    targetMarker.replaceWith(source);
    setHandItemDockPresentation(source, !!source.closest('[data-home-dock]'));
    setHandItemDockPresentation(target, !!target.closest('[data-home-dock]'));
    drag.dock = sourceIsInDock();
  }

  function swapSourceWithTarget(gridEl, target) {
    const source = drag?.source;
    if (!source || !target || source === target) return;
    const sourceParent = source.parentElement;
    const targetParent = target.parentElement;
    if (!sourceParent || !targetParent) return;
    flipReorder(gridEl, () => {
      const sourceMarker = document.createComment('home-grid-source');
      const targetMarker = document.createComment('home-grid-target');
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
        const firstDrop = gridEl.querySelector('.app-drop-slot');
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
      const marker = document.createComment('home-drop-swap');
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
      const marker = document.createComment('home-widget-origin');
      sourceParent.insertBefore(marker, source);
      gridEl.insertBefore(source, target);
      // 目标矩形内的内容作为一个整体移到源组件腾出的区域，避免不同尺寸只交换一个节点。
      conflicts.forEach((el) => marker.parentNode?.insertBefore(el, marker));
      marker.remove();
    });
  }

  const CROSS_PAGE_DROP_DWELL_MS = 280;
  const TARGET_DROP_DWELL_MS = 120;

  function pointerInPagingBand(x) {
    if (!pages) return false;
    const rect = pages.getBoundingClientRect();
    return x > rect.right - 24 || x < rect.left + 24;
  }

  function pageIndexForGrid(gridEl) {
    return homePageEls().indexOf(gridEl?.closest?.('.home-page'));
  }

  function resetDropIntent() {
    if (!drag) return;
    drag.crossPageCandidate = -1;
    drag.crossPageSince = 0;
    drag.hoverTarget = null;
    drag.hoverSince = 0;
  }

  function crossPageDropReady(gridEl, x, force) {
    if (!drag || force || gridEl.matches?.('[data-home-dock]')) return true;
    if (pointerInPagingBand(x)) {
      resetDropIntent();
      return false;
    }
    const sourcePage = pageIndexForGrid(drag.source.parentElement);
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

  function targetDropReady(gridEl, target, force) {
    if (!drag || force || drag.kind !== 'app' || !target || target === drag.source || target.matches?.('.app-drop-slot')) return true;
    const key = `${pageIndexForGrid(gridEl)}:${target.getAttribute('data-home-longpress-item') || target.getAttribute('data-custom-widget-id') || ''}`;
    const now = performance.now();
    if (drag.hoverTarget !== key) {
      drag.hoverTarget = key;
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
    const pageReady = crossPageDropReady(gridEl, x, force);
    const targetReady = targetDropReady(gridEl, over, force);
    if (!pageReady || !targetReady) return;
    const targetIsDock = !!gridEl.matches?.('[data-home-dock]');
    if (sourceIsCustomWidget() && targetIsDock) return;
    if (sourceIsInDock() && over?.matches?.('.home-custom-widget, .home-grid-builtin')) return;
    if (sourceIsCustomWidget() && !targetIsDock) {
      moveWidgetToPlacement(gridEl, widgetPlacementFor(gridEl));
      return;
    }
    if (sourceIsInDock() !== targetIsDock) {
      if (over && !over.matches('.app-drop-slot') && !over.matches('.home-custom-widget, .home-grid-builtin')) swapAcrossDock(over);
      return;
    }
    // 指针仍停在“占位空格”（源）上：保持不动，根治图标来回横跳
    if (over === drag.source) return;
    if (over) {
      if (over.matches('.app-drop-slot') || over.matches('.home-custom-widget, .home-grid-builtin') || drag.source.matches('.home-custom-widget, .home-grid-builtin')) {
        moveSourceIntoDropSlot(gridEl, over);
        return;
      }
      // App 对 App 使用两两交换；插入排序会把两点之间的一整段图标都推走，
      // 手指看起来像同时拖动了多个图标。
      swapSourceWithTarget(gridEl, over);
      return;
    }
    // 没压在任何图标上：只有明显落到该网格末尾空白处才追加，避免空隙里乱跳
    const rest = siblingSlots(gridEl);
    if (!rest.length) { moveSourceTo(gridEl, null); return; }
    const emptyRef = emptyGridRefFromPoint(gridEl, x, y);
    if (emptyRef) {
      if (emptyRef.matches('.app-drop-slot') || emptyRef.matches('.home-custom-widget, .home-grid-builtin')) moveSourceIntoDropSlot(gridEl, emptyRef);
      else swapSourceWithTarget(gridEl, emptyRef);
      return;
    }
    const last = rest[rest.length - 1].getBoundingClientRect();
    if (y > last.bottom || (y >= last.top && x > last.right)) moveSourceTo(gridEl, null);
  }

  function homePageEls() {
    return Array.from(container.querySelectorAll('.home-pages-container > .home-page'));
  }
  function setDotCount(n) {
    const row = container.querySelector('.home-indicators');
    if (!row) return;
    let cur = row.querySelectorAll('.dot').length;
    while (cur < n) { const d = document.createElement('div'); d.className = 'dot'; row.appendChild(d); cur += 1; }
    while (cur > n && row.lastElementChild) { row.lastElementChild.remove(); cur -= 1; }
  }
  // 新建一页用户自建的纯 App 分页（达到上限则不建）
  function appendExtraPage() {
    const count = homePageEls().length;
    if (count >= MAX_HOME_PAGES) return null;
    const wrap = container.querySelector('.home-pages-container');
    if (!wrap) return null;
    const pageEl = document.createElement('div');
    pageEl.className = 'home-page page-extra';
    pageEl.setAttribute('data-home-page', String(count + 1));
    const grid = document.createElement('div');
    grid.className = 'app-grid page-extra-grid';
    pageEl.appendChild(grid);
    wrap.appendChild(pageEl);
    if (container.classList.contains('is-home-editing')) ensureDropSlots();
    setDotCount(count + 1);
    renderSeaWallpaperLayer(container, theme);
    if (pages) updateSeaWallpaperCrossfade(container, pages.scrollLeft, pages.clientWidth);
    return pageEl;
  }
  // 拖动结束后回收尾部连续空页；用户仍可通过删除按钮移除任意非末尾空页。
  function pruneEmptyExtraPages() {
    const els = homePageEls();
    for (let i = els.length - 1; i >= 1; i -= 1) {
      const grid = els[i].querySelector('.app-grid');
      if (grid && (grid.querySelector('.app-item[data-home-longpress-item]') || grid.querySelector('.home-custom-widget') || grid.querySelector('.home-grid-builtin'))) break;
      els[i].remove();
    }
    setDotCount(homePageEls().length);
    renderSeaWallpaperLayer(container, theme);
    if (pages) {
      const w = pages.clientWidth || 1;
      const maxIndex = homePageEls().length - 1;
      const idx = Math.max(0, Math.min(maxIndex, Math.round(pages.scrollLeft / w)));
      pageScrollGuard?.setAnchor(idx);
      pages.scrollTo({ left: idx * w });
      container.querySelectorAll('.home-indicators .dot').forEach((d, i) => d.classList.toggle('active', i === idx));
      lastHomePageIndex = idx;
      updateSeaWallpaperCrossfade(container, pages.scrollLeft, w);
    }
  }

  // 翻页改为“边缘停留触发”：在左右边缘停约 0.5s 才翻一页；在最后一页继续右拖会自动新建一页
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
    if (autoPage.dir === dir && autoPage.timer) return; // 已在该方向计时，停满才翻
    cancelAutoPage();
    autoPage.dir = dir;
    autoPage.timer = window.setTimeout(() => {
      autoPage.timer = 0;
      resetDropIntent();
      const pageWidth = pages.clientWidth || rect.width || 1;
      const cur = Math.round(pages.scrollLeft / pageWidth);
      const total = homePageEls().length;
      if (dir > 0 && cur >= total - 1) {
        // 仅当最后一页已有图标（排除正拖动的源）才新建，避免按住边缘连环建空页
        const lastGrid = homePageEls()[total - 1]?.querySelector('.app-grid');
        const lastApps = lastGrid
          ? Array.from(lastGrid.querySelectorAll('.app-item[data-home-longpress-item]')).filter((el) => el !== drag.source)
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

  // 拖动结束后反推布局：骨架级原生件保留页位；网格内含 App / 空槽 / 自定义 / 可拖原生件
  function deriveLayoutFromDom() {
    const activeTheme = getActiveTheme(prefs).theme;
    const current = normalizeHomeLayout(activeTheme.homeLayout, activeTheme.widgetVisibility);
    const nextPages = homePageEls().map((pageEl, i) => {
      const skeletonIds = (current.pages[i] || []).filter((id) => BUILTIN_HOME_WIDGET_DEFS[id] && !isHomeGridBuiltinId(id));
      const grid = pageEl.querySelector('.app-grid');
      const gridIds = grid ? Array.from(grid.children).map((el) => {
        if (el.matches('.home-custom-widget[data-custom-widget-id]')) {
          return String(el.getAttribute('data-custom-widget-id') || '').trim();
        }
        if (el.matches('.home-grid-builtin[data-home-longpress-item], .app-item[data-home-longpress-item]')) {
          return String(el.getAttribute('data-home-longpress-item') || '').trim();
        }
        if (el.matches('.app-drop-slot')) {
          if (el.hasAttribute('data-transient-drop-slot')) return '';
          return String(el.getAttribute('data-home-empty-slot') || createHomeEmptySlotId()).trim();
        }
        return '';
      }).filter(Boolean) : [];
      while (gridIds.length && isHomeEmptySlotId(gridIds[gridIds.length - 1])) gridIds.pop();
      return [...skeletonIds, ...gridIds];
    });
    const dock = Array.from(container.querySelectorAll('[data-home-dock] .home-dock-slot[data-home-longpress-item]'))
      .map((el) => String(el.getAttribute('data-home-longpress-item') || '').trim())
      .filter(Boolean);
    return { ...current, pages: nextPages, dock };
  }

  function clearReorderInlineStyles() {
    container.querySelectorAll('.app-item, .home-dock-slot, .home-custom-widget, .home-grid-builtin').forEach((el) => {
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
    container.classList.remove('is-reordering');
    cancelAutoPage();
    window.removeEventListener('pointermove', moveRealDrag);
    window.removeEventListener('pointerup', finishRealDrag);
    window.removeEventListener('pointercancel', cancelRealDrag);
    document.removeEventListener('touchmove', blockNativeTouchDuringDrag, true);
    clearReorderInlineStyles();
    if (persist) {
      pruneEmptyExtraPages();
      await persistLayout(deriveLayoutFromDom());
    }
  }

  function startRealDrag(source, e) {
    if (!container.classList.contains('is-home-editing')) return;
    if (e.button != null && e.button !== 0) return;
    if (pressedPointerId !== e.pointerId) return;
    if (e.target.closest('[data-mm-widget-controls], .home-widget-controls')) return;
    window.clearTimeout(holdTimer);
    if (drag) void abortRealDrag();
    e.preventDefault();
    const rect = source.getBoundingClientRect();
    const itemId = String(source.getAttribute('data-home-longpress-item') || source.getAttribute('data-custom-widget-id') || '').trim();
    // 主题骨架级内置件（不在 HOME_GRID_BUILTIN_IDS）仍不可拖；网格内原生组件可以
    if (BUILTIN_HOME_WIDGET_DEFS[itemId] && !isHomeGridBuiltinId(itemId) && !source.closest('[data-home-dock]')) return;
    const ghost = source.cloneNode(true);
    ghost.classList.add('home-real-drag-ghost');
    ghost.style.width = `${rect.width}px`;
    ghost.style.height = `${rect.height}px`;
    ghost.style.left = `${rect.left}px`;
    ghost.style.top = `${rect.top}px`;
    document.body.appendChild(ghost);
    drag = {
      source,
      ghost,
      itemId,
      dock: !!source.closest('[data-home-dock]'),
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
    container.classList.add('is-reordering');
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
    render(container);
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
    container.classList.remove('is-reordering');
    cancelAutoPage();
    window.removeEventListener('pointermove', moveRealDrag);
    window.removeEventListener('pointerup', finishRealDrag);
    window.removeEventListener('pointercancel', cancelRealDrag);
    document.removeEventListener('touchmove', blockNativeTouchDuringDrag, true);
    clearReorderInlineStyles();
    pruneEmptyExtraPages();
    await persistLayout(deriveLayoutFromDom());
  }

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
}
