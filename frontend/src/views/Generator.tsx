import { useState } from 'react';
import LatticeLoader from '../components/LatticeLoader.jsx';
import {
  buildGenKeyText,
  buildGenPaperText,
  downloadText,
  generateExam,
  type GeneratedExam,
} from '../lib/api';
import { fmt } from '../lib/sim';

type GenTab = 'paper' | 'key' | 'json';

const TOPIC_TAGS = [
  'Physics: Wave Optics & Interference',
  'Chemistry: Organic Reaction Mechanisms',
  'Calculus: Integration & Applications',
  'Computer Science: Trees & Graph Algorithms',
  'World History: The Cold War Era',
];

const TAG_SHORT: Record<string, string> = {
  'Physics: Wave Optics & Interference': 'Wave Optics',
  'Chemistry: Organic Reaction Mechanisms': 'Organic Chemistry',
  'Calculus: Integration & Applications': 'Calculus',
  'Computer Science: Trees & Graph Algorithms': 'Algorithms',
  'World History: The Cold War Era': 'Cold War History',
};

interface GeneratorProps {
  modelOverride: string;
  onSendToGrader: (paper: File, key: File) => void;
}

export default function Generator({ modelOverride, onSendToGrader }: GeneratorProps) {
  const [topic, setTopic] = useState('Calculus — Quadratic Equations & Derivatives');
  const [grade, setGrade] = useState('Senior Secondary (Grade 11-12)');
  const [difficulty, setDifficulty] = useState('Medium');
  const [count, setCount] = useState('5');
  const [marks, setMarks] = useState('25');
  const [tab, setTab] = useState<GenTab>('paper');
  const [exam, setExam] = useState<GeneratedExam | null>(null);
  const [running, setRunning] = useState(false);
  const [alert, setAlert] = useState<{ msg: string; ok: boolean } | null>(null);
  const [loaderStatus, setLoaderStatus] = useState<'working' | 'done' | 'error' | null>(null);

  const onGenerate = async () => {
    if (running) return;
    if (!topic.trim()) {
      setAlert({ msg: 'Enter a subject & topic first.', ok: false });
      return;
    }
    setRunning(true);
    setAlert(null);
    setLoaderStatus('working');
    try {
      const data = await generateExam({
        topic: topic.trim(),
        grade,
        difficulty,
        count: parseInt(count, 10) || 5,
        marks: parseFloat(marks) || 25,
        model: modelOverride.trim() || undefined,
      });
      setExam(data.exam);
      setTab('paper');
      setLoaderStatus('done');
      setAlert({
        msg: data.note ? `✓ Generated (${data.model}, offline template). ${data.note}` : `✓ Exam generated with ${data.model || 'Kimi-K3'} — preview below.`,
        ok: true,
      });
    } catch (err) {
      setLoaderStatus('error');
      setAlert({ msg: `Generation failed (${err instanceof Error ? err.message : String(err)}). Check the live backend and retry.`, ok: false });
    } finally {
      setRunning(false);
    }
  };

  const sendToGrader = () => {
    if (!exam) {
      setAlert({ msg: 'Generate an exam first.', ok: false });
      return;
    }
    onSendToGrader(
      new File([buildGenPaperText(exam)], 'generated-paper.txt', { type: 'text/plain' }),
      new File([buildGenKeyText(exam)], 'generated-key.txt', { type: 'text/plain' }),
    );
  };

  const inputCls =
    'w-full rounded-[10px] border border-white/20 bg-black/25 px-3.5 py-2.5 font-sans text-sm text-white outline-none transition focus:border-mint focus:shadow-[0_0_0_3px_rgba(129,199,132,.22)]';

  return (
    <div className="rounded-2xl border border-white/10 bg-canvas p-5 shadow-[0_20px_44px_rgba(0,0,0,.32)] md:p-7">
      <div className="mb-5">
        <div className="mb-1 text-[11px] font-bold tracking-[.18em] text-white/45 uppercase">Authoring Tool</div>
        <h2 className="text-[19px] font-bold tracking-tight">Exam Paper &amp; Rubric Generator</h2>
        <p className="mt-1 max-w-[52ch] text-[13.5px] text-white/45">
          Leverage Moonshot AI Kimi-K3 to generate balanced examination papers and matching step-by-step marking rubrics.
        </p>
      </div>

      <div className="grid items-start gap-5 xl:grid-cols-[1.15fr_1.35fr]">
        <div>
          <div className="mb-4">
            <label htmlFor="genTopic" className="mb-1.5 block text-[13px] font-bold text-white/70">
              Subject &amp; Curriculum Topic
            </label>
            <input id="genTopic" type="text" value={topic} onChange={e => setTopic(e.target.value)} placeholder="e.g. Calculus — Derivatives, Integrals & Roots" className={inputCls} />
            <div className="mt-2 flex flex-wrap gap-1.5">
              {TOPIC_TAGS.map(t => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTopic(t)}
                  className="cursor-pointer rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11.5px] text-white/60 transition hover:border-mint hover:bg-mint/10 hover:text-mint"
                >
                  {TAG_SHORT[t]}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="mb-4">
              <label htmlFor="genGrade" className="mb-1.5 block text-[13px] font-bold text-white/70">
                Grade / Academic Level
              </label>
              <select id="genGrade" value={grade} onChange={e => setGrade(e.target.value)} className={`${inputCls} appearance-none`}>
                <option>High School (Grade 10)</option>
                <option>Senior Secondary (Grade 11-12)</option>
                <option>Undergraduate / College</option>
                <option>Competitive Exam / Olympiad</option>
              </select>
            </div>
            <div className="mb-4">
              <label htmlFor="genDifficulty" className="mb-1.5 block text-[13px] font-bold text-white/70">
                Difficulty
              </label>
              <select id="genDifficulty" value={difficulty} onChange={e => setDifficulty(e.target.value)} className={`${inputCls} appearance-none`}>
                <option>Easy</option>
                <option>Medium</option>
                <option>Challenging</option>
                <option>Mixed Tiers</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="mb-4">
              <label htmlFor="genCount" className="mb-1.5 block text-[13px] font-bold text-white/70">
                Number of Questions
              </label>
              <select id="genCount" value={count} onChange={e => setCount(e.target.value)} className={`${inputCls} appearance-none`}>
                <option value="3">3 Questions (Short Quiz)</option>
                <option value="5">5 Questions (Standard Test)</option>
                <option value="8">8 Questions (Full Exam)</option>
              </select>
            </div>
            <div className="mb-4">
              <label htmlFor="genMarks" className="mb-1.5 block text-[13px] font-bold text-white/70">
                Total Marks
              </label>
              <input id="genMarks" type="number" value={marks} min={5} max={100} onChange={e => setMarks(e.target.value)} className={inputCls} />
            </div>
          </div>

          <button
            type="button"
            onClick={() => void onGenerate()}
            disabled={running}
            className="mt-2.5 flex w-full cursor-pointer items-center justify-center gap-2 rounded-[13px] border-none bg-gradient-to-br from-pine to-[#3b7a53] px-6 py-3 text-[14.5px] font-extrabold text-[#0c1a11] shadow-[0_8px_24px_rgba(78,154,106,.35)] transition hover:brightness-110 disabled:cursor-progress disabled:saturate-50"
          >
            ✨ {running ? 'Generating…' : 'Generate Exam with Kimi-K3'}
          </button>

          {loaderStatus && (
            <div className="mt-3.5 flex items-center text-white/70">
              <LatticeLoader status={loaderStatus} label="Thinking" doneLabel="Done in" errorLabel="Failed after" pattern="orbit" grid={3} shape="round" showTimer />
            </div>
          )}
          {alert && (
            <div
              role="status"
              aria-live="polite"
              className={`mt-3 rounded-xl border p-3 text-[13.5px] ${
                alert.ok ? 'border-mint/45 bg-mint/15 text-[#dff6e1]' : 'border-crimson/45 bg-crimson/15 text-[#ffd9d9]'
              }`}
            >
              {alert.msg}
            </div>
          )}
        </div>

        <div>
          <div className="mb-4 flex gap-2 border-b border-white/10 pb-3">
            {(
              [
                ['paper', '📄 Question Paper'],
                ['key', '🔑 Official Rubric & Key'],
                ['json', '{ } Raw JSON'],
              ] as [GenTab, string][]
            ).map(([k, label]) => (
              <button
                key={k}
                type="button"
                onClick={() => setTab(k)}
                className={`cursor-pointer rounded-lg border-none bg-transparent px-3.5 py-1.5 text-[13px] font-bold transition ${
                  tab === k ? 'border border-mint/30 bg-white/10 text-mint' : 'text-white/45 hover:text-mint'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="max-h-[640px] min-h-[380px] overflow-y-auto rounded-xl border border-white/10 bg-black/20 p-5">
            {!exam || !exam.questions?.length ? (
              <div className="px-5 py-12 text-center text-white/45">
                <div className="mb-3 text-4xl">📝</div>
                <h4 className="mb-1.5 text-base text-white/70">No Exam Generated Yet</h4>
                <p className="mx-auto max-w-[36ch] text-[13px]">
                  Select your subject parameters on the left and hit <b>Generate Exam</b> to build an exam paper with
                  Kimi-K3.
                </p>
              </div>
            ) : tab === 'json' ? (
              <pre className="text-xs leading-relaxed break-words whitespace-pre-wrap text-white/70">
                {JSON.stringify(exam, null, 2)}
              </pre>
            ) : tab === 'key' ? (
              <div>
                <div className="mb-3.5">
                  <div className="mb-1 text-[11px] font-bold tracking-[.18em] text-white/45 uppercase">Official Rubric &amp; Key</div>
                  <h4 className="text-[17px] font-extrabold">{exam.title || 'Generated Exam'}</h4>
                  <p className="text-xs text-white/45">
                    {exam.topic || ''} · {fmt(exam.total_marks || 0)} marks
                  </p>
                </div>
                {exam.questions.map(q => (
                  <div key={q.number} className="mb-3.5 rounded-xl border border-white/10 bg-black/15 p-4">
                    <div className="mb-2 flex items-center justify-between gap-2.5">
                      <span className="text-[14.5px] font-extrabold text-mint">{q.number}</span>
                      <span className="rounded-md border border-mint/35 bg-mint/10 px-2 py-0.5 text-[11.5px] font-bold text-mint">
                        {fmt(q.max_marks || 0)} marks
                      </span>
                    </div>
                    <div className="text-sm text-white">
                      <b>Answer:</b> {q.expected_answer || '—'}
                    </div>
                    <div className="mt-2.5 rounded-lg bg-black/20 p-2.5 text-[13px] text-white/70">
                      <b>Marking scheme:</b> {q.marking_scheme || '—'}
                      {q.keywords?.length ? (
                        <>
                          <br />
                          <b>Keywords:</b> {q.keywords.join(', ')}
                        </>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div>
                <div className="mb-3.5">
                  <div className="mb-1 text-[11px] font-bold tracking-[.18em] text-white/45 uppercase">Question Paper</div>
                  <h4 className="text-[17px] font-extrabold">{exam.title || 'Generated Exam'}</h4>
                  <p className="text-xs text-white/45">{exam.instructions || ''}</p>
                  <p className="text-xs text-white/45">
                    Total: {fmt(exam.total_marks || 0)} marks · {exam.questions.length} questions
                  </p>
                </div>
                {exam.questions.map(q => (
                  <div key={q.number} className="mb-3.5 rounded-xl border border-white/10 bg-black/15 p-4">
                    <div className="mb-2 flex items-center justify-between gap-2.5">
                      <span className="text-[14.5px] font-extrabold text-mint">{q.number}</span>
                      <span className="rounded-md border border-mint/35 bg-mint/10 px-2 py-0.5 text-[11.5px] font-bold text-mint">
                        {fmt(q.max_marks || 0)} marks
                      </span>
                    </div>
                    <div className="text-sm leading-relaxed text-white">{q.text || '—'}</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {exam && exam.questions?.length > 0 && (
            <div className="mt-4 flex flex-wrap items-center gap-2.5 border-t border-white/10 pt-4">
              <button
                type="button"
                onClick={sendToGrader}
                title="Send directly to Step 01 Upload Bay"
                className="cursor-pointer rounded-[13px] border-none bg-gradient-to-br from-pine to-[#3b7a53] px-5 py-2.5 text-sm font-extrabold text-[#0c1a11] transition hover:brightness-110"
              >
                🚀 Send to Exam Grading (1-Click)
              </button>
              <button
                type="button"
                onClick={() => downloadText(buildGenPaperText(exam), 'question-paper.txt', 'text/plain')}
                className="cursor-pointer rounded-[13px] border border-white/20 bg-white/5 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-white/10"
              >
                ⬇ Question Paper (.txt)
              </button>
              <button
                type="button"
                onClick={() => downloadText(buildGenKeyText(exam), 'answer-key.txt', 'text/plain')}
                className="cursor-pointer rounded-[13px] border border-white/20 bg-white/5 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-white/10"
              >
                ⬇ Answer Key (.txt)
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
