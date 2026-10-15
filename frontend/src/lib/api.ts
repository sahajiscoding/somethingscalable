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

  for (const role of roles) {
    if (files[role] && files[role].size > 3_500_000) {
      const res = await compressMediaIfNeeded(files[role]);
      if (res.compressed) {
        files[role] = res.file;
      }
      // If still oversize on hosted Vercel, attempt aggressive pass targeted for multi-page documents
      if (!isLocal && files[role] && files[role].size > 4_200_000) {
        const fallback = await compressMediaIfNeeded(files[role], 3_000_000);
        if (fallback.compressed) {
          files[role] = fallback.file;
        }
      }
    }
  }
  const maxBytes = isLocal ? 25_000_000 : 4_500_000;
  const oversize = Object.entries(files).find(([, f]) => f && f.size > maxBytes);
  if (oversize) {
    throw new Error(
      `"${oversize[1].name}" is ${(oversize[1].size / 1048576).toFixed(1)} MB — exceeds the ${isLocal ? '25' : '4.5'} MB upload cap even after compression.`,
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
  input.onQuestionsAligned?.(aligned.aligned);

  // Stage 3 — grade one question per call (short enough for capped hosts, bypasses Vercel 60s timeout).
  // Strictly rate-limited to 39 requests per minute.
  // Initial burst allows 39 questions to start concurrently; subsequent questions wait for 60s rolling window.
  // As each question request returns from the server, its output is streamed immediately.
  const totalQuestions = aligned.aligned.length;
  const records: GradeRecord[] = new Array(totalQuestions);
  const completedRecords: (GradeRecord | null)[] = new Array(totalQuestions).fill(null);
  const rateLimiter = new RateLimiter(39, 60_000);

  const gradingPromises = aligned.aligned.map(async (q, idx) => {
    await rateLimiter.acquire();
    input.onQuestionStart?.(q.number, idx, totalQuestions);

    let attempts = 0;
    let lastErr: unknown;
    while (attempts < 3) {
      try {
        attempts++;
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
      } catch (err: any) {
        lastErr = err;
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
    throw lastErr;
  });

  await Promise.all(gradingPromises);
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
  let usedModel = input.model || 'z-ai/glm-5.3-flash';
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
