import { fmt, type AnalyticsState } from '../lib/sim';

interface AnalyticsProps {
  a: AnalyticsState;
  onReset: () => void;
}

function Bar({ label, value, pct, color }: { label: string; value: string; pct: number; color: string }) {
  return (
    <div className="mb-3.5">
      <div className="mb-1 flex justify-between text-xs font-semibold">
        <span>{label}</span>
        <span>{value}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-black/30">
        <div className="h-full rounded-full transition-[width]" style={{ width: `${Math.max(0, Math.min(100, pct))}%`, background: color }} />
      </div>
    </div>
  );
}

export default function Analytics({ a, onReset }: AnalyticsProps) {
  const avg = a.count ? a.pctSum / a.count : 0;
  const pass = a.count ? Math.round((a.pass / a.count) * 100) : 0;
  return (
    <div className="rounded-2xl border border-white/10 bg-canvas p-5 shadow-[0_20px_44px_rgba(0,0,0,.32)] md:p-7">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3.5">
        <div>
          <div className="mb-1 text-[11px] font-bold tracking-[.18em] text-white/45 uppercase">Class Insights</div>
          <h2 className="text-[19px] font-bold tracking-tight">Evaluation Performance &amp; Analytics</h2>
          <p className="mt-1 max-w-[52ch] text-[13.5px] text-white/45">
            Real-time analytics aggregated across all graded answer scripts.
          </p>
        </div>
        <button
          type="button"
          onClick={onReset}
          className="inline-flex cursor-pointer items-center gap-2 rounded-[13px] border border-white/20 bg-white/5 px-4 py-2.5 text-[14.5px] font-semibold text-white transition hover:bg-white/10"
        >
          ↺ Reset Stats
        </button>
      </div>

      <div className="mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-xl border border-white/10 bg-black/20 p-4">
          <div className="text-xs tracking-[.08em] text-white/45 uppercase">Exams Evaluated</div>
          <div className="mt-1.5 text-[32px] leading-none font-extrabold tracking-tight">{a.count}</div>
          <div className="mt-1 text-xs text-white/70">Total student submissions</div>
        </div>
        <div className="rounded-xl border border-white/10 bg-black/20 p-4">
          <div className="text-xs tracking-[.08em] text-white/45 uppercase">Average Score</div>
          <div className="mt-1.5 text-[32px] leading-none font-extrabold tracking-tight text-mint">
            {a.count ? `${avg.toFixed(1)}%` : '—'}
          </div>
          <div className="mt-1 text-xs text-white/70">Mean marks obtained</div>
        </div>
        <div className="rounded-xl border border-white/10 bg-black/20 p-4">
          <div className="text-xs tracking-[.08em] text-white/45 uppercase">Pass Rate (≥60%)</div>
          <div className="mt-1.5 text-[32px] leading-none font-extrabold tracking-tight text-mint">
            {a.count ? `${pass}%` : '—'}
          </div>
          <div className="mt-1 text-xs text-white/70">Class pass percentage</div>
        </div>
        <div className="rounded-xl border border-white/10 bg-black/20 p-4">
          <div className="text-xs tracking-[.08em] text-white/45 uppercase">Total Deductions</div>
          <div className="mt-1.5 text-[32px] leading-none font-extrabold tracking-tight text-crimson">
            {fmt(a.deducted)} pts
          </div>
          <div className="mt-1 text-xs text-white/70">Content + penalty points</div>
        </div>
      </div>

      <div className="grid gap-5 md:grid-cols-2">
        <div className="rounded-xl border border-white/10 bg-black/15 p-5">
          <h4 className="mb-3.5 text-[15px] font-bold">Penalty Category Impact</h4>
          <Bar label="Bad Handwriting" value={`${fmt(a.hw)} pts`} pct={a.deducted ? (a.hw / a.deducted) * 100 : 0} color="var(--color-sand)" />
          <Bar label="Flawed Diagrams" value={`${fmt(a.dg)} pts`} pct={a.deducted ? (a.dg / a.deducted) * 100 : 0} color="var(--color-lilac)" />
          <Bar label="Formatting / Missing Steps" value={`${fmt(a.fm)} pts`} pct={a.deducted ? (a.fm / a.deducted) * 100 : 0} color="var(--color-mist)" />
          <Bar label="Unreadable Data" value={`${fmt(a.ur)} pts`} pct={a.deducted ? (a.ur / a.deducted) * 100 : 0} color="var(--color-crimson)" />
        </div>
        <div className="rounded-xl border border-white/10 bg-black/15 p-5">
          <h4 className="mb-3.5 text-[15px] font-bold">Grade Distribution</h4>
          {a.count === 0 ? (
            <p className="text-[13px] text-white/45">No evaluations yet — grade a paper to populate this chart.</p>
          ) : (
            <p className="text-[13px] text-white/70">
              {a.count} paper{a.count === 1 ? '' : 's'} evaluated · {pass}% pass rate · average {avg.toFixed(1)}%.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
