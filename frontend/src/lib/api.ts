/* Live backend client — same-origin Flask /api (split pipeline). */
import { compressMediaIfNeeded } from './mediaCompressor';

export const APP_SECRET: string = (() => {
  const v = (window as unknown as { __APP_SECRET__?: string }).__APP_SECRET__ || '';
  return v.startsWith('__VERCEL') ? '' : v;
})();

/* Default model id used by the server (engine.WHT_ENGINE_DEFAULT_MODEL) — kept here
 * so preset buttons and status lines match the backend when no override is set. */
export const DEFAULT_MODEL_ID = 'nvidia/nemotron-3.5-super-vl:free';

/* Human-readable name for a model id; empty/unknown → default model name. */
export function modelLabel(id?: string): string {
  const v = (id || '').toLowerCase();
  if (v.includes('nemotron')) return 'Nemotron 3.5 Super VL';
  return id ? id.split('/').pop() || 'Nemotron 3.5 Super VL' : 'Nemotron 3.5 Super VL';
}

export async function api(path: string, opts: RequestInit = {}, retries = 2): Promise<Response> {
  const headers: Record<string, string> = { ...(opts.headers as Record<string, string> | undefined) };
  if (APP_SECRET) headers['X-App-Secret'] = APP_SECRET;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(path, { ...opts, headers });
      // Retry only transient states: 502 means the server already exhausted
      // its own model retries (retrying here stacks minutes of work), and 504
      // means the function hit its hard time cap (retrying doubles the wait).
      if (res.status === 503 && attempt < retries) {
        await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
        continue;
      }
      return res;
    } catch (err: unknown) {
      lastErr = err;
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
        continue;
      }
    }
  }
  const rawMsg = String((lastErr as Error)?.message || lastErr || '');
  if (/failed to fetch|networkerror|load failed/i.test(rawMsg)) {
    throw new Error(
      'Connection to the grading server dropped or timed out (Failed to fetch). Ensure the backend server is running and KILO_API_KEY is set.'
    );
  }
  throw lastErr instanceof Error ? lastErr : new Error(rawMsg || 'Network request failed');
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
  hasWhtEngineKey: boolean;
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
  reason?: string;
}

export interface CropGeometry {
  crop_id: string;
  page: number;
  rect: [number, number, number, number];
  latex?: string;
  confidence?: number;
}

export interface StepLine {
  crop_id?: string;
  text: string;
  ok: boolean;
  error_tag?: string;
}

export interface GradeStep {
  title: string;
  status: 'correct' | 'error';
  lines: StepLine[];
  explanation?: string;
}

export interface GradeRecord {
  number: string | number;
  question?: string;
  max_marks: number;
  marks_awarded: number;
  marks_deducted: number;
  expected_answer: string;
  student_answer: string;
  feedback: string;
  ocr_note?: string;
  page?: number;
  legibility?: string;
  deductions: Deduction[];
  geometry?: CropGeometry[];
  steps?: GradeStep[];
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
  pageImages?: string[];
}

export interface AlignedQuestion {
  number: string | number;
  [key: string]: unknown;
}

/**
 * Rate limiter enforcing a maximum number of requests in a rolling window.
 * Kilo's free tier allows ~200 requests/hour, so the default is a gentle
 * 6 requests per minute: enough to stream a 5-8 question paper quickly
 * without tripping 429s that would otherwise fail the whole run.
 */
export class RateLimiter {
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private timestamps: number[] = [];

  constructor(maxRequests: number = 6, windowMs: number = 60_000) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  private prune(now: number) {
    const cutoff = now - this.windowMs;
    while (this.timestamps.length > 0 && this.timestamps[0] <= cutoff) {
      this.timestamps.shift();
    }
  }

  async acquire(): Promise<void> {
    while (true) {
      const now = Date.now();
      this.prune(now);
      if (this.timestamps.length < this.maxRequests) {
        this.timestamps.push(Date.now());
        return;
      }
      // Window full — wait until the oldest request timestamp expires.
      const oldest = this.timestamps[0];
      const wait = Math.max(50, oldest + this.windowMs - now + 50);
      await new Promise(resolve => setTimeout(resolve, wait));
    }
  }

  get activeInWindow(): number {
    this.prune(Date.now());
    return this.timestamps.length;
  }
}

export interface LiveEvalInput {
  paper: File;
  key: File;
  student: File;
  strict: boolean;
  penalties: string[];
  marking_mode?: 'standard' | 'negative' | 'non_negative';
  negative_marks_value?: number;
  model?: string;
  onStage?: (stage: number) => void;
  onPageImages?: (images: string[]) => void;
  onQuestionsAligned?: (questions: AlignedQuestion[]) => void;
  onQuestionStart?: (questionNumber: string | number, index: number, total: number) => void;
  onQuestionDone?: (
    record: GradeRecord | null,
    index: number,
    total: number,
    allGraded: (GradeRecord | null)[]
  ) => void;
}

export async function runLiveEvaluation(input: LiveEvalInput): Promise<{ report: LiveReport; markdown: string }> {
  const roles = ['paper', 'key', 'student'] as const;
  const files: Record<(typeof roles)[number], File> = {
    paper: input.paper,
    key: input.key,
    student: input.student,
  };
  const isLocal =
    typeof window !== 'undefined' &&
    (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');

  // Compress in parallel across documents if needed (compressMediaIfNeeded is a no-op
  // for already-compressed JPEGs <= 450 KB and digital PDFs <= 3.5 MB).
  await Promise.all(
    roles.map(async role => {
      if (!files[role]) return;
      const res = await compressMediaIfNeeded(files[role]);
      if (res.compressed) {
        files[role] = res.file;
      }
      if (!isLocal && files[role] && files[role].size > 4_200_000) {
        const fallback = await compressMediaIfNeeded(files[role], 3_000_000);
        if (fallback.compressed) {
          files[role] = fallback.file;
        }
      }
    })
  );
  const maxBytes = isLocal ? 25_000_000 : 4_500_000;
  const oversize = Object.entries(files).find(([, f]) => f && f.size > maxBytes);
  if (oversize) {
    throw new Error(
      `"${oversize[1].name}" is ${(oversize[1].size / 1048576).toFixed(1)} MB — exceeds the ${isLocal ? '25' : '4.5'} MB upload cap even after compression.`,
    );
  }

  // Stage 1 — transcribe the three documents in parallel (one AI call each, or instant for digital PDFs).
  input.onStage?.(0);
  const extracted = await Promise.all(
    roles.map(async role => {
      const fd = new FormData();
      fd.append('file', files[role], files[role].name);
      fd.append('role', role);
      if (input.model) fd.append('model', input.model);
      const res = await api('/api/extract', { method: 'POST', body: fd }, 1);
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        role?: string;
        filename?: string;
        kind?: string;
        pages?: number;
        warnings?: string[];
        page_images?: string[];
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
  let pageImages: string[] = Array.isArray(byRole.student?.page_images) ? byRole.student.page_images : [];
  if (pageImages.length === 0 && files.student && files.student.type.startsWith('image/')) {
    try {
      pageImages = [URL.createObjectURL(files.student)];
    } catch {
      pageImages = [];
    }
  }
  if (pageImages.length > 0) {
    input.onPageImages?.(pageImages);
  }
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
  input.onQuestionsAligned?.(aligned.aligned);
  // Stage 3 — grade in batches (5 questions per LLM call, 3 batches at a time).
  const totalQuestions = aligned.aligned.length;
  const records: GradeRecord[] = new Array(totalQuestions);
  const completedRecords: (GradeRecord | null)[] = new Array(totalQuestions).fill(null);
  const rateLimiter = new RateLimiter(6, 60_000);
  const BATCH_SIZE = 5;
  const BATCH_CONCURRENCY = 3;

  const normKey = (v: unknown) => String(v ?? '').trim().toLowerCase();

  async function gradeSingle(q: AlignedQuestion, idx: number): Promise<GradeRecord | null> {
    await rateLimiter.acquire();
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const data = await apiJson<{ record: GradeRecord }>('/api/grade-one', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            question: q,
            strict: input.strict,
            penalties: input.penalties,
            marking_mode: input.marking_mode || 'standard',
            negative_marks_value: input.negative_marks_value || 0,
            model: usedModel,
          }),
        });
        records[idx] = data.record;
        completedRecords[idx] = data.record;
        input.onQuestionDone?.(data.record, idx, totalQuestions, completedRecords);
        return data.record;
      } catch (err: unknown) {
        lastErr = err;
        const msg = String((err as Error)?.message || err);
        if (msg.includes('504')) break;
        const is429 = msg.includes('429') || msg.toLowerCase().includes('rate');
        if (attempt < 2) {
          await new Promise(r => setTimeout(r, is429 ? 3000 : 1000));
          await rateLimiter.acquire();
        }
      }
    }
    // All retries exhausted — record a failed question instead of throwing,
    // so one bad question never wipes out the questions that already passed.
    const errRecord: GradeRecord = {
      number: q.number,
      question: String(q.text ?? ''),
      max_marks: Number(q.max_marks ?? 0) || 0,
      marks_awarded: 0,
      marks_deducted: 0,
      expected_answer: String(q.expected_answer ?? ''),
      student_answer: '',
      feedback: `Grading failed after retries — ${lastErr}`,
      ocr_note: 'engine error',
      deductions: [],
    };
    records[idx] = errRecord;
    input.onQuestionDone?.(null, idx, totalQuestions, completedRecords);
    return null;
  }

  async function gradeBatch(batch: AlignedQuestion[], baseIdx: number): Promise<void> {
    batch.forEach((q, i) => input.onQuestionStart?.(q.number, baseIdx + i, totalQuestions));
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await rateLimiter.acquire();
        const data = await apiJson<{ records: GradeRecord[] }>('/api/grade-batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            questions: batch,
            strict: input.strict,
            penalties: input.penalties,
            marking_mode: input.marking_mode || 'standard',
            negative_marks_value: input.negative_marks_value || 0,
            model: usedModel,
          }),
        });
        if (!Array.isArray(data.records) || data.records.length === 0) {
          throw new Error('batch returned an unexpected shape');
        }
        const byNumber = new Map<string, GradeRecord>();
        data.records.forEach(r => {
          if (r && r.number != null) byNumber.set(normKey(r.number), r);
        });
        const missing: number[] = [];
        batch.forEach((q, i) => {
          const rec = byNumber.get(normKey(q.number)) ?? data.records[i];
          if (rec) {
            records[baseIdx + i] = rec;
            completedRecords[baseIdx + i] = rec;
            input.onQuestionDone?.(rec, baseIdx + i, totalQuestions, completedRecords);
          } else {
            missing.push(i);
          }
        });
        for (const i of missing) {
          await gradeSingle(batch[i], baseIdx + i);
        }
        return;
      } catch (err: unknown) {
        const msg = String((err as Error)?.message || err);
        if (msg.includes('504')) break;
        const is429 = msg.includes('429') || msg.toLowerCase().includes('rate');
        await new Promise(r => setTimeout(r, is429 ? 3000 : 1000));
      }
    }
    // Batch failed twice — grade its questions one by one. Never throw:
    // completed questions in other batches must be preserved.
    for (let i = 0; i < batch.length; i++) {
      if (!completedRecords[baseIdx + i]) {
        await gradeSingle(batch[i], baseIdx + i);
      }
    }
  }

  // Bounded worker pool: at most BATCH_CONCURRENCY batches in flight.
  const batches: { batch: AlignedQuestion[]; baseIdx: number }[] = [];
  for (let i = 0; i < totalQuestions; i += BATCH_SIZE) {
    batches.push({ batch: aligned.aligned.slice(i, i + BATCH_SIZE), baseIdx: i });
  }
  let nextBatch = 0;
  await Promise.all(
    Array.from({ length: Math.min(BATCH_CONCURRENCY, batches.length) }, async () => {
      while (nextBatch < batches.length) {
        const job = batches[nextBatch++];
        await gradeBatch(job.batch, job.baseIdx);
      }
    }),
  );
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
      marking_mode: input.marking_mode || 'standard',
      negative_marks_value: input.negative_marks_value || 0,
      warnings: docWarnings.concat(aligned.warnings || []),
      engine: 'WHT Engine',
      model: usedModel,
    }),
  });
  input.onStage?.(5);
  if (pageImages.length > 0) {
    reportData.report.pageImages = pageImages;
  }
  return reportData;
}

export interface RecheckQuestionInput {
  question: {
    number: string | number;
    question?: string;
    max_marks: number;
    expected_answer: string;
    marking_scheme?: unknown[];
    student_answer: string;
    legibility?: string;
    uncertain_spans?: string[];
    keywords?: string[];
    page?: number;
    geometry?: CropGeometry[];
  };
  teacher_instruction: string;
  previous_record?: {
    marks_awarded: number;
    max_marks: number;
    feedback: string;
    deductions?: Deduction[];
    steps?: GradeStep[];
  };
  page_image?: string;
  strict: boolean;
  penalties: string[];
  marking_mode?: 'standard' | 'negative' | 'non_negative';
  negative_marks_value?: number;
  model?: string;
}

export async function resolvePageImageDataUrl(url?: string): Promise<string | undefined> {
  if (!url) return undefined;
  if (url.startsWith('data:image/')) return url;
  if (url.startsWith('blob:')) {
    try {
      const res = await fetch(url);
      const blob = await res.blob();
      return await new Promise<string | undefined>(resolve => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(typeof reader.result === 'string' ? reader.result : undefined);
        reader.onerror = () => resolve(undefined);
        reader.readAsDataURL(blob);
      });
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export async function recheckSingleQuestion(input: RecheckQuestionInput): Promise<GradeRecord> {
  const pageImage = await resolvePageImageDataUrl(input.page_image);
  const data = await apiJson<{ record: GradeRecord }>('/api/recheck-question', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      question: input.question,
      teacher_instruction: input.teacher_instruction,
      previous_record: input.previous_record,
      page_image: pageImage,
      strict: input.strict,
      penalties: input.penalties,
      marking_mode: input.marking_mode || 'standard',
      negative_marks_value: input.negative_marks_value || 0,
      model: input.model,
    }),
  });
  return data.record;
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
  onQuestionGenerated?: (
    question: GeneratedQuestion,
    index: number,
    total: number,
    allQuestionsSoFar: (GeneratedQuestion | null)[]
  ) => void;
}

export async function generateExam(
  input: GenerateExamInput
): Promise<{ exam: GeneratedExam; model: string; note?: string }> {
  const count = Math.max(1, input.count || 5);
  const totalMarks = input.marks || 25;
  const perQMarks = Math.round((totalMarks / count) * 10) / 10;
  const rateLimiter = new RateLimiter(6, 60_000);

  const completedQuestions: (GeneratedQuestion | null)[] = new Array(count).fill(null);
  let usedModel = input.model || DEFAULT_MODEL_ID;

  // Per-question generation: 1 request per question, so a slow model never
  // trips the host timeout and questions stream into the preview as they land.
  // Every question is written by the WHT Engine model — if a call fails we
  // surface the real error instead of inventing a placeholder question.
  const failures: string[] = [];
  const promises = Array.from({ length: count }, async (_, i) => {
    await rateLimiter.acquire();
    const qNum = `Q${i + 1}`;
    let lastErr: unknown;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const data = await apiJson<{
          ok: boolean;
          question: GeneratedQuestion;
          model: string;
          note?: string;
        }>('/api/generate-exam-question', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            topic: input.topic,
            grade: input.grade,
            difficulty: input.difficulty,
            number: qNum,
            index: i + 1,
            total: count,
            marks: perQMarks,
            model: input.model,
          }),
        });

        usedModel = data.model || usedModel;
        completedQuestions[i] = data.question;
        input.onQuestionGenerated?.(data.question, i, count, completedQuestions);
        return data.question;
      } catch (err: unknown) {
        lastErr = err;
        const msg = String((err as Error)?.message || err);
        const is429 = msg.includes('429') || msg.toLowerCase().includes('rate');
        const retryable = is429 || /502|503|504|timeout|timed out|network|fetch/i.test(msg);
        if (attempt < 1 && retryable) {
          await new Promise(r => setTimeout(r, is429 ? 3000 : 1200));
          await rateLimiter.acquire();
          continue;
        }
        break;
      }
    }
    failures.push(`${qNum}: ${String((lastErr as Error)?.message || lastErr || 'unknown error')}`);
    return null;
  });

  const settled = await Promise.all(promises);
  if (failures.length > 0) {
    throw new Error(
      failures.length === count
        ? `The WHT Engine could not write this exam. ${failures[0]}`
        : `${failures.length} of ${count} questions could not be written by the WHT Engine. ${failures[0]}`,
    );
  }

  const questions = settled as GeneratedQuestion[];
  const exam: GeneratedExam = {
    title: `${input.topic} Examination`,
    topic: input.topic,
    instructions: 'Answer all questions. Show complete working steps.',
    total_marks: totalMarks,
    questions,
  };

  return { exam, model: usedModel };
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
