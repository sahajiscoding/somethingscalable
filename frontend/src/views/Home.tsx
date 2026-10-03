import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ImageGenerationLoader, type ImageGenerationLoaderEffect } from '../components/ui/image-generation-loader';
import { TextFlippingBoard } from '../components/ui/text-flipping-board';
import type { View } from '../lib/view';

const BOARD_MESSAGES = [
  'KIMI-K3 AI ACTIVE \nAUTOMATED EXAM EVAL \nREADY TO GRADE PAPERS',
  'MULTIMODAL VISION OCR\nHANDWRITING TO MARKS \n100% FAIR RUBRICS',
  '4 PENALTY CHECKS     \nDIAGRAMS & STEPS     \nNO MORE MANUAL WORK',
  'GENERATE TEST PAPERS \nCUSTOM MARKING SCHEME\n1-CLICK PIPELINE',
];

const BOARD_TABS = ['Active Status', 'Vision OCR', '4 Penalties', 'Exam Authoring'];

const SCAN_TEXTS = ['ANALYSING', 'KIMI-K3', 'GRADING', 'RUBRIC'] as const;
const SCAN_EFFECTS: { value: ImageGenerationLoaderEffect; label: string }[] = [
  { value: 'scale-wave', label: 'Scale Wave' },
  { value: 'wave', label: 'Fluid Wave' },
  { value: 'shimmer', label: 'Shimmer' },
];

interface HomeProps {
  onNavigate: (v: View) => void;
  onTryDemo: () => void;
  backendModel: string;
  hasKey: boolean | null;
}

function Reveal({ children, className = '' }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') {
      setShown(true);
      return;
    }
    const io = new IntersectionObserver(
      entries => {
        if (entries[0].isIntersecting) {
          setShown(true);
          io.disconnect();
        }
      },
      { threshold: 0.1 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div
      ref={ref}
      className={`${className} transition-all duration-700 ease-out motion-reduce:transition-none ${
        shown ? 'translate-y-0 opacity-100' : 'translate-y-8 opacity-0'
      }`}
    >
      {children}
    </div>
  );
}

export default function Home({ onNavigate, onTryDemo, backendModel, hasKey }: HomeProps) {
  const [msgIdx, setMsgIdx] = useState(0);
  const [scanText, setScanText] = useState<string>('ANALYSING');
  const [scanEffect, setScanEffect] = useState<ImageGenerationLoaderEffect>('scale-wave');

  useEffect(() => {
    const id = setInterval(() => setMsgIdx(i => (i + 1) % BOARD_MESSAGES.length), 7000);
    return () => clearInterval(id);
  }, []);

  const scrollToContent = () => {
    document.getElementById('home-content')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div>
      {/* Minimal hero */}
      <section className="relative flex min-h-[84vh] flex-col items-center justify-center px-4 py-16 text-center">
        <div className="inline-flex items-center gap-2.5 rounded-full border border-white/10 bg-white/5 py-1.5 pr-5 pl-1.5 backdrop-blur">
          <span className="rounded-full bg-white px-3 py-1 text-xs font-extrabold text-black">NEW</span>
          <span className="text-sm font-semibold text-white/60">Kimi-K3 grading engine</span>
        </div>
        <h1 className="mt-7 max-w-[16ch] text-5xl leading-[1.05] font-extrabold tracking-tight text-balance md:text-7xl">
          Grades that explain themselves.
        </h1>
        <p className="mt-5 max-w-[52ch] text-[15px] leading-relaxed text-white/50 md:text-base">
          Upload a paper, a rubric and a handwritten sheet — get step-by-step marks with every deduction explained.
        </p>
        <div className="mt-9 flex flex-wrap items-center justify-center gap-3.5">
          <button
            type="button"
            onClick={() => onNavigate('grading')}
            className="cursor-pointer rounded-2xl border-none bg-white px-7 py-3.5 text-[15px] font-bold text-black transition hover:brightness-90"
          >
            Start grading
          </button>
          <button
            type="button"
            onClick={() => onNavigate('generator')}
            className="cursor-pointer rounded-2xl border border-white/10 bg-white/5 px-7 py-3.5 text-[15px] font-semibold text-white/60 backdrop-blur transition hover:bg-white/10 hover:text-white"
          >
            Generate an exam
          </button>
        </div>
        <button
          type="button"
          onClick={onTryDemo}
          className="mt-4 cursor-pointer border-none bg-transparent text-[13px] font-semibold text-white/35 transition hover:text-mint"
        >
          or try the demo →
        </button>
        <button
          type="button"
          onClick={scrollToContent}
          aria-label="Scroll to content"
          className="absolute bottom-6 cursor-pointer border-none bg-transparent text-white/30 transition hover:text-white"
        >
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="animate-bounce" aria-hidden="true">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
      </section>

      {/* Scroll content */}
      <div id="home-content" className="scroll-mt-24">
        <Reveal>
          <div className="mb-7 grid gap-3 rounded-2xl border border-white/10 bg-black/40 p-5 backdrop-blur sm:grid-cols-2 lg:grid-cols-4">
            {[
              { icon: '👁', t: 'Multimodal Vision', d: 'Transcribes handwriting, symbols & diagrams.' },
              { icon: '⚖', t: 'Step-by-Step Marking', d: 'Strict or standard mode with partial credit.' },
              { icon: '🎯', t: '4 Penalty Checkpoints', d: 'Handwriting, diagrams, smudges, formatting.' },
              { icon: '⚡', t: 'Serverless Speed', d: 'Split pipeline, safe for 60s host limits.' },
            ].map(p => (
              <div key={p.t} className="flex items-start gap-3">
                <div className="grid h-[34px] w-[34px] flex-none place-items-center rounded-[10px] border border-white/10 bg-white/5 text-base text-mint">
                  {p.icon}
                </div>
                <div>
                  <h4 className="text-[13.5px] font-bold">{p.t}</h4>
                  <p className="text-xs leading-snug text-white/45">{p.d}</p>
                </div>
              </div>
            ))}
          </div>
        </Reveal>

        {/* Component 1: Text flipping board */}
        <Reveal>
          <section aria-label="Split-Flap Status Terminal" className="mb-7 rounded-2xl border border-white/20 bg-black/60 p-4 shadow-[0_24px_60px_rgba(0,0,0,.5)] backdrop-blur md:p-6">
            <div className="mb-3.5 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2.5 text-xs font-bold tracking-[.14em] text-white/70 uppercase">
                <span className="h-2 w-2 animate-pulse rounded-full bg-mint shadow-[0_0_10px_var(--color-mint)]" />
                <span>Kimi-K3 Mechanical Split-Flap Terminal</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {BOARD_TABS.map((t, i) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setMsgIdx(i)}
                    className={`cursor-pointer rounded-full border px-3 py-1 text-[11.5px] font-semibold transition ${
                      i === msgIdx
                        ? 'border-mint/50 bg-mint/20 text-mint'
                        : 'border-white/10 bg-white/5 text-white/60 hover:border-mint/50 hover:text-mint'
                    }`}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>
            <TextFlippingBoard text={BOARD_MESSAGES[msgIdx]} />
          </section>
        </Reveal>

        {/* Component 2: Image generation loader / vision scanner */}
        <Reveal>
          <section aria-label="Kimi-K3 Multimodal Handwriting Scanner" className="mb-7 rounded-2xl border border-white/10 bg-black/60 p-5 shadow-[0_20px_44px_rgba(0,0,0,.32)] backdrop-blur md:p-8">
            <div className="grid items-center gap-6 lg:grid-cols-[1.2fr_1fr]">
              <div className="relative aspect-[4/3] w-full overflow-hidden rounded-2xl border border-white/15 bg-[#111] shadow-[0_16px_40px_rgba(0,0,0,.5)]">
                <svg viewBox="0 0 600 450" fill="none" xmlns="http://www.w3.org/2000/svg" className="block h-full w-full">
                  <rect width="600" height="450" fill="#1b1c1c" />
                  <path
                    d="M0 50H600 M0 90H600 M0 130H600 M0 170H600 M0 210H600 M0 250H600 M0 290H600 M0 330H600 M0 370H600 M0 410H600"
                    stroke="#2b2d2d"
                    strokeWidth="1.2"
                  />
                  <line x1="80" y1="0" x2="80" y2="450" stroke="#4a3030" strokeWidth="1.5" />
                  <text x="95" y="42" fill="#81c784" fontFamily="'Courier New', monospace" fontSize="14" fontWeight="bold">
                    Q1. Solve x² - 3x - 10 = 0
                  </text>
                  <text x="95" y="82" fill="#ffffff" fontFamily="cursive, 'Comic Sans MS', sans-serif" fontSize="16">
                    x = (-b ± √(b² - 4ac)) / 2a
                  </text>
                  <text x="95" y="122" fill="#d1d5db" fontFamily="cursive, sans-serif" fontSize="15">
                    a = 1, b = -3, c = -10
                  </text>
                  <text x="95" y="162" fill="#d1d5db" fontFamily="cursive, sans-serif" fontSize="15">
                    Δ = (-3)² - 4(1)(-10) = 9 + 40 = 49
                  </text>
                  <text x="95" y="202" fill="#81c784" fontFamily="cursive, sans-serif" fontSize="16">
                    x = (3 ± 7) / 2
                  </text>
                  <text x="95" y="242" fill="#e5e7eb" fontFamily="cursive, sans-serif" fontSize="16">
                    Roots: x₁ = 5 , x₂ = -2 [✓ matches key]
                  </text>
                  <rect x="95" y="275" width="220" height="110" rx="8" fill="#141515" stroke="#374151" />
                  <line x1="110" y1="330" x2="300" y2="330" stroke="#60a5fa" strokeWidth="1.8" />
                  <path d="M140 290L200 330L260 370" stroke="#f59e0b" strokeWidth="2" />
                  <circle cx="200" cy="330" r="4" fill="#ef4444" />
                  <text x="210" y="325" fill="#9ca3af" fontSize="11">
                    Lens focus F
                  </text>
                  <text x="330" y="300" fill="#a78bfa" fontFamily="sans-serif" fontSize="13">
                    Lenz&apos;s Law &amp; Flux Diagram
                  </text>
                  <text x="330" y="325" fill="#9ca3af" fontSize="12">
                    Induced current opposes flux ΔΦ
                  </text>
                  <text x="330" y="355" fill="#81c784" fontSize="12">
                    ✓ Labels complete: +4.0 marks
                  </text>
                </svg>
                <ImageGenerationLoader
                  effect={scanEffect}
                  easing="ease-in-out"
                  text={scanText}
                  cellSize={3}
                  gap={1}
                  bandHeight={48}
                  colors={['#81c784', '#2e7d32']}
                />
              </div>

              <div>
                <div className="mb-1 text-[11px] font-bold tracking-[.18em] text-white/45 uppercase">
                  Real-time Vision OCR
                </div>
                <h3 className="mb-2 text-[22px] font-extrabold tracking-tight">Multimodal Pixel-Wave Scanner</h3>
                <p className="mb-5 text-sm leading-relaxed text-white/70">
                  Watch how Moonshot AI Kimi-K3 scans raw handwriting, diagrams, and formulas. The neural vision layer
                  transcribes symbols into structured JSON before comparing against step rubrics.
                </p>
                <div className="mb-1.5 text-xs font-bold tracking-[.08em] text-white/45 uppercase">Scanner Text Mode</div>
                <div className="mb-3.5 flex flex-wrap gap-2">
                  {SCAN_TEXTS.map(t => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setScanText(t)}
                      className={`cursor-pointer rounded-[9px] border px-3.5 py-1.5 text-xs font-semibold transition ${
                        scanText === t
                          ? 'border-mint/45 bg-mint/20 text-mint'
                          : 'border-white/10 bg-white/5 text-white/60 hover:border-mint/45 hover:text-mint'
                      }`}
                    >
                      {t}
                    </button>
                  ))}
                </div>
                <div className="mb-1.5 text-xs font-bold tracking-[.08em] text-white/45 uppercase">Visual Wave Effect</div>
                <div className="mb-3.5 flex flex-wrap gap-2">
                  {SCAN_EFFECTS.map(e => (
                    <button
                      key={e.value}
                      type="button"
                      onClick={() => setScanEffect(e.value)}
                      className={`cursor-pointer rounded-[9px] border px-3.5 py-1.5 text-xs font-semibold transition ${
                        scanEffect === e.value
                          ? 'border-mint/45 bg-mint/20 text-mint'
                          : 'border-white/10 bg-white/5 text-white/60 hover:border-mint/45 hover:text-mint'
                      }`}
                    >
                      {e.label}
                    </button>
                  ))}
                </div>
                <div className="rounded-[10px] border border-white/10 bg-black/25 p-3 text-xs leading-relaxed text-white/45">
                  <b className="text-white/70">OCR Noise Immunity:</b> Handwriting smudges or recognition noise are
                  isolated and never cost the student marks unless true mathematical errors occur.
                </div>
              </div>
            </div>
          </section>
        </Reveal>

        {/* Feature grid */}
        <Reveal>
          <div className="mb-6 grid gap-5 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
            {[
              { icon: '📝', t: 'Exam Grading', d: 'Upload a question paper, rubric, and scanned handwriting sheet. Get automated scoring with detailed explanations for every deducted mark.', a: 'Launch Grader →', v: 'grading' as View },
              { icon: '🗜', t: 'Media Compressor', d: 'Downscale and optimize oversized scans and PDFs client-side so they fit the hosting upload cap with crisp handwriting retention.', a: 'Compress Media →', v: 'compressor' as View },
              { icon: '✨', t: 'Generate Exam', d: 'Create balanced test papers and matching official step-by-step answer keys on any subject with 1-click transfer directly into the grading bay.', a: 'Create Test →', v: 'generator' as View },
              { icon: '🎯', t: 'Rubric Studio', d: 'Explore best practices for designing step marks, mandatory formula keywords, and configuring presentation penalty boundaries.', a: 'Explore Rubrics →', v: 'rubrics' as View },
              { icon: '📊', t: 'Performance Analytics', d: 'Track class-wide averages, pass rates, score distributions, and most common penalty deductions across evaluated papers.', a: 'View Analytics →', v: 'analytics' as View },
            ].map(f => (
              <button
                key={f.t}
                type="button"
                onClick={() => onNavigate(f.v)}
                className="flex cursor-pointer flex-col justify-between rounded-2xl border border-white/10 bg-black/60 p-6 text-left shadow-[0_20px_44px_rgba(0,0,0,.32)] backdrop-blur transition hover:-translate-y-1 hover:border-mint/45"
              >
                <div>
                  <div className="mb-4 grid h-[50px] w-[50px] place-items-center rounded-[15px] border border-white/10 bg-white/5 text-[22px] text-mint">
                    {f.icon}
                  </div>
                  <h3 className="mb-2 text-lg font-bold">{f.t}</h3>
                  <p className="mb-5 flex-1 text-[13.5px] leading-relaxed text-white/70">{f.d}</p>
                </div>
                <div className="inline-flex items-center gap-1.5 text-[13px] font-bold text-mint">{f.a}</div>
              </button>
            ))}
          </div>
        </Reveal>

        {/* Workflow */}
        <Reveal>
          <div className="mb-6 rounded-2xl border border-white/10 bg-black/60 p-6 shadow-[0_20px_44px_rgba(0,0,0,.32)] backdrop-blur md:p-8">
            <div className="mb-1 text-[11px] font-bold tracking-[.18em] text-white/45 uppercase">
              Architecture &amp; Pipeline
            </div>
            <h2 className="text-[19px] font-bold tracking-tight">How Moonshot AI Kimi-K3 Evaluates Exams</h2>
            <p className="mt-1 text-[13.5px] text-white/45">
              Split-pipeline execution prevents timeouts while maintaining high grading fidelity.
            </p>
            <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              {[
                { n: 'Step 01', t: 'Document Ingestion', d: 'Accepts PDFs, scans, photos, and digital text. Digital pages extract text; scanned scripts render to 150 DPI images.' },
                { n: 'Step 02', t: 'Vision OCR Extraction', d: 'Kimi-K3 transcribes questions, expected answers, and student handwriting in parallel single-request batches.' },
                { n: 'Step 03', t: 'Alignment & Scoring', d: 'Pure code aligns question numbers; Kimi-K3 marks each item against the rubric, enforcing step marks and penalties.' },
                { n: 'Step 04', t: 'Report & Analytics', d: 'Generates real-time scoreboard, deduction tags, granular student feedback, and downloadable JSON & Markdown.' },
              ].map(s => (
                <div key={s.n} className="rounded-xl border border-white/10 bg-black/25 p-5">
                  <div className="mb-2 text-[11px] font-extrabold tracking-[.14em] text-mint uppercase">{s.n}</div>
                  <h4 className="mb-1.5 text-[15px] font-bold">{s.t}</h4>
                  <p className="text-xs leading-relaxed text-white/45">{s.d}</p>
                </div>
              ))}
            </div>
          </div>
        </Reveal>

        {/* Engine specs */}
        <Reveal>
          <div className="mb-6 rounded-2xl border border-white/10 bg-gradient-to-br from-black/60 to-black/30 p-6 shadow-[0_20px_44px_rgba(0,0,0,.32)] backdrop-blur">
            <div className="mb-1 text-[11px] font-bold tracking-[.18em] text-white/45 uppercase">
              Live System Configuration
            </div>
            <h3 className="text-[17px] font-bold">Deployment &amp; Model Specs</h3>
            <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {[
                { k: 'Default Model', v: backendModel },
                { k: 'Platform', v: 'NVIDIA NIM (OpenAI-compatible)' },
                { k: 'API Key Status', v: hasKey === null ? 'Checking…' : hasKey ? 'Connected' : 'Not configured' },
                { k: 'Execution Host', v: 'Vercel Serverless Function' },
              ].map(s => (
                <div key={s.k} className="rounded-xl border border-white/10 bg-black/30 px-4 py-3.5">
                  <div className="mb-1 text-[11.5px] tracking-[.1em] text-white/45 uppercase">{s.k}</div>
                  <div className="text-[14.5px] font-bold">{s.v}</div>
                </div>
              ))}
            </div>
          </div>
        </Reveal>
      </div>
    </div>
  );
}
