/* Client-side image downscaling so photo uploads fit the hosting cap.
   Vercel rejects request bodies over ~4.5 MB, so images are shrunk (max
   dimension + JPEG quality steps) until they fit. Non-image files (PDF,
   DOCX, TXT) pass through untouched — the backend error covers those. */

export const UPLOAD_TARGET_BYTES = 3_800_000;
const TARGET_BYTES = UPLOAD_TARGET_BYTES;
const START_DIM = 2000;
const START_Q = 0.85;
const MIN_Q = 0.5;
const MAX_ATTEMPTS = 5;

function drawToBlob(img: ImageBitmap, w: number, h: number, q: number): Promise<Blob | null> {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w));
  canvas.height = Math.max(1, Math.round(h));
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.resolve(null);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return new Promise(resolve => canvas.toBlob(b => resolve(b), 'image/jpeg', q));
}

export interface CompressResult {
  file: File;
  compressed: boolean;
  fromMB: number;
  toMB: number;
}

export async function compressImageIfNeeded(input: File): Promise<CompressResult> {
  const fromMB = input.size / 1048576;
  const done = (file: File, compressed: boolean): CompressResult => ({
    file,
    compressed,
    fromMB,
    toMB: file.size / 1048576,
  });
  if (!input.type.startsWith('image/')) return done(input, false);
  if (input.size <= TARGET_BYTES) return done(input, false);

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(input);
  } catch {
    return done(input, false);
  }
  try {
    const base = Math.min(1, START_DIM / Math.max(bitmap.width, bitmap.height));
    let w = bitmap.width * base;
    let h = bitmap.height * base;
    let q = START_Q;
    let best: File | null = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const blob = await drawToBlob(bitmap, w, h, q);
      if (!blob) break;
      const out = new File([blob], input.name.replace(/\.[a-z0-9]+$/i, '.jpg'), { type: 'image/jpeg' });
      if (!best || out.size < best.size) best = out;
      if (out.size <= TARGET_BYTES) return done(out, true);
      if (q > MIN_Q) q = Math.max(MIN_Q, q - 0.15);
      else {
        w *= 0.75;
        h *= 0.75;
      }
    }
    if (best && best.size < input.size) return done(best, true);
    return done(input, false);
  } finally {
    bitmap.close();
  }
}
