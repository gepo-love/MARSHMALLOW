const states = new Map();
const EVENT_NAME = 'marshmallow-manual-generation-state';
const TERMINAL_TTL_MS = 5 * 60 * 1000;

function cleanKey(value) {
  return String(value || '').trim();
}

function publicState(state) {
  return state ? { ...state } : null;
}

function syncGlobalGenerationSignal() {
  if (typeof window === 'undefined') return;
  const active = [...states.values()].filter((state) => state?.status === 'running').length;
  window.__mm_manual_generation_active__ = active;
  window.dispatchEvent(new CustomEvent('marshmallow-generation-activity', {
    detail: { source: 'manual', active },
  }));
}

function emit(key) {
  if (typeof window === 'undefined') return;
  syncGlobalGenerationSignal();
  window.dispatchEvent(new CustomEvent(EVENT_NAME, {
    detail: { key, state: publicState(states.get(key)) },
  }));
}

export function getManualGenerationState(key) {
  const id = cleanKey(key);
  const state = states.get(id);
  if (!state) return null;
  if (state.status !== 'running' && Date.now() - Number(state.finishedAt || 0) > TERMINAL_TTL_MS) {
    states.delete(id);
    syncGlobalGenerationSignal();
    return null;
  }
  return publicState(state);
}

export function isManualGenerationRunning(key) {
  return getManualGenerationState(key)?.status === 'running';
}

export function beginManualGeneration(key, options = {}) {
  const id = cleanKey(key);
  if (!id || isManualGenerationRunning(id)) return false;
  states.set(id, {
    key: id,
    status: 'running',
    kind: String(options.kind || ''),
    message: String(options.message || '正在生成…'),
    hint: String(options.hint || '可以先去其他页面，稍后回来查看结果'),
    startedAt: Date.now(),
    updatedAt: Date.now(),
    finishedAt: 0,
  });
  emit(id);
  return true;
}

export function updateManualGeneration(key, message, options = {}) {
  const id = cleanKey(key);
  const current = states.get(id);
  if (!current || current.status !== 'running') return null;
  const next = {
    ...current,
    message: String(message || current.message),
    hint: options.hint == null ? current.hint : String(options.hint || ''),
    updatedAt: Date.now(),
  };
  states.set(id, next);
  emit(id);
  return publicState(next);
}

export function finishManualGeneration(key, options = {}) {
  const id = cleanKey(key);
  const current = states.get(id);
  if (!current) return null;
  const next = {
    ...current,
    status: options.ok === false ? 'error' : 'success',
    message: String(options.message || (options.ok === false ? '生成失败' : '生成完成')),
    hint: String(options.hint || ''),
    updatedAt: Date.now(),
    finishedAt: Date.now(),
  };
  states.set(id, next);
  emit(id);
  return publicState(next);
}

export function subscribeManualGeneration(key, callback) {
  const id = cleanKey(key);
  if (!id || typeof window === 'undefined' || typeof callback !== 'function') return () => {};
  const handler = (event) => {
    if (event.detail?.key !== id) return;
    callback(publicState(event.detail?.state));
  };
  window.addEventListener(EVENT_NAME, handler);
  callback(getManualGenerationState(id));
  return () => window.removeEventListener(EVENT_NAME, handler);
}
