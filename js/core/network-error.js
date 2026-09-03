const OPAQUE_FETCH_PATTERN = /Failed to fetch|NetworkError|Load failed|ERR_FAILED|network error/i;

export function isOpaqueFetchError(error) {
  return error?.name === 'TypeError'
    && OPAQUE_FETCH_PATTERN.test(String(error?.message || error || ''));
}

function safeOrigin(url = '') {
  try {
    return new URL(String(url || '')).origin;
  } catch (_) {
    return String(url || '').trim() || '目标地址';
  }
}

const LONG_RUNNING_REQUEST_MS = 10_000;

/**
 * Fetch deliberately hides the reason for many network-layer failures. The same
 * TypeError can mean CORS, DNS/TLS, offline, a blocker, or a dropped response.
 * Never claim one cause or authorize replay from this error alone.
 */
export function makeOpaqueFetchError(error, url = '', {
  label = '网络请求',
  elapsedMs = 0,
  replayRisk = false,
  nativeHint = '',
} = {}) {
  const requestElapsedMs = Math.max(0, Number(elapsedMs || error?.requestElapsedMs || 0));
  const seconds = Math.max(0, Math.round(requestElapsedMs / 1000));
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  const longRunning = requestElapsedMs >= LONG_RUNNING_REQUEST_MS;
  const duration = seconds > 0 ? `（本机等待约 ${seconds} 秒后连接结束）` : '';
  const causeText = offline
    ? '设备当前处于离线状态。'
    : (longRunning
      ? '浏览器在等待生成或接收结果时失去了连接；这段本机计时不等于中转后台的生成耗时，也无法确认服务端最终是否完成。'
      : '浏览器没有提供具体原因，无法确认是跨域策略、DNS/证书、代理或扩展拦截、断网，还是响应途中断开。');
  const replayText = replayRisk
    ? (longRunning
      ? ' 请求很可能已经到达服务端；为避免重复生成或计费，本次未自动重试，请先检查服务端生成记录。'
      : ' 请求可能已经到达服务端；为避免重复生成或计费，本次未自动重试。')
    : '';
  const hint = String(nativeHint || '').trim();
  const targetOrigin = safeOrigin(url);
  const wrapped = new Error(
    `${label}失败${duration}：${causeText}${replayText}`
    + ` 目标：${targetOrigin}。`
    + (hint ? ` ${hint}` : ''),
  );
  wrapped.code = offline ? 'offline' : 'opaque_network_error';
  wrapped.networkFailure = offline ? 'offline' : 'opaque';
  wrapped.requestElapsedMs = requestElapsedMs;
  wrapped.requestMayHaveReachedServer = replayRisk;
  wrapped.replayBlocked = replayRisk;
  wrapped.resultUnknown = replayRisk && !offline;
  wrapped.requestPhase = longRunning ? 'response_wait' : 'unknown';
  wrapped.usedUrl = String(url || '');
  wrapped.targetOrigin = targetOrigin;
  wrapped.cause = error instanceof Error ? error : undefined;
  return wrapped;
}
