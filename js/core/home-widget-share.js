export const HOME_WIDGET_SHARE_TYPE = 'marshmallow-beautify-component';
export const HOME_WIDGET_BUNDLE_VERSION = 2;
const MAX_SHARED_WIDGETS = 24;

function cleanText(value, fallback = '', max = 80) {
  return String(value ?? '').trim().slice(0, max) || fallback;
}

function clampGrid(value, fallback, max) {
  return Math.max(1, Math.min(max, Math.round(Number(value) || fallback)));
}

export function normalizeSharedHomeWidget(item = {}) {
  const name = cleanText(item.name || item.label || item.title, '自定义组件');
  const html = String(item.html || '');
  const body = String(item.body || '').slice(0, 20_000);
  if (!html.trim() && !body.trim()) throw new Error(`组件“${name}”没有可分享的内容`);
  const imageSlots = item.imageSlots && typeof item.imageSlots === 'object'
    ? Object.fromEntries(Object.entries(item.imageSlots)
      .slice(0, 20)
      .map(([key, value]) => [cleanText(key, '', 60), String(value || '')])
      .filter(([key, value]) => key && (/^data:image\//i.test(value) || /^https:\/\//i.test(value))))
    : {};
  const quickColors = item.quickColors && typeof item.quickColors === 'object'
    ? {
      enabled: item.quickColors.enabled === true,
      background: cleanText(item.quickColors.background, '', 40),
      text: cleanText(item.quickColors.text, '', 40),
      accent: cleanText(item.quickColors.accent, '', 40),
      surface: cleanText(item.quickColors.surface, 'solid', 20),
      opacity: Math.max(0, Math.min(100, Math.round(Number(item.quickColors.opacity ?? 100) || 0))),
    }
    : undefined;
  return {
    name,
    html,
    body,
    size: {
      cols: clampGrid(item.size?.cols, 2, 4),
      rows: clampGrid(item.size?.rows, 1, 5),
    },
    ...(quickColors ? { quickColors } : {}),
    ...(Object.keys(imageSlots).length ? { imageSlots } : {}),
  };
}

export function buildHomeWidgetSharePayload(customItems = {}, selectedIds = []) {
  const source = customItems && typeof customItems === 'object' ? customItems : {};
  const ids = [...new Set((Array.isArray(selectedIds) ? selectedIds : [])
    .map((id) => String(id || '').trim())
    .filter(Boolean))].slice(0, MAX_SHARED_WIDGETS);
  const items = ids.map((id) => source[id]).filter(Boolean).map(normalizeSharedHomeWidget);
  if (!items.length) throw new Error('请先选择要分享的组件');
  return {
    type: HOME_WIDGET_SHARE_TYPE,
    version: HOME_WIDGET_BUNDLE_VERSION,
    name: items.length === 1 ? items[0].name : `${items.length} 个主屏组件`,
    items,
  };
}

export function parseHomeWidgetSharePayload(payload = {}) {
  if (payload?.type !== HOME_WIDGET_SHARE_TYPE || Number(payload.version) !== HOME_WIDGET_BUNDLE_VERSION) {
    throw new Error('不是有效的主屏组件合集');
  }
  const sourceItems = Array.isArray(payload.items) ? payload.items.slice(0, MAX_SHARED_WIDGETS) : [];
  if (!sourceItems.length) throw new Error('组件合集中没有可安装的组件');
  return sourceItems.map(normalizeSharedHomeWidget);
}
