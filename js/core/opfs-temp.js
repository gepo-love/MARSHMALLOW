const activeCloudTempNames = new Set();
const OPFS_SYNC_WORKER_URL = new URL('../workers/opfs-sync-writer.js', import.meta.url);

function isCloudTempName(filename = '') {
  return /^cloud-(?:mm-|encrypted-)/.test(String(filename || ''));
}

function errorName(error) {
  return String(error?.name || '').trim();
}

function createTaggedTempError(message, code, error = null) {
  const failure = new Error(message, error ? { cause: error } : undefined);
  failure.code = code;
  return failure;
}

export function isOpfsCapabilityError(error) {
  return ['opfs-unsupported', 'opfs-permission-denied'].includes(String(error?.code || ''));
}

function createRequiredTempError(label, error = null, { unsupported = false } = {}) {
  const causeName = errorName(error);
  if (unsupported) {
    return createTaggedTempError(
      `当前浏览器会话未开放${label}所需的站点私有文件存储。请退出无痕 / 隐私模式，并用手机 Edge 或 Chrome 直接打开本站；仍不行请改用电脑导出`,
      'opfs-unsupported',
      error,
    );
  }
  if (causeName === 'QuotaExceededError') {
    return createTaggedTempError(
      `${label}可用的应用私有存储配额不足；这与手机总剩余空间不同，请重启应用后重试`,
      'opfs-quota-exceeded',
      error,
    );
  }
  if (causeName === 'SecurityError' || causeName === 'NotAllowedError') {
    return createTaggedTempError(
      `${label}被浏览器的站点存储权限拦截。请退出无痕 / 隐私模式，不要从微信、QQ 等内置页面打开，并确认地址以 HTTPS 开头`,
      'opfs-permission-denied',
      error,
    );
  }
  if (causeName === 'InvalidStateError' || causeName === 'NoModificationAllowedError') {
    return createTaggedTempError(
      `${label}临时文件正被其它页面占用。请关闭本站其它标签页，完全退出浏览器后重新打开再试`,
      'opfs-busy',
      error,
    );
  }
  return createTaggedTempError(
    `无法创建${label}低内存临时文件${causeName ? `（${causeName}）` : ''}。请关闭本站其它标签页并重启浏览器；不要清除本站数据`,
    'opfs-unavailable',
    error,
  );
}

async function cleanupOrphanedCloudTempFiles(root) {
  if (!root || typeof root.entries !== 'function') return 0;
  let removed = 0;
  try {
    for await (const [name] of root.entries()) {
      if (!isCloudTempName(name) || activeCloudTempNames.has(name)) continue;
      try {
        await root.removeEntry(name);
        removed += 1;
      } catch (_) { /* best effort */ }
    }
  } catch (error) {
    console.warn('[opfs-temp] orphan cleanup unavailable', error);
  }
  return removed;
}

function beginWorkerBackedWritable(filename) {
  if (typeof Worker !== 'function') {
    return Promise.reject(new TypeError('当前环境没有可用的 OPFS 写入 Worker'));
  }
  const worker = new Worker(OPFS_SYNC_WORKER_URL);
  let requestId = 0;
  let closed = false;
  const pending = new Map();
  let queue = Promise.resolve();

  const failAll = (error) => {
    const failure = error instanceof Error ? error : new Error(String(error || 'OPFS 写入 Worker 异常'));
    for (const task of pending.values()) task.reject(failure);
    pending.clear();
  };
  worker.addEventListener('message', (event) => {
    const message = event?.data || {};
    const task = pending.get(message.id);
    if (!task) return;
    pending.delete(message.id);
    if (message.ok) task.resolve(message.result);
    else {
      const error = new Error(String(message.message || 'OPFS 临时文件写入失败'));
      error.name = String(message.name || 'Error');
      task.reject(error);
    }
  });
  worker.addEventListener('error', (event) => {
    failAll(event?.error || new Error(String(event?.message || 'OPFS 写入 Worker 加载失败')));
  });

  const call = (type, payload = {}, transfer = []) => new Promise((resolve, reject) => {
    const id = ++requestId;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, type, ...payload }, transfer);
  });
  const enqueue = (task) => {
    const next = queue.then(task);
    queue = next.catch(() => {});
    return next;
  };
  const finish = async (type) => {
    if (closed) return;
    closed = true;
    try {
      await enqueue(() => call(type));
    } finally {
      failAll(new Error('OPFS 写入流已关闭'));
      worker.terminate();
    }
  };

  return call('init', { filename }).then(() => ({
    async write(value) {
      if (closed) throw new TypeError('OPFS 写入流已关闭');
      let bytes;
      if (typeof value === 'string') bytes = new TextEncoder().encode(value);
      else if (value instanceof ArrayBuffer) bytes = new Uint8Array(value.slice(0));
      else if (ArrayBuffer.isView(value)) bytes = new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
      else if (value instanceof Blob) bytes = new Uint8Array(await value.arrayBuffer());
      else throw new TypeError('OPFS 写入内容类型不受支持');
      return enqueue(() => call('write', { buffer: bytes.buffer }, [bytes.buffer]));
    },
    close() {
      return finish('close');
    },
    abort() {
      return finish('abort');
    },
  })).catch((error) => {
    worker.terminate();
    throw error;
  });
}

export async function beginOpfsTempTarget(filename, options = {}) {
  const required = options.required === true;
  const label = String(options.label || '临时文件');
  const cloudTemp = isCloudTempName(filename);
  if (typeof navigator === 'undefined' || typeof navigator.storage?.getDirectory !== 'function') {
    if (required) throw createRequiredTempError(label, null, { unsupported: true });
    return null;
  }

  let root = null;
  if (cloudTemp) activeCloudTempNames.add(filename);
  try {
    root = await navigator.storage.getDirectory();
    // 仅 APK 的强制低内存路径清理孤儿文件；普通网页可能同时开多个标签页，
    // 不能让一个标签页误删另一个标签页仍在使用的 OPFS 文件。
    if (cloudTemp && required) await cleanupOrphanedCloudTempFiles(root);
    const handle = await root.getFileHandle(filename, { create: true });
    let writable;
    if (typeof handle?.createWritable === 'function') {
      try {
        writable = await handle.createWritable();
      } catch (error) {
        // Safari 18 及更早版本只开放 Worker 内的 SyncAccessHandle。
        // createWritable 半实现抛 TypeError 时继续走同一份 OPFS 的 Worker 写入。
        if (!['TypeError', 'NotSupportedError'].includes(errorName(error))) throw error;
        writable = await beginWorkerBackedWritable(filename);
      }
    } else {
      writable = await beginWorkerBackedWritable(filename);
    }
    return { root, handle, writable, filename, cloudTemp };
  } catch (error) {
    if (root && cloudTemp) {
      try { await root.removeEntry(filename); } catch (_) { /* best effort */ }
    }
    if (cloudTemp) activeCloudTempNames.delete(filename);
    console.warn('[opfs-temp] file-backed target unavailable', error);
    if (required) throw createRequiredTempError(label, error);
    return null;
  }
}

export async function removeOpfsTempTarget(target) {
  if (!target?.root || !target?.filename) return;
  try {
    await target.root.removeEntry(target.filename);
  } catch (_) { /* best effort */ }
  if (target.cloudTemp || isCloudTempName(target.filename)) {
    activeCloudTempNames.delete(target.filename);
  }
}

export function requiredOpfsTempError(label, error = null) {
  return createRequiredTempError(String(label || '临时文件'), error);
}
