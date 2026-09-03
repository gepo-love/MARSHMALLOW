import { normalizeDiagnosticEnvelope } from './diagnostic-envelope.js';

const SESSION_KEY = '__mm_support_incident__';
const OPERATION_KEY = '__mm_support_operation__';
let activeIncident = null;

function readSafeRouteDetail(name = '') {
  if (typeof location === 'undefined') return '';
  const query = String(location.hash || '').split('?')[1] || '';
  const value = new URLSearchParams(query).get(name) || '';
  return /^[a-z0-9._/-]{1,48}$/i.test(value) ? value : '';
}

export function collectCurrentSupportScene() {
  if (typeof document === 'undefined') return {};
  const modal = document.getElementById('modal-container');
  const quickBall = document.querySelector('.quick-ball');
  return {
    online: typeof navigator === 'undefined' ? null : navigator.onLine !== false,
    visibility: String(document.visibilityState || 'unknown'),
    // active 空壳同样会以 fixed 全屏层吞掉触摸，不能因没有子节点误报为“未打开”。
    modalOpen: !!modal?.classList.contains('active'),
    quickBallPresent: !!quickBall,
    quickBallHidden: quickBall
      ? quickBall.hidden || getComputedStyle(quickBall).display === 'none' || getComputedStyle(quickBall).visibility === 'hidden'
      : null,
    quickBallVisibilityReason: String(quickBall?.dataset?.quickBallVisibility || ''),
    generationActive: !!document.querySelector(
      '[aria-busy="true"], .is-generating, .is-loading[data-generation], [data-generation-loading]',
    ),
    recentErrorVisible: !!document.querySelector('.generation-error-report, [data-generation-error-report]'),
    routeTab: readSafeRouteDetail('tab'),
    tutorialSection: readSafeRouteDetail('section'),
    settingsFocus: readSafeRouteDetail('focus'),
    latestOperation: loadRecentSupportOperation(),
  };
}

export function recordSupportOperation(input = {}) {
  const row = {
    label: String(input.label || '页面操作').slice(0, 80),
    status: ['started', 'succeeded', 'failed', 'no-visible-result'].includes(input.status)
      ? input.status
      : 'started',
    code: String(input.code || '').slice(0, 100),
    startedAt: Number(input.startedAt || Date.now()) || Date.now(),
    finishedAt: Number(input.finishedAt || 0) || null,
    visibleDelta: Number(input.visibleDelta || 0) || 0,
  };
  try {
    sessionStorage.setItem(OPERATION_KEY, JSON.stringify(row));
  } catch (_) {}
  return row;
}

export function loadRecentSupportOperation(maxAgeMs = 30 * 60 * 1000) {
  try {
    const row = JSON.parse(sessionStorage.getItem(OPERATION_KEY) || 'null');
    if (!row?.startedAt || Date.now() - Number(row.startedAt) > maxAgeMs) return null;
    return row;
  } catch (_) {
    return null;
  }
}

export function saveSupportIncident(input = {}) {
  const diagnostic = normalizeDiagnosticEnvelope(input);
  activeIncident = diagnostic;
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(diagnostic));
  } catch (_) {}
  return diagnostic;
}

export function loadSupportIncident(incidentId = '') {
  const expected = String(incidentId || '').trim();
  if (activeIncident && (!expected || activeIncident.incidentId === expected)) return activeIncident;
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = normalizeDiagnosticEnvelope(JSON.parse(raw));
    if (expected && parsed.incidentId !== expected) return null;
    activeIncident = parsed;
    return parsed;
  } catch (_) {
    return null;
  }
}

export function captureSupportIncident(meta = {}) {
  return saveSupportIncident({
    source: meta.source || 'page',
    severity: meta.severity || 'info',
    code: meta.code || 'support-context',
    scope: meta.scope || '应用',
    message: meta.message || '用户请求帮助',
    route: meta.route || (typeof location !== 'undefined' ? location.hash || location.pathname : ''),
    ...meta,
    evidence: {
      ...collectCurrentSupportScene(),
      incidentOrigin: meta.evidence?.incidentOrigin || 'support-scene',
      ...(meta.evidence || {}),
    },
  });
}
