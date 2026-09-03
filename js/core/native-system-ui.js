import {
  getActiveTheme,
  getWallpaperOverlayAlpha,
  isSeaHomeTheme,
  isWindowHomeTheme,
  loadAppearancePrefs,
  resolveHomePageWallpaperUrl,
} from './appearance-prefs.js';

const PAPER = { r: 251, g: 246, b: 240 };
const NIGHT = { r: 16, g: 18, b: 20 };
let initialized = false;
let syncSeq = 0;
let lastSignature = '';

function baseSurface() {
  return document.documentElement.dataset.colorMode === 'dark' ? NIGHT : PAPER;
}

function plugin() {
  return window.Capacitor?.Plugins?.MarshmallowSystemUi || null;
}

function clampByte(value) {
  return Math.max(0, Math.min(255, Math.round(Number(value) || 0)));
}

function toHex(color) {
  return `#${[color.r, color.g, color.b]
    .map((value) => clampByte(value).toString(16).padStart(2, '0'))
    .join('')}`.toUpperCase();
}

function mix(a, b, bWeight = 0.5) {
  const weight = Math.max(0, Math.min(1, Number(bWeight) || 0));
  return {
    r: a.r * (1 - weight) + b.r * weight,
    g: a.g * (1 - weight) + b.g * weight,
    b: a.b * (1 - weight) + b.b * weight,
  };
}

function parseCssColor(raw = '') {
  const match = String(raw || '').match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)/i);
  if (!match) return null;
  const alpha = match[4] == null ? 1 : Number(match[4]);
  if (!Number.isFinite(alpha) || alpha <= 0.04) return null;
  const color = { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]) };
  return alpha >= 0.99 ? color : mix(baseSurface(), color, alpha);
}

function isDark(color) {
  const luminance = (0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b) / 255;
  return luminance < 0.48;
}

function sampleWallpaperTop(url, { leftThird = false, overlayAlpha = 0 } = {}) {
  return new Promise((resolve) => {
    const src = String(url || '').trim();
    if (!src || src === '__none__') {
      resolve(null);
      return;
    }
    const image = new Image();
    if (/^https?:/i.test(src) && !src.startsWith(location.origin)) image.crossOrigin = 'anonymous';
    const timer = setTimeout(() => resolve(null), 2200);
    image.onload = () => {
      clearTimeout(timer);
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 32;
        canvas.height = 10;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        const sourceWidth = leftThird ? Math.max(1, image.naturalWidth / 3) : image.naturalWidth;
        ctx.drawImage(image, 0, 0, sourceWidth, Math.max(1, image.naturalHeight * 0.18), 0, 0, 32, 10);
        const pixels = ctx.getImageData(0, 0, 32, 10).data;
        let r = 0;
        let g = 0;
        let b = 0;
        let count = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          if (pixels[i + 3] < 64) continue;
          r += pixels[i];
          g += pixels[i + 1];
          b += pixels[i + 2];
          count += 1;
        }
        if (!count) {
          resolve(null);
          return;
        }
        let sampled = { r: r / count, g: g / count, b: b / count };
        sampled = mix(sampled, baseSurface(), Math.max(0.18, Math.min(0.72, Number(overlayAlpha) || 0)));
        resolve(sampled);
      } catch (_) {
        resolve(null);
      }
    };
    image.onerror = () => {
      clearTimeout(timer);
      resolve(null);
    };
    image.src = src;
  });
}

async function resolveStatusColor(path, container) {
  if (path === 'home') {
    const prefs = await loadAppearancePrefs().catch(() => null);
    const active = prefs ? getActiveTheme(prefs) : null;
    if (active?.theme) {
      const windowTheme = isWindowHomeTheme(active.id, active.theme);
      const seaTheme = isSeaHomeTheme(active.id, active.theme);
      const sampled = await sampleWallpaperTop(resolveHomePageWallpaperUrl(active.theme, 1), {
        leftThird: windowTheme,
        overlayAlpha: getWallpaperOverlayAlpha(active.theme),
      });
      if (sampled) return sampled;
      if (seaTheme) return { r: 232, g: 242, b: 246 };
      if (windowTheme) return { r: 242, g: 239, b: 232 };
    }
  }

  const topSurface = container?.querySelector?.('.navbar, .scrapbook-navbar, header');
  const surfaceColor = topSurface ? parseCssColor(getComputedStyle(topSurface).backgroundColor) : null;
  if (surfaceColor) return surfaceColor;
  const pageColor = container ? parseCssColor(getComputedStyle(container).backgroundColor) : null;
  return pageColor || baseSurface();
}

async function syncBars(detail = {}) {
  const seq = ++syncSeq;
  const path = String(detail.path || '').trim();
  const container = detail.container || document.querySelector('#page-container > .page:not([hidden])');
  const statusColor = await resolveStatusColor(path, container);
  if (seq !== syncSeq) return;
  const statusHex = toHex(statusColor);
  const night = document.documentElement.dataset.colorMode === 'dark';
  const navigationHex = night ? '#101214' : '#FBF6F0';
  const darkStatusIcons = !isDark(statusColor);
  const signature = `${statusHex}|${navigationHex}|${darkStatusIcons}`;
  if (signature === lastSignature) return;
  lastSignature = signature;

  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', statusHex);
  const native = plugin();
  if (!native?.setBars) return;
  native.setBars({
    statusBarColor: statusHex,
    navigationBarColor: navigationHex,
    darkStatusIcons,
    darkNavigationIcons: !night,
  }).catch(() => {});
}

export function initNativeSystemUi() {
  if (initialized || typeof window === 'undefined') return;
  initialized = true;
  window.addEventListener('marshmallow-route-activated', (event) => {
    requestAnimationFrame(() => syncBars(event.detail || {}).catch(() => {}));
  });
  window.addEventListener('marshmallow-appearance-changed', () => {
    const page = document.querySelector('#page-container > .page:not([hidden])');
    syncBars({ path: page?.classList.contains('home-shell-page') ? 'home' : '', container: page }).catch(() => {});
  });
  window.addEventListener('marshmallow-color-mode-changed', () => {
    const page = document.querySelector('#page-container > .page:not([hidden])');
    syncBars({ path: page?.classList.contains('home-shell-page') ? 'home' : '', container: page }).catch(() => {});
  });
  requestAnimationFrame(() => syncBars().catch(() => {}));
}
