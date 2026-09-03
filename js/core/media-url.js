/**
 * APK / Capacitor 页面源是 https://localhost，http 媒体会被 WebView 当 mixed-content 拦掉。
 * 仅在「当前页本身是 https」时把远程 http 升为 https；本地 http 预览保持原 http，
 * 避免图床只有 http 可用、强行升 https 后裂图。
 * data:/blob: 原样保留。
 */

function pageIsHttps() {
  try {
    return typeof location !== 'undefined' && location.protocol === 'https:';
  } catch {
    return false;
  }
}

export function upgradeMixedContentMediaUrl(value = '') {
  let url = String(value || '').trim();
  if (!url) return '';
  if (/^(data:|blob:)/i.test(url)) return url;
  if (url.startsWith('//')) {
    return `${pageIsHttps() ? 'https:' : 'http:'}${url}`;
  }
  if (/^http:\/\//i.test(url)) {
    if (pageIsHttps()) return `https://${url.slice(7)}`;
    return url;
  }
  return url;
}

/** 仅接受可展示的图片地址，并按页面协议做 mixed-content 升级；非法则返回空串。 */
export function normalizeDisplayImageUrl(value = '', options = {}) {
  const maxLen = Math.max(0, Number(options.maxLen) || 0);
  let url = upgradeMixedContentMediaUrl(value);
  if (!url) return '';
  if (/^data:image\//i.test(url) || /^blob:/i.test(url)) {
    return maxLen > 0 ? url.slice(0, maxLen) : url;
  }
  if (/^https:\/\//i.test(url)) {
    return maxLen > 0 ? url.slice(0, maxLen) : url;
  }
  // 本地 http 预览允许保留 http 图床；https 壳（APK）里 http 已被升级或应拒绝
  if (/^http:\/\//i.test(url) && !pageIsHttps()) {
    return maxLen > 0 ? url.slice(0, maxLen) : url;
  }
  return '';
}
