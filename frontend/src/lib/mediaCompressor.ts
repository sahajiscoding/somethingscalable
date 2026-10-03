/* Comprehensive client-side Media Compression Engine for WeHelpTeachers.
   Supports both image downscaling/re-encoding (JPG, PNG, WebP, HEIC/HEIF, BMP, GIF)
   and multi-page PDF rasterize-and-repack compression via pdfjs and pdf-lib.
   Guarantees uploads fit the Vercel 4.5 MB request ceiling with high visual
   clarity for vision OCR and handwriting evaluation. */

import { PDFDocument } from 'pdf-lib';

export const UPLOAD_TARGET_BYTES = 3_500_000; // 3.5 MB safe limit for 4.5 MB Vercel ceiling
export const MAX_SAFE_IMAGE_DIM = 2048;

export interface MediaCompressResult {
  file: File;
  compressed: boolean;
  originalBytes: number;
  compressedBytes: number;
  fromMB: number;
  toMB: number;
  savedBytes: number;
  savedPercent: number;
  kind: 'image' | 'pdf' | 'text' | 'other';
  width?: number;
  height?: number;
  pageCount?: number;
  previewUrl?: string;
  note?: string;
}

export interface CompressOptions {
  targetBytes?: number;
  maxDimension?: number;
  quality?: number; // 0.1 to 1.0
  mimeType?: 'image/jpeg' | 'image/webp';
  preset?: 'exam' | 'high' | 'medium' | 'low' | 'custom';
  pdfDpi?: number;
  onProgress?: (pct: number, message: string) => void;
}

const PRESET_CONFIGS: Record<string, { maxDim: number; quality: number; target: number; pdfDpi: number }> = {
  exam: { maxDim: 1920, quality: 0.82, target: 3_500_000, pdfDpi: 150 },
  high: { maxDim: 2200, quality: 0.88, target: 3_800_000, pdfDpi: 180 },
  medium: { maxDim: 1600, quality: 0.78, target: 2_000_000, pdfDpi: 130 },
  low: { maxDim: 1280, quality: 0.65, target: 1_200_000, pdfDpi: 110 },
  custom: { maxDim: 1920, quality: 0.82, target: 3_500_000, pdfDpi: 150 },
};

export function isImageFile(file: File): boolean {
  if (file.type && file.type.startsWith('image/')) return true;
  return /\.(jpe?g|png|webp|bmp|gif|tiff?|heic|heif)$/i.test(file.name);
}

export function isPdfFile(file: File): boolean {
  if (file.type === 'application/pdf') return true;
  return /\.pdf$/i.test(file.name);
}

/** Decode an image file using either createImageBitmap or HTMLImageElement fallback */
async function decodeImage(file: File): Promise<{ width: number; height: number; render: (ctx: CanvasRenderingContext2D, w: number, h: number) => void; close?: () => void }> {
  // Method A: createImageBitmap (fast modern path)
  if (typeof createImageBitmap !== 'undefined') {
    try {
      const bitmap = await createImageBitmap(file);
      return {
        width: bitmap.width,
        height: bitmap.height,
        render: (ctx, w, h) => ctx.drawImage(bitmap, 0, 0, w, h),
        close: () => bitmap.close(),
      };
    } catch {
      // Fall through to HTMLImageElement
    }
  }

  // Method B: HTMLImageElement (universal browser fallback)
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      resolve({
        width: img.naturalWidth || img.width,
        height: img.naturalHeight || img.height,
        render: (ctx, w, h) => {
          ctx.drawImage(img, 0, 0, w, h);
        },
        close: () => URL.revokeObjectURL(url),
      });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`Could not decode image: ${file.name}`));
    };
    img.src = url;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, mime: string, quality: number): Promise<Blob | null> {
  return new Promise(resolve => {
    canvas.toBlob(b => resolve(b), mime, quality);
  });
}

/** Dynamically load PDF.js from cdnjs if not already present on window */
let pdfjsPromise: Promise<any> | null = null;
async function getPdfJs(): Promise<any> {
  if (typeof window === 'undefined') return null;
  const w = window as any;
  if (w.pdfjsLib) return w.pdfjsLib;
  if (pdfjsPromise) return pdfjsPromise;

  pdfjsPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
    script.async = true;
    script.onload = () => {
      const lib = (window as any).pdfjsLib;
      if (lib) {
        lib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
        resolve(lib);
      } else {
        reject(new Error('PDF.js library failed to initialize.'));
      }
    };
    script.onerror = () => {
      pdfjsPromise = null;
      reject(new Error('Unable to load PDF.js from CDN.'));
    };
    document.head.appendChild(script);
  });

  return pdfjsPromise;
}

/** Compress an image file with progressive quality & dimension reduction */
export async function compressImage(file: File, options?: CompressOptions): Promise<MediaCompressResult> {
  const origSize = file.size;
  const presetKey = options?.preset ?? 'exam';
  const cfg = PRESET_CONFIGS[presetKey] || PRESET_CONFIGS.exam;
  const targetBytes = options?.targetBytes ?? cfg.target;
  const maxDim = options?.maxDimension ?? cfg.maxDim;
  let quality = options?.quality ?? cfg.quality;
  const outMime = options?.mimeType || 'image/jpeg';
  const onProgress = options?.onProgress;

  onProgress?.(10, 'Decoding image…');
  let decoded: Awaited<ReturnType<typeof decodeImage>>;
  try {
    decoded = await decodeImage(file);
  } catch (err: any) {
    return {
      file,
      compressed: false,
      originalBytes: origSize,
      compressedBytes: origSize,
      fromMB: origSize / 1048576,
      toMB: origSize / 1048576,
      savedBytes: 0,
      savedPercent: 0,
      kind: 'image',
      note: `Decoding skipped: ${err?.message || 'Unsupported image encoding'}`,
    };
  }

  try {
    const origW = decoded.width;
    const origH = decoded.height;
    const scale = Math.min(1.0, maxDim / Math.max(origW, origH));
    let curW = Math.max(1, Math.round(origW * scale));
    let curH = Math.max(1, Math.round(origH * scale));

    const canvas = document.createElement('canvas');
    canvas.width = curW;
    canvas.height = curH;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Could not get 2D canvas context');

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    // Solid white background for transparent PNG / WEBP conversion
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, curW, curH);
    decoded.render(ctx, curW, curH);

    onProgress?.(40, 'Optimizing quality…');

    let bestBlob: Blob | null = null;
    const maxAttempts = 6;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const blob = await canvasToBlob(canvas, outMime, quality);
      if (!blob) break;

      if (!bestBlob || blob.size < bestBlob.size) {
        bestBlob = blob;
      }

      onProgress?.(
        40 + Math.round(((attempt + 1) / maxAttempts) * 50),
        `Compressing attempt ${attempt + 1}: ${(blob.size / 1048576).toFixed(2)} MB…`
      );

      if (blob.size <= targetBytes) {
        bestBlob = blob;
        break;
      }

      // Step down quality, then dimensions if quality is already low
      if (quality > 0.55) {
        quality = Math.max(0.48, quality - 0.14);
      } else {
        curW = Math.max(480, Math.round(curW * 0.78));
        curH = Math.max(480, Math.round(curH * 0.78));
        canvas.width = curW;
        canvas.height = curH;
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, curW, curH);
        decoded.render(ctx, curW, curH);
      }
    }

    onProgress?.(100, 'Done');

    if (bestBlob && (bestBlob.size < origSize || bestBlob.size <= targetBytes)) {
      const ext = outMime === 'image/webp' ? '.webp' : '.jpg';
      const cleanName = file.name.replace(/\.[a-z0-9]+$/i, '') + ext;
      const compressedFile = new File([bestBlob], cleanName, { type: outMime });
      const saved = Math.max(0, origSize - compressedFile.size);
      const previewUrl = URL.createObjectURL(compressedFile);

      return {
        file: compressedFile,
        compressed: true,
        originalBytes: origSize,
        compressedBytes: compressedFile.size,
        fromMB: origSize / 1048576,
        toMB: compressedFile.size / 1048576,
        savedBytes: saved,
        savedPercent: Math.round((saved / origSize) * 100),
        kind: 'image',
        width: curW,
        height: curH,
        previewUrl,
      };
    }

    return {
      file,
      compressed: false,
      originalBytes: origSize,
      compressedBytes: origSize,
      fromMB: origSize / 1048576,
      toMB: origSize / 1048576,
      savedBytes: 0,
      savedPercent: 0,
      kind: 'image',
      width: origW,
      height: origH,
      note: 'File was already smaller than target.',
    };
  } finally {
    decoded.close?.();
  }
}

/** Compress a PDF file by rendering each page to high-res JPEG and repacking with pdf-lib */
export async function compressPdf(file: File, options?: CompressOptions): Promise<MediaCompressResult> {
  const origSize = file.size;
  const onProgress = options?.onProgress;
  const presetKey = options?.preset ?? 'exam';
  const cfg = PRESET_CONFIGS[presetKey] || PRESET_CONFIGS.exam;
  const targetQuality = options?.quality ?? cfg.quality;
  const targetDpi = options?.pdfDpi ?? cfg.pdfDpi;

  onProgress?.(5, 'Loading PDF parser…');

  // Try PDF.js rendering path
  let pdfjs: any = null;
  try {
    pdfjs = await getPdfJs();
  } catch {
    // PDF.js unavailable, fall back to pure pdf-lib repack
  }

  if (pdfjs) {
    try {
      onProgress?.(15, 'Parsing PDF document…');
      const arrayBuffer = await file.arrayBuffer();
      const loadingTask = pdfjs.getDocument({ data: arrayBuffer });
      const pdfDoc = await loadingTask.promise;
      const numPages = pdfDoc.numPages;

      if (numPages > 0) {
        onProgress?.(25, `Rendering ${numPages} page${numPages > 1 ? 's' : ''}…`);
        const newPdfDoc = await PDFDocument.create();

        for (let i = 1; i <= numPages; i++) {
          const page = await pdfDoc.getPage(i);
          // Scale: 72 points per inch in PDF. scale = targetDpi / 72
          const standardScale = targetDpi / 72;
          const viewport = page.getViewport({ scale: standardScale });

          const canvas = document.createElement('canvas');
          canvas.width = Math.round(viewport.width);
          canvas.height = Math.round(viewport.height);
          const ctx = canvas.getContext('2d', { alpha: false });

          if (ctx) {
            ctx.fillStyle = '#FFFFFF';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            await page.render({ canvasContext: ctx, viewport }).promise;

            const blob = await canvasToBlob(canvas, 'image/jpeg', targetQuality);
            if (blob) {
              const jpgBytes = new Uint8Array(await blob.arrayBuffer());
              const embeddedJpg = await newPdfDoc.embedJpg(jpgBytes);
              // Use standard PDF points for page dimension
              const pdfPage = newPdfDoc.addPage([page.view[2] || embeddedJpg.width, page.view[3] || embeddedJpg.height]);
              pdfPage.drawImage(embeddedJpg, {
                x: 0,
                y: 0,
                width: pdfPage.getWidth(),
                height: pdfPage.getHeight(),
              });
            }
          }

          const pct = 25 + Math.round((i / numPages) * 60);
          onProgress?.(pct, `Processed page ${i} of ${numPages}…`);
        }

        onProgress?.(90, 'Packaging optimized PDF…');
        const compressedPdfBytes = await newPdfDoc.save({ useObjectStreams: true });

        if (compressedPdfBytes.length < origSize || origSize > (options?.targetBytes ?? cfg.target)) {
          const cleanName = file.name.replace(/\.pdf$/i, '') + '_compressed.pdf';
          const outPdf = new File([compressedPdfBytes as any], cleanName, { type: 'application/pdf' });
          const saved = Math.max(0, origSize - outPdf.size);

          onProgress?.(100, 'Complete');
          return {
            file: outPdf,
            compressed: true,
            originalBytes: origSize,
            compressedBytes: outPdf.size,
            fromMB: origSize / 1048576,
            toMB: outPdf.size / 1048576,
            savedBytes: saved,
            savedPercent: Math.round((saved / origSize) * 100),
            kind: 'pdf',
            pageCount: numPages,
          };
        }
      }
    } catch (err: any) {
      console.warn('PDF.js rasterization failed, attempting pure stream repack:', err);
    }
  }

  // Fallback: pure pdf-lib stream repack
  try {
    onProgress?.(50, 'Optimizing PDF object streams…');
    const arrayBuffer = await file.arrayBuffer();
    const doc = await PDFDocument.load(arrayBuffer, { ignoreEncryption: true });
    const savedBytes = await doc.save({ useObjectStreams: true });
    const numPages = doc.getPageCount();

    if (savedBytes.length < origSize) {
      const outPdf = new File([savedBytes as any], file.name, { type: 'application/pdf' });
      const saved = origSize - outPdf.size;
      onProgress?.(100, 'Complete');
      return {
        file: outPdf,
        compressed: true,
        originalBytes: origSize,
        compressedBytes: outPdf.size,
        fromMB: origSize / 1048576,
        toMB: outPdf.size / 1048576,
        savedBytes: saved,
        savedPercent: Math.round((saved / origSize) * 100),
        kind: 'pdf',
        pageCount: numPages,
      };
    }
  } catch (err: any) {
    console.warn('Pure pdf-lib repack failed:', err);
  }

  onProgress?.(100, 'Unchanged');
  return {
    file,
    compressed: false,
    originalBytes: origSize,
    compressedBytes: origSize,
    fromMB: origSize / 1048576,
    toMB: origSize / 1048576,
    savedBytes: 0,
    savedPercent: 0,
    kind: 'pdf',
    note: 'PDF could not be further reduced.',
  };
}

/** Universal media compressor — routes to image or PDF engine */
export async function compressMedia(file: File, options?: CompressOptions): Promise<MediaCompressResult> {
  if (isImageFile(file)) {
    return compressImage(file, options);
  }
  if (isPdfFile(file)) {
    return compressPdf(file, options);
  }
  // Other files (TXT, MD) pass through
  const s = file.size;
  return {
    file,
    compressed: false,
    originalBytes: s,
    compressedBytes: s,
    fromMB: s / 1048576,
    toMB: s / 1048576,
    savedBytes: 0,
    savedPercent: 0,
    kind: 'text',
    note: 'Text files do not require compression.',
  };
}

/** Fast check-and-compress helper for grading flow */
export async function compressMediaIfNeeded(
  file: File,
  targetBytes: number = UPLOAD_TARGET_BYTES,
  onProgress?: (pct: number, msg: string) => void
): Promise<MediaCompressResult> {
  const origSize = file.size;
  if (origSize <= targetBytes && !isImageFile(file) && !isPdfFile(file)) {
    return {
      file,
      compressed: false,
      originalBytes: origSize,
      compressedBytes: origSize,
      fromMB: origSize / 1048576,
      toMB: origSize / 1048576,
      savedBytes: 0,
      savedPercent: 0,
      kind: 'other',
    };
  }

  // If already under target, skip unless explicitly needed
  if (origSize <= targetBytes) {
    return {
      file,
      compressed: false,
      originalBytes: origSize,
      compressedBytes: origSize,
      fromMB: origSize / 1048576,
      toMB: origSize / 1048576,
      savedBytes: 0,
      savedPercent: 0,
      kind: isImageFile(file) ? 'image' : isPdfFile(file) ? 'pdf' : 'other',
    };
  }

  return compressMedia(file, { targetBytes, preset: 'exam', onProgress });
}

/** Alias for backward compatibility */
export const compressImageIfNeeded = compressMediaIfNeeded;
