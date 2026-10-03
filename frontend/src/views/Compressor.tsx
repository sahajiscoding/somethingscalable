import { useState, useRef, useEffect, useCallback } from 'react';
import {
  compressMedia,
  isImageFile,
  isPdfFile,
  UPLOAD_TARGET_BYTES,
  type CompressOptions,
  type MediaCompressResult,
} from '../lib/mediaCompressor';
import type { View } from '../lib/view';

interface CompressorProps {
  onNavigate: (v: View) => void;
  onSendToGrader?: (file: File, role: 'paper' | 'key' | 'sheet') => void;
}

export default function Compressor({ onNavigate, onSendToGrader }: CompressorProps) {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [preset, setPreset] = useState<'exam' | 'high' | 'medium' | 'low' | 'custom'>('exam');
  const [quality, setQuality] = useState(82);
  const [maxDimension, setMaxDimension] = useState(1920);
  const [targetMB, setTargetMB] = useState(3.5);
  const [isCompressing, setIsCompressing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressMsg, setProgressMsg] = useState('');
  const [result, setResult] = useState<MediaCompressResult | null>(null);
  const [previewTab, setPreviewTab] = useState<'after' | 'before'>('after');
  const [origPreviewUrl, setOrigPreviewUrl] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleSelectFile = useCallback((file: File) => {
    setSelectedFile(file);
    setResult(null);
    setProgress(0);
    setProgressMsg('');

    if (origPreviewUrl) {
      URL.revokeObjectURL(origPreviewUrl);
      setOrigPreviewUrl(null);
    }

    if (isImageFile(file)) {
      setOrigPreviewUrl(URL.createObjectURL(file));
    }
  }, [origPreviewUrl]);

  useEffect(() => {
    return () => {
      if (origPreviewUrl) URL.revokeObjectURL(origPreviewUrl);
      if (result?.previewUrl) URL.revokeObjectURL(result.previewUrl);
    };
  }, [origPreviewUrl, result]);

  const handleRunCompress = async () => {
    if (!selectedFile || isCompressing) return;
    setIsCompressing(true);
    setProgress(5);
    setProgressMsg('Initiating compression…');

    try {
      const options: CompressOptions = {
        preset,
        quality: quality / 100,
        maxDimension,
        targetBytes: targetMB * 1024 * 1024,
        onProgress: (pct, msg) => {
          setProgress(pct);
          setProgressMsg(msg);
        },
      };

      const res = await compressMedia(selectedFile, options);
      setResult(res);
      setProgress(100);
      setProgressMsg('Compression complete!');
    } catch (err: any) {
      setProgressMsg(`Error: ${err?.message || 'Compression failed'}`);
    } finally {
      setIsCompressing(false);
    }
  };

  const handleDownload = () => {
    if (!result) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(result.file);
    a.download = result.file.name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 1000);
  };

  const handleUseInGrading = (role: 'paper' | 'key' | 'sheet') => {
    if (!result) return;
    if (onSendToGrader) {
      onSendToGrader(result.file, role);
    } else {
      onNavigate('grading');
    }
  };

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      {/* Header */}
      <div className="mb-8 text-center">
        <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-mint/30 bg-mint/10 px-3.5 py-1 text-xs font-bold text-mint">
          <span>🗜</span> CLIENT-SIDE COMPRESSION ENGINE
        </div>
        <h1 className="text-3xl font-extrabold tracking-tight md:text-5xl">Media Compressor</h1>
        <p className="mx-auto mt-3 max-w-2xl text-sm leading-relaxed text-white/55 md:text-base">
          Compress high-resolution exam scans, phone photos, and multi-page PDFs to effortlessly fit the 4.5 MB hosting cap
          while maintaining crisp handwriting and diagram legibility for AI evaluation.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-12">
        {/* Left Column: Upload & Options */}
        <div className="space-y-6 lg:col-span-5">
          {/* Upload Box */}
          <div
            role="button"
            tabIndex={0}
            onClick={() => fileInputRef.current?.click()}
            onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && fileInputRef.current?.click()}
            onDragEnter={e => { e.preventDefault(); setDragOver(true); }}
            onDragOver={e => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={e => { e.preventDefault(); setDragOver(false); }}
            onDrop={e => {
              e.preventDefault();
              setDragOver(false);
              const f = e.dataTransfer?.files?.[0];
              if (f) handleSelectFile(f);
            }}
            className={`relative flex min-h-[190px] cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed p-6 text-center transition outline-none ${
              dragOver
                ? 'border-mint bg-mint/10 scale-[1.01]'
                : selectedFile
                  ? 'border-mint/50 bg-mint/5'
                  : 'border-white/15 bg-black/25 hover:border-mint/40 hover:bg-black/35'
            }`}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,.png,.jpg,.jpeg,.webp,.bmp,.gif"
              className="hidden"
              onChange={e => {
                const f = e.target.files?.[0];
                if (f) handleSelectFile(f);
              }}
            />

            <div className="mb-3 grid h-12 w-12 place-items-center rounded-2xl border border-white/10 bg-white/5 text-2xl text-mint">
              {selectedFile ? (isPdfFile(selectedFile) ? '📄' : '🖼️') : '📁'}
            </div>

            {selectedFile ? (
              <div className="space-y-1">
                <div className="max-w-[280px] overflow-hidden text-ellipsis whitespace-nowrap text-sm font-bold text-white">
                  {selectedFile.name}
                </div>
                <div className="text-xs text-white/50">
                  {(selectedFile.size / 1048576).toFixed(2)} MB • {selectedFile.type || 'Document'}
                </div>
                {selectedFile.size > UPLOAD_TARGET_BYTES && (
                  <div className="mt-1 text-[11px] font-semibold text-amber-400">
                    ⚠ Over the 4.5 MB cap — compression recommended
                  </div>
                )}
                <div className="mt-2 text-[11px] text-mint underline">Click or drop to replace file</div>
              </div>
            ) : (
              <div className="space-y-1">
                <div className="text-sm font-bold text-white">Drop your media file here</div>
                <div className="text-xs text-white/45">Supports Multi-page PDFs, JPG, PNG, WebP, BMP</div>
                <div className="pt-2 text-xs font-semibold text-mint">Click to browse files</div>
              </div>
            )}
          </div>

          {/* Preset Buttons */}
          <div className="rounded-2xl border border-white/10 bg-black/40 p-5 backdrop-blur">
            <label className="mb-3 block text-xs font-bold tracking-wider text-white/60 uppercase">
              Compression Preset
            </label>
            <div className="grid grid-cols-2 gap-2">
              {[
                { id: 'exam', label: '⚡ Exam Grading', desc: 'Target <3.5 MB, high OCR clarity' },
                { id: 'high', label: '💎 High Quality', desc: 'Max visual fidelity, 88% quality' },
                { id: 'medium', label: '⚖️ Balanced', desc: 'Fast load, ~2 MB target' },
                { id: 'low', label: '📦 Max Squeeze', desc: 'Lowest file size, 65% quality' },
              ].map(p => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setPreset(p.id as any)}
                  className={`cursor-pointer rounded-xl border p-2.5 text-left transition ${
                    preset === p.id
                      ? 'border-mint bg-mint/15 text-white'
                      : 'border-white/10 bg-white/5 text-white/70 hover:border-white/20'
                  }`}
                >
                  <div className="text-xs font-bold">{p.label}</div>
                  <div className="mt-0.5 text-[10.5px] text-white/45">{p.desc}</div>
                </button>
              ))}
            </div>

            {/* Custom Mode Toggle */}
            <div className="mt-4 pt-3 border-t border-white/10">
              <button
                type="button"
                onClick={() => setPreset(p => (p === 'custom' ? 'exam' : 'custom'))}
                className="flex w-full items-center justify-between text-xs font-semibold text-white/60 hover:text-white"
              >
                <span>⚙️ Fine-Tune Parameters</span>
                <span className="text-mint">{preset === 'custom' ? 'Active' : 'Customize'}</span>
              </button>

              {preset === 'custom' && (
                <div className="mt-4 space-y-4 rounded-xl border border-white/10 bg-black/25 p-3.5">
                  <div>
                    <div className="flex justify-between text-xs text-white/70">
                      <span>JPEG Quality</span>
                      <span className="font-mono text-mint">{quality}%</span>
                    </div>
                    <input
                      type="range"
                      min="30"
                      max="95"
                      value={quality}
                      onChange={e => setQuality(Number(e.target.value))}
                      className="mt-1.5 w-full accent-mint"
                    />
                  </div>

                  <div>
                    <div className="flex justify-between text-xs text-white/70">
                      <span>Max Dimension</span>
                      <span className="font-mono text-mint">{maxDimension} px</span>
                    </div>
                    <input
                      type="range"
                      min="800"
                      max="3200"
                      step="100"
                      value={maxDimension}
                      onChange={e => setMaxDimension(Number(e.target.value))}
                      className="mt-1.5 w-full accent-mint"
                    />
                  </div>

                  <div>
                    <div className="flex justify-between text-xs text-white/70">
                      <span>Target Ceiling</span>
                      <span className="font-mono text-mint">{targetMB.toFixed(1)} MB</span>
                    </div>
                    <input
                      type="range"
                      min="0.5"
                      max="4.2"
                      step="0.1"
                      value={targetMB}
                      onChange={e => setTargetMB(Number(e.target.value))}
                      className="mt-1.5 w-full accent-mint"
                    />
                  </div>
                </div>
              )}
            </div>

            {/* Compress Action Button */}
            <button
              type="button"
              disabled={!selectedFile || isCompressing}
              onClick={handleRunCompress}
              className="mt-5 flex w-full cursor-pointer items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-mint to-[#4e9a6a] px-4 py-3 text-sm font-extrabold text-[#0d1a12] shadow-lg shadow-mint/20 transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isCompressing ? (
                <>
                  <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-[#0d1a12] border-t-transparent" />
                  <span>{progressMsg || 'Compressing…'}</span>
                </>
              ) : (
                <>
                  <span>🗜 Compress Media</span>
                </>
              )}
            </button>

            {isCompressing && (
              <div className="mt-3">
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                  <div
                    className="h-full bg-mint transition-all duration-300"
                    style={{ width: `${progress}%` }}
                  />
                </div>
                <div className="mt-1 text-right font-mono text-[10px] text-white/45">{progress}%</div>
              </div>
            )}
          </div>
        </div>

        {/* Right Column: Results & Previews */}
        <div className="space-y-6 lg:col-span-7">
          {result ? (
            <div className="rounded-2xl border border-white/10 bg-black/40 p-6 backdrop-blur">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 pb-4">
                <div className="flex items-center gap-2.5">
                  <span className="grid h-7 w-7 place-items-center rounded-lg bg-mint/20 text-sm font-black text-mint">
                    ✓
                  </span>
                  <div>
                    <h3 className="text-base font-bold text-white">Compression Complete</h3>
                    <div className="text-xs text-white/50">{result.file.name}</div>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <span className="rounded-full bg-mint/15 px-3 py-1 text-xs font-bold text-mint">
                    {result.savedPercent > 0 ? `-${result.savedPercent}% Smaller` : 'Optimized'}
                  </span>
                  <span className="rounded-full bg-black/40 px-3 py-1 text-xs font-semibold text-white/70">
                    {result.kind.toUpperCase()}
                  </span>
                </div>
              </div>

              {/* Stats Grid */}
              <div className="my-5 grid grid-cols-3 gap-3">
                <div className="rounded-xl border border-white/10 bg-black/25 p-3.5 text-center">
                  <div className="text-[11px] font-semibold text-white/40 uppercase">Original Size</div>
                  <div className="mt-1 text-lg font-extrabold text-white/80">{result.fromMB.toFixed(2)} MB</div>
                </div>
                <div className="rounded-xl border border-mint/30 bg-mint/10 p-3.5 text-center">
                  <div className="text-[11px] font-semibold text-mint uppercase">Compressed Size</div>
                  <div className="mt-1 text-lg font-black text-mint">{result.toMB.toFixed(2)} MB</div>
                </div>
                <div className="rounded-xl border border-white/10 bg-black/25 p-3.5 text-center">
                  <div className="text-[11px] font-semibold text-white/40 uppercase">Data Saved</div>
                  <div className="mt-1 text-lg font-extrabold text-[#d8f5db]">
                    {(result.savedBytes / 1048576).toFixed(2)} MB
                  </div>
                </div>
              </div>

              {/* Preview Area */}
              {result.kind === 'image' && (
                <div className="mb-5 overflow-hidden rounded-xl border border-white/10 bg-black/35">
                  <div className="flex items-center justify-between border-b border-white/10 px-4 py-2.5">
                    <span className="text-xs font-bold text-white/70">Visual Quality Inspector</span>
                    <div className="flex rounded-lg border border-white/10 bg-black/30 p-0.5 text-xs">
                      <button
                        type="button"
                        onClick={() => setPreviewTab('after')}
                        className={`rounded-md px-2.5 py-1 font-semibold transition ${
                          previewTab === 'after' ? 'bg-mint text-[#0d1a12]' : 'text-white/60 hover:text-white'
                        }`}
                      >
                        Compressed
                      </button>
                      {origPreviewUrl && (
                        <button
                          type="button"
                          onClick={() => setPreviewTab('before')}
                          className={`rounded-md px-2.5 py-1 font-semibold transition ${
                            previewTab === 'before' ? 'bg-mint text-[#0d1a12]' : 'text-white/60 hover:text-white'
                          }`}
                        >
                          Original
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="relative flex max-h-[360px] items-center justify-center p-4">
                    <img
                      src={(previewTab === 'after' ? result.previewUrl : origPreviewUrl) || result.previewUrl}
                      alt="Compressed preview"
                      className="max-h-[320px] max-w-full rounded-lg object-contain shadow-md"
                    />
                  </div>
                  {result.width && result.height && (
                    <div className="border-t border-white/10 px-4 py-2 text-right text-[11px] text-white/40">
                      Dimensions: {result.width} × {result.height} px
                    </div>
                  )}
                </div>
              )}

              {result.kind === 'pdf' && (
                <div className="mb-5 rounded-xl border border-white/10 bg-black/25 p-5 text-center">
                  <div className="text-3xl">📄</div>
                  <div className="mt-2 text-sm font-bold text-white">Multi-Page PDF Repackaged</div>
                  <div className="mt-1 text-xs text-white/50">
                    {result.pageCount ? `${result.pageCount} page(s) processed` : 'Optimized stream packaging'} • Fits
                    under hosting limits
                  </div>
                </div>
              )}

              {/* Actions Grid */}
              <div className="space-y-3 pt-2">
                <button
                  type="button"
                  onClick={handleDownload}
                  className="flex w-full cursor-pointer items-center justify-center gap-2 rounded-xl border border-white/15 bg-white/5 py-3 text-sm font-bold text-white transition hover:bg-white/10"
                >
                  <span>⬇ Download Compressed File</span>
                </button>

                <div className="rounded-xl border border-mint/20 bg-mint/5 p-3.5">
                  <div className="mb-2 text-xs font-bold text-mint">Direct Transfer to Exam Grading:</div>
                  <div className="grid grid-cols-3 gap-2">
                    <button
                      type="button"
                      onClick={() => handleUseInGrading('paper')}
                      className="cursor-pointer rounded-lg border border-mint/30 bg-mint/10 px-2 py-2 text-xs font-bold text-[#d8f5db] transition hover:bg-mint/20"
                    >
                      Use as Question Paper
                    </button>
                    <button
                      type="button"
                      onClick={() => handleUseInGrading('key')}
                      className="cursor-pointer rounded-lg border border-mint/30 bg-mint/10 px-2 py-2 text-xs font-bold text-[#d8f5db] transition hover:bg-mint/20"
                    >
                      Use as Answer Key
                    </button>
                    <button
                      type="button"
                      onClick={() => handleUseInGrading('sheet')}
                      className="cursor-pointer rounded-lg border border-mint/30 bg-mint/10 px-2 py-2 text-xs font-bold text-[#d8f5db] transition hover:bg-mint/20"
                    >
                      Use as Student Sheet
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex min-h-[400px] flex-col items-center justify-center rounded-2xl border border-white/10 bg-black/25 p-8 text-center">
              <div className="mb-4 grid h-16 w-16 place-items-center rounded-2xl border border-white/10 bg-white/5 text-3xl">
                ⚙️
              </div>
              <h3 className="text-lg font-bold text-white">Ready to Compress</h3>
              <p className="mt-1.5 max-w-sm text-xs leading-relaxed text-white/50">
                Select or drop an oversized exam paper, rubric, or student script to preview compression savings and
                quality retention.
              </p>
              <div className="mt-6 flex flex-wrap justify-center gap-2">
                <span className="rounded-lg border border-white/10 bg-black/40 px-2.5 py-1 text-xs text-white/60">
                  Fast in-browser processing
                </span>
                <span className="rounded-lg border border-white/10 bg-black/40 px-2.5 py-1 text-xs text-white/60">
                  Zero cloud file storage
                </span>
                <span className="rounded-lg border border-white/10 bg-black/40 px-2.5 py-1 text-xs text-white/60">
                  Keeps OCR legibility
                </span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
