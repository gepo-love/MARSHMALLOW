let root = null;
let access = null;
let position = 0;
let activeFilename = '';

function reply(id, result = null) {
  self.postMessage({ id, ok: true, result });
}

function fail(id, error) {
  self.postMessage({
    id,
    ok: false,
    name: String(error?.name || 'Error'),
    message: String(error?.message || error || 'OPFS 写入失败'),
  });
}

async function closeAccess({ remove = false } = {}) {
  if (access) {
    try { access.flush(); } catch (_) { /* best effort */ }
    try { access.close(); } catch (_) { /* best effort */ }
    access = null;
  }
  if (remove && root && activeFilename) {
    try { await root.removeEntry(activeFilename); } catch (_) { /* best effort */ }
  }
}

self.addEventListener('message', async (event) => {
  const message = event?.data || {};
  const id = message.id;
  try {
    if (message.type === 'init') {
      activeFilename = String(message.filename || '').trim();
      if (!activeFilename) throw new TypeError('临时文件名为空');
      root = await navigator.storage.getDirectory();
      const handle = await root.getFileHandle(activeFilename, { create: true });
      if (typeof handle?.createSyncAccessHandle !== 'function') {
        throw new TypeError('当前 WebKit 未开放 OPFS 同步写入能力');
      }
      access = await handle.createSyncAccessHandle();
      access.truncate(0);
      position = 0;
      reply(id);
      return;
    }
    if (message.type === 'write') {
      if (!access) throw new TypeError('OPFS 写入流尚未初始化');
      const bytes = new Uint8Array(message.buffer || new ArrayBuffer(0));
      let offset = 0;
      while (offset < bytes.byteLength) {
        const written = Number(access.write(bytes.subarray(offset), { at: position })) || 0;
        if (written <= 0) throw new Error('OPFS 临时文件未能继续写入');
        offset += written;
        position += written;
      }
      reply(id, { bytes: bytes.byteLength });
      return;
    }
    if (message.type === 'close') {
      await closeAccess();
      reply(id, { bytes: position });
      return;
    }
    if (message.type === 'abort') {
      await closeAccess({ remove: true });
      reply(id);
      return;
    }
    throw new TypeError('未知 OPFS Worker 指令');
  } catch (error) {
    fail(id, error);
  }
});
