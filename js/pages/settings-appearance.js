import {
  back,
  navigate,
  setLeaveGuard,
  clearLeaveGuard,
} from '../core/router.js';
import { shareToCommunityStore } from '../core/community-share-draft.js';
import { buildHomeWidgetSharePayload } from '../core/home-widget-share.js';
import { icon } from '../components/svg-icons.js';
import { showToast } from '../components/toast.js';
import { openTextEditorModal } from '../components/text-editor-modal.js';
import { fileToCroppedCompressedDataUrl, IMAGE_CROP_PRESETS } from '../components/image-crop-modal.js';
import {
  loadAppearancePrefs,
  saveAppearancePrefs,
  getActiveTheme,
  DEFAULT_THEME_ID,
  PLACEHOLDER_THEME_ID,
  DEFAULT_APP_LABELS,
  DEFAULT_WALLPAPER_PATH,
  WALLPAPER_NONE,
  DEFAULT_WALLPAPER_OVERLAY,
  MIN_CHAT_BUBBLE_FONT_SIZE,
  MAX_CHAT_BUBBLE_FONT_SIZE,
  applyThemeWallpaperToElement,
  applyHomePageWallpaperToElement,
  resolveWallpaperUrl,
  resolveHomePageWallpaperUrl,
  replaceThemeHomeWallpaper,
  applyAppearanceTheme,
  applyChatBubbleFontSize,
  applyCustomTheme,
  applyAppIconEdge,
  applyWindowFrame,
  applyAlbumGrayFilter,
  isAppIconEdgeEnabled,
  isWindowFrameEnabled,
  isAlbumGrayFilterEnabled,
  getAppIconFrameOpacity,
  getThemeBuiltinWallpaperDefaults,
  getThemeFontConfig,
  getChatBubbleFontSize,
  clampChatBubbleFontSize,
  getCustomThemeConfig,
  getWidgetVisibility,
  isFontFile,
  MAX_CUSTOM_FONT_BYTES,
  normalizeFontDataUrl,
  resolveCustomFontUrl,
  verifyFontUrlLoadable,
  listThemePresets,
  saveCurrentThemeAsPreset,
  createThemePresetFromSnapshot,
  switchActiveThemePreset,
  deleteThemePreset,
  normalizeHomeLayout,
  removeHomeWidgetLibraryItem,
  upsertHomeWidgetLibraryItem,
  BUILTIN_HOME_WIDGET_DEFS,
  getHomeWidgetSlotsForTheme,
  isSeaHomeTheme,
  isAlbumHomeTheme,
  resolveHomeTemplateKey,
  themeHasOversizedImages,
  compactOversizedAppearanceImages,
  isHeavyAppearancePreviewUrl,
  DEFAULT_SEA_GRADIENT_WARM,
  DEFAULT_SEA_GRADIENT_COOL,
  DEFAULT_SEA_GRADIENT_STRENGTH,
  getSeaGradientOverlayDefaults,
  DEFAULT_SEA_MUSIC_BG,
  DEFAULT_SEA_MUSIC_BG_OPACITY,
  DEFAULT_SEA_MUSIC_TEXT,
  DEFAULT_SEA_MUSIC_ACCENT,
  resolveSeaMusicColors,
} from '../core/appearance-prefs.js';
import {
  PAGE_ONE_APPS,
  PAGE_TWO_APPS,
  PAGE_THREE_APPS,
  PAGE_FOUR_APPS,
  PAGE_FIVE_APPS,
  DOCK_APPS,
  getIconSvg,
} from '../data/home-layout.js';
import { TOGETHER_GROUP_APPS } from '../data/home-app-groups.js';
import {
  HOME_THEME_TEXT_VARS_BY_TEMPLATE,
  MAX_CUSTOM_CSS_BYTES,
} from '../data/appearance-theme-contract.js';
import {
  buildPortableThemeExportPayload,
  downloadAiThemeReference,
  downloadThemeExportPayload,
  downloadTextFile,
  parseThemeImportText,
  restoreDefaultAppearanceTheme,
} from '../core/appearance-theme-export.js';
import {
  buildChatAppearanceReferenceMarkdown,
  clearChatSessionCss,
  listChatsWithSessionCss,
  repairChatSessionMessageLayout,
  withChatMessageLayoutRepair,
} from '../core/chat-appearance.js';
import { clearOfflineStyleCss } from '../core/offline-appearance.js';
import { getCurrentUserId } from '../core/user-slot.js';

const SHOPPING_GROUP_APPS = [
  { id: 'mcd-cn', label: '麦当劳', icon: '<img src="assets/icons/shopping/mcdonalds.png" alt="">' },
  { id: 'luckin-cn', label: '瑞幸咖啡', icon: '<img src="assets/icons/shopping/luckin.png" alt="">' },
  { id: 'meituan-cn', label: '美团', icon: '<img src="assets/icons/shopping/meituan-app.png" alt="">' },
];
const GROUP_CHILD_APP_DEFS = new Map(
  [...TOGETHER_GROUP_APPS, ...SHOPPING_GROUP_APPS].map((app) => [app.id, app]),
);
const EDITABLE_APP_IDS = [
  ...PAGE_ONE_APPS, ...PAGE_TWO_APPS, ...PAGE_THREE_APPS, ...PAGE_FOUR_APPS, ...PAGE_FIVE_APPS, ...DOCK_APPS,
  ...GROUP_CHILD_APP_DEFS.keys(),
]
  .filter((id, index, arr) => arr.indexOf(id) === index);
const HOME_PAGE_WALLPAPER_PAGES = 6;

function editableAppDefaultLabel(appId = '') {
  return GROUP_CHILD_APP_DEFS.get(appId)?.label || DEFAULT_APP_LABELS[appId] || appId;
}

function editableAppDefaultIcon(appId = '') {
  return GROUP_CHILD_APP_DEFS.get(appId)?.icon || getIconSvg(appId);
}

function canRunLegacyAppearanceCompaction() {
  if (typeof navigator === 'undefined') return true;
  if (globalThis.Capacitor?.isNativePlatform?.() || globalThis.Capacitor?.getPlatform?.() === 'android') {
    return false;
  }
  const ua = String(navigator.userAgent || '');
  const platform = String(navigator.platform || '');
  const touchPoints = Number(navigator.maxTouchPoints || 0);
  return !/Android|iPhone|iPad|iPod/i.test(ua)
    && !(/Mac/i.test(platform) && touchPoints > 1);
}

const SEA_WIDGET_DEFAULTS = {
  seaWeather: '海风 24° · 波光正好',
  seaPortraitLine1: '与你相遇的每一天',
  seaPortraitLine2: '今天也想见到你 🌊',
  seaCharCaption: '今天想见的人',
  seaP2FloatLine1: '金光铺在海面上',
  seaP2FloatLine2: 'tides keep the quiet things',
  seaAtmoSub: '· 停泊在海边',
  seaPolaroidFrontCaption: '我的小记',
  seaPostcardCaption: '来自海边的一页',
};

const SEA_TEXT_FIELDS = [
  ['seaWeather', '天气 / 心情'],
  ['seaPortraitLine1', '头像文案 1'],
  ['seaPortraitLine2', '头像文案 2'],
  ['seaCharCaption', '相册标题'],
  ['seaP2FloatLine1', '第二页文案 1'],
  ['seaP2FloatLine2', '第二页文案 2'],
  ['seaAtmoSub', '记录页副标题'],
  ['seaPolaroidFrontCaption', '拍立得说明'],
  ['seaPostcardCaption', '明信片说明'],
];

const SEA_IMAGE_FIELDS = [
  ['seaPortraitAvatar', '海边头像'],
  ['seaCharTall', 'char 立绘'],
  ['seaP2Orb', '第二页圆图'],
  ['seaPolaroidFront', '拍立得照片'],
  ['seaPostcard', '明信片照片'],
];

function renderThemePresetSection(prefs) {
  const presets = listThemePresets(prefs);
  const chips = presets.map((item) => `
    <span class="appearance-theme-chip-wrap${item.isBuiltin ? '' : ' is-deletable'}">
      <button type="button" class="appearance-theme-chip ${item.isActive ? 'is-active' : ''}" data-theme-switch="${esc(item.id)}">${esc(item.name)}</button>
      ${item.isBuiltin ? '' : '<button type="button" class="appearance-theme-chip-del" data-theme-delete="' + esc(item.id) + '" aria-label="删除' + esc(item.name) + '主题">×</button>'}
    </span>
  `).join('');
  const placeholder = prefs.themes?.[PLACEHOLDER_THEME_ID];
  const showPlaceholder = !placeholder || placeholder.ready === false;
  return `
    <div class="appearance-theme-row" data-theme-chips>
      ${chips}
      ${showPlaceholder ? `<button type="button" class="appearance-theme-chip is-disabled" disabled>棉花糖之海</button>` : ''}
    </div>
    <div class="appearance-preset-save-row">
      <input type="text" class="appearance-input" data-preset-name maxlength="24" placeholder="预设名称">
      <button type="button" class="btn btn-outline btn-sm" data-save-preset>保存为预设</button>
    </div>
  `;
}

function esc(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 把 CSS 颜色尽量转成 <input type=color> 能显示的 #rrggbb；rgba/具名色取其 RGB，渐变/var() 等返回空。 */
function cssColorToHex(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  let m = raw.match(/^#([0-9a-f]{6})$/i);
  if (m) return ('#' + m[1]).toLowerCase();
  m = raw.match(/^#([0-9a-f]{3})$/i);
  if (m) return ('#' + m[1].split('').map((c) => c + c).join('')).toLowerCase();
  m = raw.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/i);
  if (m) {
    const hex = [m[1], m[2], m[3]]
      .map((n) => Math.max(0, Math.min(255, Number(n))).toString(16).padStart(2, '0'))
      .join('');
    return ('#' + hex).toLowerCase();
  }
  return '';
}

/** 把用户手填的色号规范成 #rrggbb（接受 #?rgb / #?rrggbb，允许省略 #）；非法返回 ''。 */
function normalizeHexText(value) {
  let raw = String(value || '').trim();
  if (!raw) return '';
  if (raw[0] !== '#') raw = '#' + raw;
  let m = raw.match(/^#([0-9a-f]{6})$/i);
  if (m) return ('#' + m[1]).toLowerCase();
  m = raw.match(/^#([0-9a-f]{3})$/i);
  if (m) return ('#' + m[1].split('').map((c) => c + c).join('')).toLowerCase();
  return '';
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}

/**
 * 手机相机直出图不做压缩就存成 base64，累积几张就能把整套主题拖到几十 MB——
 * 美化设置页要一次性把所有图片拼进一段 innerHTML，字符串越大越容易在低内存机型上把
 * WebView 渲染进程直接闷死（表现为「进美化页就闪退」）。这里统一在写入前用 canvas 降尺寸再编码。
 */
function compressImageToDataUrl(file, { maxSize = 1280, quality = 0.85, preserveAlpha = false } = {}) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const longest = Math.max(img.width || maxSize, img.height || maxSize);
        const scale = Math.min(1, maxSize / longest);
        const w = Math.max(1, Math.round((img.width || maxSize) * scale));
        const h = Math.max(1, Math.round((img.height || maxSize) * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        resolve(preserveAlpha ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', quality));
      } catch (err) {
        URL.revokeObjectURL(url);
        reject(err);
      }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片读取失败')); };
    img.src = url;
  });
}

function field(label, inner) {
  return `
    <label class="appearance-field">
      <span class="appearance-field-label">${esc(label)}</span>
      ${inner}
    </label>
  `;
}

function renderWidgetRowLabel(slot) {
  const placement = String(slot.placement || '').trim();
  return `
    <span class="appearance-widget-row-main">
      <span class="appearance-widget-name">${esc(slot.label)}</span>
      ${placement ? `<span class="appearance-widget-placement">${esc(placement)}</span>` : ''}
    </span>
  `;
}

function renderWidgetManager(themeId, theme, selectedWidgetIds = new Set()) {
  const vis = getWidgetVisibility(theme);
  const layout = normalizeHomeLayout(theme?.homeLayout, theme?.widgetVisibility);
  const slots = getHomeWidgetSlotsForTheme(themeId, theme);
  const active = slots.filter((slot) => vis[slot.id] !== false);
  const deleted = slots.filter((slot) => vis[slot.id] === false);
  const customItems = Object.values(layout.customItems || {});
  const placedCustomIds = new Set(layout.pages.flat());
  return `
    <div class="appearance-widget-manager" data-widget-manager>
      <div class="appearance-widget-list">
        ${active.length ? active.map((slot) => `
          <div class="appearance-widget-row">
            ${renderWidgetRowLabel(slot)}
            <button type="button" class="btn btn-soft btn-sm" data-widget-delete="${esc(slot.id)}">删除</button>
          </div>
        `).join('') : '<div class="appearance-widget-empty">装饰组件已全部删除</div>'}
      </div>
      <div class="appearance-widget-deleted">
        <div class="appearance-widget-deleted-label">组件库</div>
        ${customItems.length ? customItems.map((item) => `
          <div class="appearance-widget-row">
            <label class="appearance-widget-select">
              <input type="checkbox" data-custom-widget-select="${esc(item.id)}" ${selectedWidgetIds.has(item.id) ? 'checked' : ''}>
              <span>${esc(item.label || item.title || '自定义组件')}<small class="appearance-widget-placement">${placedCustomIds.has(item.id) ? '当前主题·主屏中' : '未放入当前主题'}</small></span>
            </label>
            <span class="appearance-widget-row-actions">
              <button type="button" class="btn btn-outline btn-sm" data-custom-widget-home="${esc(item.id)}:${placedCustomIds.has(item.id) ? 'hide' : 'show'}">${placedCustomIds.has(item.id) ? '移出当前主题' : '添加到当前主题'}</button>
              <button type="button" class="btn btn-outline btn-sm" data-custom-widget-edit="${esc(item.id)}">编辑</button>
              <button type="button" class="btn btn-soft btn-sm" data-custom-widget-delete="${esc(item.id)}">永久删除</button>
            </span>
          </div>
        `).join('') : '<div class="appearance-widget-empty">还没有自定义组件</div>'}
        ${customItems.length ? `
          <div class="appearance-widget-share-bar">
            <span data-widget-selected-count>已选 ${selectedWidgetIds.size} 个</span>
            <button type="button" class="btn btn-outline btn-sm" data-custom-widget-select-all>${selectedWidgetIds.size === customItems.length ? '取消全选' : '全选'}</button>
            <button type="button" class="btn btn-primary btn-sm" data-custom-widget-share ${selectedWidgetIds.size ? '' : 'disabled'}>分享到应用商店</button>
          </div>
        ` : ''}
        <div class="appearance-widget-add-row">
          <button type="button" class="btn btn-outline btn-sm" data-custom-widget-add>新增便签</button>
          <button type="button" class="btn btn-outline btn-sm" data-custom-widget-add-code>新增代码组件</button>
        </div>
      </div>
      ${deleted.length ? `
        <div class="appearance-widget-deleted">
          <div class="appearance-widget-deleted-label">已删除 · 可恢复</div>
          ${deleted.map((slot) => `
            <div class="appearance-widget-row">
              ${renderWidgetRowLabel(slot)}
              <button type="button" class="btn btn-outline btn-sm" data-widget-restore="${esc(slot.id)}">恢复</button>
            </div>
          `).join('')}
        </div>
      ` : ''}
    </div>
  `;
}

function renderHomeTextColorFields(theme) {
  const template = resolveHomeTemplateKey(theme);
  const defs = HOME_THEME_TEXT_VARS_BY_TEMPLATE[template] || HOME_THEME_TEXT_VARS_BY_TEMPLATE.scrapbook;
  const saved = (theme?.customTheme?.homeTextVars) || {};
  return `
    <div class="appearance-token-grid">
      ${defs.map((item) => {
    const original = String(saved[item.key] || '').trim();
    const seed = cssColorToHex(original) || cssColorToHex(item.default) || '#cccccc';
    return `
          <label class="appearance-token-item">
            <span class="appearance-token-label">${esc(item.label)}</span>
            <input type="color" class="appearance-color-input" data-home-text-var="${esc(item.key)}" data-css-default="${esc(item.default)}" data-css-original="${esc(original)}" data-css-seed="${esc(seed)}" value="${esc(seed)}" />
            <input type="text" class="appearance-color-hex" data-home-text-hex="${esc(item.key)}" value="${esc(seed)}" maxlength="7" spellcheck="false" autocapitalize="off" autocomplete="off" aria-label="${esc(item.label)} 色号" placeholder="#rrggbb" />
            <code>${esc(item.key)}</code>
          </label>
        `;
  }).join('')}
    </div>
  `;
}

function renderAppIconGrid(theme) {
  const icons = (theme && theme.appIcons) || {};
  const labels = (theme && theme.appLabels) || {};
  const edgeOn = isAppIconEdgeEnabled(theme);
  const frameOpacity = getAppIconFrameOpacity(theme);
  return `
    <div class="appearance-panel-stack">
      <div class="appearance-icon-frame-controls">
        <label class="appearance-toggle-item">
          <input type="checkbox" data-app-icon-edge ${edgeOn ? 'checked' : ''} />
          <span>显示底框</span>
        </label>
        <label class="appearance-icon-opacity-control${edgeOn ? '' : ' is-disabled'}">
          <span>底框透明度</span>
          <input type="range" class="appearance-range" data-app-icon-frame-opacity min="0" max="1" step="0.05" value="${frameOpacity}" ${edgeOn ? '' : 'disabled'}>
          <output data-app-icon-frame-opacity-value>${Math.round(frameOpacity * 100)}%</output>
        </label>
      </div>
      <div class="appearance-icon-grid">
        ${EDITABLE_APP_IDS.map((appId) => {
    const custom = String(icons[appId] || '').trim();
    const hasCustom = !!custom;
    const defaultLabel = editableAppDefaultLabel(appId);
    const currentLabel = String(labels[appId] || defaultLabel).trim() || defaultLabel;
    return `
          <article class="appearance-icon-item" data-app-icon-row="${esc(appId)}">
            <div class="appearance-icon-preview" aria-hidden="true"${hasCustom ? ` data-app-icon-lazy="${esc(appId)}"` : ''}>
              <span class="appearance-icon-svg">${editableAppDefaultIcon(appId)}</span>
            </div>
            <div class="appearance-icon-meta">
              <small data-app-icon-status>${custom ? '已替换' : '默认图标'}</small>
              <input type="text" class="appearance-icon-name" data-app-label="${esc(appId)}" value="${esc(currentLabel)}" maxlength="12" aria-label="${esc(defaultLabel)}的显示名称">
            </div>
            <div class="appearance-icon-actions">
              <label class="btn btn-outline btn-sm appearance-file-btn">
                换图
                <input type="file" accept="image/*" data-app-icon-file="${esc(appId)}" hidden>
              </label>
              <button type="button" class="btn btn-soft btn-sm" data-app-icon-clear="${esc(appId)}" ${custom ? '' : 'disabled'}>恢复</button>
            </div>
          </article>
        `;
  }).join('')}
      </div>
    </div>
  `;
}

function renderSeaGradientPanel(theme) {
  const defaults = getSeaGradientOverlayDefaults();
  const enabled = theme?.seaGradientOverlayEnabled !== false;
  const strength = Number(theme?.seaGradientStrength);
  const warm = String(theme?.seaGradientWarmColor || defaults.seaGradientWarmColor);
  const cool = String(theme?.seaGradientCoolColor || defaults.seaGradientCoolColor);
  const strengthValue = Number.isFinite(strength) ? strength : DEFAULT_SEA_GRADIENT_STRENGTH;
  return `
    <section class="settings-group">
      <div class="settings-group-title">海主题渐变遮罩</div>
      <p class="appearance-group-hint">主屏顶/底那层暖黄与浅蓝渐变。关掉或调淡后壁纸会更透亮。</p>
      <div class="appearance-panel">
        <label class="appearance-toggle-item">
          <input type="checkbox" data-sea-gradient-enabled ${enabled ? 'checked' : ''} />
          <span>启用渐变遮罩</span>
        </label>
        ${field('遮罩强度', `<input type="range" class="appearance-range" data-sea-gradient-strength min="0" max="1.5" step="0.05" value="${strengthValue}">`)}
        <div class="appearance-token-grid">
          <label class="appearance-token-item">
            <span class="appearance-token-label">暖色（顶/底）</span>
            <input type="color" class="appearance-color-input" data-sea-gradient-warm value="${warm}" />
            <input type="text" class="appearance-color-hex" data-sea-gradient-warm-hex value="${warm}" maxlength="7" spellcheck="false" autocapitalize="off" autocomplete="off" aria-label="暖色色号" placeholder="#rrggbb" />
          </label>
          <label class="appearance-token-item">
            <span class="appearance-token-label">冷色（中段）</span>
            <input type="color" class="appearance-color-input" data-sea-gradient-cool value="${cool}" />
            <input type="text" class="appearance-color-hex" data-sea-gradient-cool-hex value="${cool}" maxlength="7" spellcheck="false" autocapitalize="off" autocomplete="off" aria-label="冷色色号" placeholder="#rrggbb" />
          </label>
        </div>
        <div class="appearance-actions">
          <button type="button" class="btn btn-soft" data-sea-gradient-reset>恢复默认遮罩</button>
        </div>
      </div>
    </section>
  `;
}

function renderWindowDisplayPanel(theme) {
  if (resolveHomeTemplateKey(theme) !== 'window') return '';
  return `
    <section class="settings-group">
      <div class="settings-group-title">窗主题显示</div>
      <div class="appearance-panel">
        <label class="appearance-toggle-item">
          <input type="checkbox" data-window-frame-enabled ${isWindowFrameEnabled(theme) ? 'checked' : ''} />
          <span>显示白色窗框</span>
        </label>
      </div>
    </section>
  `;
}

function renderAlbumDisplayPanel(theme) {
  return `
    <section class="settings-group">
      <div class="settings-group-title">相册显示</div>
      <div class="appearance-panel">
        <label class="appearance-toggle-item">
          <input type="checkbox" data-album-gray-filter-enabled ${isAlbumGrayFilterEnabled(theme) ? 'checked' : ''} />
          <span>显示旧版灰雾滤镜</span>
        </label>
      </div>
    </section>
  `;
}

function collectSeaGradientDraft(container, nextTheme) {
  const enabledInput = container.querySelector('[data-sea-gradient-enabled]');
  const strengthInput = container.querySelector('[data-sea-gradient-strength]');
  const warmInput = container.querySelector('[data-sea-gradient-warm]');
  const coolInput = container.querySelector('[data-sea-gradient-cool]');
  if (!enabledInput && !strengthInput && !warmInput && !coolInput) return nextTheme;
  if (enabledInput) nextTheme.seaGradientOverlayEnabled = !!enabledInput.checked;
  if (strengthInput) nextTheme.seaGradientStrength = Number(strengthInput.value);
  if (warmInput) nextTheme.seaGradientWarmColor = String(warmInput.value || DEFAULT_SEA_GRADIENT_WARM);
  if (coolInput) nextTheme.seaGradientCoolColor = String(coolInput.value || DEFAULT_SEA_GRADIENT_COOL);
  return nextTheme;
}

function bindSeaGradientControls(container, prefsRef, onDraftChange) {
  const syncColorPair = (colorInput, hexInput) => {
    if (!colorInput || !hexInput) return;
    colorInput.addEventListener('input', () => {
      hexInput.value = colorInput.value;
      onDraftChange();
    });
    hexInput.addEventListener('change', () => {
      const next = String(hexInput.value || '').trim();
      if (/^#[0-9a-fA-F]{6}$/.test(next)) colorInput.value = next;
      onDraftChange();
    });
  };
  syncColorPair(
    container.querySelector('[data-sea-gradient-warm]'),
    container.querySelector('[data-sea-gradient-warm-hex]'),
  );
  syncColorPair(
    container.querySelector('[data-sea-gradient-cool]'),
    container.querySelector('[data-sea-gradient-cool-hex]'),
  );
  container.querySelector('[data-sea-gradient-enabled]')?.addEventListener('change', onDraftChange);
  container.querySelector('[data-sea-gradient-strength]')?.addEventListener('input', onDraftChange);
  container.querySelector('[data-sea-gradient-reset]')?.addEventListener('click', () => {
    const defaults = getSeaGradientOverlayDefaults();
    const enabledInput = container.querySelector('[data-sea-gradient-enabled]');
    const strengthInput = container.querySelector('[data-sea-gradient-strength]');
    const warmInput = container.querySelector('[data-sea-gradient-warm]');
    const coolInput = container.querySelector('[data-sea-gradient-cool]');
    const warmHex = container.querySelector('[data-sea-gradient-warm-hex]');
    const coolHex = container.querySelector('[data-sea-gradient-cool-hex]');
    if (enabledInput) enabledInput.checked = defaults.seaGradientOverlayEnabled;
    if (strengthInput) strengthInput.value = String(defaults.seaGradientStrength);
    if (warmInput) warmInput.value = defaults.seaGradientWarmColor;
    if (coolInput) coolInput.value = defaults.seaGradientCoolColor;
    if (warmHex) warmHex.value = defaults.seaGradientWarmColor;
    if (coolHex) coolHex.value = defaults.seaGradientCoolColor;
    onDraftChange();
  });
}

function renderSeaMusicColorPanel(theme) {
  const colors = resolveSeaMusicColors(theme);
  return `
    <section class="settings-group">
      <div class="settings-group-title">海主题播放条</div>
      <div class="appearance-panel">
        <div class="appearance-token-grid">
          <label class="appearance-token-item">
            <span class="appearance-token-label">背景</span>
            <input type="color" class="appearance-color-input" data-sea-music-bg value="${colors.bg}" />
            <input type="text" class="appearance-color-hex" data-sea-music-bg-hex value="${colors.bg}" maxlength="7" spellcheck="false" autocapitalize="off" autocomplete="off" aria-label="播放条背景色号" placeholder="#rrggbb" />
          </label>
          <label class="appearance-token-item">
            <span class="appearance-token-label">文字</span>
            <input type="color" class="appearance-color-input" data-sea-music-text value="${colors.text}" />
            <input type="text" class="appearance-color-hex" data-sea-music-text-hex value="${colors.text}" maxlength="7" spellcheck="false" autocapitalize="off" autocomplete="off" aria-label="播放条文字色号" placeholder="#rrggbb" />
          </label>
          <label class="appearance-token-item">
            <span class="appearance-token-label">进度与状态</span>
            <input type="color" class="appearance-color-input" data-sea-music-accent value="${colors.accent}" />
            <input type="text" class="appearance-color-hex" data-sea-music-accent-hex value="${colors.accent}" maxlength="7" spellcheck="false" autocapitalize="off" autocomplete="off" aria-label="播放条强调色号" placeholder="#rrggbb" />
          </label>
        </div>
        ${field('背景浓度', `<input type="range" class="appearance-range" data-sea-music-bg-opacity min="0" max="1" step="0.05" value="${colors.opacity}">`)}
        <div class="appearance-actions">
          <button type="button" class="btn btn-soft" data-sea-music-reset>恢复默认播放条</button>
        </div>
      </div>
    </section>
  `;
}

function collectSeaMusicColorDraft(container, nextTheme) {
  const bg = container.querySelector('[data-sea-music-bg]');
  const text = container.querySelector('[data-sea-music-text]');
  const accent = container.querySelector('[data-sea-music-accent]');
  const opacity = container.querySelector('[data-sea-music-bg-opacity]');
  if (!bg && !text && !accent && !opacity) return nextTheme;
  if (bg) nextTheme.seaMusicBgColor = String(bg.value || DEFAULT_SEA_MUSIC_BG);
  if (text) nextTheme.seaMusicTextColor = String(text.value || DEFAULT_SEA_MUSIC_TEXT);
  if (accent) nextTheme.seaMusicAccentColor = String(accent.value || DEFAULT_SEA_MUSIC_ACCENT);
  if (opacity) nextTheme.seaMusicBgOpacity = Number(opacity.value);
  return nextTheme;
}

function bindSeaMusicColorControls(container, onDraftChange) {
  const syncColorPair = (colorInput, hexInput) => {
    if (!colorInput || !hexInput) return;
    colorInput.addEventListener('input', () => {
      hexInput.value = colorInput.value;
      onDraftChange();
    });
    hexInput.addEventListener('change', () => {
      const next = String(hexInput.value || '').trim();
      if (/^#[0-9a-fA-F]{6}$/.test(next)) colorInput.value = next;
      onDraftChange();
    });
  };
  syncColorPair(
    container.querySelector('[data-sea-music-bg]'),
    container.querySelector('[data-sea-music-bg-hex]'),
  );
  syncColorPair(
    container.querySelector('[data-sea-music-text]'),
    container.querySelector('[data-sea-music-text-hex]'),
  );
  syncColorPair(
    container.querySelector('[data-sea-music-accent]'),
    container.querySelector('[data-sea-music-accent-hex]'),
  );
  container.querySelector('[data-sea-music-bg-opacity]')?.addEventListener('input', onDraftChange);
  container.querySelector('[data-sea-music-reset]')?.addEventListener('click', () => {
    const defaults = [
      ['[data-sea-music-bg]', '[data-sea-music-bg-hex]', DEFAULT_SEA_MUSIC_BG],
      ['[data-sea-music-text]', '[data-sea-music-text-hex]', DEFAULT_SEA_MUSIC_TEXT],
      ['[data-sea-music-accent]', '[data-sea-music-accent-hex]', DEFAULT_SEA_MUSIC_ACCENT],
    ];
    defaults.forEach(([colorSelector, hexSelector, value]) => {
      const colorInput = container.querySelector(colorSelector);
      const hexInput = container.querySelector(hexSelector);
      if (colorInput) colorInput.value = value;
      if (hexInput) hexInput.value = value;
    });
    const opacity = container.querySelector('[data-sea-music-bg-opacity]');
    if (opacity) opacity.value = String(DEFAULT_SEA_MUSIC_BG_OPACITY);
    onDraftChange();
  });
}

function renderTemplateTextFields(theme, seaTemplate) {
  const widgets = (theme && theme.widgets) || {};
  if (seaTemplate) {
    return SEA_TEXT_FIELDS.map(([key, label]) => field(
      label,
      `<input type="text" class="appearance-input" data-sea-text="${esc(key)}" value="${esc(widgets[key] || SEA_WIDGET_DEFAULTS[key] || '')}">`,
    )).join('');
  }
  const noteItems = Array.isArray(widgets.noteItems) ? widgets.noteItems.join('\n') : '';
  return [
    field('备忘录标题', `<input type="text" class="appearance-input" data-note-title value="${esc(widgets.noteTitle || '备忘录')}">`),
    field('备忘录条目', `<textarea class="appearance-textarea" data-note-items rows="4">${esc(noteItems)}</textarea>`),
    field('拍立得说明（第一页）', `<input type="text" class="appearance-input" data-polaroid-caption-p1 value="${esc(widgets.polaroidCaptionP1 || '')}">`),
    field('拍立得说明（第三页）', `<input type="text" class="appearance-input" data-polaroid-caption-p3 value="${esc(widgets.polaroidCaptionP3 || '')}">`),
  ].join('');
}

function renderTemplateImageUploads(seaTemplate) {
  if (seaTemplate) {
    return SEA_IMAGE_FIELDS.map(([key, label]) => (
      `<label class="btn btn-outline appearance-file-btn">${esc(label)}<input type="file" accept="image/*" data-sea-image-file="${esc(key)}" hidden></label>`
    )).join('');
  }
  return `
    <label class="btn btn-outline appearance-file-btn">拍立得（第一页）<input type="file" accept="image/*" data-polaroid-p1-file hidden></label>
    <label class="btn btn-outline appearance-file-btn">拍立得（第三页）<input type="file" accept="image/*" data-polaroid-p3-file hidden></label>
    <label class="btn btn-outline appearance-file-btn">胶片圆环<input type="file" accept="image/*" data-film-ring-file hidden></label>
    <label class="btn btn-outline appearance-file-btn">右侧贴纸<input type="file" accept="image/*" data-film-sticker-file hidden></label>
  `;
}

function renderHomePageWallpaperControls(theme) {
  const pageWallpapers = (theme && theme.homePageWallpapers) || {};
  // 跟随主屏实际分页数：用户有几页就显示几页，没单独设的页继承上方「壁纸」全局图。
  const layout = normalizeHomeLayout(theme?.homeLayout, theme?.widgetVisibility);
  const pageCount = Math.max(1, Math.min(HOME_PAGE_WALLPAPER_PAGES, (layout?.pages?.length) || 1));
  return Array.from({ length: pageCount }, (_, index) => {
    const page = index + 1;
    const hasCustom = !!String(pageWallpapers[String(page)] || '').trim();
    return `
      <div class="appearance-page-wallpaper-card">
        <div class="appearance-page-wallpaper-thumb" data-home-page-wallpaper-preview="${page}" aria-hidden="true"></div>
        <div class="appearance-page-wallpaper-meta">
          <strong>第 ${page} 页</strong>
          <span>${hasCustom ? '已设置' : '使用全局'}</span>
        </div>
        <div class="appearance-page-wallpaper-actions">
          <label class="btn btn-outline btn-sm appearance-file-btn">
            上传
            <input type="file" accept="image/*" data-home-page-wallpaper-file="${page}" hidden>
          </label>
          <button type="button" class="btn btn-soft btn-sm" data-home-page-wallpaper-clear="${page}" ${hasCustom ? '' : 'disabled'}>清除</button>
        </div>
      </div>
    `;
  }).join('');
}

function collectDraft(container, prefs) {
  const { id, theme } = getActiveTheme(prefs);
  const nextTheme = {
    ...theme,
    userCard: { ...(theme.userCard || {}) },
    appLabels: { ...(theme.appLabels || {}) },
    appIcons: { ...(theme.appIcons || {}) },
    homePageWallpapers: { ...(theme.homePageWallpapers || {}) },
    widgets: { ...(theme.widgets || {}) },
    customFont: { ...(theme.customFont || {}) },
    customTheme: {
      ...(theme?.customTheme || {}),
      css: String(theme?.customTheme?.css || ''),
      chatCss: String(theme?.customTheme?.chatCss || ''),
      homeTextVars: { ...(theme?.customTheme?.homeTextVars || {}) },
    },
    widgetVisibility: { ...(theme.widgetVisibility || {}) },
  };

  const greeting = container.querySelector('[data-user-greeting]');
  const statusText = container.querySelector('[data-user-status]');
  const wallpaperOpacity = container.querySelector('[data-wallpaper-opacity]');
  const chatBubbleFontSize = container.querySelector('[data-chat-bubble-font-size]');
  const noteTitle = container.querySelector('[data-note-title]');
  const noteItems = container.querySelector('[data-note-items]');
  const polaroidP1 = container.querySelector('[data-polaroid-caption-p1]');
  const polaroidP3 = container.querySelector('[data-polaroid-caption-p3]');

  if (greeting) nextTheme.userCard.greeting = String(greeting.value || '').trim();
  if (statusText) nextTheme.userCard.statusText = String(statusText.value || '').trim();
  if (wallpaperOpacity) {
    nextTheme.wallpaperOpacity = Number(wallpaperOpacity.value);
  }
  if (chatBubbleFontSize) {
    nextTheme.chatBubbleFontSize = clampChatBubbleFontSize(chatBubbleFontSize.value);
  }
  if (noteTitle) nextTheme.widgets.noteTitle = String(noteTitle.value || '').trim();
  if (noteItems) {
    nextTheme.widgets.noteItems = String(noteItems.value || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  }
  if (polaroidP1) nextTheme.widgets.polaroidCaptionP1 = String(polaroidP1.value || '').trim();
  if (polaroidP3) nextTheme.widgets.polaroidCaptionP3 = String(polaroidP3.value || '').trim();
  container.querySelectorAll('[data-sea-text]').forEach((input) => {
    const key = String(input.getAttribute('data-sea-text') || '').trim();
    if (key) nextTheme.widgets[key] = String(input.value || '').trim();
  });

  container.querySelectorAll('[data-app-label]').forEach((input) => {
    const appId = String(input.getAttribute('data-app-label') || '');
    if (!appId) return;
    nextTheme.appLabels[appId] = String(input.value || '').trim();
  });

  const customCss = container.querySelector('[data-custom-css]');
  if (customCss) {
    nextTheme.customTheme = {
      ...(nextTheme.customTheme || {}),
      css: String(customCss.value || ''),
      homeTextVars: { ...((nextTheme.customTheme && nextTheme.customTheme.homeTextVars) || {}) },
    };
  }
  const chatGlobalCss = container.querySelector('[data-chat-global-css]');
  if (chatGlobalCss) {
    const pageCss = { ...((nextTheme.customTheme && nextTheme.customTheme.pageCss) || {}) };
    const value = String(chatGlobalCss.value || '');
    if (value.trim()) pageCss['chat-thread'] = value;
    else delete pageCss['chat-thread'];
    nextTheme.customTheme = {
      ...(nextTheme.customTheme || {}),
      // 设置页与美化工作室统一编辑按页面发布槽；保存时清掉旧 chatCss，
      // 避免同一聊天页存在两份互相看不见、也无法在同一入口清空的 CSS。
      chatCss: '',
      pageCss,
      homeTextVars: { ...((nextTheme.customTheme && nextTheme.customTheme.homeTextVars) || {}) },
    };
  }
  const homeTextVars = { ...((nextTheme.customTheme && nextTheme.customTheme.homeTextVars) || {}) };
  container.querySelectorAll('[data-home-text-var]').forEach((input) => {
    const key = String(input.getAttribute('data-home-text-var') || '').trim();
    if (!key) return;
    const fallback = String(input.getAttribute('data-css-default') || '').trim();
    const original = String(input.getAttribute('data-css-original') || '').trim();
    const seed = String(input.getAttribute('data-css-seed') || '').trim();
    const current = String(input.value || '').trim();
    if (current.toLowerCase() === seed.toLowerCase()) {
      if (original) homeTextVars[key] = original;
      else delete homeTextVars[key];
    } else if (!current || current.toLowerCase() === fallback.toLowerCase()) {
      delete homeTextVars[key];
    } else {
      homeTextVars[key] = current;
    }
  });
  nextTheme.customTheme = {
    ...(nextTheme.customTheme || { css: '' }),
    homeTextVars,
  };
  collectSeaGradientDraft(container, nextTheme);
  collectSeaMusicColorDraft(container, nextTheme);
  const windowFrameInput = container.querySelector('[data-window-frame-enabled]');
  if (windowFrameInput) nextTheme.windowFrameEnabled = !!windowFrameInput.checked;
  const albumGrayFilterInput = container.querySelector('[data-album-gray-filter-enabled]');
  if (albumGrayFilterInput) nextTheme.albumGrayFilterEnabled = !!albumGrayFilterInput.checked;
  const appIconEdgeInput = container.querySelector('[data-app-icon-edge]');
  if (appIconEdgeInput) nextTheme.appIconEdgeEnabled = !!appIconEdgeInput.checked;
  const appIconFrameOpacityInput = container.querySelector('[data-app-icon-frame-opacity]');
  if (appIconFrameOpacityInput) nextTheme.appIconFrameOpacity = Number(appIconFrameOpacityInput.value);

  return {
    ...prefs,
    activeThemeId: id,
    themes: {
      ...prefs.themes,
      [id]: nextTheme,
    },
  };
}

function applyWallpaperPreview(page, theme) {
  // 美化设置页滚动区域极长：整页 ::before 壁纸 backdrop 会在下滑合成时把 WebView 闷死，
  // 这里只更新区块内的小缩略图，不再给整页挂 backdrop。
  page.classList.remove('has-settings-wallpaper');
  page.style.removeProperty('--settings-wallpaper');
  const thumb = page.querySelector('[data-wallpaper-preview]');
  if (thumb) {
    applyAppearanceWallpaperThumb(thumb, theme);
  }
}

/**
 * 上传壁纸常常超过 background-image 预览的安全阈值；设置页只在当前缩略图进入视口后
 * 放一张 <img>，既能显示用户刚上传的图，又不会让整页同时解码多张大 data URL。
 */
function lockAppearanceWallpaperThumbBox(el, pageNumber = 0) {
  if (!el) return;
  // 容器约束写进 inline：避免 settings.css 旧缓存时 absolute 预览图落到滚动根上撑爆整页
  el.style.position = 'relative';
  el.style.overflow = 'hidden';
  if (pageNumber) {
    el.style.width = '72px';
    el.style.maxWidth = '72px';
    el.style.height = '96px';
    el.style.maxHeight = '96px';
    return;
  }
  el.style.width = '100%';
  el.style.maxWidth = '100%';
  el.style.height = '128px';
  el.style.maxHeight = '128px';
}

function applyAppearanceWallpaperThumb(el, theme, pageNumber = 0) {
  if (!el) return;
  const wallpaper = pageNumber
    ? resolveHomePageWallpaperUrl(theme, pageNumber)
    : resolveWallpaperUrl(theme);
  const applyBackground = pageNumber ? applyHomePageWallpaperToElement : applyThemeWallpaperToElement;
  lockAppearanceWallpaperThumbBox(el, pageNumber);
  if (!wallpaper || !isHeavyAppearancePreviewUrl(wallpaper)) {
    el.replaceChildren();
    applyBackground(el, theme, ...(pageNumber ? [pageNumber] : []));
    return;
  }
  const alpha = Math.max(0, Math.min(0.8, Number(theme?.wallpaperOpacity ?? DEFAULT_WALLPAPER_OVERLAY) || 0));
  const image = document.createElement('img');
  image.className = 'appearance-wallpaper-thumb-image';
  image.alt = '';
  image.decoding = 'async';
  image.setAttribute('draggable', 'false');
  image.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;max-width:100%;max-height:100%;object-fit:cover;object-position:center;display:block;pointer-events:none;';
  image.src = wallpaper;
  const overlay = document.createElement('span');
  overlay.className = 'appearance-wallpaper-thumb-overlay';
  overlay.style.cssText = `position:absolute;inset:0;width:100%;height:100%;pointer-events:none;background:rgba(251, 246, 240, ${alpha})`;
  el.style.removeProperty('background-image');
  el.style.removeProperty('background-size');
  el.style.removeProperty('background-position');
  el.replaceChildren(image, overlay);
}

function hydrateOneAppIconPreview(el, theme, generation) {
  const appId = el.getAttribute('data-app-icon-lazy') || '';
  const dataUrl = String((theme?.appIcons || {})[appId] || '').trim();
  if (!dataUrl) return;
  const img = document.createElement('img');
  img.alt = '';
  img.decoding = 'async';
  const reveal = () => {
    if (!img.naturalWidth || el._appearancePreviewGeneration !== generation) return;
    el.replaceChildren(img);
  };
  // 先保留内置 SVG；只有自定义图标实际解码成功后才替换。大 data URL 也由外层
  // IntersectionObserver 队列逐张加载，不能直接跳过，否则重新进入时会假装成默认图标。
  img.addEventListener('load', reveal, { once: true });
  img.src = dataUrl;
  if (img.complete) reveal();
}

function yieldPreviewFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function disconnectAppearancePreviewObserver(container) {
  const obs = container._appearancePreviewObserver;
  if (obs) {
    obs.disconnect();
    container._appearancePreviewObserver = null;
  }
  const queue = container._appearancePreviewQueue;
  if (Array.isArray(queue)) {
    for (const job of queue) {
      if (!job?.el) continue;
      job.generation += 1;
      job.el._appearancePreviewGeneration = job.generation;
      job.el.innerHTML = job.originalHtml;
      if (job.originalStyle == null) job.el.removeAttribute('style');
      else job.el.setAttribute('style', job.originalStyle);
    }
  }
  container._appearancePreviewQueue = null;
}

/** 壁纸/分页壁纸/App 图标预览：进入视口才加载，且同一帧最多塞一张，避免 idle 时一次性解码全部图。 */
function setupAppearanceLazyPreviews(container, theme) {
  disconnectAppearancePreviewObserver(container);

  const scrollRoot = container.querySelector('.appearance-scroll');
  const jobs = [];

  const addPreviewJob = (el, run) => {
    if (!el) return;
    const originalHtml = el.innerHTML;
    const originalStyle = el.getAttribute('style');
    jobs.push({
      el,
      run,
      originalHtml,
      originalStyle,
      generation: 0,
      pending: false,
      done: false,
    });
  };

  const wallThumb = container.querySelector('[data-wallpaper-preview]');
  if (wallThumb) {
    addPreviewJob(wallThumb, () => applyAppearanceWallpaperThumb(wallThumb, theme));
  }

  container.querySelectorAll('[data-home-page-wallpaper-preview]').forEach((el) => {
    const pageNumber = Number(el.getAttribute('data-home-page-wallpaper-preview')) || 1;
    addPreviewJob(el, () => {
      applyAppearanceWallpaperThumb(el, theme, pageNumber);
      const card = el.closest('.appearance-page-wallpaper-card');
      const hasCustom = !!String(theme?.homePageWallpapers?.[String(pageNumber)] || '').trim();
      const status = card?.querySelector('.appearance-page-wallpaper-meta span');
      const clearBtn = card?.querySelector('[data-home-page-wallpaper-clear]');
      if (status) status.textContent = hasCustom ? '已设置' : '使用全局';
      if (clearBtn) clearBtn.disabled = !hasCustom;
    });
  });

  container.querySelectorAll('[data-app-icon-lazy]').forEach((el) => {
    addPreviewJob(el, (generation) => hydrateOneAppIconPreview(el, theme, generation));
  });

  if (!jobs.length) return;

  const queue = jobs;
  container._appearancePreviewQueue = queue;

  let draining = false;
  const drainQueue = async () => {
    if (draining) return;
    draining = true;
    try {
      while (queue.some((job) => job.pending && !job.done)) {
        const job = queue.find((item) => item.pending && !item.done);
        if (!job) break;
        job.pending = false;
        job.done = true;
        job.generation += 1;
        job.el._appearancePreviewGeneration = job.generation;
        try { job.run(job.generation); } catch (_) {}
        await yieldPreviewFrame();
      }
    } finally {
      draining = false;
    }
  };

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const job = queue.find((item) => item.el === entry.target);
      if (!job) continue;
      if (entry.isIntersecting) {
        if (!job.done && !job.pending) job.pending = true;
        continue;
      }
      job.pending = false;
      if (!job.done) continue;
      // 预览项滚出预取区后撤掉 data URL，避免用户从上到下浏览一遍后，所有壁纸和
      // 图标仍以解码位图常驻 WebView。再次滚回时按同一逐帧队列重新加载。
      job.done = false;
      job.generation += 1;
      job.el._appearancePreviewGeneration = job.generation;
      job.el.innerHTML = job.originalHtml;
      if (job.originalStyle == null) job.el.removeAttribute('style');
      else job.el.setAttribute('style', job.originalStyle);
    }
    void drainQueue();
  }, {
    root: scrollRoot,
    // 主题页预览在刚进入视口才开始加载会短暂露出默认半透明底；
    // 提前预取约半屏，让背景图在用户滑到卡片前完成解码。
    rootMargin: '55% 0px',
    threshold: 0.01,
  });

  container._appearancePreviewObserver = observer;
  for (const job of queue) observer.observe(job.el);
}

function refreshHomePageWallpaperPreviews(container, theme) {
  container.querySelectorAll('[data-home-page-wallpaper-preview]').forEach((el) => {
    const pageNumber = Number(el.getAttribute('data-home-page-wallpaper-preview')) || 1;
    applyAppearanceWallpaperThumb(el, theme, pageNumber);
    const card = el.closest('.appearance-page-wallpaper-card');
    const hasCustom = !!String(theme?.homePageWallpapers?.[String(pageNumber)] || '').trim();
    const status = card?.querySelector('.appearance-page-wallpaper-meta span');
    const clearBtn = card?.querySelector('[data-home-page-wallpaper-clear]');
    if (status) status.textContent = hasCustom ? '已设置' : '使用全局';
    if (clearBtn) clearBtn.disabled = !hasCustom;
  });
}

function isWallpaperDisabled(theme) {
  const raw = theme && theme.wallpaper != null ? String(theme.wallpaper).trim() : '';
  return raw === WALLPAPER_NONE;
}

function formatFontStatus(theme) {
  const { fileName } = getThemeFontConfig(theme);
  if (!fileName) return '当前：默认手账字体';
  return `当前：${fileName}`;
}

function updateThemePreview(container, theme, { skipFont = false } = {}) {
  const status = container.querySelector('[data-font-status]');
  const resetBtn = container.querySelector('[data-font-reset]');
  const { dataUrl, styleUrl } = getThemeFontConfig(theme);
  if (status) status.textContent = formatFontStatus(theme);
  if (resetBtn) resetBtn.disabled = !(dataUrl || styleUrl);
  if (skipFont) {
    applyChatBubbleFontSize(theme);
    applyCustomTheme(theme);
    return;
  }
  applyAppearanceTheme(theme);
}

/** 首帧骨架：点击「美化设置」后先同步画出标题栏 + 占位，避免读取偏好设置期间原地卡顿无反馈 */
function renderAppearanceSkeleton(container) {
  container.className = 'page scrapbook-page settings-sub-page appearance-settings-page';
  container.innerHTML = `
    <header class="navbar">
      <button type="button" class="navbar-btn" data-back aria-label="返回">${icon('back')}</button>
      <h1 class="navbar-title appearance-navbar-title"><span>美化设置</span><small data-appearance-save-state aria-live="polite"></small></h1>
      <button type="button" class="navbar-btn appearance-save-btn" aria-label="保存美化设置" disabled>保存</button>
    </header>
    <main class="settings-scroll scrapbook-scroll appearance-scroll" aria-busy="true">
      <div class="page-skeleton appearance-page-skeleton" aria-hidden="true">
        <span class="sk-block sk-bar" style="width:30%"></span>
        <div class="sk-grid">
          <span class="sk-block sk-tile"></span>
          <span class="sk-block sk-tile"></span>
          <span class="sk-block sk-tile"></span>
        </div>
        <span class="sk-block sk-bar" style="width:40%"></span>
        <span class="sk-block sk-bar" style="height:120px"></span>
        <span class="sk-block sk-bar" style="width:35%"></span>
        <span class="sk-block sk-bar" style="height:80px"></span>
        <p class="appearance-loading-hint">正在读取主题配置…</p>
      </div>
    </main>
  `;
  container.querySelector('[data-back]')?.addEventListener('click', () => back());
}

function yieldToPaint() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });
}

function deferAppearancePreview(work) {
  const run = () => {
    try { work(); } catch (err) { console.warn('[appearance] preview failed', err); }
  };
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(run, { timeout: 1200 });
  } else {
    setTimeout(run, 0);
  }
}

export default async function render(container) {
  renderAppearanceSkeleton(container);
  await yieldToPaint();
  let prefs;
  try {
    prefs = await loadAppearancePrefs();
  } catch (err) {
    container.querySelector('main')?.insertAdjacentHTML('beforeend', `<p class="appearance-load-error">读取主题失败：${esc(String(err?.message || err || ''))}</p>`);
    return;
  }
  let activeInitial = getActiveTheme(prefs);
  const { theme } = activeInitial;
  const seaTemplate = isSeaHomeTheme(activeInitial.id, theme);
  const albumTemplate = isAlbumHomeTheme(activeInitial.id, theme);
  const user = (theme && theme.userCard) || {};
  const customTheme = getCustomThemeConfig(theme);
  const effectiveChatGlobalCss = String(
    customTheme.pageCss?.['chat-thread'] || customTheme.chatCss || '',
  );
  const darkAdaptTargets = Object.keys(customTheme.pageCss || {})
    .filter((key) => String(customTheme.pageCss[key] || '').trim()
      && !String(customTheme.pageDarkCss?.[key] || '').trim());
  const darkAdaptTarget = darkAdaptTargets[0]
    || (String(customTheme.chatCss || '').trim() ? 'chat-thread' : '')
    || (String(customTheme.css || '').trim() ? 'home' : '')
    || 'home';
  const colorMode = ['light', 'dark', 'system'].includes(prefs.colorMode) ? prefs.colorMode : 'light';

  container.className = 'page scrapbook-page settings-sub-page appearance-settings-page';

  const appearanceMainUpper = `
      <section class="settings-group">
        <div class="settings-group-title">显示模式</div>
        <div class="appearance-panel appearance-color-mode-panel">
          <div class="appearance-color-mode" role="radiogroup" aria-label="显示模式">
            <button type="button" role="radio" aria-checked="${colorMode === 'light'}" class="${colorMode === 'light' ? 'is-active' : ''}" data-color-mode="light">浅色</button>
            <button type="button" role="radio" aria-checked="${colorMode === 'system'}" class="${colorMode === 'system' ? 'is-active' : ''}" data-color-mode="system">跟随系统</button>
            <button type="button" role="radio" aria-checked="${colorMode === 'dark'}" class="${colorMode === 'dark' ? 'is-active' : ''}" data-color-mode="dark">夜间</button>
          </div>
          <div class="appearance-dark-adapt">
            <span>${darkAdaptTargets.length ? `${darkAdaptTargets.length} 页自定义 CSS 待适配` : '夜间覆盖可单独编辑'}</span>
            <button type="button" class="btn btn-outline btn-sm" data-open-dark-studio>去美化工作室</button>
          </div>
        </div>
      </section>

      <section class="settings-group">
        <div class="settings-group-title">主题</div>
        ${renderThemePresetSection(prefs)}
      </section>

      <section class="settings-group">
        <div class="settings-group-title">主题包</div>
        <div class="appearance-panel">
          <div class="appearance-actions appearance-pack-actions">
            <button type="button" class="btn btn-outline btn-sm" data-export-theme>导出主题</button>
            <button type="button" class="btn btn-soft btn-sm" data-share-theme>分享当前主题</button>
            <label class="btn btn-outline btn-sm appearance-file-btn">
              导入主题
              <input type="file" accept=".json,application/json" data-import-theme-file hidden>
            </label>
            <button type="button" class="btn btn-soft btn-sm" data-restore-default-theme>恢复默认主题</button>
          </div>
          <textarea class="appearance-textarea appearance-theme-paste" data-theme-paste rows="5" spellcheck="false" placeholder="粘贴 AI 返回的 JSON 或 markdown 代码块"></textarea>
          <div class="appearance-actions">
            <button type="button" class="btn btn-primary btn-sm" data-apply-theme-paste>应用粘贴内容</button>
          </div>
        </div>
      </section>

      <section class="settings-group">
        <div class="settings-group-title">主屏字色</div>
        <div class="appearance-panel">
          <p class="appearance-group-hint">仅影响当前桌面主屏（标题、状态小字等），不改动通讯录、设置等内页。</p>
          ${renderHomeTextColorFields(theme)}
          <div class="appearance-actions">
            <button type="button" class="btn btn-soft" data-home-text-vars-reset>恢复默认字色</button>
          </div>
        </div>
      </section>

      <section class="settings-group">
        <div class="settings-group-title">自定义 CSS（主屏与全局）</div>
        <div class="appearance-panel">
          ${field('样式代码', `<textarea class="appearance-textarea appearance-custom-css" data-custom-css rows="10" spellcheck="false" placeholder="/* 主屏与全局美化 CSS；类名与变量见「CSS 参考文档」 */">${esc(customTheme.css)}</textarea>`)}
          <div class="appearance-actions">
            <button type="button" class="btn btn-outline btn-sm" data-download-ai-doc>CSS 参考文档</button>
            <button type="button" class="btn btn-outline btn-sm" data-export-custom-css>导出 CSS</button>
            <button type="button" class="btn btn-soft btn-sm" data-share-custom-css>分享 CSS</button>
            <label class="btn btn-outline btn-sm appearance-file-btn">
              导入 CSS
              <input type="file" accept=".css,.txt,text/css,text/plain" data-import-custom-css-file hidden>
            </label>
            <button type="button" class="btn btn-soft btn-sm" data-custom-css-reset>清空 CSS</button>
          </div>
          <div class="appearance-actions">
            <button type="button" class="btn btn-soft btn-sm" data-offline-css-emergency-clear>清空线下 CSS（急救）</button>
            <button type="button" class="btn btn-soft btn-sm" data-chat-session-css-emergency>会话 CSS 急救</button>
          </div>
          <div class="appearance-emergency-chat-css" data-chat-session-css-emergency-panel hidden>
            <label class="appearance-field">
              <span>选择本档位会话</span>
              <select class="form-input" data-chat-session-css-emergency-select aria-label="选择要清除 CSS 的会话"></select>
            </label>
            <div class="appearance-actions">
              <button type="button" class="btn btn-primary btn-sm" data-chat-session-layout-repair-confirm>修复消息左右布局</button>
              <button type="button" class="btn btn-outline btn-sm" data-chat-session-css-emergency-confirm>清除该会话 CSS</button>
              <button type="button" class="btn btn-soft btn-sm" data-chat-session-css-emergency-cancel>取消</button>
            </div>
          </div>
        </div>
      </section>

      <section class="settings-group">
        <div class="settings-group-title">消息界面 CSS（全局）</div>
        <div class="appearance-panel">
          ${field('样式代码', `<textarea class="appearance-textarea appearance-custom-css" data-chat-global-css rows="8" spellcheck="false" placeholder="/* 作用于所有会话的消息界面；如 .chat-thread-page .chat-bubble-row.is-them .scrapbook-bubble{...} */">${esc(effectiveChatGlobalCss)}</textarea>`)}
          <div class="appearance-actions">
            <button type="button" class="btn btn-outline btn-sm" data-download-chat-css-doc>CSS 参考文档</button>
            <button type="button" class="btn btn-outline btn-sm" data-export-chat-global-css>导出 CSS</button>
            <button type="button" class="btn btn-soft btn-sm" data-share-chat-global-css>分享 CSS</button>
            <label class="btn btn-outline btn-sm appearance-file-btn">
              导入 CSS
              <input type="file" accept=".css,.txt,text/css,text/plain" data-import-chat-global-css-file hidden>
            </label>
            <button type="button" class="btn btn-soft btn-sm" data-chat-global-layout-repair>修复消息左右布局</button>
            <button type="button" class="btn btn-soft btn-sm" data-chat-global-css-reset>清空</button>
          </div>
        </div>
      </section>

      <section class="settings-group">
        <div class="settings-group-title">主屏布局</div>
        <div class="appearance-panel">
          ${renderWidgetManager(activeInitial.id, theme)}
        </div>
      </section>

      <section class="settings-group">
        <div class="settings-group-title">壁纸</div>
        <div class="appearance-panel">
          <div class="appearance-wallpaper-preview" data-wallpaper-preview aria-hidden="true"></div>
          ${field('透明度', `<input type="range" class="appearance-range" data-wallpaper-opacity min="0" max="0.6" step="0.02" value="${Number(theme.wallpaperOpacity != null ? theme.wallpaperOpacity : DEFAULT_WALLPAPER_OVERLAY)}">`)}
          <div class="appearance-actions">
            <label class="btn btn-outline appearance-file-btn">
              上传壁纸
              <input type="file" accept="image/*" data-wallpaper-file hidden>
            </label>
            <button type="button" class="btn btn-soft" data-wallpaper-default>恢复默认</button>
            <button type="button" class="btn btn-soft" data-wallpaper-clear ${isWallpaperDisabled(theme) ? 'disabled' : ''}>纯色底</button>
          </div>
          <div class="appearance-font-url-row">
            <input type="url" class="appearance-input" data-wallpaper-url placeholder="粘贴图片链接（https://…）" autocomplete="off" autocapitalize="off" spellcheck="false">
            <button type="button" class="btn btn-outline btn-sm" data-wallpaper-url-apply>用链接</button>
          </div>
        </div>
      </section>

      ${seaTemplate ? renderSeaGradientPanel(theme) : ''}
      ${seaTemplate ? renderSeaMusicColorPanel(theme) : ''}
      ${albumTemplate ? renderAlbumDisplayPanel(theme) : ''}
      ${renderWindowDisplayPanel(theme)}

      <section class="settings-group">
        <div class="settings-group-title">主屏分页壁纸</div>
        <p class="appearance-group-hint">默认整屏共用上方那张壁纸。想做「一页一景 / 四季窗」时，再给某一页单独换图——页数跟随你的主屏分页，滑动时会柔和淡入淡出。</p>
        <div class="appearance-actions">
          <label class="btn btn-outline appearance-file-btn">
            横图无缝铺满整屏
            <input type="file" accept="image/*" data-home-pano-file hidden>
          </label>
          <button type="button" class="btn btn-soft" data-home-pano-clear ${theme && theme.homePanorama ? '' : 'disabled'}>取消横图</button>
        </div>
        <p class="appearance-group-hint">上传一整张横图：它会横跨你全部主屏分页，随滑动 1:1 平移，划过去是一张完整连续的图、没有断层（按当前页数自动适配三页/四页）。设了横图时单页换图会盖在它上面。</p>
        <div class="appearance-page-wallpaper-grid">
          ${renderHomePageWallpaperControls(theme)}
        </div>
      </section>

      <section class="settings-group">
        <div class="settings-group-title">字体</div>
        <div class="appearance-panel">
          <div class="appearance-font-preview" data-font-preview>
            <div class="appearance-font-sample-title">棉花糖手账</div>
            <div class="appearance-font-sample-body">今天也要开开心心呀 ✨ ABcd 123</div>
          </div>
          <div class="appearance-font-meta" data-font-status>${esc(formatFontStatus(theme))}</div>
          <div class="appearance-actions">
            <label class="btn btn-outline appearance-file-btn">
              上传字体
              <input type="file" accept=".ttf,.ttc,.otf,.woff,.woff2,font/ttf,font/otf,font/woff,font/woff2" data-font-file hidden>
            </label>
            <button type="button" class="btn btn-soft" data-font-reset ${(getThemeFontConfig(theme).dataUrl || getThemeFontConfig(theme).styleUrl) ? '' : 'disabled'}>恢复默认</button>
          </div>
          <div class="appearance-font-url-row">
            <input type="url" class="appearance-input" data-font-url placeholder="粘贴字体直链（.woff2/.ttf）或 Google Fonts 链接" autocomplete="off" autocapitalize="off" spellcheck="false">
            <button type="button" class="btn btn-outline btn-sm" data-font-url-apply>用链接</button>
          </div>
        </div>
      </section>

      <section class="settings-group">
        <div class="settings-group-title">聊天字号</div>
        <div class="appearance-panel">
          ${field('气泡文字', `<input type="range" class="appearance-range" data-chat-bubble-font-size min="${MIN_CHAT_BUBBLE_FONT_SIZE}" max="${MAX_CHAT_BUBBLE_FONT_SIZE}" step="1" value="${getChatBubbleFontSize(theme)}">`)}
          <div class="appearance-chat-font-preview" data-chat-font-preview style="--chat-bubble-font-size:${getChatBubbleFontSize(theme)}px;">
            <span>今天晚一点回你。</span>
            <b data-chat-font-value>${getChatBubbleFontSize(theme)}px</b>
          </div>
        </div>
      </section>

      <section class="settings-group">
        <div class="settings-group-title">用户卡片</div>
        <div class="appearance-panel">
          ${field('标题', `<input type="text" class="appearance-input" data-user-greeting value="${esc(user.greeting || '')}">`)}
          ${field('状态语', `<input type="text" class="appearance-input" data-user-status value="${esc(user.statusText || '')}">`)}
          <div class="appearance-actions">
            <label class="btn btn-outline appearance-file-btn">
              上传头像
              <input type="file" accept="image/*" data-avatar-file hidden>
            </label>
            <button type="button" class="btn btn-soft" data-avatar-clear ${user.avatarDataUrl ? '' : 'disabled'}>清除头像</button>
          </div>
        </div>
      </section>

      <section class="settings-group">
        <div class="settings-group-title">${seaTemplate ? '海主题文案' : '组件文案'}</div>
        <div class="appearance-panel">
          ${renderTemplateTextFields(theme, seaTemplate)}
        </div>
      </section>

      <section class="settings-group">
        <div class="settings-group-title">${seaTemplate ? '海主题图片' : '组件图片'}</div>
        <div class="appearance-panel appearance-upload-grid">
          ${renderTemplateImageUploads(seaTemplate)}
        </div>
      </section>
  `;

  const appearanceMainLower = `
      <section class="settings-group">
        <div class="settings-group-title">图标与名称</div>
        <div class="appearance-panel">
          ${renderAppIconGrid(theme)}
        </div>
      </section>
  `;

  container.innerHTML = `
    <header class="navbar">
      <button type="button" class="navbar-btn" data-back aria-label="返回">${icon('back')}</button>
      <h1 class="navbar-title appearance-navbar-title"><span>美化设置</span><small data-appearance-save-state aria-live="polite"></small></h1>
      <button type="button" class="navbar-btn appearance-save-btn" aria-label="保存美化设置" disabled>保存</button>
    </header>
    <main class="settings-scroll scrapbook-scroll appearance-scroll" aria-busy="true"></main>
  `;
  const appearanceMain = container.querySelector('main');
  if (appearanceMain) {
    appearanceMain.innerHTML = appearanceMainUpper;
    await yieldToPaint();
    appearanceMain.insertAdjacentHTML('beforeend', appearanceMainLower);
    await yieldToPaint();
  }

  appearanceMain?.removeAttribute('aria-busy');
  const saveBtn = container.querySelector('.appearance-save-btn');
  const saveState = container.querySelector('[data-appearance-save-state]');
  let hasUnsavedChanges = false;
  let draftRevision = 0;
  let saveFeedbackTimer = 0;

  const armUnsavedLeaveGuard = () => {
    setLeaveGuard(() => (
      !hasUnsavedChanges || window.confirm('还有未保存的美化修改，确定离开？')
    ));
  };

  const markAppearanceDirty = () => {
    hasUnsavedChanges = true;
    draftRevision += 1;
    if (saveFeedbackTimer) clearTimeout(saveFeedbackTimer);
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = '保存';
      saveBtn.classList.add('is-dirty');
      saveBtn.setAttribute('aria-label', '保存美化设置（有未保存修改）');
    }
    if (saveState) saveState.textContent = '未保存';
    armUnsavedLeaveGuard();
  };

  const markAppearanceSaved = () => {
    hasUnsavedChanges = false;
    clearLeaveGuard();
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.textContent = '已保存';
      saveBtn.classList.remove('is-dirty');
      saveBtn.setAttribute('aria-label', '美化设置已保存');
    }
    if (saveState) saveState.textContent = '已保存';
    saveFeedbackTimer = window.setTimeout(() => {
      if (hasUnsavedChanges) return;
      if (saveBtn?.isConnected) {
        saveBtn.textContent = '保存';
        saveBtn.setAttribute('aria-label', '保存美化设置');
      }
      if (saveState?.isConnected) saveState.textContent = '';
    }, 900);
  };

  deferAppearancePreview(() => {
    updateThemePreview(container, theme, { skipFont: true });
    setupAppearanceLazyPreviews(container, theme);
    // 进页后再延迟压缩：与首屏渲染错开，避免 prefs 大图 + 解码同时占满 WebView 内存。
    if (themeHasOversizedImages(theme) && canRunLegacyAppearanceCompaction()) {
      setTimeout(() => {
        void compactOversizedAppearanceImages({ priorityActiveTheme: true, yieldEvery: 1 }).catch(() => {});
      }, 5000);
    }
  });

  const backBtn = container.querySelector('[data-back]');
  if (backBtn) backBtn.addEventListener('click', () => back());
  container.querySelectorAll('[data-color-mode]').forEach((button) => {
    button.addEventListener('click', async () => {
      const nextMode = button.dataset.colorMode;
      if (!['light', 'dark', 'system'].includes(nextMode) || prefs.colorMode === nextMode) return;
      prefs = await saveAppearancePrefs({ ...prefs, colorMode: nextMode });
      container.querySelectorAll('[data-color-mode]').forEach((item) => {
        const active = item.dataset.colorMode === nextMode;
        item.classList.toggle('is-active', active);
        item.setAttribute('aria-checked', String(active));
      });
      showToast(nextMode === 'dark' ? '已开启夜间模式' : nextMode === 'system' ? '已跟随系统显示' : '已切换为浅色模式');
    });
  });
  container.querySelector('[data-open-dark-studio]')?.addEventListener('click', () => {
    navigate('beautify', { target: darkAdaptTarget, variant: 'dark', intent: 'dark-adapt' });
  });

  const selectedWidgetIds = new Set();

  function refreshWidgetManager() {
    const panel = container.querySelector('[data-widget-manager]');
    if (!panel) return;
    const parent = panel.parentElement;
    if (!parent) return;
    const wrap = document.createElement('div');
    const active = getActiveTheme(prefs);
    const validIds = new Set(Object.keys(normalizeHomeLayout(
      active.theme?.homeLayout,
      active.theme?.widgetVisibility,
    ).customItems || {}));
    for (const itemId of [...selectedWidgetIds]) {
      if (!validIds.has(itemId)) selectedWidgetIds.delete(itemId);
    }
    wrap.innerHTML = renderWidgetManager(active.id, active.theme, selectedWidgetIds);
    const next = wrap.firstElementChild;
    if (next) parent.replaceChild(next, panel);
    bindWidgetManagerActions();
  }

  function setWidgetVisible(widgetId, visible) {
    const { id, theme: activeTheme } = getActiveTheme(prefs);
    const layout = normalizeHomeLayout(activeTheme.homeLayout, activeTheme.widgetVisibility);
    const slots = getHomeWidgetSlotsForTheme(id, activeTheme);
    const slot = slots.find((item) => item.id === widgetId);
    const pageIndex = Math.max(0, Math.min(layout.pages.length - 1, Number(slot?.page) || 0));
    const pages = visible && BUILTIN_HOME_WIDGET_DEFS[widgetId] && !layout.pages.flat().includes(widgetId)
      ? layout.pages.map((page, index) => (index === pageIndex ? [...page, widgetId] : page))
      : layout.pages;
    prefs = {
      ...prefs,
      themes: {
        ...prefs.themes,
        [id]: {
          ...activeTheme,
          homeLayout: { ...layout, pages },
          widgetVisibility: (() => {
            const vis = getWidgetVisibility(activeTheme);
            vis[widgetId] = visible;
            delete vis.seaMusic;
            return vis;
          })(),
        },
      },
    };
    refreshWidgetManager();
    markAppearanceDirty();
  }

  function commitCustomWidget(nextId, nextItem, isNew) {
    const { id, theme: activeTheme } = getActiveTheme(prefs);
    const layout = normalizeHomeLayout(activeTheme.homeLayout, activeTheme.widgetVisibility);
    const pages = layout.pages.map((page) => page.slice());
    if (isNew && !pages.flat().includes(nextId)) {
      pages[0].push(nextId);
    }
    prefs = upsertHomeWidgetLibraryItem({
      ...prefs,
      themes: {
        ...prefs.themes,
        [id]: {
          ...activeTheme,
          homeLayout: normalizeHomeLayout({
            ...layout,
            pages,
          }, activeTheme.widgetVisibility),
        },
      },
    }, nextItem);
    refreshWidgetManager();
    markAppearanceDirty();
  }

  function setCustomWidgetHomeVisible(itemId, visible) {
    const { id, theme: activeTheme } = getActiveTheme(prefs);
    const layout = normalizeHomeLayout(activeTheme.homeLayout, activeTheme.widgetVisibility);
    const current = layout.customItems?.[itemId];
    if (!current) return;
    const pages = layout.pages.map((page) => page.filter((entry) => entry !== itemId));
    if (visible) pages[Math.max(0, pages.length - 1)].unshift(itemId);
    const customItems = {
      ...layout.customItems,
      [itemId]: { ...current, storedInLibrary: true, hiddenFromHome: !visible },
    };
    prefs = {
      ...prefs,
      themes: {
        ...prefs.themes,
        [id]: {
          ...activeTheme,
          homeLayout: normalizeHomeLayout({ ...layout, pages, customItems }, activeTheme.widgetVisibility),
        },
      },
    };
    refreshWidgetManager();
    markAppearanceDirty();
  }

  function upsertCustomWidget(itemId = '') {
    const { theme: activeTheme } = getActiveTheme(prefs);
    const layout = normalizeHomeLayout(activeTheme.homeLayout, activeTheme.widgetVisibility);
    const old = itemId ? layout.customItems[itemId] : null;
    const title = window.prompt('组件标题', old?.title || old?.label || '便签');
    if (title == null) return;
    const body = window.prompt('组件内容', old?.body || '');
    if (body == null) return;
    const colsRaw = window.prompt('宽度格数（1-4）', String(old?.size?.cols || 2));
    if (colsRaw == null) return;
    const rowsRaw = window.prompt('高度格数（1-5）', String(old?.size?.rows || 1));
    if (rowsRaw == null) return;
    const nextId = old?.id || `custom-${Date.now()}`;
    const nextItem = {
      ...(old || {}),
      id: nextId,
      kind: 'custom-widget',
      label: String(title || '便签').trim() || '便签',
      title: String(title || '便签').trim() || '便签',
      body: String(body || '').trim(),
      html: '',
      size: {
        cols: Math.max(1, Math.min(4, Math.round(Number(colsRaw) || 2))),
        rows: Math.max(1, Math.min(5, Math.round(Number(rowsRaw) || 1))),
      },
    };
    commitCustomWidget(nextId, nextItem, !old);
  }

  function upsertCodeWidget(itemId = '') {
    const { theme: activeTheme } = getActiveTheme(prefs);
    const layout = normalizeHomeLayout(activeTheme.homeLayout, activeTheme.widgetVisibility);
    const old = itemId ? layout.customItems[itemId] : null;
    const title = window.prompt('组件名称（仅用于管理列表）', old?.label || old?.title || '代码组件');
    if (title == null) return;
    const colsRaw = window.prompt('宽度格数（1-4）', String(old?.size?.cols || 2));
    if (colsRaw == null) return;
    const rowsRaw = window.prompt('高度格数（1-5）', String(old?.size?.rows || 2));
    if (rowsRaw == null) return;
    openTextEditorModal({
      title: '代码组件（HTML/CSS）',
      value: old?.html || '',
      placeholder: '<style>.box{color:#c98a6a}</style>\n<div class="box">Hi 🌷</div>',
      confirmLabel: '保存组件',
      onSave: (html) => {
        const nextId = old?.id || `custom-${Date.now()}`;
        const label = String(title || '代码组件').trim() || '代码组件';
        const nextItem = {
          ...(old || {}),
          id: nextId,
          kind: 'custom-widget',
          label,
          title: label,
          body: '',
          html: String(html || ''),
          size: {
            cols: Math.max(1, Math.min(4, Math.round(Number(colsRaw) || 2))),
            rows: Math.max(1, Math.min(5, Math.round(Number(rowsRaw) || 2))),
          },
        };
        commitCustomWidget(nextId, nextItem, !old);
      },
    });
  }

  function editCustomWidget(itemId) {
    const { theme: activeTheme } = getActiveTheme(prefs);
    const layout = normalizeHomeLayout(activeTheme.homeLayout, activeTheme.widgetVisibility);
    const item = layout.customItems[itemId];
    if (item && String(item.html || '').trim()) upsertCodeWidget(itemId);
    else upsertCustomWidget(itemId);
  }

  function deleteCustomWidget(itemId) {
    prefs = removeHomeWidgetLibraryItem(prefs, itemId);
    refreshWidgetManager();
    markAppearanceDirty();
  }

  function bindWidgetManagerActions() {
    const syncWidgetShareBar = () => {
      const activeTheme = getActiveTheme(prefs).theme;
      const customItems = normalizeHomeLayout(
        activeTheme?.homeLayout,
        activeTheme?.widgetVisibility,
      ).customItems || {};
      const count = container.querySelector('[data-widget-selected-count]');
      const share = container.querySelector('[data-custom-widget-share]');
      const selectAll = container.querySelector('[data-custom-widget-select-all]');
      if (count) count.textContent = `已选 ${selectedWidgetIds.size} 个`;
      if (share) share.disabled = selectedWidgetIds.size === 0;
      if (selectAll) selectAll.textContent = selectedWidgetIds.size === Object.keys(customItems).length ? '取消全选' : '全选';
    };
    container.querySelectorAll('[data-custom-widget-select]').forEach((input) => {
      input.addEventListener('change', () => {
        const itemId = String(input.getAttribute('data-custom-widget-select') || '').trim();
        if (!itemId) return;
        if (input.checked) selectedWidgetIds.add(itemId);
        else selectedWidgetIds.delete(itemId);
        syncWidgetShareBar();
      });
    });
    container.querySelector('[data-custom-widget-select-all]')?.addEventListener('click', () => {
      const inputs = [...container.querySelectorAll('[data-custom-widget-select]')];
      const shouldSelect = inputs.some((input) => !input.checked);
      selectedWidgetIds.clear();
      inputs.forEach((input) => {
        input.checked = shouldSelect;
        const itemId = String(input.getAttribute('data-custom-widget-select') || '').trim();
        if (shouldSelect && itemId) selectedWidgetIds.add(itemId);
      });
      syncWidgetShareBar();
    });
    container.querySelector('[data-custom-widget-share]')?.addEventListener('click', () => {
      try {
        prefs = collectDraft(container, prefs);
        const activeTheme = getActiveTheme(prefs).theme;
        const layout = normalizeHomeLayout(activeTheme?.homeLayout, activeTheme?.widgetVisibility);
        const source = buildHomeWidgetSharePayload(layout.customItems, [...selectedWidgetIds]);
        shareToCommunityStore({
          source,
          fileName: 'marshmallow-home-widgets.json',
          resourceType: 'beautify',
          resourceSubtype: 'home-widget',
          title: source.name,
          originLabel: '美化设置 · 组件库',
        });
      } catch (error) {
        showToast(`无法分享：${error?.message || error}`);
      }
    });
    container.querySelectorAll('[data-widget-delete]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const widgetId = String(btn.getAttribute('data-widget-delete') || '').trim();
        if (widgetId) setWidgetVisible(widgetId, false);
      });
    });
    container.querySelectorAll('[data-widget-restore]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const widgetId = String(btn.getAttribute('data-widget-restore') || '').trim();
        if (widgetId) setWidgetVisible(widgetId, true);
      });
    });
    container.querySelector('[data-custom-widget-add]')?.addEventListener('click', () => upsertCustomWidget());
    container.querySelector('[data-custom-widget-add-code]')?.addEventListener('click', () => upsertCodeWidget());
    container.querySelectorAll('[data-custom-widget-home]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const [itemId, action] = String(btn.getAttribute('data-custom-widget-home') || '').split(':');
        if (itemId) setCustomWidgetHomeVisible(itemId, action === 'show');
      });
    });
    container.querySelectorAll('[data-custom-widget-edit]').forEach((btn) => {
      btn.addEventListener('click', () => editCustomWidget(String(btn.getAttribute('data-custom-widget-edit') || '').trim()));
    });
    container.querySelectorAll('[data-custom-widget-delete]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const itemId = String(btn.getAttribute('data-custom-widget-delete') || '').trim();
        if (!itemId) return;
        if (!window.confirm('永久删除这个自定义组件？组件代码、图片和配色都会一并删除，且无法恢复。')) return;
        deleteCustomWidget(itemId);
      });
    });
  }

  async function downloadAiDoc() {
    await persistDraft().catch(() => {});
    const active = getActiveTheme(prefs);
    await downloadAiThemeReference(active.theme, { themeId: active.id });
    showToast('CSS 参考文档已下载');
  }

  container.querySelector('[data-download-ai-doc]')?.addEventListener('click', () => {
    downloadAiDoc().catch((err) => showToast(`下载失败：${(err && err.message) || err}`));
  });

  container.querySelector('[data-export-theme]')?.addEventListener('click', async () => {
    try {
      await persistDraft();
      const payload = await buildPortableThemeExportPayload(prefs);
      await downloadThemeExportPayload(payload);
      showToast('主题已导出');
    } catch (err) {
      showToast(`导出失败：${(err && err.message) || err}`);
    }
  });
  container.querySelector('[data-share-theme]')?.addEventListener('click', async () => {
    try {
      await persistDraft();
      const payload = await buildPortableThemeExportPayload(prefs);
      shareToCommunityStore({ source: payload, fileName: 'marshmallow-theme.json', resourceType: 'beautify', resourceSubtype: 'theme', title: payload.themeName || '美化主题', originLabel: '主题设置' });
    } catch (err) {
      showToast(`无法分享：${err?.message || err}`);
    }
  });

  // 导入整套美化主题：先解析校验，再弹窗让用户给主题起名，存成「新的美化主题」并切换应用，不再直接覆盖当前主题。
  async function importThemeWithPresetPrompt(text) {
    let payload;
    try {
      payload = parseThemeImportText(text);
    } catch (err) {
      showToast(`导入失败：${(err && err.message) || err}`);
      return;
    }
    const suggested = String(payload?.themeName || '').trim()
      || `导入主题 ${new Date().toLocaleDateString('zh-CN')}`;
    openTextEditorModal({
      title: '保存为美化主题',
      value: suggested,
      placeholder: '给这套美化起个名字',
      multiline: false,
      confirmLabel: '保存为新主题',
      onSave: async (input) => {
        const label = String(input || '').trim() || suggested;
        try {
          const res = await createThemePresetFromSnapshot(prefs, label, payload.theme, { activate: true });
          prefs = res.prefs;
          showToast('已保存为新主题并应用');
          navigate('settings/appearance', {}, true);
        } catch (err) {
          showToast(`保存失败：${(err && err.message) || err}`);
        }
      },
    });
  }

  container.querySelector('[data-import-theme-file]')?.addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      await importThemeWithPresetPrompt(text);
    } catch (err) {
      showToast(`导入失败：${(err && err.message) || err}`);
    }
  });

  container.querySelector('[data-apply-theme-paste]')?.addEventListener('click', async () => {
    const textarea = container.querySelector('[data-theme-paste]');
    const text = textarea ? String(textarea.value || '').trim() : '';
    if (!text) {
      showToast('请先粘贴主题 JSON');
      return;
    }
    await importThemeWithPresetPrompt(text);
  });

  container.querySelector('[data-restore-default-theme]')?.addEventListener('click', async () => {
    if (!window.confirm('将恢复当前主题的默认配色、CSS、字体、壁纸、组件和布局。继续？')) return;
    try {
      prefs = await restoreDefaultAppearanceTheme(prefs);
      showToast('已恢复当前主题默认');
      navigate('settings/appearance', {}, true);
    } catch (err) {
      showToast(`恢复失败：${(err && err.message) || err}`);
    }
  });

  container.querySelector('[data-save-preset]')?.addEventListener('click', async () => {
    const input = container.querySelector('[data-preset-name]');
    const name = input ? String(input.value || '').trim() : '';
    if (!name) {
      showToast('请填写预设名称');
      return;
    }
    try {
      prefs = collectDraft(container, prefs);
      const draftTheme = getActiveTheme(prefs).theme;
      prefs = await saveCurrentThemeAsPreset(prefs, name, draftTheme);
      if (input) input.value = '';
      showToast('已保存为预设');
      navigate('settings/appearance', {}, true);
    } catch (err) {
      showToast(`保存失败：${(err && err.message) || err}`);
    }
  });

  container.querySelector('[data-theme-chips]')?.addEventListener('click', async (e) => {
    const delBtn = e.target.closest('[data-theme-delete]');
    if (delBtn) {
      e.stopPropagation();
      const themeId = String(delBtn.getAttribute('data-theme-delete') || '').trim();
      if (!themeId || !window.confirm('删除该美化预设？')) return;
      try {
        prefs = await deleteThemePreset(prefs, themeId);
        showToast('预设已删除');
        navigate('settings/appearance', {}, true);
      } catch (err) {
        showToast(`删除失败：${(err && err.message) || err}`);
      }
      return;
    }
    const chip = e.target.closest('[data-theme-switch]');
    if (!chip) return;
    const themeId = String(chip.getAttribute('data-theme-switch') || '').trim();
    if (!themeId || themeId === getActiveTheme(prefs).id) return;
    if (!window.confirm('切换预设会重新加载页面，未保存的修改将丢失。继续？')) return;
    try {
      prefs = await switchActiveThemePreset(prefs, themeId);
      showToast('已切换主题');
      navigate('settings/appearance', {}, true);
    } catch (err) {
      showToast(`切换失败：${(err && err.message) || err}`);
    }
  });

  function previewDraftTheme() {
    prefs = collectDraft(container, prefs);
    updateThemePreview(container, getActiveTheme(prefs).theme);
  }

  async function persistDraft() {
    prefs = collectDraft(container, prefs);
    const css = String(getCustomThemeConfig(getActiveTheme(prefs).theme).css || '');
    if (css.length > MAX_CUSTOM_CSS_BYTES) {
      throw new Error(`自定义 CSS 过长，请控制在 ${Math.round(MAX_CUSTOM_CSS_BYTES / 1024)}KB 内`);
    }
    prefs = await saveAppearancePrefs(prefs, { refreshActiveHome: true });
    const savedTheme = getActiveTheme(prefs).theme;
    // 当前预览 DOM 在各上传/清除动作里已经即时更新；保存后重建整套观察队列会让
    // 可视区图片重复解码一次，也会把刚释放的历史大图重新拉回内存。
    updateThemePreview(container, savedTheme);
    return prefs;
  }

  let saveInFlight = null;
  container.querySelector('.appearance-save-btn').addEventListener('click', async () => {
    if (saveInFlight || !hasUnsavedChanges) return;
    const saveButton = container.querySelector('.appearance-save-btn');
    const pageBackButton = container.querySelector('[data-back]');
    const savingRevision = draftRevision;
    saveButton.disabled = true;
    saveButton.textContent = '保存中';
    saveButton.classList.remove('is-dirty');
    saveButton.setAttribute('aria-busy', 'true');
    if (saveState) saveState.textContent = '保存中';
    pageBackButton?.setAttribute('disabled', '');
    // IndexedDB 仍在写整份主题时禁止系统返回/侧滑离页，避免主屏先恢复旧 DOM。
    setLeaveGuard(() => false);
    try {
      saveInFlight = persistDraft();
      await saveInFlight;
      if (draftRevision === savingRevision) markAppearanceSaved();
      else markAppearanceDirty();
    } catch (err) {
      showToast(`保存失败：${(err && err.message) || err}`);
      markAppearanceDirty();
    } finally {
      saveInFlight = null;
      if (saveButton.isConnected) {
        saveButton.removeAttribute('aria-busy');
        saveButton.disabled = !hasUnsavedChanges;
        if (hasUnsavedChanges) {
          saveButton.textContent = '保存';
          saveButton.classList.add('is-dirty');
        }
      }
      if (hasUnsavedChanges) armUnsavedLeaveGuard();
      else clearLeaveGuard();
      if (pageBackButton?.isConnected) pageBackButton.removeAttribute('disabled');
    }
  });

  const persistedDraftFieldSelector = [
    '[data-user-greeting]',
    '[data-user-status]',
    '[data-wallpaper-opacity]',
    '[data-chat-bubble-font-size]',
    '[data-note-title]',
    '[data-note-items]',
    '[data-polaroid-caption-p1]',
    '[data-polaroid-caption-p3]',
    '[data-sea-text]',
    '[data-app-label]',
    '[data-custom-css]',
    '[data-chat-global-css]',
    '[data-home-text-var]',
    '[data-sea-gradient-enabled]',
    '[data-sea-gradient-strength]',
    '[data-sea-gradient-warm]',
    '[data-sea-gradient-warm-hex]',
    '[data-sea-gradient-cool]',
    '[data-sea-gradient-cool-hex]',
    '[data-sea-music-bg]',
    '[data-sea-music-bg-hex]',
    '[data-sea-music-text]',
    '[data-sea-music-text-hex]',
    '[data-sea-music-accent]',
    '[data-sea-music-accent-hex]',
    '[data-sea-music-bg-opacity]',
    '[data-window-frame-enabled]',
    '[data-album-gray-filter-enabled]',
    '[data-app-icon-edge]',
    '[data-app-icon-frame-opacity]',
  ].join(',');
  const markDraftFieldDirty = (event) => {
    if (event.target?.matches?.(persistedDraftFieldSelector)) markAppearanceDirty();
  };
  container.addEventListener('input', markDraftFieldDirty);
  container.addEventListener('change', markDraftFieldDirty);

  container.querySelector('[data-wallpaper-opacity]').addEventListener('input', (e) => {
    const { id, theme: activeTheme } = getActiveTheme(prefs);
    const nextTheme = {
      ...activeTheme,
      wallpaperOpacity: Number(e.target.value),
    };
    prefs = {
      ...prefs,
      themes: { ...prefs.themes, [id]: nextTheme },
    };
    applyWallpaperPreview(container, nextTheme);
    // 透明度拖动时只更新壁纸缩略图，不刷新全部分页预览，避免反复解码大图。
  });

  if (seaTemplate) {
    bindSeaGradientControls(container, () => prefs, () => {
      prefs = collectDraft(container, prefs);
      markAppearanceDirty();
    });
    bindSeaMusicColorControls(container, () => {
      prefs = collectDraft(container, prefs);
      updateThemePreview(container, getActiveTheme(prefs).theme);
      markAppearanceDirty();
    });
  }

  container.querySelector('[data-window-frame-enabled]')?.addEventListener('change', () => {
    prefs = collectDraft(container, prefs);
    applyWindowFrame(getActiveTheme(prefs).theme);
  });

  container.querySelector('[data-album-gray-filter-enabled]')?.addEventListener('change', () => {
    prefs = collectDraft(container, prefs);
    applyAlbumGrayFilter(getActiveTheme(prefs).theme);
  });

  const iconEdgeInput = container.querySelector('[data-app-icon-edge]');
  const iconFrameOpacityInput = container.querySelector('[data-app-icon-frame-opacity]');
  const iconFrameOpacityValue = container.querySelector('[data-app-icon-frame-opacity-value]');
  const syncIconFrameControls = () => {
    const enabled = iconEdgeInput?.checked !== false;
    if (iconFrameOpacityInput) iconFrameOpacityInput.disabled = !enabled;
    iconFrameOpacityInput?.closest('.appearance-icon-opacity-control')?.classList.toggle('is-disabled', !enabled);
  };
  iconEdgeInput?.addEventListener('change', () => {
    prefs = collectDraft(container, prefs);
    applyAppIconEdge(getActiveTheme(prefs).theme);
    syncIconFrameControls();
  });
  iconFrameOpacityInput?.addEventListener('input', () => {
    if (iconFrameOpacityValue) {
      iconFrameOpacityValue.textContent = `${Math.round(Number(iconFrameOpacityInput.value) * 100)}%`;
    }
    prefs = collectDraft(container, prefs);
    applyAppIconEdge(getActiveTheme(prefs).theme);
  });

  container.querySelector('[data-chat-bubble-font-size]')?.addEventListener('input', (e) => {
    const size = clampChatBubbleFontSize(e.target.value);
    const { id, theme: activeTheme } = getActiveTheme(prefs);
    const nextTheme = {
      ...activeTheme,
      chatBubbleFontSize: size,
    };
    prefs = {
      ...prefs,
      themes: { ...prefs.themes, [id]: nextTheme },
    };
    const preview = container.querySelector('[data-chat-font-preview]');
    const value = container.querySelector('[data-chat-font-value]');
    if (preview) preview.style.setProperty('--chat-bubble-font-size', `${size}px`);
    if (value) value.textContent = `${size}px`;
  });

  container.querySelector('[data-wallpaper-file]').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try {
      const dataUrl = await fileToCroppedCompressedDataUrl(file, IMAGE_CROP_PRESETS.wallpaper);
      if (!dataUrl) return;
      const { id, theme: activeTheme } = getActiveTheme(prefs);
      prefs = {
        ...prefs,
        themes: {
          ...prefs.themes,
          [id]: replaceThemeHomeWallpaper(activeTheme, dataUrl),
        },
      };
      applyWallpaperPreview(container, prefs.themes[id]);
      setupAppearanceLazyPreviews(container, prefs.themes[id]);
      container.querySelector('[data-wallpaper-clear]').disabled = false;
      markAppearanceDirty();
    } catch (err) {
      showToast(`上传失败：${(err && err.message) || err}`);
    }
    e.target.value = '';
  });

  container.querySelector('[data-wallpaper-url-apply]')?.addEventListener('click', () => {
    const inputEl = container.querySelector('[data-wallpaper-url]');
    let url = String(inputEl?.value || '').trim();
    if (!url) {
      showToast('先粘贴图片链接');
      return;
    }
    if (url.startsWith('//')) url = `https:${url}`;
    if (/^http:\/\//i.test(url)) url = `https://${url.slice(7)}`;
    if (!/^https:\/\//i.test(url)) {
      showToast('请填以 https:// 开头的图片直链（http 在 App 内会被拦截）');
      return;
    }
    const { id, theme: activeTheme } = getActiveTheme(prefs);
    prefs = {
      ...prefs,
      themes: {
        ...prefs.themes,
        [id]: replaceThemeHomeWallpaper(activeTheme, url),
      },
    };
    applyWallpaperPreview(container, prefs.themes[id]);
    setupAppearanceLazyPreviews(container, prefs.themes[id]);
    container.querySelector('[data-wallpaper-clear]').disabled = false;
    if (inputEl) inputEl.value = '';
    markAppearanceDirty();
  });

  container.querySelector('[data-wallpaper-default]').addEventListener('click', () => {
    const { id, theme: activeTheme } = getActiveTheme(prefs);
    const wpDefaults = getThemeBuiltinWallpaperDefaults(id);
    prefs = {
      ...prefs,
      themes: {
        ...prefs.themes,
        [id]: {
          ...activeTheme,
          wallpaper: wpDefaults.wallpaper,
          wallpaperOpacity: wpDefaults.wallpaperOpacity,
          homePageWallpapers: { ...wpDefaults.homePageWallpapers },
          homePanorama: wpDefaults.homePanorama ? { ...wpDefaults.homePanorama } : null,
        },
      },
    };
    applyWallpaperPreview(container, prefs.themes[id]);
    setupAppearanceLazyPreviews(container, prefs.themes[id]);
    const opacityInput = container.querySelector('[data-wallpaper-opacity]');
    if (opacityInput) opacityInput.value = String(wpDefaults.wallpaperOpacity);
    container.querySelector('[data-wallpaper-clear]').disabled = false;
    const panoClearReset = container.querySelector('[data-home-pano-clear]');
    if (panoClearReset) panoClearReset.disabled = !wpDefaults.homePanorama;
    markAppearanceDirty();
  });

  container.querySelector('[data-wallpaper-clear]').addEventListener('click', async () => {
    const { id, theme: activeTheme } = getActiveTheme(prefs);
    prefs = {
      ...prefs,
      themes: {
        ...prefs.themes,
        [id]: replaceThemeHomeWallpaper(activeTheme, WALLPAPER_NONE),
      },
    };
    applyWallpaperPreview(container, prefs.themes[id]);
    setupAppearanceLazyPreviews(container, prefs.themes[id]);
    container.querySelector('[data-wallpaper-clear]').disabled = true;
    markAppearanceDirty();
  });

  container.querySelectorAll('[data-home-page-wallpaper-file]').forEach((input) => {
    input.addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      const page = String(input.getAttribute('data-home-page-wallpaper-file') || '').trim();
      if (!file || !page) return;
      try {
        const dataUrl = await fileToCroppedCompressedDataUrl(file, {
          ...IMAGE_CROP_PRESETS.wallpaper,
          title: `裁剪第 ${page} 页壁纸`,
        });
        if (!dataUrl) return;
        const { id, theme: activeTheme } = getActiveTheme(prefs);
        const nextTheme = {
          ...activeTheme,
          homePageWallpapers: {
            ...(activeTheme.homePageWallpapers || {}),
            [page]: dataUrl,
          },
        };
        prefs = {
          ...prefs,
          themes: { ...prefs.themes, [id]: nextTheme },
        };
        refreshHomePageWallpaperPreviews(container, nextTheme);
        markAppearanceDirty();
      } catch (err) {
        showToast(`上传失败：${(err && err.message) || err}`);
      }
      e.target.value = '';
    });
  });

  const panoInput = container.querySelector('[data-home-pano-file]');
  if (panoInput) {
    panoInput.addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      try {
        // 主屏横图只在手机视口展示；控制解码尺寸可显著降低 Android WebView
        // 横滑时的纹理上传与显存压力，1800px 对 3–4 页仍有足够清晰度。
        const dataUrl = await compressImageToDataUrl(file, { maxSize: 1800, quality: 0.8 });
        const { id, theme: activeTheme } = getActiveTheme(prefs);
        const pageCount = Math.max(1, Math.min(6, (activeTheme.homeLayout?.pages?.length) || 3));
        const nextTheme = {
          ...activeTheme,
          // 单页壁纸层级高于横图；设横图时清掉分页覆盖，否则上传成功后视觉上仍像没生效。
          homePageWallpapers: {},
          homePanorama: { src: dataUrl, pages: pageCount },
        };
        prefs = { ...prefs, themes: { ...prefs.themes, [id]: nextTheme } };
        applyWallpaperPreview(container, nextTheme);
        setupAppearanceLazyPreviews(container, nextTheme);
        const clearBtn = container.querySelector('[data-home-pano-clear]');
        if (clearBtn) clearBtn.disabled = false;
        markAppearanceDirty();
      } catch (err) {
        showToast(`处理失败：${(err && err.message) || err}`);
      }
      e.target.value = '';
    });
  }

  const panoClearBtn = container.querySelector('[data-home-pano-clear]');
  if (panoClearBtn) {
    panoClearBtn.addEventListener('click', () => {
      const { id, theme: activeTheme } = getActiveTheme(prefs);
      const nextTheme = { ...activeTheme, homePanorama: null };
      prefs = { ...prefs, themes: { ...prefs.themes, [id]: nextTheme } };
      applyWallpaperPreview(container, nextTheme);
      setupAppearanceLazyPreviews(container, nextTheme);
      panoClearBtn.disabled = true;
      markAppearanceDirty();
    });
  }

  container.querySelectorAll('[data-home-page-wallpaper-clear]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const page = String(btn.getAttribute('data-home-page-wallpaper-clear') || '').trim();
      if (!page) return;
      const { id, theme: activeTheme } = getActiveTheme(prefs);
      const homePageWallpapers = { ...(activeTheme.homePageWallpapers || {}) };
      // 「清除」应真正移除这一页的覆盖，让它继承全局壁纸/横图。
      // 内置分页图只应由「恢复默认」恢复，不能在清除时悄悄写回来。
      delete homePageWallpapers[page];
      const nextTheme = { ...activeTheme, homePageWallpapers };
      prefs = {
        ...prefs,
        themes: { ...prefs.themes, [id]: nextTheme },
      };
      refreshHomePageWallpaperPreviews(container, nextTheme);
      markAppearanceDirty();
    });
  });

  container.querySelector('[data-avatar-file]').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try {
      const dataUrl = await fileToCroppedCompressedDataUrl(file, IMAGE_CROP_PRESETS.avatar);
      if (!dataUrl) return;
      const { id, theme: activeTheme } = getActiveTheme(prefs);
      prefs = {
        ...prefs,
        themes: {
          ...prefs.themes,
          [id]: {
            ...activeTheme,
            userCard: { ...(activeTheme.userCard || {}), avatarDataUrl: dataUrl },
          },
        },
      };
      container.querySelector('[data-avatar-clear]').disabled = false;
      markAppearanceDirty();
    } catch (err) {
      showToast(`上传失败：${(err && err.message) || err}`);
    }
    e.target.value = '';
  });

  container.querySelector('[data-avatar-clear]').addEventListener('click', () => {
    const { id, theme: activeTheme } = getActiveTheme(prefs);
    prefs = {
      ...prefs,
      themes: {
        ...prefs.themes,
        [id]: {
          ...activeTheme,
          userCard: { ...(activeTheme.userCard || {}), avatarDataUrl: '' },
        },
      },
    };
    container.querySelector('[data-avatar-clear]').disabled = true;
    markAppearanceDirty();
  });

  container.querySelector('[data-font-file]').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    if (!isFontFile(file)) {
      showToast('请选择 .ttf / .ttc / .otf / .woff / .woff2 字体文件');
      e.target.value = '';
      return;
    }
    if (file.size > MAX_CUSTOM_FONT_BYTES) {
      showToast(`字体文件过大，请控制在 ${Math.round(MAX_CUSTOM_FONT_BYTES / 1024 / 1024)}MB 以内`);
      e.target.value = '';
      return;
    }
    try {
      const dataUrl = normalizeFontDataUrl(await readFileAsDataUrl(file), file.name);
      const { id, theme: activeTheme } = getActiveTheme(prefs);
      prefs = {
        ...prefs,
        themes: {
          ...prefs.themes,
          [id]: {
            ...activeTheme,
            customFont: {
              dataUrl,
              fileName: String(file.name || '自定义字体').trim(),
              styleUrl: '',
              family: '',
            },
          },
        },
      };
      updateThemePreview(container, prefs.themes[id]);
      markAppearanceDirty();
    } catch (err) {
      showToast(`导入失败：${(err && err.message) || err}`);
    }
    e.target.value = '';
  });

  container.querySelector('[data-font-reset]').addEventListener('click', () => {
    const { id, theme: activeTheme } = getActiveTheme(prefs);
    prefs = {
      ...prefs,
      themes: {
        ...prefs.themes,
        [id]: {
          ...activeTheme,
          customFont: { dataUrl: '', fileName: '', styleUrl: '', family: '' },
        },
      },
    };
    updateThemePreview(container, prefs.themes[id]);
    markAppearanceDirty();
  });

  container.querySelector('[data-font-url-apply]')?.addEventListener('click', async () => {
    const inputEl = container.querySelector('[data-font-url]');
    const applyBtn = container.querySelector('[data-font-url-apply]');
    const raw = inputEl ? inputEl.value.trim() : '';
    if (!raw) { showToast('请先粘贴字体链接'); return; }
    if (applyBtn) { applyBtn.disabled = true; applyBtn.textContent = '解析中…'; }
    try {
      const resolved = await resolveCustomFontUrl(raw);
      if (resolved.dataUrl) {
        const ok = await verifyFontUrlLoadable(resolved.dataUrl);
        if (!ok) {
          showToast('这个链接的字体加载失败：该站点多半禁止跨域引用（CORS）或需要验证。请下载后改用「上传字体」。');
          return;
        }
      }
      const { id, theme: activeTheme } = getActiveTheme(prefs);
      prefs = {
        ...prefs,
        themes: {
          ...prefs.themes,
          [id]: {
            ...activeTheme,
            customFont: {
              dataUrl: resolved.dataUrl,
              fileName: resolved.fileName,
              styleUrl: resolved.styleUrl,
              family: resolved.family,
            },
          },
        },
      };
      if (inputEl) inputEl.value = '';
      updateThemePreview(container, prefs.themes[id]);
      markAppearanceDirty();
    } catch (err) {
      showToast((err && err.message) || '链接无法使用');
    } finally {
      if (applyBtn) { applyBtn.disabled = false; applyBtn.textContent = '用链接'; }
    }
  });

  container.querySelector('[data-home-text-vars-reset]')?.addEventListener('click', () => {
    const { id, theme: activeTheme } = getActiveTheme(prefs);
    prefs = {
      ...prefs,
      themes: {
        ...prefs.themes,
        [id]: {
          ...activeTheme,
          customTheme: {
            ...(activeTheme.customTheme || {}),
            homeTextVars: {},
            cssVars: {},
          },
        },
      },
    };
    container.querySelectorAll('[data-home-text-var]').forEach((input) => {
      const fallback = String(input.getAttribute('data-css-default') || '').trim();
      if (fallback) input.value = fallback;
      const item = input.closest('.appearance-token-item');
      const hexInput = item && item.querySelector('[data-home-text-hex]');
      if (hexInput) {
        hexInput.value = String(input.value || '').toLowerCase();
        hexInput.classList.remove('is-invalid');
      }
    });
    previewDraftTheme();
    markAppearanceDirty();
  });

  container.querySelector('[data-custom-css-reset]')?.addEventListener('click', () => {
    const textarea = container.querySelector('[data-custom-css]');
    if (textarea) textarea.value = '';
    previewDraftTheme();
    markAppearanceDirty();
  });

  container.querySelector('[data-offline-css-emergency-clear]')?.addEventListener('click', async () => {
    if (!window.confirm('清空线下进行页的自定义 CSS？用于写坏布局、按钮点不到时急救；底色/底图/字号等其它线下美化会保留。')) return;
    try {
      const userId = await getCurrentUserId();
      if (!userId) {
        showToast('未找到当前用户，无法清空');
        return;
      }
      const result = await clearOfflineStyleCss(userId);
      showToast(result.cleared ? '已清空并校验线下 CSS，打开的线下页也已同步' : '线下 CSS 已确认是空的');
    } catch (err) {
      showToast(`清空失败：${(err && err.message) || err}`);
    }
  });

  const chatCssEmergencyPanel = container.querySelector('[data-chat-session-css-emergency-panel]');
  const chatCssEmergencySelect = container.querySelector('[data-chat-session-css-emergency-select]');
  const hideChatCssEmergencyPanel = () => {
    if (chatCssEmergencyPanel) chatCssEmergencyPanel.hidden = true;
  };
  container.querySelector('[data-chat-session-css-emergency]')?.addEventListener('click', async () => {
    try {
      const userId = await getCurrentUserId();
      if (!userId) {
        showToast('未找到当前用户，无法清空');
        return;
      }
      const rows = await listChatsWithSessionCss(userId);
      if (!rows.length) {
        hideChatCssEmergencyPanel();
        showToast('当前档位没有写过会话 CSS 的聊天');
        return;
      }
      if (chatCssEmergencySelect) {
        chatCssEmergencySelect.innerHTML = rows.map((row) => {
          const kind = row.type === 'group' ? '群' : '私聊';
          const parts = row.parts?.length ? ` · ${row.parts.join('+')}` : '';
          return `<option value="${esc(row.id)}">[${esc(kind)}] ${esc(row.title)}${esc(parts)}</option>`;
        }).join('');
      }
      if (chatCssEmergencyPanel) chatCssEmergencyPanel.hidden = false;
    } catch (err) {
      showToast(`加载会话失败：${(err && err.message) || err}`);
    }
  });
  container.querySelector('[data-chat-session-css-emergency-cancel]')?.addEventListener('click', () => {
    hideChatCssEmergencyPanel();
  });
  container.querySelector('[data-chat-session-css-emergency-confirm]')?.addEventListener('click', async () => {
    const chatId = String(chatCssEmergencySelect?.value || '').trim();
    if (!chatId) {
      showToast('请先选择会话');
      return;
    }
    const label = chatCssEmergencySelect?.selectedOptions?.[0]?.textContent?.trim() || '该会话';
    if (!window.confirm(`清除「${label}」的会话自定义 CSS？气泡色/壁纸/字号会保留；写坏导致进不了详情时用这个急救。`)) return;
    try {
      const result = await clearChatSessionCss(chatId);
      hideChatCssEmergencyPanel();
      showToast(result.cleared ? '已清除该会话 CSS，重新进入聊天即可' : '该会话 CSS 本来就是空的');
    } catch (err) {
      showToast(`清除失败：${(err && err.message) || err}`);
    }
  });
  container.querySelector('[data-chat-session-layout-repair-confirm]')?.addEventListener('click', async () => {
    const chatId = String(chatCssEmergencySelect?.value || '').trim();
    if (!chatId) {
      showToast('请先选择会话');
      return;
    }
    try {
      await repairChatSessionMessageLayout(chatId);
      hideChatCssEmergencyPanel();
      showToast('已补回我方在右、对方在左，其它会话美化已保留');
    } catch (err) {
      showToast(`修复失败：${(err && err.message) || err}`);
    }
  });

  container.querySelector('[data-custom-css]')?.addEventListener('input', () => {
    previewDraftTheme();
  });
  container.querySelector('[data-chat-global-layout-repair]')?.addEventListener('click', () => {
    const textarea = container.querySelector('[data-chat-global-css]');
    if (!textarea) return;
    textarea.value = withChatMessageLayoutRepair(textarea.value);
    previewDraftTheme();
    markAppearanceDirty();
  });

  container.querySelector('[data-export-custom-css]')?.addEventListener('click', async () => {
    try {
      const textarea = container.querySelector('[data-custom-css]');
      await downloadTextFile(textarea ? textarea.value : '', `marshmallow-home-${Date.now()}.css`);
      showToast('CSS 已导出');
    } catch (err) {
      showToast(`导出失败：${err?.message || err}`);
    }
  });
  container.querySelector('[data-share-custom-css]')?.addEventListener('click', () => {
    const cssText = container.querySelector('[data-custom-css]')?.value || '';
    if (!cssText.trim()) { showToast('当前没有可分享的 CSS'); return; }
    shareToCommunityStore({ source: cssText, fileName: 'marshmallow-home.css', resourceType: 'beautify', resourceSubtype: 'home-style', title: '主屏美化', originLabel: '外观设置' });
  });

  container.querySelector('[data-import-custom-css-file]')?.addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      const textarea = container.querySelector('[data-custom-css]');
      if (textarea) textarea.value = text;
      previewDraftTheme();
      markAppearanceDirty();
    } catch (err) {
      showToast(`导入失败：${(err && err.message) || err}`);
    }
  });

  container.querySelector('[data-chat-global-css-reset]')?.addEventListener('click', () => {
    const textarea = container.querySelector('[data-chat-global-css]');
    if (textarea) textarea.value = '';
    previewDraftTheme();
    markAppearanceDirty();
  });
  container.querySelector('[data-chat-global-css]')?.addEventListener('input', () => {
    previewDraftTheme();
  });
  container.querySelector('[data-download-chat-css-doc]')?.addEventListener('click', async () => {
    try {
      await downloadTextFile(buildChatAppearanceReferenceMarkdown(), `marshmallow-chat-css-reference-${Date.now()}.md`);
      showToast('CSS 参考文档已下载');
    } catch (err) {
      showToast(`下载失败：${(err && err.message) || err}`);
    }
  });

  container.querySelector('[data-export-chat-global-css]')?.addEventListener('click', async () => {
    try {
      const textarea = container.querySelector('[data-chat-global-css]');
      await downloadTextFile(textarea ? textarea.value : '', `marshmallow-chat-global-${Date.now()}.css`);
      showToast('CSS 已导出');
    } catch (err) {
      showToast(`导出失败：${err?.message || err}`);
    }
  });
  container.querySelector('[data-share-chat-global-css]')?.addEventListener('click', () => {
    const cssText = container.querySelector('[data-chat-global-css]')?.value || '';
    if (!cssText.trim()) { showToast('当前没有可分享的 CSS'); return; }
    shareToCommunityStore({ source: cssText, fileName: 'marshmallow-chat.css', resourceType: 'beautify', resourceSubtype: 'chat-style', title: '聊天美化', originLabel: '外观设置' });
  });

  container.querySelector('[data-import-chat-global-css-file]')?.addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      const textarea = container.querySelector('[data-chat-global-css]');
      if (textarea) textarea.value = text;
      previewDraftTheme();
      markAppearanceDirty();
    } catch (err) {
      showToast(`导入失败：${(err && err.message) || err}`);
    }
  });

  container.querySelectorAll('.appearance-token-item').forEach((item) => {
    const colorInput = item.querySelector('[data-home-text-var]');
    if (!colorInput) return;
    const hexInput = item.querySelector('[data-home-text-hex]');
    colorInput.addEventListener('input', () => {
      if (hexInput) {
        hexInput.value = String(colorInput.value || '').toLowerCase();
        hexInput.classList.remove('is-invalid');
      }
      previewDraftTheme();
    });
    if (hexInput) {
      hexInput.addEventListener('input', () => {
        const hex = normalizeHexText(hexInput.value);
        if (hex) {
          hexInput.classList.remove('is-invalid');
          colorInput.value = hex;
          previewDraftTheme();
        } else {
          hexInput.classList.add('is-invalid');
        }
      });
      hexInput.addEventListener('blur', () => {
        const hex = normalizeHexText(hexInput.value);
        if (hex) {
          hexInput.value = hex;
        } else {
          hexInput.value = String(colorInput.value || '').toLowerCase();
        }
        hexInput.classList.remove('is-invalid');
      });
    }
  });

  bindWidgetManagerActions();

  container.querySelectorAll('[data-app-icon-file]').forEach((input) => {
    input.addEventListener('change', async (e) => {
      const appId = String(input.getAttribute('data-app-icon-file') || '').trim();
      const file = e.target.files && e.target.files[0];
      if (!appId || !file) return;
      try {
        const dataUrl = await fileToCroppedCompressedDataUrl(file, IMAGE_CROP_PRESETS.icon);
        if (!dataUrl) return;
        const { id, theme: activeTheme } = getActiveTheme(prefs);
        prefs = {
          ...prefs,
          themes: {
            ...prefs.themes,
            [id]: {
              ...activeTheme,
              appIcons: { ...(activeTheme.appIcons || {}), [appId]: dataUrl },
            },
          },
        };
        const row = container.querySelector(`[data-app-icon-row="${appId}"]`);
        const preview = row?.querySelector('.appearance-icon-preview');
        const status = row?.querySelector('[data-app-icon-status]');
        const clearBtn = row?.querySelector(`[data-app-icon-clear="${appId}"]`);
        if (preview) preview.innerHTML = `<img src="${esc(dataUrl)}" alt="">`;
        if (status) status.textContent = '已替换';
        if (clearBtn) clearBtn.disabled = false;
        markAppearanceDirty();
      } catch (err) {
        showToast(`上传失败：${(err && err.message) || err}`);
      }
      e.target.value = '';
    });
  });

  container.querySelectorAll('[data-app-icon-clear]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const appId = String(btn.getAttribute('data-app-icon-clear') || '').trim();
      if (!appId) return;
      const { id, theme: activeTheme } = getActiveTheme(prefs);
      const nextIcons = { ...(activeTheme.appIcons || {}) };
      delete nextIcons[appId];
      prefs = {
        ...prefs,
        themes: {
          ...prefs.themes,
          [id]: { ...activeTheme, appIcons: nextIcons },
        },
      };
      const row = container.querySelector(`[data-app-icon-row="${appId}"]`);
      const preview = row?.querySelector('.appearance-icon-preview');
      const status = row?.querySelector('[data-app-icon-status]');
      if (preview) preview.innerHTML = `<span class="appearance-icon-svg">${editableAppDefaultIcon(appId)}</span>`;
      if (status) status.textContent = '默认';
      btn.disabled = true;
      markAppearanceDirty();
    });
  });

  async function bindWidgetUpload(selector, widgetKey, compressOptions = { maxSize: 1400, quality: 0.85 }, cropPreset = IMAGE_CROP_PRESETS.photo) {
    const input = container.querySelector(selector);
    if (!input) return;
    input.addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      try {
        // PNG/WebP cutouts keep alpha; JPEG stays JPEG via crop/compress defaults.
        const preserveAlpha = !!compressOptions.preserveAlpha
          || /image\/(png|webp)/i.test(String(file.type || ''));
        const dataUrl = await fileToCroppedCompressedDataUrl(file, {
          ...cropPreset,
          compress: { ...compressOptions, preserveAlpha },
          preserveAlpha,
          outputMaxEdge: compressOptions.maxSize || cropPreset.outputMaxEdge,
        });
        if (!dataUrl) return;
        const { id, theme: activeTheme } = getActiveTheme(prefs);
        prefs = {
          ...prefs,
          themes: {
            ...prefs.themes,
            [id]: {
              ...activeTheme,
              widgets: { ...(activeTheme.widgets || {}), [widgetKey]: dataUrl },
            },
          },
        };
        markAppearanceDirty();
      } catch (err) {
        showToast(`上传失败：${(err && err.message) || err}`);
      }
      e.target.value = '';
    });
  }

  bindWidgetUpload('[data-polaroid-p1-file]', 'polaroidPhotoP1', { maxSize: 1200, quality: 0.85 }, IMAGE_CROP_PRESETS.photo);
  bindWidgetUpload('[data-polaroid-p3-file]', 'polaroidPhotoP3', { maxSize: 1200, quality: 0.85 }, IMAGE_CROP_PRESETS.photo);
  bindWidgetUpload('[data-film-ring-file]', 'filmRingDataUrl', { maxSize: 800, preserveAlpha: true }, IMAGE_CROP_PRESETS.icon);
  bindWidgetUpload('[data-film-sticker-file]', 'filmStickerDataUrl', { maxSize: 800, preserveAlpha: true }, IMAGE_CROP_PRESETS.icon);
  container.querySelectorAll('[data-sea-image-file]').forEach((input) => {
    const widgetKey = String(input.getAttribute('data-sea-image-file') || '').trim();
    if (widgetKey) bindWidgetUpload(`[data-sea-image-file="${widgetKey}"]`, widgetKey, { maxSize: 1400, quality: 0.85 }, IMAGE_CROP_PRESETS.photo);
  });
}
