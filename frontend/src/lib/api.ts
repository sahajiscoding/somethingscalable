/* Live backend client — same-origin Flask /api (split pipeline). */
import { compressMediaIfNeeded } from './mediaCompressor';

export const APP_SECRET: string = (() => {
  const v = (window as unknown as { __APP_SECRET__?: string }).__APP_SECRET__ || '';
  return v.startsWith('__VERCEL') ? '' : v;
})();

/* Default NIM id used by the server (engine.NVIDIA_DEFAULT_MODEL) — kept here
 * so preset buttons and status lines match the backend when no override is set. */
export const DEFAULT_MODEL_ID = 'nvidia/nemotron-3.5-super-vl-120b-a12b';

/* Human-readable name for a NIM model id; empty/unknown → default model name. */
export function modelLabel(id?: string): string {
  const v = (id || '').toLowerCase();
  if (v.includes('gemma-4-31b')) return 'Gemma 4 31B Vision';
  if (v.includes('gemma-3-12b') || v.includes('gemma-3-27b')) return 'Gemma 3 Vision';
  if (v.includes('llama-3.2-90b')) return 'Llama 3.2 90B Vision';
  if (v.includes('llama-3.2-11b')) return 'Llama 3.2 11B Vision';
  if (v.includes('lightning')) return 'Nemotron 3.5 Lightning';
  if (v.includes('deepseek')) return 'DeepSeek V4.1 Flash';
  if (v.includes('glm')) return 'GLM 5.3 Flash';
  if (v.includes('qwen')) return 'Qwen 3.6 35B';
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
      if ((res.status === 502 || res.status === 503 || res.status === 504) && attempt < retries) {
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
      'Connection to the grading server dropped or timed out (Failed to fetch). Ensure the backend server is running and NVIDIA_API_KEY is set, or select a faster model such as Gemma 4 31B Vision or Llama 3.2 90B Vision.'
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

/**
 * Strict Rate Limiter enforcing maximum requests in a rolling time window.
 * Default: 39 requests per 60,000 ms window (NVIDIA NIM safe limit).
 * Supports an initial burst of 39 requests.
 */
export class RateLimiter {
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private timestamps: number[] = [];

  constructor(maxRequests: number = 39, windowMs: number = 60_000) {
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
      // Window full (39 requests in last 60s). Wait until oldest request timestamp expires.
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
  model?: string;
  onStage?: (stage: number) => void;
  onQuestionsAligned?: (questions: AlignedQuestion[]) => void;
  onQuestionStart?: (questionNumber: string | number, index: number, total: number) => void;
  onQuestionDone?: (
    record: GradeRecord,
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
      const res = await api('/api/extract', { method: 'POST', body: fd }, 2);
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
  input.onQuestionsAligned?.(aligned.aligned);
  // Stage 3 — grade in batches (5 questions per LLM call, 3 batches at a time).
  const totalQuestions = aligned.aligned.length;
  const records: GradeRecord[] = new Array(totalQuestions);
  const completedRecords: (GradeRecord | null)[] = new Array(totalQuestions).fill(null);
  const rateLimiter = new RateLimiter(39, 60_000);
  const BATCH_SIZE = 5;
  const BATCH_CONCURRENCY = 3;

  const normKey = (v: unknown) => String(v ?? '').trim().toLowerCase();

  async function gradeSingle(q: AlignedQuestion, idx: number): Promise<GradeRecord> {
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
    throw lastErr;
  }

  async function gradeBatch(batch: AlignedQuestion[], baseIdx: number): Promise<void> {
    batch.forEach((q, i) => input.onQuestionStart?.(q.number, baseIdx + i, totalQuestions));
    let lastErr: unknown;
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
            model: usedModel,
          }),
        });
        if (!Array.isArray(data.records) || data.records.length === 0) {
          throw new Error('batch returned an unexpected shape');
        }
        // Tolerant matching: the model may reorder or restyle numbers, so
        // match by normalised number first and position second. Anything
        // still unmatched is graded individually below.
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
        lastErr = err;
        const msg = String((err as Error)?.message || err);
        if (msg.includes('504')) break;
        const is429 = msg.includes('429') || msg.toLowerCase().includes('rate');
        await new Promise(r => setTimeout(r, is429 ? 3000 : 1000));
      }
    }
    // Batch failed twice — grade its questions one by one so a single bad
    // batch never loses marks.
    try {
      for (let i = 0; i < batch.length; i++) {
        if (!completedRecords[baseIdx + i]) {
          await gradeSingle(batch[i], baseIdx + i);
        }
      }
    } catch (err: unknown) {
      throw lastErr ?? err;
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
  const rateLimiter = new RateLimiter(39, 60_000);

  const completedQuestions: (GeneratedQuestion | null)[] = new Array(count).fill(null);
  let usedModel = input.model || DEFAULT_MODEL_ID;
  let note: string | undefined;

  // Per-question generation: 1 request per question, bypassing timeouts.
  // Up to 39 requests dispatched concurrently at once (39 RPM limit).
  // Streams question output immediately upon response.
  const promises = Array.from({ length: count }, async (_, i) => {
    await rateLimiter.acquire();
    const qNum = `Q${i + 1}`;
    let attempts = 0;

    while (attempts < 2) {
      try {
        attempts++;
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
        if (data.note) note = data.note;

        completedQuestions[i] = data.question;
        input.onQuestionGenerated?.(data.question, i, count, completedQuestions);
        return data.question;
      } catch (err: any) {
        const msg = String(err?.message || err);
        const is429 = msg.includes('429') || msg.toLowerCase().includes('rate');
        if (msg.includes('504')) {
          break;
        }
        if (attempts < 2) {
          await new Promise(r => setTimeout(r, is429 ? 3000 : 1000));
          await rateLimiter.acquire();
        }
      }
    }
    const fallbackQ: GeneratedQuestion = {
      number: qNum,
      text: `Analyze the core principles and primary mechanisms of ${input.topic} (Question ${i + 1} of ${count}) for ${input.grade}. Explain the complete step-by-step working and critical concepts.`,
      max_marks: perQMarks,
      expected_answer: `Complete targeted explanation and step-by-step solution for ${input.topic} question ${i + 1}.`,
      marking_scheme: `Concepts & definitions: ${Math.round(perQMarks * 0.4 * 10) / 10}m; Explanations & steps: ${Math.round(perQMarks * 0.4 * 10) / 10}m; Final solution: ${Math.round(perQMarks * 0.2 * 10) / 10}m.`,
      keywords: [input.topic.split(' ')[0].toLowerCase(), 'solution'],
    };
    completedQuestions[i] = fallbackQ;
    input.onQuestionGenerated?.(fallbackQ, i, count, completedQuestions);
    note = 'Generated with backup syllabus template due to temporary NIM latency.';
    return fallbackQ;
  });

  const questions = await Promise.all(promises);

  const exam: GeneratedExam = {
    title: `${input.topic} Examination`,
    topic: input.topic,
    instructions: 'Answer all questions. Show complete working steps.',
    total_marks: totalMarks,
    questions,
  };

  return { exam, model: usedModel, note };
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
