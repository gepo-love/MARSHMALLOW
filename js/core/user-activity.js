/** 前台用户正在操作时，后台 AI 补跑应让路，避免 APK 输入/点推进卡顿。 */
let lastAt = 0;

export function markUserActivity() {
  lastAt = Date.now();
}

export function isUserRecentlyActive(windowMs = 12000) {
  if (typeof document !== 'undefined' && document.hidden) return false;
  if (!lastAt) return false;
  return Date.now() - lastAt < Math.max(1000, Number(windowMs) || 12000);
}
