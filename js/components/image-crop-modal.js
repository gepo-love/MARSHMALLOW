import { icon } from './svg-icons.js';

function esc(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function loadImageElementFromUrl(img, url) {
  return new Promise((resolve, reject) => {
    if (!img) {
      reject(new Error('图片加载失败'));
      return;
    }
    img.onload = () => {
      img.onload = null;
      img.onerror = null;
      resolve(img);
    };
    img.onerror = () => {
      img.onload = null;
      img.onerror = null;
      reject(new Error('图片加载失败，请将图片截图或另存为 JPEG 后重试'));
    };
    img.src = url;
  });
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

/** 独立叠层，避免盖写 #modal-container 拆掉父设置弹层 */
function ensureImageCropHost() {
  let host = document.getElementById('image-crop-host');
  if (host) return host;
  host = document.createElement('div');
  host.id = 'image-crop-host';
  host.setAttribute('aria-hidden', 'true');
  document.body.appendChild(host);
  return host;
}

/**
 * 打开图片裁剪弹层。确认返回裁好的 File（JPEG），取消返回 null。
 * @returns {Promise<File|null>}
 */
export function openImageCropModal({
  file = null,
  src = '',
  title = '裁剪头像',
  confirmLabel = '完成',
  aspectRatio = 1,
  outputMaxEdge = 1024,
  shape = 'circle',
  outputType = 'image/jpeg',
  preserveAlpha = false,
} = {}) {
  const host = ensureImageCropHost();
  if (!host) return Promise.resolve(null);

  const objectUrl = file ? URL.createObjectURL(file) : '';
  const imageSrc = objectUrl || String(src || '');
  if (!imageSrc) return Promise.resolve(null);

  host.setAttribute('aria-hidden', 'false');
  host.classList.add('active');
  const shapeClass = shape === 'square' ? 'is-square' : 'is-circle';
  host.innerHTML = `
    <div class="modal-overlay image-crop-overlay" data-image-crop-overlay>
      <div class="modal-sheet image-crop-sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <header class="modal-header image-crop-header">
          <h3>${esc(title)}</h3>
          <button type="button" class="navbar-btn modal-close-btn" data-image-crop-cancel aria-label="取消">${icon('close')}</button>
        </header>
        <div class="image-crop-stage" data-image-crop-stage>
          <div class="image-crop-canvas-wrap" data-image-crop-wrap>
            <img class="image-crop-img" data-image-crop-img alt="" draggable="false" />
            <div class="image-crop-frame ${shapeClass}" data-image-crop-frame aria-hidden="true"></div>
          </div>
        </div>
        <div class="image-crop-toolbar">
          <button type="button" class="btn btn-outline image-crop-zoom-btn" data-image-crop-zoom-out aria-label="缩小">−</button>
          <input type="range" class="image-crop-zoom" data-image-crop-zoom min="100" max="300" value="100" aria-label="缩放" />
          <button type="button" class="btn btn-outline image-crop-zoom-btn" data-image-crop-zoom-in aria-label="放大">+</button>
        </div>
        <p class="image-crop-hint">拖动调整位置，滑杆缩放</p>
        <footer class="image-crop-footer">
          <button type="button" class="btn btn-outline" data-image-crop-cancel>取消</button>
          <button type="button" class="btn btn-primary" data-image-crop-confirm>${esc(confirmLabel)}</button>
        </footer>
      </div>
    </div>
  `;

  const sheet = host.querySelector('.image-crop-sheet');
  const stage = host.querySelector('[data-image-crop-stage]');
  const imgEl = host.querySelector('[data-image-crop-img]');
  const frameEl = host.querySelector('[data-image-crop-frame]');
  const zoomRange = host.querySelector('[data-image-crop-zoom]');
  const confirmBtn = host.querySelector('[data-image-crop-confirm]');
  if (confirmBtn) confirmBtn.disabled = true;

  return new Promise((resolve, reject) => {
    let settled = false;
    let imageReady = false;
    let naturalW = 0;
    let naturalH = 0;
    let frameW = 0;
    let frameH = 0;
    let zoom = 1;
    let panX = 0;
    let panY = 0;
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    let pinchDist = 0;
    let pinchZoom = 1;

    const finish = (result, error = null) => {
      if (settled) return;
      settled = true;
      cleanup();
      host.classList.remove('active');
      host.setAttribute('aria-hidden', 'true');
      host.innerHTML = '';
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      if (error) reject(error);
      else resolve(result);
    };

    const coverBase = () => {
      if (!frameW || !frameH || !naturalW || !naturalH) return 0;
      return Math.max(frameW / naturalW, frameH / naturalH);
    };

    const display = () => {
      const base = coverBase();
      if (!base) return { w: 0, h: 0, scale: 0 };
      const scale = base * zoom;
      return { w: naturalW * scale, h: naturalH * scale, scale };
    };

    const clampPan = () => {
      const { w, h } = display();
      if (!w || !h) return;
      panX = clamp(panX, -Math.max(0, (w - frameW) / 2), Math.max(0, (w - frameW) / 2));
      panY = clamp(panY, -Math.max(0, (h - frameH) / 2), Math.max(0, (h - frameH) / 2));
    };

    const layoutFrame = () => {
      const rect = stage.getBoundingClientRect();
      if (!rect.width || !rect.height) return false;
      const pad = 28;
      const maxW = Math.max(120, rect.width - pad * 2);
      const maxH = Math.max(120, rect.height - pad * 2);
      const ratio = Math.max(0.2, Number(aspectRatio) || 1);
      let w;
      let h;
      if (maxW / maxH > ratio) {
        h = maxH;
        w = h * ratio;
      } else {
        w = maxW;
        h = w / ratio;
      }
      frameW = Math.round(w);
      frameH = Math.round(h);
      frameEl.style.width = `${frameW}px`;
      frameEl.style.height = `${frameH}px`;
      return frameW > 0 && frameH > 0;
    };

    const paint = () => {
      const { w, h } = display();
      if (!w || !h) {
        imgEl.classList.remove('is-ready');
        return;
      }
      clampPan();
      imgEl.style.width = `${w}px`;
      imgEl.style.height = `${h}px`;
      imgEl.style.transform = `translate(-50%, -50%) translate(${panX}px, ${panY}px)`;
      imgEl.classList.add('is-ready');
      if (zoomRange) zoomRange.value = String(Math.round(zoom * 100));
    };

    const setZoom = (next) => {
      zoom = clamp(Number(next) || 1, 1, 3);
      paint();
    };

    const onPointerDown = (e) => {
      if (e.touches && e.touches.length === 2) {
        const [a, b] = e.touches;
        pinchDist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
        pinchZoom = zoom;
        dragging = false;
        return;
      }
      const point = e.touches ? e.touches[0] : e;
      dragging = true;
      lastX = point.clientX;
      lastY = point.clientY;
    };

    const onPointerMove = (e) => {
      if (e.touches && e.touches.length === 2) {
        e.preventDefault();
        const [a, b] = e.touches;
        const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
        if (pinchDist > 0) setZoom(pinchZoom * (dist / pinchDist));
        return;
      }
      if (!dragging) return;
      e.preventDefault();
      const point = e.touches ? e.touches[0] : e;
      panX += point.clientX - lastX;
      panY += point.clientY - lastY;
      lastX = point.clientX;
      lastY = point.clientY;
      paint();
    };

    const onPointerUp = () => {
      dragging = false;
      pinchDist = 0;
    };

    const onWheel = (e) => {
      e.preventDefault();
      setZoom(zoom + (e.deltaY > 0 ? -0.08 : 0.08));
    };

    const exportCroppedFile = async () => {
      if (!imageReady || !imgEl.complete || !Number(imgEl.naturalWidth || 0)) {
        throw new Error('图片还在读取，请稍后再试');
      }
      const { scale } = display();
      if (!scale || !frameW || !frameH) throw new Error('裁剪区域未就绪');
      const srcW = frameW / scale;
      const srcH = frameH / scale;
      const srcX = naturalW / 2 - srcW / 2 - panX / scale;
      const srcY = naturalH / 2 - srcH / 2 - panY / scale;

      const usePng = preserveAlpha || String(outputType || '').includes('png');
      const outW = Math.max(1, Math.round(Math.min(outputMaxEdge, srcW)));
      const outH = Math.max(1, Math.round(outW * (srcH / srcW)));
      const canvas = document.createElement('canvas');
      canvas.width = outW;
      canvas.height = outH;
      const ctx = canvas.getContext('2d', { alpha: usePng });
      if (!ctx) throw new Error('无法裁剪图片');
      if (!usePng) {
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, outW, outH);
      } else {
        ctx.clearRect(0, 0, outW, outH);
      }
      ctx.drawImage(imgEl, srcX, srcY, srcW, srcH, 0, 0, outW, outH);

      const mime = usePng ? 'image/png' : 'image/jpeg';
      const blob = await new Promise((res) => {
        canvas.toBlob((b) => res(b), mime, usePng ? undefined : 0.92);
      });
      if (!blob) throw new Error('裁剪失败');
      const nameBase = String(file?.name || 'image').replace(/\.[^.]+$/, '') || 'image';
      const ext = usePng ? 'png' : 'jpg';
      return new File([blob], `${nameBase}-crop.${ext}`, { type: mime });
    };

    const onKeyDown = (e) => {
      if (e.key === 'Escape') finish(null);
    };

    const onResize = () => {
      layoutFrame();
      paint();
    };

    const cleanup = () => {
      stage?.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('mousemove', onPointerMove);
      window.removeEventListener('mouseup', onPointerUp);
      stage?.removeEventListener('touchstart', onPointerDown);
      stage?.removeEventListener('touchmove', onPointerMove);
      stage?.removeEventListener('touchend', onPointerUp);
      stage?.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', onResize);
      if (imgEl) {
        imgEl.onload = null;
        imgEl.onerror = null;
      }
    };

    sheet?.addEventListener('click', (e) => e.stopPropagation());
    host.querySelectorAll('[data-image-crop-cancel]').forEach((el) => {
      el.addEventListener('click', () => finish(null));
    });
    host.querySelector('[data-image-crop-overlay]')?.addEventListener('click', () => finish(null));
    confirmBtn?.addEventListener('click', async () => {
      try {
        finish(await exportCroppedFile());
      } catch (err) {
        console.error(err);
        const { showToast } = await import('./toast.js');
        showToast(err?.message || '裁剪失败');
      }
    });
    host.querySelector('[data-image-crop-zoom-in]')?.addEventListener('click', () => setZoom(zoom + 0.12));
    host.querySelector('[data-image-crop-zoom-out]')?.addEventListener('click', () => setZoom(zoom - 0.12));
    zoomRange?.addEventListener('input', () => setZoom((Number(zoomRange.value) || 100) / 100));

    stage.addEventListener('mousedown', onPointerDown);
    window.addEventListener('mousemove', onPointerMove);
    window.addEventListener('mouseup', onPointerUp);
    stage.addEventListener('touchstart', onPointerDown, { passive: true });
    stage.addEventListener('touchmove', onPointerMove, { passive: false });
    stage.addEventListener('touchend', onPointerUp);
    stage.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', onResize);

    (async () => {
      try {
        // iOS WebKit 对 blob: 图片的两个 Image 实例可能不同步完成解码。
        // 必须等真正传给 canvas.drawImage 的这个 <img> 加载完成，
        // 否则预览可能还是旧图/空白，立即点「完成」还会导出空帧。
        const img = await loadImageElementFromUrl(imgEl, imageSrc);
        naturalW = Number(img.naturalWidth || img.width || 0);
        naturalH = Number(img.naturalHeight || img.height || 0);
        if (!naturalW || !naturalH) {
          throw new Error('图片尺寸无法读取');
        }
        imageReady = true;
        if (confirmBtn) confirmBtn.disabled = false;
        const bootPaint = (tries = 0) => {
          const ready = layoutFrame();
          zoom = 1;
          panX = 0;
          panY = 0;
          if (ready) {
            paint();
            return;
          }
          if (tries < 8) {
            requestAnimationFrame(() => bootPaint(tries + 1));
            return;
          }
          // 极端机型 stage 尺寸迟迟为 0：给一个安全取景框，仍不按原图像素写入宽高
          frameW = 240;
          frameH = Math.round(240 / Math.max(0.2, Number(aspectRatio) || 1));
          frameEl.style.width = `${frameW}px`;
          frameEl.style.height = `${frameH}px`;
          paint();
        };
        requestAnimationFrame(() => bootPaint());
      } catch (err) {
        finish(null, err instanceof Error ? err : new Error('图片加载失败'));
      }
    })();
  });
}

/**
 * 选图后先裁剪再压缩。取消返回 null；GIF/SVG 跳过裁剪直接压缩。
 */
export async function fileToCroppedOptimizedAvatarDataUrl(file, cropOpts = {}) {
  const { detectImageFileMime, fileToOptimizedAvatarDataUrl } = await import('../core/chat/chat-image-utils.js');
  const type = await detectImageFileMime(file);
  if (!type) {
    throw new Error('请选择图片文件');
  }
  if (type === 'image/svg+xml' || type === 'image/gif') {
    return fileToOptimizedAvatarDataUrl(file);
  }
  const cropped = await openImageCropModal({
    file,
    title: cropOpts.title || '裁剪头像',
    confirmLabel: cropOpts.confirmLabel || '完成',
    aspectRatio: cropOpts.aspectRatio ?? 1,
    shape: cropOpts.shape || 'circle',
    outputMaxEdge: cropOpts.outputMaxEdge || 1024,
  });
  if (!cropped) return null;
  return fileToOptimizedAvatarDataUrl(cropped);
}

/** Compress a File to data URL; pass preserveAlpha for PNG cutouts. */
export function compressFileToDataUrl(file, { maxSize = 1280, quality = 0.85, preserveAlpha = false } = {}) {
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
        const ctx = canvas.getContext('2d', { alpha: !!preserveAlpha });
        if (!ctx) throw new Error('无法压缩图片');
        if (!preserveAlpha) {
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, w, h);
        }
        ctx.drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        resolve(preserveAlpha ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', quality));
      } catch (err) {
        URL.revokeObjectURL(url);
        reject(err);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('图片读取失败'));
    };
    img.src = url;
  });
}

function fileToRawDataUrl(file, detectedMime = '') {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const mime = String(detectedMime || '').trim().toLowerCase();
      resolve(mime && /^data:(?:application\/octet-stream)?;/i.test(result)
        ? result.replace(/^data:(?:application\/octet-stream)?;/i, `data:${mime};`)
        : result);
    };
    reader.onerror = () => reject(new Error('图片读取失败'));
    reader.readAsDataURL(file);
  });
}
export async function downsampleLargeFileForCrop(file, {
  minBytes = 3 * 1024 * 1024,
  resizeWidth = 1800,
  quality = 0.86,
} = {}) {
  if (Number(file?.size || 0) < minBytes || typeof createImageBitmap !== 'function') {
    return file;
  }

  let bitmap = null;
  try {
    bitmap = await createImageBitmap(file, {
      imageOrientation: 'from-image',
      resizeWidth,
      resizeQuality: 'high',
    });
    if (!bitmap?.width || !bitmap?.height) return file;

    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return file;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0);

    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob(
        (value) => value ? resolve(value) : reject(new Error('图片预处理失败')),
        'image/jpeg',
        quality,
      );
    });
    const name = `${String(file?.name || 'wallpaper').replace(/\.[^.]+$/, '')}.jpg`;
    return typeof File === 'function'
      ? new File([blob], name, { type: 'image/jpeg', lastModified: Date.now() })
      : blob;
  } catch (_) {
    return file;
  } finally {
    try {
      bitmap?.close?.();
    } catch (_) {
      // Older WebKit may not expose ImageBitmap.close().
    }
  }
}


/** 常用裁剪预设：壁纸竖图、图标方图、封面横图等 */
export const IMAGE_CROP_PRESETS = {
  avatar: {
    title: '裁剪头像',
    aspectRatio: 1,
    shape: 'circle',
    outputMaxEdge: 1024,
    compress: { maxSize: 640, quality: 0.85 },
  },
  icon: {
    title: '裁剪图标',
    aspectRatio: 1,
    shape: 'square',
    outputMaxEdge: 512,
    preserveAlpha: true,
    compress: { maxSize: 240, preserveAlpha: true },
  },
  wallpaper: {
    title: '裁剪壁纸',
    aspectRatio: 9 / 16,
    shape: 'square',
    outputMaxEdge: 1600,
    predecodeMaxWidth: 1800,
    predecodeMinBytes: 3 * 1024 * 1024,
    compress: { maxSize: 1600, quality: 0.85 },
  },
  cover: {
    title: '裁剪封面',
    aspectRatio: 16 / 9,
    shape: 'square',
    outputMaxEdge: 1600,
    compress: { maxSize: 1600, quality: 0.85 },
  },
  wechatCover: {
    title: '裁剪朋友圈封面',
    aspectRatio: 4 / 3,
    shape: 'square',
    outputMaxEdge: 1600,
    compress: { maxSize: 1600, quality: 0.85 },
  },
  photo: {
    title: '裁剪图片',
    aspectRatio: 3 / 4,
    shape: 'square',
    outputMaxEdge: 1400,
    compress: { maxSize: 1400, quality: 0.85 },
  },
};

/**
 * 通用：裁剪后按 compress 参数压成 dataUrl。取消返回 null。
 * @param {File} file
 * @param {object} [opts] 可直接传 IMAGE_CROP_PRESETS.* 再覆盖字段
 * @returns {Promise<string|null>}
 */
export async function fileToCroppedCompressedDataUrl(file, opts = {}) {
  const { detectImageFileMime } = await import('../core/chat/chat-image-utils.js');
  const type = await detectImageFileMime(file);
  if (!type) {
    throw new Error('请选择图片文件');
  }
  const compress = opts.compress || { maxSize: 1280, quality: 0.85 };
  if (type === 'image/svg+xml' || type === 'image/gif') {
    if (type === 'image/gif' || type === 'image/svg+xml') {
      return fileToRawDataUrl(file, type);
    }
  }
  const cropFile = opts.predecodeMaxWidth
    ? await downsampleLargeFileForCrop(file, {
      minBytes: opts.predecodeMinBytes,
      resizeWidth: opts.predecodeMaxWidth,
    })
    : file;
  const cropped = await openImageCropModal({
    file: cropFile,
    title: opts.title || '裁剪图片',
    confirmLabel: opts.confirmLabel || '完成',
    aspectRatio: opts.aspectRatio ?? 1,
    shape: opts.shape || 'square',
    outputMaxEdge: opts.outputMaxEdge || compress.maxSize || 1600,
    outputType: compress.preserveAlpha || opts.preserveAlpha ? 'image/png' : 'image/jpeg',
    preserveAlpha: !!(compress.preserveAlpha || opts.preserveAlpha),
  });
  if (!cropped) return null;
  return compressFileToDataUrl(cropped, compress);
}
