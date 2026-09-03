/**
 * 主屏自定义 App 图标：自定义图片确认加载成功前始终显示内置 SVG，避免冷启动空白。
 */
export function getHomeCustomIconSource(theme, appId) {
  const value = theme?.appIcons?.[appId];
  return typeof value === 'string' ? value.trim() : '';
}

export function renderHomeIconLayers(customSource, fallbackSvg, options = {}) {
  if (!customSource) return fallbackSvg;
  const escape = typeof options.escape === 'function' ? options.escape : String;
  const className = String(options.className || 'custom-img').trim();
  const rawFallback = String(fallbackSvg || '');
  const visibleFallback = /<svg\b/i.test(rawFallback)
    ? rawFallback.replace(/<svg\b/i, '<svg data-home-icon-fallback')
    : `<span data-home-icon-fallback>${rawFallback}</span>`;
  return `${visibleFallback}<img class="${className}" data-home-custom-icon draggable="false" hidden style="display:none!important" src="${escape(customSource)}" alt="">`;
}

export function installHomeNativeDragGuard(container) {
  if (!container?.addEventListener) return () => {};
  container.querySelectorAll?.('img').forEach((image) => image.setAttribute?.('draggable', 'false'));
  const preventNativeDrag = (event) => {
    const target = event?.target;
    if (!target?.closest?.('img, [data-app-id], [data-home-longpress-item]')) return;
    event.preventDefault?.();
  };
  container.addEventListener('dragstart', preventNativeDrag, true);
  return () => container.removeEventListener?.('dragstart', preventNativeDrag, true);
}

export function hasVisibleHomeIconPixels(pixelData, options = {}) {
  const rgba = pixelData && typeof pixelData.length === 'number' ? pixelData : [];
  const pixels = Math.floor(rgba.length / 4);
  if (!pixels) return false;
  const minAlpha = Math.max(0, Math.min(255, Number(options.minAlpha ?? 16)));
  const minVisible = Math.max(4, Math.ceil(pixels * 0.001));
  let visible = 0;
  for (let index = 3; index < rgba.length; index += 4) {
    if (Number(rgba[index] || 0) <= minAlpha) continue;
    visible += 1;
    if (visible >= minVisible) return true;
  }
  return false;
}

function customIconHasVisiblePixels(image) {
  const width = Number(image?.naturalWidth || 0);
  const height = Number(image?.naturalHeight || 0);
  if (!(width > 0) || !(height > 0)) return false;
  const doc = image?.ownerDocument;
  if (!doc?.createElement) return true;
  try {
    const canvas = doc.createElement('canvas');
    const sampleWidth = Math.max(1, Math.min(32, Math.round(width)));
    const sampleHeight = Math.max(1, Math.min(32, Math.round(height)));
    canvas.width = sampleWidth;
    canvas.height = sampleHeight;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return true;
    context.clearRect(0, 0, sampleWidth, sampleHeight);
    context.drawImage(image, 0, 0, sampleWidth, sampleHeight);
    return hasVisibleHomeIconPixels(context.getImageData(0, 0, sampleWidth, sampleHeight).data);
  } catch (_) {
    // 跨域图片可能禁止读取像素；既然浏览器已经成功解码，就按正常图片显示。
    return true;
  }
}

export function hydrateHomeCustomIconFallbacks(container) {
  container?.querySelectorAll?.('[data-home-custom-icon]').forEach((image) => {
    const fallback = image.parentElement?.querySelector?.('[data-home-icon-fallback]');
    const revealFallback = () => {
      fallback?.removeAttribute?.('hidden');
      fallback?.style?.removeProperty?.('display');
      image.parentElement?.classList?.remove?.('has-ready-custom-icon');
    };
    const hideFallback = () => {
      fallback?.setAttribute?.('hidden', '');
      fallback?.style?.setProperty?.('display', 'none', 'important');
    };
    const removeBrokenImage = () => {
      revealFallback();
      image.remove();
    };
    const revealCustomImage = () => {
      if (!customIconHasVisiblePixels(image)) {
        removeBrokenImage();
        return;
      }
      hideFallback();
      image.removeAttribute?.('hidden');
      image.style?.removeProperty?.('display');
      image.parentElement?.classList?.add?.('has-ready-custom-icon');
    };

    // 必须先监听再检查 complete：缓存命中、Safari 恢复页和慢速解码都可能改变触发顺序。
    image.addEventListener('load', revealCustomImage, { once: true });
    image.addEventListener('error', removeBrokenImage, { once: true });
    if (image.complete) {
      if (Number(image.naturalWidth) > 0) revealCustomImage();
      else removeBrokenImage();
    } else {
      revealFallback();
    }
  });
}
