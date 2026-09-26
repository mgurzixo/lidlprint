/**
 * lidlprint — rasterizer: ImageData → 1-bpp packed bitmap
 *
 * Converts an RGBA image to the printer's native bitmap format:
 * 1 bit/pixel, MSB first, rows byte-aligned, 1 = black.
 * Scaling to the head width (384 px on gen 2) and Floyd–Steinberg dithering
 * for photographic input; simple threshold for pure black/white art
 * (QR codes must NOT be dithered).
 *
 * Pure TypeScript, works in browser (canvas ImageData) and Node (tests).
 */

export interface Bitmap {
  /** packed bits, rows byte-aligned, MSB first, 1 = black */
  data: Uint8Array;
  width: number;
  height: number;
  bytesPerRow: number;
}

/** Grayscale value 0..255 per pixel (0 = black as usual in image land). */
export type Gray = { data: Uint8Array; width: number; height: number };

/** RGBA (from canvas ImageData) → grayscale. */
export function toGray(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): Gray {
  const out = new Uint8Array(width * height);
  for (let i = 0; i < out.length; i++) {
    const r = rgba[i * 4]!, g = rgba[i * 4 + 1]!, b = rgba[i * 4 + 2]!, a = rgba[i * 4 + 3]!;
    // white background where transparent — thermal paper is white
    const alpha = a / 255;
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    out[i] = Math.round(255 - alpha * (255 - lum)); // composite over white
  }
  return { data: out, width, height };
}

/** Nearest-neighbour scale. Good enough after dithering for photos; QR use exact scale. */
export function scaleGray(src: Gray, newWidth: number, newHeight: number): Gray {
  const out = new Uint8Array(newWidth * newHeight);
  for (let y = 0; y < newHeight; y++) {
    const sy = Math.min(src.height - 1, Math.floor((y * src.height) / newHeight));
    for (let x = 0; x < newWidth; x++) {
      const sx = Math.min(src.width - 1, Math.floor((x * src.width) / newWidth));
      out[y * newWidth + x] = src.data[sy * src.width + sx]!;
    }
  }
  return { data: out, width: newWidth, height: newHeight };
}

/** Simple threshold — for line art / QR / text that must stay crisp. */
export function threshold(gray: Gray, blackBelow = 128): Bitmap {
  return packBits(gray.data, gray.width, gray.height, (v) => v < blackBelow);
}

/**
 * Floyd–Steinberg dithering — for photos and anti-aliased content.
 * Operates on a copy; input is untouched.
 */
export function ditherFloydSteinberg(gray: Gray): Bitmap {
  const w = gray.width, h = gray.height;
  const buf = Float32Array.from(gray.data);
  const out1bpp = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const old = buf[i]!;
      const black = old < 128;
      out1bpp[i] = black ? 1 : 0;
      const err = old - (black ? 0 : 255);
      if (x + 1 < w) buf[i + 1]! += (err * 7) / 16;
      if (y + 1 < h) {
        if (x > 0) buf[i + w - 1]! += (err * 3) / 16;
        buf[i + w]! += (err * 5) / 16;
        if (x + 1 < w) buf[i + w + 1]! += (err * 1) / 16;
      }
    }
  }
  return packBits(out1bpp, w, h, (v) => v === 1);
}

/**
 * Scale a bitmap to fit the printable width, preserving aspect ratio.
 * Returns bitmap sized (headWidthPx × proportional rows, min 1).
 */
export function fitToHead(
  rgba: Uint8Array | Uint8ClampedArray,
  imgW: number,
  imgH: number,
  headWidthPx: number,
  style: 'photo' | 'art' = 'photo',
): { bitmap: Bitmap; gray: Gray } {
  const scale = headWidthPx / imgW;
  const newH = Math.max(1, Math.round(imgH * scale));
  const gray = toGray(rgba, imgW, imgH);
  const scaled = scaleGray(gray, headWidthPx, newH);
  const bitmap = style === 'art' ? threshold(scaled) : ditherFloydSteinberg(scaled);
  return { bitmap, gray: scaled };
}

function packBits(
  values: ArrayLike<number>,
  width: number,
  height: number,
  isBlack: (v: number) => boolean,
): Bitmap {
  const bytesPerRow = Math.ceil(width / 8);
  const data = new Uint8Array(bytesPerRow * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (isBlack(values[y * width + x]!)) {
        data[y * bytesPerRow + (x >> 3)]! |= 0x80 >> (x & 7); // MSB first
      }
    }
  }
  return { data, width, height, bytesPerRow };
}
