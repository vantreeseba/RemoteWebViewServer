import os from "node:os";
import sharp from "sharp";
import { Encoding, FRAME_HEADER_BYTES, TILE_HEADER_BYTES } from "./protocol.js";

sharp.concurrency(Math.max(1, os.cpus().length - 1));

// Raw interleaved pixel data; channels is 3 (RGB) or 4 (RGBA).
export type RawImage = { data: Buffer; width: number; height: number; channels: number };

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

export class FrameProcessor {
  private _cfg: FrameProcessorCfg;
  private _cols = 0;
  private _rows = 0;
  private _iter = 0;
  private _fullFrameRequested = false;
  private _redTileCache = new Map<string, Promise<Buffer>>();

  // Grid state, all sized/computed once in _initGrid — frame dimensions are
  // pinned by the screencast config, so per-frame recomputation is waste.
  private _prev?: Uint32Array;       // last acknowledged tile hashes
  private _curHashes?: Uint32Array;  // scratch: this frame's tile hashes
  private _changed?: Uint8Array;     // scratch: this frame's changed flags
  private _visited?: Uint8Array;     // scratch for _mergeChangedTiles
  private _widths: number[] = [];    // per-column tile widths (last clipped)
  private _heights: number[] = [];   // per-row tile heights (last clipped)
  private _xOffsets: number[] = [];
  private _yOffsets: number[] = [];
  private _fullRects: { x: number; y: number; w: number; h: number }[] = [];
  private _maxW = 0;                 // largest full-frame rect dims — caps
  private _maxH = 0;                 // merged partial rects to the same size

  constructor(cfg: FrameProcessorCfg) {
    this._cfg = cfg;
  }

  public requestFullFrame(): void {
    this._iter = 0;
    this._fullFrameRequested = true;
  }

  public async processFrameAsync(rgba: RawImage): Promise<FrameOut> {
    if (!this._prev) this._initGrid(rgba.width, rgba.height);

    let forceFull = (this._iter % this._cfg.fullFrameEvery) === 0;
    if (this._fullFrameRequested) {
      forceFull = true;
      this._fullFrameRequested = false;
    }
    const chosenEncoding: Encoding = Encoding.JPEG;

    const cur = this._curHashes!;
    const changed = this._changed!;
    const prev = this._prev!;
    let changedArea = 0;

    for (let ty = 0; ty < this._rows; ty++) {
      for (let tx = 0; tx < this._cols; tx++) {
        const idx = ty * this._cols + tx;
        const w = this._widths[tx];
        const h = this._heights[ty];

        const h32 = this._hashTile(rgba, this._xOffsets[tx], this._yOffsets[ty], w, h);
        cur[idx] = h32;
        const isChanged = forceFull || (prev[idx] !== h32);
        changed[idx] = isChanged ? 1 : 0;
        if (isChanged) changedArea += w * h;
      }
    }

    const totalArea = rgba.width * rgba.height;
    const changedPct = totalArea > 0 ? (changedArea / totalArea) : 0;
    const doFull = forceFull || (changedPct > this._cfg.fullframeAreaThreshold);

    const out = doFull
      ? await this._processFullFrame(rgba, chosenEncoding)
      : await this._processPartialFrame(rgba, chosenEncoding);

    const maxBytesPerTile = this._cfg.maxBytesPerMessage - FRAME_HEADER_BYTES - TILE_HEADER_BYTES;
    await Promise.all(out.rects.map(async (r, i) => {
      if (r.data.length > maxBytesPerTile) {
        const redData = await this._makeRedFrameAsync(r.w, r.h, chosenEncoding);
        out.rects[i] = { x: r.x, y: r.y, w: r.w, h: r.h, data: redData };
      }
    }));

    this._iter++;
    return out;
  }

  private async _processFullFrame(rgba: RawImage, encoding: Encoding): Promise<FrameOut> {
    const rects: Rect[] = await Promise.all(this._fullRects.map(async r => ({
      x: r.x, y: r.y, w: r.w, h: r.h,
      data: await this._encodeRectAsync(rgba, r.x, r.y, r.w, r.h, encoding),
    })));

    this._prev!.set(this._curHashes!);

    return { rects, isFullFrame: true, encoding };
  }

  private async _processPartialFrame(rgba: RawImage, encoding: Encoding): Promise<FrameOut> {
    const mergedRects = this._mergeChangedTiles();

    const out: Rect[] = await Promise.all(mergedRects.map(async r => ({
      ...r,
      data: await this._encodeRectAsync(rgba, r.x, r.y, r.w, r.h, encoding),
    })));

    const prev = this._prev!, cur = this._curHashes!, changed = this._changed!;
    for (let i = 0; i < changed.length; i++) if (changed[i]) prev[i] = cur[i];

    return { rects: out, isFullFrame: false, encoding };
  }

  private _splitWholeFrame(w: number, h: number, n: number): { x: number; y: number; w: number; h: number }[] {
    if (n <= 1) return [{ x: 0, y: 0, w, h }];

    if (n === 2) {
      const h1 = Math.floor(h / 2);
      const h2 = h - h1;
      return [
        { x: 0, y: 0, w, h: h1 },
        { x: 0, y: h1, w, h: h2 },
      ];
    }

    let rows = Math.floor(Math.sqrt(n));
    while (rows > 1 && (n % rows !== 0)) rows--;
    const cols = Math.floor(n / rows);

    const split = (size: number, parts: number): number[] => {
      const out: number[] = [];
      let prev = 0;
      for (let i = 1; i <= parts; i++) {
        const cur = Math.floor((i * size) / parts);
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

  private _mergeChangedTiles(): { x: number; y: number; w: number; h: number }[] {
    const cols = this._cols, rows = this._rows;
    const changed = this._changed!;
    const visited = this._visited!;
    visited.fill(0);

    const rects: { x: number; y: number; w: number; h: number }[] = [];

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const idx = r * cols + c;
        if (!changed[idx] || visited[idx]) continue;

        // grow horizontally
        let wTiles = 0, pxW = 0;
        while (c + wTiles < cols) {
          const i2 = r * cols + c + wTiles;
          if (!changed[i2] || visited[i2]) break;
          const nextW = pxW + this._widths[c + wTiles];
          if (nextW > this._maxW) break;
          pxW = nextW;
          wTiles++;
        }

        // grow vertically
        let hTiles = 1, pxH = this._heights[r];
        let canGrow = true;
        while (canGrow && (r + hTiles) < rows) {
          const nextH = pxH + this._heights[r + hTiles];
          if (nextH > this._maxH) break;
          for (let cc = c; cc < c + wTiles; cc++) {
            const i2 = (r + hTiles) * cols + cc;
            if (!changed[i2] || visited[i2]) { canGrow = false; break; }
          }
          if (!canGrow) break;
          pxH = nextH;
          hTiles++;
        }

        rects.push({ x: this._xOffsets[c], y: this._yOffsets[r], w: pxW, h: pxH });

        for (let rr = r; rr < r + hTiles; rr++) {
          for (let cc = c; cc < c + wTiles; cc++) {
            visited[rr * cols + cc] = 1;
          }
        }
      }
    }

    return rects;
  }

  private _initGrid(w: number, h: number) {
    const ts = this._cfg.tileSize;
    this._cols = Math.ceil(w / ts);
    this._rows = Math.ceil(h / ts);
    const n = this._cols * this._rows;

    this._prev = new Uint32Array(n);
    this._curHashes = new Uint32Array(n);
    this._changed = new Uint8Array(n);
    this._visited = new Uint8Array(n);

    this._widths = new Array(this._cols);
    this._xOffsets = new Array(this._cols);
    for (let c = 0, x = 0; c < this._cols; c++) {
      this._widths[c] = Math.min(ts, w - x);
      this._xOffsets[c] = x;
      x += this._widths[c];
    }
    this._heights = new Array(this._rows);
    this._yOffsets = new Array(this._rows);
    for (let r = 0, y = 0; r < this._rows; r++) {
      this._heights[r] = Math.min(ts, h - y);
      this._yOffsets[r] = y;
      y += this._heights[r];
    }

    this._fullRects = this._splitWholeFrame(w, h, this._cfg.fullframeTileCount);
    this._maxW = 0;
    this._maxH = 0;
    for (const r of this._fullRects) {
      if (r.w > this._maxW) this._maxW = r.w;
      if (r.h > this._maxH) this._maxH = r.h;
    }
  }

  // Strided FNV-1a over the first byte of every pixel in the tile — the same
  // bytes hash32 sampled on an extracted tile copy, without the alloc+memcpy
  // per tile per frame.
  private _hashTile(rgba: RawImage, x: number, y: number, w: number, h: number): number {
    const { data, width, channels } = rgba;
    let hsh = 0x811C9DC5 >>> 0;
    for (let yy = 0; yy < h; yy++) {
      let off = ((y + yy) * width + x) * channels;
      for (let xx = 0; xx < w; xx++, off += channels) {
        hsh ^= data[off];
        hsh = (hsh * 0x01000193) >>> 0;
      }
    }
    return hsh >>> 0;
  }

  private _extractRaw(rgba: RawImage, x: number, y: number, w: number, h: number): Buffer {
    const c = rgba.channels;
    const out = Buffer.allocUnsafe(w * h * c);
    for (let yy = 0; yy < h; yy++) {
      const src = ((y + yy) * rgba.width + x) * c;
      rgba.data.copy(out, yy * w * c, src, src + w * c);
    }
    return out;
  }

  // Encode a rect straight from the shared frame buffer. For JPEG, sharp's
  // extract() crops as a libvips region read — no JS-side alloc+memcpy of
  // the rect. RAW565 still needs the extracted bytes in JS.
  private async _encodeRectAsync(rgba: RawImage, x: number, y: number, w: number, h: number, enc: Encoding): Promise<Buffer> {
    if (enc === Encoding.RAW565) {
      return this._encodeRAW565(this._extractRaw(rgba, x, y, w, h), rgba.channels);
    }
    return sharp(rgba.data, { raw: { width: rgba.width, height: rgba.height, channels: rgba.channels as 3 | 4 } })
      .extract({ left: x, top: y, width: w, height: h })
      .jpeg({ quality: this._cfg.jpegQuality, mozjpeg: false, chromaSubsampling: "4:2:0" })
      .toBuffer();
  }

  private async _encodeJPEG(raw: Buffer, w: number, h: number, channels: number): Promise<Buffer> {
    return sharp(raw, { raw: { width: w, height: h, channels: channels as 3 | 4 } })
      .jpeg({ quality: this._cfg.jpegQuality, mozjpeg: false, chromaSubsampling: "4:2:0" })
      .toBuffer();
  }

  private _encodeRAW565(raw: Buffer, channels: number): Buffer {
    const pxCount = (raw.length / channels) | 0;
    const out = Buffer.allocUnsafe(pxCount * 2);
    for (let i = 0, j = 0; i < pxCount; i++, j += channels) {
      const r = raw[j];
      const g = raw[j + 1];
      const b = raw[j + 2];
      const v = ((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3);
      out[i * 2] = v & 0xFF;
      out[i * 2 + 1] = (v >> 8) & 0xFF;
    }
    return out;
  }

  // "Tile too big" is a property of the page content, so this can fire on
  // every frame; the output is deterministic per (w, h, enc) — cache it.
  private _makeRedFrameAsync(w: number, h: number, enc: Encoding): Promise<Buffer> {
    const key = `${w}x${h}:${enc}`;
    let cached = this._redTileCache.get(key);
    if (!cached) {
      cached = this._buildRedFrameAsync(w, h, enc);
      this._redTileCache.set(key, cached);
      cached.catch(() => this._redTileCache.delete(key));
    }
    return cached;
  }

  private async _buildRedFrameAsync(w: number, h: number, enc: Encoding): Promise<Buffer> {
    const raw = Buffer.allocUnsafe(w * h * 3);
    for (let o = 0; o < raw.length; o += 3) {
      raw[o] = 0xFF;
      raw[o + 1] = 0x00;
      raw[o + 2] = 0x00;
    }
    if (enc === Encoding.RAW565) return this._encodeRAW565(raw, 3);
    return this._encodeJPEG(raw, w, h, 3);
  }
}
