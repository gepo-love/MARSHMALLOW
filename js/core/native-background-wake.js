// APK 后台主动消息：Android AlarmManager 定时唤醒 JS 跑 catch-up（日程主动消息 / 备忘 / 自动闲聊等）。
// Web/PWA 仍走 setInterval + 可选 Worker；原生壳不依赖用户手动开「后台活跃」才注册闹钟。

import { isNativeShell } from './native-update-bridge.js';

const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;
let wakeListenerRemove = null;

function keepAlivePlugin() {
  if (typeof window === 'undefined') return null;
  const plugins = window.Capacitor?.Plugins || {};
  return plugins.MarshmallowKeepAlive || plugins.GloryKeepAlive || null;
}

export function isNativeBackgroundWakeSupported() {
  return isNativeShell() && !!keepAlivePlugin()?.scheduleBackgroundWake;
}

export async function startNativeBackgroundWake(options = {}) {
  const plugin = keepAlivePlugin();
  if (!plugin?.scheduleBackgroundWake) return { ok: false, reason: 'no-native-bridge' };
  const intervalMs = Math.max(
    15 * 60_000,
    Math.min(24 * 60 * 60_000, Number(options.intervalMs) || DEFAULT_INTERVAL_MS),
  );
  try {
    return await plugin.scheduleBackgroundWake({ intervalMs });
  } catch (err) {
    return { ok: false, error: err?.message || String(err || '') };
  }
}

export async function stopNativeBackgroundWake() {
  const plugin = keepAlivePlugin();
  if (!plugin?.cancelBackgroundWake) return { ok: false, reason: 'no-native-bridge' };
  try {
    return await plugin.cancelBackgroundWake();
  } catch (err) {
    return { ok: false, error: err?.message || String(err || '') };
  }
}

export function bindNativeBackgroundWake(handler) {
  if (typeof handler !== 'function') return () => {};
  const plugin = keepAlivePlugin();
  if (!plugin?.addListener) return () => {};
  if (wakeListenerRemove) {
    try { wakeListenerRemove(); } catch (_) {}
    wakeListenerRemove = null;
  }
  const sub = plugin.addListener('backgroundWake', async (event = {}) => {
    let handled = false;
    try {
      await handler(event.source || 'native-wake');
      handled = true;
    } catch (_) {
      // 后台补跑失败留给网页自己的 catch-up 状态处理。
    } finally {
      if (handled && typeof plugin.acknowledgePendingBackgroundWake === 'function') {
        plugin.acknowledgePendingBackgroundWake().catch(() => {});
      }
      if (event.leaseId && typeof plugin.completeBackgroundWake === 'function') {
        plugin.completeBackgroundWake({ leaseId: event.leaseId }).catch(() => {});
      }
    }
  });
  wakeListenerRemove = () => {
    sub?.remove?.().catch?.(() => {});
  };
  return wakeListenerRemove;
}

export async function initNativeBackgroundWake(handler, options = {}) {
  if (!isNativeBackgroundWakeSupported()) return { ok: false, reason: 'unsupported' };
  bindNativeBackgroundWake(handler);
  const plugin = keepAlivePlugin();
  if (typeof plugin?.consumePendingBackgroundWake === 'function') {
    try {
      const pending = await plugin.consumePendingBackgroundWake();
      if (pending?.pending) {
        await handler(pending.source || 'native-catch-up');
        if (typeof plugin.acknowledgePendingBackgroundWake === 'function') {
          await plugin.acknowledgePendingBackgroundWake();
        }
      }
    } catch (_) {}
  }
  return startNativeBackgroundWake(options);
}

export async function getNativeBackgroundWakeStatus() {
  const plugin = keepAlivePlugin();
  if (typeof plugin?.getStatus !== 'function') return { native: false };
  return plugin.getStatus();
}

export async function scheduleNativeExactWake(alarmId, triggerAtMs) {
  const plugin = keepAlivePlugin();
  if (typeof plugin?.scheduleExactWake !== 'function') return { ok: false, reason: 'unsupported' };
  return plugin.scheduleExactWake({
    alarmId: String(alarmId || 'default'),
    triggerAtMs: Number(triggerAtMs) || 0,
  });
}

export async function cancelNativeExactWake(alarmId) {
  const plugin = keepAlivePlugin();
  if (typeof plugin?.cancelExactWake !== 'function') return { ok: false, reason: 'unsupported' };
  return plugin.cancelExactWake({ alarmId: String(alarmId || 'default') });
}

export async function openNativeExactAlarmSettings() {
  const plugin = keepAlivePlugin();
  if (typeof plugin?.openExactAlarmSettings !== 'function') return { ok: false, reason: 'unsupported' };
  return plugin.openExactAlarmSettings();
}

export async function openNativeOemBackgroundSettings() {
  const plugin = keepAlivePlugin();
  if (typeof plugin?.openOemBackgroundSettings !== 'function') return { ok: false, reason: 'unsupported' };
  return plugin.openOemBackgroundSettings();
}
