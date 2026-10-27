import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { decodeJpegBlocks, encodeJpegBlocks, JpegBlocks } from "../src/jpegBlocks.js";

// Smooth gradients plus some noise and hard edges: exercises long AC runs, ZRL and EOB.
function testImage(w: number, h: number): Buffer {
  const d = Buffer.alloc(w * h * 3);
  let s = 7;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      const o = (y * w + x) * 3;
      const noise = (x > w / 2 && y > h / 2) ? (s >>> 24) : 0;
      d[o] = (x * 255 / w) ^ noise;
      d[o + 1] = (y * 255 / h);
      d[o + 2] = ((x >> 4) + (y >> 4)) & 1 ? 230 : 20;
    }
  }
  return d;
}

async function jpeg(w: number, h: number, subsampling: "4:2:0" | "4:4:4", quality = 85, extra: object = {}) {
  return sharp(testImage(w, h), { raw: { width: w, height: h, channels: 3 } })
    .jpeg({ quality, chromaSubsampling: subsampling, ...extra })
    .toBuffer();
}

async function pixels(buf: Buffer) {
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

function region(p: { data: Buffer; width: number }, x: number, y: number, w: number, h: number): Buffer {
  const out = Buffer.alloc(w * h * 3);
  for (let r = 0; r < h; r++)
    p.data.copy(out, r * w * 3, ((y + r) * p.width + x) * 3, ((y + r) * p.width + x + w) * 3);
  return out;
}

function mcuCoef(img: JpegBlocks, mx: number, my: number): Int16Array {
  const n = img.blocksPerMcu * 64;
  const o = (my * img.mcusX + mx) * n;
  return img.coef.subarray(o, o + n);
}

describe("jpegBlocks", () => {
  it("reads geometry of a 4:2:0 image", async () => {
    const img = decodeJpegBlocks(await jpeg(333, 201, "4:2:0"))!;
    expect(img).not.toBeNull();
    expect([img.width, img.height, img.mcuW, img.mcuH, img.mcusX, img.mcusY, img.blocksPerMcu])
      .toEqual([333, 201, 16, 16, 21, 13, 6]);
  });

  it("re-encodes the whole image to exactly the same pixels and coefficients", async () => {
    for (const ss of ["4:2:0", "4:4:4"] as const) {
      const src = await jpeg(333, 201, ss);
      const img = decodeJpegBlocks(src)!;
      const out = encodeJpegBlocks(img, 0, 0, img.mcusX, img.mcusY, img.width, img.height);
      expect((await pixels(out)).data.equals((await pixels(src)).data)).toBe(true);
      expect(decodeJpegBlocks(out)!.coef).toEqual(img.coef);
    }
  });

  it("crops 4:4:4 losslessly: the tile decodes to the same pixels as that region", async () => {
    const src = await jpeg(320, 240, "4:4:4");
    const img = decodeJpegBlocks(src)!;
    const full = await pixels(src);
    // 64x32 px at (96, 40) = MCUs (12, 5) .. 8 wide, 4 high
    const tile = encodeJpegBlocks(img, 12, 5, 8, 4, 64, 32);
    const t = await pixels(tile);
    expect([t.width, t.height]).toEqual([64, 32]);
    expect(t.data.equals(region(full, 96, 40, 64, 32))).toBe(true);
  });

  it("crops 4:2:0 without touching the coefficients", async () => {
    const src = await jpeg(320, 240, "4:2:0");
    const img = decodeJpegBlocks(src)!;
    const tile = encodeJpegBlocks(img, 4, 2, 3, 2, 48, 32);
    const back = decodeJpegBlocks(tile)!;
    expect([back.width, back.height, back.mcusX, back.mcusY]).toEqual([48, 32, 3, 2]);
    for (let y = 0; y < 2; y++)
      for (let x = 0; x < 3; x++)
        expect(mcuCoef(back, x, y)).toEqual(mcuCoef(img, 4 + x, 2 + y));

    // Pixels match the region exactly, except the outer pixel ring: a whole-frame decode
    // blends chroma there with the neighbouring blocks, a standalone tile can't.
    const inner = (p: { data: Buffer; width: number }, x: number, y: number) => region(p, x + 1, y + 1, 46, 30);
    expect(inner(await pixels(tile), 0, 0).equals(inner(await pixels(src), 64, 32))).toBe(true);
  });

  it("crops a partial MCU at the image edge", async () => {
    const src = await jpeg(333, 201, "4:2:0");
    const img = decodeJpegBlocks(src)!;
    // last MCU column/row: x 320..333, y 192..201
    const tile = encodeJpegBlocks(img, 20, 12, 1, 1, 13, 9);
    const back = decodeJpegBlocks(tile)!;
    expect([back.width, back.height]).toEqual([13, 9]);
    expect(mcuCoef(back, 0, 0)).toEqual(mcuCoef(img, 20, 12));
  });

  it("produces tiles no larger than sharp's own re-encode at the same quality", async () => {
    const src = await jpeg(320, 240, "4:2:0", 85);
    const img = decodeJpegBlocks(src)!;
    const ours = encodeJpegBlocks(img, 0, 0, 10, 5, 160, 80).length;
    const theirs = (await sharp(await pixels(src).then(p => region(p, 0, 0, 160, 80)), { raw: { width: 160, height: 80, channels: 3 } })
      .jpeg({ quality: 85, chromaSubsampling: "4:2:0" }).toBuffer()).length;
    expect(ours).toBeLessThanOrEqual(theirs * 1.05);
  });

  it("rejects what it can't crop", async () => {
    expect(decodeJpegBlocks(await jpeg(64, 64, "4:2:0", 85, { progressive: true }))).toBeNull();
    expect(decodeJpegBlocks(await sharp(testImage(16, 16), { raw: { width: 16, height: 16, channels: 3 } }).png().toBuffer())).toBeNull();
    expect(decodeJpegBlocks(Buffer.from([0xFF, 0xD8, 0xFF, 0xDB, 0x00]))).toBeNull();
    const truncated = await jpeg(64, 64, "4:2:0");
    expect(decodeJpegBlocks(truncated.subarray(0, truncated.length - 40))).toBeNull();
    expect(decodeJpegBlocks(truncated)).not.toBeNull();
  });
});
