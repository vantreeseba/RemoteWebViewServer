import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { imageSize } from "../src/util.js";

const raw = { width: 37, height: 21, channels: 3 as const };
const pixels = Buffer.alloc(raw.width * raw.height * 3, 0x80);

describe("imageSize", () => {
  it("reads PNG dimensions", async () => {
    const png = await sharp(pixels, { raw }).png().toBuffer();
    expect(imageSize(png)).toEqual({ width: 37, height: 21 });
  });

  it("reads JPEG dimensions past APP/DQT/DHT segments", async () => {
    const jpg = await sharp(pixels, { raw }).jpeg({ quality: 90 }).withMetadata().toBuffer();
    expect(imageSize(jpg)).toEqual({ width: 37, height: 21 });
  });

  it("reads progressive JPEG dimensions", async () => {
    const jpg = await sharp(pixels, { raw }).jpeg({ progressive: true }).toBuffer();
    expect(imageSize(jpg)).toEqual({ width: 37, height: 21 });
  });

  it("returns undefined for other or truncated data", () => {
    expect(imageSize(Buffer.from("not an image at all, really"))).toBeUndefined();
    expect(imageSize(Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00]))).toBeUndefined();
  });
});
