import sharp from "sharp";
import { Encoding, FRAME_HEADER_BYTES, TILE_HEADER_BYTES } from "./protocol.js";
import { JpegBlocks, encodeJpegBlocks } from "./jpegBlocks.js";

// One libvips thread per image: the boxes of a frame are already encoded in parallel on the
// libuv thread pool, and splitting each small box across more threads costs more than it
// saves (measured ~25% more server CPU at cores-1, same latency). It is also sharp's own
// default on glibc without jemalloc (the Docker image), to limit memory fragmentation.
sharp.concurrency(1);

// Packed RGB, no alpha: 25% less to decode, compare and encode than RGB.
export type RGB = { data: Buffer; width: number; height: number };
export const BPP = 3; // bytes per pixel

// A frame that is already JPEG, decoded only to DCT coefficients (see jpegBlocks.ts).
// Changed tiles are cut out of it without being compressed again. `blocks` are already
// rotated by `rotation`; `jpeg` is the frame as captured.
export type JpegFrame = { width: number; height: number; jpeg: Buffer; blocks: JpegBlocks; rotation: number };

function isJpegFrame(f: RGB | JpegFrame): f is JpegFrame {
  return (f as JpegFrame).blocks !== undefined;
}

export type Rect = { x: number; y: number; w: number; h: number; data: Buffer };

export type FrameOut = {
  rects: Rect[];
  isFullFrame: boolean;
  encoding: Encoding;
};

export type FrameProcessorCfg = {
  tileSize: number;
  fullframeTileCount: number;
  fullframeAreaThreshold: number;
  jpegQuality: number;
  fullFrameEvery: number;
  maxBytesPerMessage: number;
};

type Box = { x: number; y: number; w: number; h: number };

// Split point for oversized rects: a multiple of the JPEG MCU size keeps tiles friendly to HW decoders.
const SPLIT_ALIGN = 16;

export class FrameProcessor {
  private _cfg: FrameProcessorCfg;
  private _cols = 0;
  private _rows = 0;
  // Grid geometry, fixed for a frame size (see _initGrid).
  private _colX = new Int32Array(0);
  private _colW = new Int32Array(0);
  private _rowY = new Int32Array(0);
  private _rowH = new Int32Array(0);
  // Largest box a partial frame may merge tiles into: the size of a full-frame part.
  private _maxBoxW = 0;
  private _maxBoxH = 0;
  // Per-tile flags, row-major, reused every frame.
  private _changed = new Uint8Array(0);
  private _visited = new Uint8Array(0);
  // Last processed frame. Every tile that differed from its predecessor was sent,
  // so this is exactly what the client shows. Must not be mutated by the caller.
  private _prevFrame?: RGB | JpegFrame;
  private _iter = 0;
  private _fullFrameRequested = false;

  constructor(cfg: FrameProcessorCfg) {
    this._cfg = cfg;
  }

  public requestFullFrame(): void {
    this._iter = 0;
    this._fullFrameRequested = true;
  }

  // True if tiles can be cut out of this JPEG frame directly: the tile grid has to fall on
  // the JPEG's MCU grid.
  public acceptsJpegBlocks(b: JpegBlocks): boolean {
    const ts = this._cfg.tileSize;
    return ts % b.mcuW === 0 && ts % b.mcuH === 0;
  }

  public async processFrameAsync(frame: RGB | JpegFrame): Promise<FrameOut> {
    const prev = this._prevFrame;
    const sizeChanged = !prev || prev.width !== frame.width || prev.height !== frame.height;
    if (sizeChanged) this._initGrid(frame.width, frame.height);
    // Frames of different kinds can't be compared; switching kinds (e.g. a frame that had
    // to be rescaled) sends a full frame.
    const kindChanged = !!prev && isJpegFrame(prev) !== isJpegFrame(frame);
    if (isJpegFrame(frame) && !this.acceptsJpegBlocks(frame.blocks))
      throw new Error("tile grid doesn't match the JPEG's MCU grid");

    let forceFull = sizeChanged || kindChanged || (this._iter % this._cfg.fullFrameEvery) === 0;
    if (this._fullFrameRequested) {
      forceFull = true;
      this._fullFrameRequested = false;
    }
    const chosenEncoding: Encoding = Encoding.JPEG;

    let doFull = forceFull;
    let boxes: Box[] = [];
    if (!forceFull) {
      const changedArea = isJpegFrame(frame)
        ? this._markChangedBlocks(frame.blocks, (prev as JpegFrame).blocks)
        : this._markChangedTiles(frame, prev as RGB);
      const totalArea = frame.width * frame.height;
      const changedPct = totalArea > 0 ? (changedArea / totalArea) : 0;
      doFull = changedPct > this._cfg.fullframeAreaThreshold;
      if (!doFull) boxes = this._mergeChangedTiles();
    }
    if (doFull) boxes = this._splitWholeFrame(frame.width, frame.height, this._cfg.fullframeTileCount);

    // Encode in parallel: sharp runs each encode on the libuv thread pool.
    const parts = await Promise.all(boxes.map(b => this._encodeFittingAsync(frame, b, chosenEncoding)));
    const rects = parts.flat();

    this._prevFrame = frame;
    this._iter++;
    return { rects, isFullFrame: doFull, encoding: chosenEncoding };
  }

  // Sets _changed for every tile that differs from the previous frame; returns the changed area.
  // Compares whole pixel rows first: on a mostly static page nearly all rows are equal, so
  // that is one compare per row instead of one per tile row.
  private _markChangedTiles(cur: RGB, prev: RGB): number {
    const cols = this._cols, changed = this._changed;
    const stride = cur.width * BPP;
    const a = cur.data, b = prev.data;
    changed.fill(0);
    let changedArea = 0;

    for (let r = 0; r < this._rows; r++) {
      const base = r * cols;
      let pending = cols; // tiles in this band not known to have changed yet
      const y1 = this._rowY[r] + this._rowH[r];
      for (let y = this._rowY[r]; y < y1 && pending > 0; y++) {
        const row = y * stride;
        if (a.compare(b, row, row + stride, row, row + stride) === 0) continue;
        for (let c = 0; c < cols; c++) {
          if (changed[base + c]) continue;
          const off = row + this._colX[c] * BPP;
          const end = off + this._colW[c] * BPP;
          if (a.compare(b, off, end, off, end) !== 0) {
            changed[base + c] = 1;
            changedArea += this._colW[c] * this._rowH[r];
            pending--;
          }
        }
      }
    }
    return changedArea;
  }

  // Same as _markChangedTiles, on quantized DCT coefficients: equal pixels give equal
  // coefficients. Whole MCU rows are compared first.
  private _markChangedBlocks(cur: JpegBlocks, prev: JpegBlocks): number {
    const cols = this._cols, changed = this._changed;
    const mcuBytes = cur.blocksPerMcu * 64 * 2;
    const rowBytes = cur.mcusX * mcuBytes;
    const a = Buffer.from(cur.coef.buffer, cur.coef.byteOffset, cur.coef.byteLength);
    const b = Buffer.from(prev.coef.buffer, prev.coef.byteOffset, prev.coef.byteLength);
    changed.fill(0);
    let changedArea = 0;

    for (let r = 0; r < this._rows; r++) {
      const base = r * cols;
      let pending = cols;
      const my0 = this._rowY[r] / cur.mcuH;
      const my1 = Math.ceil((this._rowY[r] + this._rowH[r]) / cur.mcuH);
      for (let my = my0; my < my1 && pending > 0; my++) {
        const row = my * rowBytes;
        if (a.compare(b, row, row + rowBytes, row, row + rowBytes) === 0) continue;
        for (let c = 0; c < cols; c++) {
          if (changed[base + c]) continue;
          const off = row + (this._colX[c] / cur.mcuW) * mcuBytes;
          const end = row + Math.ceil((this._colX[c] + this._colW[c]) / cur.mcuW) * mcuBytes;
          if (a.compare(b, off, end, off, end) !== 0) {
            changed[base + c] = 1;
            changedArea += this._colW[c] * this._rowH[r];
            pending--;
          }
        }
      }
    }
    return changedArea;
  }

  // Encodes a box, splitting it in halves until every piece fits into one message.
  private async _encodeFittingAsync(frame: RGB | JpegFrame, b: Box, enc: Encoding): Promise<Rect[]> {
    const maxBytesPerTile = this._cfg.maxBytesPerMessage - FRAME_HEADER_BYTES - TILE_HEADER_BYTES;
    const data = await this._encodeBox(frame, b, enc);
    if (data.length <= maxBytesPerTile) return [{ ...b, data }];

    const halves = this._splitBox(b);
    if (!halves) {
      // A tiny box that still doesn't fit: maxBytesPerMessage is unrealistically small.
      return [{ ...b, data: await this._makeRedFrameAsync(b.w, b.h, enc) }];
    }
    const parts = await Promise.all(halves.map(h => this._encodeFittingAsync(frame, h, enc)));
    return parts.flat();
  }

  private _splitBox(b: Box): [Box, Box] | null {
    const alongX = b.w >= b.h;
    const size = alongX ? b.w : b.h;
    if (size < 2) return null;

    let cut = Math.floor(size / 2);
    if (size >= 2 * SPLIT_ALIGN) cut = Math.floor(cut / SPLIT_ALIGN) * SPLIT_ALIGN;

    return alongX
      ? [{ x: b.x, y: b.y, w: cut, h: b.h }, { x: b.x + cut, y: b.y, w: b.w - cut, h: b.h }]
      : [{ x: b.x, y: b.y, w: b.w, h: cut }, { x: b.x, y: b.y + cut, w: b.w, h: b.h - cut }];
  }

  private _splitWholeFrame(w: number, h: number, n: number): { x: number; y: number; w: number; h: number }[] {
    if (n <= 1) return [{ x: 0, y: 0, w, h }];

    // Two parts are horizontal bands; otherwise a grid of rows x cols = n.
    let rows = n === 2 ? 2 : Math.floor(Math.sqrt(n));
    while (rows > 1 && (n % rows !== 0)) rows--;
    const cols = Math.floor(n / rows);

    // Inner edges go to the nearest multiple of SPLIT_ALIGN, so tiles stay friendly to
    // HW JPEG decoders (the ESP32-P4 one needs a width that is a multiple of 16).
    const split = (size: number, parts: number): number[] => {
      const out: number[] = [];
      let prev = 0;
      for (let i = 1; i <= parts; i++) {
        let cur = size;
        if (i < parts) {
          cur = Math.round((i * size) / parts / SPLIT_ALIGN) * SPLIT_ALIGN;
          cur = Math.min(Math.max(cur, prev + 1), size - (parts - i)); // no empty parts
        }
        out.push(cur - prev);
        prev = cur;
      }
      return out;
    };

    const widths = split(w, cols);
    const heights = split(h, rows);

    const rects: { x: number; y: number; w: number; h: number }[] = [];
    let yAcc = 0;
    for (let r = 0; r < rows; r++) {
      let xAcc = 0;
      for (let c = 0; c < cols; c++) {
        rects.push({ x: xAcc, y: yAcc, w: widths[c], h: heights[r] });
        xAcc += widths[c];
      }
      yAcc += heights[r];
    }
    return rects;
  }

  // Merges changed tiles into rectangles no larger than a full-frame part.
  private _mergeChangedTiles(): Box[] {
    const cols = this._cols, rows = this._rows;
    const changed = this._changed, visited = this._visited;
    const maxW = this._maxBoxW, maxH = this._maxBoxH;
    visited.fill(0);

    const rects: Box[] = [];

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        if (!changed[i] || visited[i]) continue;

        // grow horizontally
        let wTiles = 0, pxW = 0;
        while (c + wTiles < cols && changed[i + wTiles] && !visited[i + wTiles]) {
          const nextW = pxW + this._colW[c + wTiles];
          if (nextW > maxW) break;
          pxW = nextW;
          wTiles++;
        }

        // grow vertically
        let hTiles = 1, pxH = this._rowH[r];
        while (r + hTiles < rows) {
          const nextH = pxH + this._rowH[r + hTiles];
          if (nextH > maxH) break;
          const rowBase = (r + hTiles) * cols;
          let all = true;
          for (let cc = c; cc < c + wTiles; cc++) {
            if (!changed[rowBase + cc] || visited[rowBase + cc]) { all = false; break; }
          }
          if (!all) break;
          pxH = nextH;
          hTiles++;
        }

        rects.push({ x: this._colX[c], y: this._rowY[r], w: pxW, h: pxH });

        for (let rr = r; rr < r + hTiles; rr++) {
          visited.fill(1, rr * cols + c, rr * cols + c + wTiles);
        }
      }
    }

    return rects;
  }

  private _initGrid(w: number, h: number) {
    const ts = this._cfg.tileSize;
    const cols = this._cols = Math.ceil(w / ts);
    const rows = this._rows = Math.ceil(h / ts);
    this._colX = new Int32Array(cols);
    this._colW = new Int32Array(cols);
    this._rowY = new Int32Array(rows);
    this._rowH = new Int32Array(rows);
    for (let c = 0; c < cols; c++) {
      this._colX[c] = c * ts;
      this._colW[c] = Math.min(ts, w - c * ts);
    }
    for (let r = 0; r < rows; r++) {
      this._rowY[r] = r * ts;
      this._rowH[r] = Math.min(ts, h - r * ts);
    }
    this._changed = new Uint8Array(cols * rows);
    this._visited = new Uint8Array(cols * rows);

    this._maxBoxW = 0;
    this._maxBoxH = 0;
    for (const r of this._splitWholeFrame(w, h, this._cfg.fullframeTileCount)) {
      this._maxBoxW = Math.max(this._maxBoxW, r.w);
      this._maxBoxH = Math.max(this._maxBoxH, r.h);
    }
  }

  private _extractRaw(frame: RGB, x: number, y: number, w: number, h: number): Buffer {
    const out = Buffer.allocUnsafe(w * h * BPP);
    for (let yy = 0; yy < h; yy++) {
      const src = ((y + yy) * frame.width + x) * BPP;
      frame.data.copy(out, yy * w * BPP, src, src + w * BPP);
    }
    return out;
  }

  // Encodes one box of the frame. For JPEG, sharp crops the shared frame buffer itself,
  // so the box isn't copied out first.
  private async _encodeBox(frame: RGB | JpegFrame, b: Box, enc: Encoding): Promise<Buffer> {
    if (isJpegFrame(frame)) return this._cropJpegAsync(frame, b);
    if (enc !== Encoding.JPEG && enc !== Encoding.UNKNOWN)
      return this._encode(this._extractRaw(frame, b.x, b.y, b.w, b.h), b.w, b.h, enc);
    const img = sharp(frame.data, { raw: { width: frame.width, height: frame.height, channels: BPP } });
    if (b.x !== 0 || b.y !== 0 || b.w !== frame.width || b.h !== frame.height)
      img.extract({ left: b.x, top: b.y, width: b.w, height: b.h });
    return img
      .jpeg({ quality: this._cfg.jpegQuality, mozjpeg: false, chromaSubsampling: "4:2:0" })
      .toBuffer();
  }

  // Cuts a box out of an already-JPEG frame without compressing it again. A box off the
  // MCU grid (only from splitting a box smaller than two MCUs) is re-encoded instead.
  private async _cropJpegAsync(frame: JpegFrame, b: Box): Promise<Buffer> {
    const j = frame.blocks;
    const alignedX = b.x % j.mcuW === 0 && (b.w % j.mcuW === 0 || b.x + b.w === frame.width);
    const alignedY = b.y % j.mcuH === 0 && (b.h % j.mcuH === 0 || b.y + b.h === frame.height);
    if (alignedX && alignedY) {
      return encodeJpegBlocks(j, b.x / j.mcuW, b.y / j.mcuH,
        Math.ceil(b.w / j.mcuW), Math.ceil(b.h / j.mcuH), b.w, b.h);
    }
    return sharp(frame.jpeg)
      .rotate(frame.rotation) // before extract: sharp applies them in call order
      .extract({ left: b.x, top: b.y, width: b.w, height: b.h })
      .jpeg({ quality: this._cfg.jpegQuality, mozjpeg: false, chromaSubsampling: "4:2:0" })
      .toBuffer();
  }

  private async _encode(rawRgb: Buffer, w: number, h: number, enc: Encoding): Promise<Buffer> {
    switch (enc) {
      case Encoding.JPEG:
        return this._encodeJPEG(rawRgb, w, h);
      case Encoding.RAW565:
        return this._encodeRAW565(rawRgb);
      default:
        return this._encodeJPEG(rawRgb, w, h);
    }
  }

  private async _encodeJPEG(rawRgb: Buffer, w: number, h: number): Promise<Buffer> {
    return sharp(rawRgb, { raw: { width: w, height: h, channels: BPP } })
      .jpeg({ quality: this._cfg.jpegQuality, mozjpeg: false, chromaSubsampling: "4:2:0" })
      .toBuffer();
  }

  private _encodeRAW565(rawRgb: Buffer): Buffer {
    const pxCount = rawRgb.length / BPP;
    const out = Buffer.allocUnsafe(pxCount * 2);
    for (let i = 0, j = 0; i < pxCount; i++, j += BPP) {
      const r = rawRgb[j];
      const g = rawRgb[j + 1];
      const b = rawRgb[j + 2];
      const v = ((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3);
      out[i * 2] = v & 0xFF;
      out[i * 2 + 1] = (v >> 8) & 0xFF;
    }
    return out;
  }

  private async _makeRedFrameAsync(w: number, h: number, enc: Encoding): Promise<Buffer> {
    const raw = Buffer.alloc(w * h * BPP);
    for (let o = 0; o < raw.length; o += BPP) raw[o] = 0xFF;
    return this._encode(raw, w, h, enc);
  }
}
