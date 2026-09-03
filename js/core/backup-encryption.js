import {
  beginOpfsTempTarget,
  removeOpfsTempTarget,
  requiredOpfsTempError,
} from './opfs-temp.js';

const MAGIC = new TextEncoder().encode('MME2E01\n');
const FORMAT = 'marshmallow-cloud-encrypted';
const VERSION = 1;
const DEFAULT_CHUNK_SIZE = 1024 * 1024;
const DEFAULT_ITERATIONS = 310000;
const HASH_READ_CHUNK_SIZE = 1024 * 1024;
const SHA256_INITIAL_STATE = Object.freeze([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);
const SHA256_ROUND_CONSTANTS = Object.freeze([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
  0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
  0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function getCrypto() {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.subtle) throw new Error('当前环境不支持 WebCrypto，无法加密云备份');
  return cryptoApi;
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  if (typeof btoa === 'function') return btoa(binary);
  return Buffer.from(bytes).toString('base64');
}

function base64ToBytes(value) {
  const binary = typeof atob === 'function'
    ? atob(String(value || ''))
    : Buffer.from(String(value || ''), 'base64').toString('binary');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function u32(value) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, false);
  return bytes;
}

function rotateRight(value, bits) {
  return (value >>> bits) | (value << (32 - bits));
}

class IncrementalSha256 {
  constructor() {
    this.state = SHA256_INITIAL_STATE.slice();
    this.pending = new Uint8Array(64);
    this.pendingLength = 0;
    this.bytes = 0;
    this.words = new Uint32Array(64);
  }

  processBlock(bytes, offset = 0) {
    const words = this.words;
    for (let index = 0; index < 16; index += 1) {
      const start = offset + (index * 4);
      words[index] = (
        (bytes[start] << 24)
        | (bytes[start + 1] << 16)
        | (bytes[start + 2] << 8)
        | bytes[start + 3]
      ) >>> 0;
    }
    for (let index = 16; index < 64; index += 1) {
      const before15 = words[index - 15];
      const before2 = words[index - 2];
      const sigma0 = rotateRight(before15, 7) ^ rotateRight(before15, 18) ^ (before15 >>> 3);
      const sigma1 = rotateRight(before2, 17) ^ rotateRight(before2, 19) ^ (before2 >>> 10);
      words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = this.state;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temp1 = (h + sum1 + choice + SHA256_ROUND_CONSTANTS[index] + words[index]) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    this.state[0] = (this.state[0] + a) >>> 0;
    this.state[1] = (this.state[1] + b) >>> 0;
    this.state[2] = (this.state[2] + c) >>> 0;
    this.state[3] = (this.state[3] + d) >>> 0;
    this.state[4] = (this.state[4] + e) >>> 0;
    this.state[5] = (this.state[5] + f) >>> 0;
    this.state[6] = (this.state[6] + g) >>> 0;
    this.state[7] = (this.state[7] + h) >>> 0;
  }

  update(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    this.bytes += bytes.byteLength;
    let offset = 0;
    if (this.pendingLength) {
      const needed = Math.min(64 - this.pendingLength, bytes.byteLength);
      this.pending.set(bytes.subarray(0, needed), this.pendingLength);
      this.pendingLength += needed;
      offset += needed;
      if (this.pendingLength === 64) {
        this.processBlock(this.pending);
        this.pendingLength = 0;
      }
    }
    while (offset + 64 <= bytes.byteLength) {
      this.processBlock(bytes, offset);
      offset += 64;
    }
    if (offset < bytes.byteLength) {
      this.pending.set(bytes.subarray(offset), 0);
      this.pendingLength = bytes.byteLength - offset;
    }
    return this;
  }

  digestHex() {
    const tailLength = this.pendingLength < 56 ? 64 : 128;
    const tail = new Uint8Array(tailLength);
    tail.set(this.pending.subarray(0, this.pendingLength));
    tail[this.pendingLength] = 0x80;
    const bitLengthHigh = Math.floor(this.bytes / 0x20000000);
    const bitLengthLow = (this.bytes * 8) >>> 0;
    const view = new DataView(tail.buffer);
    view.setUint32(tailLength - 8, bitLengthHigh, false);
    view.setUint32(tailLength - 4, bitLengthLow, false);
    for (let offset = 0; offset < tail.length; offset += 64) this.processBlock(tail, offset);
    return this.state.map((word) => word.toString(16).padStart(8, '0')).join('');
  }
}

function chunkIv(prefix, index) {
  if (!(prefix instanceof Uint8Array) || prefix.length !== 8) throw new Error('加密头部 IV 无效');
  const iv = new Uint8Array(12);
  iv.set(prefix, 0);
  new DataView(iv.buffer).setUint32(8, index, false);
  return iv;
}

async function deriveKey(passphrase, salt, iterations) {
  const cryptoApi = getCrypto();
  const password = String(passphrase || '');
  if (!password) throw new Error('请输入云备份加密密码');
  const material = await cryptoApi.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return cryptoApi.subtle.deriveKey({
    name: 'PBKDF2',
    hash: 'SHA-256',
    salt,
    iterations,
  }, material, {
    name: 'AES-GCM',
    length: 256,
  }, false, ['encrypt', 'decrypt']);
}

export async function sha256Hex(blobOrBuffer, options = {}) {
  const cryptoApi = getCrypto();
  if (blobOrBuffer instanceof Blob) {
    // subtle.digest 只接受完整输入；大资源包会因此额外复制整包并推高 WebView/WebKit
    // 内存峰值。这里逐片读取，让校验阶段的额外内存稳定在约 1 MB。
    const digest = new IncrementalSha256();
    options.onProgress?.({ loadedBytes: 0, totalBytes: blobOrBuffer.size });
    for (let offset = 0; offset < blobOrBuffer.size; offset += HASH_READ_CHUNK_SIZE) {
      const chunk = await blobOrBuffer
        .slice(offset, Math.min(blobOrBuffer.size, offset + HASH_READ_CHUNK_SIZE))
        .arrayBuffer();
      digest.update(chunk);
      options.onProgress?.({
        loadedBytes: Math.min(blobOrBuffer.size, offset + chunk.byteLength),
        totalBytes: blobOrBuffer.size,
      });
    }
    if (!blobOrBuffer.size) options.onProgress?.({ loadedBytes: 0, totalBytes: 0 });
    return digest.digestHex();
  }
  const input = ArrayBuffer.isView(blobOrBuffer)
    ? blobOrBuffer.buffer.slice(blobOrBuffer.byteOffset, blobOrBuffer.byteOffset + blobOrBuffer.byteLength)
    : blobOrBuffer;
  const digest = new Uint8Array(await cryptoApi.subtle.digest('SHA-256', input));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function beginEncryptedFileTarget({ required = false, label = '云备份加密' } = {}) {
  const random = getCrypto().getRandomValues(new Uint8Array(8));
  const suffix = [...random].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  const filename = `cloud-encrypted-${Date.now()}-${suffix}.mme`;
  return beginOpfsTempTarget(filename, { required, label });
}

async function removeEncryptedFileTarget(target) {
  await removeOpfsTempTarget(target);
}

/**
 * 版本化分块 AES-256-GCM 封装。每块使用随机 64-bit 前缀 + 32-bit 序号作为独立 IV，
 * PBKDF2 参数与 salt 仅写入本地生成的密文头部，密码及派生密钥不会离开设备。
 */
export async function encryptBackupBlob(blob, passphrase, options = {}) {
  if (!(blob instanceof Blob)) throw new Error('待加密内容不是 Blob');
  const cryptoApi = getCrypto();
  const chunkSize = Math.max(64 * 1024, Number(options.chunkSize) || DEFAULT_CHUNK_SIZE);
  const iterations = Math.max(100000, Number(options.iterations) || DEFAULT_ITERATIONS);
  const salt = cryptoApi.getRandomValues(new Uint8Array(16));
  const ivPrefix = cryptoApi.getRandomValues(new Uint8Array(8));
  const key = await deriveKey(passphrase, salt, iterations);
  const chunks = Math.max(1, Math.ceil(blob.size / chunkSize));
  const header = {
    format: FORMAT,
    version: VERSION,
    cipher: 'AES-256-GCM',
    kdf: {
      name: 'PBKDF2',
      hash: 'SHA-256',
      iterations,
      salt: bytesToBase64(salt),
    },
    chunkSize,
    chunks,
    ivPrefix: bytesToBase64(ivPrefix),
    plaintextSize: blob.size,
  };
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const target = options.preferFileBacked === true
    ? await beginEncryptedFileTarget({
      required: options.requireFileBacked === true,
      label: '云备份加密',
    })
    : null;
  if (!target && options.requireFileBacked === true) {
    throw requiredOpfsTempError('云备份加密');
  }
  const parts = target ? null : [MAGIC, u32(headerBytes.length), headerBytes];
  try {
    if (target) {
      await target.writable.write(MAGIC);
      await target.writable.write(u32(headerBytes.length));
      await target.writable.write(headerBytes);
    }
    options.onProgress?.({ loadedBytes: 0, totalBytes: blob.size });
    for (let index = 0; index < chunks; index += 1) {
      const start = index * chunkSize;
      const plain = await blob.slice(start, Math.min(blob.size, start + chunkSize)).arrayBuffer();
      const encrypted = await cryptoApi.subtle.encrypt({
        name: 'AES-GCM',
        iv: chunkIv(ivPrefix, index),
        additionalData: headerBytes,
        tagLength: 128,
      }, key, plain);
      const length = u32(encrypted.byteLength);
      if (target) {
        await target.writable.write(length);
        await target.writable.write(encrypted);
      } else {
        parts.push(length, encrypted);
      }
      options.onProgress?.({
        loadedBytes: Math.min(blob.size, start + plain.byteLength),
        totalBytes: blob.size,
      });
    }
    if (target) {
      await target.writable.close();
      const encryptedFile = await target.handle.getFile();
      return {
        blob: encryptedFile,
        header,
        cleanup: () => removeEncryptedFileTarget(target),
        fileBacked: true,
      };
    }
  } catch (error) {
    if (target) {
      try { await target.writable.abort(); } catch (_) { /* best effort */ }
      await removeEncryptedFileTarget(target);
    }
    throw error;
  }
  return {
    blob: new Blob(parts, { type: 'application/octet-stream' }),
    header,
    cleanup: null,
    fileBacked: false,
  };
}

export async function decryptBackupBlob(encryptedBlob, passphrase, options = {}) {
  if (!(encryptedBlob instanceof Blob)) throw new Error('密文内容不是 Blob');
  if (encryptedBlob.size < MAGIC.length + 4) throw new Error('云备份密文不完整');
  const prefix = new Uint8Array(await encryptedBlob.slice(0, MAGIC.length + 4).arrayBuffer());
  if (!MAGIC.every((byte, index) => prefix[index] === byte)) {
    throw new Error('不是受支持的棉花糖机加密备份');
  }
  const headerLength = new DataView(prefix.buffer, MAGIC.length, 4).getUint32(0, false);
  if (!headerLength || headerLength > 64 * 1024) throw new Error('云备份加密头部无效');
  const dataOffset = MAGIC.length + 4 + headerLength;
  if (dataOffset > encryptedBlob.size) throw new Error('云备份密文已损坏');
  const headerBytes = new Uint8Array(await encryptedBlob.slice(MAGIC.length + 4, dataOffset).arrayBuffer());
  let header;
  try {
    header = JSON.parse(new TextDecoder().decode(headerBytes));
  } catch (_) {
    throw new Error('云备份加密头部无法解析');
  }
  if (header?.format !== FORMAT || header?.version !== VERSION || header?.cipher !== 'AES-256-GCM') {
    throw new Error(`不支持的云备份加密版本：${header?.version ?? '未知'}`);
  }
  const salt = base64ToBytes(header.kdf?.salt);
  const ivPrefix = base64ToBytes(header.ivPrefix);
  const iterations = Number(header.kdf?.iterations);
  const chunks = Number(header.chunks);
  const plaintextSize = Number(header.plaintextSize);
  if (salt.length !== 16
    || ivPrefix.length !== 8
    || iterations < 100000
    || iterations > 2000000
    || !Number.isSafeInteger(chunks)
    || chunks < 1
    || chunks > Math.ceil(encryptedBlob.size / 16)
    || !Number.isSafeInteger(plaintextSize)
    || plaintextSize < 0) {
    throw new Error('云备份密码派生参数无效');
  }
  const key = await deriveKey(passphrase, salt, iterations);
  const target = options.preferFileBacked === true
    ? await beginEncryptedFileTarget({
      required: options.requireFileBacked === true,
      label: '云恢复解密',
    })
    : null;
  if (!target && options.requireFileBacked === true) {
    throw requiredOpfsTempError('云恢复解密');
  }
  const parts = target ? null : [];
  let offset = dataOffset;
  try {
    options.onProgress?.({ loadedBytes: 0, totalBytes: plaintextSize });
    let writtenBytes = 0;
    for (let index = 0; index < chunks; index += 1) {
      if (offset + 4 > encryptedBlob.size) throw new Error('密文分块缺失');
      const lenBytes = await encryptedBlob.slice(offset, offset + 4).arrayBuffer();
      const length = new DataView(lenBytes).getUint32(0, false);
      offset += 4;
      if (length < 16 || offset + length > encryptedBlob.size) throw new Error('密文分块长度无效');
      const encrypted = await encryptedBlob.slice(offset, offset + length).arrayBuffer();
      offset += length;
      const plain = await getCrypto().subtle.decrypt({
        name: 'AES-GCM',
        iv: chunkIv(ivPrefix, index),
        additionalData: headerBytes,
        tagLength: 128,
      }, key, encrypted);
      if (target) await target.writable.write(plain);
      else parts.push(plain);
      writtenBytes += plain.byteLength;
      options.onProgress?.({
        loadedBytes: Math.min(plaintextSize, writtenBytes),
        totalBytes: plaintextSize,
      });
    }
  } catch (error) {
    if (target) {
      try { await target.writable.abort(); } catch (_) { /* best effort */ }
      await removeEncryptedFileTarget(target);
    }
    if (/密文分块/.test(String(error?.message || ''))) throw error;
    throw new Error('解密失败：密码错误或云端文件已损坏');
  }
  if (offset !== encryptedBlob.size) {
    if (target) {
      try { await target.writable.abort(); } catch (_) { /* best effort */ }
      await removeEncryptedFileTarget(target);
    }
    throw new Error('云备份密文包含异常尾部数据');
  }
  let blob;
  if (target) {
    await target.writable.close();
    blob = await target.handle.getFile();
  } else {
    blob = new Blob(parts, { type: 'application/json;charset=utf-8' });
  }
  if (blob.size !== plaintextSize) {
    if (target) await removeEncryptedFileTarget(target);
    throw new Error('解密后的文件大小校验失败');
  }
  return {
    blob,
    header,
    cleanup: target ? () => removeEncryptedFileTarget(target) : null,
    fileBacked: !!target,
  };
}

export const BACKUP_ENCRYPTION_FORMAT = FORMAT;
export const BACKUP_ENCRYPTION_VERSION = VERSION;
