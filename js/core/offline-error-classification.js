/** 线下页生成/收纳异常归类。保持纯函数，避免把本地程序错误误报成网络断流。 */
export function classifyOfflineErrorReason(err) {
  if (!err) return 'empty-api-response';
  if (err.reason) return String(err.reason);
  if (err.timeoutStage || err.abortReason === 'watchdog') return 'client-timeout';
  if (err.code === 'opaque_network_error' || err.networkFailure === 'opaque') return 'network-unknown';
  const msg = String(err.message || '');
  if (/超时|timeout/i.test(msg)) return 'client-timeout';
  if (/未生成内容|空回|empty/i.test(msg)) return 'empty-api-response';
  if (/网页而非 JSON/i.test(msg)) return 'api-html-response';
  if (/CORS|浏览器拦截|WebView 拦截/i.test(msg)) return 'network-cors';
  if (/Failed to fetch|NetworkError|Load failed|ERR_FAILED|network error|HTTP2|ERR_HTTP2|protocol error/i.test(msg)) {
    return 'network-unknown';
  }
  if (/截断|流式|连接.*断开|传输中断|finish_reason.*length|length-truncated|broken pipe|socket closed|unexpected end of stream|connection reset|ECONNRESET/i.test(msg)) {
    return /length|截断/.test(msg) ? 'length-truncated' : 'stream-error';
  }
  if (/indexed database|database (?:server|connection).*lost|database has been closed/i.test(msg)) {
    return 'local-storage-error';
  }
  if (
    ['ReferenceError', 'TypeError', 'SyntaxError'].includes(String(err.name || ''))
    || /is not defined|is not a function|Cannot read propert/i.test(msg)
  ) {
    return 'exception';
  }
  if (Number(err.status) >= 400 || /API错误 \(\d+\)/.test(msg)) return 'generic';
  return 'generic';
}
