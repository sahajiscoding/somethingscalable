/* Offline demo engine — sample dataset + realistic handwritten math pages & step annotations. */
import type { CropGeometry, GradeStep } from './api';

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
  questionText: string;
  total: number;
  page: number;
  target: string;
  student: string;
  contentLoss: number;
  strictLoss: number;
  contentReason: string;
  penalties: Record<string, { amount: number; note: string }>;
  fullNote: string;
  geometry: CropGeometry[];
  steps: GradeStep[];
}

function svgToDataUrl(svg: string): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg.trim())}`;
}

const PAGE_1_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 1040" width="800" height="1040">
  <defs>
    <linearGradient id="paperGrad1" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#c9c6be"/>
      <stop offset="50%" stop-color="#bebbb3"/>
      <stop offset="100%" stop-color="#b2afa7"/>
    </linearGradient>
    <filter id="paperShadow1" x="-5%" y="-5%" width="110%" height="110%">
      <feDropShadow dx="0" dy="6" stdDeviation="10" flood-color="#000" flood-opacity="0.45"/>
    </filter>
  </defs>
  <!-- Desk background -->
  <rect width="800" height="1040" fill="#2c2623"/>
  <!-- Notebook page -->
  <rect x="68" y="24" width="664" height="992" rx="4" fill="url(#paperGrad1)" filter="url(#paperShadow1)"/>
  <!-- Subtle ruled lines -->
  <g stroke="#a5a29a" stroke-width="1" opacity="0.45">
    <line x1="90" y1="120" x2="710" y2="120"/>
    <line x1="90" y1="170" x2="710" y2="170"/>
    <line x1="90" y1="220" x2="710" y2="220"/>
    <line x1="90" y1="270" x2="710" y2="270"/>
    <line x1="90" y1="320" x2="710" y2="320"/>
    <line x1="90" y1="370" x2="710" y2="370"/>
    <line x1="90" y1="420" x2="710" y2="420"/>
    <line x1="90" y1="470" x2="710" y2="470"/>
  </g>
  <line x1="138" y1="24" x2="138" y2="1016" stroke="#9e7b7b" stroke-width="1.5" opacity="0.45"/>
  <!-- Handwritten Q1 -->
  <g fill="#424347" font-family="'Segoe Print', 'Bradley Hand', 'Comic Sans MS', cursive" font-size="22">
    <text x="95" y="92" font-size="16" opacity="0.75">Page 1 · Class 10 Mathematics — Polynomials</text>
    <text x="96" y="162" font-weight="bold">Q1</text>
    <path d="M 92 170 Q 115 165 130 150" stroke="#424347" stroke-width="1.6" fill="none"/>
    <text x="160" y="162">Find the degree and zeroes of p(x) = x² - 5x + 6</text>
    <text x="165" y="214">Highest power of x is 2, so degree = 2</text>
    <text x="165" y="264">x² - 5x + 6 = (x - 2)(x - 3) = 0</text>
    <text x="165" y="314">Therefore, zeroes are x = 2 and x = 3.</text>
  </g>
</svg>
`;

const PAGE_2_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 1040" width="800" height="1040">
  <defs>
    <linearGradient id="paperGrad2" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#c9c6be"/>
      <stop offset="55%" stop-color="#bcb9b1"/>
      <stop offset="100%" stop-color="#afa9a0"/>
    </linearGradient>
    <filter id="paperShadow2" x="-5%" y="-5%" width="110%" height="110%">
      <feDropShadow dx="0" dy="6" stdDeviation="10" flood-color="#000" flood-opacity="0.48"/>
    </filter>
  </defs>
  <!-- Desk background -->
  <rect width="800" height="1040" fill="#2c2623"/>
  <!-- Left desk floral/cloth texture hint -->
  <circle cx="32" cy="445" r="24" fill="#8e8279" opacity="0.35"/>
  <!-- Scanned paper sheet -->
  <rect x="92" y="18" width="628" height="1004" rx="3" fill="url(#paperGrad2)" filter="url(#paperShadow2)"/>
  <!-- Handwritten script matching screenshot -->
  <g fill="#46474b" font-family="'Segoe Print', 'Bradley Hand', 'Comic Sans MS', cursive" font-size="22">
    <!-- Top crossed-out scratch -->
    <text x="150" y="64" font-size="18" opacity="0.65">Q2 ans</text>
    <line x1="145" y1="58" x2="212" y2="54" stroke="#46474b" stroke-width="2"/>
    <line x1="145" y1="64" x2="210" y2="60" stroke="#46474b" stroke-width="1.8"/>

    <!-- Q2 -->
    <text x="145" y="122">Q2</text>
    <path d="M 136 136 Q 168 126 194 106" stroke="#46474b" stroke-width="1.6" fill="none"/>
    <text x="220" y="118" font-size="24">5 x³ + 2x - 7</text>
    <text x="224" y="176" font-size="19">Constant is negative (-7)</text>
    <text x="220" y="232" font-size="20">Polynomials should have only positive terms</text>
    <text x="220" y="274" font-size="20">It is not a polynomial</text>

    <!-- Q3 -->
    <text x="145" y="388">Q3</text>
    <path d="M 136 404 Q 168 392 192 374" stroke="#46474b" stroke-width="1.6" fill="none"/>
    <text x="222" y="384" font-size="23">p(x) = x² - 4</text>
    <text x="234" y="428" font-size="22">x = 2</text>
    <text x="224" y="476" font-size="23">p(2) = 2² - 4</text>
    <text x="266" y="528" font-size="24">= 22 - 4</text>
    <text x="266" y="574" font-size="24">= 18</text>
    <text x="230" y="622" font-size="23">p(2) = 0  ≠  18</text>
    <text x="232" y="682" font-size="21">hence x = 2 not a zero of p(x)</text>

    <!-- Q4 -->
    <text x="145" y="760">Q4</text>
    <path d="M 136 778 Q 168 764 192 744" stroke="#46474b" stroke-width="1.6" fill="none"/>
    <text x="218" y="756" font-size="23">x² - 9 = 0</text>
    <text x="222" y="798" font-size="22">x² = 9</text>
    <text x="222" y="844" font-size="23">x = √9</text>
    <text x="242" y="894" font-size="23">=  3</text>
    <text x="226" y="948" font-size="23">zero is  x = 3</text>
  </g>
</svg>
`;

export const DEMO_PAGE_IMAGES: string[] = [
  svgToDataUrl(PAGE_1_SVG),
  svgToDataUrl(PAGE_2_SVG),
];

export const QUESTIONS: DemoQuestion[] = [
  {
    no: 'Q1',
    questionText: 'Find the degree and zeroes of the quadratic polynomial p(x) = x^2 - 5x + 6.',
    total: 3,
    page: 1,
    target: 'Degree = 2; factorising p(x) = (x - 2)(x - 3) = 0 gives zeroes x = 2 and x = 3.',
    student: 'Highest power of x is 2, so degree = 2\nx^2 - 5x + 6 = (x - 2)(x - 3) = 0\nTherefore, zeroes are x = 2 and x = 3.',
    contentLoss: 0,
    strictLoss: 0,
    contentReason: '',
    penalties: {},
    fullNote: 'Degree and both zeroes of p(x) are stated with complete factorisation steps',
    geometry: [
      { crop_id: 'p1c1', page: 1, rect: [0.20, 0.185, 0.50, 0.042], latex: 'Highest power of x is 2, so degree = 2', confidence: 0.97 },
      { crop_id: 'p1c2', page: 1, rect: [0.20, 0.233, 0.45, 0.042], latex: 'x^2 - 5x + 6 = (x - 2)(x - 3) = 0', confidence: 0.96 },
      { crop_id: 'p1c3', page: 1, rect: [0.20, 0.281, 0.46, 0.042], latex: 'Therefore, zeroes are x = 2 and x = 3.', confidence: 0.98 },
    ],
    steps: [
      {
        title: 'Step 1: Identify degree of polynomial',
        status: 'correct',
        lines: [{ crop_id: 'p1c1', text: 'degree = 2 (highest power of x)', ok: true, error_tag: '' }],
        explanation: '',
      },
      {
        title: 'Step 2: Factorise and solve for zeroes',
        status: 'correct',
        lines: [
          { crop_id: 'p1c2', text: '(x - 2)(x - 3) = 0', ok: true, error_tag: '' },
          { crop_id: 'p1c3', text: 'Zeroes are x = 2 and x = 3', ok: true, error_tag: '' },
        ],
        explanation: '',
      },
    ],
  },
  {
    no: 'Q2',
    questionText: 'State whether 5x^3 + 2x - 7 is a polynomial. Justify your answer.',
    total: 2,
    page: 2,
    target: 'Yes, 5x^3 + 2x - 7 is a polynomial because all variable exponents (3, 1, 0) are non-negative integers. Negative coefficients/constants are allowed.',
    student: '5x^3 + 2x - 7\nConstant is negative (-7)\nPolynomials should have only positive terms\nIt is not a polynomial',
    contentLoss: 2,
    strictLoss: 0,
    contentReason: 'misidentified a polynomial as invalid due to a negative constant term (-7)',
    penalties: {
      handwriting: { amount: 0.5, note: 'minor scratch-out at the top of the solution' },
    },
    fullNote: 'correctly identifies polynomial criteria',
    geometry: [
      { crop_id: 'p2c1', page: 2, rect: [0.275, 0.148, 0.275, 0.036], latex: 'Constant is negative (-7)', confidence: 0.93 },
      { crop_id: 'p2c2', page: 2, rect: [0.270, 0.202, 0.500, 0.038], latex: 'Polynomials should have only positive terms', confidence: 0.91 },
      { crop_id: 'p2c3', page: 2, rect: [0.270, 0.244, 0.300, 0.036], latex: 'It is not a polynomial', confidence: 0.94 },
    ],
    steps: [
      {
        title: 'Step 1: Check polynomial definition',
        status: 'error',
        lines: [
          { crop_id: 'p2c1', text: 'Constant is negative (-7)', ok: false, error_tag: 'Concept Error' },
          { crop_id: 'p2c2', text: 'Polynomials should have only positive terms', ok: false, error_tag: '' },
        ],
        explanation: 'Conceptual misconception: polynomial terms only require non-negative integer exponents on variables; negative coefficients or constants (-7) are completely valid.',
      },
      {
        title: 'Step 2: Final classification',
        status: 'error',
        lines: [
          { crop_id: 'p2c3', text: 'It is not a polynomial', ok: false, error_tag: '' },
        ],
        explanation: 'Incorrect conclusion: 5x^3 + 2x - 7 is a cubic polynomial.',
      },
    ],
  },
  {
    no: 'Q3',
    questionText: 'Check whether x=2 is a zero of p(x) = x^2 - 4',
    total: 3,
    page: 2,
    target: 'Substitute x = 2: p(2) = 2^2 - 4 = 4 - 4 = 0. Since p(2) = 0, x = 2 is a zero of p(x).',
    student: 'p(x) = x^2 - 4\nx = 2\np(2) = 2^2 - 4\n= 22 - 4\n= 18\np(2) = 18 != 0\nhence x = 2 not a zero of p(x)',
    contentLoss: 2,
    strictLoss: 0.5,
    contentReason: 'arithmetic error evaluating 2^2 as 22 instead of 4, which led to the wrong conclusion',
    penalties: {
      formatting: { amount: 0.5, note: 'intermediate substitution notation was cramped' },
    },
    fullNote: 'substitution, evaluation and zero check are all accurate',
    geometry: [
      { crop_id: 'p2c4', page: 2, rect: [0.275, 0.432, 0.195, 0.040], latex: 'p(2) = 2^2 - 4', confidence: 0.96 },
      { crop_id: 'p2c5', page: 2, rect: [0.326, 0.483, 0.115, 0.042], latex: '= 22 - 4', confidence: 0.94 },
      { crop_id: 'p2c6', page: 2, rect: [0.326, 0.531, 0.088, 0.038], latex: '= 18', confidence: 0.95 },
      { crop_id: 'p2c7', page: 2, rect: [0.340, 0.578, 0.036, 0.034], latex: 'p(2) = 18 != 0', confidence: 0.89 },
      { crop_id: 'p2c8', page: 2, rect: [0.285, 0.635, 0.370, 0.040], latex: 'hence x=2 not a zero', confidence: 0.92 },
    ],
    steps: [
      {
        title: 'Step 1: Substitute x=2',
        status: 'correct',
        lines: [
          { crop_id: 'p2c4', text: 'p(2) = 2^2 - 4', ok: true, error_tag: '' },
        ],
        explanation: '',
      },
      {
        title: 'Step 2: Calculate value',
        status: 'error',
        lines: [
          { crop_id: 'p2c5', text: '= 22 - 4', ok: false, error_tag: 'Calculation Error' },
          { crop_id: 'p2c6', text: '= 18', ok: false, error_tag: '' },
        ],
        explanation: 'Arithmetic error: calculated 2^2 as 22.',
      },
      {
        title: 'Step 3: Conclusion',
        status: 'error',
        lines: [
          { crop_id: 'p2c7', text: 'p(2) = 18 != 0', ok: false, error_tag: 'Result Error' },
          { crop_id: 'p2c8', text: 'hence x=2 not a zero', ok: false, error_tag: '' },
        ],
        explanation: 'Conclusion is incorrect because the calculation was wrong.',
      },
    ],
  },
  {
    no: 'Q4',
    questionText: 'Find all real zeroes of the polynomial x^2 - 9 = 0.',
    total: 2,
    page: 2,
    target: 'x^2 = 9 => x = ±√9 => x = 3 and x = -3.',
    student: 'x^2 - 9 = 0\nx^2 = 9\nx = √9\n= 3\nzero is x = 3',
    contentLoss: 1,
    strictLoss: 0.5,
    contentReason: 'took only the positive square root (x = 3) and omitted the negative root (x = -3)',
    penalties: {
      formatting: { amount: 0.5, note: 'missing ± sign when taking square root on both sides' },
    },
    fullNote: 'both positive and negative roots stated',
    geometry: [
      { crop_id: 'p2c9', page: 2, rect: [0.272, 0.742, 0.140, 0.068], latex: 'x^2 = 9; x = \\sqrt{9}', confidence: 0.95 },
      { crop_id: 'p2c10', page: 2, rect: [0.326, 0.838, 0.030, 0.036], latex: '= 3', confidence: 0.93 },
      { crop_id: 'p2c11', page: 2, rect: [0.280, 0.892, 0.195, 0.038], latex: 'zero is x = 3', confidence: 0.94 },
    ],
    steps: [
      {
        title: 'Step 1: Isolate x^2 and take square root',
        status: 'correct',
        lines: [
          { crop_id: 'p2c9', text: 'x^2 = 9  =>  x = √9', ok: true, error_tag: '' },
        ],
        explanation: '',
      },
      {
        title: 'Step 2: State all roots',
        status: 'error',
        lines: [
          { crop_id: 'p2c10', text: '= 3', ok: false, error_tag: 'Missing Root' },
          { crop_id: 'p2c11', text: 'zero is x = 3', ok: false, error_tag: '' },
        ],
        explanation: 'Missing negative root: x^2 = 9 has two solutions, x = +3 and x = -3.',
      },
    ],
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
  pageImages: string[];
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

  return { rows, total, awarded, deducted, contentSum, strictSum, impact, pageImages: DEMO_PAGE_IMAGES };
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
