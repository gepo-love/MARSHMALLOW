let crc32Table;

function getCrc32Table() {
  if (crc32Table) return crc32Table;
  crc32Table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    crc32Table[i] = c >>> 0;
  }
  return crc32Table;
}

export function crc32Bytes(bytes) {
  const table = getCrc32Table();
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** 流式写入 STORE（无压缩）ZIP，适合分片 JSON 导出。 */
export class StoreZipStreamWriter {
  constructor(writable) {
    this.writable = writable;
    this.offset = 0;
    this.centralRecords = [];
    this.encoder = new TextEncoder();
  }

  async addEntry(filename, text) {
    const nameBytes = this.encoder.encode(String(filename || 'part.json'));
    const data = this.encoder.encode(String(text ?? ''));
    const crc = crc32Bytes(data);
    const size = data.length;

    const header = new Uint8Array(30 + nameBytes.length);
    const view = new DataView(header.buffer);
    header.set([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x00, 0x00], 0);
    view.setUint32(14, crc, true);
    view.setUint32(18, size, true);
    view.setUint32(22, size, true);
    view.setUint16(26, nameBytes.length, true);
    header.set(nameBytes, 30);

    await this.writable.write(header);
    await this.writable.write(data);

    this.centralRecords.push({
      nameBytes,
      crc,
      size,
      offset: this.offset,
    });
    this.offset += header.length + data.length;
  }

  async addBlobEntry(filename, blob, options = {}) {
    if (!(blob instanceof Blob) || !blob.size) return false;
    const nameBytes = this.encoder.encode(String(filename || 'media.bin'));
    const chunkBytes = Math.max(64 * 1024, Number(options.chunkBytes || 384 * 1024));
    let crc = 0xffffffff;
    const table = getCrc32Table();
    for (let offset = 0; offset < blob.size; offset += chunkBytes) {
      const bytes = new Uint8Array(await blob.slice(offset, offset + chunkBytes).arrayBuffer());
      for (let index = 0; index < bytes.length; index += 1) {
        crc = table[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
      }
      options.onProgress?.({ phase: 'checksum', loadedBytes: Math.min(blob.size, offset + bytes.length), totalBytes: blob.size });
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const size = blob.size;
    const header = new Uint8Array(30 + nameBytes.length);
    const view = new DataView(header.buffer);
    header.set([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x00, 0x00], 0);
    view.setUint32(14, crc, true);
    view.setUint32(18, size, true);
    view.setUint32(22, size, true);
    view.setUint16(26, nameBytes.length, true);
    header.set(nameBytes, 30);
    await this.writable.write(header);
    for (let offset = 0; offset < blob.size; offset += chunkBytes) {
      const bytes = new Uint8Array(await blob.slice(offset, offset + chunkBytes).arrayBuffer());
      await this.writable.write(bytes);
      options.onProgress?.({ phase: 'write', loadedBytes: Math.min(blob.size, offset + bytes.length), totalBytes: blob.size });
    }
    this.centralRecords.push({ nameBytes, crc, size, offset: this.offset });
    this.offset += header.length + size;
    return true;
  }

  async close() {
    const centralStart = this.offset;
    for (const rec of this.centralRecords) {
      const cd = new Uint8Array(46 + rec.nameBytes.length);
      const view = new DataView(cd.buffer);
      cd.set([0x50, 0x4b, 0x01, 0x02, 0x14, 0x00, 0x14, 0x00, 0x00, 0x00, 0x00, 0x00], 0);
      view.setUint32(16, rec.crc, true);
      view.setUint32(20, rec.size, true);
      view.setUint32(24, rec.size, true);
      view.setUint16(28, rec.nameBytes.length, true);
      view.setUint32(42, rec.offset, true);
      cd.set(rec.nameBytes, 46);
      await this.writable.write(cd);
      this.offset += cd.length;
    }

    const centralSize = this.offset - centralStart;
    const eocd = new Uint8Array(22);
    const eocdView = new DataView(eocd.buffer);
    eocd.set([0x50, 0x4b, 0x05, 0x06, 0x00, 0x00, 0x00, 0x00], 0);
    eocdView.setUint16(8, this.centralRecords.length, true);
    eocdView.setUint16(10, this.centralRecords.length, true);
    eocdView.setUint32(12, centralSize, true);
    eocdView.setUint32(16, centralStart, true);
    await this.writable.write(eocd);
    await this.writable.close();
  }
}

export function createStoreZipBlob(entries) {
  const records = [];
  const chunks = [];
  let offset = 0;
  const encoder = new TextEncoder();

  for (const entry of entries) {
    const nameBytes = encoder.encode(String(entry.name || 'part.json'));
    const data = encoder.encode(String(entry.text ?? ''));
    const crc = crc32Bytes(data);
    const size = data.length;

    const header = new Uint8Array(30 + nameBytes.length);
    const view = new DataView(header.buffer);
    header.set([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x00, 0x00], 0);
    view.setUint32(14, crc, true);
    view.setUint32(18, size, true);
    view.setUint32(22, size, true);
    view.setUint16(26, nameBytes.length, true);
    header.set(nameBytes, 30);

    chunks.push(header, data);
    records.push({ nameBytes, crc, size, offset });
    offset += header.length + data.length;
  }

  const centralStart = offset;
  for (const rec of records) {
    const cd = new Uint8Array(46 + rec.nameBytes.length);
    const view = new DataView(cd.buffer);
    cd.set([0x50, 0x4b, 0x01, 0x02, 0x14, 0x00, 0x14, 0x00, 0x00, 0x00, 0x00, 0x00], 0);
    view.setUint32(16, rec.crc, true);
    view.setUint32(20, rec.size, true);
    view.setUint32(24, rec.size, true);
    view.setUint16(28, rec.nameBytes.length, true);
    view.setUint32(42, rec.offset, true);
    cd.set(rec.nameBytes, 46);
    chunks.push(cd);
    offset += cd.length;
  }

  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocd.set([0x50, 0x4b, 0x05, 0x06, 0x00, 0x00, 0x00, 0x00], 0);
  eocdView.setUint16(8, records.length, true);
  eocdView.setUint16(10, records.length, true);
  eocdView.setUint32(12, offset - centralStart, true);
  eocdView.setUint32(16, centralStart, true);
  chunks.push(eocd);

  return new Blob(chunks, { type: 'application/zip' });
}

async function deflateRawBytes(bytes) {
  if (typeof CompressionStream === 'undefined') return null;
  try {
    const stream = new CompressionStream('deflate-raw');
    const writer = stream.writable.getWriter();
    // 必须在写入前就开始消费 readable。移动端 WebView 的流缓冲区很小，
    // 若等 writer.close() 后才读取，稍大的档案会因背压让 write/close 永远等待。
    const output = new Response(stream.readable).arrayBuffer();
    await writer.write(bytes);
    await writer.close();
    return new Uint8Array(await output);
  } catch (_) {
    return null;
  }
}

/**
 * 文本 ZIP：支持时使用标准 deflate-raw，旧 Safari / WebView 自动回退 STORE。
 * 返回是否真正压缩，供清单记录而不是把“ZIP”误写成必然压缩。
 */
export async function createTextZipBlob(entries, options = {}) {
  if (options.compress === false) {
    return { blob: createStoreZipBlob(entries), compressed: false };
  }
  const encoder = new TextEncoder();
  const prepared = [];
  let usedDeflate = false;
  for (const entry of entries) {
    const raw = encoder.encode(String(entry.text ?? ''));
    const compressed = await deflateRawBytes(raw);
    const worthwhile = compressed && compressed.length + 12 < raw.length;
    prepared.push({
      name: String(entry.name || 'part.json'),
      raw,
      data: worthwhile ? compressed : raw,
      method: worthwhile ? 8 : 0,
    });
    if (worthwhile) usedDeflate = true;
  }

  const chunks = [];
  const records = [];
  let offset = 0;
  for (const entry of prepared) {
    const nameBytes = encoder.encode(entry.name);
    const crc = crc32Bytes(entry.raw);
    const header = new Uint8Array(30 + nameBytes.length);
    const view = new DataView(header.buffer);
    header.set([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x08], 0);
    view.setUint16(8, entry.method, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, entry.data.length, true);
    view.setUint32(22, entry.raw.length, true);
    view.setUint16(26, nameBytes.length, true);
    header.set(nameBytes, 30);
    chunks.push(header, entry.data);
    records.push({
      nameBytes,
      crc,
      method: entry.method,
      compressedSize: entry.data.length,
      size: entry.raw.length,
      offset,
    });
    offset += header.length + entry.data.length;
  }

  const centralStart = offset;
  for (const rec of records) {
    const cd = new Uint8Array(46 + rec.nameBytes.length);
    const view = new DataView(cd.buffer);
    cd.set([0x50, 0x4b, 0x01, 0x02, 0x14, 0x00, 0x14, 0x00, 0x00, 0x08], 0);
    view.setUint16(10, rec.method, true);
    view.setUint32(16, rec.crc, true);
    view.setUint32(20, rec.compressedSize, true);
    view.setUint32(24, rec.size, true);
    view.setUint16(28, rec.nameBytes.length, true);
    view.setUint32(42, rec.offset, true);
    cd.set(rec.nameBytes, 46);
    chunks.push(cd);
    offset += cd.length;
  }

  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocd.set([0x50, 0x4b, 0x05, 0x06, 0x00, 0x00, 0x00, 0x00], 0);
  eocdView.setUint16(8, records.length, true);
  eocdView.setUint16(10, records.length, true);
  eocdView.setUint32(12, offset - centralStart, true);
  eocdView.setUint32(16, centralStart, true);
  chunks.push(eocd);
  return { blob: new Blob(chunks, { type: 'application/zip' }), compressed: usedDeflate };
}
