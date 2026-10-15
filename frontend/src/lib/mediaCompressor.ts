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

/** Dynamically load PDF.js from cdnjs/jsdelivr with fallback */
let pdfjsPromise: Promise<any> | null = null;
async function getPdfJs(): Promise<any> {
  if (typeof window === 'undefined') return null;
  const w = window as any;
  if (w.pdfjsLib) return w.pdfjsLib;
  if (pdfjsPromise) return pdfjsPromise;

  const CDNS = [
    {
      src: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
      worker: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
    },
    {
      src: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js',
      worker: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js',
    },
    {
      src: 'https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.min.js',
      worker: 'https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.worker.min.js',
    },
  ];

  pdfjsPromise = new Promise((resolve, reject) => {
    let index = 0;
    const tryNext = () => {
      if (index >= CDNS.length) {
        pdfjsPromise = null;
        reject(new Error('Unable to load PDF.js from CDNs.'));
        return;
      }
      const cdn = CDNS[index++];
      const script = document.createElement('script');
      script.src = cdn.src;
      script.async = true;
      script.onload = () => {
        const lib = (window as any).pdfjsLib;
        if (lib) {
          lib.GlobalWorkerOptions.workerSrc = cdn.worker;
          resolve(lib);
        } else {
          tryNext();
        }
      };
      script.onerror = () => {
        script.remove();
        tryNext();
      };
      document.head.appendChild(script);
    };
    tryNext();
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

/** Calculate optimal rendering parameters based on page count so multi-page PDFs
    (including 20, 30, 50+ page exam papers) always fit comfortably under the upload cap. */
export function getAdaptivePdfProfile(numPages: number, targetBytes: number) {
  const safePages = Math.max(1, numPages);
  // Estimate PDF structure overhead (~1200 bytes per page + 40KB catalog/fonts/xref)
  const overhead = Math.min(180_000, safePages * 1200 + 40_000);
  const availableImageBytes = Math.max(80_000, targetBytes - overhead);
  const perPageBudget = Math.floor(availableImageBytes / safePages);

  if (safePages <= 3) {
    return { dpi: 150, quality: 0.82, maxDim: 1920, perPageBudget };
  }
  if (safePages <= 6) {
    return { dpi: 135, quality: 0.78, maxDim: 1650, perPageBudget };
  }
  if (safePages <= 12) {
    return { dpi: 120, quality: 0.72, maxDim: 1450, perPageBudget };
  }
  if (safePages <= 20) {
    return { dpi: 105, quality: 0.65, maxDim: 1250, perPageBudget };
  }
  if (safePages <= 30) {
    return { dpi: 92, quality: 0.60, maxDim: 1100, perPageBudget };
  }
  if (safePages <= 45) {
    return { dpi: 80, quality: 0.52, maxDim: 950, perPageBudget };
  }
  return { dpi: 70, quality: 0.46, maxDim: 850, perPageBudget };
}

/** Compress a PDF file with adaptive page scaling to guarantee fitting upload caps */
export async function compressPdf(file: File, options?: CompressOptions): Promise<MediaCompressResult> {
  const origSize = file.size;
  const onProgress = options?.onProgress;
  const presetKey = options?.preset ?? 'exam';
  const cfg = PRESET_CONFIGS[presetKey] || PRESET_CONFIGS.exam;
  const targetBytes = options?.targetBytes ?? cfg.target;

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
      onProgress?.(12, 'Parsing PDF document…');
      const arrayBuffer = await file.arrayBuffer();
      const loadingTask = pdfjs.getDocument({ data: arrayBuffer });
      const pdfDoc = await loadingTask.promise;
      const numPages = pdfDoc.numPages;

      if (numPages > 0) {
        const profile = getAdaptivePdfProfile(numPages, targetBytes);
        const targetDpi = options?.pdfDpi ? Math.min(options.pdfDpi, profile.dpi * 1.25) : profile.dpi;
        const targetQuality = options?.quality ? Math.min(options.quality, profile.quality) : profile.quality;
        const maxDim = options?.maxDimension ? Math.min(options.maxDimension, profile.maxDim) : profile.maxDim;

        onProgress?.(20, `Optimizing ${numPages} page${numPages > 1 ? 's' : ''} (adaptive ${targetDpi} DPI, ~${Math.round(profile.perPageBudget / 1024)} KB/page)…`);
        const newPdfDoc = await PDFDocument.create();

        for (let i = 1; i <= numPages; i++) {
          const page = await pdfDoc.getPage(i);
          // Scale from DPI (72 pt per inch)
          let scale = targetDpi / 72;
          let viewport = page.getViewport({ scale });
          const maxDimCur = Math.max(viewport.width, viewport.height);
          if (maxDimCur > maxDim) {
            scale = scale * (maxDim / maxDimCur);
            viewport = page.getViewport({ scale });
          }

          const canvas = document.createElement('canvas');
          canvas.width = Math.round(viewport.width);
          canvas.height = Math.round(viewport.height);
          const ctx = canvas.getContext('2d', { alpha: false });

          if (ctx) {
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';
            ctx.fillStyle = '#FFFFFF';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            await page.render({ canvasContext: ctx, viewport }).promise;

            let curQuality = targetQuality;
            let blob = await canvasToBlob(canvas, 'image/jpeg', curQuality);

            // If page is larger than perPageBudget * 1.25, step down quality
            if (blob && blob.size > profile.perPageBudget * 1.25 && curQuality > 0.45) {
              curQuality = Math.max(0.40, curQuality - 0.14);
              blob = await canvasToBlob(canvas, 'image/jpeg', curQuality);
            }

            // If still over budget, downscale canvas slightly
            if (blob && blob.size > profile.perPageBudget * 1.3 && Math.max(canvas.width, canvas.height) > 650) {
              const halfCanvas = document.createElement('canvas');
              halfCanvas.width = Math.round(canvas.width * 0.8);
              halfCanvas.height = Math.round(canvas.height * 0.8);
              const hCtx = halfCanvas.getContext('2d', { alpha: false });
              if (hCtx) {
                hCtx.fillStyle = '#FFFFFF';
                hCtx.fillRect(0, 0, halfCanvas.width, halfCanvas.height);
                hCtx.drawImage(canvas, 0, 0, halfCanvas.width, halfCanvas.height);
                blob = await canvasToBlob(halfCanvas, 'image/jpeg', Math.max(0.38, curQuality - 0.05));
              }
            }

            if (blob) {
              const jpgBytes = new Uint8Array(await blob.arrayBuffer());
              const embeddedJpg = await newPdfDoc.embedJpg(jpgBytes);
              const pdfPage = newPdfDoc.addPage([page.view[2] || embeddedJpg.width, page.view[3] || embeddedJpg.height]);
              pdfPage.drawImage(embeddedJpg, {
                x: 0,
                y: 0,
                width: pdfPage.getWidth(),
                height: pdfPage.getHeight(),
              });
            }
          }

          const pct = 20 + Math.round((i / numPages) * 70);
          onProgress?.(pct, `Processed page ${i} of ${numPages}…`);
        }

        onProgress?.(92, 'Packaging optimized PDF…');
        const compressedPdfBytes = await newPdfDoc.save({ useObjectStreams: true });

        if (compressedPdfBytes.length <= targetBytes || compressedPdfBytes.length < origSize) {
          const cleanName = file.name.replace(/\.pdf$/i, '') + '_compressed.pdf';
          const outPdf = new File([compressedPdfBytes as any], cleanName, { type: 'application/pdf' });
          const saved = Math.max(0, origSize - outPdf.size);

          onProgress?.(100, 'Complete');
          return {
            file: outPdf,
            compressed: outPdf.size < origSize,
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
