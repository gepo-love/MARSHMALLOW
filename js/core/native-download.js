import {
  hasNativeFileExport,
  saveBlobNatively,
  saveTextNatively,
} from './native-file-export.js';

export class DownloadFailedError extends Error {
  constructor(message = '文件未能保存到设备') {
    super(message);
    this.name = 'DownloadFailedError';
  }
}

/**
 * 桌面 Chrome/Edge：超过此体积时，必须先在用户点击瞬间弹出 showSaveFilePicker，
 * 否则大文件下载常被静默拦截。这是网页手势策略，不是 iOS/系统硬限制。
 */
export const WEB_GESTURE_SAVE_THRESHOLD_BYTES = 4 * 1024 * 1024;
/** 给 Android 下载管理器留出读取 OPFS-backed File 的时间，避免临时源过早释放成 0 B。 */
export const BROWSER_DOWNLOAD_RELEASE_DELAY_MS = 5 * 60 * 1000;

export function isNativeShell() {
  return typeof window !== 'undefined'
    && typeof window.Capacitor?.isNativePlatform === 'function'
    && window.Capacitor.isNativePlatform();
}

/** iPhone / iPad（含 iPadOS 伪装成 Mac 的情况）。 */
export function isIOSDevice() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  if (/iP(hone|od|ad)/.test(ua)) return true;
  return navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1;
}

/** Android 浏览器 / WebView。允许传入 UA，便于兼容性测试。 */
export function isAndroidDevice(userAgent = null) {
  const ua = userAgent == null
    ? (typeof navigator === 'undefined' ? '' : navigator.userAgent || '')
    : String(userAgent || '');
  return /Android/i.test(ua);
}

/** 已知会把 File System Access 接到系统文件保存器的 Android Chromium 浏览器。 */
export function isKnownAndroidWebSaveBrowser(userAgent = null) {
  const ua = userAgent == null
    ? (typeof navigator === 'undefined' ? '' : String(navigator.userAgent || ''))
    : String(userAgent || '');
  if (!/Android/i.test(ua)) return false;
  // WebView 与部分厂商浏览器会带 Chrome token，但 showSaveFilePicker 只是残缺占位；
  // 继续让它们走 OPFS，避免点导出后出现假的「已取消保存」。
  if (/\bwv\b|;\s*wv\)|Version\/4\.0|SamsungBrowser|HuaweiBrowser|VivoBrowser|HeyTapBrowser|OppoBrowser|MiuiBrowser|UCBrowser|Quark/i.test(ua)) {
    return false;
  }
  return /\bEdgA\/\d+/i.test(ua) || /\bChrome\/\d+/i.test(ua);
}

/**
 * 桌面 Chrome/Edge 与确实暴露保存 API 的官方 Android Chrome/Edge 可直接流式落盘。
 * 厂商浏览器的半实现仍不启用，失败时由 OPFS 安全兜底。
 */
export function hasReliableWebSaveFilePicker() {
  if (isNativeShell() || typeof window.showSaveFilePicker !== 'function') return false;
  if (isIOSDevice()) return false;
  if (isAndroidDevice() && !isKnownAndroidWebSaveBrowser()) return false;
  return true;
}

function pickerTypesForFilename(filename, mimeType = '') {
  const lower = String(filename || '').toLowerCase();
  const mime = String(mimeType || '').toLowerCase();
  if (lower.endsWith('.mmmigrate') || mime.includes('marshmallow.migration')) {
    return [{ description: '棉花糖机搬家包', accept: { 'application/octet-stream': ['.mmmigrate'] } }];
  }
  if (lower.endsWith('.zip') || mime.includes('zip')) {
    return [{ description: 'ZIP', accept: { 'application/zip': ['.zip'] } }];
  }
  if (lower.endsWith('.json') || mime.includes('json')) {
    return [{ description: 'JSON', accept: { 'application/json': ['.json'] } }];
  }
  if (lower.endsWith('.md') || mime.includes('markdown')) {
    return [{ description: 'Markdown', accept: { 'text/markdown': ['.md'] } }];
  }
  if (lower.endsWith('.css') || mime.includes('css')) {
    return [{ description: 'CSS', accept: { 'text/css': ['.css'] } }];
  }
  if (lower.endsWith('.png') || mime.startsWith('image/')) {
    return [{ description: 'Image', accept: { 'image/png': ['.png'] } }];
  }
  return [{ description: 'File', accept: { 'application/octet-stream': ['.bin'] } }];
}

/**
 * 必须在用户点击事件的同步链路里尽早调用（写文件之前），否则大文件会被浏览器静默拦截。
 * @returns {Promise<{ writable: FileSystemWritableFileStream, filename: string }|null>}
 */
export async function pickWebSaveWritable(filename, options = {}) {
  if (!hasReliableWebSaveFilePicker()) return null;
  const safeName = String(filename || 'marshmallow-export.bin');
  try {
    const handle = await window.showSaveFilePicker({
      suggestedName: safeName,
      types: pickerTypesForFilename(safeName, options.mimeType),
    });
    return { handle, writable: await handle.createWritable(), filename: safeName };
  } catch (err) {
    if (err?.name === 'AbortError') throw new DownloadFailedError('已取消保存');
    return null;
  }
}

export async function finishWebSaveWritable(target, data) {
  if (!target?.writable) throw new DownloadFailedError('保存目标不可用');
  await target.writable.write(data);
  await target.writable.close();
  return { method: 'browser-fs', filename: target.filename, ok: true };
}

function browserDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.dispatchEvent(new MouseEvent('click', {
    bubbles: true,
    cancelable: true,
    view: window,
  }));
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, BROWSER_DOWNLOAD_RELEASE_DELAY_MS);
  return { method: 'browser', filename, ok: true };
}

function asShareFile(blob, filename) {
  return typeof File !== 'undefined'
    && blob instanceof File
    && blob.name === filename
    ? blob
    : new File([blob], filename, { type: blob.type || 'application/octet-stream' });
}

export function canShareBlobFile(blob, filename) {
  if (!blob || typeof File === 'undefined' || typeof navigator === 'undefined' || !navigator.share || !navigator.canShare) return false;
  try {
    return navigator.canShare({ files: [asShareFile(blob, filename)] }) === true;
  } catch (_) {
    return false;
  }
}

async function shareBlob(blob, filename) {
  if (typeof navigator === 'undefined' || !navigator.share) return null;
  try {
    // Reuse an OPFS-backed File instead of asking WebKit to copy the whole export again.
    const file = asShareFile(blob, filename);
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: filename });
      return { method: 'share', filename, ok: true };
    }
  } catch (err) {
    if (err?.name === 'AbortError') return null;
    console.warn('[native-download] share failed', err);
  }
  return null;
}

export async function shareBlobFile(blob, filename) {
  const safeName = String(filename || 'marshmallow-export.bin');
  if (!blob || blob.size <= 0) throw new DownloadFailedError('没有可保存的内容');
  const shared = await shareBlob(blob, safeName);
  if (shared) return shared;
  throw new DownloadFailedError('当前浏览器不支持文件分享，请改用浏览器下载或加密云备份');
}

async function downloadBlobWeb(blob, filename, options = {}) {
  if (options.webSaveTarget?.writable) {
    return finishWebSaveWritable(options.webSaveTarget, blob);
  }

  const android = isAndroidDevice();

  // iOS Safari / PWA：没有可靠的「另存为」，整包（含大 ZIP）优先一次系统分享到「文件」。
  // 不要用桌面 4MB 手势门槛硬拦——那不是 iOS 上限，硬拦只会逼出一堆小分片。
  // Android 厂商浏览器可能让 canShare({ files }) 返回 true，却把文件降级成标题文本；
  // 即使调用方请求 preferShare，也必须走真实下载，避免出现“分享文本”假成功。
  if (isIOSDevice() || (options.preferShare && !android)) {
    const shared = await shareBlob(blob, filename);
    if (shared) return shared;
    // 分享被取消或不可用时，再试一次 <a download>（部分 WebView 仍能落盘）
    if (blob.size < WEB_GESTURE_SAVE_THRESHOLD_BYTES) {
      return browserDownload(blob, filename);
    }
    throw new DownloadFailedError(
      '未能弹出系统分享。请重试并选择「存储到文件」，或用电脑 Chrome/Edge 导出。',
    );
  }

  // 必须在新的用户点击栈中同步触发。尤其是大文件，不能先 await 一个注定不可用的
  // showSaveFilePicker，否则 Android 会丢失下载所需的 transient user activation。
  if (android) return browserDownload(blob, filename);

  if (blob.size >= WEB_GESTURE_SAVE_THRESHOLD_BYTES) {
    const picked = await pickWebSaveWritable(filename, options);
    if (picked) return finishWebSaveWritable(picked, blob);
    // Android 浏览器（如雨见）通常没有 File System Access API，但仍支持
    // <a download>。这里不能把桌面浏览器的手势限制误当成通用文件大小上限。
    return browserDownload(blob, filename);
  }
  return browserDownload(blob, filename);
}

async function downloadTextWeb(text, filename, options = {}) {
  const mimeType = String(options.mimeType || 'text/plain; charset=utf-8');
  const blob = new Blob([String(text ?? '')], { type: mimeType });
  return downloadBlobWeb(blob, filename, { ...options, mimeType });
}

export async function downloadBlob(blob, filename, options = {}) {
  const safeName = String(filename || 'marshmallow-export.bin');
  if (!blob || blob.size <= 0) {
    throw new DownloadFailedError('没有可导出的内容');
  }

  if (isNativeShell()) {
    if (hasNativeFileExport()) {
      try {
        const result = await saveBlobNatively(blob, {
          filename: safeName,
          mimeType: String(options.mimeType || blob.type || 'application/octet-stream'),
          directory: options.directory || (String(options.mimeType || blob.type || '').startsWith('image/') ? 'pictures' : 'downloads'),
        });
        if (result?.ok) return { method: 'native', filename: safeName, ...result, ok: true };
      } catch (err) {
        console.warn('[native-download] native blob save failed', err);
      }
    }
    const shared = await shareBlob(blob, safeName);
    if (shared) return shared;
    throw new DownloadFailedError('未能写入 Downloads/MarshmallowMachine，请更新到最新版本后重试');
  }

  return downloadBlobWeb(blob, safeName, options);
}

export async function downloadText(text, filename, options = {}) {
  const safeName = String(filename || 'marshmallow-export.txt');
  const body = String(text ?? '');
  if (!body.length) throw new DownloadFailedError('没有可导出的内容');

  if (isNativeShell()) {
    const mimeType = String(options.mimeType || 'text/plain; charset=utf-8');
    if (hasNativeFileExport()) {
      try {
        const result = await saveTextNatively(body, {
          filename: safeName,
          mimeType,
          directory: options.directory || 'downloads',
        });
        if (result?.ok) return { method: 'native', filename: safeName, ...result, ok: true };
      } catch (err) {
        console.warn('[native-download] native text save failed', err);
      }
    }
    const blob = new Blob([body], { type: mimeType });
    const shared = await shareBlob(blob, safeName);
    if (shared) return shared;
    throw new DownloadFailedError('未能写入 Downloads/MarshmallowMachine，请更新到最新版本后重试');
  }

  return downloadTextWeb(body, safeName, options);
}

export async function downloadJson(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
  return downloadBlob(blob, filename, { mimeType: 'application/json', directory: 'downloads' });
}

export function describeDownloadResult(result) {
  if (result?.method === 'native') {
    const path = result.relativePath || 'Download/MarshmallowMachine';
    return `已保存到 ${path}/${result.filename || ''}`.replace(/\/+$/, '');
  }
  if (result?.method === 'browser-fs') return `已保存 ${result.filename || '文件'}`;
  if (result?.method === 'browser-dir') return '已保存到所选文件夹';
  if (result?.method === 'browser-zip') return `已保存 ${result.filename || '分片 ZIP'}`;
  if (result?.method === 'share') return '已通过系统分享保存到「文件」';
  if (result?.method === 'browser') return '已开始下载';
  return '已保存';
}
