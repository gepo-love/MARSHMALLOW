import * as db from './db.js';
import { isNativeAppShell } from './native-http.js';
import {
  diagnosticFromError,
  normalizeDiagnosticEnvelope,
  sanitizeDiagnosticValue,
  stripRouteDetails,
} from './support/diagnostic-envelope.js';

const DEBUG_LOG_KEY = 'debugLogEvents';
const API_STAT_KEY = 'apiRequestStats';
const MAX_EVENTS = 100;
const MAX_API_STATS = 300;
const TEXT_HEAD = 1800;
const TEXT_TAIL = 900;
let installed = false;

function nowIso() {
  try {
    return new Date().toISOString();
  } catch (_) {
    return String(Date.now());
  }
}

function makeId() {
  return `dbg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function safeString(value = '') {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message || String(value);
  try {
    return JSON.stringify(value);
  } catch (_) {
    return String(value);
  }
}

export function redactSensitiveText(value = '') {
  return safeString(value)
    .replace(/Bearer\s+[-._~+/=A-Za-z0-9]+/g, 'Bearer [REDACTED]')
    .replace(/("(?:apiKey|api_key|authorization|Authorization)"\s*:\s*")([^"]+)(")/g, '$1[REDACTED]$3')
    .replace(/((?:apiKey|api_key|authorization|Authorization)\s*[:=]\s*)([^\s,;]+)/g, '$1[REDACTED]')
    .replace(/\b(sk|pk|ak)-[A-Za-z0-9_\-.]{16,}\b/g, '$1-[REDACTED]');
}

function compactText(value = '', head = TEXT_HEAD, tail = TEXT_TAIL) {
  const text = redactSensitiveText(value);
  if (text.length <= head + tail + 120) return text;
  return `${text.slice(0, head)}\n\n...[截断 ${text.length - head - tail} 字]...\n\n${text.slice(-tail)}`;
}

function normalizeEvent(input = {}) {
  const err = input.error instanceof Error ? input.error : null;
  const message = input.message || err?.message || input.error || '';
  const context = input.context && typeof input.context === 'object' ? input.context : {};
  const raw = input.raw ?? input.responseText ?? context.responseText ?? '';
  const prompt = input.prompt ?? context.prompt ?? '';
  const stack = input.stack || err?.stack || '';
  return {
    id: input.id || makeId(),
    timestamp: Number(input.timestamp || Date.now()) || Date.now(),
    isoTime: input.isoTime || nowIso(),
    type: String(input.type || 'event'),
    level: String(input.level || (String(input.type || '').includes('error') ? 'error' : 'info')),
    route: input.route || (typeof location !== 'undefined' ? location.hash || location.pathname : ''),
    pageUrl: input.pageUrl || (typeof location !== 'undefined' ? location.href : ''),
    userAgent: input.userAgent || (typeof navigator !== 'undefined' ? navigator.userAgent : ''),
    message: compactText(message, 800, 400),
    stack: compactText(stack, 1200, 500),
    usedUrl: String(input.usedUrl || context.usedUrl || ''),
    correlationId: String(input.correlationId || context.correlationId || ''),
    errorKind: String(input.errorKind || context.errorKind || ''),
    durationMs: input.durationMs ?? context.durationMs ?? null,
    ttfbMs: input.ttfbMs ?? context.ttfbMs ?? null,
    status: input.status ?? context.status ?? null,
    finishReason: String(input.finishReason || context.finishReason || ''),
    reasoningLength: Number(input.reasoningLength ?? context.reasoningLength ?? 0) || 0,
    model: String(input.model || input.requestModel || context.requestModel || context.model || ''),
    stream: input.stream ?? input.requestStream ?? context.requestStream ?? null,
    raw: compactText(raw),
    prompt: compactText(prompt, 1200, 600),
    context: sanitizeContext(context),
  };
}

function sanitizeContext(context = {}) {
  const out = {};
  for (const [key, value] of Object.entries(context || {})) {
    if (/apiKey|authorization|token|secret|password/i.test(key)) {
      out[key] = '[REDACTED]';
      continue;
    }
    if (typeof value === 'string') out[key] = compactText(value, 900, 400);
    else if (value == null || typeof value === 'number' || typeof value === 'boolean') out[key] = value;
    else {
      try {
        out[key] = JSON.parse(redactSensitiveText(JSON.stringify(value)));
      } catch (_) {
        out[key] = compactText(value, 900, 400);
      }
    }
  }
  return out;
}

async function readStoredEvents() {
  const saved = await db.get('settings', DEBUG_LOG_KEY).catch(() => null);
  const list = Array.isArray(saved?.value) ? saved.value : [];
  return list.filter(Boolean);
}

export function makeCorrelationId() {
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Unified error taxonomy so debug log, error guide and stats agree on
 * "who broke it": upstream, network, client timeout or user action.
 */
export function classifyErrorKind(err, context = {}) {
  if (!err && !context.errorKind) return '';
  if (context.errorKind) return String(context.errorKind);
  const name = String(err?.name || '');
  const msg = String(err?.message || err || '');
  if (name === 'AbortError' || /请求已取消|abort/i.test(msg)) {
    if (context.abortReason === 'watchdog') return 'watchdog_abort';
    if (context.abortReason === 'timeout') return 'client_timeout';
    return 'user_abort';
  }
  if (err?.timeoutStage) return 'client_timeout';
  const status = Number(err?.status ?? context.status ?? 0);
  if (status >= 400) return 'http_status';
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'offline';
  if (err?.code === 'opaque_network_error' || err?.networkFailure === 'opaque') return 'network';
  if (/CORS|浏览器拦截|WebView 拦截/i.test(msg)) return 'cors';
  if (/ERR_NAME_NOT_RESOLVED|DNS|getaddrinfo|UnknownHostException/i.test(msg)) return 'dns';
  if (err?.streamIncomplete === true) return 'sse_disconnect';
  if (/HTTP2|protocol error|连接在返回阶段断开|连接在返回中途断开|流式连接提前结束|网络连接中断|ERR_HTTP2/i.test(msg)) return 'sse_disconnect';
  if (/Gateway Timeout|API错误 \(504\)|API错误 \(524\)|timed?\s*out|SocketTimeout/i.test(msg)) return 'upstream_timeout';
  if (/Failed to fetch|NetworkError|Load failed|ERR_FAILED|network error/i.test(msg)) return 'network';
  if (/不是合法 JSON|网页而非 JSON/i.test(msg)) return 'json_parse';
  return 'exception';
}

async function readStoredApiStats() {
  const saved = await db.get('settings', API_STAT_KEY).catch(() => null);
  const list = Array.isArray(saved?.value) ? saved.value : [];
  return list.filter(Boolean);
}

/**
 * Lightweight per-request stats ring buffer, separate from the error log so
 * routine info records never crowd out real errors. Used by feedback bundle
 * and the API probe page to answer "slow where: local build, TTFB or upstream".
 */
export async function recordApiRequestStat(stat = {}) {
  const audit = stat.audit && typeof stat.audit === 'object' ? stat.audit : {};
  const actorIds = Array.isArray(audit.actorIds)
    ? audit.actorIds.map((id) => String(id || '').trim()).filter(Boolean).slice(0, 24)
    : [];
  const actorNames = Array.isArray(audit.actorNames)
    ? audit.actorNames.map((name) => String(name || '').trim()).filter(Boolean).slice(0, 24)
    : [];
  const entry = {
    correlationId: String(stat.correlationId || makeCorrelationId()),
    at: Number(stat.at || Date.now()) || Date.now(),
    usedUrl: String(stat.usedUrl || ''),
    model: String(stat.model || ''),
    requestStream: stat.requestStream ?? null,
    responseStream: stat.responseStream ?? stat.requestStream ?? null,
    viaGenerationRelay: stat.viaGenerationRelay === true,
    viaNativeHttp: stat.viaNativeHttp === true,
    nativeHttpTransport: String(stat.nativeHttpTransport || ''),
    viaProxyFallback: stat.viaProxyFallback === true,
    status: stat.status ?? null,
    durationMs: Number.isFinite(Number(stat.durationMs)) ? Math.round(Number(stat.durationMs)) : null,
    ttfbMs: Number.isFinite(Number(stat.ttfbMs)) ? Math.round(Number(stat.ttfbMs)) : null,
    buildMs: Number.isFinite(Number(stat.buildMs)) ? Math.round(Number(stat.buildMs)) : null,
    chunkCount: Number(stat.chunkCount || 0) || 0,
    byteCount: Number(stat.byteCount || 0) || 0,
    badSseLines: Number(stat.badSseLines || 0) || 0,
    sawDone: stat.sawDone ?? null,
    finishReason: String(stat.finishReason || ''),
    contentLength: Number(stat.contentLength || 0) || 0,
    reasoningLength: Number(stat.reasoningLength || 0) || 0,
    ok: stat.ok !== false,
    errorKind: String(stat.errorKind || ''),
    errorMessage: stat.errorMessage ? compactText(stat.errorMessage, 300, 0) : '',
    audit: {
      apiSection: String(audit.apiSection || ''),
      operation: String(audit.operation || ''),
      trigger: String(audit.trigger || ''),
      initiator: String(audit.initiator || ''),
      chatId: String(audit.chatId || ''),
      logicalRoundId: String(audit.logicalRoundId || ''),
      proactiveChannel: String(audit.proactiveChannel || ''),
      fallbackFrom: String(audit.fallbackFrom || ''),
      actorIds,
      actorNames,
    },
  };
  try {
    const list = await readStoredApiStats();
    list.push(entry);
    await db.put('settings', { key: API_STAT_KEY, value: list.slice(-MAX_API_STATS) });
  } catch (err) {
    console.warn('[debug-log] api stat append failed:', err);
  }
  return entry;
}

export async function listApiRequestStats(limit = MAX_API_STATS) {
  const n = Math.max(1, Math.min(MAX_API_STATS, Number(limit || MAX_API_STATS) || MAX_API_STATS));
  const list = await readStoredApiStats();
  return list.slice(-n).reverse();
}

export async function appendDebugEvent(input = {}) {
  const event = normalizeEvent(input);
  try {
    const list = await readStoredEvents();
    list.push(event);
    const next = list.slice(-MAX_EVENTS);
    await db.put('settings', { key: DEBUG_LOG_KEY, value: next });
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('marshmallow-debug-log-updated', { detail: { event } }));
    }
  } catch (err) {
    console.warn('[debug-log] append failed:', err);
  }
  return event;
}

export async function listDebugEvents(limit = MAX_EVENTS) {
  const n = Math.max(1, Math.min(MAX_EVENTS, Number(limit || MAX_EVENTS) || MAX_EVENTS));
  const list = await readStoredEvents();
  return list.slice(-n).reverse();
}

export async function clearDebugEvents() {
  await db.put('settings', { key: DEBUG_LOG_KEY, value: [] });
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('marshmallow-debug-log-updated', { detail: { cleared: true } }));
  }
}

function summarizeApiConfigForFeedback(value = {}) {
  const host = (() => {
    try {
      return value?.baseUrl ? new URL(String(value.baseUrl)).host : '';
    } catch (_) {
      return '[invalid-url]';
    }
  })();
  return {
    baseUrlHost: host,
    hasApiKey: !!value?.apiKey,
    model: String(value?.model || ''),
    maxTokens: value?.maxTokens ?? null,
    preferStream: value?.preferStream !== false,
    retryOnFailure: false,
    endpointType: String(value?.endpointType || ''),
  };
}

function slimEventForFeedback(event = {}) {
  const diagnostic = event?.context?.diagnostic && typeof event.context.diagnostic === 'object'
    ? event.context.diagnostic
    : {};
  return {
    id: event.id,
    timestamp: event.timestamp,
    isoTime: event.isoTime,
    type: event.type,
    level: event.level,
    message: event.message,
    errorKind: event.errorKind || '',
    status: event.status ?? null,
    durationMs: event.durationMs ?? null,
    model: event.model || '',
    correlationId: event.correlationId || '',
    incidentId: diagnostic.incidentId || '',
    route: stripRouteDetails(event.route || ''),
    context: sanitizeDiagnosticValue(event.context || {}),
    ...(event.stack ? { stack: compactText(event.stack, 500, 0) } : {}),
  };
}

function buildFeedbackHighlights(events = []) {
  const interesting = (Array.isArray(events) ? events : []).filter((event) => (
    event
    && (
      event.level === 'warn'
      || event.level === 'error'
      || /partially_rejected|peer_private|social_boundary|persist_skipped|validation|parse_/i.test(String(event.type || ''))
    )
  )).slice(0, 20);
  return interesting.map((event) => ({
    type: event.type,
    time: event.isoTime || event.timestamp,
    message: event.message,
    rejected: event?.context?.rejected || null,
    context: event?.context && Object.keys(event.context).length
      ? {
        validCount: event.context.validCount,
        rejectedCount: Array.isArray(event.context.rejected) ? event.context.rejected.length : undefined,
        reason: event.context.reason || event.context.errorKind || '',
      }
      : null,
  }));
}

export async function buildFeedbackBundle({ diagnostic = null } = {}) {
  const events = await listDebugEvents(MAX_EVENTS);
  const eligibleEvents = (events || []).filter((event) => (
    event?.level === 'error'
    || /api|network|http|stream|error|storage|indexeddb|backup|permission|native|service.?worker|route|render/i.test(String(event?.type || ''))
  ));
  const target = diagnostic && typeof diagnostic === 'object' ? diagnostic : null;
  const incidentBound = target?.evidence?.incidentOrigin === 'generation-error';
  const withinIncidentWindow = (at) => (
    !!target?.at && Math.abs(Number(at || 0) - Number(target.at)) <= 5 * 60 * 1000
  );
  const safeEvents = (incidentBound ? eligibleEvents.filter((event) => {
    const eventDiagnostic = event?.context?.diagnostic || {};
    if (target.correlationId && event.correlationId === target.correlationId) return true;
    if (target.incidentId && eventDiagnostic.incidentId === target.incidentId) return true;
    return withinIncidentWindow(event.timestamp)
      && (!target.route || stripRouteDetails(event.route || '') === stripRouteDetails(target.route));
  }) : []).slice(0, 30);
  const allApiStats = await listApiRequestStats(MAX_API_STATS).catch(() => []);
  const apiStats = (incidentBound ? allApiStats.filter((stat) => (
    (target.correlationId && stat.correlationId === target.correlationId)
    || withinIncidentWindow(stat.at)
  )) : []);
  const apiConfig = await db.get('settings', 'apiConfig').catch(() => null);
  const isNative = isNativeAppShell();
  const highlights = buildFeedbackHighlights(safeEvents);
  const meta = {
    exportedAt: nowIso(),
    route: typeof location !== 'undefined' ? stripRouteDetails(location.hash || location.pathname) : '',
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
    online: typeof navigator !== 'undefined' ? navigator.onLine !== false : null,
    nativeShell: isNative,
    runtime: sanitizeDiagnosticValue(target?.runtime || {}),
    build: typeof window !== 'undefined' ? String(window.__MARSHMALLOW_BUILD__ || '') : '',
    viewport: typeof window !== 'undefined' ? {
      width: window.innerWidth,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio || 1,
    } : null,
    bootOk: typeof window !== 'undefined' ? !!window.__MARSHMALLOW_BOOT_OK : false,
    bootFailed: typeof window !== 'undefined' ? !!window.__MARSHMALLOW_BOOT_FAILED : false,
    apiConfig: summarizeApiConfigForFeedback(apiConfig?.value || {}),
  };
  // highlights 放最前：拒因/校验失败别被超长 apiStats、raw 挤出剪贴板。
  return JSON.stringify({
    highlights,
    meta,
    apiStats: (apiStats || []).slice(0, 20),
    events: safeEvents.map(slimEventForFeedback),
    latestDiagnostic: target ? normalizeDiagnosticEnvelope(target) : (safeEvents[0] ? normalizeDiagnosticEnvelope({
      code: safeEvents[0].errorKind || safeEvents[0].type,
      source: '',
      severity: safeEvents[0].level === 'error' ? 'error' : 'warning',
      scope: safeEvents[0].type || '应用',
      message: safeEvents[0].message,
      status: safeEvents[0].status,
      correlationId: safeEvents[0].correlationId,
      route: safeEvents[0].route,
      timestamp: safeEvents[0].timestamp,
      evidence: {
        durationMs: safeEvents[0].durationMs,
        model: safeEvents[0].model,
      },
    }) : null),
  }, null, 2);
}

export function recordApiError(err, context = {}) {
  const diagnostic = diagnosticFromError(err, {
    code: classifyErrorKind(err, context),
    source: 'api',
    scope: context.scope || 'API 请求',
    status: err?.status ?? context.status ?? null,
    correlationId: err?.correlationId || context.correlationId || '',
    route: typeof location !== 'undefined' ? location.hash || location.pathname : '',
    evidence: {
      durationMs: context.durationMs ?? null,
      requestModel: err?.requestModel || context.requestModel || '',
      requestStream: err?.requestStream ?? context.requestStream ?? null,
      requestMethod: err?.requestMethod || context.requestMethod || '',
      requestPath: err?.requestPath || context.requestPath || '',
    },
  });
  return appendDebugEvent({
    type: 'api_error',
    level: 'error',
    message: err?.message || err,
    stack: err?.stack || '',
    usedUrl: err?.usedUrl || context.usedUrl || '',
    status: err?.status ?? context.status ?? null,
    correlationId: err?.correlationId || context.correlationId || '',
    errorKind: classifyErrorKind(err, context),
    durationMs: context.durationMs ?? null,
    requestModel: err?.requestModel || context.requestModel || '',
    requestStream: err?.requestStream ?? context.requestStream ?? null,
    responseText: err?.responseText || context.responseText || '',
    prompt: context.prompt || '',
    context: { ...context, diagnostic },
  });
}

export function installGlobalDebugHandlers() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('error', (ev) => {
    appendDebugEvent({
      type: 'js_error',
      level: 'error',
      message: ev.message || ev.error?.message || 'JavaScript error',
      stack: ev.error?.stack || '',
      context: {
        filename: ev.filename || '',
        lineno: ev.lineno || 0,
        colno: ev.colno || 0,
        diagnostic: diagnosticFromError(ev.error || new Error(ev.message || 'JavaScript error'), {
          code: 'js_error',
          source: 'page',
          scope: '页面运行',
          route: location.hash || location.pathname,
        }),
      },
    });
  });
  window.addEventListener('unhandledrejection', (ev) => {
    const reason = ev.reason;
    appendDebugEvent({
      type: 'unhandledrejection',
      level: 'error',
      message: reason?.message || reason || 'Unhandled promise rejection',
      stack: reason?.stack || '',
      responseText: reason?.responseText || '',
      usedUrl: reason?.usedUrl || '',
      status: reason?.status ?? null,
      requestModel: reason?.requestModel || '',
      requestStream: reason?.requestStream ?? null,
      context: {
        diagnostic: diagnosticFromError(reason, {
          code: reason?.code || 'unhandledrejection',
          source: reason?.status ? 'api' : 'page',
          scope: '异步任务',
          route: location.hash || location.pathname,
        }),
      },
    });
  });
}
