// Lossless JPEG cropping in the DCT domain (what `jpegtran -crop` does).
//
// Chrome's screencast frames are already JPEG. Decoding them to pixels and encoding each
// changed tile again costs CPU and compresses the image a second time. Instead, the
// frame's entropy data is decoded to quantized DCT coefficients only (no IDCT), tiles are
// compared on those, and a tile is written out as a new JPEG from the same coefficients
// and quantization tables. The device then decodes exactly what Chrome encoded.
//
// Supported: baseline/extended sequential Huffman JPEG, 8-bit, 3 components in one
// interleaved scan, no restart intervals (Chrome writes none). Anything else returns null
// and the caller falls back to decoding with sharp. Rotation by quarter turns is lossless
// too (rotateJpegBlocks), for images that are a whole number of MCUs.

export type JpegComponent = {
  id: number;
  h: number; // horizontal sampling factor
  v: number; // vertical sampling factor
  tq: number; // quantization table id
};

export type JpegBlocks = {
  width: number;
  height: number;
  // MCU size in pixels (16x16 for 4:2:0, 8x8 for 4:4:4)
  mcuW: number;
  mcuH: number;
  mcusX: number;
  mcusY: number;
  components: JpegComponent[];
  // 8x8 blocks per MCU (6 for 4:2:0)
  blocksPerMcu: number;
  // Quantized coefficients in zigzag order, DC as an absolute value (not a difference).
  // Laid out MCU by MCU (row-major); inside an MCU, component by component in SOF order,
  // each component's blocks row-major. One MCU is blocksPerMcu * 64 values.
  coef: Int16Array;
  // DQT segments of the source, copied into every tile.
  dqt: Buffer[];
};

type HuffDecodeTable = {
  look: Uint16Array; // 9-bit lookahead: (length << 8) | value, 0 = not a short code
  maxcode: Int32Array; // per code length 1..16, -1 if none
  mincode: Int32Array;
  valptr: Int32Array;
  vals: Uint8Array;
};

const LOOKAHEAD = 9;

function buildDecodeTable(bits: Uint8Array, vals: Uint8Array): HuffDecodeTable {
  const maxcode = new Int32Array(18).fill(-1);
  const mincode = new Int32Array(17);
  const valptr = new Int32Array(17);
  const look = new Uint16Array(1 << LOOKAHEAD);
  let code = 0, k = 0;
  for (let l = 1; l <= 16; l++) {
    const n = bits[l - 1];
    valptr[l] = k;
    mincode[l] = code;
    if (n) {
      maxcode[l] = code + n - 1;
      if (l <= LOOKAHEAD) {
        for (let c = code; c < code + n; c++) {
          const entry = (l << 8) | vals[k + c - code];
          const base = c << (LOOKAHEAD - l);
          look.fill(entry, base, base + (1 << (LOOKAHEAD - l)));
        }
      }
    }
    code += n;
    k += n;
    code <<= 1;
  }
  maxcode[17] = 0x7fffffff; // sentinel: a corrupt stream throws instead of looping
  return { look, maxcode, mincode, valptr, vals };
}

class BitReader {
  private _acc = 0; // the low _n bits are unread
  private _n = 0;
  private _atMarker = false;
  // Zero bytes fed after the end of the entropy data. The lookahead reads at most 4 bytes
  // ahead; more means the data ran out (a truncated frame).
  padBytes = 0;

  constructor(private _data: Buffer, public pos: number) { }

  private _fill(): void {
    const d = this._data;
    while (this._n <= 24) {
      let b = 0;
      if (this._atMarker || this.pos >= d.length) this.padBytes++;
      else {
        b = d[this.pos++];
        if (b === 0xFF) {
          if (d[this.pos] === 0x00) this.pos++; // stuffed byte
          else { this._atMarker = true; this.pos--; b = 0; this.padBytes++; }
        }
      }
      this._acc = ((this._acc << 8) | b) >>> 0;
      this._n += 8;
    }
  }

  bits(k: number): number {
    if (k === 0) return 0;
    if (this._n < k) this._fill();
    this._n -= k;
    const v = this._acc >>> this._n;
    this._acc = this._n === 0 ? 0 : (this._acc & (0xFFFFFFFF >>> (32 - this._n))) >>> 0;
    return v;
  }

  decode(t: HuffDecodeTable): number {
    if (this._n < 16) this._fill();
    const e = t.look[this._acc >>> (this._n - LOOKAHEAD)];
    if (e !== 0) {
      this.bits(e >> 8);
      return e & 0xFF;
    }
    const code16 = this._acc >>> (this._n - 16);
    let l = LOOKAHEAD + 1;
    let code = code16 >>> (16 - l);
    while (code > t.maxcode[l]) {
      l++;
      if (l > 16) throw new Error("bad Huffman code");
      code = code16 >>> (16 - l);
    }
    this.bits(l);
    return t.vals[t.valptr[l] + code - t.mincode[l]];
  }
}

function extend(v: number, s: number): number {
  return v < (1 << (s - 1)) ? v - (1 << s) + 1 : v;
}

// Decodes a JPEG to quantized DCT coefficients. Returns null for unsupported or corrupt input.
export function decodeJpegBlocks(buf: Buffer): JpegBlocks | null {
  try {
    return _decode(buf);
  } catch {
    return null;
  }
}

function _decode(buf: Buffer): JpegBlocks | null {
  if (buf.length < 4 || buf[0] !== 0xFF || buf[1] !== 0xD8) return null;

  const dqt: Buffer[] = [];
  const dcTables: (HuffDecodeTable | undefined)[] = [];
  const acTables: (HuffDecodeTable | undefined)[] = [];
  let components: JpegComponent[] | undefined;
  let width = 0, height = 0;

  let off = 2;
  for (;;) {
    if (off + 4 > buf.length || buf[off] !== 0xFF) return null;
    const marker = buf[off + 1];
    if (marker === 0xFF) { off++; continue; }
    const len = buf.readUInt16BE(off + 2);
    const seg = off + 4, segEnd = off + 2 + len;
    if (segEnd > buf.length) return null;

    if (marker === 0xDB) {
      dqt.push(buf.subarray(off, segEnd));
    } else if (marker === 0xC0 || marker === 0xC1) {
      if (buf[seg] !== 8) return null;
      height = buf.readUInt16BE(seg + 1);
      width = buf.readUInt16BE(seg + 3);
      const nc = buf[seg + 5];
      if (nc !== 3 || width === 0 || height === 0) return null;
      components = [];
      for (let i = 0; i < nc; i++) {
        const p = seg + 6 + i * 3;
        components.push({ id: buf[p], h: buf[p + 1] >> 4, v: buf[p + 1] & 15, tq: buf[p + 2] });
      }
    } else if (marker >= 0xC2 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
      return null; // progressive, lossless or arithmetic coding
    } else if (marker === 0xC4) {
      let p = seg;
      while (p < segEnd) {
        const tc = buf[p] >> 4, th = buf[p] & 15;
        const bits = buf.subarray(p + 1, p + 17);
        let n = 0;
        for (let i = 0; i < 16; i++) n += bits[i];
        const vals = buf.subarray(p + 17, p + 17 + n);
        (tc === 0 ? dcTables : acTables)[th] = buildDecodeTable(bits, vals);
        p += 17 + n;
      }
    } else if (marker === 0xDD) {
      if (buf.readUInt16BE(seg) !== 0) return null; // restart intervals
    } else if (marker === 0xDA) {
      if (!components) return null;
      const ns = buf[seg];
      if (ns !== components.length) return null; // non-interleaved scans
      const dcSel: HuffDecodeTable[] = [], acSel: HuffDecodeTable[] = [];
      for (let i = 0; i < ns; i++) {
        const cid = buf[seg + 1 + i * 2], sel = buf[seg + 2 + i * 2];
        if (components[i].id !== cid) return null;
        const dc = dcTables[sel >> 4], ac = acTables[sel & 15];
        if (!dc || !ac) return null;
        dcSel.push(dc); acSel.push(ac);
      }
      return _decodeScan(buf, segEnd, width, height, components, dcSel, acSel, dqt);
    } else if (marker === 0xD9) {
      return null;
    }
    off = segEnd;
  }
}

function _decodeScan(
  buf: Buffer, start: number, width: number, height: number, components: JpegComponent[],
  dcSel: HuffDecodeTable[], acSel: HuffDecodeTable[], dqt: Buffer[],
): JpegBlocks | null {
  let hmax = 0, vmax = 0, blocksPerMcu = 0;
  for (const c of components) {
    if (c.h < 1 || c.v < 1) return null;
    hmax = Math.max(hmax, c.h);
    vmax = Math.max(vmax, c.v);
    blocksPerMcu += c.h * c.v;
  }
  if (blocksPerMcu > 10) return null;
  const mcuW = 8 * hmax, mcuH = 8 * vmax;
  const mcusX = Math.ceil(width / mcuW), mcusY = Math.ceil(height / mcuH);
  const mcuCount = mcusX * mcusY;

  const coef = new Int16Array(mcuCount * blocksPerMcu * 64);
  const rd = new BitReader(buf, start);
  const pred = new Int32Array(components.length);
  // Component index of each block in an MCU.
  const blockComp: number[] = [];
  components.forEach((c, i) => { for (let b = 0; b < c.h * c.v; b++) blockComp.push(i); });

  let o = 0;
  for (let m = 0; m < mcuCount; m++) {
    for (let b = 0; b < blocksPerMcu; b++, o += 64) {
      const ci = blockComp[b];
      const t = rd.decode(dcSel[ci]);
      const diff = t ? extend(rd.bits(t), t) : 0;
      pred[ci] += diff;
      coef[o] = pred[ci];
      const ac = acSel[ci];
      for (let k = 1; k < 64;) {
        const rs = rd.decode(ac);
        const r = rs >> 4, s = rs & 15;
        if (s) {
          k += r;
          if (k > 63) throw new Error("coefficient index out of range");
          coef[o + k] = extend(rd.bits(s), s);
          k++;
        } else if (r === 15) {
          k += 16;
        } else {
          break;
        }
      }
    }
  }

  if (rd.padBytes > 4) return null;
  return { width, height, mcuW, mcuH, mcusX, mcusY, components, blocksPerMcu, coef, dqt };
}

// ---------------------------------------------------------------------------------------
// Lossless rotation (what `jpegtran -rotate` does)

// Natural (row-major, row = vertical frequency) index of each zigzag position.
const NATURAL_ORDER = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5,
  12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51,
  58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
];
const ZIGZAG_OF = new Int32Array(64);
NATURAL_ORDER.forEach((n, k) => { ZIGZAG_OF[n] = k; });

// For each output zigzag position: the input zigzag position it comes from, and the sign.
// Rotating a block's pixels maps to moving and negating its DCT coefficients:
//  90° clockwise = transpose, then mirror horizontally: out[v][u] = (-1)^u in[u][v]
// 180°           = mirror both ways:                  out[v][u] = (-1)^(u+v) in[v][u]
// 270° clockwise = transpose, then mirror vertically:   out[v][u] = (-1)^v in[u][v]
function coefficientMap(rotation: 90 | 180 | 270): { src: Int32Array; neg: Uint8Array } {
  const src = new Int32Array(64), neg = new Uint8Array(64);
  for (let k = 0; k < 64; k++) {
    const n = NATURAL_ORDER[k], v = n >> 3, u = n & 7;
    const transposed = rotation !== 180;
    src[k] = ZIGZAG_OF[transposed ? u * 8 + v : n];
    neg[k] = (rotation === 90 ? u : rotation === 270 ? v : u + v) & 1;
  }
  return { src, neg };
}
const COEF_MAPS = { 90: coefficientMap(90), 180: coefficientMap(180), 270: coefficientMap(270) };

// Quantization tables follow their coefficients: transposed for a quarter turn.
function transposeDqt(seg: Buffer): Buffer {
  const out = Buffer.from(seg);
  let p = 4;
  while (p < out.length) {
    const wide = out[p] >> 4 ? 2 : 1;
    for (let k = 0; k < 64; k++) {
      const n = NATURAL_ORDER[k];
      const from = ZIGZAG_OF[(n & 7) * 8 + (n >> 3)];
      for (let b = 0; b < wide; b++) out[p + 1 + k * wide + b] = seg[p + 1 + from * wide + b];
    }
    p += 1 + 64 * wide;
  }
  return out;
}

// Rotates the image clockwise by moving and sign-flipping DCT coefficients; no pixel is
// decoded, so nothing is lost. Returns null when the image isn't a whole number of MCUs:
// the padding of the right/bottom edge would end up on the left/top.
export function rotateJpegBlocks(img: JpegBlocks, rotation: 90 | 180 | 270): JpegBlocks | null {
  if (img.width % img.mcuW !== 0 || img.height % img.mcuH !== 0) return null;
  const quarter = rotation !== 180;
  const { src: map, neg } = COEF_MAPS[rotation];
  const comps = img.components;
  const outComps = quarter ? comps.map(c => ({ ...c, h: c.v, v: c.h })) : comps;
  const outMcusX = quarter ? img.mcusY : img.mcusX;
  const bpm = img.blocksPerMcu;
  const coef = img.coef;
  const out = new Int16Array(coef.length);

  let compOff = 0;
  for (let ci = 0; ci < comps.length; ci++) {
    const { h, v } = comps[ci];
    const oh = outComps[ci].h, ov = outComps[ci].v;
    const bw = img.mcusX * h, bh = img.mcusY * v; // this component's plane, in blocks
    for (let by = 0; by < bh; by++) {
      for (let bx = 0; bx < bw; bx++) {
        const s = ((((by / v) | 0) * img.mcusX + ((bx / h) | 0)) * bpm + compOff + (by % v) * h + (bx % h)) * 64;
        let ox: number, oy: number;
        if (rotation === 90) { ox = bh - 1 - by; oy = bx; }
        else if (rotation === 270) { ox = by; oy = bw - 1 - bx; }
        else { ox = bw - 1 - bx; oy = bh - 1 - by; }
        const d = ((((oy / ov) | 0) * outMcusX + ((ox / oh) | 0)) * bpm + compOff + (oy % ov) * oh + (ox % oh)) * 64;
        for (let k = 0; k < 64; k++) {
          const c = coef[s + map[k]];
          out[d + k] = neg[k] ? -c : c;
        }
      }
    }
    compOff += h * v;
  }

  return {
    width: quarter ? img.height : img.width,
    height: quarter ? img.width : img.height,
    mcuW: quarter ? img.mcuH : img.mcuW,
    mcuH: quarter ? img.mcuW : img.mcuH,
    mcusX: outMcusX,
    mcusY: quarter ? img.mcusX : img.mcusY,
    components: outComps,
    blocksPerMcu: bpm,
    coef: out,
    dqt: quarter ? img.dqt.map(transposeDqt) : img.dqt,
  };
}

// ---------------------------------------------------------------------------------------
// Encoding

type HuffEncodeTable = { code: Uint16Array; size: Uint8Array; bits: Uint8Array; vals: Uint8Array };

// Optimal code lengths for the given symbol frequencies, limited to 16 bits
// (ITU T.81 Annex K.2, as in libjpeg's jpeg_gen_optimal_table).
function buildOptimalTable(freqIn: Uint32Array): HuffEncodeTable {
  const freq = new Float64Array(257);
  for (let i = 0; i < 256; i++) freq[i] = freqIn[i];
  freq[256] = 1; // reserved so no code is all ones
  const codesize = new Int32Array(257);
  const others = new Int32Array(257).fill(-1);

  for (;;) {
    let c1 = -1, v = Infinity;
    for (let i = 0; i <= 256; i++) if (freq[i] && freq[i] <= v) { v = freq[i]; c1 = i; }
    let c2 = -1; v = Infinity;
    for (let i = 0; i <= 256; i++) if (freq[i] && freq[i] <= v && i !== c1) { v = freq[i]; c2 = i; }
    if (c2 < 0) break;
    freq[c1] += freq[c2];
    freq[c2] = 0;
    codesize[c1]++;
    while (others[c1] >= 0) { c1 = others[c1]; codesize[c1]++; }
    others[c1] = c2;
    codesize[c2]++;
    while (others[c2] >= 0) { c2 = others[c2]; codesize[c2]++; }
  }

  const bitsN = new Int32Array(33);
  for (let i = 0; i <= 256; i++) if (codesize[i]) bitsN[codesize[i]]++;
  for (let i = 32; i > 16; i--) {
    while (bitsN[i] > 0) {
      let j = i - 2;
      while (bitsN[j] === 0) j--;
      bitsN[i] -= 2;
      bitsN[i - 1]++;
      bitsN[j + 1] += 2;
      bitsN[j]--;
    }
  }
  let i = 16;
  while (bitsN[i] === 0) i--;
  bitsN[i]--; // drop the reserved symbol

  const bits = new Uint8Array(16);
  for (let l = 1; l <= 16; l++) bits[l - 1] = bitsN[l];
  const valsArr: number[] = [];
  for (let l = 1; l <= 32; l++)
    for (let s = 0; s < 256; s++) if (codesize[s] === l) valsArr.push(s);
  const vals = Uint8Array.from(valsArr.slice(0, bits.reduce((a, b) => a + b, 0)));

  // Canonical codes (Annex C).
  const code = new Uint16Array(256), size = new Uint8Array(256);
  let c = 0, k = 0;
  for (let l = 1; l <= 16; l++) {
    for (let n = 0; n < bits[l - 1]; n++, k++) {
      code[vals[k]] = c++;
      size[vals[k]] = l;
    }
    c <<= 1;
  }
  return { code, size, bits, vals };
}

class BitWriter {
  private _buf: Buffer;
  private _pos = 0;
  private _acc = 0;
  private _n = 0;

  constructor(capacity: number) {
    this._buf = Buffer.allocUnsafe(Math.max(64, capacity));
  }

  private _byte(b: number): void {
    if (this._pos + 2 > this._buf.length) {
      const nb = Buffer.allocUnsafe(this._buf.length * 2);
      this._buf.copy(nb, 0, 0, this._pos);
      this._buf = nb;
    }
    this._buf[this._pos++] = b;
    if (b === 0xFF) this._buf[this._pos++] = 0x00;
  }

  write(value: number, n: number): void {
    // n <= 16, so _acc never holds more than 23 bits
    this._acc = (this._acc << n) | (value & ((1 << n) - 1));
    this._n += n;
    while (this._n >= 8) {
      this._n -= 8;
      this._byte((this._acc >>> this._n) & 0xFF);
    }
    this._acc &= (1 << this._n) - 1;
  }

  finish(): Buffer {
    if (this._n > 0) this.write(0x7F, 8 - this._n); // pad with ones
    return this._buf.subarray(0, this._pos);
  }
}

function category(v: number): number {
  return v === 0 ? 0 : 32 - Math.clz32(v < 0 ? -v : v);
}

// Calls emit(table, symbol, extraBits, extraLen) for every Huffman symbol of a block.
type Emit = (t: number, sym: number, extra: number, extraLen: number) => void;

function emitBlock(coef: Int16Array, o: number, dcDiff: number, t: number, emit: Emit): void {
  const s = category(dcDiff);
  emit(t * 2, s, dcDiff < 0 ? dcDiff - 1 : dcDiff, s);
  let run = 0;
  for (let k = 1; k < 64; k++) {
    const v = coef[o + k];
    if (v === 0) { run++; continue; }
    while (run > 15) { emit(t * 2 + 1, 0xF0, 0, 0); run -= 16; }
    const sz = category(v);
    emit(t * 2 + 1, (run << 4) | sz, v < 0 ? v - 1 : v, sz);
    run = 0;
  }
  if (run > 0) emit(t * 2 + 1, 0x00, 0, 0); // EOB
}

// Writes the MCUs [mx, mx+mw) x [my, my+mh) as a standalone JPEG of pxW x pxH pixels
// (pxW/pxH are smaller than the MCU area only where the box reaches the image edge).
// Huffman tables are built for the tile, like sharp's optimiseCoding.
export function encodeJpegBlocks(img: JpegBlocks, mx: number, my: number, mw: number, mh: number, pxW: number, pxH: number): Buffer {
  const { coef, blocksPerMcu, components } = img;
  const mcuStride = blocksPerMcu * 64;
  // Table set per block: 0 = luma (first component), 1 = chroma.
  const blockTable: number[] = [];
  const blockComp: number[] = [];
  components.forEach((c, i) => {
    for (let b = 0; b < c.h * c.v; b++) { blockTable.push(i === 0 ? 0 : 1); blockComp.push(i); }
  });

  const walk = (emit: Emit) => {
    const pred = [0, 0, 0];
    for (let y = my; y < my + mh; y++) {
      for (let x = mx; x < mx + mw; x++) {
        let o = (y * img.mcusX + x) * mcuStride;
        for (let b = 0; b < blocksPerMcu; b++, o += 64) {
          const ci = blockComp[b];
          const dc = coef[o];
          emitBlock(coef, o, dc - pred[ci], blockTable[b], emit);
          pred[ci] = dc;
        }
      }
    }
  };

  // Pass 1: symbol frequencies for the four tables (DC0, AC0, DC1, AC1).
  const freqs = [0, 1, 2, 3].map(() => new Uint32Array(256));
  walk((t, sym) => { freqs[t][sym]++; });
  const tables = freqs.map(buildOptimalTable);

  // Pass 2: entropy data.
  const bw = new BitWriter(mw * mh * blocksPerMcu * 16);
  walk((t, sym, extra, extraLen) => {
    const tb = tables[t];
    bw.write(tb.code[sym], tb.size[sym]);
    if (extraLen) bw.write(extra, extraLen);
  });
  const scan = bw.finish();

  // Headers, in the same layout as sharp's output: DQT, SOF0, DHT x4, SOS.
  const parts: Buffer[] = [Buffer.from([0xFF, 0xD8]), ...img.dqt];

  const sof = Buffer.alloc(2 + 8 + 3 * components.length);
  sof.writeUInt16BE(0xFFC0, 0);
  sof.writeUInt16BE(8 + 3 * components.length, 2);
  sof[4] = 8;
  sof.writeUInt16BE(pxH, 5);
  sof.writeUInt16BE(pxW, 7);
  sof[9] = components.length;
  components.forEach((c, i) => {
    sof[10 + i * 3] = c.id;
    sof[11 + i * 3] = (c.h << 4) | c.v;
    sof[12 + i * 3] = c.tq;
  });
  parts.push(sof);

  // DC0, AC0, DC1, AC1 -> class/id
  const ids = [0x00, 0x10, 0x01, 0x11];
  tables.forEach((t, i) => {
    const seg = Buffer.alloc(2 + 2 + 1 + 16 + t.vals.length);
    seg.writeUInt16BE(0xFFC4, 0);
    seg.writeUInt16BE(seg.length - 2, 2);
    seg[4] = ids[i];
    seg.set(t.bits, 5);
    seg.set(t.vals, 21);
    parts.push(seg);
  });

  const sos = Buffer.alloc(2 + 6 + 2 * components.length);
  sos.writeUInt16BE(0xFFDA, 0);
  sos.writeUInt16BE(6 + 2 * components.length, 2);
  sos[4] = components.length;
  components.forEach((c, i) => {
    sos[5 + i * 2] = c.id;
    sos[6 + i * 2] = i === 0 ? 0x00 : 0x11;
  });
  sos[5 + 2 * components.length] = 0;    // Ss
  sos[6 + 2 * components.length] = 63;   // Se
  sos[7 + 2 * components.length] = 0;    // Ah/Al
  parts.push(sos, scan, Buffer.from([0xFF, 0xD9]));

  return Buffer.concat(parts);
}
