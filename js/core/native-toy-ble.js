function plugin() {
  return globalThis.Capacitor?.Plugins?.MarshmallowToyBle || null;
}

export function isNativeToyBleAvailable() {
  const native = typeof globalThis.Capacitor?.isNativePlatform === 'function'
    && globalThis.Capacitor.isNativePlatform();
  return !!native && !!plugin();
}

export async function scanNativeToys({ includeUnknown = false } = {}) {
  const bridge = plugin();
  if (!bridge) throw new Error('TOY_BLE_NATIVE_UNAVAILABLE');
  let timeout = null;
  try {
    return await Promise.race([
      bridge.scan({ includeUnknown: includeUnknown === true }),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('TOY_BLE_SCAN_TIMEOUT')), 12_000);
      }),
    ]);
  } finally {
    if (timeout != null) clearTimeout(timeout);
  }
}

export async function connectNativeToy(address) {
  const bridge = plugin();
  if (!bridge) throw new Error('TOY_BLE_NATIVE_UNAVAILABLE');
  return bridge.connect({ address: String(address || '').trim() });
}

export async function getNativeToyStatus() {
  const bridge = plugin();
  if (!bridge || typeof bridge.getStatus !== 'function') return null;
  return bridge.getStatus();
}

export function subscribeNativeToyConnection(listener) {
  const bridge = plugin();
  if (!bridge || typeof bridge.addListener !== 'function' || typeof listener !== 'function') {
    return () => {};
  }
  let removed = false;
  let handle = null;
  Promise.resolve(bridge.addListener('connectionState', listener)).then((value) => {
    handle = value;
    if (removed) void handle?.remove?.();
  }).catch(() => {});
  return () => {
    removed = true;
    void handle?.remove?.();
  };
}

export async function controlNativeToy(
  { mode = 'stop', vibration = 0, suction = 0 } = {},
  { timeoutMs = 4_000 } = {},
) {
  const bridge = plugin();
  if (!bridge) throw new Error('TOY_BLE_NATIVE_UNAVAILABLE');
  let timer = null;
  try {
    return await Promise.race([
      bridge.control({ mode, vibration, suction }),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error('TOY_BLE_CONTROL_TIMEOUT');
          error.code = 'TOY_BLE_CONTROL_TIMEOUT';
          reject(error);
        }, Math.max(250, Number(timeoutMs) || 4_000));
      }),
    ]);
  } finally {
    if (timer != null) clearTimeout(timer);
  }
}

export async function disconnectNativeToy() {
  const bridge = plugin();
  if (!bridge) return { ok: true, unavailable: true };
  return bridge.disconnect();
}
