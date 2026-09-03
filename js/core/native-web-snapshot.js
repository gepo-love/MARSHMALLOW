// 内置网页窗 + 无 TikHub Key 时的社媒链接截图兜底：仅 Android 原生壳生效，
// Web/PWA/iOS（暂无原生实现）isWebSnapshotSupported() 恒为 false，调用方需自行兜底。
// 原生实现见 android/app/src/main/java/com/marshmallow/machine/MarshmallowWebSnapshotActivity.java
// + MarshmallowWebSnapshotPlugin.java：用真正的顶层 WebView 打开页面（不是塞进 iframe），
// 不受小红书/微博的 X-Frame-Options 限制；截图同样不做任何 OCR/内容抓取，直接作为图片
// 交给聊天链路已有的识图能力（core/chat/vision-context.js 的 image_url parts）。

function plugin() {
  if (typeof window === 'undefined') return null;
  return window.Capacitor?.Plugins?.MarshmallowWebSnapshot || null;
}

const CAPTURE_HOST_RULES = [
  /(^|\.)xiaohongshu\.com$/i,
  /(^|\.)xhslink\.(?:com|cn)$/i,
  /(^|\.)weibo\.(?:com|cn)$/i,
  /^t\.cn$/i,
  /(^|\.)bilibili\.com$/i,
  /(^|\.)b23\.tv$/i,
  /(^|\.)taobao\.com$/i,
  /(^|\.)tmall\.(?:com|hk)$/i,
  /(^|\.)tb\.cn$/i,
];

/** 自动截图只允许产品明确支持的分享站点，不能被当成任意网页截图器。 */
export function isWebSnapshotCaptureUrlAllowed(url = '') {
  try {
    const parsed = new URL(String(url || '').trim());
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    const host = parsed.hostname.toLowerCase();
    return CAPTURE_HOST_RULES.some((rule) => rule.test(host));
  } catch {
    return false;
  }
}

export function isWebSnapshotSupported() {
  return !!plugin();
}

/** 用内置顶层 WebView 打开一个网页（分享链接的「内置小窗」）；非原生壳直接返回 false 交给调用方走浏览器新标签页兜底。 */
export async function openNativeWebViewer(url, options = {}) {
  const p = plugin();
  if (!p) return { ok: false, error: '当前不是原生壳环境' };
  const target = String(url || '').trim();
  if (!/^https?:\/\//i.test(target)) return { ok: false, error: '链接不合法' };
  try {
    return await p.openViewer({ url: target, title: String(options.title || '').trim() });
  } catch (err) {
    return { ok: false, error: err?.message || String(err || '') };
  }
}

/**
 * 加载一个 URL，优先抽取页面结构化内容（小红书 __INITIAL_STATE__），否则自动截 1~2 屏。
 * 用于没配 TikHub Key（或 TikHub 请求失败）时的小红书/微博分享链接兜底。
 * @returns {{ ok:boolean, images?: Array<{dataUrl:string,width:number,height:number}>, note?: object, finalUrl?:string, pageTitle?:string, reason?:string, error?:string }}
 */
export async function captureUrlSnapshot(url, options = {}) {
  const p = plugin();
  if (!p) return { ok: false, reason: 'unsupported', error: '当前不是原生壳环境' };
  const target = String(url || '').trim();
  if (!isWebSnapshotCaptureUrlAllowed(target)) {
    return { ok: false, reason: 'blocked_url', error: '该站点不允许自动截图' };
  }
  try {
    // 旧 APK 虽已有 captureUrl，但没有敏感跳转阻断与读取即清理。必须显式完成能力握手，
    // 不能把“方法存在”误当成“安全实现已升级”；旧壳继续退回普通链接卡片。
    const capabilities = await p.getCapabilities().catch(() => null);
    const minSecurityVersion = Math.max(1, Number(options.minSecurityVersion) || 1);
    if (Number(capabilities?.captureSecurityVersion || 0) < minSecurityVersion
      || capabilities?.restrictedRedirects !== true
      || capabilities?.consumeOnRead !== true) {
      return { ok: false, reason: 'native_update_required', error: '当前 APK 原生截图能力需要更新' };
    }
    const res = await p.captureUrl({
      url: target,
      maxShots: Math.max(1, Math.min(3, Number(options.maxShots) || 2)),
      maxWidth: Math.max(320, Math.min(960, Number(options.maxWidth) || 640)),
      quality: Math.max(40, Math.min(85, Number(options.quality) || 60)),
    });
    return res || { ok: false, reason: 'empty_result' };
  } catch (err) {
    return { ok: false, reason: 'plugin_error', error: err?.message || String(err || '') };
  }
}
