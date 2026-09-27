/**
 * job.ts — print job orchestration + share-intent ingestion.
 *
 * Owns: preview state, density/dither choices, the Print button logic and
 * the full job sequence from doc/SPEC.md §4.3.
 */
import { computed, reactive } from 'vue';
import { deflateRaw as pakoDeflateRaw } from 'pako';
import { toGray, scaleGray, threshold, ditherFloydSteinberg, type Bitmap } from './raster';
import {
  CMD, encodeJob, writeChunk, finishJob, cat, type ByteSink,
} from './printer-protocol';
import { bt as btStore, useBt, b64FromBytes, bytesFromB64, btPlugin, readContentUri } from './bt';

export const HEAD_WIDTH_PX = 384;
export const BYTES_PER_ROW = 48;

interface PreviewState {
  /** object URL for the preview img */
  url: string;
  /** decoded source pixels (RGBA) kept for re-rasterizing on chip change */
  rgba: Uint8ClampedArray | null;
  srcW: number;
  srcH: number;
  rows: number;
}

export const job = reactive({
  preview: {
    url: '',
    rgba: null,
    srcW: 0,
    srcH: 0,
    rows: 0,
  } as PreviewState,
  density: 1 as 0 | 1 | 2,
  dither: (localStorage.getItem('lidlprint.dither') as 'photo' | 'art') || 'art',
  printing: false,
  progress: 0, // 0..100
  paperOk: true,
});

function rasterize(): Bitmap {
  const p = job.preview;
  if (!p.rgba) throw new Error('no image');
  const gray = toGray(p.rgba, p.srcW, p.srcH);
  const scaled = scaleGray(gray, HEAD_WIDTH_PX, p.rows);
  const bm = job.dither === 'art' ? threshold(scaled) : ditherFloydSteinberg(scaled);
  console.log('[lidlprint] rasterize: dither =', job.dither, 'bitmap', bm.width, 'x', bm.height,
    '(', bm.data.length, 'bytes,', bm.bytesPerRow, 'B/row )');
  return bm;
}

function setPreview(rgba: Uint8ClampedArray, w: number, h: number, url?: string) {
  const rows = Math.max(1, Math.round((h * HEAD_WIDTH_PX) / w));
  // mutate, never reassign: useJob() hands the object itself to the template
  if (job.preview.url && job.preview.url.startsWith('blob:')) {
    URL.revokeObjectURL(job.preview.url);
  }
  job.preview.url = url ?? renderPreviewUrl(rgba, w, h);
  job.preview.rgba = rgba;
  job.preview.srcW = w;
  job.preview.srcH = h;
  job.preview.rows = rows;
  console.log('[lidlprint] setPreview: src', w, 'x', h, '-> print 384 x', rows, 'dots');
}

let previewCanvas: HTMLCanvasElement | null = null;
function renderPreviewUrl(rgba: Uint8ClampedArray, w: number, h: number): string {
  previewCanvas = previewCanvas ?? document.createElement('canvas');
  previewCanvas.width = w;
  previewCanvas.height = h;
  const ctx = previewCanvas.getContext('2d');
  if (!ctx) throw new Error('no 2d context');
  // white background so transparent areas read as paper
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  const img = new ImageData(new Uint8ClampedArray(rgba), w, h);
  ctx.putImageData(img, 0, 0);
  return previewCanvas.toDataURL('image/png');
}

async function loadImage(uri: string): Promise<void> {
  // native shares arrive as file:// in the app cache — fetch() it into a
  // blob URL so the <img> decoder works regardless of WebView file policy
  let src = uri;
  if (uri.startsWith('content:')) {
    const b64 = await readContentUri(uri);
    src = `data:image/*;base64,${b64}`;
  } else if (uri.startsWith('file:')) {
    // WebView served from https://localhost cannot fetch file:// —
    // route through Capacitor's webview proxy
    const cap = window.Capacitor as unknown as {
      convertFileSrc?: (p: string) => string;
    };
    if (cap.convertFileSrc) {
      src = cap.convertFileSrc(uri.replace('file://', ''));
    } else {
      const blob = await (await fetch(uri)).blob();
      src = URL.createObjectURL(blob);
    }
  }
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () =>
      reject(new Error(`image decode failed (${src.slice(0, 40)}…, is ${uri.slice(0, 40)}…)`));
    img.src = src;
  });
  let w = img.naturalWidth, h = img.naturalHeight;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d context');
  ctx.drawImage(img, 0, 0);
  let rgba = ctx.getImageData(0, 0, w, h).data;
  console.log('[lidlprint] loadImage: decoded', w, 'x', h, 'from', uri.slice(0, 48));
  if (w > h) {
    // rotate 90° clockwise for preview, matching the print orientation
    const r = new Uint8ClampedArray(rgba.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const src = (y * w + x) * 4;
        const dst = (x * h + (h - 1 - y)) * 4;
        r[dst] = rgba[src]!;
        r[dst + 1] = rgba[src + 1]!;
        r[dst + 2] = rgba[src + 2]!;
        r[dst + 3] = rgba[src + 3]!;
      }
    }
    const tw = w; w = h; h = tw;
    rgba = r;
  }
  // dither choice is user-persistent; no auto-switch
  setPreview(rgba, w, h, src.startsWith('blob:') || src.startsWith('data:') ? src : undefined);
}

function countColors(rgba: Uint8ClampedArray): number {
  const set = new Set<number>();
  const stride = 4 * 7; // sample every 7th pixel — enough for the heuristic
  for (let i = 0; i < rgba.length; i += stride) {
    set.add(((rgba[i] ?? 255) << 16) | ((rgba[i + 1] ?? 255) << 8) | (rgba[i + 2] ?? 255));
    if (set.size > 64) return 65;
  }
  return set.size;
}

// ---------------------------------------------------------------- share intake

declare global {
  interface Window {
    __onLidlPrintShare?: (data: { uri?: string; text?: string }) => void;
  }
}

// ---------------------------------------------------------------- share intake
// Mirrors zik4: darryncampbell intent-shim (getIntent = cold start,
// onIntent = warm singleTask delivery). The native ShareIntentHandler is gone.

declare global {
  interface Window {
    plugins?: {
      intentShim?: {
        getIntent(ok: (i: any) => void, err: (e: any) => void): void;
        onIntent(cb: (i: any) => void): void;
      };
    };
  }
}

function decodeShareIntent(intent: any): void {
  console.log('[lidlprint] intent:', JSON.stringify(intent, null, 2));
  const type: string = intent?.type ?? '';

  // Collect EVERY plausible image-uri candidate, in priority order. Different
  // senders put the payload in different places (url, data, EXTRA_STREAM,
  // clipItems) — take the first that actually decodes.
  const candidates: string[] = [];
  const push = (u: unknown) => {
    if (typeof u === 'string' && u.length > 0 && !candidates.includes(u)) candidates.push(u);
  };
  push(intent?.url);
  push(intent?.data);
  push(intent?.extras?.['android.intent.extra.STREAM']);
  for (const item of intent?.clipItems ?? []) {
    if (item?.type?.startsWith('image/') || !item?.type) push(item?.uri);
  }

  const text = intent?.extras?.['android.intent.extra.TEXT'];

  if (type.startsWith('image/')) {
    if (candidates.length === 0) {
      useBt().say('Share contained no image URI.', true);
      return;
    }
    void loadImageWithFallbacks(candidates);
  } else if (type.startsWith('text/') && text) {
    textToPreview(text);
  } else if (candidates.length > 0) {
    void loadImageWithFallbacks(candidates); // unknown type but has a URI — try it
  } else {
    useBt().say(`Unsupported share (type=${type || 'none'})`, true);
  }
}

/** Try each URI in order until one decodes; banner shows the last failure. */
async function loadImageWithFallbacks(candidates: string[]): Promise<void> {
  let lastErr: unknown;
  for (const uri of candidates) {
    try {
      await loadImage(uri);
      console.log('[lidlprint] loaded candidate:', uri.slice(0, 60));
      return;
    } catch (e) {
      console.log('[lidlprint] candidate failed:', uri.slice(0, 60), String(e));
      lastErr = e;
    }
  }
  useBt().say(`Could not load shared image: ${String(lastErr)}`, true);
}


export async function consumeShare(): Promise<void> {
  const shim = window.plugins?.intentShim;
  if (!shim) return; // web/dev
  shim.getIntent((intent) => decodeShareIntent(intent), () => {});
  shim.onIntent((intent) => decodeShareIntent(intent));
}

const TEXT_FONT_PX = 24;
const TEXT_MAX_ROWS = 20 * 48; // ~20 text lines worth of head height

function textToPreview(text: string): void {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d context');
  ctx.font = `${TEXT_FONT_PX}px sans-serif`;
  // wrap at 384 px
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (ctx.measureText(candidate).width > HEAD_WIDTH_PX - 8 && line) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  const h = Math.min(TEXT_MAX_ROWS, Math.max(1, lines.length) * (TEXT_FONT_PX + 8) + 16);
  canvas.width = HEAD_WIDTH_PX;
  canvas.height = h;
  const ctx2 = canvas.getContext('2d')!;
  ctx2.fillStyle = '#fff';
  ctx2.fillRect(0, 0, HEAD_WIDTH_PX, h);
  ctx2.fillStyle = '#000';
  ctx2.font = `${TEXT_FONT_PX}px sans-serif`;
  lines.forEach((l, i) => ctx2.fillText(l, 4, TEXT_FONT_PX + 8 + i * (TEXT_FONT_PX + 8)));
  const rgba = ctx2.getImageData(0, 0, HEAD_WIDTH_PX, h).data;
  setPreview(rgba, HEAD_WIDTH_PX, h);
}

export function pickImage(): void {
  console.log('[lidlprint] pickImage: opening file dialog');
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.onchange = () => {
    const file = input.files?.[0];
    console.log('[lidlprint] pickImage: picked', file?.name, file?.size);
    if (file) void loadImage(URL.createObjectURL(file));
  };
  input.click();
}

// ---------------------------------------------------------------- printing

export function useJob() {
  return {
    preview: job.preview,
    density: computed({
      get: () => job.density,
      set: (v: 0 | 1 | 2) => (job.density = v),
    }),
    dither: computed({
      get: () => job.dither,
      set: (v: 'photo' | 'art') => {
        job.dither = v;
        localStorage.setItem('lidlprint.dither', v);
      },
    }),
    printLabel: computed(() =>
      job.printing ? `Printing… ${job.progress}%` : 'Print',
    ),
    canPrint: computed(
      () =>
        !!job.preview.rgba &&
        !job.printing &&
        btStore.state === 'connected' &&
        job.paperOk,
    ),
    doPrint,
    pickImage,
    consumeShare,
    loadImage,
  };
}

async function doPrint(): Promise<void> {
  if (job.printing || !job.preview.rgba) return;
  const { say } = useBt();
  job.printing = true;
  job.progress = 0;
  try {
    // 0. warm-up: vendor app queries status right after connect; the printer
    // closes SPP sockets that stay silent, so ping first and reconnect if dead.
    const bt = useBt();
    let sink = makeSink();
    let alive = false;
    try {
      await sink.write(CMD.getBattery);
      const warm = await readSome(sink);
      alive = warm.length > 0;
    } catch { alive = false; }
    if (!alive) {
      say('Reconnecting to printer…');
      await bt.disconnect(''); 
      if (!(await bt.connect())) return;
      sink = makeSink();
      await sink.write(CMD.getBattery);
      const warm2 = await readSome(sink);
      if (warm2.length === 0) {
        say('Printer is not responding.', true);
        return;
      }
    }
    // 1. paper check
    await sink.write(CMD.getPaperStatus);
    const paper = await readSome(sink);
    job.paperOk = paper.length > 0 && paper[paper.length - 1] !== 0x04;
    if (!job.paperOk) {
      say('No paper.', true);
      return;
    }
    // 2. (density: gen-2 has no verified density command in captures — the
    //    header mode byte carries it; sending 10FF1000n prints garbage here)
    // 3. build bitmap + job
    const bitmap = rasterize();
    // append ~10mm (80 dot-lines) of blank paper feed to the bitmap itself
    const blank = new Uint8Array(bitmap.bytesPerRow * 80); // 1 = black; 0 = blank rows? no:
    // NOTE: bit=1 prints black. Blank feed rows must be 0x00 bytes? 1bpp: bit=1 is black,
    // so blank = all zero BITS => byte 0x00. Uint8Array inits to 0. good.
    const full = new Uint8Array(bitmap.data.length + blank.length);
    full.set(bitmap.data, 0);
    full.set(blank, bitmap.data.length);
    const totalRows = bitmap.height + 80;
    const chunks = encodeJob(full, totalRows, {
      gen: 2,
      deflate: (d) => pakoDeflateRaw(d, { level: 0 }) as Uint8Array,
      mode: 0x0c, // vendor's choice for photo shares (see vendor_sent_51)
      // feed 80 dots as the vendor app does
    });
    const total = chunks.reduce((n, c) => n + c.length, 0);
    {
      const img = chunks[1]!;
      (window as any).__lastJob = chunks; // for devtools: inspect/replay
      console.log('[lidlprint] job: img chunk len', img.length,
        'hdr', Array.from(img.subarray(0, 12)).map(b => b.toString(16).padStart(2, '0')).join(' '),
        'first-data', Array.from(img.subarray(12, 20)).map(b => b.toString(16).padStart(2, '0')).join(' '));
    }
    // 4. send with ACK pacing
    let sent = 0;
    for (const chunk of chunks) {
      await writeChunk(sink, chunk);
      sent += chunk.length;
      job.progress = Math.min(99, Math.round((sent / total) * 100));
    }
    // 5. wait for ready sentinel
    const ok = await finishJob(sink, 10_000);
    if (!ok) {
      say('Printer did not confirm end of job.', true);
      return;
    }
    job.progress = 100;
    say('Printed ✓');
    // keep the connection alive (user request); it drops on printer auto-off

  } catch (e) {
    say(`Print failed: ${String(e)}`, true);
  } finally {
    job.printing = false;
  }
}

// Replay the exact captured vendor "hello world" job (doc/RE doc §4).
// console: (await __replayCapture())  — needs printer connected.
(window as any).__replayVendorPhoto = async function () {
  const btMod: any = await import('./bt');
  const store = btMod.bt;
  if (store.state === 'connected') await btMod.useBt().disconnect('');
  if (!(await btMod.useBt().connect())) return 'connect failed';
  console.log('[lidlprint] vendor replay: connected, streaming');
  const hex = await (await fetch('/vendor_sent.hex')).text();
  const bytes = new Uint8Array(hex.trim().split(/\s+/).map(h => parseInt(h, 16)));
  const sink = makeSink();
  const { writeChunk, finishJob } = await import('./printer-protocol');
  await writeChunk(sink, bytes, { chunkSize: 255 });
  const ok = await finishJob(sink, 15000);
  return ok ? 'vendor replay done' : 'no ready sentinel';
};

(window as any).__replayCapture = async function () {
  const btMod: any = await import('./bt');
  const store = btMod.bt;
  // always start from a FRESH connection: the printer drops idle SPP in seconds
  if (store.state === 'connected') await btMod.useBt().disconnect('');
  if (!(await btMod.useBt().connect())) return 'connect failed';
  console.log('[lidlprint] replay: connected, streaming immediately');
  // captured SPP stream (from spp_sent2.bin, 226-row hello world)
  const hex = await (await fetch('/spp_sent2.hex')).text();
  const bytes = new Uint8Array(hex.trim().split(/\s+/).map(h => parseInt(h, 16)));
  const sink = makeSink();
  const { writeChunk } = await import('./printer-protocol');
  await writeChunk(sink, bytes);
  const { finishJob } = await import('./printer-protocol');
  const ok = await finishJob(sink, 10000);
  return ok ? 'replay done' : 'no ready sentinel';
};

// minimal SPP sink over the capacitor bridge
function makeSink(): ByteSink {
  const p = btPlugin();
  return {
    async write(data: Uint8Array) {
      await p.write({ data: b64FromBytes(data) });
    },
    async read(): Promise<Uint8Array> {
      const r = await p.read({ timeoutMs: 1000 });
      return bytesFromB64(r.data);
    },
    async close() {
      await p.disconnect();
    },
  };
}

async function readSome(sink: ByteSink): Promise<Uint8Array> {
  return sink.read();
}
