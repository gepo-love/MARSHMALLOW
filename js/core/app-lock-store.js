// v1 在功能开发预览期曾把“保存密码”误当成“开启锁屏”，不能迁移它的 enabled。
// 使用新键让所有用户从明确关闭开始，只有设置页开关可以写入开启状态。
const STORAGE_KEY = 'mm_app_lock_v2';

const DEFAULTS = Object.freeze({
  enabled: false,
  pinHash: '',
  salt: '',
  wallpaper: '',
});

function randomSalt() {
  const bytes = new Uint8Array(16);
  globalThis.crypto?.getRandomValues?.(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}

async function digest(value) {
  const bytes = new TextEncoder().encode(value);
  if (globalThis.crypto?.subtle) {
    const result = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(result), (item) => item.toString(16).padStart(2, '0')).join('');
  }
  let hash = 2166136261;
  bytes.forEach((item) => {
    hash ^= item;
    hash = Math.imul(hash, 16777619);
  });
  return `fallback-${(hash >>> 0).toString(16)}`;
}

export function loadAppLockSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return { ...DEFAULTS, ...saved, enabled: saved.enabled === true };
  } catch (_) {
    return { ...DEFAULTS };
  }
}

export function saveAppLockSettings(patch = {}) {
  const next = { ...loadAppLockSettings(), ...patch };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  globalThis.dispatchEvent?.(new CustomEvent('marshmallow-app-lock-settings', { detail: next }));
  return next;
}

export function isValidPin(pin) {
  return /^\d{4}$/.test(String(pin || ''));
}

export async function setAppLockPin(pin) {
  if (!isValidPin(pin)) throw new Error('请输入四位数字密码');
  const salt = randomSalt();
  const pinHash = await digest(`${salt}:${pin}`);
  return saveAppLockSettings({ salt, pinHash });
}

export async function verifyAppLockPin(pin, settings = loadAppLockSettings()) {
  if (!isValidPin(pin) || !settings.salt || !settings.pinHash) return false;
  return (await digest(`${settings.salt}:${pin}`)) === settings.pinHash;
}

export function hasAppLockPin(settings = loadAppLockSettings()) {
  return !!(settings.salt && settings.pinHash);
}
