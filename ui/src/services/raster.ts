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

/** Nearest-neighbour scale — the exact, brutal quantization used for QR/art. */
export function scaleGray(src: Gray, newWidth: number, newHeight: number): Gray {
  const out = new Uint8Array(newWidth * newHeight);
  const xr = src.width / newWidth;
  const yr = src.height / newHeight;
  for (let y = 0; y < newHeight; y++) {
    const fy = (y + 0.5) * yr - 0.5;
    const y0 = Math.max(0, Math.floor(fy));
    const y1 = Math.min(src.height - 1, y0 + 1);
    const dy = fy - y0;
    for (let x = 0; x < newWidth; x++) {
      const fx = (x + 0.5) * xr - 0.5;
      const x0 = Math.max(0, Math.floor(fx));
      const x1 = Math.min(src.width - 1, x0 + 1);
      const dx = fx - x0;
      const v =
        (1 - dx) * (1 - dy) * src.data[y0 * src.width + x0]! +
        dx * (1 - dy) * src.data[y0 * src.width + x1]! +
        (1 - dx) * dy * src.data[y1 * src.width + x0]! +
        dx * dy * src.data[y1 * src.width + x1]!;
      out[y * newWidth + x] = Math.round(v);
    }
  }
  return { data: out, width: newWidth, height: newHeight };
}

/**
 * Trim uniform white borders down to `keep` pixels of quiet zone.
 * Matches the vendor app behavior: the QR ink fills the full 384-dot width.
 */
export function trimWhiteBorders(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  keep = 8,
): { data: Uint8ClampedArray; w: number; h: number } {
  const stride = w * 4;
  const isWhite = (x: number, y: number) => {
    const o = y * stride + x * 4;
    return rgba[o]! > 245 && rgba[o + 1]! > 245 && rgba[o + 2]! > 245;
  };
  let top = 0, bottom = h - 1, left = 0, right = w - 1;
  const rowWhite = (y: number) => { for (let x = 0; x < w; x++) if (!isWhite(x, y)) return false; return true; };
  const colWhite = (x: number) => { for (let y = 0; y < h; y++) if (!isWhite(x, y)) return false; return true; };
  while (top < bottom && rowWhite(top)) top++;
  while (bottom > top && rowWhite(bottom)) bottom--;
  while (left < right && colWhite(left)) left++;
  while (right > left && colWhite(right)) right--;
  top = Math.max(0, top - keep); bottom = Math.min(h - 1, bottom + keep);
  left = Math.max(0, left - keep); right = Math.min(w - 1, right + keep);
  if (bottom <= top || right <= left) return { data: rgba, w, h }; // all-white fallback
  const nw = right - left + 1, nh = bottom - top + 1;
  if (nw === w && nh === h) return { data: rgba, w, h };
  const out = new Uint8ClampedArray(nw * nh * 4);
  for (let y = 0; y < nh; y++) {
    const srcRow = (top + y) * stride + left * 4;
    out.set(rgba.subarray(srcRow, srcRow + nw * 4), y * nw * 4);
  }
  return { data: out, w: nw, h: nh };
}

/** Bilinear resample — smoother for photos/dithers. */
export function scaleGrayBilinear(src: Gray, newWidth: number, newHeight: number): Gray {
  const out = new Uint8Array(newWidth * newHeight);
  const xr = src.width / newWidth;
  const yr = src.height / newHeight;
  for (let y = 0; y < newHeight; y++) {
    const fy = (y + 0.5) * yr - 0.5;
    const y0 = Math.max(0, Math.floor(fy));
    const y1 = Math.min(src.height - 1, y0 + 1);
    const dy = fy - y0;
    for (let x = 0; x < newWidth; x++) {
      const fx = (x + 0.5) * xr - 0.5;
      const x0 = Math.max(0, Math.floor(fx));
      const x1 = Math.min(src.width - 1, x0 + 1);
      const dx = fx - x0;
      const v =
        (1 - dx) * (1 - dy) * src.data[y0 * src.width + x0]! +
        dx * (1 - dy) * src.data[y0 * src.width + x1]! +
        (1 - dx) * dy * src.data[y1 * src.width + x0]! +
        dx * dy * src.data[y1 * src.width + x1]!;
      out[y * newWidth + x] = Math.round(v);
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
