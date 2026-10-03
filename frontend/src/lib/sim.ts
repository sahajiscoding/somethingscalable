/* Offline demo engine — sample dataset + scoring (mirrors the legacy page). */

export const fmt = (n: number): string =>
  Math.round(n * 10) % 10 === 0 ? String(Math.round(n)) : n.toFixed(1);

export interface Criterion {
  key: string;
  label: string;
  color: string;
}

export const CRITERIA: Record<string, Criterion> = {
  handwriting: { key: 'handwriting', label: 'Bad Handwriting', color: 'var(--color-sand)' },
  diagrams: { key: 'diagrams', label: 'Flawed / Bad Diagrams', color: 'var(--color-lilac)' },
  unreadable: { key: 'unreadable', label: 'Unreadable / Smudged Data', color: 'var(--color-crimson)' },
  formatting: { key: 'formatting', label: 'Poor Formatting / Missing Steps', color: 'var(--color-mist)' },
};

export interface DemoQuestion {
  no: string;
  total: number;
  target: string;
  student: string;
  contentLoss: number;
  strictLoss: number;
  contentReason: string;
  penalties: Record<string, { amount: number; note: string }>;
  fullNote: string;
}

export const QUESTIONS: DemoQuestion[] = [
  {
    no: 'Q1',
    total: 5,
    target: 'x = (−b ± √(b² − 4ac)) / 2a, with discriminant b² − 4ac evaluated to 49, giving roots x = 5 and x = −2.',
    student: 'x = (−b ± √(b² − 4ac)) / 2a written correctly; discriminant left unevaluated and final roots not stated.',
    contentLoss: 1.5,
    strictLoss: 0.5,
    contentReason: 'the discriminant was never evaluated and the final roots were not stated',
    penalties: {
      handwriting: { amount: 0.5, note: 'handwriting penalties were applied' },
      formatting: { amount: 0.5, note: 'intermediate working steps were missing from the solution' },
    },
    fullNote: 'formula, discriminant and both roots match the official key',
  },
  {
    no: 'Q2',
    total: 6,
    target: "Explanation of Lenz's law (4 marks) plus a fully labelled diagram showing induced current opposing the flux change (2 marks).",
    student: 'Correct verbal explanation of the opposing flux change, but the diagram has no current-direction arrows and only one coil turn is shown.',
    contentLoss: 1.0,
    strictLoss: 0.5,
    contentReason: 'the induced-current direction was never annotated on the diagram',
    penalties: {
      diagrams: { amount: 1.5, note: 'the diagram was incomplete and marked flawed' },
      handwriting: { amount: 0.5, note: 'handwriting penalties were applied' },
    },
    fullNote: 'explanation and diagram both meet the rubric',
  },
  {
    no: 'Q3',
    total: 4,
    target: 'The Treaty of Versailles was signed on 28 June 1919, ending the First World War between the Allied Powers and Germany.',
    student: 'Signed on 28 June 1919; ended the First World War between the Allied Powers and Germany.',
    contentLoss: 0,
    strictLoss: 0,
    contentReason: '',
    penalties: {},
    fullNote: 'response matches the official answer key exactly — no corrections required',
  },
  {
    no: 'Q4',
    total: 5,
    target: 'n = 0.25 mol; limiting reagent NaOH; theoretical yield = 11.0 g.',
    student: 'n ≈ 0.2? mol (figure smudged), limiting reagent NaOH, calculated yield 9.8 g.',
    contentLoss: 1.5,
    strictLoss: 0.5,
    contentReason: 'the mole calculation started from an incorrect value, giving 9.8 g instead of 11.0 g',
    penalties: {
      unreadable: { amount: 1.0, note: 'the input data was smudged and treated as unreadable' },
      handwriting: { amount: 0.5, note: 'handwriting penalties were applied' },
    },
    fullNote: 'limiting reagent and yield both correct',
  },
  {
    no: 'Q5',
    total: 5,
    target: 'Structured response: claim → evidence → reasoning → conclusion, with each step of the argument shown in order.',
    student: 'Conclusion present, but evidence is never linked back to the claim and the working steps are skipped; ideas jump between paragraphs.',
    contentLoss: 2.0,
    strictLoss: 0.5,
    contentReason: 'the reasoning chain was incomplete: evidence was not linked back to the claim',
    penalties: {
      formatting: { amount: 1.0, note: 'poor formatting and missing steps were penalised' },
      handwriting: { amount: 0.5, note: 'handwriting penalties were applied' },
    },
    fullNote: 'structure and reasoning chain fully developed',
  },
];

export interface DemoRow {
  q: DemoQuestion;
  content: number;
  strict: number;
  crit: Record<string, number>;
  critTotal: number;
  deducted: number;
  awarded: number;
}

export interface DemoEval {
  rows: DemoRow[];
  total: number;
  awarded: number;
  deducted: number;
  contentSum: number;
  strictSum: number;
  impact: Record<string, number>;
}

export function evaluateDemo(strict: boolean, criteria: Record<string, boolean>): DemoEval {
  const rows: DemoRow[] = QUESTIONS.map(q => {
    const content = q.contentLoss;
    const strictLoss = strict ? q.strictLoss : 0;
    const crit: Record<string, number> = {};
    let critTotal = 0;
    Object.keys(criteria).forEach(k => {
      if (criteria[k] && q.penalties[k]) {
        crit[k] = q.penalties[k].amount;
        critTotal += q.penalties[k].amount;
      }
    });
    const deducted = Math.min(q.total, content + strictLoss + critTotal);
    return { q, content, strict: strictLoss, crit, critTotal, deducted, awarded: Math.max(0, q.total - deducted) };
  });

  const total = rows.reduce((s, r) => s + r.q.total, 0);
  const awarded = rows.reduce((s, r) => s + r.awarded, 0);
  const deducted = total - awarded;
  const contentSum = rows.reduce((s, r) => s + r.content, 0);
  const strictSum = rows.reduce((s, r) => s + r.strict, 0);

  const impact: Record<string, number> = {};
  Object.keys(criteria).forEach(k => {
    if (!criteria[k]) return;
    const sum = rows.reduce((s, r) => s + (r.crit[k] || 0), 0);
    if (sum > 0) impact[k] = sum;
  });

  return { rows, total, awarded, deducted, contentSum, strictSum, impact };
}

export function gradeLetter(pct: number): string {
  if (pct >= 90) return 'A';
  if (pct >= 80) return 'B';
  if (pct >= 70) return 'C';
  if (pct >= 60) return 'D';
  return 'F';
}

/* ---------------- Analytics ---------------- */

export interface AnalyticsState {
  count: number;
  pctSum: number;
  pass: number;
  deducted: number;
  hw: number;
  dg: number;
  fm: number;
  ur: number;
}

export const EMPTY_ANALYTICS: AnalyticsState = {
  count: 0,
  pctSum: 0,
  pass: 0,
  deducted: 0,
  hw: 0,
  dg: 0,
  fm: 0,
  ur: 0,
};

export function recordInto(prev: AnalyticsState, awarded: number, total: number, impact: Record<string, number>): AnalyticsState {
  const pct = total ? (awarded / total) * 100 : 0;
  const hw = impact.handwriting || 0;
  const dg = impact.diagrams || 0;
  const fm = impact.formatting || 0;
  const ur = impact.unreadable || 0;
  return {
    count: prev.count + 1,
    pctSum: prev.pctSum + pct,
    pass: prev.pass + (pct >= 60 ? 1 : 0),
    deducted: prev.deducted + (total - awarded),
    hw: prev.hw + hw,
    dg: prev.dg + dg,
    fm: prev.fm + fm,
    ur: prev.ur + ur,
  };
}

/* ---------------- Shared files state ---------------- */

export interface DocFiles {
  paper: File | null;
  key: File | null;
  sheet: File | null;
}

export const EMPTY_FILES: DocFiles = { paper: null, key: null, sheet: null };

export type CriteriaState = Record<string, boolean>;

export const EMPTY_CRITERIA: CriteriaState = {
  handwriting: false,
  diagrams: false,
  unreadable: false,
  formatting: false,
};
