import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toGray, scaleGray, threshold, ditherFloydSteinberg, fitToHead } from '../src/services/raster.ts';

test('toGray composites transparent over white', () => {
  const rgba = new Uint8Array([
    0, 0, 0, 255,     // black
    255, 255, 255, 255, // white
    0, 0, 0, 0,       // fully transparent → white
  ]);
  const g = toGray(rgba, 3, 1);
  assert.deepEqual(Array.from(g.data), [0, 255, 255]);
});

test('threshold marks dark pixels black, MSB-first packing', () => {
  // 10 px wide, one row: first pixel black, rest white
  const w = 10, h = 1;
  const gray = { data: new Uint8Array([0, 255, 255, 255, 255, 255, 255, 255, 255, 255]), width: w, height: h };
  const bm = threshold(gray);
  assert.equal(bm.bytesPerRow, 2);
  assert.equal(bm.data[0], 0b1000_0000); // MSB first
  assert.equal(bm.data[1], 0);
});

test('ditherFloydSteinberg on mid-gray gives ~50% coverage', () => {
  const w = 64, h = 64;
  const gray = { data: new Uint8Array(w * h).fill(128), width: w, height: h };
  const bm = ditherFloydSteinberg(gray);
  let black = 0;
  for (const b of bm.data) for (let k = 0; k < 8; k++) black += (b >> k) & 1;
  const total = w * h;
  const ratio = black / total;
  assert.ok(ratio > 0.4 && ratio < 0.6, `coverage ${ratio}`);
});

test('scaleGray nearest neighbour', () => {
  const src = { data: Uint8Array.from([10, 200, 30, 240]), width: 2, height: 2 };
  const out = scaleGray(src, 4, 4);
  assert.equal(out.width, 4);
  assert.equal(out.data[0], 10);   // top-left preserved
  assert.equal(out.data[3], 200);
});

test('fitToHead produces 384-wide bitmap with byte-aligned rows', () => {
  const w = 192, h = 50;
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = (i % 2) ? 255 : 0;
    rgba[i * 4 + 3] = 255;
  }
  const { bitmap } = fitToHead(rgba, w, h, 384, 'art');
  assert.equal(bitmap.width, 384);
  assert.equal(bitmap.bytesPerRow, 48);
  assert.equal(bitmap.data.length, 48 * bitmap.height);
  assert.equal(bitmap.height, 100); // aspect preserved (2× scale)
});

test('solid black rows produce zero bytes (1 = black)', () => {
  const w = 8, h = 2;
  const gray = { data: new Uint8Array(w * h), width: w, height: h }; // all 0 = black
  const bm = threshold(gray, 128);
  for (const b of bm.data) assert.equal(b, 0xff);
});
