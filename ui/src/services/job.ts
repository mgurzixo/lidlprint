/**
 * job.ts — print job orchestration + share-intent ingestion.
 *
 * Owns: preview state, dither choice, the Print button logic and
 * the full job sequence from doc/SPEC.md §4.3.
 */
import { computed, reactive } from 'vue';
import { deflateRaw as pakoDeflateRaw } from 'pako';
import { toGray, scaleGray, scaleGrayBilinear, threshold, ditherFloydSteinberg, type Bitmap } from './raster';
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
  dither: (localStorage.getItem('lidlprint.dither') as 'photo' | 'art') || 'art',
  density: (Number(localStorage.getItem('lidlprint.density')) || 1) as 0 | 1 | 2,
  printing: false,
  progress: 0, // 0..100
  paperOk: true,
});

/** Render the 1-bit bitmap to a dataURL — WYSIWYG: this IS what prints. */
let bwCanvas: HTMLCanvasElement | null = null;
function renderBitmapPreview(bm: Bitmap): string {
  bwCanvas = bwCanvas ?? document.createElement('canvas');
  bwCanvas.width = bm.width;
  bwCanvas.height = bm.height;
  const ctx = bwCanvas.getContext('2d');
  if (!ctx) throw new Error('no 2d context');
  const img = ctx.createImageData(bm.width, bm.height);
  const px = img.data;
  for (let y = 0; y < bm.height; y++) {
    for (let x = 0; x < bm.width; x++) {
      const black = (bm.data[y * bm.bytesPerRow + (x >> 3)]! & (0x80 >> (x & 7))) !== 0;
      const o = (y * bm.width + x) * 4;
      const v = black ? 0 : 255; // 1 = black
      px[o] = v; px[o + 1] = v; px[o + 2] = v; px[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return bwCanvas.toDataURL('image/png');
}

/** Re-rasterize the loaded image and refresh the WYSIWYG preview. */
export function refreshBwPreview(): void {
  const p = job.preview;
  if (!p.rgba) return;
  try {
    const bm = rasterize();
    p.url = renderBitmapPreview(bm);
  } catch (e) {
    console.log('[lidlprint] refreshBwPreview error:', String(e));
  }
}

/** density 0=Light / 1=Normal / 2=Darker -> threshold bias for the raster */
function densityBias(): number {
  return job.density === 0 ? 48 : job.density === 2 ? -48 : 0;
}

function rasterize(): Bitmap {
  const p = job.preview;
  if (!p.rgba) throw new Error('no image');
  const bias = densityBias();
  const gray = toGray(p.rgba, p.srcW, p.srcH);
  const scaled =
    job.dither === 'photo'
      ? scaleGrayBilinear(gray, HEAD_WIDTH_PX, p.rows)
      : scaleGray(gray, HEAD_WIDTH_PX, p.rows);
  const bm =
    job.dither === 'photo' ? ditherFloydSteinberg(scaled, bias) : threshold(scaled, 128, bias);
  console.log('[lidlprint] rasterize: dither =', job.dither, 'density =', job.density,
    'bitmap', bm.width, 'x', bm.height,
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
  setPreview(rgba, w, h);
  // WYSIWYG: replace source preview with the rasterized B/W version
  refreshBwPreview();
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
  const type: string = intent?.type ?? '';
  const streamUri = intent?.extras?.['android.intent.extra.STREAM'];
  const clipCount = intent?.clipItems?.length ?? 0;
  // Launcher/normal launch: ACTION_SEND absent, no payload — ignore silently.
  if (intent?.action !== 'android.intent.action.SEND' || (!streamUri && !clipCount)) {
    return; // not a share — plain launch, no message
  }
  console.log('[lidlprint] intent:', JSON.stringify(intent, null, 2));

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

/** Clear the current image and return to the initial screen state. */
export function clearImage(): void {
  if (job.preview.url) URL.revokeObjectURL(job.preview.url);
  job.preview.url = '';
  job.preview.rgba = null;
  job.preview.srcW = 0;
  job.preview.srcH = 0;
  job.preview.rows = 0;
  useBt().say('Make sure that the printer is ON.');
}

/** Read an image from the clipboard via @capacitor/clipboard. */
export async function pasteImage(): Promise<void> {
  try {
    // Preferred: native ClipboardManager (byte-exact via ContentResolver)
    const p = window.Capacitor?.Plugins?.BluetoothClassic as any;
    if (p?.readClipboardImage) {
      const res = await p.readClipboardImage();
      console.log('[lidlprint] pasteImage: native ok, base64 len =', res.data.length);
      await loadImage(`data:image/png;base64,${res.data}`);
      return;
    }
    // Fallback: @capacitor/clipboard JS path (binary string may be mangled)
    const { Clipboard } = await import('@capacitor/clipboard');
    const res = await Clipboard.read();
    console.log('[lidlprint] pasteImage: read() ->',
      { type: res.type, len: res.value?.length, head: res.value?.slice(0, 8) });
    const v = res.value ?? '';
    const isPng = v.charCodeAt(0) === 0x89 && v.slice(1, 4) === 'PNG';
    const isJpeg = v.charCodeAt(0) === 0xff && v.charCodeAt(1) === 0xd8;
    const looksBinary = v.length > 8 && (isPng || isJpeg);
    if (res.type.startsWith('image') || res.value.startsWith('data:image') || looksBinary) {
      // binary-string form (Android returns raw bytes as a JS string): rebuild a blob
      const src = v.startsWith('data:')
        ? v
        : URL.createObjectURL(new Blob([new Uint8Array(Array.from(v, (c) => c.charCodeAt(0) & 0xff))], { type: 'image/png' }));
      await loadImage(src);
      return;
    }
    useBt().say(
      `Clipboard has ${res.type || 'nothing'} — copy an image, or use Share.`,
      true,
    );
  } catch (e) {
    console.log('[lidlprint] pasteImage error:', String(e));
    useBt().say(`Paste failed: ${String(e)}`, true);
  }
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
    dither: computed({
      get: () => job.dither,
      set: (v: 'photo' | 'art') => {
        job.dither = v;
        localStorage.setItem('lidlprint.dither', v);
        refreshBwPreview(); // WYSIWYG: live update
      },
    }),
    density: computed({
      get: () => job.density,
      set: (v: 0 | 1 | 2) => {
        job.density = v;
        localStorage.setItem('lidlprint.density', String(v));
        refreshBwPreview(); // WYSIWYG: live update
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
    clearImage,
    pasteImage,
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
    const bitmap = rasterize();
    // append ~10mm (80 dot-lines) of blank paper feed after the image
    const full = new Uint8Array(bitmap.data.length + bitmap.bytesPerRow * 80);
    full.set(bitmap.data, 0);
    const ok = await sendBitmapJob(full, bitmap.height + 80);
    if (ok) say('Printed ✓');
  } catch (e) {
    say(`Print failed: ${String(e)}`, true);
  } finally {
    job.printing = false;
  }
}

/** Send a complete image job for an already-packed bitmap (+80 feed rows appended by caller). */
async function sendBitmapJob(bitmapBytes: Uint8Array, rows: number): Promise<boolean> {
  const { say } = useBt();
  const bt = useBt();
  try {
    // 0. warm-up: printer closes SPP sockets that stay silent — ping, reconnect if dead
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
      if (!(await bt.connect())) return false;
      sink = makeSink();
      await sink.write(CMD.getBattery);
      const warm2 = await readSome(sink);
      if (warm2.length === 0) {
        say('Printer is not responding.', true);
        return false;
      }
    }
    // 1. paper check
    await sink.write(CMD.getPaperStatus);
    const paper = await readSome(sink);
    job.paperOk = paper.length > 0 && paper[paper.length - 1]! !== 0x04;
    if (!job.paperOk) {
      say('No paper.', true);
      return false;
    }
    // 2. build + send job (vendor-exact: begin, header+deflate, feed, end)
    const chunks = encodeJob(bitmapBytes, rows, {
      gen: 2,
      deflate: (d) => pakoDeflateRaw(d, { level: 0 }) as Uint8Array,
      mode: 0x0c, // vendor's choice for photo shares (see vendor_sent_51)
    });
    const total = chunks.reduce((n, c) => n + c.length, 0);
    let sent = 0;
    for (const chunk of chunks) {
      await writeChunk(sink, chunk, { chunkSize: 255 });
      sent += chunk.length;
      job.progress = Math.min(99, Math.round((sent / total) * 100));
    }
    // 3. wait for the ready sentinel
    const ok = await finishJob(sink, 10_000);
    if (!ok) {
      say('Printer did not confirm end of job.', true);
      return false;
    }
    return true;
  } catch (e) {
    say(`Print failed: ${String(e)}`, true);
    return false;
  } finally {
    job.printing = false;
  }
}

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
