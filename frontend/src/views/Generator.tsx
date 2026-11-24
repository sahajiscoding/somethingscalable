import { useState } from 'react';
import LatticeLoader from '../components/LatticeLoader.jsx';
import {
  buildGenKeyText,
  buildGenPaperText,
  DEFAULT_MODEL_ID,
  downloadText,
  generateExam,
  modelLabel,
  type GeneratedExam,
  type GeneratedQuestion,
} from '../lib/api';
import { downloadPdf, generateAnswerKeyPdf, generateExamPaperPdf } from '../lib/pdfGenerator';
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
  setModelOverride?: (m: string) => void;
  onSendToGrader: (paper: File, key: File) => void;
}

export default function Generator({ modelOverride, setModelOverride, onSendToGrader }: GeneratorProps) {
  const [topic, setTopic] = useState('Calculus — Quadratic Equations & Derivatives');
  const [subtopic, setSubtopic] = useState('');
  const [grade, setGrade] = useState('Senior Secondary (Grade 11)');
  const [difficulty, setDifficulty] = useState('Medium');
  const [count, setCount] = useState('5');
  const [marks, setMarks] = useState('25');
  const [tab, setTab] = useState<GenTab>('paper');
  const [exam, setExam] = useState<GeneratedExam | null>(null);
  const [running, setRunning] = useState(false);
  const [alert, setAlert] = useState<{ msg: string; ok: boolean } | null>(null);
  const [loaderStatus, setLoaderStatus] = useState<'working' | 'done' | 'error' | null>(null);
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [includeAnswerLines, setIncludeAnswerLines] = useState(true);
  const [timeAllowed, setTimeAllowed] = useState('1 Hour');
  const [schoolName, setSchoolName] = useState('');

  const updateExam = (patch: Partial<GeneratedExam>) => {
    setExam(previous => previous ? { ...previous, ...patch } : previous);
  };

  const updateQuestion = (index: number, patch: Partial<GeneratedQuestion>) => {
    setExam(previous => {
      if (!previous) return previous;
      const questions = previous.questions.map((question, i) => i === index ? { ...question, ...patch } : question);
      return {
        ...previous,
        questions,
        total_marks: questions.reduce((sum, question) => sum + (Number(question.max_marks) || 0), 0),
      };
    });
  };

  const onGenerate = async () => {
    if (running) return;
    if (!topic.trim()) {
      setAlert({ msg: 'Enter a subject & topic first.', ok: false });
      return;
    }
    const totalCount = Math.max(1, parseInt(count, 10) || 5);
    const totalMarks = parseFloat(marks) || 25;

    setRunning(true);
    setAlert(null);
    setLoaderStatus('working');
    setTab('paper');
    setExam({
      title: `${topic.trim()} Examination`,
      topic: topic.trim(),
      instructions: 'Answer all questions. Show complete working steps.',
      total_marks: totalMarks,
      questions: [],
    });

    try {
      const data = await generateExam({
        topic: topic.trim(),
        subtopic: subtopic.trim() || undefined,
        grade,
        difficulty,
        count: totalCount,
        marks: totalMarks,
        model: modelOverride.trim() || undefined,
        onQuestionGenerated: (_q, _idx, _total, allQuestions) => {
          const done = allQuestions.filter((item): item is GeneratedQuestion => item !== null);
          setExam({
            title: `${topic.trim()} Examination`,
            topic: topic.trim(),
            instructions: 'Answer all questions. Show complete working steps.',
            total_marks: totalMarks,
            questions: done,
          });
        },
      });
      setExam(data.exam);
      setLoaderStatus('done');
      setAlert({
        msg: `Exam written by ${modelLabel(data.model || modelOverride)} — ${data.exam.questions.length} questions, ${fmt(totalMarks)} marks. Preview & answer key below.`,
        ok: true,
      });
    } catch (err) {
      setLoaderStatus('error');
      // Only real, AI-written questions are ever shown; if none arrived, clear
      // the preview entirely rather than leaving a fake/template paper.
      setExam(prev => (prev && prev.questions.length > 0 ? prev : null));
      setAlert({ msg: `Exam generation failed — ${err instanceof Error ? err.message : String(err)}`, ok: false });
    } finally {
      setRunning(false);
    }
  };

  const [pdfBusy, setPdfBusy] = useState(false);

  const downloadPaperPdf = async () => {
    if (!exam || pdfBusy) return;
    try {
      setPdfBusy(true);
      const bytes = await generateExamPaperPdf(exam);
      const safeName = (exam.title || 'question-paper')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');
      downloadPdf(bytes, `${safeName}.pdf`);
    } catch (err) {
      setAlert({ msg: `Could not generate PDF: ${err instanceof Error ? err.message : String(err)}`, ok: false });
    } finally {
      setPdfBusy(false);
    }
  };

  const downloadCustomPaperPdf = async () => {
    if (!exam || pdfBusy) return;
    try {
      setPdfBusy(true);
      const bytes = await generateExamPaperPdf(exam, {
        includeAnswerLines,
        gradeLevel: grade,
        timeAllowed,
        schoolName,
      });
      const safeName = (exam.title || 'custom-question-paper')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');
      downloadPdf(bytes, `${safeName}-custom.pdf`);
      setAlert({ msg: 'Custom question PDF generated from your edited exam.', ok: true });
    } catch (err) {
      setAlert({ msg: `Could not generate custom PDF: ${err instanceof Error ? err.message : String(err)}`, ok: false });
    } finally {
      setPdfBusy(false);
    }
  };

  const downloadCustomKeyPdf = async () => {
    if (!exam || pdfBusy) return;
    try {
      setPdfBusy(true);
      const bytes = await generateAnswerKeyPdf(exam, { schoolName });
      const safeName = (exam.title || 'custom-answer-key')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');
      downloadPdf(bytes, `${safeName}-custom-key.pdf`);
      setAlert({ msg: 'Custom answer-key PDF generated from your edited exam.', ok: true });
    } catch (err) {
      setAlert({ msg: `Could not generate custom PDF: ${err instanceof Error ? err.message : String(err)}`, ok: false });
    } finally {
      setPdfBusy(false);
    }
  };

  const downloadKeyPdf = async () => {
    if (!exam || pdfBusy) return;
    try {
      setPdfBusy(true);
      const bytes = await generateAnswerKeyPdf(exam);
      const safeName = (exam.title || 'answer-key')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');
      downloadPdf(bytes, `${safeName}-rubric.pdf`);
    } catch (err) {
      setAlert({ msg: `Could not generate PDF: ${err instanceof Error ? err.message : String(err)}`, ok: false });
    } finally {
      setPdfBusy(false);
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
          Leverage Nemotron 3.5 Super VL to generate balanced examination papers and matching step-by-step marking rubrics.
        </p>
      </div>

      <div className="grid items-start gap-5 xl:grid-cols-[1.15fr_1.35fr]">
        <div>
          <div className="mb-4">
            <label htmlFor="genTopic" className="mb-1.5 block text-[13px] font-bold text-white/70">
              Subject &amp; Curriculum Topic
            </label>
            <input id="genTopic" type="text" value={topic} onChange={e => setTopic(e.target.value)} placeholder="e.g. Calculus — Derivatives, Integrals & Roots" className={inputCls} />
            <input
              id="genSubtopic"
              type="text"
              value={subtopic}
              onChange={e => setSubtopic(e.target.value)}
              placeholder="Optional narrower focus, e.g. Snell's law (leave blank to cover the whole topic)"
              aria-label="Optional subtopic focus"
              className={`${inputCls} mt-2`}
            />
            <div className="mt-2 flex flex-wrap gap-1.5">
              {TOPIC_TAGS.map(t => (
                <button
                  key={t}
                  type="button"
                  onClick={() => {
                    setTopic(t);
                    setSubtopic('');
                  }}
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
                <option>Senior Secondary (Grade 11)</option>
                <option>Senior Secondary (Grade 12)</option>
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

          {setModelOverride && (
            <div className="mb-4 rounded-xl border border-white/10 bg-black/20 p-3.5">
              <div className="flex items-center justify-between">
                <div className="text-[11px] font-bold tracking-[.14em] text-white/50 uppercase">Generation Model (WHT Engine AI Gateway)</div>
                <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-0.5 text-[10px] font-medium text-white/40">
                  WHT Engine Gateway
                </span>
              </div>
              <div className="mt-1 text-xs text-white/45">Auto starts with Nemotron 3.5 Super VL; free backups are used only if its limit is reached:</div>
              <div className="mt-1 text-[11px] text-white/40">Free providers may retain or use prompts for training; avoid personal or confidential information.</div>

              <div className="mt-2.5 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                {[
                  {
                    id: DEFAULT_MODEL_ID,
                    name: 'Auto',
                    tag: 'WHT Engine Gateway · automatic free-model selection',
                    tagTone: 'text-mint/90',
                    desc: 'Starts with Nemotron 3.5 Super VL and uses a free backup only if its limit is reached.',
                    match: (m: string) => !m.trim() || m.trim() === DEFAULT_MODEL_ID,
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
            </div>
          )}

          <button
            type="button"
            onClick={() => void onGenerate()}
            disabled={running}
            className="mt-2.5 flex w-full cursor-pointer items-center justify-center gap-2 rounded-[13px] border-none bg-gradient-to-br from-pine to-[#3b7a53] px-6 py-3.5 text-[14.5px] font-bold text-[#0c1a11] shadow-[0_8px_24px_rgba(78,154,106,.32)] transition hover:brightness-110 disabled:cursor-progress disabled:saturate-50"
          >
            {running
              ? `Generating (${exam?.questions.length || 0}/${count} ready)…`
              : `Generate Exam with ${modelLabel(modelOverride)}`}
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
          {running && (
            <div className="mb-3 flex items-center justify-between rounded-xl border border-mint/40 bg-mint/10 px-4 py-2.5 text-[13px] text-mint">
              <span className="flex items-center gap-2">
                <span className="inline-block h-2 w-2 animate-ping rounded-full bg-mint" />
                <span>
                  Generating with <strong>{modelLabel(modelOverride)}</strong> (1 request per question · queued to stay inside the gateway limit)
                </span>
              </span>
              <span className="font-mono font-bold">
                {exam?.questions.length || 0} / {count} ready
              </span>
            </div>
          )}

          <div className="mb-4 flex gap-2 border-b border-white/10 pb-3">
            {(
              [
                ['paper', 'Question Paper'],
                ['key', 'Official Rubric & Key'],
                ['json', 'Raw JSON'],
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
                {running ? (
                  <>
                    <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl border border-mint/30 bg-mint/10 text-mint">
                      <svg className="h-6 w-6 animate-spin" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                      </svg>
                    </div>
                    <h4 className="mb-1.5 text-base font-semibold text-white/80">Generating Questions…</h4>
                    <p className="mx-auto max-w-[36ch] text-[13px] text-white/45">
                      Contacting the WHT Engine AI Gateway {modelLabel(modelOverride)}. Questions will appear here live as each request completes.
                    </p>
                  </>
                ) : (
                  <>
                    <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl border border-white/10 bg-white/5 text-white/40">
                      <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.75">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                      </svg>
                    </div>
                    <h4 className="mb-1.5 text-base font-semibold text-white/80">No Exam Generated Yet</h4>
                    <p className="mx-auto max-w-[36ch] text-[13px] text-white/45">
                      Select your subject parameters on the left and hit <b>Generate Exam</b> to build an exam paper with
                      {` ${modelLabel(modelOverride)}.`}
                    </p>
                  </>
                )}
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
                {running && exam.questions.length < parseInt(count, 10) && (
                  <div className="flex items-center justify-between rounded-xl border border-dashed border-mint/30 bg-mint/5 p-4 text-[13px] text-white/70">
                    <span className="flex items-center gap-2">
                      <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-mint" />
                      Generating Question {exam.questions.length + 1} of {count}…
                    </span>
                    <span className="text-xs text-white/40">queued</span>
                  </div>
                )}
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
                {running && exam.questions.length < parseInt(count, 10) && (
                  <div className="flex items-center justify-between rounded-xl border border-dashed border-mint/30 bg-mint/5 p-4 text-[13px] text-white/70">
                    <span className="flex items-center gap-2">
                      <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-mint" />
                      Generating Question {exam.questions.length + 1} of {count}…
                    </span>
                    <span className="text-xs text-white/40">queued</span>
                  </div>
                )}
              </div>
            )}
          </div>

          {customizeOpen && exam && !running && (
            <section aria-labelledby="custom-pdf-title" className="mt-4 rounded-xl border border-mint/25 bg-mint/[.035] p-4 md:p-5">
              <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 id="custom-pdf-title" className="text-base font-bold text-white">Customize your exam PDF</h3>
                  <p className="mt-1 text-xs text-white/45">Edit the generated paper and rubric below. These changes update the preview and custom downloads.</p>
                </div>
                <button type="button" onClick={() => setCustomizeOpen(false)} className="rounded-lg border border-white/15 px-3 py-1.5 text-xs font-semibold text-white/65 hover:bg-white/5">Close editor</button>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="text-xs font-semibold text-white/65">PDF title
                  <input aria-label="Custom PDF title" value={exam.title} onChange={event => updateExam({ title: event.target.value })} className={`${inputCls} mt-1.5`} />
                </label>
                <label className="text-xs font-semibold text-white/65">Subject / topic
                  <input aria-label="Custom PDF subject" value={exam.topic} onChange={event => updateExam({ topic: event.target.value })} className={`${inputCls} mt-1.5`} />
                </label>
                <label className="text-xs font-semibold text-white/65">School / organization name <span className="font-normal text-white/40">(optional)</span>
                  <input aria-label="School name" value={schoolName} maxLength={100} onChange={event => setSchoolName(event.target.value)} placeholder="e.g. Northfield School" className={`${inputCls} mt-1.5`} />
                </label>
                <label className="text-xs font-semibold text-white/65">Time allowed
                  <input aria-label="Time allowed" value={timeAllowed} maxLength={60} onChange={event => setTimeAllowed(event.target.value)} placeholder="e.g. 45 minutes" className={`${inputCls} mt-1.5`} />
                </label>
                <label className="text-xs font-semibold text-white/65 sm:col-span-2">Candidate instructions
                  <textarea aria-label="Candidate instructions" value={exam.instructions} onChange={event => updateExam({ instructions: event.target.value })} rows={2} className={`${inputCls} mt-1.5 resize-y`} />
                </label>
                <label className="flex items-center gap-2 text-xs font-semibold text-white/70 sm:col-span-2">
                  <input type="checkbox" checked={includeAnswerLines} onChange={event => setIncludeAnswerLines(event.target.checked)} />
                  Include ruled answer lines under questions
                </label>
              </div>
              <div className="mt-4 space-y-3">
                {exam.questions.map((question, index) => (
                  <fieldset key={index} className="rounded-xl border border-white/10 bg-black/20 p-3.5">
                    <legend className="px-1 text-xs font-bold text-mint">Edit question {index + 1}</legend>
                    <div className="grid gap-3 sm:grid-cols-[1fr_130px]">
                      <label className="text-[11px] font-semibold text-white/60">Question number
                        <input aria-label={`Question ${index + 1} number`} value={question.number} onChange={event => updateQuestion(index, { number: event.target.value })} className={`${inputCls} mt-1`} />
                      </label>
                      <label className="text-[11px] font-semibold text-white/60">Marks
                        <input aria-label={`Question ${index + 1} marks`} type="number" min="0" step="0.5" value={question.max_marks} onChange={event => updateQuestion(index, { max_marks: Math.max(0, Number(event.target.value) || 0) })} className={`${inputCls} mt-1`} />
                      </label>
                    </div>
                    <label className="mt-3 block text-[11px] font-semibold text-white/60">Question text
                      <textarea aria-label={`Question ${index + 1} text`} value={question.text} onChange={event => updateQuestion(index, { text: event.target.value })} rows={3} className={`${inputCls} mt-1 resize-y`} />
                    </label>
                    <label className="mt-3 block text-[11px] font-semibold text-white/60">Answer key
                      <textarea aria-label={`Question ${index + 1} answer`} value={question.expected_answer} onChange={event => updateQuestion(index, { expected_answer: event.target.value })} rows={2} className={`${inputCls} mt-1 resize-y`} />
                    </label>
                    <label className="mt-3 block text-[11px] font-semibold text-white/60">Marking scheme
                      <textarea aria-label={`Question ${index + 1} marking scheme`} value={question.marking_scheme} onChange={event => updateQuestion(index, { marking_scheme: event.target.value })} rows={2} className={`${inputCls} mt-1 resize-y`} />
                    </label>
                    <label className="mt-3 block text-[11px] font-semibold text-white/60">Keywords <span className="font-normal text-white/40">(comma separated)</span>
                      <input aria-label={`Question ${index + 1} keywords`} value={question.keywords.join(', ')} onChange={event => updateQuestion(index, { keywords: event.target.value.split(',').map(keyword => keyword.trim()).filter(Boolean) })} className={`${inputCls} mt-1`} />
                    </label>
                  </fieldset>
                ))}
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                <button type="button" onClick={() => void downloadCustomPaperPdf()} disabled={pdfBusy} className="rounded-xl bg-mint px-4 py-2.5 text-sm font-bold text-black transition hover:brightness-90 disabled:opacity-50">{pdfBusy ? 'Generating…' : 'Generate Custom Question PDF'}</button>
                <button type="button" onClick={() => void downloadCustomKeyPdf()} disabled={pdfBusy} className="rounded-xl border border-mint/35 bg-mint/10 px-4 py-2.5 text-sm font-bold text-mint transition hover:bg-mint/15 disabled:opacity-50">{pdfBusy ? 'Generating…' : 'Generate Custom Answer Key PDF'}</button>
              </div>
            </section>
          )}

          {exam && exam.questions?.length > 0 && (
            <div className="mt-4 flex flex-wrap items-center gap-2.5 border-t border-white/10 pt-4">
              <button
                type="button"
                onClick={sendToGrader}
                title="Send directly to Step 01 Upload Bay"
                className="cursor-pointer rounded-[13px] border-none bg-gradient-to-br from-pine to-[#3b7a53] px-5 py-2.5 text-sm font-extrabold text-[#0c1a11] transition hover:brightness-110"
              >
                Send to Exam Grading
              </button>
              <button
                type="button"
                onClick={() => setCustomizeOpen(open => !open)}
                aria-expanded={customizeOpen}
                disabled={running}
                className="cursor-pointer rounded-[13px] border border-lilac/45 bg-lilac/10 px-4 py-2.5 text-sm font-bold text-[#e6ddff] transition hover:bg-lilac/15 disabled:cursor-wait disabled:opacity-50"
              >
                {customizeOpen ? 'Close Custom PDF Editor' : 'Customize & Edit PDF'}
              </button>
              <button
                type="button"
                onClick={downloadPaperPdf}
                disabled={pdfBusy}
                className="flex cursor-pointer items-center gap-2 rounded-[13px] border border-mint/45 bg-mint/15 px-4 py-2.5 text-sm font-extrabold text-[#d8f5db] shadow-[0_4px_16px_rgba(129,199,132,.2)] transition hover:bg-mint/25 disabled:cursor-wait disabled:opacity-50"
              >
                {pdfBusy ? 'Generating PDF…' : 'Question Paper (.pdf)'}
              </button>
              <button
                type="button"
                onClick={downloadKeyPdf}
                disabled={pdfBusy}
                className="flex cursor-pointer items-center gap-2 rounded-[13px] border border-mint/45 bg-mint/15 px-4 py-2.5 text-sm font-extrabold text-[#d8f5db] shadow-[0_4px_16px_rgba(129,199,132,.2)] transition hover:bg-mint/25 disabled:cursor-wait disabled:opacity-50"
              >
                {pdfBusy ? 'Generating PDF…' : 'Answer Key (.pdf)'}
              </button>
              <button
                type="button"
                onClick={() => downloadText(buildGenPaperText(exam), 'question-paper.txt', 'text/plain')}
                className="cursor-pointer rounded-[13px] border border-white/20 bg-white/5 px-3 py-2 text-xs font-semibold text-white/70 transition hover:bg-white/10"
                title="Download plain text question paper"
              >
                Paper (.txt)
              </button>
              <button
                type="button"
                onClick={() => downloadText(buildGenKeyText(exam), 'answer-key.txt', 'text/plain')}
                className="cursor-pointer rounded-[13px] border border-white/20 bg-white/5 px-3 py-2 text-xs font-semibold text-white/70 transition hover:bg-white/10"
                title="Download plain text answer key"
              >
                Key (.txt)
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
