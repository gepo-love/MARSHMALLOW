const LOCAL_CHAT_IMAGE_INLINE_MAX_BYTES = 420 * 1024;
const LOCAL_CHAT_IMAGE_TARGET_MAX_BYTES = 900 * 1024;
const LOCAL_CHAT_IMAGE_MAX_EDGE = 1280;
const LOCAL_CHAT_IMAGE_MIN_EDGE = 640;
const LOCAL_CHAT_IMAGE_QUALITY_STEPS = [0.82, 0.74, 0.66, 0.58];

const IMAGE_EXTENSION_MIME = Object.freeze({
  avif: 'image/avif',
  bmp: 'image/bmp',
  gif: 'image/gif',
  heic: 'image/heic',
  heif: 'image/heif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  svg: 'image/svg+xml',
  webp: 'image/webp',
});

function imageMimeFromName(name = '') {
  const extension = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || '';
  return IMAGE_EXTENSION_MIME[extension] || '';
}

function imageMimeFromHeader(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 4) return '';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  const ascii = String.fromCharCode(...bytes.slice(0, 24));
  if (ascii.startsWith('GIF87a') || ascii.startsWith('GIF89a')) return 'image/gif';
  if (ascii.startsWith('BM')) return 'image/bmp';
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') return 'image/webp';
  if (ascii.slice(4, 8) === 'ftyp') {
    const brand = ascii.slice(8, 12).toLowerCase();
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
    if (/^(?:heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(brand)) return 'image/heic';
  }
  return '';
}

/** Android 文件选择器可能把图片交成空 MIME 或 application/octet-stream。 */
export async function detectImageFileMime(file) {
  const declared = String(file?.type || '').trim().toLowerCase();
  if (declared.startsWith('image/')) return declared === 'image/jpg' ? 'image/jpeg' : declared;
  const byName = imageMimeFromName(file?.name);
  if (byName) return byName;
  try {
    const header = new Uint8Array(await file.slice(0, 32).arrayBuffer());
    return imageMimeFromHeader(header);
  } catch (_) {
    return '';
  }
}

function fileToDataUrl(file, detectedMime = '') {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const mime = String(detectedMime || '').trim().toLowerCase();
      resolve(mime && /^data:(?:application\/octet-stream)?;/i.test(result)
        ? result.replace(/^data:(?:application\/octet-stream)?;/i, `data:${mime};`)
        : result);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve) => {
    if (!canvas?.toBlob) {
      resolve(null);
      return;
    }
    canvas.toBlob((blob) => resolve(blob), type, quality);
  });
}

function loadImageFromObjectUrl(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

export function isProbablyBlankWhiteRgba(data) {
  const pixels = data instanceof Uint8ClampedArray
    ? data
    : (data?.data instanceof Uint8ClampedArray ? data.data : null);
  if (!pixels || pixels.length < 4) return false;
  let visible = 0;
  let white = 0;
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    const alpha = pixels[i + 3];
    if (alpha < 16) continue;
    visible += 1;
    if (pixels[i] >= 253 && pixels[i + 1] >= 253 && pixels[i + 2] >= 253) {
      white += 1;
    }
  }
  return visible > 0 && white === visible;
}

function canvasLooksBlankWhite(canvas) {
  try {
    const probe = document.createElement('canvas');
    probe.width = 24;
    probe.height = 24;
    const ctx = probe.getContext('2d', { alpha: false, willReadFrequently: true });
    if (!ctx) return false;
    ctx.drawImage(canvas, 0, 0, probe.width, probe.height);
    return isProbablyBlankWhiteRgba(ctx.getImageData(0, 0, probe.width, probe.height));
  } catch (_) {
    // 读回探针失败时不能误杀正常图片；继续采用浏览器原有编码结果。
    return false;
  }
}

function drawChatImageToCanvas(source, sourceWidth, sourceHeight, maxEdge) {
  const scale = Math.min(1, maxEdge / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  // willReadFrequently 在部分 Android WebView 会避开容易产出空白帧的 GPU 读回路径。
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
  if (!ctx) return null;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(source, 0, 0, width, height);
  return { canvas, width, height };
}

async function createFallbackImageBitmap(file) {
  if (typeof createImageBitmap !== 'function') return null;
  try {
    return await createImageBitmap(file, {
      imageOrientation: 'from-image',
      premultiplyAlpha: 'default',
      colorSpaceConversion: 'default',
    });
  } catch (_) {
    try {
      return await createImageBitmap(file);
    } catch (_) {
      return null;
    }
  }
}

async function originalChatImageFallback(file, {
  allowOriginal = true,
  targetMaxBytes = LOCAL_CHAT_IMAGE_TARGET_MAX_BYTES,
} = {}) {
  if (allowOriginal && Number(file?.size || 0) <= targetMaxBytes * 1.8) {
    return {
      dataUrl: await fileToDataUrl(file),
      compressed: false,
      conversionFallback: 'original-after-blank-canvas',
    };
  }
  throw new Error('当前设备未能正确转换这张图片，请先在相册中截图或另存为 JPEG 后重试');
}

export function dataUrlApproxBytes(dataUrl = '') {
  const raw = String(dataUrl || '');
  const comma = raw.indexOf(',');
  const encodedLength = comma >= 0 ? raw.length - comma - 1 : raw.length;
  return Math.max(0, Math.floor(encodedLength * 0.75));
}

export async function fileToOptimizedChatImageDataUrl(file, options = {}) {
  const targetMaxBytes = Math.max(120 * 1024, Number(options.targetMaxBytes) || LOCAL_CHAT_IMAGE_TARGET_MAX_BYTES);
  const inlineMaxBytes = Math.max(0, Number(options.inlineMaxBytes ?? LOCAL_CHAT_IMAGE_INLINE_MAX_BYTES) || 0);
  const requestedMaxEdge = Math.max(320, Number(options.maxEdge) || LOCAL_CHAT_IMAGE_MAX_EDGE);
  const requestedMinEdge = Math.max(240, Number(options.minEdge) || LOCAL_CHAT_IMAGE_MIN_EDGE);
  const minEdge = Math.min(requestedMaxEdge, requestedMinEdge);
  const forcePixelResize = options.forcePixelResize === true;
  const allowOriginalFallback = options.allowOriginalFallback !== false;
  const type = String(file?.type || '').toLowerCase();
  const name = String(file?.name || '').toLowerCase();
  const imageByExtension = /\.(?:avif|gif|heic|heif|jpe?g|png|svg|webp)$/.test(name);
  if (!type.startsWith('image/') && !imageByExtension) {
    throw new Error('请选择图片文件');
  }
  const svg = type === 'image/svg+xml' || /\.svg$/.test(name);
  if (svg && !forcePixelResize) {
    if (Number(file.size || 0) > targetMaxBytes) {
      throw new Error('SVG 图片过大，请换一张较小的图片');
    }
    return { dataUrl: await fileToDataUrl(file), compressed: false };
  }
  // iOS 相册/文件选择器可能交出 HEIC、HEIF 或空 MIME。它们的 blob:
  // 当下能预览，但持久化成 data URL 后在 PWA/WKWebView 里不一定能再显示。
  // 通话背景等长期资产可要求非通用格式即使很小也先转成 JPEG。
  const portableType = /^(?:image\/jpeg|image\/png|image\/webp|image\/gif|image\/avif)$/.test(type);
  const forcePortableConversion = options.forcePortableFormat === true && !portableType;
  if (!forcePortableConversion && !forcePixelResize && Number(file.size || 0) <= inlineMaxBytes) {
    return { dataUrl: await fileToDataUrl(file), compressed: false };
  }

  const objectUrl = URL.createObjectURL(file);
  let fallbackBitmap = null;
  try {
    const img = await loadImageFromObjectUrl(objectUrl);
    const originalWidth = Number(img.naturalWidth || img.width || 0);
    const originalHeight = Number(img.naturalHeight || img.height || 0);
    if (!originalWidth || !originalHeight) {
      if (forcePixelResize || !allowOriginalFallback) {
        throw new Error('当前设备未能读取这张图片，请先在相册中截图或另存为 JPEG 后重试');
      }
      return { dataUrl: await fileToDataUrl(file), compressed: false };
    }

    let maxEdge = requestedMaxEdge;
    let bestBlob = null;
    let bestBytes = Infinity;
    while (maxEdge >= minEdge) {
      let drawn = drawChatImageToCanvas(img, originalWidth, originalHeight, maxEdge);
      if (!drawn) break;
      if (canvasLooksBlankWhite(drawn.canvas)) {
        fallbackBitmap ||= await createFallbackImageBitmap(file);
        const bitmapWidth = Number(fallbackBitmap?.width || 0);
        const bitmapHeight = Number(fallbackBitmap?.height || 0);
        if (fallbackBitmap && bitmapWidth && bitmapHeight) {
          drawn = drawChatImageToCanvas(fallbackBitmap, bitmapWidth, bitmapHeight, maxEdge);
        }
        if (!drawn || canvasLooksBlankWhite(drawn.canvas)) {
          return originalChatImageFallback(file, {
            allowOriginal: allowOriginalFallback && !forcePortableConversion && !forcePixelResize,
            targetMaxBytes,
          });
        }
      }
      const { canvas, width, height } = drawn;

      for (const quality of LOCAL_CHAT_IMAGE_QUALITY_STEPS) {
        const blob = await canvasToBlob(canvas, 'image/jpeg', quality);
        if (!blob) continue;
        if (blob.size < bestBytes) {
          bestBlob = blob;
          bestBytes = blob.size;
        }
        if (blob.size <= targetMaxBytes) {
          return {
            dataUrl: await fileToDataUrl(blob),
            compressed: true,
            originalWidth,
            originalHeight,
            width,
            height,
            storedBytes: blob.size,
          };
        }
      }
      maxEdge = Math.floor(maxEdge * 0.78);
    }

    if (bestBlob) {
      return {
        dataUrl: await fileToDataUrl(bestBlob),
        compressed: true,
        originalWidth,
        originalHeight,
        storedBytes: bestBlob.size,
      };
    }
    if (forcePixelResize || !allowOriginalFallback) {
      throw new Error('当前设备未能压缩这张图片，请换一张图片后重试');
    }
    return { dataUrl: await fileToDataUrl(file), compressed: false };
  } finally {
    fallbackBitmap?.close?.();
    URL.revokeObjectURL(objectUrl);
  }
}

/**
 * 朋友圈会在同一屏展示多张图片，使用比聊天图片更保守的像素和体积上限。
 * 无论源文件压缩后有多小都必须经过像素缩放，失败时也不能退回高分辨率原图。
 */
export const MOMENT_IMAGE_OPTIMIZATION_OPTIONS = Object.freeze({
  forcePortableFormat: true,
  forcePixelResize: true,
  allowOriginalFallback: false,
  inlineMaxBytes: 0,
  targetMaxBytes: 640 * 1024,
  maxEdge: 1080,
  minEdge: 540,
});

export function fileToOptimizedMomentImageDataUrl(file) {
  return fileToOptimizedChatImageDataUrl(file, MOMENT_IMAGE_OPTIMIZATION_OPTIONS);
}

export const CHAT_IMAGE_TARGET_MAX_BYTES = LOCAL_CHAT_IMAGE_TARGET_MAX_BYTES;
export const CHAT_IMAGE_INLINE_MAX_BYTES = LOCAL_CHAT_IMAGE_INLINE_MAX_BYTES;

/* 头像专用压缩：头像始终以很小的尺寸显示，但浏览器解码的是「原始像素」大小，
 * 一张 4000×3000 的照片当头像会解出 ~48MB 位图。群成员一多，iOS Safari 滚动到
 * 头像区时位图集中解码就会内存爆掉、整页卡死。这里把头像统一缩到 512px 内、JPEG 压缩，
 * 既省 IndexedDB 存储，也把解码内存压到几百 KB 量级。 */
const AVATAR_MAX_EDGE = 512;
const AVATAR_MIN_EDGE = 256;
const AVATAR_TARGET_MAX_BYTES = 180 * 1024;
const AVATAR_INLINE_MAX_BYTES = 60 * 1024;
const AVATAR_QUALITY_STEPS = [0.84, 0.76, 0.68, 0.6];

export async function fileToOptimizedAvatarDataUrl(file) {
  const type = await detectImageFileMime(file);
  if (!type) {
    throw new Error('请选择图片文件');
  }
  // SVG / GIF 无法安全地走 canvas 缩放（动图会丢帧、矢量会光栅化），直接内联原图。
  if (type === 'image/svg+xml' || type === 'image/gif') {
    return { dataUrl: await fileToDataUrl(file, type), compressed: false };
  }
  if (Number(file.size || 0) <= AVATAR_INLINE_MAX_BYTES) {
    return { dataUrl: await fileToDataUrl(file, type), compressed: false };
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await loadImageFromObjectUrl(objectUrl);
    const originalWidth = Number(img.naturalWidth || img.width || 0);
    const originalHeight = Number(img.naturalHeight || img.height || 0);
    if (!originalWidth || !originalHeight) {
      return { dataUrl: await fileToDataUrl(file, type), compressed: false };
    }

    let maxEdge = AVATAR_MAX_EDGE;
    let bestBlob = null;
    let bestBytes = Infinity;
    while (maxEdge >= AVATAR_MIN_EDGE) {
      const scale = Math.min(1, maxEdge / Math.max(originalWidth, originalHeight));
      const width = Math.max(1, Math.round(originalWidth * scale));
      const height = Math.max(1, Math.round(originalHeight * scale));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d', { alpha: false });
      if (!ctx) break;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(img, 0, 0, width, height);

      for (const quality of AVATAR_QUALITY_STEPS) {
        const blob = await canvasToBlob(canvas, 'image/jpeg', quality);
        if (!blob) continue;
        if (blob.size < bestBytes) {
          bestBlob = blob;
          bestBytes = blob.size;
        }
        if (blob.size <= AVATAR_TARGET_MAX_BYTES) {
          return { dataUrl: await fileToDataUrl(blob), compressed: true, storedBytes: blob.size };
        }
      }
      maxEdge = Math.floor(maxEdge * 0.78);
    }

    if (bestBlob) {
      return { dataUrl: await fileToDataUrl(bestBlob), compressed: true, storedBytes: bestBlob.size };
    }
    return { dataUrl: await fileToDataUrl(file, type), compressed: false };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
