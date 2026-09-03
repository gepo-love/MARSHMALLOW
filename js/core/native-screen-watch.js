// 定时截屏（陪你看屏幕）桥接：仅 Android 原生壳生效，iOS/网页端 isScreenWatchSupported() 恒为 false。
// 原生实现见 android/app/src/main/java/com/marshmallow/machine/MarshmallowScreenPlugin.java + MarshmallowScreenCaptureService.java。
// 截屏本身不做任何图像识别/OCR——拿到的 dataUrl 直接作为一张图片喂给用户配置的主模型，
// 复用聊天链路已有的识图能力（core/chat/vision-context.js 的 image_url parts）。

function plugin() {
  if (typeof window === 'undefined') return null;
  return window.Capacitor?.Plugins?.MarshmallowScreen || null;
}

let periodicWatchActive = false;
let periodicWatchKey = '';

export function isScreenWatchSupported() {
  return !!plugin();
}

/** 首次截屏会弹系统授权框；用户同意后返回一张 dataUrl，未开启定时任务。 */
export async function captureScreenOnce(options = {}) {
  const p = plugin();
  if (!p) return { ok: false, cancelled: false, error: '当前不是原生壳环境' };
  try {
    return await p.captureOnce({
      maxWidth: Math.max(240, Math.min(1440, Number(options.maxWidth) || 720)),
      quality: Math.max(35, Math.min(90, Number(options.quality) || 68)),
    });
  } catch (err) {
    return { ok: false, error: err?.message || String(err || '') };
  }
}

/** 开启定时截屏后台任务（会弹一次系统授权框，同意后常驻到 stopPeriodic 或授权被系统收回）。 */
export async function startPeriodicScreenWatch(options = {}) {
  const p = plugin();
  if (!p) return { ok: false, error: '当前不是原生壳环境' };
  const nextKey = JSON.stringify({
    intervalMs: Math.max(5 * 60_000, Math.min(120 * 60_000, Number(options.intervalMs) || 15 * 60_000)),
    maxWidth: Math.max(240, Math.min(1440, Number(options.maxWidth) || 720)),
    quality: Math.max(35, Math.min(90, Number(options.quality) || 68)),
  });
  if (periodicWatchActive && periodicWatchKey === nextKey) {
    return { ok: true, alreadyRunning: true };
  }
  try {
    const status = await p.getPeriodicStatus?.().catch(() => null);
    if (status?.running) {
      periodicWatchActive = true;
      periodicWatchKey = nextKey;
      return { ok: true, alreadyRunning: true, started: true };
    }
    const res = await p.startPeriodic(JSON.parse(nextKey));
    if (res?.started || res?.ok) {
      periodicWatchActive = true;
      periodicWatchKey = nextKey;
    }
    return res;
  } catch (err) {
    return { ok: false, error: err?.message || String(err || '') };
  }
}

export async function stopPeriodicScreenWatch() {
  periodicWatchActive = false;
  periodicWatchKey = '';
  const p = plugin();
  if (!p) return;
  try { await p.stopPeriodic(); } catch (_) {}
}

/** 读最近一次缓存的截屏（定时任务或 captureOnce 落地的那张），拿不到时 ok:false。 */
export async function getLatestScreenCapture() {
  const p = plugin();
  if (!p) return { ok: false, empty: true };
  try {
    return await p.getLatestCapture({ includeDataUrl: true });
  } catch (err) {
    return { ok: false, error: err?.message || String(err || '') };
  }
}

export async function clearLatestScreenCapture() {
  const p = plugin();
  if (!p) return;
  try { await p.clearLatestCapture(); } catch (_) {}
}
