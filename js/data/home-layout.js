/** 主屏预设布局：图标 SVG + 路由映射（坐标固定，仅 prefs 改文案/图） */

import {
  BUILTIN_HOME_WIDGET_DEFS,
  HOME_GRID_BUILTIN_IDS,
  MAX_HOME_PAGES,
  MIN_HOME_PAGES,
  COMING_SOON_APP_IDS,
} from '../core/appearance-prefs.js';
import { getCommercialHomeIcon } from './home-commercial-icons.js';
export { isHomeAppGroup } from './home-app-groups.js';

export const PAGE_ONE_APPS = ['chat', 'worldbook', 'preset', 'encounter'];
export const PAGE_TWO_APPS = ['weibo', 'forum', 'stickers', 'anon-chat', 'radio'];
export const PAGE_THREE_APPS = ['memory', 'music', 'mailbox', 'character-phone', 'au'];
export const PAGE_FOUR_APPS = ['travel-char', 'extensions', 'mcp', 'appearance', 'beautify'];
export const PAGE_FIVE_APPS = ['together-reading', ...COMING_SOON_APP_IDS];
export const DOCK_APPS = ['contacts', 'calendar', 'settings', 'my-space'];

export const APP_BG = {
  chat: 'bg-cream',
  worldbook: 'bg-blue-light',
  preset: 'bg-peach',
  encounter: 'bg-cream',
  weibo: 'bg-peach',
  forum: 'bg-blue',
  stickers: 'bg-cream',
  au: 'bg-cream',
  companion: 'bg-peach',
  radio: 'bg-cream',
  memory: 'bg-peach',
  music: 'bg-blue-light',
  'travel-char': 'bg-peach',
  extensions: 'bg-blue-light',
  'anon-chat': 'bg-cream',
  'character-phone': 'bg-blue-light',
  mailbox: 'bg-cream',
  appearance: 'bg-blue',
  beautify: 'bg-blue-light',
  'my-space': 'bg-peach',
  contacts: 'bg-blue-light',
  calendar: 'bg-peach',
  settings: 'bg-cream',
  live: 'bg-blue-light',
  'couple-space': 'bg-peach',
  'together-reading': 'bg-blue-light',
  'parallel-universe': 'bg-blue',
  shopping: 'bg-cream',
  mcp: 'bg-blue-light',
  'app-store': 'bg-peach',
  'play-together': 'bg-blue-light',
  'strategy-game': 'bg-cream',
};

export const APP_ROUTES = {
  chat: 'chat',
  worldbook: 'worldbook',
  preset: 'presets',
  encounter: 'encounter',
  weibo: 'weibo',
  forum: 'forum',
  stickers: 'stickers',
  au: 'au',
  companion: 'companion',
  radio: 'radio',
  memory: 'memory',
  music: 'music',
  'travel-char': 'travel-char',
  extensions: 'extensions',
  'anon-chat': 'anon-chat',
  'character-phone': 'character-phone',
  mailbox: 'mailbox',
  appearance: 'settings/appearance',
  beautify: 'beautify',
  'my-space': 'user-space',
  contacts: 'contacts',
  calendar: 'calendar',
  settings: 'settings',
  live: '__coming-soon__',
  'couple-space': '__coming-soon__',
  'together-reading': 'together-reading',
  'parallel-universe': '__coming-soon__',
  shopping: 'shopping',
  mcp: 'mcp',
  'app-store': 'app-store',
  'play-together': '__coming-soon__',
  'strategy-game': '__coming-soon__',
};

// 棉花糖之窗图标：统一 100×100 viewBox、纯线条几何、无填充无颜色，
// 描边/半透明由 home-window.css 控制（stroke: var(--mw-icon)）。线条干净利落。
const WINDOW_ICONS = {
  chat: '<svg viewBox="0 0 100 100" aria-hidden="true"><path d="M28 33h44a8 8 0 0 1 8 8v18a8 8 0 0 1-8 8H47L33 79V67h-5a8 8 0 0 1-8-8V41a8 8 0 0 1 8-8z"/></svg>',
  worldbook: '<svg viewBox="0 0 100 100" aria-hidden="true"><path d="M50 30c-7-5-16-6-22-5v44c6-1 15 0 22 5 7-5 16-6 22-5V25c-6-1-15 0-22 5z"/><path d="M50 30v44"/></svg>',
  preset: '<svg viewBox="0 0 100 100" aria-hidden="true"><path d="M24 36h52M24 64h52"/><circle cx="40" cy="36" r="7"/><circle cx="62" cy="64" r="7"/></svg>',
  encounter: '<svg viewBox="0 0 100 100" aria-hidden="true"><path d="M50 78c0-16 16-19 16-36a16 16 0 0 0-32 0c0 17 16 20 16 36z"/><circle cx="50" cy="42" r="6"/></svg>',
  weibo: '<svg viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="26"/><path d="M24 50h52M50 24c8 8 8 44 0 52M50 24c-8 8-8 44 0 52"/></svg>',
  forum: '<svg viewBox="0 0 100 100" aria-hidden="true"><path d="M26 32h34a7 7 0 0 1 7 7v14a7 7 0 0 1-7 7H40L29 78V60h-3a7 7 0 0 1-7-7V39a7 7 0 0 1 7-7z"/><path d="M70 44h4a7 7 0 0 1 7 7v12"/></svg>',
  stickers: '<svg viewBox="0 0 100 100" aria-hidden="true"><path d="M30 26h28l16 16v32a6 6 0 0 1-6 6H30a6 6 0 0 1-6-6V32a6 6 0 0 1 6-6z"/><path d="M57 26v18h17"/></svg>',
  companion: '<svg viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="24"/><path d="M50 26V31M50 50 34.4 41M50 50 65.6 41"/><circle cx="50" cy="50" r="2.6" fill="#000"/></svg>',
  radio: '<svg viewBox="0 0 100 100" aria-hidden="true"><rect x="25" y="30" width="50" height="42" rx="5"/><path d="M34 30 65 18M36 44h28M36 55h18"/><circle cx="64" cy="58" r="5"/></svg>',
  memory: '<svg viewBox="0 0 100 100" aria-hidden="true"><path d="M50 72C43 64 28 55 28 43A13 13 0 0 1 50 35 13 13 0 0 1 72 43C72 55 57 64 50 72Z"/><path d="M24 52H42L47 40 52 64 57 52H76"/></svg>',
  music: '<svg viewBox="0 0 100 100" aria-hidden="true"><path d="M42 66V30l30-7v36"/><circle cx="34" cy="68" r="9"/><circle cx="64" cy="61" r="9"/></svg>',
  'anon-chat': '<svg viewBox="0 0 100 100" aria-hidden="true"><path d="M38 46V38a12 12 0 0 1 24 0v8"/><rect x="30" y="46" width="40" height="30" rx="7"/><path d="M50 61v7"/><circle cx="50" cy="58" r="4" fill="#000"/></svg>',
  'character-phone': '<svg viewBox="0 0 100 100" aria-hidden="true"><rect x="34" y="20" width="32" height="60" rx="8"/><path d="M44 70h12"/></svg>',
  au: '<svg viewBox="0 0 100 100" aria-hidden="true"><path d="M50 22l7 21 21 7-21 7-7 21-7-21-21-7 21-7z"/></svg>',
  'travel-char': '<svg viewBox="0 0 100 100" aria-hidden="true"><path d="M50 22 26 74l24-12 24 12z"/><path d="M50 22V62"/></svg>',
  extensions: '<svg viewBox="0 0 100 100" aria-hidden="true"><path d="M27 28h46v44H27z"/><path d="M36 41h28M36 51h18M36 61h23"/><path d="M69 23v10M64 28h10"/></svg>',
  appearance: '<svg viewBox="0 0 100 100" aria-hidden="true"><path d="M50 24a26 26 0 1 0 0 52c5 0 7-3 7-7 0-5 3-7 8-7h6a6 6 0 0 0 6-6 27 27 0 0 0-27-26z"/><circle cx="38" cy="44" r="3.5"/><circle cx="52" cy="36" r="3.5"/><circle cx="64" cy="46" r="3.5"/></svg>',
  beautify: '<svg viewBox="0 0 100 100" aria-hidden="true"><path d="M24 28h52v44H24z"/><path d="M24 41h52M40 28v44"/><circle cx="58" cy="55" r="8"/><path d="M63 61l10 10"/></svg>',
  contacts: '<svg viewBox="0 0 100 100" aria-hidden="true"><rect x="26" y="24" width="48" height="52" rx="8"/><circle cx="50" cy="44" r="8"/><path d="M38 64c2-7 6-10 12-10s10 3 12 10"/></svg>',
  calendar: '<svg viewBox="0 0 100 100" aria-hidden="true"><rect x="24" y="28" width="52" height="48" rx="8"/><path d="M24 42h52M38 22v12M62 22v12"/></svg>',
  settings: '<svg viewBox="0 0 100 100" aria-hidden="true"><path d="M24 36H76M24 50H76M24 64H76"/><circle cx="44" cy="36" r="5.5" fill="#000"/><circle cx="60" cy="50" r="5.5" fill="#000"/><circle cx="36" cy="64" r="5.5" fill="#000"/></svg>',
  'my-space': '<svg viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="38" r="14"/><path d="M26 78c2-15 12-24 24-24s22 9 24 24"/></svg>',
};

export function getWindowIconSvg(appId) {
  return WINDOW_ICONS[appId] || getCommercialHomeIcon(appId) || WINDOW_ICONS.settings;
}

const ICONS = {
  chat: '<svg viewBox="0 0 100 100"><path d="M20 60 Q20 30 50 30 Q80 30 80 60 Q80 80 60 80 L50 80 L30 90 L35 75 Q20 70 20 60" fill="#b6cde0"/><circle cx="40" cy="55" r="4" fill="#5c7b8f"/><circle cx="60" cy="55" r="4" fill="#5c7b8f"/></svg>',
  worldbook: '<svg viewBox="0 0 100 100"><circle cx="35" cy="40" r="6" fill="#f1b98f"/><circle cx="65" cy="60" r="4" fill="#fff"/><circle cx="25" cy="70" r="5" fill="#5c7b8f"/></svg>',
  preset: '<svg viewBox="0 0 100 100"><path d="M20 70 Q50 40 80 70 L50 80 Z" fill="#b6cde0"/><circle cx="50" cy="30" r="12" fill="#f1b98f"/></svg>',
  encounter: '<svg viewBox="0 0 100 100"><path d="M30 70 Q30 30 50 30 Q70 30 70 70" fill="none" stroke="#b6cde0" stroke-width="10" stroke-linecap="round"/><circle cx="50" cy="70" r="8" fill="#f1b98f"/></svg>',
  weibo: '<svg viewBox="0 0 100 100"><path d="M50 25 C75 25 90 40 90 40 C90 40 75 75 50 75 C25 75 10 40 10 40 C10 40 25 25 50 25" fill="#fff"/><circle cx="50" cy="50" r="15" fill="#5c7b8f"/></svg>',
  forum: '<svg viewBox="0 0 100 100"><path d="M20 40 Q30 20 50 20 Q70 20 80 40 Q90 60 70 70 Q50 80 30 70 Q10 60 20 40" fill="#fff"/></svg>',
  stickers: '<svg viewBox="0 0 100 100"><path d="M30 30 L70 30 L70 70 L30 70 Z" fill="#f8d3c5"/><circle cx="50" cy="50" r="12" fill="#fff"/><path d="M60 20 L80 40 L80 20 Z" fill="#b6cde0"/></svg>',
  au: '<svg viewBox="0 0 100 100"><path d="M30 30 Q50 10 70 30 Q90 50 70 70 Q50 90 30 70 Q10 50 30 30" fill="#d5e4ed"/><path d="M20 50 Q50 80 80 50" fill="none" stroke="#f1b98f" stroke-width="4"/></svg>',
  companion: '<svg viewBox="0 0 100 100"><circle cx="50" cy="54" r="30" fill="#fff"/><circle cx="50" cy="54" r="30" fill="none" stroke="#b6cde0" stroke-width="5"/><circle cx="50" cy="54" r="4.5" fill="#f1b98f"/><path d="M50 54 L50 32" stroke="#5c7b8f" stroke-width="5" stroke-linecap="round"/><path d="M50 54 L66 60" stroke="#f1b98f" stroke-width="4" stroke-linecap="round"/><circle cx="50" cy="22" r="4" fill="#b6cde0"/></svg>',
  radio: '<svg viewBox="0 0 100 100"><rect x="20" y="28" width="60" height="46" rx="8" fill="#fff"/><path d="M28 28 L67 17" fill="none" stroke="#5c7b8f" stroke-width="4" stroke-linecap="round"/><path d="M31 43h38M31 54h20" stroke="#b6cde0" stroke-width="4" stroke-linecap="round"/><circle cx="67" cy="59" r="7" fill="#f1b98f"/></svg>',
  memory: '<svg viewBox="0 0 100 100"><circle cx="50" cy="40" r="15" fill="#fff"/><path d="M50 55 L50 80 M40 65 L50 55 L60 65" fill="none" stroke="#5c7b8f" stroke-width="4" stroke-linecap="round"/></svg>',
  music: '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="25" fill="#fff"/><circle cx="50" cy="50" r="7" fill="#f1b98f"/></svg>',
  'travel-char': '<svg viewBox="0 0 100 100"><rect x="20" y="28" width="60" height="42" rx="6" fill="#fff"/><path d="M24 40 L46 52 L76 36" fill="none" stroke="#b6cde0" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/><path d="M62 22 C54 22 50 28 50 36 C50 50 62 64 62 64 C62 64 74 50 74 36 C74 28 70 22 62 22 Z" fill="#e77878"/><circle cx="62" cy="35" r="5" fill="#fff"/><path d="M30 72 L42 60 L52 70 L70 52 L82 72 Z" fill="#f1b98f"/></svg>',
  extensions: '<svg viewBox="0 0 100 100"><rect x="22" y="22" width="56" height="58" rx="9" fill="#fff"/><path d="M34 39h32M34 51h20M34 63h27" stroke="#5c7b8f" stroke-width="5" stroke-linecap="round"/><circle cx="70" cy="28" r="10" fill="#f1b98f"/><path d="M70 23v10M65 28h10" stroke="#fff" stroke-width="3" stroke-linecap="round"/></svg>',
  'anon-chat': '<svg viewBox="0 0 100 100"><path d="M20 70 Q50 20 80 70 Z" fill="none" stroke="#b6cde0" stroke-width="8" stroke-linecap="round"/><path d="M35 70 Q50 40 65 70 Z" fill="#f1b98f"/></svg>',
  'character-phone': '<svg viewBox="0 0 100 100"><rect x="32" y="18" width="36" height="64" rx="8" fill="#fff"/><rect x="32" y="18" width="36" height="12" rx="8" fill="#b6cde0"/><circle cx="50" cy="72" r="4" fill="#f1b98f"/><rect x="38" y="34" width="24" height="30" rx="4" fill="#f8f4ef"/></svg>',
  appearance: '<svg viewBox="0 0 100 100"><path d="M30 72 Q20 54 34 38 Q48 20 68 32 Q84 42 72 58 Q66 66 54 60 Q48 78 30 72" fill="#fff"/><circle cx="42" cy="42" r="4" fill="#f1b98f"/><circle cx="56" cy="38" r="4" fill="#f8d3c5"/><circle cx="66" cy="50" r="4" fill="#5c7b8f"/></svg>',
  beautify: '<svg viewBox="0 0 100 100"><rect x="20" y="24" width="60" height="52" rx="12" fill="#fff"/><path d="M20 40h60M40 24v52" stroke="#5c7b8f" stroke-width="4"/><circle cx="58" cy="55" r="9" fill="none" stroke="#f1b98f" stroke-width="4"/><path d="M65 62l9 9" stroke="#f1b98f" stroke-width="4" stroke-linecap="round"/></svg>',
  'my-space': '<svg viewBox="0 0 100 100"><circle cx="50" cy="36" r="16" fill="#fff"/><path d="M24 78 Q24 58 50 58 Q76 58 76 78 Z" fill="#f1b98f"/><path d="M62 28 L72 22 L70 34 Z" fill="#b6cde0" opacity="0.9"/></svg>',
  contacts: '<svg viewBox="0 0 100 100"><path d="M50 80 C50 80 20 50 20 35 C20 20 40 20 50 35 C60 20 80 20 80 35 C80 50 50 80 50 80" fill="#fff"/><circle cx="40" cy="36" r="3" fill="#5c7b8f"/><circle cx="60" cy="36" r="3" fill="#5c7b8f"/></svg>',
  calendar: '<svg viewBox="0 0 100 100"><rect x="25" y="24" width="50" height="56" rx="8" fill="#fff"/><rect x="25" y="24" width="50" height="16" rx="8" fill="#f1b98f"/><circle cx="50" cy="58" r="9" fill="#b6cde0"/></svg>',
  settings: '<svg viewBox="0 0 100 100"><path d="M50 28 L58 34 L68 32 L72 42 L80 48 L74 58 L76 68 L64 72 L58 80 L48 74 L38 76 L32 66 L22 60 L28 50 L26 40 L38 36 Z" fill="#b6cde0"/><circle cx="50" cy="54" r="9" fill="#fff"/></svg>',
};

export const DEFAULT_AVATAR_SVG = '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="50" fill="#f8d3c5"/><circle cx="35" cy="45" r="4" fill="#5c7b8f"/><circle cx="65" cy="45" r="4" fill="#5c7b8f"/><path d="M 45 55 Q 50 60 55 55" fill="none" stroke="#5c7b8f" stroke-width="3" stroke-linecap="round"/></svg>';

export const DEFAULT_POLAROID_SVG = '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="20" fill="#fff"/><path d="M10 90 L40 50 L60 70 L90 30 L90 90 Z" fill="#d5e4ed"/></svg>';

export const DEFAULT_POLAROID_SVG_P3 = '<svg viewBox="0 0 100 100"><circle cx="30" cy="30" r="15" fill="#fff"/><path d="M0 100 L40 60 L70 80 L100 50 L100 100 Z" fill="#b6cde0"/></svg>';

export function getIconSvg(appId) {
  return ICONS[appId] || getCommercialHomeIcon(appId) || ICONS.settings;
}

export function getIconBg(appId) {
  return APP_BG[appId] || 'bg-cream';
}

export function getAppRoute(appId) {
  return APP_ROUTES[appId] || 'tutorial';
}

export function isComingSoonApp(appId) {
  return COMING_SOON_APP_IDS.includes(String(appId || '').trim());
}

export function isCommercialHomeIcon(appId) {
  return Boolean(getCommercialHomeIcon(appId));
}

const DEFAULT_PAGE_APPS = [PAGE_ONE_APPS, PAGE_TWO_APPS, PAGE_THREE_APPS, PAGE_FOUR_APPS, PAGE_FIVE_APPS];
const KNOWN_APP_IDS = new Set([
  ...PAGE_ONE_APPS,
  ...PAGE_TWO_APPS,
  ...PAGE_THREE_APPS,
  ...PAGE_FOUR_APPS,
  ...PAGE_FIVE_APPS,
  ...DOCK_APPS,
]);

function layoutPageApps(page = [], layout) {
  return (page || []).filter((id) => !BUILTIN_HOME_WIDGET_DEFS[id] && !layout?.customItems?.[id]);
}

function isHomeEmptySlotIdLocal(id) {
  return String(id || '').startsWith('__empty-slot:');
}

/** 从 homeLayout 提取各页 App 列表（过滤内置组件槽）。
 * 默认页无 App 时只补「尚未出现在其它页」的默认项，避免用户挪走后渲染层又画一份。 */
export function getLayoutAppPages(layout) {
  const rawPages = Array.isArray(layout?.pages) ? layout.pages : [];
  const count = Math.max(MIN_HOME_PAGES, Math.min(MAX_HOME_PAGES, rawPages.length || MIN_HOME_PAGES));
  const globalPlaced = new Set();
  (Array.isArray(layout?.dock) ? layout.dock : []).forEach((id) => {
    if (KNOWN_APP_IDS.has(id)) globalPlaced.add(id);
  });
  rawPages.forEach((page) => {
    layoutPageApps(page, layout).forEach((id) => globalPlaced.add(id));
  });
  return Array.from({ length: count }, (_, index) => {
    const apps = layoutPageApps(rawPages[index], layout);
    if (apps.length) return apps;
    if (index >= DEFAULT_PAGE_APPS.length) return [];
    return DEFAULT_PAGE_APPS[index].filter((id) => !globalPlaced.has(id));
  });
}

/**
 * 图标网格单元格流：App / 空槽 / 自定义组件 / 可拖动原生组件按 pages 顺序交错。
 * 主题骨架级原生件（未列入 HOME_GRID_BUILTIN_IDS）仍不进网格。
 */
export function getLayoutPageGridItems(layout, pageIndex = 0) {
  const raw = Array.isArray(layout?.pages?.[pageIndex]) ? layout.pages[pageIndex] : [];
  const customItems = layout?.customItems || {};
  const seen = new Set();
  const items = [];
  raw.forEach((id) => {
    const key = String(id || '').trim();
    if (!key) return;
    if (BUILTIN_HOME_WIDGET_DEFS[key] && !HOME_GRID_BUILTIN_IDS.has(key)) return;
    if (isHomeEmptySlotIdLocal(key)) {
      items.push(key);
      return;
    }
    if (seen.has(key)) return;
    items.push(key);
    seen.add(key);
  });
  const hasApp = items.some((id) => !isHomeEmptySlotIdLocal(id) && !customItems[id] && !HOME_GRID_BUILTIN_IDS.has(id));
  if (!hasApp) {
    const fallbackApps = getLayoutAppPages(layout)[pageIndex] || [];
    fallbackApps.forEach((id) => {
      if (seen.has(id)) return;
      items.push(id);
      seen.add(id);
    });
  }
  return items;
}
