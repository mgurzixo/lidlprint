import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { deflateRawSync } from 'node:zlib';

import {
  CMD, gen2ImageHeader, gen1Image, encodeJob, cat,
} from '../src/services/printer-protocol.ts';

const here = dirname(fileURLToPath(import.meta.url));

// The inflated bitmaps from the two captured vendor jobs, recomputed from
// the captured deflate payloads (see doc/REVERSE-ENGINEERING.md §4).
// Re-inflate here from the raw streams for full independence:
import { inflateRawSync } from 'node:zlib';

function inflateAt(buf: Uint8Array, start: number): { out: Uint8Array; consumed: number } {
  // Node has no streaming raw inflate in sync mode; do it the dumb way:
  // try suffixes and pick the one that inflates cleanly.
  for (let end = buf.length; end > start + 10; end--) {
    try {
      const out = inflateRawSync(buf.subarray(start, end));
      if (out.length > 1000) return { out, consumed: end - start };
    } catch { /* try shorter */ }
  }
  throw new Error('no deflate stream found');
}

const frame = readFileSync(join(here, 'spp_sent.bin'));
const hello = readFileSync(join(here, 'spp_sent2.bin'));

test('captured frame job: header + deflate reproduce 574-row bitmap', () => {
  const i = frame.indexOf(Buffer.from([0x1f, 0x10, 0x00]));
  assert.equal(i, 35);
  const { out } = inflateAt(frame, i + 12);
  assert.equal(out.length, 48 * 574);
  assert.equal(frame[i + 3], 0x30); // widthBytes
  assert.equal((frame[i + 4] << 8) | frame[i + 5], 574); // rows BE
});

test('captured hello-world job: header + deflate reproduce 226-row bitmap', () => {
  const i = hello.indexOf(Buffer.from([0x1f, 0x10, 0x00]));
  assert.equal(i, 31);
  const { out } = inflateAt(hello, i + 12);
  assert.equal(out.length, 48 * 226);
  assert.equal((hello[i + 4] << 8) | hello[i + 5], 226);
});

test('gen2ImageHeader emits the exact captured bytes', () => {
  const h = gen2ImageHeader(574, 48, 0x07);
  assert.deepEqual(Array.from(h), [0x1f, 0x10, 0x00, 0x30, 0x02, 0x3e, 0x00, 0x00, 0x07, 0x7b, 0x28, 0x91]);
  const h2 = gen2ImageHeader(226, 48, 0x02);
  assert.equal(h2[5], 226 & 0xff);
  assert.equal(h2[4], 0);
});

test('encodeJob(gen2) round-trips against the captured hello-world job', () => {
  const i = hello.indexOf(Buffer.from([0x1f, 0x10, 0x00]));
  const bitmap = inflateAt(hello, i + 12).out;
  const chunks = encodeJob(bitmap, 226, { gen: 2, deflate: deflateRawSync, mode: 0x02 });
  // chunk 0 = beginJob
  assert.equal(chunks[0].length, 4 + 12);
  // chunk 1 = header + deflate — inflate ours and compare with captured bitmap
  const ours = chunks[1];
  assert.deepEqual(Array.from(ours.subarray(0, 12)), Array.from(hello.subarray(i, i + 12)));
  const reinflated = inflateRawSync(ours.subarray(12));
  assert.deepEqual(Array.from(reinflated), Array.from(bitmap));
  // chunk 2 = feed, chunk 3 = endJob
  assert.deepEqual(Array.from(chunks[2]), [0x1b, 0x4a, 0x50]);
  assert.deepEqual(Array.from(chunks[3]), Array.from(CMD.endJob));
});

test('encodeJob(gen1) emits classic ESC/POS raster', () => {
  const bitmap = new Uint8Array(12 * 100);
  const chunks = encodeJob(bitmap, 100, { gen: 1, deflate: deflateRawSync });
  const img = chunks[1];
  assert.deepEqual(Array.from(img.subarray(0, 8)), [0x1d, 0x76, 0x30, 0x00, 12, 0, 100, 0]);
  assert.equal(img.length, 8 + bitmap.length);
});

test('beginJob matches captured prefix', () => {
  // captured stream: [queries][10fff103][12×00][1f1000…]
  const z0 = hello.indexOf(Buffer.from([0x10, 0xff, 0xf1, 0x03]));
  assert.equal(z0, 15); // after the 4 query commands (4+4+4+3 bytes)
  for (let k = z0 + 4; k < z0 + 16; k++) assert.equal(hello[k], 0, `zero at ${k}`);
  assert.equal(z0 + 4 + 12, 31 + 3 - 3); // sanity: zeros end where magic starts
  assert.deepEqual(Array.from(CMD.beginJob), [0x10, 0xff, 0xf1, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
});
