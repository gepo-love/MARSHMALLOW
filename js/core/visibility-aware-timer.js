function isHidden(target) {
  if (!target) return false;
  return target.hidden === true || target.visibilityState === 'hidden';
}

/**
 * 记录任务的墙钟耗时与页面前台活跃耗时。
 * 浏览器退到后台时 JS 可能被整段冻结；诊断本地计算性能时不能把这段冻结时间算进去。
 */
export function createVisibilityAwareTimer(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const visibilityTarget = Object.prototype.hasOwnProperty.call(options, 'visibilityTarget')
    ? options.visibilityTarget
    : (typeof document !== 'undefined' ? document : null);
  const startedAt = Number(now()) || 0;
  let hiddenStartedAt = isHidden(visibilityTarget) ? startedAt : null;
  let hiddenMs = 0;
  let result = null;

  const onVisibilityChange = () => {
    const current = Number(now()) || 0;
    if (isHidden(visibilityTarget)) {
      if (hiddenStartedAt === null) hiddenStartedAt = current;
      return;
    }
    if (hiddenStartedAt === null) return;
    hiddenMs += Math.max(0, current - hiddenStartedAt);
    hiddenStartedAt = null;
  };

  visibilityTarget?.addEventListener?.('visibilitychange', onVisibilityChange);

  return {
    finish() {
      if (result) return { ...result };
      const finishedAt = Number(now()) || 0;
      if (hiddenStartedAt !== null) {
        hiddenMs += Math.max(0, finishedAt - hiddenStartedAt);
        hiddenStartedAt = null;
      }
      const elapsedMs = Math.max(0, finishedAt - startedAt);
      const boundedHiddenMs = Math.min(elapsedMs, Math.max(0, hiddenMs));
      result = {
        elapsedMs,
        hiddenMs: boundedHiddenMs,
        activeMs: Math.max(0, elapsedMs - boundedHiddenMs),
      };
      visibilityTarget?.removeEventListener?.('visibilitychange', onVisibilityChange);
      return { ...result };
    },
  };
}
