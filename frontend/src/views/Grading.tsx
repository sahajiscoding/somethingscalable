import { useCallback, useEffect, useRef, useState } from 'react';
import LatticeLoader from '../components/LatticeLoader.jsx';
import {
  DEFAULT_MODEL_ID,
  downloadText,
  modelLabel,
  runLiveEvaluation,
  type BackendState,
  type CropGeometry,
  type GradeRecord,
  type GradeStep,
  type LiveReport,
} from '../lib/api';
import {
  compressMediaIfNeeded,
  UPLOAD_TARGET_BYTES,
} from '../lib/mediaCompressor';
import { downloadPdf, generateGradingReportPdf } from '../lib/pdfGenerator';
import type { View } from '../lib/view';
import {
  CRITERIA,
  DEMO_PAGE_IMAGES,
  evaluateDemo,
  fmt,
  gradeLetter,
  type CriteriaState,
  type DemoEval,
  type DocFiles,
} from '../lib/sim';
import DualPaneReview from './DualPaneReview';

const STEPS_TEXT = [
  'Reading question paper & answer key…',
  'Extracting responses from student sheet…',
  'Matching answers against the rubric…',
  'Applying selected penalty criteria…',
  'Compiling evaluation report…',
];

const DOC_META = [
  { key: 'paper', title: 'Upload Question Paper', hint: 'Drop a PDF, DOCX or image — or click to browse' },
  { key: 'key', title: 'Upload Official Answer Key / Rubric', hint: 'The marking scheme used as ground truth' },
  { key: 'sheet', title: 'Upload Student Answer Sheet', hint: 'Scanned or photographed script to be graded' },
] as const;

type DocKey = (typeof DOC_META)[number]['key'];

const DOC_NAMES: Record<DocKey, string> = {
  paper: 'Question Paper',
  key: 'Answer Key / Rubric',
  sheet: 'Student Answer Sheet',
};

/* ---------------- Results view-model (shared by demo + live) ---------------- */

interface QTag {
  label: string;
  amount: number;
  tone: string;
}

interface QVM {
  no: string;
  questionText: string;
  awarded: number;
  total: number;
  target: string;
  student: string;
  tags: QTag[];
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

interface ImpactItem {
  key: string;
  label: string;
  color: string;
  amount: number;
}

interface ResultsVM {
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
  impact: ImpactItem[];
  contentExtra: number;
  questions: QVM[];
  pageImages: string[];
  sheetName?: string;
  subjectLabel?: string;
  downloadJson?: string;
  downloadMd?: string;
  inProgress?: boolean;
  modelName?: string;
}

function vmFromDemo(ev: DemoEval, strict: boolean, criteria: CriteriaState, sheetName: string): ResultsVM {
  const activeCrit = Object.keys(criteria).filter(k => criteria[k]);
  const pct = ev.total ? (ev.awarded / ev.total) * 100 : 0;
  const impact: ImpactItem[] = Object.keys(ev.impact).map(k => ({
    key: k,
    label: CRITERIA[k]?.label || k,
    color: CRITERIA[k]?.color || 'var(--color-crimson)',
    amount: ev.impact[k],
  }));
  const questions: QVM[] = ev.rows.map(r => {
    const q = r.q;
    const tags: QTag[] = [];
    if (r.content > 0) tags.push({ label: 'Content', amount: r.content, tone: 'content' });
    if (r.strict > 0) tags.push({ label: 'Strict mode', amount: r.strict, tone: 'strict' });
    Object.keys(r.crit).forEach(k =>
      tags.push({ label: CRITERIA[k]?.label || k, amount: r.crit[k], tone: k }),
    );
    if (r.deducted > 0) tags.push({ label: 'Total', amount: r.deducted, tone: 'total' });
    if (r.deducted === 0) tags.push({ label: `${fmt(q.total)} awarded`, amount: 0, tone: 'awarded' });
    const good = r.deducted === 0;
    const clauses: string[] = [];
    if (r.content > 0) clauses.push(q.contentReason);
    if (r.strict > 0) clauses.push('strict checking mode withheld partial credit for incomplete work');
    const notes = Object.keys(r.crit).map(k => q.penalties[k].note);
    if (notes.length === 1) clauses.push(notes[0]);
    else if (notes.length > 1) clauses.push(`${notes.slice(0, -1).join(', ')} and ${notes[notes.length - 1]}`);
    return {
      no: q.no,
      questionText: q.questionText,
      awarded: r.awarded,
      total: q.total,
      target: q.target,
      student: q.student,
      tags,
      good,
      title: good ? 'Full marks awarded:' : `Deducted ${fmt(r.deducted)} mark${r.deducted === 1 ? '' : 's'}:`,
      body: good ? `${q.fullNote}.` : `${clauses.join('; ')}.`,
      page: q.page,
      geometry: q.geometry,
      steps: q.steps,
    };
  });
  return {
    chips: [
      { text: 'Demo — sample data, not your documents', tone: 'crit' },
      { text: strict ? 'Strict checking' : 'Standard checking', tone: 'plain' },
      { text: sheetName, tone: 'plain' },
      ...(activeCrit.length
        ? activeCrit.map(k => ({ text: `Penalty: ${CRITERIA[k].label}`, tone: 'crit' as const }))
        : [{ text: 'No penalty criteria selected', tone: 'plain' as const }]),
    ],
    awarded: ev.awarded,
    total: ev.total,
    pct,
    grade: gradeLetter(pct),
    pass: pct >= 60,
    qCount: ev.rows.length,
    deducted: ev.deducted,
    mode: strict ? 'Strict' : 'Standard',
    critCountText: `${activeCrit.length} penalty criteria active`,
    sub: `DEMO preview — ${fmt(ev.awarded)} of ${fmt(ev.total)} sample marks across ${ev.rows.length} sample questions. Enable the live backend to grade your documents.`,
    impact,
    contentExtra: ev.contentSum + ev.strictSum,
    questions,
    pageImages: ev.pageImages || DEMO_PAGE_IMAGES,
    sheetName: 'Tanya Goenka',
    subjectLabel: 'Grade 10 Class 10 A · MATH',
  };
}

function fallbackStepsForRecord(r: GradeRecord): GradeStep[] {
  if (Array.isArray(r.steps) && r.steps.length > 0) return r.steps;
  const geo = Array.isArray(r.geometry) ? r.geometry : [];
  const lines = geo.length
    ? geo.map(g => ({ crop_id: g.crop_id, text: g.latex || r.student_answer }))
    : (r.student_answer || '')
        .split(/\r?\n/)
        .map(s => s.trim())
        .filter(Boolean)
        .map(t => ({ crop_id: '', text: t }));

  const good = r.marks_deducted <= 0;
  if (!lines.length) {
    return [
      {
        title: 'Step 1: Student response',
        status: good ? 'correct' : 'error',
        lines: [{ text: r.student_answer || '(no answer transcribed)', ok: good, error_tag: good ? '' : 'Missing Answer' }],
        explanation: good ? '' : r.feedback,
      },
    ];
  }
  if (good) {
    return lines.map((ln, idx) => ({
      title: `Step ${idx + 1}: Working step ${idx + 1}`,
      status: 'correct',
      lines: [{ crop_id: ln.crop_id, text: ln.text, ok: true, error_tag: '' }],
      explanation: '',
    }));
  }
  const cutoff = r.marks_awarded > 0 && lines.length >= 2 ? Math.max(1, Math.floor(lines.length / 2)) : 0;
  const out: GradeStep[] = [];
  for (let i = 0; i < cutoff; i++) {
    out.push({
      title: `Step ${i + 1}: Initial substitution`,
      status: 'correct',
      lines: [{ crop_id: lines[i].crop_id, text: lines[i].text, ok: true, error_tag: '' }],
      explanation: '',
    });
  }
  for (let i = cutoff; i < lines.length; i++) {
    const isLast = i === lines.length - 1;
    out.push({
      title: `Step ${i + 1}: ${isLast && lines.length >= 2 ? 'Conclusion' : 'Calculate value'}`,
      status: 'error',
      lines: [
        {
          crop_id: lines[i].crop_id,
          text: lines[i].text,
          ok: false,
          error_tag: isLast && lines.length >= 2 ? 'Result Error' : 'Calculation Error',
        },
      ],
      explanation: r.feedback,
    });
  }
  return out;
}

function recordToQVM(r: GradeRecord): QVM {
  const good = r.marks_deducted <= 0;
  const tags: QTag[] = (r.deductions || []).map(d => ({
    label: d.category === 'content' ? 'Content' : CRITERIA[d.category]?.label || d.category,
    amount: d.marks,
    tone: d.category === 'content' ? 'content' : d.category,
  }));
  if (!tags.length) tags.push({ label: `${fmt(r.max_marks)} awarded`, amount: 0, tone: 'awarded' });
  const qNo = String(r.number).toUpperCase().startsWith('Q') ? String(r.number) : `Q${r.number}`;
  const geometry = Array.isArray(r.geometry) ? r.geometry : [];
  const page = r.page || geometry[0]?.page || 1;
  return {
    no: qNo,
    questionText: r.question || r.expected_answer,
    awarded: r.marks_awarded,
    total: r.max_marks,
    target: r.expected_answer,
    student: r.student_answer,
    tags,
    good,
    title: good ? 'Full marks awarded:' : `Deducted ${fmt(r.marks_deducted)} marks:`,
    body: r.feedback,
    ocrNote: r.ocr_note,
    page,
    geometry,
    steps: fallbackStepsForRecord(r),
  };
}

function vmFromPartialLive(
  completedRecords: (GradeRecord | null)[],
  totalExpected: number,
  strict: boolean,
  criteria: CriteriaState,
  model: string,
  inProgress: boolean,
  pageImages: string[] = [],
  sheetName?: string,
): ResultsVM {
  const done = completedRecords.filter((r): r is GradeRecord => r !== null);
  const activeCrit = Object.keys(criteria).filter(k => criteria[k]);

  let awarded = 0;
  let total = 0;
  let deducted = 0;
  const byCat: Record<string, number> = {};

  for (const r of done) {
    awarded += r.marks_awarded;
    total += r.max_marks;
    deducted += r.marks_deducted;
    for (const d of r.deductions || []) {
      byCat[d.category] = (byCat[d.category] || 0) + d.marks;
    }
  }

  awarded = Math.round(awarded * 100) / 100;
  total = Math.round(total * 100) / 100;
  deducted = Math.round(deducted * 100) / 100;
  const pct = total > 0 ? (awarded / total) * 100 : 0;

  const impact: ImpactItem[] = Object.keys(byCat)
    .filter(k => k !== 'content' && k !== 'strict')
    .map(k => ({
      key: k,
      label: CRITERIA[k]?.label || k,
      color: CRITERIA[k]?.color || 'var(--color-crimson)',
      amount: byCat[k],
    }));
  const contentExtra = (byCat.content || 0) + (byCat.strict || 0);

  const questions: QVM[] = done.map(recordToQVM);

  return {
    chips: [
      {
        text: inProgress ? `Evaluating: ${done.length} / ${totalExpected}` : `Live AI · ${model}`,
        tone: inProgress ? 'warn' : 'plain',
      },
      { text: 'Rate Limit: 39 RPM', tone: 'plain' },
      { text: strict ? 'Strict checking' : 'Standard checking', tone: 'plain' },
      ...(activeCrit.length
        ? activeCrit.map(k => ({ text: `Penalty: ${CRITERIA[k]?.label || k}`, tone: 'crit' as const }))
        : [{ text: 'No penalty criteria selected', tone: 'plain' as const }]),
    ],
    awarded,
    total,
    pct,
    grade: gradeLetter(pct),
    pass: pct >= 60,
    qCount: done.length,
    deducted,
    mode: strict ? 'Strict' : 'Standard',
    critCountText: `${activeCrit.length} penalty criteria active`,
    sub: inProgress
      ? `Live evaluation in progress with ${modelLabel(model)} — ${done.length} of ${totalExpected} questions evaluated (batched checking, 5 per request). Outputs appear below in real time as batches return from server.`
      : `Live AI evaluation complete — ${fmt(awarded)} of ${fmt(total)} marks across ${done.length} questions.`,
    impact,
    contentExtra,
    questions,
    pageImages,
    sheetName: sheetName || 'Student Submission',
    subjectLabel: `Live AI · ${modelLabel(model)}`,
    modelName: model,
    inProgress,
  };
}

function vmFromLive(report: LiveReport, fallbackImages: string[] = [], sheetName?: string): ResultsVM {
  const s = report.summary;
  const pct = s.total_marks ? (s.marks_awarded / s.total_marks) * 100 : 0;
  const activeCrit = report.mode.penalty_criteria || [];
  const byCat = s.deductions_by_category || {};
  const impact: ImpactItem[] = Object.keys(byCat)
    .filter(k => k !== 'content' && k !== 'strict')
    .map(k => ({
      key: k,
      label: CRITERIA[k]?.label || k,
      color: CRITERIA[k]?.color || 'var(--color-crimson)',
      amount: byCat[k],
    }));
  const contentExtra = (byCat.content || 0) + (byCat.strict || 0);
  const questions: QVM[] = report.questions.map(recordToQVM);
  const pageImages =
    report.pageImages && report.pageImages.length > 0 ? report.pageImages : fallbackImages;
  return {
    chips: [
      { text: `Live AI · ${report.engine} ${report.model}`, tone: 'plain' },
      { text: 'Rate Limit: 39 RPM', tone: 'plain' },
      { text: report.mode.strict ? 'Strict checking' : 'Standard checking', tone: 'plain' },
      ...(activeCrit.length
        ? activeCrit.map(k => ({ text: `Penalty: ${CRITERIA[k]?.label || k}`, tone: 'crit' as const }))
        : [{ text: 'No penalty criteria selected', tone: 'plain' as const }]),
    ],
    awarded: s.marks_awarded,
    total: s.total_marks,
    pct,
    grade: gradeLetter(pct),
    pass: pct >= 60,
    qCount: s.questions_graded,
    deducted: s.marks_deducted,
    mode: report.mode.strict ? 'Strict' : 'Standard',
    critCountText: `${activeCrit.length} penalty criteria active`,
    sub: `Live AI evaluation complete — ${fmt(s.marks_awarded)} of ${fmt(s.total_marks)} marks across ${s.questions_graded} questions.`,
    impact,
    contentExtra,
    questions,
    pageImages,
    sheetName: sheetName || 'Student Submission',
    subjectLabel: `Live AI · ${modelLabel(report.model)}`,
    modelName: report.model,
    inProgress: false,
  };
}

/* ---------------- Small pieces ---------------- */

function Dropzone({
  docKey,
  title,
  hint,
  file,
  onFile,
  onClear,
  missing,
  compressing,
  shrink,
  onCompress,
}: {
  docKey: DocKey;
  title: string;
  hint: string;
  file: File | null;
  onFile: (doc: DocKey, f: File) => void;
  onClear: (doc: DocKey) => void;
  missing: boolean;
  compressing: boolean;
  shrink: string | null;
  onCompress: (doc: DocKey) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  void docKey;
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={title}
      onClick={e => {
        if ((e.target as HTMLElement).closest('.dz-remove')) return;
        inputRef.current?.click();
      }}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click();
      }}
      onDragEnter={e => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragOver={e => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={e => {
        e.preventDefault();
        setDrag(false);
      }}
      onDrop={e => {
        e.preventDefault();
        setDrag(false);
        const f = e.dataTransfer?.files?.[0];
        if (f) onFile(docKey, f);
      }}
      className={`relative cursor-pointer rounded-xl border-[1.5px] border-dashed bg-black/10 px-4 pt-5 pb-4 text-center transition outline-none ${
        drag
          ? '-translate-y-0.5 border-mint bg-mint/10'
          : file
            ? 'border-mint/50 border-solid bg-mint/5'
            : 'border-white/20 hover:border-mint/60 hover:bg-black/15'
      } ${missing ? 'animate-shake border-crimson' : ''} focus-visible:shadow-[0_0_0_3px_rgba(129,199,132,.3)]`}
    >
      <div
        className={`mx-auto mb-3 grid h-11 w-11 place-items-center rounded-xl border border-white/10 bg-white/5 transition ${
          file ? 'border-mint/45 text-mint' : 'text-white/60'
        }`}
      >
        <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.75">
          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
        </svg>
      </div>
      <div className="text-[14.5px] leading-snug font-bold">{title}</div>
      {!file && <div className="mt-1.5 text-xs text-white/45">{hint}</div>}
      {file && (
        <div className="mt-3 flex items-center justify-center gap-2 rounded-[9px] border border-mint/35 bg-black/25 px-2.5 py-2 text-xs">
          <span className="grid h-[18px] w-[18px] flex-none place-items-center rounded-full bg-mint text-[11px] font-black text-[#12211a]">
            ✓
          </span>
          <span className="max-w-[19ch] overflow-hidden text-ellipsis whitespace-nowrap text-white">{file.name}</span>
        </div>
      )}
      {file && file.size > UPLOAD_TARGET_BYTES && (
        <div className="mt-2 rounded-[9px] border border-sand/40 bg-sand/10 px-2.5 py-2 text-left text-xs">
          <div className="text-[#ffe6c0]">Exceeds 4.5 MB cap ({(file.size / 1048576).toFixed(1)} MB)</div>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={e => {
                e.stopPropagation();
                void onCompress(docKey);
              }}
              disabled={compressing}
              className="cursor-pointer rounded-lg border border-mint/45 bg-mint/15 px-2.5 py-1 text-[11.5px] font-bold text-[#d8f5db] transition hover:bg-mint/25 disabled:cursor-wait disabled:opacity-60"
            >
              {compressing ? 'Compressing…' : 'Compress to fit'}
            </button>
            {shrink && !compressing && <span className="text-white/60">{shrink}</span>}
          </div>
        </div>
      )}
      {file && shrink && file.size <= UPLOAD_TARGET_BYTES && (
        <div className="mt-2 rounded-[9px] border border-mint/35 bg-mint/10 px-2.5 py-1.5 text-left text-xs text-[#d8f5db]">
          ✓ Compressed {shrink} — fits hosting cap, ready to grade
        </div>
      )}
      {file && (
        <button
          type="button"
          title="Remove file"
          aria-label={`Remove ${title}`}
          onClick={e => {
            e.stopPropagation();
            onClear(docKey);
          }}
          className="dz-remove absolute top-2 right-2 z-[5] grid h-6 w-6 place-items-center rounded-[7px] border border-white/10 bg-black/30 text-[13px] text-white/70 hover:border-crimson hover:text-crimson"
        >
          ✕
        </button>
      )}
      <input
        ref={inputRef}
        type="file"
        accept=".pdf,.doc,.docx,.png,.jpg,.jpeg,.txt"
        aria-label={`Choose ${title} file`}
        className="absolute inset-0 z-[1] cursor-pointer opacity-0"
        onChange={e => {
          const f = e.target.files?.[0];
          if (f) onFile(docKey, f);
        }}
      />
    </div>
  );
}

function tagClass(tone: string): string {
  switch (tone) {
    case 'content':
      return 'border-crimson/45 bg-crimson/15 text-[#ffcfcf]';
    case 'strict':
      return 'border-sand/45 bg-sand/15 text-[#ffe6c0]';
    case 'handwriting':
      return 'border-sand/45 bg-sand/15 text-[#ffe6c0]';
    case 'diagrams':
      return 'border-lilac/50 bg-lilac/15 text-[#e6ddff]';
    case 'unreadable':
      return 'border-crimson/50 bg-crimson/15 text-[#ffd2d2]';
    case 'formatting':
      return 'border-mist/50 bg-mist/15 text-[#d9edff]';
    case 'total':
      return 'border-crimson bg-crimson/20 text-[#ffe0e0]';
    case 'awarded':
      return 'border-mint/50 bg-mint/15 text-[#d8f5db]';
    default:
      return 'border-crimson/45 bg-crimson/15 text-[#ffcfcf]';
  }
}

function ResultsView({
  vm,
  onDownloadJson,
  onDownloadMd,
  onDownloadPdf,
}: {
  vm: ResultsVM;
  onDownloadJson?: () => void;
  onDownloadMd?: () => void;
  onDownloadPdf?: () => void;
}) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);
  return (
    <section ref={ref} aria-live="polite" className="animate-rise mt-6 scroll-mt-4">
      <div className="rounded-2xl border border-white/10 bg-canvas p-5 shadow-[0_20px_44px_rgba(0,0,0,.32)] md:p-7">
        <div className="mb-5">
          <div className="mb-1 text-[11px] font-bold tracking-[.18em] text-white/45 uppercase">Step 03</div>
          <h2 className="text-[19px] font-bold tracking-tight">Detailed Evaluation Summary</h2>
          <p className="mt-1 max-w-[52ch] text-[13.5px] text-white/45">{vm.sub}</p>
        </div>

        {vm.inProgress && (
          <div className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-mint/40 bg-mint/10 p-3.5 text-xs text-mint">
            <div className="flex items-center gap-2.5 font-bold">
              <span className="relative flex h-2.5 w-2.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-mint opacity-75" />
                <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-mint" />
              </span>
              <span>Evaluating with {modelLabel(vm.modelName)} · 39 requests/minute limit active · Output streams per question</span>
            </div>
            <span className="rounded-full bg-mint/20 px-2.5 py-1 font-extrabold tabular-nums text-white">
              {vm.qCount} question{vm.qCount === 1 ? '' : 's'} ready
            </span>
          </div>
        )}

        <div className="mb-4 flex flex-wrap items-center gap-2">
          {vm.chips.map((c, i) => (
            <span
              key={i}
              className={`rounded-full border px-3 py-1.5 text-xs ${
                c.tone === 'crit'
                  ? 'border-crimson/45 bg-crimson/15 text-[#ffd6d6]'
                  : 'border-white/10 bg-white/5 text-white/70'
              }`}
            >
              {c.text}
            </span>
          ))}
        </div>

        {(onDownloadJson || onDownloadMd || onDownloadPdf) && (
          <div className="mb-4 flex flex-wrap gap-2.5">
            {onDownloadPdf && (
              <button
                type="button"
                onClick={onDownloadPdf}
                className="cursor-pointer rounded-[10px] border border-mint/45 bg-mint/15 px-4 py-2 text-[13.5px] font-extrabold text-[#d8f5db] shadow-[0_2px_12px_rgba(129,199,132,.2)] hover:bg-mint/25"
              >
                Download report.pdf
              </button>
            )}
            {onDownloadMd && (
              <button
                type="button"
                onClick={onDownloadMd}
                className="cursor-pointer rounded-[10px] border border-white/20 bg-white/5 px-4 py-2 text-[13.5px] font-semibold text-white/80 hover:bg-white/10"
              >
                Download report.md
              </button>
            )}
            {onDownloadJson && (
              <button
                type="button"
                onClick={onDownloadJson}
                className="cursor-pointer rounded-[10px] border border-white/20 bg-white/5 px-4 py-2 text-[13.5px] font-semibold text-white/80 hover:bg-white/10"
              >
                Download report.json
              </button>
            )}
          </div>
        )}

        <div className="grid items-center gap-5 md:grid-cols-2">
          <div>
            <div className="mb-2.5 text-[11px] font-bold tracking-[.18em] text-white/45 uppercase">Marks Obtained</div>
            <div className="flex flex-wrap items-baseline gap-3">
              <span className="text-6xl leading-none font-extrabold tracking-tight md:text-7xl">{fmt(vm.awarded)}</span>
              <span className="text-[22px] font-semibold text-white/45">/ {fmt(vm.total)} total</span>
            </div>
          </div>
          <div>
            <div className="mb-2 flex items-center justify-between text-[13px]">
              <span className="text-white/45">Overall performance</span>
              <span className="text-xl font-extrabold">{vm.pct.toFixed(1)}%</span>
            </div>
            <div className="h-3 overflow-hidden rounded-full border border-white/10 bg-black/30">
              <i className="block h-full rounded-full bg-gradient-to-r from-[#66c17f] to-pine transition-[width] duration-700" style={{ width: `${vm.pct}%` }} />
            </div>
            <span
              className={`mt-4 inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-extrabold ${
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
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[
            { k: 'Total Marks', v: fmt(vm.total), sub: `across ${vm.qCount} questions`, cls: '' },
            { k: 'Marks Obtained', v: fmt(vm.awarded), sub: 'after deductions', cls: 'text-mint' },
            { k: 'Total Deducted', v: fmt(vm.deducted), sub: 'content + penalties', cls: 'text-crimson' },
            { k: 'Checking Mode', v: vm.mode, sub: vm.critCountText, cls: '' },
          ].map(s => (
            <div key={s.k} className="rounded-xl border border-white/10 bg-black/10 px-4 py-3.5">
              <div className="text-[11px] font-bold tracking-[.14em] text-white/45 uppercase">{s.k}</div>
              <div className={`mt-1 text-2xl font-extrabold tracking-tight ${s.cls}`}>{s.v}</div>
              <div className="mt-0.5 text-[11.5px] text-white/45">{s.sub}</div>
            </div>
          ))}
        </div>

        <div className="mt-5 border-t border-white/10 pt-4">
          <h3 className="mb-3 text-xs font-bold tracking-[.16em] text-white/45 uppercase">
            Penalty Impact — where marks were lost
          </h3>
          {vm.impact.length || vm.contentExtra ? (
            <div>
              {vm.impact.map(it => (
                <div key={it.key} className="flex items-center gap-3 py-2 text-[13.5px]">
                  <span className="h-2.5 w-2.5 flex-none rounded-[3px]" style={{ background: it.color }} />
                  <span>{it.label}</span>
                  <span className="ml-auto font-extrabold text-crimson tabular-nums">−{fmt(it.amount)}</span>
                </div>
              ))}
              {vm.contentExtra > 0 && (
                <div className="flex items-center gap-3 py-2 text-[13.5px]">
                  <span className="h-2.5 w-2.5 flex-none rounded-[3px] bg-crimson" />
                  <span>Content &amp; strict-mode deductions</span>
                  <span className="ml-auto font-extrabold text-crimson tabular-nums">−{fmt(vm.contentExtra)}</span>
                </div>
              )}
            </div>
          ) : (
            <div className="text-[13px] text-white/45">No deductions — full marks.</div>
          )}
        </div>
      </div>

      <div className="mt-5 rounded-2xl border border-white/10 bg-canvas p-5 shadow-[0_20px_44px_rgba(0,0,0,.32)] md:p-7">
        <div className="mb-5">
          <div className="mb-1 text-[11px] font-bold tracking-[.18em] text-white/45 uppercase">Granular Breakdown</div>
          <h2 className="text-[19px] font-bold tracking-tight">Question-by-Question Report</h2>
          <p className="mt-1 max-w-[52ch] text-[13.5px] text-white/45">
            Target answer vs. student answer, deduction tags and a full explanation of every mark cut.
          </p>
        </div>
        <div className="grid gap-4">
          {vm.questions.map(q => {
            const cls = q.good ? 'text-mint' : q.awarded >= q.total * 0.7 ? 'text-sand' : 'text-crimson';
            return (
              <article key={q.no} className="rounded-xl border border-white/10 bg-black/10 p-5 transition hover:border-white/20">
                <div className="flex flex-wrap items-center gap-3 border-b border-white/10 pb-3.5">
                  <span className="rounded-[9px] border border-white/10 bg-white/5 px-3 py-1.5 text-[15px] font-extrabold">
                    {q.no}
                  </span>
                  <span className={`text-[15px] font-extrabold tabular-nums ${cls}`}>
                    {fmt(q.awarded)} / {fmt(q.total)}
                  </span>
                  <span className="text-[13px] text-white/45">marks</span>
                  <span
                    className={`ml-auto rounded-full border px-3 py-1 text-xs font-semibold ${
                      q.good ? 'border-mint/40 bg-mint/15 text-[#d8f5db]' : 'border-crimson/40 bg-crimson/15 text-[#ffd6d6]'
                    }`}
                  >
                    {q.good ? '✓ Full marks' : `Marks deducted: −${fmt(q.total - q.awarded)}`}
                  </span>
                </div>
                <div className="mt-3.5 grid gap-3.5 md:grid-cols-2">
                  <div className="rounded-[10px] border border-white/10 bg-black/20 p-3.5">
                    <div className="mb-2 flex items-center gap-1.5 text-[10.5px] font-extrabold tracking-[.16em] text-mint uppercase">
                      <span className="inline-block h-[7px] w-[7px] rounded-full bg-mint" /> Target Answer (Official Key)
                    </div>
                    <p className="text-[13.5px] leading-relaxed text-white/70">{q.target}</p>
                  </div>
                  <div className="rounded-[10px] border border-white/10 bg-black/20 p-3.5">
                    <div className="mb-2 flex items-center gap-1.5 text-[10.5px] font-extrabold tracking-[.16em] text-white/45 uppercase">
                      <span className="inline-block h-[7px] w-[7px] rounded-full bg-white/45" /> Student Answer
                    </div>
                    <p className="text-[13.5px] leading-relaxed text-white/70">{q.student}</p>
                  </div>
                </div>
                <div className="mt-3.5 flex flex-wrap items-center gap-2">
                  <span className="mr-0.5 text-[11px] font-bold tracking-[.14em] text-white/45 uppercase">
                    Marks deducted
                  </span>
                  {q.tags.map((t, i) => (
                    <span key={i} className={`rounded-full border px-2.5 py-1 text-xs font-bold whitespace-nowrap ${tagClass(t.tone)}`}>
                      {t.tone === 'awarded' ? `+ ${t.label}` : `${t.label} −${fmt(t.amount)}`}
                    </span>
                  ))}
                </div>
                <div className={`mt-3.5 rounded-[10px] border border-white/10 border-l-[3px] bg-black/20 p-3.5 text-[13.5px] leading-relaxed text-white/70 ${q.good ? 'border-l-mint' : 'border-l-crimson'}`}>
                  <strong className={q.good ? 'font-extrabold text-mint' : 'font-extrabold text-crimson'}>{q.title}</strong>{' '}
                  {q.body}
                </div>
                {q.ocrNote && (
                  <div className="mt-3.5 rounded-[10px] border border-white/10 border-l-[3px] border-l-mist bg-black/20 p-3.5 text-[13.5px] text-white/70">
                    OCR note: {q.ocrNote}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      </div>
    </section>
  );
}

/* ---------------- Main view ---------------- */

interface GradingProps {
  files: DocFiles;
  setFiles: (f: DocFiles) => void;
  strict: boolean;
  setStrict: (b: boolean) => void;
  criteria: CriteriaState;
  toggleCriterion: (k: string) => void;
  modelOverride: string;
  setModelOverride: (s: string) => void;
  live: boolean;
  setLive: (b: boolean) => void;
  backend: BackendState;
  demoRequest: number;
  notice: { id: number; msg: string } | null;
  onRecord: (awarded: number, total: number, impact: Record<string, number>) => void;
  onNavigate?: (v: View) => void;
  markingMode: 'standard' | 'negative' | 'non_negative';
  setMarkingMode: (m: 'standard' | 'negative' | 'non_negative') => void;
  negativeMarksValue: number;
  setNegativeMarksValue: (n: number) => void;
}

export default function Grading(props: GradingProps) {
  const { files, setFiles, strict, setStrict, criteria, toggleCriterion, modelOverride, setModelOverride, live, setLive, backend, demoRequest, notice, onRecord, markingMode, setMarkingMode, negativeMarksValue, setNegativeMarksValue } = props;
  const [alert, setAlert] = useState<{ msg: string; ok: boolean } | null>(null);
  const [missing, setMissing] = useState<DocKey[]>([]);
  const [running, setRunning] = useState(false);
  const [runLabel, setRunLabel] = useState('Run AI Evaluation');
  const [stage, setStage] = useState<{ done: number; active: number } | null>(null);
  const [vm, setVm] = useState<ResultsVM | null>(null);
  const [liveBlobs, setLiveBlobs] = useState<{ json: string; md: string } | null>(null);
  const [liveReport, setLiveReport] = useState<LiveReport | null>(null);
  const [loaderStatus, setLoaderStatus] = useState<'working' | 'done' | 'error' | null>(null);
  const [compressing, setCompressing] = useState<DocKey | null>(null);
  const [shrinkInfo, setShrinkInfo] = useState<Partial<Record<DocKey, string>>>({});
  const missingTimer = useRef<number | null>(null);

  const flagMissing = useCallback((docs: DocKey[]) => {
    setMissing(docs);
    if (missingTimer.current) window.clearTimeout(missingTimer.current);
    missingTimer.current = window.setTimeout(() => setMissing([]), 1400);
    const names = docs.map(d => DOC_NAMES[d]).join(', ');
    setAlert({ msg: `Please upload: ${names} — all three documents are required.`, ok: false });
  }, []);

  const missingDocs = useCallback((): DocKey[] => (['paper', 'key', 'sheet'] as DocKey[]).filter(d => !files[d]), [files]);

  const runSimulation = useCallback(async () => {
    if (running) return;
    const miss = missingDocs();
    if (miss.length) {
      flagMissing(miss);
      return;
    }
    setRunning(true);
    setAlert(null);
    setVm(null);
    setLiveBlobs(null);
    setLiveReport(null);
    setRunLabel('Evaluating…');
    setLoaderStatus('working');
    setStage({ done: 0, active: 0 });
    for (let i = 0; i < STEPS_TEXT.length; i++) {
      setStage({ done: i, active: i });
      await new Promise(r => setTimeout(r, 430));
      setStage({ done: i + 1, active: -1 });
    }
    const ev = evaluateDemo(strict, criteria);
    setVm(vmFromDemo(ev, strict, criteria, files.sheet?.name || 'student sheet'));
    onRecord(ev.awarded, ev.total, ev.impact);
    setRunning(false);
    setRunLabel('Re-run AI Evaluation');
    setStage(null);
    setLoaderStatus('done');
    setAlert({ msg: 'Demo preview complete — sample data below. Turn on live AI grading for your documents.', ok: true });
  }, [running, missingDocs, flagMissing, strict, criteria, files.sheet, onRecord]);

  const runLiveFlow = useCallback(async () => {
    if (running) return;
    const miss = missingDocs();
    if (miss.length) {
      flagMissing(miss);
      return;
    }
    setRunning(true);
    setAlert(null);
    setVm(null);
    setLiveBlobs(null);
    setRunLabel('Optimizing uploads…');
    setLoaderStatus('working');
    setStage({ done: 0, active: 0 });
    const [paperDoc, keyDoc, studentDoc] = await Promise.all(
      [files.paper!, files.key!, files.sheet!].map(f => compressMediaIfNeeded(f)),
    );
    const shrunk = [paperDoc, keyDoc, studentDoc].filter(r => r.compressed);
    if (shrunk.length > 0) {
      setFiles({
        paper: paperDoc.file,
        key: keyDoc.file,
        sheet: studentDoc.file,
      });
    }
    setRunLabel('Grading with live AI…');
    const penalties = Object.keys(criteria).filter(k => criteria[k]);
    let latestPageImages: string[] = [];
    if (studentDoc.file.type.startsWith('image/')) {
      try {
        latestPageImages = [URL.createObjectURL(studentDoc.file)];
      } catch {
        latestPageImages = [];
      }
    }
    try {
      const { report, markdown } = await runLiveEvaluation({
        paper: paperDoc.file,
        key: keyDoc.file,
        student: studentDoc.file,
        strict,
        penalties,
        marking_mode: markingMode,
        negative_marks_value: negativeMarksValue,
        model: modelOverride.trim() || undefined,
        onPageImages: imgs => {
          latestPageImages = imgs;
        },
        onStage: s => {
          if (s >= 5) setStage({ done: 5, active: -1 });
          else setStage({ done: s, active: s });
        },
        onQuestionsAligned: qs => {
          setRunLabel(`Checking ${qs.length} questions in batches of 5 (3 at a time)\u2026`);
        },
        onQuestionDone: (_record, _idx, total, allGraded) => {
          const completedCount = allGraded.filter(Boolean).length;
          setVm(vmFromPartialLive(
            allGraded,
            total,
            strict,
            criteria,
            modelOverride.trim() || backend.model || DEFAULT_MODEL_ID,
            completedCount < total,
            latestPageImages,
            studentDoc.file.name,
          ));
          setRunLabel(`Grading (${completedCount}/${total} done)`);
        },
      });
      const s = report.summary;
      setVm({
        ...vmFromLive(report, latestPageImages, studentDoc.file.name),
        downloadJson: JSON.stringify(report, null, 2),
        downloadMd: markdown,
      });
      setLiveBlobs({ json: JSON.stringify(report, null, 2), md: markdown || '# WeHelpTeachers — Grading Report\n' });
      setLiveReport(report);
      onRecord(s.marks_awarded, s.total_marks, s.deductions_by_category || {});
      setRunning(false);
      setRunLabel('Re-run AI Evaluation');
      setStage(null);
      setLoaderStatus('done');
      const shrinkNote = shrunk.length
        ? ` (auto-compressed uploads: ${shrunk.map(r => `${r.file.name} ${r.fromMB.toFixed(1)}→${r.toMB.toFixed(1)} MB`).join(', ')})`
        : '';
      setAlert({ msg: `Live AI evaluation complete — report generated below.${shrinkNote}`, ok: true });
    } catch (err) {
      setRunning(false);
      setRunLabel('Run AI Evaluation');
      setStage(null);
      setLoaderStatus('error');
      const errMsg = err instanceof Error ? err.message : String(err);
      setAlert({
        msg: `Live backend failed (${errMsg}) — nothing was graded and no demo was substituted. Check the server API key or switch to a faster model (e.g. Gemma 4 31B Vision or Llama 3.2 90B Vision) and retry.`,
        ok: false,
      });
    }
  }, [running, missingDocs, flagMissing, files, strict, criteria, modelOverride, backend.model, onRecord, setFiles]);

  const runEvaluation = useCallback(() => {
    if (!live) {
      void runSimulation();
      return;
    }
    if (!backend.ok) {
      setAlert({
        msg: 'Live backend is unreachable, so nothing was graded. Set NVIDIA_API_KEY on the server and redeploy for real grading. Uncheck “Use live AI grading” only to preview the UI with sample data.',
        ok: false,
      });
      return;
    }
    void runLiveFlow();
  }, [live, backend.ok, runSimulation, runLiveFlow]);

  // "Try Demo Grading" from Home, and generator 1-click notices
  useEffect(() => {
    if (demoRequest > 0) void runSimulation();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demoRequest]);

  useEffect(() => {
    if (notice) setAlert({ msg: notice.msg, ok: true });
  }, [notice]);

  const onFile = (doc: DocKey, f: File) => {
    setFiles({ ...files, [doc]: f });
    setShrinkInfo(s => {
      if (!(doc in s)) return s;
      const next = { ...s };
      delete next[doc];
      return next;
    });
    setAlert(null);
  };
  const onClear = (doc: DocKey) => {
    setFiles({ ...files, [doc]: null });
    setShrinkInfo(s => {
      if (!(doc in s)) return s;
      const next = { ...s };
      delete next[doc];
      return next;
    });
  };

  const handleCompress = async (doc: DocKey) => {
    const f = files[doc];
    if (!f || compressing) return;
    setCompressing(doc);
    try {
      const r = await compressMediaIfNeeded(f);
      if (r.compressed) {
        onFile(doc, r.file);
        setShrinkInfo(s => ({
          ...s,
          [doc]: `${r.fromMB.toFixed(1)} → ${r.toMB.toFixed(1)} MB (-${r.savedPercent}%)`,
        }));
      } else {
        setShrinkInfo(s => ({ ...s, [doc]: 'Already under hosting cap' }));
      }
    } catch (err: any) {
      setShrinkInfo(s => ({ ...s, [doc]: `Error: ${err?.message || 'Failed'}` }));
    } finally {
      setCompressing(null);
    }
  };

  const handleUpdateQuestion = useCallback(
    (
      qNo: string,
      patch: { awarded?: number; accepted?: boolean; flagged?: boolean; teacherFeedback?: string },
    ) => {
      setVm(prev => {
        if (!prev) return prev;
        const questions = prev.questions.map(q => {
          if (q.no !== qNo) return q;
          const nextAwarded =
            patch.awarded !== undefined
              ? Math.max(0, Math.min(q.total, patch.awarded))
              : q.awarded;
          const nextGood = nextAwarded >= q.total;
          const nextDeducted = Math.max(0, Math.round((q.total - nextAwarded) * 100) / 100);
          return {
            ...q,
            awarded: nextAwarded,
            good: nextGood,
            title: nextGood ? 'Full marks awarded:' : `Deducted ${fmt(nextDeducted)} marks:`,
            accepted: patch.accepted !== undefined ? patch.accepted : q.accepted,
            flagged: patch.flagged !== undefined ? patch.flagged : q.flagged,
            teacherFeedback:
              patch.teacherFeedback !== undefined ? patch.teacherFeedback : q.teacherFeedback,
          };
        });
        const total = questions.reduce((s, q) => s + q.total, 0);
        const awarded = Math.round(questions.reduce((s, q) => s + q.awarded, 0) * 100) / 100;
        const deducted = Math.max(0, Math.round((total - awarded) * 100) / 100);
        const pct = total > 0 ? (awarded / total) * 100 : 0;
        return {
          ...prev,
          questions,
          awarded,
          total,
          deducted,
          pct,
          grade: gradeLetter(pct),
          pass: pct >= 60,
        };
      });

      setLiveReport(prev => {
        if (!prev) return prev;
        const norm = (s: string | number) =>
          String(s).toUpperCase().startsWith('Q') ? String(s).toUpperCase() : `Q${s}`.toUpperCase();
        const questions = prev.questions.map(r => {
          if (norm(r.number) !== qNo.toUpperCase()) return r;
          const nextAwarded =
            patch.awarded !== undefined
              ? Math.max(0, Math.min(r.max_marks, patch.awarded))
              : r.marks_awarded;
          const nextDeducted = Math.max(0, Math.round((r.max_marks - nextAwarded) * 100) / 100);
          const baseFeedback = r.feedback.replace(/\n\nTeacher Feedback:[\s\S]*$/, '');
          const nextFeedback =
            patch.teacherFeedback !== undefined
              ? patch.teacherFeedback.trim()
                ? `${baseFeedback}\n\nTeacher Feedback: ${patch.teacherFeedback.trim()}`
                : baseFeedback
              : r.feedback;
          return {
            ...r,
            marks_awarded: nextAwarded,
            marks_deducted: nextDeducted,
            feedback: nextFeedback,
          };
        });
        const total_marks = questions.reduce((s, r) => s + r.max_marks, 0);
        const marks_awarded = Math.round(questions.reduce((s, r) => s + r.marks_awarded, 0) * 100) / 100;
        const marks_deducted = Math.max(0, Math.round((total_marks - marks_awarded) * 100) / 100);
        const percentage = total_marks > 0 ? Math.round((marks_awarded / total_marks) * 1000) / 10 : 0;
        const updated: LiveReport = {
          ...prev,
          questions,
          summary: {
            ...prev.summary,
            total_marks,
            marks_awarded,
            marks_deducted,
            percentage,
          },
        };
        setLiveBlobs(b => (b ? { ...b, json: JSON.stringify(updated, null, 2) } : b));
        return updated;
      });
    },
    [],
  );

  const handleAcceptAll = useCallback(() => {
    setVm(prev => {
      if (!prev) return prev;
      return {
        ...prev,
        questions: prev.questions.map(q => ({ ...q, accepted: true, flagged: false })),
      };
    });
  }, []);

  const buildExportJson = useCallback(() => {
    if (!vm) return '{}';
    return JSON.stringify(
      {
        sheetName: vm.sheetName,
        mode: vm.mode,
        summary: {
          marks_awarded: vm.awarded,
          total_marks: vm.total,
          marks_deducted: vm.deducted,
          percentage: Math.round(vm.pct * 10) / 10,
          grade: vm.grade,
        },
        questions: vm.questions.map(q => ({
          number: q.no,
          question: q.questionText,
          awarded: q.awarded,
          total: q.total,
          accepted: !!q.accepted,
          flagged: !!q.flagged,
          feedback: q.body,
          teacher_feedback: q.teacherFeedback || '',
          steps: q.steps,
        })),
      },
      null,
      2,
    );
  }, [vm]);

  const buildExportMd = useCallback(() => {
    if (!vm) return '';
    const lines = [
      `# WeHelpTeachers — Grading Report (${vm.sheetName || 'Student Submission'})`,
      '',
      `**Score:** ${fmt(vm.awarded)} / ${fmt(vm.total)} (${vm.pct.toFixed(1)}% · Grade ${vm.grade})`,
      '',
    ];
    for (const q of vm.questions) {
      lines.push(`## ${q.no} — ${fmt(q.awarded)} / ${fmt(q.total)} marks ${q.accepted ? '[Accepted]' : ''} ${q.flagged ? '[Flagged]' : ''}`);
      lines.push(`- **Question:** ${q.questionText}`);
      lines.push(`- **AI Evaluation:** ${q.body}`);
      if (q.teacherFeedback) {
        lines.push(`- **Teacher Feedback:** ${q.teacherFeedback}`);
      }
      lines.push('');
    }
    return lines.join('\n');
  }, [vm]);

  return (
    <div>
      <div className="grid items-start gap-5 xl:grid-cols-[1.35fr_1fr]">
        {/* Upload bay */}
        <section aria-labelledby="upload-title" className="rounded-2xl border border-white/10 bg-canvas p-5 shadow-[0_20px_44px_rgba(0,0,0,.32)] md:p-7">
          <div className="mb-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-[11px] font-bold tracking-[.18em] text-white/45 uppercase">Step 01</div>
              {props.onNavigate && (
                <button
                  type="button"
                  onClick={() => props.onNavigate?.('compressor')}
                  className="cursor-pointer text-xs font-semibold text-mint hover:underline"
                >
                  Open Media Compressor →
                </button>
              )}
            </div>
            <h2 id="upload-title" className="text-[19px] font-bold tracking-tight">
              Document Upload Bay
            </h2>
            <p className="mt-1 max-w-[52ch] text-[13.5px] text-white/45">
              Provide the question paper, the official rubric and the student&apos;s answer sheet. All three are
              required before evaluation.
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-1 2xl:grid-cols-3">
            {DOC_META.map(d => (
              <Dropzone
                key={d.key}
                docKey={d.key}
                title={d.title}
                hint={d.hint}
                file={files[d.key]}
                onFile={onFile}
                onClear={onClear}
                missing={missing.includes(d.key)}
                compressing={compressing === d.key}
                shrink={shrinkInfo[d.key] ?? null}
                onCompress={doc => void handleCompress(doc)}
              />
            ))}
          </div>
        </section>

        {/* Control panel */}
        <section aria-labelledby="control-title" className="rounded-2xl border border-white/10 bg-canvas p-5 shadow-[0_20px_44px_rgba(0,0,0,.32)] md:p-7">
          <div className="mb-5">
            <div className="mb-1 text-[11px] font-bold tracking-[.18em] text-white/45 uppercase">Step 02</div>
            <h2 id="control-title" className="text-[19px] font-bold tracking-tight">
              Grading Modes &amp; Parameters
            </h2>
            <p className="mt-1 max-w-[52ch] text-[13.5px] text-white/45">
              Control how the evaluation engine awards — and deducts — marks.
            </p>
          </div>

          <div className="flex items-center justify-between gap-4 rounded-xl border border-white/10 bg-black/10 p-4">
            <div>
              <div className="text-[14.5px] font-bold">Strict Checking Mode</div>
              <div className="mt-0.5 max-w-[34ch] text-xs text-white/45">
                No partial credit for incomplete answers; rubric must be matched exactly.
              </div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={strict}
              aria-label="Strict Checking Mode"
              onClick={() => setStrict(!strict)}
              className={`relative h-[30px] w-14 flex-none cursor-pointer rounded-full border transition ${
                strict ? 'border-mint bg-mint/30' : 'border-white/20 bg-black/35'
              }`}
            >
              <span
                className={`switch-knob absolute top-[3px] left-[3px] h-[22px] w-[22px] rounded-full ${
                  strict ? 'translate-x-[26px] bg-mint' : 'bg-white/70'
                }`}
              />
            </button>
          </div>

          <fieldset className="mt-4 border-0">
            <legend className="mb-2.5 text-[11px] font-bold tracking-[.16em] text-white/45 uppercase">
              Marking Mode — wrong answer policy
            </legend>
            <div className="grid gap-2.5">
              {([
                {
                  value: 'standard' as const,
                  label: 'Standard Marking',
                  desc: 'Deduct marks from the question total as usual',
                },
                {
                  value: 'negative' as const,
                  label: 'Negative Marking',
                  desc: 'Wrong answers lose extra marks (penalty below)',
                },
                {
                  value: 'non_negative' as const,
                  label: 'Non-Negative Marking',
                  desc: 'Wrong answers score 0 — no marks deducted',
                },
              ] as const).map(opt => (
                <label
                  key={opt.value}
                  className={`flex cursor-pointer items-center gap-2.5 rounded-xl border bg-black/10 p-3 text-[13.5px] transition select-none ${
                    markingMode === opt.value ? 'border-mint/45 bg-mint/5' : 'border-white/10 hover:border-white/20 hover:bg-black/15'
                  }`}
                >
                  <input
                    type="radio"
                    name="markingMode"
                    className="sr-only"
                    checked={markingMode === opt.value}
                    onChange={() => setMarkingMode(opt.value)}
                  />
                  <span
                    aria-hidden="true"
                    className={`grid h-[19px] w-[19px] flex-none place-items-center rounded-full border-[1.5px] text-[10px] font-black transition ${
                      markingMode === opt.value ? 'border-mint bg-mint text-[#12211a]' : 'border-white/20 bg-black/25 text-transparent'
                    }`}
                  >
                    ●
                  </span>
                  <span>
                    <b className="block font-semibold">{opt.label}</b>
                    <span className="text-[11.5px] text-white/45">{opt.desc}</span>
                  </span>
                </label>
              ))}
            </div>
            {markingMode === 'negative' && (
              <div className="mt-3 rounded-xl border border-crimson/30 bg-crimson/5 p-3.5">
                <label htmlFor="negativeMarksValue" className="block text-[12.5px] font-semibold text-[#ffd6d6]">
                  Penalty per wrong answer
                  <span className="ml-1.5 text-[11px] font-normal text-white/45">(marks deducted for each incorrect answer)</span>
                </label>
                <input
                  type="number"
                  id="negativeMarksValue"
                  min="0"
                  step="0.25"
                  value={negativeMarksValue || ''}
                  onChange={e => setNegativeMarksValue(Math.max(0, parseFloat(e.target.value) || 0))}
                  placeholder="e.g. 0.25 or 1"
                  className="mt-2 w-full rounded-[8px] border border-crimson/30 bg-black/30 px-3 py-2 text-xs text-white outline-none focus:border-crimson focus:shadow-[0_0_0_3px_rgba(239,83,80,.25)] placeholder:text-white/30"
                />
                {negativeMarksValue > 0 && (
                  <div className="mt-2 text-[11.5px] text-[#ffcfcf]">
                    Each wrong answer will lose an additional <strong>−{negativeMarksValue}</strong> mark{negativeMarksValue !== 1 ? 's' : ''} beyond the question's own deductions.
                  </div>
                )}
              </div>
            )}
          </fieldset>

          <fieldset className="mt-4 border-0">
            <legend className="mb-2.5 text-[11px] font-bold tracking-[.16em] text-white/45 uppercase">
              Penalty Criteria — deduct marks for
            </legend>
            <div className="grid gap-2.5 sm:grid-cols-2">
              {Object.values(CRITERIA).map(c => (
                <label
                  key={c.key}
                  className={`flex cursor-pointer items-center gap-2.5 rounded-xl border bg-black/10 p-3 text-[13.5px] transition select-none ${
                    criteria[c.key] ? 'border-mint/45 bg-mint/5' : 'border-white/10 hover:border-white/20 hover:bg-black/15'
                  }`}
                >
                  <input
                    type="checkbox"
                    className="sr-only"
                    checked={!!criteria[c.key]}
                    onChange={() => toggleCriterion(c.key)}
                  />
                  <span
                    aria-hidden="true"
                    className={`grid h-[19px] w-[19px] flex-none place-items-center rounded-md border-[1.5px] text-xs font-black transition ${
                      criteria[c.key] ? 'border-mint bg-mint text-[#12211a]' : 'border-white/20 bg-black/25 text-transparent'
                    }`}
                  >
                    ✓
                  </span>
                  <span>
                    <b className="block font-semibold">{c.label.split(' — ')[0] ?? c.label}</b>
                    <span className="text-[11.5px] text-white/45">
                      {c.key === 'handwriting' && 'Illegible script & cramped letters'}
                      {c.key === 'diagrams' && 'Missing labels, wrong structure'}
                      {c.key === 'unreadable' && 'Figures the engine cannot parse'}
                      {c.key === 'formatting' && 'Skipped working & unstructured answers'}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <div aria-label="Live backend settings" className="mt-4 rounded-xl border border-white/10 bg-black/10 p-3.5">
            <div className="flex items-center justify-between">
              <div className="text-[11px] font-bold tracking-[.16em] text-white/45 uppercase">Live AI Engine &amp; Model (build.nvidia.com)</div>
              <span className="rounded-full border border-mint/30 bg-mint/10 px-2 py-0.5 text-[10px] font-bold text-mint">
                Fast Direct Mode
              </span>
            </div>
            <div className="mt-1 text-xs text-white/45">Recommended high-speed NVIDIA NIM models for OCR &amp; grading:</div>

            <div className="mt-2.5 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              {[
                {
                  id: DEFAULT_MODEL_ID,
                  name: 'Nemotron 3.5 Super VL',
                  tag: 'Default Multi-Page VLM · 12B Active',
                  tagTone: 'text-mint/90',
                  desc: 'Native multi-page OCR + rubric grading with chain-of-thought overhead disabled.',
                  match: (m: string) => !m.trim() || m.includes('super-vl'),
                },
                {
                  id: 'google/gemma-4-31b-it',
                  name: 'Gemma 4 31B Vision',
                  tag: 'Recommended Fast VLM · ~2s/page',
                  tagTone: 'text-mint/90',
                  desc: 'Google’s multimodal vision-language model on NVIDIA NIM. Fast OCR & strict JSON.',
                  match: (m: string) => m.includes('gemma-4-31b'),
                },
                {
                  id: 'meta/llama-3.2-90b-vision-instruct',
                  name: 'Llama 3.2 90B Vision',
                  tag: 'Zero-Thinking VLM · High Accuracy',
                  tagTone: 'text-mint/90',
                  desc: 'Instant non-thinking vision instruct model. Ideal for dense handwriting & answer keys.',
                  match: (m: string) => m.includes('llama-3.2-90b'),
                },
                {
                  id: 'meta/llama-3.2-11b-vision-instruct',
                  name: 'Llama 3.2 11B Vision',
                  tag: 'Ultra-Light VLM · ~1s/page',
                  tagTone: 'text-mint/90',
                  desc: 'Lowest-latency vision model on build.nvidia.com for clean scans and printed keys.',
                  match: (m: string) => m.includes('llama-3.2-11b'),
                },
                {
                  id: 'nvidia/nemotron-3.5-lightning-30b-a3b',
                  name: 'Nemotron 3.5 Lightning',
                  tag: 'Fastest Grader · 3B Active MoE',
                  tagTone: 'text-sand/90',
                  desc: 'Sub-second batch grading (30B/3B active). Auto-pairs with VLM for image scans.',
                  match: (m: string) => m.includes('lightning'),
                },
                {
                  id: 'deepseek-ai/deepseek-v4.1-flash',
                  name: 'DeepSeek V4.1 Flash',
                  tag: 'High-Throughput MoE · ~1.5s/batch',
                  tagTone: 'text-sand/90',
                  desc: 'Fast rubric step-by-step evaluation. Auto-pairs with VLM for image scans.',
                  match: (m: string) => m.includes('deepseek'),
                },
              ].map(preset => {
                const active = preset.match(modelOverride);
                return (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => setModelOverride(preset.id)}
                    className={`group flex cursor-pointer flex-col rounded-xl border p-3 text-left transition-all duration-200 ${
                      active
                        ? 'border-mint/60 bg-mint/[0.08] shadow-[0_0_24px_rgba(129,199,132,0.12)] ring-1 ring-mint/30'
                        : 'border-white/10 bg-white/[0.02] hover:border-white/20 hover:bg-white/[0.05]'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-1">
                      <span className="text-[12.5px] font-semibold tracking-tight text-white">
                        {preset.name}
                      </span>
                      {active ? (
                        <span className="flex items-center gap-1 rounded-full border border-mint/40 bg-mint/15 px-2 py-0.5 text-[9px] font-semibold tracking-wide text-mint uppercase">
                          <span className="h-1.5 w-1.5 rounded-full bg-mint shadow-[0_0_6px_var(--color-mint)]" />
                          Active
                        </span>
                      ) : (
                        <span className="h-1.5 w-1.5 rounded-full bg-white/20 group-hover:bg-white/40" />
                      )}
                    </div>
                    <div className={`mt-1 text-[10.5px] font-medium ${preset.tagTone}`}>
                      {preset.tag}
                    </div>
                    <div className="mt-1 text-[10.5px] text-white/45 leading-relaxed">
                      {preset.desc}
                    </div>
                  </button>
                );
              })}
            </div>

            <div className="mt-3">
              <label htmlFor="modelId" className="block text-[11.5px] text-white/60">
                Custom NIM Model ID <span className="text-white/35">(any model from build.nvidia.com)</span>:
              </label>
              <input
                type="text"
                id="modelId"
                value={modelOverride}
                onChange={e => setModelOverride(e.target.value)}
                placeholder="e.g. google/gemma-4-31b-it or meta/llama-3.2-90b-vision-instruct"
                autoComplete="off"
                aria-label="Model id override"
                className="mt-1 w-full rounded-[8px] border border-white/20 bg-black/30 px-3 py-2 text-xs text-white outline-none focus:border-mint focus:shadow-[0_0_0_3px_rgba(129,199,132,.25)]"
              />
            </div>

            <div className="mt-2.5 flex items-center gap-2.5 text-[13px]">
              <label
                className={`flex flex-1 cursor-pointer items-center gap-2.5 rounded-xl border bg-black/10 p-3 transition ${
                  live ? 'border-mint/45 bg-mint/5' : 'border-white/10'
                }`}
              >
                <input type="checkbox" className="sr-only" checked={live} onChange={e => setLive(e.target.checked)} />
                <span
                  aria-hidden="true"
                  className={`grid h-[19px] w-[19px] flex-none place-items-center rounded-md border-[1.5px] text-xs font-black ${
                    live ? 'border-mint bg-mint text-[#12211a]' : 'border-white/20 bg-black/25 text-transparent'
                  }`}
                >
                  ✓
                </span>
                <span>
                  <b className="block font-semibold">Use live AI grading</b>
                  <span className="text-[11.5px] text-white/45">Uncheck to preview the offline demo</span>
                </span>
              </label>
            </div>
            <div className={`mt-2 text-xs ${backend.ok ? 'text-mint' : 'text-crimson'}`}>
              {backend.ok
                ? `● Live backend connected (Active: ${modelOverride.trim() || backend.model || DEFAULT_MODEL_ID}).`
                : '○ No live backend (offline demo mode). Deploy with `vercel` to enable AI grading.'}
            </div>
          </div>

          <button
            type="button"
            onClick={runEvaluation}
            disabled={running}
            className="mt-5 flex w-full cursor-pointer items-center justify-center gap-2.5 rounded-xl border-none bg-gradient-to-br from-[#57a674] to-pine px-5 py-4 font-sans text-[15.5px] font-extrabold text-[#0d1a12] shadow-[0_14px_30px_rgba(78,154,106,.32)] transition hover:-translate-y-0.5 hover:brightness-105 disabled:cursor-progress disabled:saturate-50 disabled:brightness-90"
          >
            {running && (
              <span className="h-4 w-4 flex-none animate-spin rounded-full border-2 border-[#0d1a12]/30 border-t-[#0d1a12]" />
            )}
            {runLabel}
          </button>

          {loaderStatus && (
            <div className="mt-3.5 flex items-center text-white/70">
              <LatticeLoader
                status={loaderStatus}
                label="Grading"
                doneLabel="Graded in"
                errorLabel="Failed after"
                pattern="orbit"
                grid={3}
                shape="round"
                showTimer
              />
            </div>
          )}

          {alert && (
            <div
              role="status"
              aria-live="polite"
              className={`mt-3.5 rounded-xl border p-3 text-[13.5px] ${
                alert.ok ? 'border-mint/45 bg-mint/15 text-[#dff6e1]' : 'border-crimson/45 bg-crimson/15 text-[#ffd9d9]'
              }`}
            >
              {alert.msg}
            </div>
          )}

          {stage && (
            <div aria-live="polite" className="mt-4 pl-1">
              {STEPS_TEXT.map((t, i) => (
                <div
                  key={t}
                  className={`flex items-center gap-2.5 py-1.5 text-[13px] transition ${
                    i === stage.active ? 'text-white opacity-100' : i < stage.done ? 'text-white/70 opacity-75' : 'text-white/45 opacity-40'
                  }`}
                >
                  <span
                    className={`h-[9px] w-[9px] flex-none rounded-full transition ${
                      i === stage.active ? 'bg-mint shadow-[0_0_0_4px_rgba(129,199,132,.18)]' : i < stage.done ? 'bg-mint' : 'bg-white/20'
                    }`}
                  />
                  <span>{t}</span>
                  <span className={`ml-auto font-extrabold text-mint ${i < stage.done ? 'visible' : 'invisible'}`}>✓</span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      {vm && (
        <>
          <DualPaneReview
            vm={vm}
            onUpdateQuestion={handleUpdateQuestion}
            onAcceptAll={handleAcceptAll}
            onDownloadPdf={
              liveReport
                ? async () => {
                    const bytes = await generateGradingReportPdf(liveReport);
                    downloadPdf(bytes, 'grading-report.pdf');
                  }
                : undefined
            }
            onDownloadJson={() =>
              downloadText(liveBlobs?.json || buildExportJson(), 'report.json', 'application/json')
            }
            onDownloadMd={() =>
              downloadText(liveBlobs?.md || buildExportMd(), 'report.md', 'text/markdown')
            }
          />
          <ResultsView
            vm={vm}
            onDownloadPdf={
              liveReport
                ? async () => {
                    const bytes = await generateGradingReportPdf(liveReport);
                    downloadPdf(bytes, 'grading-report.pdf');
                  }
                : undefined
            }
            onDownloadJson={() =>
              downloadText(liveBlobs?.json || buildExportJson(), 'report.json', 'application/json')
            }
            onDownloadMd={() =>
              downloadText(liveBlobs?.md || buildExportMd(), 'report.md', 'text/markdown')
            }
          />
        </>
      )}
    </div>
  );
}
