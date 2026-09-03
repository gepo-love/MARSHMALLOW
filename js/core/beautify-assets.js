import * as db from './db.js';
import { detachChatWallpaperAsset } from './chat-wallpaper-assets.js';
import {
  applyAppearanceTheme,
  getActiveTheme,
  getHomeWidgetLibraryItems,
  loadAppearancePrefs,
  normalizeHomeLayout,
  saveAppearancePrefs,
  upsertHomeWidgetLibraryItem,
} from './appearance-prefs.js';

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const ASSET_SCHEME = 'mm-img://';
const REMOTE_IMAGE_FETCH_TIMEOUT_MS = 8000;
const REMOTE_CSS_IMAGE_LIMIT = 12;

function makeId(prefix = 'asset') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function cleanName(value, fallback = '未命名素材') {
  return String(value || fallback).trim().slice(0, 50) || fallback;
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('素材读取失败'));
    reader.readAsDataURL(file);
  });
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let start = 0; start < bytes.length; start += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(start, start + chunkSize));
  }
  return btoa(binary);
}

/**
 * 尽量把外链图片固化进主题。图床未开放 CORS 时会失败，调用方保留原 URL 即可；
 * 成功时发布后的样式和导出的主题包不再依赖链接寿命、Referer 或接收方网络。
 */
export async function fetchBeautifyRemoteImageDataUrl(url, options = {}) {
  const source = String(url || '').trim();
  if (!/^https:\/\//i.test(source)) return '';
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || REMOTE_IMAGE_FETCH_TIMEOUT_MS);
  const maxBytes = Math.max(1, Number(options.maxBytes) || MAX_IMAGE_BYTES);
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await fetch(source, {
      signal: controller?.signal,
      cache: 'force-cache',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
    if (!response.ok) return '';
    const declaredSize = Number(response.headers.get('content-length') || 0);
    if (declaredSize > maxBytes) return '';
    const blob = await response.blob();
    if (!String(blob.type || '').toLowerCase().startsWith('image/') || blob.size > maxBytes) return '';
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return `data:${blob.type};base64,${bytesToBase64(bytes)}`;
  } catch (_) {
    return '';
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function localizeBeautifyRemoteCssImages(cssText, options = {}) {
  const css = String(cssText || '');
  const urls = [...new Set([...css.matchAll(/url\(\s*(['"]?)(https:\/\/[^'"\s)]+)\1\s*\)/gi)]
    .map((match) => match[2])
    .filter(Boolean))]
    .slice(0, Math.max(1, Number(options.limit) || REMOTE_CSS_IMAGE_LIMIT));
  if (!urls.length) return css;
  let next = css;
  // 一张图下载、转 ArrayBuffer、转 Base64 时会同时占用数份内存。
  // 主题导出最多处理 12 张外链图，改为逐张处理避免低内存 WebView 被系统杀掉。
  for (const url of urls) {
    const dataUrl = await fetchBeautifyRemoteImageDataUrl(url, options);
    if (dataUrl) next = next.split(url).join(dataUrl);
  }
  return next;
}

const COMPRESS_THRESHOLD_BYTES = 300 * 1024;
const COMPRESS_MAX_SIDE = 1600;

/** 大图入库前收敛尺寸和体积（webp 优先保透明底；GIF 保动图不处理），避免美化配置被巨图拖慢。 */
async function compressImageDataUrl(dataUrl, mime) {
  if (mime === 'image/gif' || typeof document === 'undefined') return { dataUrl, mime };
  try {
    const img = await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('图片解码失败'));
      image.src = dataUrl;
    });
    const scale = Math.min(1, COMPRESS_MAX_SIDE / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round((img.naturalWidth || 1) * scale));
    canvas.height = Math.max(1, Math.round((img.naturalHeight || 1) * scale));
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    const webp = canvas.toDataURL('image/webp', 0.85);
    const candidate = webp.startsWith('data:image/webp')
      ? webp
      : canvas.toDataURL(mime === 'image/jpeg' ? 'image/jpeg' : 'image/png', 0.85);
    if (candidate.length < dataUrl.length) {
      return { dataUrl: candidate, mime: candidate.slice(5, candidate.indexOf(';')) };
    }
  } catch (_) {}
  return { dataUrl, mime };
}

export async function saveBeautifyImage(file, name = '') {
  if (!file || !String(file.type || '').startsWith('image/')) throw new Error('请选择图片文件');
  if (file.size > MAX_IMAGE_BYTES) throw new Error('图片不能超过 4MB');
  const raw = await fileToDataUrl(file);
  const optimized = file.size > COMPRESS_THRESHOLD_BYTES
    ? await compressImageDataUrl(raw, String(file.type || 'image/png'))
    : { dataUrl: raw, mime: String(file.type || 'image/png') };
  return saveBeautifyImageDataUrl(optimized.dataUrl, name || file.name, optimized.mime);
}

/** 保存已经压缩好的图片；聊天壁纸批量导入会先缩图，再从这里进入共用素材库。 */
export async function saveBeautifyImageDataUrl(dataUrl, name = '', mime = '') {
  const source = String(dataUrl || '').trim();
  const match = source.match(/^data:(image\/[a-z0-9.+-]+);base64,/i);
  if (!match) throw new Error('图片格式无效');
  const storedBytes = Math.round(Math.max(0, source.length - match[0].length) * 0.75);
  if (storedBytes > MAX_IMAGE_BYTES) throw new Error('图片压缩后仍超过 4MB');
  const existing = (await db.getAllRecords('beautifyAssets'))
    .find((item) => item?.type === 'image' && item.dataUrl === source);
  if (existing) return existing;
  const record = {
    id: makeId('image'),
    type: 'image',
    name: cleanName(name, '图片素材'),
    mime: String(mime || match[1]).trim() || match[1],
    size: storedBytes,
    dataUrl: source,
    updatedAt: Date.now(),
  };
  await db.putRecord('beautifyAssets', record);
  return record;
}

/** 外部图床只保存 HTTPS 直链，不代理上传用户图片。 */
export async function saveBeautifyImageUrl(url, name = '外链图片') {
  let parsed;
  try {
    parsed = new URL(String(url || '').trim());
  } catch (_) {
    throw new Error('图片链接格式不正确');
  }
  if (parsed.protocol !== 'https:') throw new Error('请使用 HTTPS 图片直链');
  const remoteSource = parsed.href;
  const localized = await fetchBeautifyRemoteImageDataUrl(remoteSource);
  if (localized) {
    const record = await saveBeautifyImageDataUrl(localized, name, localized.slice(5, localized.indexOf(';')));
    return { ...record, remoteSource };
  }
  const source = remoteSource;
  const existing = (await db.getAllRecords('beautifyAssets'))
    .find((item) => item?.type === 'image' && item.dataUrl === source);
  if (existing) return existing;
  const record = {
    id: makeId('image'),
    type: 'image',
    name: cleanName(name, '外链图片'),
    mime: '',
    size: 0,
    dataUrl: source,
    remote: true,
    updatedAt: Date.now(),
  };
  await db.putRecord('beautifyAssets', record);
  return record;
}

export async function saveBeautifyComponent(input = {}) {
  const record = {
    id: String(input.id || makeId('component')),
    type: 'component',
    name: cleanName(input.name, '自定义组件'),
    target: String(input.target || 'home'),
    selector: String(input.selector || '').trim().slice(0, 500),
    css: String(input.css || '').replace(/<\/?\s*style[^>]*>/gi, ''),
    html: String(input.html || '').replace(/<script[\s\S]*?<\/script>/gi, ''),
    assetIds: Array.isArray(input.assetIds) ? input.assetIds.map(String).slice(0, 30) : [],
    updatedAt: Date.now(),
  };
  if (!record.css.trim()) throw new Error('组件 CSS 不能为空');
  await db.putRecord('beautifyAssets', record);
  return record;
}

export async function listBeautifyAssets(type = '') {
  const rows = await db.getAllRecords('beautifyAssets');
  return rows
    .filter((item) => !type || item.type === type)
    .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
}

export async function deleteBeautifyAsset(id) {
  const asset = await db.getRecord('beautifyAssets', id).catch(() => null);
  if (asset?.type === 'image') await detachChatWallpaperAsset(asset);
  await db.deleteRecord('beautifyAssets', id);
}

function cssUrl(value = '') {
  const escaped = String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\r\n\f]/g, '');
  return `url("${escaped}")`;
}

function cssUrlTokenRanges(cssText = '') {
  const source = String(cssText || '');
  const ranges = [];
  const opener = /url\s*\(/gi;
  let match;
  while ((match = opener.exec(source))) {
    let quote = '';
    let end = -1;
    for (let index = opener.lastIndex; index < source.length; index += 1) {
      const char = source[index];
      if (quote) {
        if (char === '\\') index += 1;
        else if (char === quote) quote = '';
        continue;
      }
      if (char === '"' || char === "'") quote = char;
      else if (char === ')') {
        end = index + 1;
        break;
      }
    }
    if (end < 0) continue;
    ranges.push({ start: match.index, end });
    opener.lastIndex = end;
  }
  return ranges;
}

/**
 * 在 CSS 编辑器中插入图片时，如果光标或选区位于已有 url(...) 内，替换完整
 * url()，避免把原链接替成 url("url(...)") 后导致整条背景声明失效。
 */
export function replaceBeautifyCssImageSelection(cssText, start, end, imageUrl) {
  const source = String(cssText || '');
  const from = Math.max(0, Math.min(source.length, Number(start) || 0));
  const to = Math.max(from, Math.min(source.length, Number(end) || from));
  const token = cssUrl(imageUrl);
  const containing = cssUrlTokenRanges(source).find((range) => (
    from === to
      ? from >= range.start && from <= range.end
      : from < range.end && to > range.start
  ));
  const replaceFrom = containing?.start ?? from;
  const replaceTo = containing?.end ?? to;
  return {
    cssText: `${source.slice(0, replaceFrom)}${token}${source.slice(replaceTo)}`,
    selectionStart: replaceFrom,
    selectionEnd: replaceFrom + token.length,
    replacedExistingUrl: !!containing,
  };
}

/**
 * 把素材库协议替换成真正可绘制的 CSS url()。
 * 兼容两种粘贴方式：
 *   background-image: url("mm-img://ID");
 *   background-image: mm-img://ID;
 */
export function substituteBeautifyAssetUrls(cssText, recordsById = new Map()) {
  const map = recordsById instanceof Map
    ? recordsById
    : new Map(Object.entries(recordsById || {}));
  let css = String(cssText || '');
  css = css.replace(
    /url\(\s*(['"]?)mm-img:\/\/([a-zA-Z0-9_-]+)\1\s*\)/gi,
    (full, _quote, id) => {
      const value = map.get(id);
      return value ? cssUrl(value) : full;
    },
  );
  return css.replace(/mm-img:\/\/([a-zA-Z0-9_-]+)/g, (full, id) => {
    const value = map.get(id);
    return value ? cssUrl(value) : full;
  });
}

export async function resolveBeautifyCssAssets(cssText) {
  const css = String(cssText || '');
  const ids = [...css.matchAll(/mm-img:\/\/([a-zA-Z0-9_-]+)/g)].map((match) => match[1]);
  if (!ids.length) return css;
  const records = await db.getMany('beautifyAssets', [...new Set(ids)]);
  const map = new Map(records.filter(Boolean).map((record) => [record.id, record.dataUrl]));
  return substituteBeautifyAssetUrls(css, map);
}

export async function exportBeautifyComponent(id) {
  const component = await db.getRecord('beautifyAssets', id);
  if (!component || component.type !== 'component') throw new Error('组件不存在');
  const assets = (await db.getMany('beautifyAssets', component.assetIds || [])).filter(Boolean);
  return JSON.stringify({
    type: 'marshmallow-beautify-component',
    version: 1,
    component,
    assets,
  }, null, 2);
}

export async function importBeautifyComponent(text) {
  const payload = JSON.parse(String(text || ''));
  if (payload?.type !== 'marshmallow-beautify-component' || Number(payload.version) !== 1) {
    throw new Error('不是有效的棉花糖美化组件');
  }
  const idMap = new Map();
  for (const source of Array.isArray(payload.assets) ? payload.assets : []) {
    if (source?.type !== 'image' || !String(source.dataUrl || '').startsWith('data:image/')) continue;
    const id = makeId('image');
    idMap.set(String(source.id), id);
    await db.putRecord('beautifyAssets', {
      ...source,
      id,
      name: cleanName(source.name, '导入图片'),
      updatedAt: Date.now(),
    });
  }
  const component = payload.component || {};
  return saveBeautifyComponent({
    ...component,
    id: makeId('component'),
    name: cleanName(component.name, '导入组件'),
    assetIds: (component.assetIds || []).map((id) => idMap.get(String(id))).filter(Boolean),
    css: String(component.css || '').replace(/mm-img:\/\/([a-zA-Z0-9_-]+)/g, (full, id) => {
      const mapped = idMap.get(id);
      return mapped ? `${ASSET_SCHEME}${mapped}` : full;
    }),
  });
}

export async function installBeautifyComponentOnHome(componentId) {
  const component = await db.getRecord('beautifyAssets', componentId);
  if (!component || component.type !== 'component') throw new Error('组件不存在');
  const prefs = await loadAppearancePrefs();
  const active = getActiveTheme(prefs);
  const theme = { ...active.theme };
  const layout = normalizeHomeLayout(theme.homeLayout, theme.widgetVisibility);
  const instanceId = `beautify-widget-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const widget = {
    id: instanceId,
    kind: 'custom-widget',
    label: component.name,
    title: component.name,
    body: '',
    html: component.html || `<div class="beautify-custom-widget" data-beautify-component="${component.id}">${component.name}</div>`,
    size: { cols: 2, rows: 1 },
  };
  const pageIndex = Math.max(0, layout.pages.length - 1);
  layout.pages[pageIndex] = [instanceId, ...(layout.pages[pageIndex] || [])];
  theme.homeLayout = layout;
  const marker = `/* beautify-component:${component.id} */`;
  const currentCss = String(theme.customTheme?.css || '');
  if (!currentCss.includes(marker)) {
    theme.customTheme = {
      ...(theme.customTheme || {}),
      css: `${currentCss}\n${marker}\n${component.css}`.trim(),
    };
  }
  prefs.themes[active.id] = theme;
  const saved = await saveAppearancePrefs(upsertHomeWidgetLibraryItem(prefs, widget));
  applyAppearanceTheme(getActiveTheme(saved).theme);
  return instanceId;
}

/** 把 HTML 组件装到指定主屏页；未指定时仍放最后一页。 */
export async function installWidgetTemplateOnHome(template) {
  if (!template || !template.html) throw new Error('模板不存在');
  const prefs = await loadAppearancePrefs();
  const active = getActiveTheme(prefs);
  const theme = { ...active.theme };
  const layout = normalizeHomeLayout(theme.homeLayout, theme.widgetVisibility);
  const instanceId = `beautify-widget-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const widget = {
    id: instanceId,
    kind: 'custom-widget',
    label: template.name,
    title: template.name,
    body: '',
    html: template.html,
    quickColors: template.quickColors || undefined,
    size: template.size || { cols: 2, rows: 1 },
  };
  const requestedPage = Number(template.pageIndex);
  const pageIndex = Number.isFinite(requestedPage)
    ? Math.max(0, Math.min(layout.pages.length - 1, Math.round(requestedPage)))
    : Math.max(0, layout.pages.length - 1);
  layout.pages[pageIndex] = [instanceId, ...(layout.pages[pageIndex] || [])];
  theme.homeLayout = layout;
  prefs.themes[active.id] = theme;
  const saved = await saveAppearancePrefs(upsertHomeWidgetLibraryItem(prefs, widget));
  applyAppearanceTheme(getActiveTheme(saved).theme);
  return instanceId;
}

/** 一次安装一个或多个社区主屏组件，只写入一次外观配置。 */
export async function installWidgetTemplatesOnHome(templates = []) {
  const items = (Array.isArray(templates) ? templates : []).filter((item) => (
    item && (String(item.html || '').trim() || String(item.body || '').trim())
  )).slice(0, 24);
  if (!items.length) throw new Error('组件合集中没有可安装的组件');
  const prefs = await loadAppearancePrefs();
  const active = getActiveTheme(prefs);
  const theme = { ...active.theme };
  const layout = normalizeHomeLayout(theme.homeLayout, theme.widgetVisibility);
  const pageIndex = Math.max(0, layout.pages.length - 1);
  const widgets = [];
  const instanceIds = items.map((template, index) => {
    const instanceId = `beautify-widget-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`;
    const name = String(template.name || '自定义组件').trim() || '自定义组件';
    widgets.push({
      id: instanceId,
      kind: 'custom-widget',
      label: name,
      title: name,
      body: String(template.body || ''),
      html: String(template.html || ''),
      quickColors: template.quickColors || undefined,
      imageSlots: template.imageSlots && typeof template.imageSlots === 'object'
        ? { ...template.imageSlots }
        : undefined,
      size: template.size || { cols: 2, rows: 1 },
    });
    return instanceId;
  });
  layout.pages[pageIndex] = [...instanceIds, ...(layout.pages[pageIndex] || [])];
  theme.homeLayout = layout;
  prefs.themes[active.id] = theme;
  const nextPrefs = widgets.reduce((next, widget) => upsertHomeWidgetLibraryItem(next, widget), prefs);
  const saved = await saveAppearancePrefs(nextPrefs);
  applyAppearanceTheme(getActiveTheme(saved).theme);
  return instanceIds;
}

/** 更新已有 HTML 组件，并可同时调整尺寸和所在页。 */
export async function updateWidgetTemplateOnHome(widgetId, patch = {}) {
  const id = String(widgetId || '').trim();
  if (!id) throw new Error('组件不存在');
  const prefs = await loadAppearancePrefs();
  const active = getActiveTheme(prefs);
  const theme = { ...active.theme };
  const layout = normalizeHomeLayout(theme.homeLayout, theme.widgetVisibility);
  const current = getHomeWidgetLibraryItems(prefs)[id] || layout.customItems[id];
  if (!current) throw new Error('组件不存在');
  const widget = {
    ...current,
    label: String(patch.name || current.label || '自定义组件').trim() || '自定义组件',
    title: String(patch.name || current.title || current.label || '自定义组件').trim() || '自定义组件',
    html: patch.html != null ? String(patch.html) : current.html,
    quickColors: patch.quickColors || current.quickColors,
    size: patch.size || current.size || { cols: 2, rows: 1 },
  };
  const currentPage = layout.pages.findIndex((page) => page.includes(id));
  const requestedPage = Number(patch.pageIndex);
  const nextPage = Number.isFinite(requestedPage)
    ? Math.max(0, Math.min(layout.pages.length - 1, Math.round(requestedPage)))
    : Math.max(0, currentPage);
  layout.pages = layout.pages.map((page) => page.filter((itemId) => itemId !== id));
  layout.pages[nextPage].unshift(id);
  theme.homeLayout = layout;
  prefs.themes[active.id] = theme;
  const saved = await saveAppearancePrefs(upsertHomeWidgetLibraryItem(prefs, widget));
  applyAppearanceTheme(getActiveTheme(saved).theme);
  return id;
}

/** 把已保存的自定义组件移出或重新放回主屏；组件代码与图片槽始终保留。 */
export async function setWidgetTemplateHomeVisible(widgetId, visible, pageIndex) {
  const id = String(widgetId || '').trim();
  if (!id) throw new Error('组件不存在');
  const prefs = await loadAppearancePrefs();
  const active = getActiveTheme(prefs);
  const theme = { ...active.theme };
  const layout = normalizeHomeLayout(theme.homeLayout, theme.widgetVisibility);
  const current = getHomeWidgetLibraryItems(prefs)[id] || layout.customItems[id];
  if (!current) throw new Error('组件不存在');
  layout.pages = layout.pages.map((page) => page.filter((itemId) => itemId !== id));
  if (visible) {
    const requestedPage = Number(pageIndex);
    const targetPage = Number.isFinite(requestedPage)
      ? Math.max(0, Math.min(layout.pages.length - 1, Math.round(requestedPage)))
      : Math.max(0, layout.pages.length - 1);
    layout.pages[targetPage].unshift(id);
  }
  layout.customItems[id] = { ...current, storedInLibrary: true, hiddenFromHome: !visible };
  theme.homeLayout = normalizeHomeLayout(layout, theme.widgetVisibility);
  prefs.themes[active.id] = theme;
  const saved = await saveAppearancePrefs(prefs);
  applyAppearanceTheme(getActiveTheme(saved).theme);
  return id;
}

export function beautifyAssetUrl(id) {
  return `${ASSET_SCHEME}${String(id || '')}`;
}
