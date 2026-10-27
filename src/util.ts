export type Rotation = 0 | 90 | 180 | 270;

export function getRotatedDimensions(
  width: number,
  height: number,
  rotation: Rotation
): { width: number; height: number } {
  if (rotation === 90 || rotation === 270) {
    return { width: height, height: width };
  }
  return { width, height };
}

export function mapPointForRotation(
  xd: number, yd: number,
  srcW: number, srcH: number, // розмір сторінки у Chrome (до ротації)
  rotation: Rotation
): { x: number; y: number } {
  switch (rotation) {
    case 0:   return { x: xd,            y: yd };
    case 90:  return { x: yd,            y: srcH - 1 - xd };
    case 180: return { x: srcW - 1 - xd, y: srcH - 1 - yd };
    case 270: return { x: srcW - 1 - yd, y: xd };
  }
}

// CSS viewport for a device of width x height physical px shown at the given scale.
export function getScaledViewport(
  width: number,
  height: number,
  scale: number
): { width: number; height: number } {
  return {
    width: Math.max(1, Math.round(width / scale)),
    height: Math.max(1, Math.round(height / scale)),
  };
}

// Width and height of a PNG or JPEG screencast frame, read from its header without decoding it.
export function imageSize(img: Buffer): { width: number; height: number } | undefined {
  if (img.length >= 24 && img.readUInt32BE(12) === 0x49484452) // PNG "IHDR"
    return { width: img.readUInt32BE(16), height: img.readUInt32BE(20) };
  if (img.length < 4 || img[0] !== 0xFF || img[1] !== 0xD8) return undefined; // JPEG SOI
  // Walk the marker segments up to the first start-of-frame (SOF0..SOF15 minus DHT/JPG/DAC).
  let off = 2;
  while (off + 9 <= img.length) {
    if (img[off] !== 0xFF) return undefined;
    const marker = img[off + 1];
    if (marker === 0xFF) { off++; continue; } // fill byte
    if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC)
      return { width: img.readUInt16BE(off + 7), height: img.readUInt16BE(off + 5) };
    off += 2 + img.readUInt16BE(off + 2);
  }
  return undefined;
}
