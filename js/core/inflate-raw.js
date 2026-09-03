/**
 * ZIP / DOCX 等使用的 deflate-raw 解压。
 * 优先原生 DecompressionStream('deflate-raw')；
 * 部分 Android WebView 有 DecompressionStream 但不支持该格式，此时走纯 JS
 *（基于 tiny-inflate，MIT）。
 */

const TINF_OK = 0;
const TINF_DATA_ERROR = -3;

let nativeDeflateRawSupport = null;
let tablesReady = false;

/** 探测是否真正支持 'deflate-raw'（不只是有 DecompressionStream） */
export function supportsNativeDeflateRaw() {
  if (nativeDeflateRawSupport != null) return nativeDeflateRawSupport;
  if (typeof DecompressionStream === 'undefined') {
    nativeDeflateRawSupport = false;
    return false;
  }
  try {
    new DecompressionStream('deflate-raw');
    nativeDeflateRawSupport = true;
  } catch {
    nativeDeflateRawSupport = false;
  }
  return nativeDeflateRawSupport;
}

async function inflateRawNative(bytes) {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function Tree() {
  this.table = new Uint16Array(16);
  this.trans = new Uint16Array(288);
}

function Data(source, dest) {
  this.source = source;
  this.sourceIndex = 0;
  this.tag = 0;
  this.bitcount = 0;
  this.dest = dest;
  this.destLen = 0;
  this.ltree = new Tree();
  this.dtree = new Tree();
}

const sltree = new Tree();
const sdtree = new Tree();
const lengthBits = new Uint8Array(30);
const lengthBase = new Uint16Array(30);
const distBits = new Uint8Array(30);
const distBase = new Uint16Array(30);
const clcidx = new Uint8Array([
  16, 17, 18, 0, 8, 7, 9, 6,
  10, 5, 11, 4, 12, 3, 13, 2,
  14, 1, 15,
]);
const codeTree = new Tree();
const lengths = new Uint8Array(288 + 32);
const offs = new Uint16Array(16);

function ensureDest(d, need) {
  if (d.destLen + need <= d.dest.length) return;
  let next = d.dest.length;
  while (d.destLen + need > next) next *= 2;
  const bigger = new Uint8Array(next);
  bigger.set(d.dest.subarray(0, d.destLen));
  d.dest = bigger;
}

function tinfBuildBitsBase(bits, base, delta, first) {
  let i;
  let sum;
  for (i = 0; i < delta; i += 1) bits[i] = 0;
  for (i = 0; i < 30 - delta; i += 1) bits[i + delta] = (i / delta) | 0;
  for (sum = first, i = 0; i < 30; i += 1) {
    base[i] = sum;
    sum += 1 << bits[i];
  }
}

function tinfBuildFixedTrees(lt, dt) {
  let i;
  for (i = 0; i < 7; i += 1) lt.table[i] = 0;
  lt.table[7] = 24;
  lt.table[8] = 152;
  lt.table[9] = 112;
  for (i = 0; i < 24; i += 1) lt.trans[i] = 256 + i;
  for (i = 0; i < 144; i += 1) lt.trans[24 + i] = i;
  for (i = 0; i < 8; i += 1) lt.trans[24 + 144 + i] = 280 + i;
  for (i = 0; i < 112; i += 1) lt.trans[24 + 144 + 8 + i] = 144 + i;
  for (i = 0; i < 5; i += 1) dt.table[i] = 0;
  dt.table[5] = 32;
  for (i = 0; i < 32; i += 1) dt.trans[i] = i;
}

function tinfBuildTree(t, lens, off, num) {
  let i;
  let sum;
  for (i = 0; i < 16; i += 1) t.table[i] = 0;
  for (i = 0; i < num; i += 1) t.table[lens[off + i]] += 1;
  t.table[0] = 0;
  for (sum = 0, i = 0; i < 16; i += 1) {
    offs[i] = sum;
    sum += t.table[i];
  }
  for (i = 0; i < num; i += 1) {
    if (lens[off + i]) t.trans[offs[lens[off + i]]++] = i;
  }
}

function ensureTables() {
  if (tablesReady) return;
  tinfBuildFixedTrees(sltree, sdtree);
  tinfBuildBitsBase(lengthBits, lengthBase, 4, 3);
  tinfBuildBitsBase(distBits, distBase, 2, 1);
  lengthBits[28] = 0;
  lengthBase[28] = 258;
  tablesReady = true;
}

function tinfGetbit(d) {
  if (!d.bitcount--) {
    d.tag = d.source[d.sourceIndex++];
    d.bitcount = 7;
  }
  const bit = d.tag & 1;
  d.tag >>>= 1;
  return bit;
}

function tinfReadBits(d, num, base) {
  if (!num) return base;
  while (d.bitcount < 24) {
    d.tag |= d.source[d.sourceIndex++] << d.bitcount;
    d.bitcount += 8;
  }
  const val = d.tag & (0xffff >>> (16 - num));
  d.tag >>>= num;
  d.bitcount -= num;
  return val + base;
}

function tinfDecodeSymbol(d, t) {
  while (d.bitcount < 24) {
    d.tag |= d.source[d.sourceIndex++] << d.bitcount;
    d.bitcount += 8;
  }
  let sum = 0;
  let cur = 0;
  let len = 0;
  let tag = d.tag;
  do {
    cur = 2 * cur + (tag & 1);
    tag >>>= 1;
    len += 1;
    sum += t.table[len];
    cur -= t.table[len];
  } while (cur >= 0);
  d.tag = tag;
  d.bitcount -= len;
  return t.trans[sum + cur];
}

function tinfDecodeTrees(d, lt, dt) {
  const hlit = tinfReadBits(d, 5, 257);
  const hdist = tinfReadBits(d, 5, 1);
  const hclen = tinfReadBits(d, 4, 4);
  let i;
  for (i = 0; i < 19; i += 1) lengths[i] = 0;
  for (i = 0; i < hclen; i += 1) {
    lengths[clcidx[i]] = tinfReadBits(d, 3, 0);
  }
  tinfBuildTree(codeTree, lengths, 0, 19);
  let num = 0;
  while (num < hlit + hdist) {
    const sym = tinfDecodeSymbol(d, codeTree);
    let length;
    switch (sym) {
      case 16: {
        const prev = lengths[num - 1];
        for (length = tinfReadBits(d, 2, 3); length; length -= 1) lengths[num++] = prev;
        break;
      }
      case 17:
        for (length = tinfReadBits(d, 3, 3); length; length -= 1) lengths[num++] = 0;
        break;
      case 18:
        for (length = tinfReadBits(d, 7, 11); length; length -= 1) lengths[num++] = 0;
        break;
      default:
        lengths[num++] = sym;
        break;
    }
  }
  tinfBuildTree(lt, lengths, 0, hlit);
  tinfBuildTree(dt, lengths, hlit, hdist);
}

function tinfInflateBlockData(d, lt, dt) {
  for (;;) {
    let sym = tinfDecodeSymbol(d, lt);
    if (sym === 256) return TINF_OK;
    if (sym < 256) {
      ensureDest(d, 1);
      d.dest[d.destLen++] = sym;
    } else {
      sym -= 257;
      const length = tinfReadBits(d, lengthBits[sym], lengthBase[sym]);
      const dist = tinfDecodeSymbol(d, dt);
      const copyOff = d.destLen - tinfReadBits(d, distBits[dist], distBase[dist]);
      ensureDest(d, length);
      for (let i = copyOff; i < copyOff + length; i += 1) {
        d.dest[d.destLen++] = d.dest[i];
      }
    }
  }
}

function tinfInflateUncompressedBlock(d) {
  while (d.bitcount > 8) {
    d.sourceIndex -= 1;
    d.bitcount -= 8;
  }
  let length = d.source[d.sourceIndex + 1];
  length = 256 * length + d.source[d.sourceIndex];
  let invlength = d.source[d.sourceIndex + 3];
  invlength = 256 * invlength + d.source[d.sourceIndex + 2];
  if (length !== (~invlength & 0xffff)) return TINF_DATA_ERROR;
  d.sourceIndex += 4;
  ensureDest(d, length);
  for (let i = length; i; i -= 1) d.dest[d.destLen++] = d.source[d.sourceIndex++];
  d.bitcount = 0;
  return TINF_OK;
}

/** 纯 JS deflate-raw 解压 */
export function inflateRawSync(src) {
  ensureTables();
  const source = src instanceof Uint8Array ? src : new Uint8Array(src);
  const dest = new Uint8Array(Math.max(source.length * 4, 1024));
  const d = new Data(source, dest);
  let bfinal;
  do {
    bfinal = tinfGetbit(d);
    const btype = tinfReadBits(d, 2, 0);
    let res = TINF_OK;
    switch (btype) {
      case 0:
        res = tinfInflateUncompressedBlock(d);
        break;
      case 1:
        res = tinfInflateBlockData(d, sltree, sdtree);
        break;
      case 2:
        tinfDecodeTrees(d, d.ltree, d.dtree);
        res = tinfInflateBlockData(d, d.ltree, d.dtree);
        break;
      default:
        res = TINF_DATA_ERROR;
    }
    if (res !== TINF_OK) throw new Error('deflate 数据损坏');
  } while (!bfinal);
  return d.dest.subarray(0, d.destLen);
}

/**
 * @param {Uint8Array|ArrayBuffer} bytes
 * @param {string} [unsupportedMessage]
 * @returns {Promise<Uint8Array>}
 */
export async function inflateRaw(bytes, unsupportedMessage) {
  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (supportsNativeDeflateRaw()) {
    try {
      return await inflateRawNative(input);
    } catch {
      // 原生偶发失败时继续纯 JS
    }
  }
  try {
    return inflateRawSync(input);
  } catch {
    throw new Error(
      unsupportedMessage
        || '当前环境无法解压该文件，请改用未压缩格式或更新系统浏览器组件',
    );
  }
}
