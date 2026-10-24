import { useEffect, useMemo, useRef, useState } from 'react';
import type { CropGeometry, GradeStep } from '../lib/api';
import { fmt } from '../lib/sim';

export interface ReviewQuestionVM {
  no: string;
  questionText: string;
  awarded: number;
  total: number;
  target: string;
  student: string;
  tags: { label: string; amount: number; tone: string }[];
  good: boolean;
  title: string;
  body: string;
  ocrNote?: string;
  page: number;
  geometry: CropGeometry[];
  steps: GradeStep[];
  accepted?: boolean;
  flagged?: boolean;
  teacherFeedback?: string;
}

export interface ReviewImpactItem {
  key: string;
  label: string;
  color: string;
  amount: number;
}

export interface DualPaneResultsVM {
  chips: { text: string; tone: 'warn' | 'plain' | 'crit' }[];
  awarded: number;
  total: number;
  pct: number;
  grade: string;
  pass: boolean;
  qCount: number;
  deducted: number;
  mode: string;
  critCountText: string;
  sub: string;
  impact: ReviewImpactItem[];
  contentExtra: number;
  questions: ReviewQuestionVM[];
  pageImages: string[];
  sheetName?: string;
  subjectLabel?: string;
  downloadJson?: string;
  downloadMd?: string;
  inProgress?: boolean;
  modelName?: string;
}

interface CalloutPin {
  cropId: string;
  questionNo: string;
  stepIdx: number;
  page: number;
  rect: [number, number, number, number];
  errorTag: string;
  latex: string;
}

interface DualPaneReviewProps {
  vm: DualPaneResultsVM;
  onUpdateQuestion: (
    qNo: string,
    patch: { awarded?: number; accepted?: boolean; flagged?: boolean; teacherFeedback?: string },
  ) => void;
  onAcceptAll: () => void;
  onDownloadJson?: () => void;
  onDownloadMd?: () => void;
  onDownloadPdf?: () => void;
}

export default function DualPaneReview({
  vm,
  onUpdateQuestion,
  onAcceptAll,
  onDownloadJson,
  onDownloadMd,
  onDownloadPdf,
}: DualPaneReviewProps) {
  const sectionRef = useRef<HTMLElement>(null);
  const pageContainerRef = useRef<HTMLDivElement>(null);

  // Default to the first question with deductions (like Q3 in the screenshot), or Q1
  const defaultQuestion = useMemo(() => {
    const q3 = vm.questions.find(q => q.no.toUpperCase() === 'Q3' && !q.good);
    if (q3) return q3;
    const firstErr = vm.questions.find(q => !q.good);
    return firstErr || vm.questions[0] || null;
  }, [vm.questions]);

  const [selectedQNo, setSelectedQNo] = useState<string>(() => defaultQuestion?.no || 'Q1');
  const [currentPage, setCurrentPage] = useState<number>(() => defaultQuestion?.page || 1);
  const [fixesOn, setFixesOn] = useState<boolean>(true);
  const [rightMode, setRightMode] = useState<'transcript' | 'summary'>('transcript');
  const [activeCropId, setActiveCropId] = useState<string | null>(null);
  const [editingMarks, setEditingMarks] = useState<boolean>(false);
  const [markDraft, setMarkDraft] = useState<string>('');

  // Collapsed state per question+step key: correct steps default collapsed when the question has errors; error steps default expanded
  const [collapsedSteps, setCollapsedSteps] = useState<Record<string, boolean>>({});

  useEffect(() => {
    sectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  const activeQuestion = useMemo(
    () => vm.questions.find(q => q.no === selectedQNo) ?? defaultQuestion,
    [vm.questions, selectedQNo, defaultQuestion],
  );

  const activeQIndex = useMemo(
    () => Math.max(0, vm.questions.findIndex(q => q.no === activeQuestion?.no)),
    [vm.questions, activeQuestion],
  );

  const selectQuestion = (qNo: string) => {
    setSelectedQNo(qNo);
    setEditingMarks(false);
    const target = vm.questions.find(q => q.no === qNo);
    if (target?.page && target.page >= 1) {
      setCurrentPage(target.page);
    }
  };

  const pageCount = useMemo(() => {
    const maxFromQ = vm.questions.reduce((m, q) => Math.max(m, q.page || 1), 1);
    return Math.max(vm.pageImages.length, maxFromQ, 1);
  }, [vm.pageImages.length, vm.questions]);

  // Collect all error callouts on the current page across all questions
  const pageCallouts = useMemo<CalloutPin[]>(() => {
    const pins: CalloutPin[] = [];
    const seenCrops = new Set<string>();

    for (const q of vm.questions) {
      const geoById = new Map<string, CropGeometry>();
      for (const g of q.geometry || []) {
        geoById.set(g.crop_id, g);
      }

      (q.steps || []).forEach((step, sIdx) => {
        for (const ln of step.lines || []) {
          if (ln.ok && !ln.error_tag) continue;
          const tag =
            ln.error_tag ||
            (step.status === 'error' ? 'Calculation Error' : '');
          if (!tag) continue;

          const cid = ln.crop_id || '';
          const geo = cid ? geoById.get(cid) : undefined;
          if (geo && geo.page === currentPage && !seenCrops.has(geo.crop_id)) {
            seenCrops.add(geo.crop_id);
            pins.push({
              cropId: geo.crop_id,
              questionNo: q.no,
              stepIdx: sIdx,
              page: geo.page,
              rect: geo.rect,
              errorTag: tag,
              latex: ln.text || geo.latex || '',
            });
          }
        }
      });
    }
    return pins;
  }, [vm.questions, currentPage]);

  // All crops on the current page (for subtle active-question outlines)
  const pageCrops = useMemo(() => {
    const list: { crop: CropGeometry; questionNo: string }[] = [];
    for (const q of vm.questions) {
      for (const g of q.geometry || []) {
        if (g.page === currentPage) {
          list.push({ crop: g, questionNo: q.no });
        }
      }
    }
    return list;
  }, [vm.questions, currentPage]);

  const isStepExpanded = (q: ReviewQuestionVM, step: GradeStep, sIdx: number): boolean => {
    const key = `${q.no}::${sIdx}`;
    if (key in collapsedSteps) {
      return !collapsedSteps[key];
    }
    // Default: error steps expanded; correct steps collapsed if the question has error steps
    const hasErrors = q.steps.some(s => s.status === 'error');
    return step.status === 'error' || !hasErrors;
  };

  const toggleStep = (q: ReviewQuestionVM, step: GradeStep, sIdx: number) => {
    const key = `${q.no}::${sIdx}`;
    const currentlyExpanded = isStepExpanded(q, step, sIdx);
    setCollapsedSteps(prev => ({ ...prev, [key]: currentlyExpanded }));
  };

  const focusCropOnCanvas = (cropId?: string, page?: number) => {
    if (page && page !== currentPage) {
      setCurrentPage(page);
    }
    if (cropId) {
      setActiveCropId(cropId);
      setFixesOn(true);
      pageContainerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  };

  const handleCalloutClick = (pin: CalloutPin) => {
    selectQuestion(pin.questionNo);
    setRightMode('transcript');
    setActiveCropId(pin.cropId);
    // Ensure the step is expanded
    const key = `${pin.questionNo}::${pin.stepIdx}`;
    setCollapsedSteps(prev => ({ ...prev, [key]: false }));
  };

  const fullMarksCount = useMemo(
    () => vm.questions.filter(q => q.awarded >= q.total && q.total > 0).length,
    [vm.questions],
  );

  const currentPageImg = vm.pageImages[currentPage - 1] || vm.pageImages[0] || '';

  const commitMarkEdit = () => {
    if (!activeQuestion) return;
    const parsed = parseFloat(markDraft);
    if (!Number.isNaN(parsed)) {
      const clamped = Math.max(0, Math.min(activeQuestion.total, Math.round(parsed * 2) / 2));
      onUpdateQuestion(activeQuestion.no, { awarded: clamped });
    }
    setEditingMarks(false);
  };

  return (
    <section ref={sectionRef} aria-live="polite" className="animate-rise mt-6 scroll-mt-4">
      <div className="overflow-hidden rounded-2xl border border-white/12 bg-[#0b0c0e] shadow-[0_24px_60px_rgba(0,0,0,0.65)]">
        {/* ==================== TOP WORKSPACE HEADER BAR ==================== */}
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 bg-[#111317] px-4 py-3 md:px-6">
          <div className="flex flex-wrap items-center gap-2.5 text-sm">
            <span className="grid h-7 w-7 place-items-center rounded-lg border border-white/10 bg-white/5 text-xs text-white/70">
              ←
            </span>
            <span className="font-extrabold tracking-tight text-white">
              {vm.sheetName || 'Tanya Goenka'}
            </span>
            <span className="text-white/30">·</span>
            <span className="text-xs font-medium text-white/55">
              {vm.subjectLabel || 'Grade 10 Class 10 A · MATH'}
            </span>
            {vm.inProgress && (
              <span className="ml-2 inline-flex items-center gap-1.5 rounded-full border border-mint/40 bg-mint/15 px-2.5 py-0.5 text-[11px] font-bold text-mint">
                <span className="h-2 w-2 animate-ping rounded-full bg-mint" />
                Grading live ({vm.qCount} ready)
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Prev / Next Question Switcher */}
            <div className="flex items-center rounded-lg border border-white/10 bg-black/30 p-0.5 text-xs">
              <button
                type="button"
                disabled={activeQIndex <= 0}
                onClick={() => {
                  const prev = vm.questions[activeQIndex - 1];
                  if (prev) selectQuestion(prev.no);
                }}
                className="cursor-pointer rounded-md px-2.5 py-1 font-semibold text-white/75 transition hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-35"
              >
                ‹ Prev
              </button>
              <button
                type="button"
                disabled={activeQIndex >= vm.questions.length - 1}
                onClick={() => {
                  const next = vm.questions[activeQIndex + 1];
                  if (next) selectQuestion(next.no);
                }}
                className="cursor-pointer rounded-md px-2.5 py-1 font-semibold text-white/75 transition hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-35"
              >
                Next ›
              </button>
            </div>

            {/* Page Dropdown */}
            <div className="relative">
              <select
                aria-label="Select submission page"
                value={currentPage}
                onChange={e => setCurrentPage(Number(e.target.value))}
                className="cursor-pointer appearance-none rounded-lg border border-white/15 bg-black/40 py-1.5 pr-7 pl-3 text-xs font-bold text-white outline-none transition hover:border-white/30 focus:border-mint"
              >
                {Array.from({ length: pageCount }, (_, idx) => idx + 1).map(p => (
                  <option key={p} value={p} className="bg-[#111317] text-white">
                    Page {p}
                  </option>
                ))}
              </select>
              <span className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-[10px] text-white/60">
                ▾
              </span>
            </div>

            {/* Global Accept */}
            <button
              type="button"
              onClick={onAcceptAll}
              className="cursor-pointer inline-flex items-center gap-1.5 rounded-lg border border-mint/50 bg-mint/20 px-3 py-1.5 text-xs font-extrabold text-[#d8f5db] shadow-[0_2px_10px_rgba(129,199,132,0.18)] transition hover:bg-mint/30"
            >
              <span>✓</span> Accept
            </button>

            {/* Flag active question */}
            {activeQuestion && (
              <button
                type="button"
                onClick={() =>
                  onUpdateQuestion(activeQuestion.no, { flagged: !activeQuestion.flagged })
                }
                className={`cursor-pointer inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-extrabold transition ${
                  activeQuestion.flagged
                    ? 'border-crimson bg-crimson/30 text-white shadow-[0_0_12px_rgba(229,115,115,0.35)]'
                    : 'border-crimson/45 bg-crimson/10 text-[#ffcfcf] hover:bg-crimson/20'
                }`}
              >
                <span>⚑</span> {activeQuestion.flagged ? 'Flagged' : 'Flag'}
              </button>
            )}

            {/* Total Marks Pill (like 5/10 in screenshot) */}
            <span className="rounded-lg border border-lilac/40 bg-lilac/15 px-2.5 py-1.5 text-xs font-extrabold tabular-nums text-[#e6ddff]">
              {fmt(vm.awarded)}/{fmt(vm.total)}
            </span>
          </div>
        </header>

        {/* ==================== DUAL-PANE SPLIT BODY ==================== */}
        <div className="grid lg:grid-cols-[1.12fr_0.88fr]">
          {/* -------------------- LEFT PANE: STUDENT SUBMISSION -------------------- */}
          <div className="flex flex-col border-b border-white/10 lg:border-r lg:border-b-0">
            {/* Left Subheader */}
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 bg-[#14171c] px-4 py-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1.5 text-xs font-extrabold tracking-tight text-white/90 mr-1">
                  <svg className="h-4 w-4 text-mint" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                  Student Submission
                </span>

                {/* Question Score Pills: Q1 3/3, Q2 0/2, Q3 1/3, Q4 1/2 */}
                <div className="flex flex-wrap items-center gap-1.5">
                  {vm.questions.map(q => {
                    const isSelected = q.no === activeQuestion?.no;
                    const isFull = q.awarded >= q.total && q.total > 0;
                    const pillTone = isFull
                      ? isSelected
                        ? 'border-mint bg-mint/25 text-[#d8f5db] ring-2 ring-mint/35'
                        : 'border-mint/35 bg-mint/10 text-mint hover:bg-mint/20'
                      : isSelected
                        ? 'border-crimson bg-crimson/25 text-[#ffd9d9] ring-2 ring-crimson/35'
                        : 'border-crimson/35 bg-crimson/10 text-[#ffcfcf] hover:bg-crimson/20';
                    return (
                      <button
                        key={q.no}
                        type="button"
                        onClick={() => {
                          selectQuestion(q.no);
                          setRightMode('transcript');
                        }}
                        className={`cursor-pointer rounded-full border px-2.5 py-0.5 text-xs font-extrabold tabular-nums transition ${pillTone}`}
                      >
                        {q.no} {fmt(q.awarded)}/{fmt(q.total)}
                        {q.accepted && <span className="ml-1 text-[10px]">✓</span>}
                        {q.flagged && <span className="ml-1 text-[10px]">⚑</span>}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Fixes Toggle Switch */}
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-white/65">Fixes</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={fixesOn}
                  aria-label="Toggle error fixes overlay on submission"
                  onClick={() => setFixesOn(v => !v)}
                  className={`relative h-6 w-11 cursor-pointer rounded-full border transition ${
                    fixesOn ? 'border-mint bg-mint/35' : 'border-white/20 bg-black/40'
                  }`}
                >
                  <span
                    className={`switch-knob absolute top-[2px] left-[2px] h-4 w-4 rounded-full ${
                      fixesOn ? 'translate-x-5 bg-mint' : 'bg-white/60'
                    }`}
                  />
                </button>
              </div>
            </div>

            {/* Annotated Canvas Viewport */}
            <div
              ref={pageContainerRef}
              className="relative flex-1 overflow-y-auto bg-[#1b1918] p-3 md:p-5 max-h-[760px]"
            >
              {currentPageImg ? (
                <div className="relative mx-auto w-full max-w-[680px] select-none overflow-hidden rounded-lg border border-white/10 shadow-2xl">
                  <img
                    src={currentPageImg}
                    alt={`Student submission page ${currentPage}`}
                    className="block h-auto w-full"
                  />

                  {/* SVG Overlay for Red Bounding Boxes & Dashed Leader Lines */}
                  {fixesOn && (
                    <svg
                      viewBox="0 0 1000 1000"
                      preserveAspectRatio="none"
                      className="pointer-events-none absolute inset-0 h-full w-full"
                    >
                      {/* Subtle dashed outline for active question's correct crops */}
                      {pageCrops.map(({ crop, questionNo }) => {
                        const isErr = pageCallouts.some(p => p.cropId === crop.crop_id);
                        if (isErr) return null;
                        const isActiveQ = questionNo === activeQuestion?.no;
                        const isFocused = activeCropId === crop.crop_id;
                        if (!isActiveQ && !isFocused) return null;
                        const [rx, ry, rw, rh] = crop.rect;
                        return (
                          <rect
                            key={crop.crop_id}
                            x={rx * 1000}
                            y={ry * 1000}
                            width={rw * 1000}
                            height={rh * 1000}
                            rx={4}
                            fill={isFocused ? 'rgba(129, 199, 132, 0.16)' : 'rgba(129, 199, 132, 0.05)'}
                            stroke="#81c784"
                            strokeWidth={isFocused ? 3 : 1.5}
                            strokeDasharray="6,4"
                          />
                        );
                      })}

                      {/* Red Error Boxes + Anchor Dots + Dashed Leader Lines */}
                      {pageCallouts.map(pin => {
                        const [rx, ry, rw, rh] = pin.rect;
                        const bx = rx * 1000;
                        const by = ry * 1000;
                        const bw = rw * 1000;
                        const bh = rh * 1000;

                        // Anchor dot near top-middle/right of bounding box, dashed line extending to the callout badge
                        const anchorX = bx + Math.min(bw * 0.65, 120);
                        const anchorY = by;
                        const badgeX = Math.min(720, Math.max(bx + bw + 55, anchorX + 85));
                        const badgeY = Math.max(35, by - 14);
                        const isActive =
                          activeCropId === pin.cropId || pin.questionNo === activeQuestion?.no;

                        return (
                          <g key={pin.cropId}>
                            <rect
                              x={bx}
                              y={by}
                              width={bw}
                              height={bh}
                              rx={3}
                              fill={
                                activeCropId === pin.cropId
                                  ? 'rgba(239, 68, 68, 0.24)'
                                  : 'rgba(239, 68, 68, 0.08)'
                              }
                              stroke="#ef4444"
                              strokeWidth={isActive ? 2.6 : 1.8}
                            />
                            {/* Anchor circle on the box edge */}
                            <circle cx={anchorX} cy={anchorY} r={4.5} fill="#ef4444" />
                            {/* Dashed leader line to the floating callout badge */}
                            <line
                              x1={anchorX}
                              y1={anchorY}
                              x2={badgeX}
                              y2={badgeY}
                              stroke="#ef4444"
                              strokeWidth={2}
                              strokeDasharray="6,5"
                            />
                          </g>
                        );
                      })}
                    </svg>
                  )}

                  {/* Clickable Hit-Boxes & Floating Callout Pills */}
                  {fixesOn &&
                    pageCallouts.map(pin => {
                      const [rx, ry, rw, rh] = pin.rect;
                      const anchorX = rx + Math.min(rw * 0.65, 0.12);
                      const badgeLeftPct = Math.min(70, Math.max((rx + rw + 0.055) * 100, (anchorX + 0.085) * 100));
                      const badgeTopPct = Math.max(2.5, (ry - 0.026) * 100);
                      const isFocused = activeCropId === pin.cropId;

                      return (
                        <div key={`pin-${pin.cropId}`}>
                          {/* Clickable red box overlay */}
                          <button
                            type="button"
                            title={`${pin.questionNo}: ${pin.errorTag} (${pin.latex})`}
                            onClick={() => handleCalloutClick(pin)}
                            style={{
                              left: `${rx * 100}%`,
                              top: `${ry * 100}%`,
                              width: `${rw * 100}%`,
                              height: `${rh * 100}%`,
                            }}
                            className="absolute z-10 cursor-pointer bg-transparent focus:outline-none"
                          />

                          {/* Floating Callout Pill (matches screenshot's white/dark-contrasted badge with red dot) */}
                          <button
                            type="button"
                            onClick={() => handleCalloutClick(pin)}
                            style={{
                              left: `${badgeLeftPct}%`,
                              top: `${badgeTopPct}%`,
                            }}
                            className={`absolute z-20 -translate-y-1/2 cursor-pointer inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11.5px] font-extrabold whitespace-nowrap shadow-[0_6px_18px_rgba(0,0,0,0.55)] transition hover:scale-105 ${
                              isFocused
                                ? 'border-crimson bg-[#1e1315] text-white ring-2 ring-crimson/60'
                                : 'border-white/80 bg-white text-[#b91c1c] hover:bg-[#fff5f5]'
                            }`}
                          >
                            <span className="h-2 w-2 flex-none rounded-full bg-[#ef4444]" />
                            <span>{pin.errorTag}</span>
                          </button>
                        </div>
                      );
                    })}
                </div>
              ) : (
                <div className="grid h-80 place-items-center rounded-xl border border-dashed border-white/15 bg-black/20 p-6 text-center text-sm text-white/50">
                  <div>
                    <div className="font-bold text-white/75">No scanned page preview available</div>
                    <p className="mt-1 text-xs text-white/45">
                      Upload an image or PDF student submission to view on-page bounding boxes and error callouts.
                    </p>
                  </div>
                </div>
              )}

              {activeQuestion && activeQuestion.geometry.length === 0 && (
                <div className="mt-3 rounded-lg border border-sand/35 bg-sand/10 px-3 py-2 text-xs text-[#ffe6c0]">
                  Note: Whole-page transcription ran for {activeQuestion.no} — step breakdown is shown on the right without line-level bounding boxes on the scan.
                </div>
              )}
            </div>
          </div>

          {/* -------------------- RIGHT PANE: AI TRANSCRIPT / SUMMARY -------------------- */}
          <div className="flex flex-col bg-[#0e1014]">
            {/* Right Subheader */}
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 bg-[#14171c] px-4 py-2.5">
              <div className="flex items-center gap-3">
                <span className="inline-flex items-center gap-1.5 text-xs font-extrabold tracking-tight text-white/90">
                  <svg className="h-4 w-4 text-mint" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                  AI Transcript
                </span>

                {/* Summary [o-] Transcript Switch */}
                <div className="flex items-center gap-2 text-xs">
                  <button
                    type="button"
                    onClick={() => setRightMode('summary')}
                    className={`cursor-pointer font-semibold transition ${
                      rightMode === 'summary' ? 'text-white' : 'text-white/45 hover:text-white/75'
                    }`}
                  >
                    Summary
                  </button>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={rightMode === 'transcript'}
                    aria-label="Toggle between Summary and AI Transcript"
                    onClick={() => setRightMode(m => (m === 'transcript' ? 'summary' : 'transcript'))}
                    className={`relative h-5 w-10 cursor-pointer rounded-full border transition ${
                      rightMode === 'transcript' ? 'border-mint bg-mint/35' : 'border-white/20 bg-black/40'
                    }`}
                  >
                    <span
                      className={`switch-knob absolute top-[2px] left-[2px] h-3.5 w-3.5 rounded-full ${
                        rightMode === 'transcript' ? 'translate-x-5 bg-mint' : 'bg-white/70'
                      }`}
                    />
                  </button>
                  <button
                    type="button"
                    onClick={() => setRightMode('transcript')}
                    className={`cursor-pointer font-semibold transition ${
                      rightMode === 'transcript' ? 'text-white' : 'text-white/45 hover:text-white/75'
                    }`}
                  >
                    Transcript
                  </button>
                </div>
              </div>

              {/* Right Accuracy Badge: 1/4 correct · 50% */}
              <div className="flex items-center gap-2 text-xs">
                <span className="rounded-full border border-mint/40 bg-mint/15 px-2.5 py-0.5 font-extrabold text-[#d8f5db]">
                  {fullMarksCount}/{vm.questions.length} correct
                </span>
                <span className="font-extrabold tabular-nums text-white/75">
                  {Math.round(vm.pct)}%
                </span>
              </div>
            </div>

            {rightMode === 'transcript' && activeQuestion ? (
              <div className="flex flex-1 flex-col justify-between">
                {/* Scrollable Question + Step-by-Step Breakdown */}
                <div className="flex-1 overflow-y-auto p-4 md:p-5 max-h-[600px]">
                  {/* Question Header Row */}
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-xs font-extrabold tracking-[0.14em] text-white/55 uppercase">
                      QUESTION {activeQuestion.no.replace(/^Q/i, '')}
                    </div>

                    <div className="flex items-center gap-2.5">
                      {/* Editable Score Badge (e.g. 1/3) */}
                      {editingMarks ? (
                        <div className="inline-flex items-center gap-1 rounded-lg border border-mint bg-black/50 px-2 py-0.5 text-xs">
                          <input
                            type="number"
                            step="0.5"
                            min={0}
                            max={activeQuestion.total}
                            value={markDraft}
                            onChange={e => setMarkDraft(e.target.value)}
                            onKeyDown={e => {
                              if (e.key === 'Enter') commitMarkEdit();
                              if (e.key === 'Escape') setEditingMarks(false);
                            }}
                            autoFocus
                            className="w-12 bg-transparent text-right font-extrabold text-white outline-none"
                          />
                          <span className="text-white/50">/ {fmt(activeQuestion.total)}</span>
                          <button
                            type="button"
                            onClick={commitMarkEdit}
                            className="ml-1 cursor-pointer rounded bg-mint px-1.5 py-0.5 text-[10px] font-black text-[#0d1a12]"
                          >
                            Save
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          title="Click to override awarded marks"
                          onClick={() => {
                            setMarkDraft(String(activeQuestion.awarded));
                            setEditingMarks(true);
                          }}
                          className={`cursor-pointer rounded-lg border border-transparent px-2 py-0.5 text-sm font-extrabold tabular-nums transition hover:border-white/20 hover:bg-white/5 ${
                            activeQuestion.good ? 'text-mint' : 'text-crimson'
                          }`}
                        >
                          {fmt(activeQuestion.awarded)}/{fmt(activeQuestion.total)} ✎
                        </button>
                      )}

                      {/* Per-question Accept button */}
                      <button
                        type="button"
                        onClick={() =>
                          onUpdateQuestion(activeQuestion.no, {
                            accepted: !activeQuestion.accepted,
                          })
                        }
                        className={`cursor-pointer inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-xs font-extrabold transition ${
                          activeQuestion.accepted
                            ? 'border-mint bg-mint/25 text-[#d8f5db]'
                            : 'border-mint/35 bg-mint/10 text-mint hover:bg-mint/20'
                        }`}
                      >
                        <span>✓</span> {activeQuestion.accepted ? 'Accepted' : 'Accept'}
                      </button>
                    </div>
                  </div>

                  {/* Question Prompt Box */}
                  <div className="mt-3 rounded-xl border border-white/10 bg-white/[0.03] px-3.5 py-3 text-[13.5px] leading-relaxed text-white/90">
                    {activeQuestion.questionText || activeQuestion.target}
                  </div>

                  {/* STEP-BY-STEP BREAKDOWN */}
                  <div className="mt-5">
                    <div className="mb-2.5 text-[11px] font-extrabold tracking-[0.15em] text-white/50 uppercase">
                      Step-by-Step Breakdown
                    </div>

                    <div className="grid gap-3">
                      {activeQuestion.steps.map((step, sIdx) => {
                        const expanded = isStepExpanded(activeQuestion, step, sIdx);
                        const isErr = step.status === 'error';
                        const primaryCropId = step.lines.find(l => l.crop_id)?.crop_id;

                        return (
                          <div key={`${activeQuestion.no}-step-${sIdx}`} className="flex items-start gap-2">
                            <div
                              className={`flex-1 overflow-hidden rounded-xl border transition ${
                                isErr
                                  ? 'border-crimson/40 bg-crimson/[0.06]'
                                  : 'border-mint/35 bg-mint/[0.05]'
                              }`}
                            >
                              {/* Step Header */}
                              <button
                                type="button"
                                onClick={() => toggleStep(activeQuestion, step, sIdx)}
                                className="flex w-full cursor-pointer items-center justify-between gap-2 px-3.5 py-2.5 text-left"
                              >
                                <div className="flex items-center gap-2.5">
                                  <span
                                    className={`h-2.5 w-2.5 flex-none rounded-full ${
                                      isErr
                                        ? 'bg-crimson shadow-[0_0_8px_var(--color-crimson)]'
                                        : 'bg-mint shadow-[0_0_8px_var(--color-mint)]'
                                    }`}
                                  />
                                  <span className="text-[13px] font-bold text-white">
                                    {step.title}
                                  </span>
                                </div>
                                <span className="text-xs text-white/55">
                                  {expanded ? '⌃' : '⌄'}
                                </span>
                              </button>

                              {/* Step Body (Lines + Explanation) */}
                              {expanded && (
                                <div className="space-y-2 border-t border-white/8 px-3.5 pt-2.5 pb-3">
                                  {step.lines.map((ln, lIdx) => {
                                    const isFocused =
                                      Boolean(ln.crop_id) && activeCropId === ln.crop_id;
                                    return (
                                      <div
                                        key={lIdx}
                                        onClick={() =>
                                          focusCropOnCanvas(ln.crop_id, activeQuestion.page)
                                        }
                                        className={`flex cursor-pointer items-center justify-between gap-3 rounded-lg border px-3 py-2 font-mono text-[13px] transition ${
                                          ln.ok
                                            ? 'border-mint/25 bg-black/35 text-white/90 hover:border-mint/50'
                                            : 'border-crimson/30 bg-black/40 text-white hover:border-crimson/60'
                                        } ${isFocused ? 'ring-2 ring-crimson/60' : ''}`}
                                      >
                                        <span className=" italic tracking-wide">{ln.text}</span>
                                        <div className="flex items-center gap-2">
                                          {ln.error_tag && (
                                            <span className="rounded bg-crimson/20 px-1.5 py-0.5 font-sans text-[10px] font-bold text-[#ffcfcf]">
                                              {ln.error_tag}
                                            </span>
                                          )}
                                          <span
                                            className={`text-sm font-black ${
                                              ln.ok ? 'text-mint' : 'text-crimson'
                                            }`}
                                          >
                                            {ln.ok ? '✓' : '✕'}
                                          </span>
                                        </div>
                                      </div>
                                    );
                                  })}

                                  {step.explanation && (
                                    <div className="rounded-lg border border-sand/45 bg-sand/15 px-3 py-2 text-xs font-medium leading-relaxed text-[#ffe6c0]">
                                      {step.explanation}
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>

                            {/* Link Icon Button on Right Margin (matches screenshot's chain-link icon next to step cards) */}
                            {primaryCropId && (
                              <button
                                type="button"
                                title="Locate step on student submission"
                                onClick={() =>
                                  focusCropOnCanvas(primaryCropId, activeQuestion.page)
                                }
                                className={`mt-2.5 grid h-7 w-7 flex-none cursor-pointer place-items-center rounded-lg border text-xs transition ${
                                  activeCropId === primaryCropId
                                    ? 'border-sand bg-sand/25 text-[#ffe6c0]'
                                    : 'border-white/10 bg-white/[0.03] text-sand/80 hover:border-sand/45 hover:bg-sand/15'
                                }`}
                              >
                                🔗
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Official Answer Key Reference (collapsible/compact) */}
                  <details className="mt-4 rounded-xl border border-white/10 bg-black/25 px-3.5 py-2.5 text-xs text-white/70">
                    <summary className="cursor-pointer font-bold text-mint select-none">
                      View Official Answer Key &amp; Rubric Target
                    </summary>
                    <p className="mt-2 leading-relaxed text-white/80">{activeQuestion.target}</p>
                  </details>

                  {activeQuestion.ocrNote && (
                    <div className="mt-3 rounded-lg border border-mist/40 bg-mist/10 px-3 py-2 text-xs text-[#d9edff]">
                      OCR Note: {activeQuestion.ocrNote}
                    </div>
                  )}
                </div>

                {/* Sticky Bottom Teacher Feedback */}
                <div className="border-t border-white/10 bg-[#12141a] p-4">
                  <div className="mb-1.5 flex items-center justify-between">
                    <label
                      htmlFor="teacher-feedback-input"
                      className="text-[11px] font-extrabold tracking-[0.15em] text-white/50 uppercase"
                    >
                      Teacher Feedback
                    </label>
                    <span className="text-[11px] text-white/40">
                      Included in exported reports
                    </span>
                  </div>
                  <textarea
                    id="teacher-feedback-input"
                    rows={2}
                    value={activeQuestion.teacherFeedback ?? ''}
                    onChange={e =>
                      onUpdateQuestion(activeQuestion.no, {
                        teacherFeedback: e.target.value,
                      })
                    }
                    placeholder="Add feedback for the student..."
                    className="w-full resize-none rounded-xl border border-white/15 bg-black/40 px-3.5 py-2.5 text-xs leading-relaxed text-white placeholder-white/35 outline-none transition focus:border-mint focus:shadow-[0_0_0_3px_rgba(129,199,132,0.2)]"
                  />
                </div>
              </div>
            ) : (
              /* -------------------- SUMMARY MODE PANE -------------------- */
              <div className="flex-1 overflow-y-auto p-5 max-h-[720px]">
                <div className="mb-4 flex flex-wrap items-center gap-2">
                  {vm.chips.map((c, i) => (
                    <span
                      key={i}
                      className={`rounded-full border px-3 py-1 text-xs ${
                        c.tone === 'crit'
                          ? 'border-crimson/45 bg-crimson/15 text-[#ffd6d6]'
                          : 'border-white/10 bg-white/5 text-white/70'
                      }`}
                    >
                      {c.text}
                    </span>
                  ))}
                </div>

                <div className="rounded-xl border border-white/10 bg-black/30 p-4">
                  <div className="text-[11px] font-bold tracking-[0.16em] text-white/45 uppercase">
                    Overall Score
                  </div>
                  <div className="mt-1 flex items-baseline gap-2.5">
                    <span className="text-4xl font-extrabold tracking-tight text-white">
                      {fmt(vm.awarded)}
                    </span>
                    <span className="text-lg font-semibold text-white/45">
                      / {fmt(vm.total)} marks ({vm.pct.toFixed(1)}%)
                    </span>
                    <span
                      className={`ml-auto rounded-full border px-3 py-1 text-xs font-extrabold ${
                        vm.pct >= 80
                          ? 'border-mint/45 bg-mint/15 text-[#d8f5db]'
                          : vm.pct >= 60
                            ? 'border-sand/50 bg-sand/15 text-[#ffe9c9]'
                            : 'border-crimson/50 bg-crimson/15 text-[#ffd9d9]'
                      }`}
                    >
                      Grade {vm.grade} · {vm.pass ? 'Pass' : 'Needs review'}
                    </span>
                  </div>
                  <div className="mt-3 h-2.5 overflow-hidden rounded-full border border-white/10 bg-black/40">
                    <i
                      className="block h-full rounded-full bg-gradient-to-r from-[#66c17f] to-pine transition-[width] duration-500"
                      style={{ width: `${Math.min(100, Math.max(0, vm.pct))}%` }}
                    />
                  </div>
                </div>

                {/* Export Buttons */}
                {(onDownloadPdf || onDownloadMd || onDownloadJson) && (
                  <div className="mt-4 flex flex-wrap gap-2">
                    {onDownloadPdf && (
                      <button
                        type="button"
                        onClick={onDownloadPdf}
                        className="cursor-pointer rounded-lg border border-mint/45 bg-mint/15 px-3.5 py-2 text-xs font-extrabold text-[#d8f5db] hover:bg-mint/25"
                      >
                        Download report.pdf
                      </button>
                    )}
                    {onDownloadMd && (
                      <button
                        type="button"
                        onClick={onDownloadMd}
                        className="cursor-pointer rounded-lg border border-white/20 bg-white/5 px-3.5 py-2 text-xs font-semibold text-white/80 hover:bg-white/10"
                      >
                        Download report.md
                      </button>
                    )}
                    {onDownloadJson && (
                      <button
                        type="button"
                        onClick={onDownloadJson}
                        className="cursor-pointer rounded-lg border border-white/20 bg-white/5 px-3.5 py-2 text-xs font-semibold text-white/80 hover:bg-white/10"
                      >
                        Download report.json
                      </button>
                    )}
                  </div>
                )}

                {/* Penalty Impact Breakdown */}
                <div className="mt-5 border-t border-white/10 pt-4">
                  <h3 className="mb-2.5 text-[11px] font-bold tracking-[0.16em] text-white/45 uppercase">
                    Penalty Impact — where marks were lost
                  </h3>
                  {vm.impact.length || vm.contentExtra ? (
                    <div className="space-y-1.5">
                      {vm.impact.map(it => (
                        <div key={it.key} className="flex items-center gap-2.5 text-xs">
                          <span
                            className="h-2.5 w-2.5 flex-none rounded-sm"
                            style={{ background: it.color }}
                          />
                          <span>{it.label}</span>
                          <span className="ml-auto font-extrabold text-crimson tabular-nums">
                            −{fmt(it.amount)}
                          </span>
                        </div>
                      ))}
                      {vm.contentExtra > 0 && (
                        <div className="flex items-center gap-2.5 text-xs">
                          <span className="h-2.5 w-2.5 flex-none rounded-sm bg-crimson" />
                          <span>Content &amp; calculation deductions</span>
                          <span className="ml-auto font-extrabold text-crimson tabular-nums">
                            −{fmt(vm.contentExtra)}
                          </span>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="text-xs text-white/45">No deductions — full marks.</div>
                  )}
                </div>

                {/* All Questions Quick List */}
                <div className="mt-5 border-t border-white/10 pt-4">
                  <h3 className="mb-2.5 text-[11px] font-bold tracking-[0.16em] text-white/45 uppercase">
                    All Questions (click to inspect transcript)
                  </h3>
                  <div className="space-y-2">
                    {vm.questions.map(q => (
                      <button
                        key={q.no}
                        type="button"
                        onClick={() => {
                          selectQuestion(q.no);
                          setRightMode('transcript');
                        }}
                        className="flex w-full cursor-pointer items-center justify-between gap-3 rounded-xl border border-white/10 bg-black/25 p-3 text-left transition hover:border-white/25 hover:bg-white/[0.04]"
                      >
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-extrabold text-white">{q.no}</span>
                            <span className="text-xs text-white/60 line-clamp-1">
                              {q.questionText || q.body}
                            </span>
                          </div>
                          {q.teacherFeedback && (
                            <div className="mt-1 text-[11px] text-mint">
                              Teacher note: {q.teacherFeedback}
                            </div>
                          )}
                        </div>
                        <span
                          className={`flex-none text-xs font-extrabold tabular-nums ${
                            q.good ? 'text-mint' : 'text-crimson'
                          }`}
                        >
                          {fmt(q.awarded)}/{fmt(q.total)}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
