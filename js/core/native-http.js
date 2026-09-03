/**
 * Native HTTP for Capacitor APK/iOS shell.
 * 非流式模型请求直接用原生整包通道；流式仍由 WebView fetch 增量消费，
 * WebView 已确认跨域失败或页面切到后台时也回退到这里。
 */

export function isNativeAppShell() {
  try {
    return typeof window !== 'undefined'
      && typeof window.Capacitor?.isNativePlatform === 'function'
      && !!window.Capacitor.isNativePlatform();
  } catch (_) {
    return false;
  }
}

function capacitorHttpPlugin() {
  return window.Capacitor?.Plugins?.CapacitorHttp || null;
}

/** Custom plugin with real abort support; only in APKs built after it landed. */
function marshmallowHttpPlugin() {
  const plugin = window.Capacitor?.Plugins?.MarshmallowHttp || null;
  return typeof plugin?.request === 'function' ? plugin : null;
}

export function hasNativeHttp() {
  return isNativeAppShell()
    && (!!marshmallowHttpPlugin() || typeof capacitorHttpPlugin()?.request === 'function');
}

export function getNativeHttpTransport() {
  if (!isNativeAppShell()) return '';
  if (marshmallowHttpPlugin()) return 'marshmallow-http';
  if (typeof capacitorHttpPlugin()?.request === 'function') return 'capacitor-http';
  return '';
}

export function supportsNativeHttpRequestRecovery() {
  const plugin = marshmallowHttpPlugin();
  return typeof plugin?.getRequestState === 'function'
    && typeof plugin?.readRequestChunk === 'function';
}

/**
 * 请求期间挂起「正在生成回复」前台服务（引用计数），让系统在切后台时
 * 尽量别掐网络。走 MarshmallowHttp 原生请求时 Java 侧会挂独立租约；WebView
 * fetch 流式请求由 JS 在这里显式挂上。旧 APK 没有这两个方法时静默跳过。
 */
export async function acquireNetworkLease({
  timeoutMs = 16 * 60_000,
  title = '正在准备聊天上下文',
  body = '请暂留前台',
} = {}) {
  const plugin = window.Capacitor?.Plugins?.MarshmallowHttp || null;
  if (typeof plugin?.acquireNetworkLease !== 'function') return false;
  const leaseId = `web:${makeNativeRequestId()}`;
  try {
    const result = await plugin.acquireNetworkLease({
      leaseId,
      timeoutMs,
      title: String(title || '正在准备聊天上下文'),
      body: String(body || '请暂留前台'),
    });
    return result?.ok === false ? false : leaseId;
  } catch (_) {
    return false;
  }
}

export function releaseNetworkLease(leaseId = '') {
  const plugin = window.Capacitor?.Plugins?.MarshmallowHttp || null;
  if (typeof plugin?.releaseNetworkLease !== 'function') return;
  try {
    plugin.releaseNetworkLease({ leaseId: String(leaseId || '') }).catch(() => {});
  } catch (_) {}
}

let _requestSeq = 0;

function makeNativeRequestId() {
  _requestSeq += 1;
  return `mhttp_${Date.now().toString(36)}_${_requestSeq}`;
}

function nativeAbortError() {
  const error = new Error('请求已取消');
  error.name = 'AbortError';
  return error;
}

function waitForNativePoll(ms, signal) {
  if (signal?.aborted) return Promise.reject(nativeAbortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      reject(nativeAbortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

async function readCompletedNativeRequest(plugin, requestId, state) {
  let offset = 0;
  let data = '';
  const availableLength = Math.max(0, Number(state?.responseLength || 0));
  while (offset < availableLength) {
    const chunk = await plugin.readRequestChunk({
      requestId,
      offset,
      maxChars: 256 * 1024,
    });
    if (!chunk) break;
    data += String(chunk.data || '');
    const nextOffset = Number(chunk.nextOffset || offset);
    if (nextOffset <= offset) break;
    offset = nextOffset;
  }
  return {
    status: Number(state?.status || 0) || 200,
    data,
    headers: state?.headers || {},
    partial: state?.state === 'partial' || state?.partial === true,
    readError: String(state?.error || ''),
    requestId,
    recoveredFromTaskState: true,
  };
}

async function pollNativeHttpRequest(plugin, requestId, signal) {
  while (!signal?.aborted) {
    await waitForNativePoll(900, signal);
    let state = null;
    try {
      state = await plugin.getRequestState({ requestId });
    } catch (_) {
      continue;
    }
    const phase = String(state?.state || '').toLowerCase();
    if (phase === 'completed' || phase === 'partial') {
      return readCompletedNativeRequest(plugin, requestId, state);
    }
    if (phase === 'aborted') throw nativeAbortError();
    if (phase === 'failed') {
      if (Number(state?.responseLength || 0) > 0) {
        return readCompletedNativeRequest(plugin, requestId, { ...state, state: 'partial', partial: true });
      }
      const error = new Error(String(state?.error || '原生网络请求失败'));
      error.nativeRequestId = requestId;
      throw error;
    }
  }
  throw nativeAbortError();
}

async function recoverNativeRequestAfterBridgeFailure(plugin, requestId, signal, graceMs = 5_000) {
  const deadline = Date.now() + Math.max(0, Number(graceMs) || 0);
  do {
    if (signal?.aborted) throw nativeAbortError();
    let state = null;
    try {
      state = await plugin.getRequestState({ requestId });
    } catch (_) {
      state = null;
    }
    const responseLength = Math.max(0, Number(state?.responseLength || 0));
    const phase = String(state?.state || '').toLowerCase();
    if (responseLength > 0 && ['completed', 'partial', 'failed'].includes(phase)) {
      return readCompletedNativeRequest(plugin, requestId, {
        ...state,
        state: phase === 'completed' ? 'completed' : 'partial',
        partial: phase !== 'completed',
      });
    }
    if (phase === 'aborted') throw nativeAbortError();
    if (phase === 'failed' && responseLength === 0) return null;
    if (Date.now() >= deadline) return null;
    await waitForNativePoll(300, signal);
  } while (true);
}

async function inspectNativeRequestState(plugin, requestId) {
  if (!requestId || typeof plugin?.getRequestState !== 'function') return null;
  try {
    const state = await plugin.getRequestState({ requestId });
    if (!state || typeof state !== 'object') return null;
    return {
      state: String(state.state || '').toLowerCase(),
      status: Number(state.status || 0),
      responseLength: Math.max(0, Number(state.responseLength || 0)),
      error: String(state.error || ''),
      partial: state.partial === true,
      active: state.active === true,
    };
  } catch (error) {
    return {
      state: 'query-failed',
      status: 0,
      responseLength: 0,
      error: String(error?.message || error || '读取原生任务状态失败'),
      partial: false,
      active: false,
    };
  }
}

function attachNativeFailureEvidence(error, source = {}) {
  const out = error instanceof Error ? error : new Error(String(error || '原生网络请求失败'));
  const from = source && typeof source === 'object' ? source : {};
  if (from.nativeRequestId) out.nativeRequestId = String(from.nativeRequestId);
  if (from.nativeTaskState) out.nativeTaskState = from.nativeTaskState;
  if (from.nativeErrorCode || from.code) out.nativeErrorCode = String(from.nativeErrorCode || from.code);
  if (from.nativeErrorMessage || from.message) {
    out.nativeErrorMessage = String(from.nativeErrorMessage || from.message);
  }
  if (from.backgroundedDuringRequest === true) out.backgroundedDuringRequest = true;
  return out;
}

/**
 * Request through MarshmallowHttp with true cancellation; abort disconnects
 * the socket instead of just ignoring the promise like CapacitorHttp does.
 */
async function marshmallowHttpRequest(plugin, {
  url,
  method,
  headers,
  data,
  connectTimeout,
  readTimeout,
  responseType,
  signal,
  requestId: suppliedRequestId,
  onRequestQueued,
}) {
  const requestId = suppliedRequestId || makeNativeRequestId();
  let backgroundedDuringRequest = typeof document !== 'undefined' && document.hidden;
  let queuedListenerHandle = null;
  let queuedNotified = false;
  const removeQueuedListener = () => {
    const handle = queuedListenerHandle;
    queuedListenerHandle = null;
    if (typeof handle?.remove !== 'function') return;
    try {
      Promise.resolve(handle.remove()).catch(() => {});
    } catch (_) {}
  };
  if (typeof onRequestQueued === 'function' && typeof plugin?.addListener === 'function') {
    try {
      // Capacitor listeners are registered asynchronously. Await registration so a fast
      // native queue acknowledgement cannot beat the listener immediately after request().
      queuedListenerHandle = await plugin.addListener('requestQueued', (event = {}) => {
        const queuedRequestId = String(event?.requestId || '').trim();
        if (queuedNotified || queuedRequestId !== requestId) return;
        queuedNotified = true;
        try {
          Promise.resolve(onRequestQueued(requestId, event)).catch(() => {});
        } catch (_) {}
        removeQueuedListener();
      });
    } catch (_) {
      // Old APKs do not emit requestQueued. The request still uses the established
      // promise/task polling path; only the stronger "native accepted" signal is absent.
      queuedListenerHandle = null;
    }
  }
  const abortNow = () => {
    plugin.abort({ requestId }).catch(() => {});
  };
  const noteVisibility = () => {
    if (document.hidden) backgroundedDuringRequest = true;
  };
  signal?.addEventListener?.('abort', abortNow, { once: true });
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', noteVisibility);
  try {
    const rawRequestPromise = plugin.request({
      requestId,
      url: String(url || '').trim(),
      method,
      headers,
      data,
      connectTimeoutMs: connectTimeout,
      readTimeoutMs: readTimeout,
      responseType: responseType || 'text',
    });
    // Android WebView may delay a long Capacitor promise callback after Java has
    // already persisted the complete body. Poll that durable task in parallel.
    // 新版原生插件会把二进制响应以 Base64 写入同一个任务正文；WebView 从后台
    // 恢复后也能轮询取回 Fish TTS / 图片，而不是依赖一次性的 bridge 回调。
    // 旧插件仍会报告 responseLength=0，readCompletedNativeRequest 会返回空数据，
    // 所以仅在持久化正文确实非空时让轮询结果赢过原始请求。
    const canRecoverFromTaskState = typeof plugin.getRequestState === 'function'
      && typeof plugin.readRequestChunk === 'function';
    const requestPromise = canRecoverFromTaskState
      ? rawRequestPromise.catch(async (error) => {
        const recovered = await recoverNativeRequestAfterBridgeFailure(plugin, requestId, signal);
        if (String(recovered?.data || '').length) return recovered;
        throw error;
      })
      : rawRequestPromise;
    const recoveredRequest = canRecoverFromTaskState
      ? pollNativeHttpRequest(plugin, requestId, signal).then((recovered) => (
        String(recovered?.data || '').length ? recovered : requestPromise
      )).catch(() => requestPromise)
      : null;
    const result = recoveredRequest
      ? await Promise.race([
        requestPromise,
        recoveredRequest,
      ])
      : await requestPromise;
    if (result && typeof result === 'object') {
      result.backgroundedDuringRequest = backgroundedDuringRequest;
      result.requestId = requestId;
    }
    return result;
  } catch (err) {
    if (err && typeof err === 'object') {
      err.backgroundedDuringRequest = backgroundedDuringRequest;
      err.nativeRequestId = requestId;
      err.nativeErrorCode = String(err.code || '');
      err.nativeErrorMessage = String(err.message || err || '原生网络请求失败');
      err.nativeTaskState = await inspectNativeRequestState(plugin, requestId);
    }
    if (signal?.aborted || /^aborted$/i.test(String(err?.message || '')) || String(err?.code || '') === 'ABORTED') {
      const abortErr = new Error('请求已取消');
      abortErr.name = 'AbortError';
      throw abortErr;
    }
    throw err;
  } finally {
    removeQueuedListener();
    signal?.removeEventListener?.('abort', abortNow);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', noteVisibility);
  }
}

/**
 * MarshmallowHttp keeps owning and persisting the socket, while Capacitor events
 * expose each decoded text chunk as a real fetch-compatible ReadableStream.
 * Old APKs that do not emit these events fall back to their completed response.
 */
async function marshmallowHttpStreamResponse(plugin, {
  url,
  headers,
  data,
  connectTimeout,
  readTimeout,
  signal,
  requestId: suppliedRequestId,
  onRequestQueued,
}) {
  if (typeof plugin?.addListener !== 'function' || typeof ReadableStream !== 'function') {
    const result = await marshmallowHttpRequest(plugin, {
      url,
      method: 'POST',
      headers,
      data,
      connectTimeout,
      readTimeout,
      responseType: 'text',
      signal,
      requestId: suppliedRequestId,
      onRequestQueued,
    });
    return toFetchResponse(result, url);
  }

  const requestId = suppliedRequestId || makeNativeRequestId();
  const encoder = new TextEncoder();
  const listenerHandles = [];
  let controller;
  let responseResolved = false;
  let streamEnded = false;
  let resolveResponse;
  let rejectResponse;
  const responsePromise = new Promise((resolve, reject) => {
    resolveResponse = resolve;
    rejectResponse = reject;
  });
  const stream = new ReadableStream({
    start(value) { controller = value; },
  });
  const removeListeners = () => {
    listenerHandles.splice(0).forEach((handle) => {
      try { Promise.resolve(handle?.remove?.()).catch(() => {}); } catch (_) {}
    });
  };
  const matches = (event) => String(event?.requestId || '').trim() === requestId;
  const resolveStarted = (event = {}) => {
    if (responseResolved) return;
    responseResolved = true;
    const rawStatus = Number(event?.status || 0);
    const status = rawStatus >= 200 && rawStatus <= 599 ? rawStatus : 200;
    const response = new Response(stream, {
      status,
      headers: normalizeHeaderMap(event?.headers),
    });
    response.nativeRequestId = requestId;
    resolveResponse(response);
  };
  const fail = (error) => {
    if (streamEnded) return;
    streamEnded = true;
    removeListeners();
    const err = error instanceof Error ? error : new Error(String(error || '原生流式请求失败'));
    err.nativeRequestId = requestId;
    if (!responseResolved) rejectResponse(err);
    else controller.error(err);
  };
  const finish = (event = {}) => {
    if (streamEnded) return;
    const state = String(event?.state || 'completed');
    if (state === 'failed' || state === 'aborted') {
      const err = new Error(String(event?.error || (state === 'aborted' ? '请求已取消' : '原生流式请求失败')));
      if (state === 'aborted') err.name = 'AbortError';
      fail(err);
      return;
    }
    resolveStarted(event);
    streamEnded = true;
    controller.close();
    removeListeners();
  };

  listenerHandles.push(await plugin.addListener('responseStarted', (event = {}) => {
    if (matches(event)) resolveStarted(event);
  }));
  listenerHandles.push(await plugin.addListener('responseChunk', (event = {}) => {
    if (!matches(event) || streamEnded) return;
    resolveStarted(event);
    const chunk = String(event?.data || '');
    if (chunk) controller.enqueue(encoder.encode(chunk));
  }));
  listenerHandles.push(await plugin.addListener('responseFinished', (event = {}) => {
    if (matches(event)) finish(event);
  }));

  let queuedHandle = null;
  if (typeof onRequestQueued === 'function') {
    queuedHandle = await plugin.addListener('requestQueued', (event = {}) => {
      if (!matches(event)) return;
      try { Promise.resolve(onRequestQueued(requestId, event)).catch(() => {}); } catch (_) {}
      try { Promise.resolve(queuedHandle?.remove?.()).catch(() => {}); } catch (_) {}
      queuedHandle = null;
    });
    listenerHandles.push(queuedHandle);
  }
  const abortNow = () => {
    plugin.abort({ requestId }).catch(() => {});
    fail(nativeAbortError());
  };
  signal?.addEventListener?.('abort', abortNow, { once: true });

  plugin.request({
    requestId,
    url: String(url || '').trim(),
    method: 'POST',
    headers,
    data,
    connectTimeoutMs: connectTimeout,
    readTimeoutMs: readTimeout,
    responseType: 'text',
    eventStream: true,
  }).then((result = {}) => {
    // Compatibility with an older installed APK: eventStream is ignored there,
    // so its one completed body becomes a single-chunk ReadableStream.
    if (streamEnded) return;
    resolveStarted(result);
    const fallbackBody = responseDataToText(result?.data);
    if (fallbackBody) controller.enqueue(encoder.encode(fallbackBody));
    finish(result);
  }).catch(fail).finally(() => {
    signal?.removeEventListener?.('abort', abortNow);
  });

  return responsePromise;
}

function isRetryableBackgroundDisconnect(err) {
  if (!err?.backgroundedDuringRequest) return false;
  return /Connection reset|ECONNRESET|Software caused connection abort|unexpected end of stream|socket closed|broken pipe/i
    .test(String(err?.message || err || ''));
}

function looksLikeSseBody(text = '') {
  return /^\s*(data|event)\s*:/m.test(String(text || ''));
}

function looksLikeCompleteJsonBody(text = '') {
  const value = String(text || '').trim();
  if (!value || (!value.startsWith('{') && !value.startsWith('['))) return false;
  try {
    JSON.parse(value);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Mid-read disconnect with a partial body. SSE partials flow back as a normal
 * Response so the stream parser salvages already-billed content; anything else
 * (truncated plain JSON) is useless downstream and surfaces as a raw disconnect
 * error — kept in English so the background-retry check still matches, callers
 * classify it into user-facing wording on give-up.
 */
function partialResultToError(result) {
  const err = new Error(String(result?.readError || 'Connection reset'));
  err.streamIncomplete = true;
  err.backgroundedDuringRequest = result?.backgroundedDuringRequest === true;
  return err;
}

function normalizeHeaderMap(headers = {}) {
  const out = {};
  if (!headers || typeof headers !== 'object') return out;
  Object.entries(headers).forEach(([key, value]) => {
    if (value == null || value === '') return;
    out[String(key)] = String(value);
  });
  return out;
}

function bodyToNativeData(body) {
  if (body == null) return undefined;
  if (typeof body === 'string') {
    try {
      return JSON.parse(body);
    } catch (_) {
      return body;
    }
  }
  return body;
}

function responseDataToText(data) {
  if (data == null) return '';
  if (typeof data === 'string') return data;
  if (typeof data === 'object') {
    try {
      return JSON.stringify(data);
    } catch (_) {
      return String(data);
    }
  }
  return String(data);
}

/** Map OkHttp/plugin errors to the same wording the web error guides key on. */
function classifyNativeHttpError(err, url = '') {
  const msg = String(err?.message || err || '');
  const host = (() => {
    try {
      return new URL(String(url || '')).host;
    } catch (_) {
      return String(url || '');
    }
  })();
  if (/UnknownHostException|Unable to resolve host|ERR_NAME_NOT_RESOLVED/i.test(msg)) {
    return new Error(`无法解析域名 ${host}（DNS 失败）。请检查网络，或该域名在当前网络被污染/屏蔽。`);
  }
  if (/SocketTimeout|timeout|timed out/i.test(msg)) {
    const e = new Error(`连接 ${host} 超时。可能是中转响应过慢或当前网络不通，可稍后重试或换线路。`);
    e.timeoutStage = 'native';
    return e;
  }
  if (/SSLHandshake|CertPath|TrustAnchor|certificate/i.test(msg)) {
    return new Error(`与 ${host} 的 HTTPS 握手失败（证书问题）。自签证书的局域网中转请改用 http://局域网IP 并更新到支持明文 HTTP 的 APK。`);
  }
  if (/CLEARTEXT|cleartext/i.test(msg)) {
    return new Error(`系统禁止访问明文 HTTP 地址 ${host}。请更新到放行局域网 http 的新版 APK，或改用 https 中转。`);
  }
  if (/Connection refused|ECONNREFUSED/i.test(msg)) {
    return new Error(`${host} 拒绝连接。局域网中转请确认服务已启动、端口正确，且填的是电脑的局域网 IP 而不是 localhost。`);
  }
  if (/Connection reset|ECONNRESET|Software caused connection abort|unexpected end of stream|socket closed|broken pipe/i.test(msg)) {
    const e = new Error(err?.backgroundedDuringRequest === true
      ? `与 ${host} 的连接在后台期间中途断开。可能是系统后台限网、VPN/网络切换、中转或上游提前关流；请回到前台重试。`
      : `与 ${host} 的连接中途断开。可能是中转或上游提前关流、VPN/网络切换，或当前网络不稳定；请重试或换线路。`);
    e.streamIncomplete = true;
    return e;
  }
  return err instanceof Error ? err : new Error(msg || '原生网络请求失败');
}

/**
 * CapacitorHttp resolves with status 0 when the request died before getting an
 * HTTP response; `new Response(_, { status: 0 })` would throw RangeError.
 */
function toFetchResponse(result, url = '') {
  const status = Number(result?.status) || 0;
  if (status < 200) {
    throw classifyNativeHttpError(
      new Error(String(result?.error || result?.data || `原生请求失败（status ${status}）`)),
      url,
    );
  }
  const text = responseDataToText(result?.data);
  const response = new Response(text, {
    status,
    statusText: String(status),
    headers: normalizeHeaderMap(result?.headers || {}),
  });
  if (result?.requestId) response.nativeRequestId = result.requestId;
  return response;
}

/**
 * APK 内任意文本/JSON HTTP 请求，返回与 fetch 兼容的 Response。
 * 主要给 GitHub 等需要 GET / PUT / DELETE 的 API 使用；二进制下载继续走专用字节接口。
 */
export async function nativeHttpRequest(url, options = {}) {
  const cancellable = marshmallowHttpPlugin();
  const plugin = capacitorHttpPlugin();
  if (!cancellable && !plugin?.request) {
    throw new Error('原生 HTTP 不可用（CapacitorHttp 未加载）');
  }
  const signal = options.signal;
  if (signal?.aborted) throw nativeAbortError();
  const method = String(options.method || 'GET').trim().toUpperCase() || 'GET';
  const headers = normalizeHeaderMap(options.headers);
  const connectTimeout = Number(options.connectTimeout) > 0 ? Number(options.connectTimeout) : 60_000;
  const readTimeout = Number(options.readTimeout) > 0 ? Number(options.readTimeout) : 120_000;
  const hasBody = options.body != null && method !== 'GET' && method !== 'HEAD';
  const body = hasBody
    ? (typeof options.body === 'string' ? options.body : JSON.stringify(options.body))
    : undefined;

  try {
    const result = cancellable
      ? await marshmallowHttpRequest(cancellable, {
        url,
        method,
        headers,
        data: body,
        connectTimeout,
        readTimeout,
        responseType: 'text',
        signal,
        requestId: options.requestId,
      })
      : await plugin.request({
        url: String(url || '').trim(),
        method,
        headers,
        data: hasBody ? bodyToNativeData(body) : undefined,
        connectTimeout,
        readTimeout,
        responseType: 'text',
      });
    if (result?.partial === true && !looksLikeCompleteJsonBody(responseDataToText(result?.data))) {
      throw partialResultToError(result);
    }
    if (signal?.aborted) throw nativeAbortError();
    return toFetchResponse(result, url);
  } catch (err) {
    if (signal?.aborted || err?.name === 'AbortError') throw nativeAbortError();
    throw attachNativeFailureEvidence(classifyNativeHttpError(err, url), err);
  }
}

/**
 * POST JSON via CapacitorHttp and return a fetch-compatible Response.
 * @param {string} url
 * @param {{ headers?: Record<string,string>, body?: any, signal?: AbortSignal, connectTimeout?: number, readTimeout?: number, onRequestQueued?: (requestId: string, event: object) => void }} options
 */
export async function nativeHttpPostJson(url, options = {}) {
  const cancellable = marshmallowHttpPlugin();
  const plugin = capacitorHttpPlugin();
  if (!cancellable && !plugin?.request) {
    throw new Error('原生 HTTP 不可用（CapacitorHttp 未加载）');
  }
  const signal = options.signal;
  if (signal?.aborted) {
    const err = new Error('请求已取消');
    err.name = 'AbortError';
    throw err;
  }

  const headers = normalizeHeaderMap(options.headers);
  if (!headers['Content-Type'] && !headers['content-type']) {
    headers['Content-Type'] = 'application/json';
  }

  const connectTimeout = Number(options.connectTimeout) > 0 ? Number(options.connectTimeout) : 120_000;
  // LLM completions can take several minutes on slow relays.
  const readTimeout = Number(options.readTimeout) > 0 ? Number(options.readTimeout) : 600_000;

  if (cancellable) {
    const data = typeof options.body === 'string' ? options.body : JSON.stringify(options.body ?? {});
    if (options.streamResponse === true) {
      try {
        return await marshmallowHttpStreamResponse(cancellable, {
          url,
          headers,
          data,
          connectTimeout,
          readTimeout,
          signal,
          requestId: options.requestId,
          onRequestQueued: options.onRequestQueued,
        });
      } catch (err) {
        if (err?.name === 'AbortError') throw err;
        throw attachNativeFailureEvidence(classifyNativeHttpError(err, url), err);
      }
    }
    const maxAttempts = options.retryOnBackgroundDisconnect === true ? 2 : 1;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const result = await marshmallowHttpRequest(cancellable, {
          url,
          method: 'POST',
          headers,
          data,
          connectTimeout,
          readTimeout,
          signal,
          requestId: options.requestId,
          onRequestQueued: options.onRequestQueued,
        });
        if (
          result?.partial === true
          && Number(result?.status || 0) < 400
          && !looksLikeSseBody(responseDataToText(result?.data))
          && !looksLikeCompleteJsonBody(responseDataToText(result?.data))
        ) {
          throw partialResultToError(result);
        }
        return toFetchResponse(result, url);
      } catch (err) {
        if (err?.name === 'AbortError') throw err;
        if (attempt + 1 < maxAttempts && isRetryableBackgroundDisconnect(err) && !signal?.aborted) continue;
        throw attachNativeFailureEvidence(classifyNativeHttpError(err, url), err);
      }
    }
  }

  let aborted = false;
  const onAbort = () => { aborted = true; };
  try {
    signal?.addEventListener?.('abort', onAbort, { once: true });
    const result = await plugin.request({
      url: String(url || '').trim(),
      method: 'POST',
      headers,
      data: bodyToNativeData(options.body),
      connectTimeout,
      readTimeout,
      responseType: 'text',
    });
    if (aborted || signal?.aborted) {
      const err = new Error('请求已取消');
      err.name = 'AbortError';
      throw err;
    }
    return toFetchResponse(result, url);
  } catch (err) {
    if (aborted || signal?.aborted || err?.name === 'AbortError') {
      const abortErr = new Error('请求已取消');
      abortErr.name = 'AbortError';
      throw abortErr;
    }
    throw classifyNativeHttpError(err, url);
  } finally {
    signal?.removeEventListener?.('abort', onAbort);
  }
}

/**
 * GET via CapacitorHttp → fetch-compatible Response.
 */
export async function nativeHttpGet(url, options = {}) {
  const cancellable = marshmallowHttpPlugin();
  const plugin = capacitorHttpPlugin();
  if (!cancellable && !plugin?.request) {
    throw new Error('原生 HTTP 不可用（CapacitorHttp 未加载）');
  }
  const signal = options.signal;
  if (signal?.aborted) {
    const err = new Error('请求已取消');
    err.name = 'AbortError';
    throw err;
  }
  try {
    const connectTimeout = Number(options.connectTimeout) > 0 ? Number(options.connectTimeout) : 60_000;
    const readTimeout = Number(options.readTimeout) > 0 ? Number(options.readTimeout) : 120_000;
    const headers = normalizeHeaderMap(options.headers);
    const result = cancellable
      ? await marshmallowHttpRequest(cancellable, {
        url,
        method: 'GET',
        headers,
        data: undefined,
        connectTimeout,
        readTimeout,
        signal,
        requestId: options.requestId,
      })
      : await plugin.request({
        url: String(url || '').trim(),
        method: 'GET',
        headers,
        connectTimeout,
        readTimeout,
        responseType: 'text',
      });
    if (
      result?.partial === true
      && !looksLikeCompleteJsonBody(responseDataToText(result?.data))
    ) {
      throw partialResultToError(result);
    }
    if (signal?.aborted) {
      const err = new Error('请求已取消');
      err.name = 'AbortError';
      throw err;
    }
    return toFetchResponse(result, url);
  } catch (err) {
    if (signal?.aborted || err?.name === 'AbortError') {
      const abortErr = new Error('请求已取消');
      abortErr.name = 'AbortError';
      throw abortErr;
    }
    throw classifyNativeHttpError(err, url);
  }
}

function utf8ToBytes(value = '') {
  const text = String(value ?? '');
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text);
  const encoded = unescape(encodeURIComponent(text));
  const bytes = new Uint8Array(encoded.length);
  for (let i = 0; i < encoded.length; i += 1) bytes[i] = encoded.charCodeAt(i);
  return bytes;
}

function decodeBase64Bytes(value = '') {
  let raw = String(value ?? '').trim();
  const dataUrl = raw.match(/^data:([^,]*),([\s\S]*)$/i);
  if (dataUrl) {
    if (!/;base64(?:;|$)/i.test(dataUrl[1])) return null;
    raw = dataUrl[2];
  }
  raw = raw.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (!raw) return new Uint8Array();
  if (/[^A-Za-z0-9+/=]/.test(raw) || /=/.test(raw.slice(0, -2))) return null;
  const unpadded = raw.replace(/=+$/, '');
  if (unpadded.length % 4 === 1) return null;
  const padded = unpadded + '='.repeat((4 - (unpadded.length % 4)) % 4);
  let binary = '';
  try {
    binary = atob(padded);
  } catch (_) {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** 原生桥成功响应必须是二进制/Base64；错误响应允许保留 UTF-8 JSON/文字供业务层展示。 */
export function decodeNativeBinaryResponse(data, { status = 200 } = {}) {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (Array.isArray(data) && data.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)) {
    return Uint8Array.from(data);
  }
  if (data && typeof data === 'object') {
    if (data.type === 'Buffer' && Array.isArray(data.data)) {
      return decodeNativeBinaryResponse(data.data, { status });
    }
    if (typeof data.base64 === 'string') {
      const decoded = decodeBase64Bytes(data.base64);
      if (decoded) return decoded;
    }
    if (Number(status) >= 400) return utf8ToBytes(JSON.stringify(data));
    throw new Error('原生二进制响应格式异常：返回了对象而不是音频字节；请更新 APK 后重试。');
  }

  const raw = String(data ?? '');
  const decoded = decodeBase64Bytes(raw);
  if (decoded) return decoded;
  if (Number(status) >= 400) return utf8ToBytes(raw);
  throw new Error('原生音频响应不是有效 Base64；请更新 APK 后重试。');
}

/**
 * 通过原生 HTTP POST JSON 并读取二进制响应。
 * HTTP 4xx/5xx 也返回响应字节，让业务层能解析服务端的 JSON 报错；
 * 只有 DNS、证书、断网、超时等真正的传输错误会在这里抛出。
 */
export async function nativeHttpPostJsonBytes(url, options = {}) {
  const cancellable = marshmallowHttpPlugin();
  const plugin = capacitorHttpPlugin();
  if (!isNativeAppShell() || (!cancellable && typeof plugin?.request !== 'function')) {
    throw new Error('原生二进制 HTTP 不可用（原生 HTTP 插件未加载）');
  }
  const signal = options.signal;
  if (signal?.aborted) {
    const err = new Error('请求已取消');
    err.name = 'AbortError';
    throw err;
  }

  try {
    const connectTimeout = Number(options.connectTimeout) > 0 ? Number(options.connectTimeout) : 120_000;
    const readTimeout = Number(options.readTimeout) > 0 ? Number(options.readTimeout) : 300_000;
    const headers = normalizeHeaderMap(options.headers);
    if (!headers['Content-Type'] && !headers['content-type']) {
      headers['Content-Type'] = 'application/json';
    }
    const result = cancellable
      ? await marshmallowHttpRequest(cancellable, {
        url,
        method: 'POST',
        headers,
        data: typeof options.body === 'string'
          ? options.body
          : JSON.stringify(options.body ?? {}),
        connectTimeout,
        readTimeout,
        responseType: 'arraybuffer',
        signal,
        requestId: options.requestId,
      })
      : await plugin.request({
        url: String(url || '').trim(),
        method: 'POST',
        headers,
        data: bodyToNativeData(options.body),
        connectTimeout,
        readTimeout,
        responseType: 'arraybuffer',
      });
    if (signal?.aborted) {
      const err = new Error('请求已取消');
      err.name = 'AbortError';
      throw err;
    }
    const status = Number(result?.status) || 0;
    if (status < 100) {
      throw new Error(String(result?.error || `原生请求失败（status ${status}）`));
    }
    return {
      bytes: decodeNativeBinaryResponse(result?.data, { status }),
      status,
      headers: normalizeHeaderMap(result?.headers || {}),
    };
  } catch (err) {
    if (signal?.aborted || err?.name === 'AbortError') {
      const abortErr = new Error('请求已取消');
      abortErr.name = 'AbortError';
      throw abortErr;
    }
    throw classifyNativeHttpError(err, url);
  }
}

/**
 * 通过原生 HTTP 读取二进制响应。原生桥会把 arraybuffer 编码为 base64；
 * MarshmallowHttp 的二进制分支同样保持字节安全，并可从原生任务缓存恢复。
 */
export async function nativeHttpGetBytes(url, options = {}) {
  const cancellable = marshmallowHttpPlugin();
  const plugin = capacitorHttpPlugin();
  if (!isNativeAppShell() || (!cancellable && typeof plugin?.request !== 'function')) {
    throw new Error('原生二进制 HTTP 不可用（原生 HTTP 插件未加载）');
  }
  const signal = options.signal;
  if (signal?.aborted) {
    const err = new Error('请求已取消');
    err.name = 'AbortError';
    throw err;
  }

  try {
    const connectTimeout = Number(options.connectTimeout) > 0 ? Number(options.connectTimeout) : 60_000;
    const readTimeout = Number(options.readTimeout) > 0 ? Number(options.readTimeout) : 120_000;
    const headers = normalizeHeaderMap(options.headers);
    const result = cancellable
      ? await marshmallowHttpRequest(cancellable, {
        url,
        method: 'GET',
        headers,
        data: undefined,
        connectTimeout,
        readTimeout,
        responseType: 'arraybuffer',
        signal,
        requestId: options.requestId,
      })
      : await plugin.request({
        url: String(url || '').trim(),
        method: 'GET',
        headers,
        connectTimeout,
        readTimeout,
        responseType: 'arraybuffer',
      });
    if (signal?.aborted) {
      const err = new Error('请求已取消');
      err.name = 'AbortError';
      throw err;
    }
    const status = Number(result?.status) || 0;
    if (status < 200 || status >= 300) {
      const err = new Error(`原生图片下载失败（HTTP ${status || 0}）`);
      err.status = status;
      err.httpStatus = status;
      throw err;
    }
    const bytes = decodeNativeBinaryResponse(result?.data, { status });
    return {
      bytes,
      status,
      headers: normalizeHeaderMap(result?.headers || {}),
    };
  } catch (err) {
    if (signal?.aborted || err?.name === 'AbortError') {
      const abortErr = new Error('请求已取消');
      abortErr.name = 'AbortError';
      throw abortErr;
    }
    if (err?.httpStatus) throw err;
    throw classifyNativeHttpError(err, url);
  }
}

export async function getNativeHttpRequestState(requestId) {
  const plugin = marshmallowHttpPlugin();
  if (typeof plugin?.getRequestState !== 'function') return null;
  try {
    return await plugin.getRequestState({ requestId: String(requestId || '') });
  } catch (_) {
    return null;
  }
}

export async function readNativeHttpRequestChunk(requestId, offset = 0, maxChars = 64 * 1024) {
  const plugin = marshmallowHttpPlugin();
  if (typeof plugin?.readRequestChunk !== 'function') return null;
  return plugin.readRequestChunk({
    requestId: String(requestId || ''),
    offset: Math.max(0, Number(offset) || 0),
    maxChars: Math.max(1, Number(maxChars) || 64 * 1024),
  });
}

export async function listNativeHttpRequestStates(limit = 20) {
  const plugin = marshmallowHttpPlugin();
  if (typeof plugin?.listRequestStates !== 'function') return [];
  try {
    const result = await plugin.listRequestStates({ limit: Math.max(1, Number(limit) || 20) });
    return Array.isArray(result?.requests) ? result.requests : [];
  } catch (_) {
    return [];
  }
}

export async function removeNativeHttpRequestState(requestId) {
  const plugin = marshmallowHttpPlugin();
  if (typeof plugin?.removeRequestState !== 'function') return { ok: false, reason: 'unsupported' };
  return plugin.removeRequestState({ requestId: String(requestId || '') });
}
