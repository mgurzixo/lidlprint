/**
 * lidlprint — printer protocol encoder
 *
 * Reverse-engineered protocol of the Lidl / Silvercrest / TRONIC "Mini Pocket
 * Printer" (Karsten International B.V.; IAN 470561_2407 gen 1 "DP-L13",
 * IAN 508705_2507 gen 2 "A2Y"), spoken over Bluetooth Classic SPP (RFCOMM
 * channel 1). See doc/REVERSE-ENGINEERING.md.
 *
 * Pure TypeScript, no dependencies. The transport (BluetoothSocket etc.) is
 * injected as a Sink so the same encoder runs on Capacitor Android, Node
 * (tests) or any byte pipe.
 */

/** Generator producing raw DEFLATE (RFC 1951) bytes. */
export type Deflater = (data: Uint8Array) => Uint8Array;

/** Byte sink — e.g. a BluetoothSocket output stream wrapper. */
export interface ByteSink {
  write(data: Uint8Array): Promise<void> | void;
  /** Read whatever the printer sent (ACKs, status replies). Resolves with >=0 bytes. */
  read(): Promise<Uint8Array>;
  close?(): void;
}

export type PrinterGeneration = 1 | 2;

export const GEN = {
  /** bytes per row on the wire. gen1 labels: 12 bytes = 96 px; gen2: 48 bytes = 384 px */
  bytesPerRow: (gen: PrinterGeneration): number => (gen === 1 ? 12 : 48),
} as const;

// ---------------------------------------------------------------- commands

export const CMD = {
  getModel: hex('10ff20f0'),
  getFirmware: hex('10ff20f1'),
  getSerial: hex('10ff20f2'),
  getBattery: hex('10ff50f1'),
  getPaperStatus: hex('10ff40'),
  setDensity: (n: 0 | 1 | 2) => cat(hex('10ff1000'), Uint8Array.of(n)),
  setAutoOff: (minutes: number) => cat(hex('10ff1200'), Uint8Array.of(minutes)),
  beginJob: cat(hex('10fff103'), new Uint8Array(12)), // + 12 zero bytes
  endJob: hex('10fff145'),
  /** print & feed n dots (standard ESC/POS ESC J n) */
  printFeed: (n: number) => cat(hex('1b4a'), Uint8Array.of(n)),
  /** job-done sentinel the printer answers to endJob */
  READY: 0xaa,
} as const;

function hex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
  return out;
}

/** Concatenate byte arrays. */
export function cat(...parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// ---------------------------------------------------------------- image header

/**
 * Build the generation-2 image header.
 *
 * 1F 10 00 | widthBytes | heightRows u16 BE | 00 00 | mode | c1 c2 c3
 *
 * The last five bytes are not fully understood (see doc) but captured
 * traffic shows the printer accepts these canonical values:
 * mode 0x07 (dense/graphic) or 0x02 (light), tail 7B 28 91 / 8B 28 91.
 */
export function gen2ImageHeader(rows: number, widthBytes = 48, mode: 0x02 | 0x07 = 0x07): Uint8Array {
  const h = new Uint8Array(12);
  h.set(hex('1f1000'), 0);
  h[3] = widthBytes;
  h[4] = (rows >> 8) & 0xff; // BIG-endian (verified: 0x023E=574, 0x00E2=226)
  h[5] = rows & 0xff;
  h[6] = 0;
  h[7] = 0;
  h[8] = mode;
  h[9] = mode === 0x07 ? 0x7b : 0x8b; // observed pairings; semantics unknown
  h[10] = 0x28;
  h[11] = 0x91;
  return h;
}

/**
 * Generation-1 image: classic ESC/POS raster
 * `1D 76 30 00 xL xH yL yH` + UNCOMPRESSED 1-bpp bitmap.
 */
export function gen1Image(bitmap: Uint8Array, rows: number, widthBytes = 12): Uint8Array {
  const head = new Uint8Array(8);
  head.set(hex('1d763000'), 0);
  head[4] = widthBytes & 0xff; // xL xH
  head[5] = (widthBytes >> 8) & 0xff;
  head[6] = rows & 0xff; // yL yH
  head[7] = (rows >> 8) & 0xff;
  const out = new Uint8Array(8 + bitmap.length);
  out.set(head, 0);
  out.set(bitmap, 8);
  return out;
}

// ---------------------------------------------------------------- job encoding

export interface PrintJobOptions {
  gen: PrinterGeneration;
  /** raw DEFLATE implementer. Browser/Node: (d) => pako.deflateRaw(d) */
  deflate: Deflater;
  /** feed after print, in dots. Default 80 (0x50), as the vendor app sends. */
  feedDots?: number;
  /** gen-2 header mode byte. Default 0x07. */
  mode?: 0x02 | 0x07;
}

/**
 * Encode a complete print job (begin → image → feed → end) as a list of
 * chunks. The caller sends them one by one, waiting for printer ACKs
 * between chunks (see pacing helpers below).
 */
export function encodeJob(
  bitmap: Uint8Array,
  rows: number,
  opts: PrintJobOptions,
): Uint8Array[] {
  const chunks: Uint8Array[] = [CMD.beginJob];
  if (opts.gen === 2) {
    const widthBytes = bitmap.length / rows;
    if (!Number.isInteger(widthBytes)) throw new Error('bitmap length not a multiple of rows');
    const payload = opts.deflate(bitmap);
    const head = gen2ImageHeader(rows, widthBytes, opts.mode ?? 0x07);
    const img = new Uint8Array(head.length + payload.length);
    img.set(head, 0);
    img.set(payload, head.length);
    chunks.push(img);
  } else {
    chunks.push(gen1Image(bitmap, rows, GEN.bytesPerRow(1)));
  }
  chunks.push(CMD.printFeed(opts.feedDots ?? 0x50));
  chunks.push(CMD.endJob);
  return chunks;
}

// ---------------------------------------------------------------- transport helpers

/** Max SPP payload per RFCOMM UIH frame observed from the vendor app. */
export const SPP_CHUNK = 122;

/**
 * Vendor-matched pacing: 122-byte writes with ~20 ms gaps (≈6 KB/s,
 * safely below the printer's inflate+print throughput of ~80 dot-lines/s).
 * The vendor capture shows no per-chunk ACKs during image streaming —
 * completion is signaled by `AA 0D 0A` after endJob (see finishJob).
 */
export async function writeChunk(
  sink: ByteSink,
  chunk: Uint8Array,
  opts: { chunkSize?: number; paceMs?: number } = {},
): Promise<void> {
  const size = opts.chunkSize ?? SPP_CHUNK;
  const pace = opts.paceMs ?? 20;
  for (let off = 0; off < chunk.length; off += size) {
    await sink.write(chunk.subarray(off, Math.min(off + size, chunk.length)));
    await sleep2(pace);
  }
}

function sleep2(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function finishJob(sink: ByteSink, timeoutMs = 10_000): Promise<boolean> {
  await sink.write(CMD.endJob);
  const deadline = Date.now() + timeoutMs;
  let acc: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  while (Date.now() < deadline) {
    const got = await sink.read(); // native 1s poll
    if (got.length === 0) continue;
    const merged = cat(acc, got);
    // look for the sentinel anywhere in the tail
    const tail = merged.subarray(Math.max(0, merged.length - 3));
    if (tail[0] === 0xaa) return true;
    acc = (merged.length > 64 ? merged.subarray(merged.length - 64) : merged) as Uint8Array;
  }
  return false;
}
