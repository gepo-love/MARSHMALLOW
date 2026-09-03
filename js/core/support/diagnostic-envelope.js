const SOURCE_VALUES = new Set([
  'api',
  'protocol',
  'network',
  'page',
  'storage',
  'backup',
  'permission',
  'native',
  'service-worker',
  'unknown',
]);

const SEVERITY_VALUES = new Set(['info', 'warning', 'error', 'critical']);
const ROUTE_LABELS = Object.freeze({
  home: '主屏',
  settings: '设置',
  'settings/api': 'API 管理',
  'settings/debug-log': '错误日志',
  chat: '聊天',
  'chat/thread': '聊天详情',
  contacts: '通讯录',
  moments: '朋友圈',
  forum: '论坛',
  music: '音乐',
  support: '芥末棉花糖',
  'generation-error': '报错详情',
  tutorial: '使用教程',
});

const SECRET_KEY_PATTERN = /api[_-]?key|authorization|token|secret|password|cookie|credential/i;
function text(value = '', max = 1200) {
  let output = String(value ?? '');
  output = output
    .replace(/Bearer\s+[-._~+/=A-Za-z0-9]+/gi, 'Bearer [REDACTED]')
    .replace(/("(?:apiKey|api_key|authorization|token|secret|password)"\s*:\s*")([^"]+)(")/gi, '$1[REDACTED]$3')
    .replace(/((?:apiKey|api_key|authorization|token|secret|password)\s*[:=]\s*)([^\s,;]+)/gi, '$1[REDACTED]')
    .replace(/\b(?:sk|pk|ak|cursor)_[A-Za-z0-9_.-]{12,}\b/gi, '[REDACTED]')
    .replace(/\b(?:sk|pk|ak)-[A-Za-z0-9_.-]{12,}\b/gi, '[REDACTED]');
  output = output.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  if (output.length > max) return `${output.slice(0, max)}…`;
  return output;
}

function safeScalar(value) {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  return text(value, 600);
}

function safeObject(input, depth = 0) {
  if (depth > 3) return '[TRUNCATED]';
  if (Array.isArray(input)) return input.slice(0, 20).map((item) => safeObject(item, depth + 1));
  if (!input || typeof input !== 'object') return safeScalar(input);
  const output = {};
  for (const [key, value] of Object.entries(input).slice(0, 40)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      output[key] = '[REDACTED]';
      continue;
    }
    if (/prompt|messages|chat|character|memory|worldbook|raw|body/i.test(key)) continue;
    output[key] = safeObject(value, depth + 1);
  }
  return output;
}

function sourceFrom(input = {}) {
  const explicit = String(input.source || '').trim();
  if (SOURCE_VALUES.has(explicit)) return explicit;
  const code = String(input.code || input.reason || input.errorKind || '').toLowerCase();
  if (/api|http|upstream|relay/.test(code)) return 'api';
  if (/protocol|parse|json|validation/.test(code)) return 'protocol';
  if (/network|cors|dns|stream|offline|timeout/.test(code)) return 'network';
  if (/indexeddb|storage|quota|database/.test(code)) return 'storage';
  if (/backup|import|export/.test(code)) return 'backup';
  if (/permission|microphone|camera|notification/.test(code)) return 'permission';
  if (/native|capacitor|bridge/.test(code)) return 'native';
  if (/service.?worker|cache|hot.?update/.test(code)) return 'service-worker';
  if (/render|route|page|javascript|exception/.test(code)) return 'page';
  return 'unknown';
}

function severityFrom(input = {}) {
  const explicit = String(input.severity || '').trim();
  if (SEVERITY_VALUES.has(explicit)) return explicit;
  if (input.fatal === true) return 'critical';
  if (String(input.level || '') === 'warn') return 'warning';
  return 'error';
}

export function stripRouteDetails(value = '') {
  const route = String(value || '').trim();
  if (!route) return '';
  if (route.startsWith('#')) return route.split('?')[0];
  try {
    const url = new URL(route, typeof location !== 'undefined' ? location.origin : 'https://local.invalid');
    return `${url.origin === 'https://local.invalid' ? '' : url.origin}${url.pathname}`;
  } catch (_) {
    return route.split('?')[0].split('#')[0];
  }
}

export function sanitizeDiagnosticValue(value) {
  return safeObject(value);
}

export function diagnosticFingerprint(input = {}) {
  const source = `${input.source || ''}|${input.code || ''}|${input.status || ''}|${text(input.message || '', 300)}`;
  let hash = 2166136261;
  for (let i = 0; i < source.length; i += 1) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `dg_${(hash >>> 0).toString(36)}`;
}

export function makeIncidentId() {
  if (globalThis.crypto?.randomUUID) return `inc_${crypto.randomUUID()}`;
  return `inc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function routeIdFrom(value = '') {
  return stripRouteDetails(value).replace(/^#\/?/, '').replace(/^\/+/, '') || 'unknown';
}

function detectRuntime() {
  if (typeof window === 'undefined') return { channel: 'unknown', platform: 'unknown' };
  const native = !!globalThis.Capacitor?.isNativePlatform?.();
  const standalone = !native && (
    window.matchMedia?.('(display-mode: standalone)')?.matches
    || navigator.standalone === true
  );
  const ua = String(navigator.userAgent || '');
  const platform = /Android/i.test(ua)
    ? 'android'
    : (/iPhone|iPad|iPod/i.test(ua) ? 'ios' : 'web');
  return {
    channel: native ? 'android-apk' : (standalone ? 'pwa' : 'web'),
    platform,
  };
}

export function normalizeDiagnosticEnvelope(input = {}) {
  const code = text(input.code || input.reason || input.errorKind || 'unknown', 100) || 'unknown';
  const route = stripRouteDetails(input.route || '');
  const routeId = text(input.routeId || routeIdFrom(route), 120);
  const runtime = {
    ...detectRuntime(),
    ...(sanitizeDiagnosticValue(input.runtime || {})),
  };
  const envelope = {
    schemaVersion: 2,
    incidentId: text(input.incidentId || makeIncidentId(), 100),
    appId: 'marshmallow-machine',
    appName: '棉花糖机',
    code,
    source: sourceFrom({ ...input, code }),
    severity: severityFrom(input),
    scope: text(input.scope || input.route || '应用', 120),
    message: text(input.message || input.error || '发生未知错误', 1000),
    status: Number(input.status || 0) || null,
    correlationId: text(input.correlationId || '', 120),
    route,
    routeId,
    routeLabel: text(input.routeLabel || ROUTE_LABELS[routeId] || input.scope || '应用', 80),
    operation: text(input.operation || '', 120),
    apiKind: text(input.apiKind || '', 60),
    runtime,
    build: text(input.build || (typeof window !== 'undefined' ? window.__MARSHMALLOW_BUILD__ : ''), 80),
    at: Number(input.at || input.timestamp || Date.now()) || Date.now(),
    evidence: sanitizeDiagnosticValue(input.evidence || {}),
    actions: Array.isArray(input.actions)
      ? input.actions.slice(0, 8).map((action) => text(action, 80)).filter(Boolean)
      : [],
  };
  envelope.fingerprint = diagnosticFingerprint(envelope);
  return envelope;
}

export function diagnosticFromError(error, meta = {}) {
  const err = error instanceof Error ? error : new Error(String(error || '未知错误'));
  return normalizeDiagnosticEnvelope({
    ...meta,
    code: meta.code || err.code || err.reason || err.name || 'exception',
    message: meta.message || err.message,
    status: meta.status || err.status,
    correlationId: meta.correlationId || err.correlationId,
    evidence: {
      ...(meta.evidence || {}),
      errorName: err.name || '',
      stack: text(err.stack || '', 1800),
      timeoutStage: err.timeoutStage || '',
      requestMayHaveReachedServer: err.requestMayHaveReachedServer === true,
    },
  });
}
