/**
 * 公开试玩仅运行在浏览器 / PWA，不连接原生包、激活门禁或 OTA 服务。
 * 保留同名导出，避免共享 Web 模块为平台判断复制分支。
 */

export function isNativeShell() {
  return false;
}

export function inspectNativeUpdateDatabaseCompatibility() {
  return { compatible: true, reason: 'web-trial' };
}

export function inspectNativeUpdateManifestCompatibility() {
  return { compatible: true, reason: 'web-trial' };
}

export async function notifyNativeAppReady() {
  return { ok: true, skipped: true, reason: 'web-trial' };
}

export async function verifyNativeBundleCompatibilityBeforeBoot() {
  return { ok: true, skipped: true, reason: 'web-trial' };
}

export async function checkNativeUpdate() {
  return { ok: true, skipped: true, message: '试玩版通过网页发布更新。' };
}
