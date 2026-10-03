/* Live backend client — same-origin Flask /api (split pipeline). */
import { compressMediaIfNeeded } from './mediaCompressor';

export const APP_SECRET: string = (() => {
  const v = (window as unknown as { __APP_SECRET__?: string }).__APP_SECRET__ || '';
  return v.startsWith('__VERCEL') ? '' : v;
})();

export function api(path: string, opts: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = { ...(opts.headers as Record<string, string> | undefined) };
  if (APP_SECRET) headers['X-App-Secret'] = APP_SECRET;
  return fetch(path, { ...opts, headers });
}

export async function apiJson<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await api(path, opts);
  const data = (await res.json().catch(() => ({}))) as { error?: string } & Record<string, unknown>;
  if (!res.ok) throw new Error(data.error || `backend error (HTTP ${res.status})`);
  return data as T;
}

export interface BackendHealth {
  ok: boolean;
  hasApiKey: boolean;
  hasNvidiaKey: boolean;
  model: string;
}

export interface BackendState {
  ok: boolean;
  model: string;
  hasKey: boolean;
}

export async function checkBackend(): Promise<BackendState> {
  const health = await apiJson<BackendHealth>('/api/health');
  return { ok: true, model: health.model, hasKey: health.hasApiKey };
}

export type CriterionKey = 'handwriting' | 'diagrams' | 'unreadable' | 'formatting';

export interface Deduction {
  category: string;
  marks: number;
}

export interface GradeRecord {
  number: string | number;
  max_marks: number;
  marks_awarded: number;
  marks_deducted: number;
  expected_answer: string;
  student_answer: string;
  feedback: string;
  ocr_note?: string;
  deductions: Deduction[];
}

export interface LiveSummary {
  total_marks: number;
  marks_awarded: number;
  marks_deducted: number;
  percentage: number;
  questions_graded: number;
  deductions_by_category: Record<string, number>;
}

export interface LiveReport {
  engine: string;
  model: string;
  mode: { strict: boolean; penalty_criteria: string[] };
  summary: LiveSummary;
  questions: GradeRecord[];
}

export interface AlignedQuestion {
  number: string | number;
  [key: string]: unknown;
}

async function pool<T, R>(items: T[], n: number, fn: (item: T, idx: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length || 1) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k], k);
      }
    }),
  );
  return out;
}

export interface LiveEvalInput {
  paper: File;
  key: File;
  student: File;
  strict: boolean;
  penalties: string[];
  model?: string;
  onStage?: (stage: number) => void;
}

export async function runLiveEvaluation(input: LiveEvalInput): Promise<{ report: LiveReport; markdown: string }> {
  const roles = ['paper', 'key', 'student'] as const;
  const files: Record<(typeof roles)[number], File> = {
    paper: input.paper,
    key: input.key,
    student: input.student,
  };
  for (const role of roles) {
    if (files[role] && files[role].size > 3_500_000) {
      const res = await compressMediaIfNeeded(files[role]);
      if (res.compressed) {
        files[role] = res.file;
      }
    }
  }
  const oversize = Object.entries(files).find(([, f]) => f && f.size > 4_500_000);
  if (oversize) {
    throw new Error(
      `"${oversize[1].name}" is ${(oversize[1].size / 1048576).toFixed(1)} MB — exceeds 4.5 MB cap even after compression. Split or resize the file.`,
    );
  }

  // Stage 1 — transcribe the three documents in parallel (one AI call each).
  input.onStage?.(0);
  const extracted = await Promise.all(
    roles.map(async role => {
      const fd = new FormData();
      fd.append('file', files[role], files[role].name);
      fd.append('role', role);
      if (input.model) fd.append('model', input.model);
      const res = await api('/api/extract', { method: 'POST', body: fd });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        role?: string;
        filename?: string;
        kind?: string;
        pages?: number;
        warnings?: string[];
        data?: Record<string, unknown[]>;
      };
      if (!res.ok) throw new Error(data.error || `could not transcribe ${files[role].name} (HTTP ${res.status})`);
      return data;
    }),
  );
  const byRole: Record<string, (typeof extracted)[number]> = {};
  extracted.forEach(e => {
    if (e.role) byRole[e.role] = e;
  });
  input.onStage?.(2);

  // Stage 2 — map responses onto question numbers (instant, no AI).
  const docs: Record<string, { file: string; kind: string; pages: number }> = {};
  roles.forEach(r => {
    docs[r] = {
      file: byRole[r].filename || r,
      kind: byRole[r].kind || 'unknown',
      pages: byRole[r].pages || 0,
    };
  });
  const docWarnings: string[] = [];
  extracted.forEach(e => (e.warnings || []).forEach(w => docWarnings.push(`${e.role}: ${w}`)));
  const alignBody: Record<string, unknown> = {
    paper: (byRole.paper.data as Record<string, unknown[]> | undefined)?.questions,
    key: (byRole.key.data as Record<string, unknown[]> | undefined)?.entries,
    student: (byRole.student.data as Record<string, unknown[]> | undefined)?.answers,
    documents: docs,
  };
  if (input.model) alignBody.model = input.model;
  const aligned = await apiJson<{
    aligned: AlignedQuestion[];
    warnings: string[];
    model: string;
  }>('/api/align', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(alignBody),
  });
  const usedModel = aligned.model;
  input.onStage?.(3);

  // Stage 3 — grade one question per call (short enough for capped hosts).
  const records = await pool(aligned.aligned, 3, async q => {
    const data = await apiJson<{ record: GradeRecord }>('/api/grade-one', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: q,
        strict: input.strict,
        penalties: input.penalties,
        model: usedModel,
      }),
    });
    return data.record;
  });
  input.onStage?.(4);

  // Stage 4 — assemble the canonical report (instant, no AI).
  const reportData = await apiJson<{ report: LiveReport; markdown: string }>('/api/report', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      records,
      documents: docs,
      strict: input.strict,
      penalties: input.penalties,
      warnings: docWarnings.concat(aligned.warnings || []),
      engine: 'nvidia',
      model: usedModel,
    }),
  });
  input.onStage?.(5);
  return reportData;
}

/* ---------------- Exam generator ---------------- */

export interface GeneratedQuestion {
  number: string;
  text: string;
  max_marks: number;
  expected_answer: string;
  marking_scheme: string;
  keywords: string[];
}

export interface GeneratedExam {
  title: string;
  topic: string;
  instructions: string;
  total_marks: number;
  questions: GeneratedQuestion[];
}

export interface GenerateExamInput {
  topic: string;
  grade: string;
  difficulty: string;
  count: number;
  marks: number;
  model?: string;
}

export async function generateExam(input: GenerateExamInput): Promise<{ exam: GeneratedExam; model: string; note?: string }> {
  return apiJson<{ exam: GeneratedExam; model: string; note?: string }>('/api/generate-exam', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export function buildGenPaperText(exam: GeneratedExam): string {
  const lines = [
    exam.title || 'Generated Exam',
    `Topic: ${exam.topic || ''}`,
    `Instructions: ${exam.instructions || ''}`,
    `Total marks: ${exam.total_marks || 0}`,
    '',
  ];
  (exam.questions || []).forEach(q => {
    lines.push(`${q.number || ''} (${q.max_marks || 0} marks)`, `${q.text || ''}`, '');
  });
  return lines.join('\n');
}

export function buildGenKeyText(exam: GeneratedExam): string {
  const lines = [`${exam.title || 'Generated Exam'} — Official Answer Key`, `Topic: ${exam.topic || ''}`, ''];
  (exam.questions || []).forEach(q => {
    lines.push(
      `${q.number || ''} (${q.max_marks || 0} marks)`,
      `Answer: ${q.expected_answer || ''}`,
      `Scheme: ${q.marking_scheme || ''}`,
      q.keywords && q.keywords.length ? `Keywords: ${q.keywords.join(', ')}` : '',
      '',
    );
  });
  return lines.join('\n');
}

export function downloadText(text: string, filename: string, mime: string): void {
  const blob = new Blob([text], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 500);
}
