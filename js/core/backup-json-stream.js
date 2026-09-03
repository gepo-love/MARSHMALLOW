export const BACKUP_JSON_STRING_CHUNK_CHARS = 64 * 1024;
export const BACKUP_BLOB_MARKER = '__marshmallowBackupBlobV1';
const BACKUP_BLOB_CHUNK_BYTES = 192 * 1024;

async function drainIfNeeded(writer) {
  if (writer?.shouldDrain && typeof writer.drain === 'function') {
    await writer.drain();
  }
}

async function appendJsonString(writer, value) {
  const text = String(value);
  writer.write('"');
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + BACKUP_JSON_STRING_CHUNK_CHARS);
    // 不把 emoji 等代理对拆到两个 JSON.stringify 调用中，否则会被写成两个孤立转义。
    if (
      end < text.length
      && end > start
      && text.charCodeAt(end - 1) >= 0xD800
      && text.charCodeAt(end - 1) <= 0xDBFF
      && text.charCodeAt(end) >= 0xDC00
      && text.charCodeAt(end) <= 0xDFFF
    ) {
      end += 1;
    }
    const encoded = JSON.stringify(text.slice(start, end));
    writer.write(encoded.slice(1, -1));
    start = end;
    await drainIfNeeded(writer);
  }
  writer.write('"');
}

function normalizeJsonValue(input, key = '') {
  let value = input;
  if (
    value !== null
    && (typeof value === 'object' || typeof value === 'function')
    && typeof value.toJSON === 'function'
  ) {
    value = value.toJSON(key);
  }
  if (value instanceof Number || value instanceof String || value instanceof Boolean) {
    value = value.valueOf();
  }
  return value;
}

function isJsonOmittedValue(value) {
  return value === undefined || typeof value === 'function' || typeof value === 'symbol';
}

function bytesToBinaryString(bytes) {
  let text = '';
  const step = 8 * 1024;
  for (let i = 0; i < bytes.length; i += step) {
    text += String.fromCharCode(...bytes.subarray(i, Math.min(bytes.length, i + step)));
  }
  return text;
}

async function appendBackupBlob(writer, blob) {
  writer.write(`{"${BACKUP_BLOB_MARKER}":true,"type":${JSON.stringify(String(blob.type || 'application/octet-stream'))},"base64":"`);
  for (let offset = 0; offset < blob.size; offset += BACKUP_BLOB_CHUNK_BYTES) {
    const slice = blob.slice(offset, Math.min(blob.size, offset + BACKUP_BLOB_CHUNK_BYTES));
    const bytes = new Uint8Array(await slice.arrayBuffer());
    writer.write(btoa(bytesToBinaryString(bytes)));
    await drainIfNeeded(writer);
  }
  writer.write('"}');
}

function decodeBackupBlob(marker) {
  const encoded = String(marker?.base64 || '');
  const parts = [];
  const step = 256 * 1024;
  for (let offset = 0; offset < encoded.length; offset += step) {
    const binary = atob(encoded.slice(offset, Math.min(encoded.length, offset + step)));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    parts.push(bytes);
  }
  return new Blob(parts, { type: String(marker?.type || 'application/octet-stream') });
}

/** 把搬家 JSON 中的二进制标记递归还原为 Blob；旧备份不含标记时保持原样。 */
export function reviveBackupBlobValues(input) {
  if (input === null || typeof input !== 'object' || input instanceof Blob) return input;
  if (input[BACKUP_BLOB_MARKER] === true && typeof input.base64 === 'string') {
    return decodeBackupBlob(input);
  }
  if (Array.isArray(input)) {
    for (let index = 0; index < input.length; index += 1) input[index] = reviveBackupBlobValues(input[index]);
    return input;
  }
  for (const key of Object.keys(input)) input[key] = reviveBackupBlobValues(input[key]);
  return input;
}

async function appendPreparedJsonValue(writer, value, {
  arrayItem = false,
  ancestors,
} = {}) {
  if (isJsonOmittedValue(value)) {
    if (arrayItem) writer.write('null');
    return arrayItem;
  }
  if (value === null) {
    writer.write('null');
    return true;
  }
  if (typeof value === 'string') {
    await appendJsonString(writer, value);
    return true;
  }
  if (typeof value === 'number') {
    writer.write(Number.isFinite(value) ? String(value) : 'null');
    return true;
  }
  if (typeof value === 'boolean') {
    writer.write(value ? 'true' : 'false');
    return true;
  }
  if (typeof value === 'bigint') {
    throw new TypeError('Do not know how to serialize a BigInt');
  }
  if (value instanceof Blob) {
    await appendBackupBlob(writer, value);
    return true;
  }

  const activeAncestors = ancestors || new Set();
  if (activeAncestors.has(value)) {
    throw new TypeError('Converting circular structure to JSON');
  }
  activeAncestors.add(value);
  try {
    if (Array.isArray(value)) {
      writer.write('[');
      for (let index = 0; index < value.length; index += 1) {
        if (index) writer.write(',');
        const child = normalizeJsonValue(value[index], String(index));
        await appendPreparedJsonValue(writer, child, {
          arrayItem: true,
          ancestors: activeAncestors,
        });
        await drainIfNeeded(writer);
      }
      writer.write(']');
      return true;
    }

    writer.write('{');
    let first = true;
    for (const key of Object.keys(value)) {
      const child = normalizeJsonValue(value[key], key);
      if (isJsonOmittedValue(child)) continue;
      if (!first) writer.write(',');
      writer.write(`${JSON.stringify(key)}:`);
      await appendPreparedJsonValue(writer, child, { ancestors: activeAncestors });
      first = false;
      await drainIfNeeded(writer);
    }
    writer.write('}');
    return true;
  } finally {
    activeAncestors.delete(value);
  }
}

/**
 * 与 JSON.stringify 结果等价地写入可序列化值，但长字符串按片转义。
 * 备份中的 data URL 可达数 MB；避免先额外创建同等大小的完整 JSON 字符串。
 */
export async function appendJsonValueToWriter(writer, input, { arrayItem = false } = {}) {
  const value = normalizeJsonValue(input, '');
  return appendPreparedJsonValue(writer, value, { arrayItem });
}
