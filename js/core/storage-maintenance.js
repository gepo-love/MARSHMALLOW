const STORAGE_MAINTENANCE_LOCK = 'marshmallow-storage-maintenance-v1';
const STORAGE_MAINTENANCE_OWNER_KEY = '__mm_storage_maintenance_owner_v1__';

function createBusyError(owner = null) {
  const label = String(owner?.label || '其它页面的数据维护');
  const error = new Error(`${label}仍在进行，请完成后再试`);
  error.name = 'MarshmallowStorageMaintenanceBusyError';
  error.owner = owner;
  return error;
}
function readOwner() {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_MAINTENANCE_OWNER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

function writeOwner(owner) {
  try {
    globalThis.localStorage?.setItem(STORAGE_MAINTENANCE_OWNER_KEY, JSON.stringify(owner));
  } catch (_) {}
}

function clearOwner(token) {
  try {
    const current = readOwner();
    if (!current || current.token === token) {
      globalThis.localStorage?.removeItem(STORAGE_MAINTENANCE_OWNER_KEY);
    }
  } catch (_) {}
}

export function getStorageMaintenanceOwner() {
  const owner = readOwner();
  if (!owner) return null;
  if (Date.now() - Number(owner.startedAt || 0) > 30 * 60 * 1000) {
    clearOwner(owner.token);
    return null;
  }
  return owner;
}

export async function runStorageMaintenanceExclusive(label, task, options = {}) {
  if (typeof task !== 'function') throw new TypeError('storage maintenance task is required');
  const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const owner = {
    token,
    label: String(label || '数据维护'),
    build: String(globalThis.__MARSHMALLOW_BUILD__ || ''),
    href: String(globalThis.location?.href || ''),
    startedAt: Date.now(),
  };
  const execute = async () => {
    writeOwner(owner);
    try {
      globalThis.dispatchEvent?.(new CustomEvent('marshmallow-storage-maintenance', {
        detail: { active: true, owner },
      }));
    } catch (_) {}
    try {
      return await task(owner);
    } finally {
      clearOwner(token);
      try {
        globalThis.dispatchEvent?.(new CustomEvent('marshmallow-storage-maintenance', {
          detail: { active: false, owner },
        }));
      } catch (_) {}
    }
  };

  const locks = globalThis.navigator?.locks;
  if (!locks || typeof locks.request !== 'function') {
    const current = getStorageMaintenanceOwner();
    if (options.ifAvailable === true && current && current.token !== token) {
      throw createBusyError(current);
    }
    return execute();
  }

  return locks.request(
    STORAGE_MAINTENANCE_LOCK,
    { mode: 'exclusive', ifAvailable: options.ifAvailable === true },
    async (lock) => {
      if (!lock) throw createBusyError(getStorageMaintenanceOwner());
      return execute();
    },
  );
}
