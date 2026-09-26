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
import { bt as btStore, useBt, b64FromBytes, bytesFromB64, btPlugin } from './bt';

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
  dither: 'photo' as 'photo' | 'art',
  printing: false,
  progress: 0, // 0..100
  paperOk: true,
});

function rasterize(): Bitmap {
  const p = job.preview;
  if (!p.rgba) throw new Error('no image');
  const gray = toGray(p.rgba, p.srcW, p.srcH);
  const scaled = scaleGray(gray, HEAD_WIDTH_PX, p.rows);
  return job.dither === 'art' ? threshold(scaled) : ditherFloydSteinberg(scaled);
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
  const img = new ImageData(rgba as unknown as ImageDataArray, w, h);
  ctx.putImageData(img, 0, 0);
  return previewCanvas.toDataURL('image/png');
}

async function loadImage(uri: string): Promise<void> {
  // native shares arrive as file:// in the app cache — fetch() it into a
  // blob URL so the <img> decoder works regardless of WebView file policy
  let src = uri;
  if (uri.startsWith('file:')) {
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
  const w = img.naturalWidth, h = img.naturalHeight;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d context');
  ctx.drawImage(img, 0, 0);
  const rgba = ctx.getImageData(0, 0, w, h).data;
  console.log('[lidlprint] loadImage: decoded', w, 'x', h, 'from', uri.slice(0, 48));
  // heuristic per SPEC §3.3: small PNG → art
  const isPng = uri.startsWith('data:image/png') || uri.toLowerCase().endsWith('.png');
  job.dither = isPng && countColors(rgba) <= 64 ? 'art' : 'photo';
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

// Native side (ShareIntentHandler.java) calls this hook; we stage the payload
// and consume it from the page lifecycle.
window.__onLidlPrintShare = (data: { uri?: string; text?: string }) => {
  window.LidlPrintShare = data;
};

export async function consumeShare(): Promise<void> {
  const shared = window.LidlPrintShare;
  if (!shared) return;
  try {
    if (shared.uri) {
      await loadImage(shared.uri);
      delete window.LidlPrintShare;
    } else if (shared.text) {
      textToPreview(shared.text);
      delete window.LidlPrintShare;
    }
    // on failure we KEEP the payload: the user can retry by reopening the
    // page, and the diagnostic message says what went wrong
  } catch (e) {
    console.log('[lidlprint] consumeShare error:', String(e));
    useBt().say(`Could not open shared content: ${String(e)}`, true);
  }
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
      set: (v: 'photo' | 'art') => (job.dither = v),
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
    // 1. paper check
    const sink = makeSink();
    await sink.write(CMD.getPaperStatus);
    const paper = await readSome(sink);
    job.paperOk = paper.length > 0 && paper[paper.length - 1] !== 0x04;
    if (!job.paperOk) {
      say('No paper.', true);
      return;
    }
    // 2. density
    await sink.write(cat(CMD.setDensity(job.density)));
    // 3. build bitmap + job
    const bitmap = rasterize();
    const chunks = encodeJob(bitmap.data, bitmap.height, {
      gen: 2,
      deflate: (d) => pakoDeflateRaw(d),
      // feed 80 dots as the vendor app does
    });
    const total = chunks.reduce((n, c) => n + c.length, 0);
    // 4. send with ACK pacing
    let sent = 0;
    for (const chunk of chunks) {
      await writeChunk(sink, chunk, {
        chunkSize: 122,
        ackTimeoutMs: 1000,
        paceMs: 20,
        // progress reporting per chunk write
      });
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
    // 6. stateless policy: disconnect
    await useBt().disconnect('Printed ✓ (disconnected)');
  } catch (e) {
    say(`Print failed: ${String(e)}`, true);
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
