function plugin() {
  return window.Capacitor?.Plugins?.MarshmallowFileExport
    || window.Capacitor?.Plugins?.GloryFileExport
    || null;
}

function sanitizeFilename(raw = 'marshmallow-export') {
  return String(raw || 'marshmallow-export')
    .replace(/[\\/:*?"<>|\r\n]+/g, '_')
    .slice(0, 80) || 'marshmallow-export';
}

function stripDataUrlPrefix(dataUrl = '') {
  const raw = String(dataUrl || '');
  const comma = raw.indexOf(',');
  if (raw.startsWith('data:') && comma >= 0) return raw.slice(comma + 1);
  return raw;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

const NATIVE_TEXT_BUFFER_CHARS = 96 * 1024;

export function hasNativeFileExport() {
  return !!plugin();
}

export function supportsChunkedNativeSave() {
  const p = plugin();
  return !!(p?.beginSave && p?.appendBase64 && p?.finishSave);
}

/** 直接把文本小段写入 Android MediaStore，禁止先在 WebView 内组装大 Blob。 */
export async function beginNativeChunkedTextSave(options = {}) {
  const p = plugin();
  if (!p?.beginSave || !p?.appendBase64 || !p?.finishSave || !p?.abortSave) {
    throw new Error('当前 APK 不支持低内存流式保存，请先覆盖安装最新版本');
  }
  const filename = sanitizeFilename(options.filename || `marshmallow-export-${Date.now()}.json`);
  const mimeType = String(options.mimeType || 'application/json');
  const directory = String(options.directory || 'downloads');
  const sessionId = `export_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const encoder = new TextEncoder();
  let buffer = '';
  let bytes = 0;
  let closed = false;
  await p.beginSave({ sessionId, filename, mimeType, directory });

  const writer = {
    isStreaming: true,
    write(text) {
      if (closed) throw new Error('原生文件输出流已经关闭');
      if (text) buffer += String(text);
    },
    get shouldDrain() {
      return buffer.length >= NATIVE_TEXT_BUFFER_CHARS;
    },
    get sizeEstimate() {
      return bytes + (buffer ? encoder.encode(buffer).byteLength : 0);
    },
    async drain() {
      if (closed || !buffer) return;
      const chunk = encoder.encode(buffer);
      buffer = '';
      await p.appendBase64({
        sessionId,
        base64: arrayBufferToBase64(
          chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength),
        ),
      });
      bytes += chunk.byteLength;
      options.onProgress?.({ bytes });
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    async finish() {
      if (closed) throw new Error('原生文件输出流已经关闭');
      await this.drain();
      closed = true;
      const result = await p.finishSave({ sessionId });
      return { ...result, filename, bytes: Number(result?.bytes || bytes) };
    },
    async abort() {
      if (closed) return;
      buffer = '';
      closed = true;
      if (p.abortSave) await p.abortSave({ sessionId }).catch(() => {});
    },
  };
  return writer;
}

/** 直接把二进制分片写入 Android MediaStore，用于大型 ZIP 媒体归档。 */
export async function beginNativeChunkedBinarySave(options = {}) {
  const p = plugin();
  if (!p?.beginSave || !p?.appendBase64 || !p?.finishSave || !p?.abortSave) {
    throw new Error('当前 APK 不支持低内存流式保存，请先覆盖安装最新版本');
  }
  const filename = sanitizeFilename(options.filename || `marshmallow-export-${Date.now()}.bin`);
  const mimeType = String(options.mimeType || 'application/octet-stream');
  const directory = String(options.directory || 'downloads');
  const sessionId = `binary_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  let bytes = 0;
  let closed = false;
  await p.beginSave({ sessionId, filename, mimeType, directory });
  return {
    result: null,
    async write(value) {
      if (closed) throw new Error('原生文件输出流已经关闭');
      const source = value instanceof Uint8Array
        ? value
        : new Uint8Array(value instanceof ArrayBuffer ? value : await new Blob([value]).arrayBuffer());
      if (!source.byteLength) return;
      await p.appendBase64({
        sessionId,
        base64: arrayBufferToBase64(
          source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength),
        ),
      });
      bytes += source.byteLength;
      options.onProgress?.({ bytes });
    },
    async close() {
      if (closed) return this.result;
      closed = true;
      const result = await p.finishSave({ sessionId });
      this.result = { ...result, ok: true, method: 'native', filename, bytes: Number(result?.bytes || bytes) };
      return this.result;
    },
    async abort() {
      if (closed) return;
      closed = true;
      await p.abortSave({ sessionId }).catch(() => {});
    },
  };
}

export async function saveTextNatively(text, options = {}) {
  const p = plugin();
  if (!p?.saveText) return null;
  return p.saveText({
    text: String(text ?? ''),
    filename: sanitizeFilename(options.filename || `marshmallow-export-${Date.now()}.txt`),
    mimeType: String(options.mimeType || 'text/plain; charset=utf-8'),
    directory: String(options.directory || 'downloads'),
  });
}

async function saveBlobViaChunks(blob, options = {}) {
  const p = plugin();
  if (!p?.beginSave || !p?.appendBase64 || !p?.finishSave) return null;
  const filename = sanitizeFilename(options.filename || `marshmallow-export-${Date.now()}`);
  const mimeType = String(options.mimeType || blob.type || 'application/octet-stream');
  const directory = String(options.directory || (mimeType.startsWith('image/') ? 'pictures' : 'downloads'));
  const sessionId = `mm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const chunkBytes = 384 * 1024;
  await p.beginSave({ sessionId, filename, mimeType, directory });
  for (let offset = 0; offset < blob.size; offset += chunkBytes) {
    const slice = blob.slice(offset, offset + chunkBytes);
    const ab = await slice.arrayBuffer();
    await p.appendBase64({
      sessionId,
      base64: arrayBufferToBase64(ab),
    });
  }
  return p.finishSave({ sessionId });
}

export async function saveBlobNatively(blob, options = {}) {
  const p = plugin();
  if (!p || !blob) return null;
  const filename = sanitizeFilename(options.filename || `marshmallow-export-${Date.now()}`);
  const mimeType = String(options.mimeType || blob.type || 'application/octet-stream');
  const directory = String(options.directory || (mimeType.startsWith('image/') ? 'pictures' : 'downloads'));

  if (blob.size > 512 * 1024 && supportsChunkedNativeSave()) {
    return saveBlobViaChunks(blob, { filename, mimeType, directory });
  }

  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('文件读取失败'));
    reader.onload = () => resolve(String(reader.result || ''));
    reader.readAsDataURL(blob);
  });
  return p.saveBase64({
    base64: stripDataUrlPrefix(dataUrl),
    filename,
    mimeType,
    directory,
  });
}
