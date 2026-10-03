const CRITERIA = [
  {
    badge: 'Criteria 01',
    badgeCls: 'border-sand/40 bg-sand/15 text-sand',
    t: 'Bad Handwriting',
    d: 'Applied when handwriting is cramped, erratic, or difficult to parse, slowing evaluation.',
    r1: 'Deduction range:',
    r1v: ' −0.5 to −2.0 marks.',
    r2: 'OCR Noise Guarantee:',
    r2v: ' Recognition artefacts are never penalized against the student.',
  },
  {
    badge: 'Criteria 02',
    badgeCls: 'border-lilac/40 bg-lilac/15 text-lilac',
    t: 'Flawed / Bad Diagrams',
    d: 'Applies to ray optics, circuit diagrams, geometric proofs, and free-body figures lacking required labels or arrows.',
    r1: 'Deduction range:',
    r1v: ' −1.0 to −3.0 marks.',
    r2: 'Rule:',
    r2v: " Diagram must match the rubric's required components and annotations.",
  },
  {
    badge: 'Criteria 03',
    badgeCls: 'border-crimson/40 bg-crimson/15 text-crimson',
    t: 'Unreadable / Smudged Data',
    d: 'Applies when critical intermediate data (e.g. numerical constants, signs, indices) are smudged or scribbled over.',
    r1: 'Deduction range:',
    r1v: ' −1.0 to −2.0 marks.',
    r2: 'Rule:',
    r2v: " Only penalizes if ambiguity obscures the student's mathematical logic.",
  },
  {
    badge: 'Criteria 04',
    badgeCls: 'border-mist/40 bg-mist/15 text-mist',
    t: 'Poor Formatting / Missing Steps',
    d: 'Applies when a student skips mandatory working steps or presents disconnected equations.',
    r1: 'Deduction range:',
    r1v: ' −0.5 to −1.5 marks.',
    r2: 'Rule:',
    r2v: ' Step marks awarded proportionally according to the official marking scheme.',
  },
];

export default function Rubrics() {
  return (
    <div className="rounded-2xl border border-white/10 bg-canvas p-5 shadow-[0_20px_44px_rgba(0,0,0,.32)] md:p-7">
      <div className="mb-5">
        <div className="mb-1 text-[11px] font-bold tracking-[.18em] text-white/45 uppercase">Scoring Reference</div>
        <h2 className="text-[19px] font-bold tracking-tight">Rubric Studio &amp; Penalty Architecture</h2>
        <p className="mt-1 max-w-[52ch] text-[13.5px] text-white/45">
          Understand how Kimi-K3 applies step marks, keyword checkpoints, and optional penalty criteria.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {CRITERIA.map(c => (
          <div key={c.t} className="rounded-xl border border-white/10 bg-black/15 p-5">
            <span className={`mb-3 inline-block rounded-md border px-2.5 py-0.5 text-[11px] font-bold ${c.badgeCls}`}>
              {c.badge}
            </span>
            <h4 className="mb-1.5 text-base font-bold">{c.t}</h4>
            <p className="mb-3.5 text-[13px] leading-relaxed text-white/70">{c.d}</p>
            <div className="rounded-lg bg-black/20 p-2.5 text-xs leading-relaxed text-white/45">
              <b className="text-white/70">{c.r1}</b>
              {c.r1v}
              <br />
              <b className="text-white/70">{c.r2}</b>
              {c.r2v}
            </div>
          </div>
        ))}
      </div>

      <div className="my-5 h-px bg-white/10" />

      <div className="mb-3">
        <div className="mb-1 text-[11px] font-bold tracking-[.18em] text-white/45 uppercase">Interactive Sandbox</div>
        <h3 className="text-[17px] font-bold">Sample Rubric &amp; Step Mark Breakdown</h3>
        <p className="mt-1 text-[13.5px] text-white/45">How a 5-mark question is evaluated across step schemes.</p>
      </div>

      <div className="rounded-xl border border-white/10 bg-black/20 p-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2.5">
          <span className="font-bold text-mint">Q1: Solve x² − 3x − 10 = 0 (5 Marks)</span>
          <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-white/70">
            Standard Step Breakdown
          </span>
        </div>
        <div className="space-y-2 text-[13.5px] leading-relaxed text-white/70">
          <div className="rounded-lg bg-black/20 px-3 py-2">
            <b>Step 1 (Formula Identification, 1.5 marks):</b> Statement of quadratic formula{' '}
            <code>x = (-b ± √(b² - 4ac)) / 2a</code>.
          </div>
          <div className="rounded-lg bg-black/20 px-3 py-2">
            <b>Step 2 (Discriminant Evaluation, 1.5 marks):</b> Correct calculation of{' '}
            <code>Δ = (-3)² - 4(1)(-10) = 49</code>.
          </div>
          <div className="rounded-lg bg-black/20 px-3 py-2">
            <b>Step 3 (Square Root &amp; Substitution, 1.0 mark):</b> <code>√49 = 7</code>, yielding{' '}
            <code>x = (3 ± 7) / 2</code>.
          </div>
          <div className="rounded-lg bg-black/20 px-3 py-2">
            <b>Step 4 (Final Roots, 1.0 mark):</b> Both roots explicitly stated: <code>x = 5</code> and{' '}
            <code>x = -2</code>.
          </div>
        </div>
      </div>
    </div>
  );
}
