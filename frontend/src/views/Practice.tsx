import { useState } from 'react';
import LatticeLoader from '../components/LatticeLoader.jsx';
import {
  generateExam,
  generatePresentation,
  modelLabel,
  type GeneratedExam,
  type PresentationDeck,
} from '../lib/api';
import {
  buildEditablePresentation,
  createBlankSlide,
  downloadPresentation,
  PRESENTATION_THEMES,
  type PresentationTheme,
} from '../lib/presentation';

type Mode = 'questions' | 'lesson';

const inputClass = 'mt-1.5 w-full rounded-xl border border-white/10 bg-black/25 px-3 py-2.5 text-sm text-white outline-none transition placeholder:text-white/30 focus:border-pine/70';
const labelClass = 'block text-xs font-semibold text-white/65';

export default function Practice({ model = '' }: { model?: string }) {
  const [mode, setMode] = useState<Mode>('questions');
  const [topic, setTopic] = useState('');
  const [audience, setAudience] = useState('Grade 8');
  const [count, setCount] = useState(8);
  const [difficulty, setDifficulty] = useState('Medium');
  const [slideCount, setSlideCount] = useState(7);
  const [theme, setTheme] = useState<PresentationTheme>('emerald');
  const [exam, setExam] = useState<GeneratedExam | null>(null);
  const [deck, setDeck] = useState<PresentationDeck | null>(null);
  const [showAnswers, setShowAnswers] = useState(false);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loaderStatus, setLoaderStatus] = useState<'working' | 'done' | 'error' | null>(null);

  const generate = async () => {
    if (busy) return;
    setError('');
    setNotice('');
    setBusy(true);
    setLoaderStatus('working');
    try {
      if (mode === 'questions') {
        const result = await generateExam({
          topic: topic.trim(), grade: audience.trim(), difficulty, count,
          marks: count * 2, model: model.trim() || undefined,
        });
        setExam(result.exam);
        setDeck(null);
        setShowAnswers(false);
        setNotice(`Practice set generated with ${modelLabel(result.model)}. Review the answers and adapt before assigning.`);
      } else {
        const result = await generatePresentation({
          topic: topic.trim(), audience: audience.trim(), slideCount,
          model: model.trim() || undefined,
        });
        setDeck(result.presentation);
        setExam(null);
        setNotice(`Editable lesson deck generated with ${modelLabel(result.model)}. You can revise every slide before downloading.`);
      }
      setLoaderStatus('done');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setLoaderStatus('error');
    } finally {
      setBusy(false);
    }
  };

  const updateSlide = (index: number, patch: Partial<PresentationDeck['slides'][number]>) => {
    setDeck(current => current ? {
      ...current,
      slides: current.slides.map((slide, i) => i === index ? { ...slide, ...patch } : slide),
    } : current);
  };

  const exportDeck = async () => {
    if (!deck || exporting) return;
    setExporting(true);
    setError('');
    try {
      const blob = await buildEditablePresentation(deck, theme);
      downloadPresentation(blob, deck.title);
      setNotice('PowerPoint downloaded. Slide text, shapes, and labels are native editable PowerPoint objects.');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setExporting(false);
    }
  };

  const downloadQuestions = () => {
    if (!exam) return;
    const text = [exam.title, `Audience: ${audience}`, `Difficulty: ${difficulty}`, '', exam.instructions, '',
      ...exam.questions.flatMap(q => [`${q.number} (${q.max_marks} marks) — ${q.text}`, ...(showAnswers ? [`Suggested answer: ${q.expected_answer}`, `Marking guidance: ${q.marking_scheme}`] : []), '']),
    ].join('\n');
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${exam.title.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'practice-questions'}.txt`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <section className="overflow-hidden rounded-2xl border border-white/10 bg-canvas shadow-[0_20px_44px_rgba(0,0,0,.32)]" aria-labelledby="practice-heading">
      <header className="border-b border-white/10 px-5 py-5 md:px-7">
        <div className="text-[11px] font-bold tracking-[.18em] text-white/45 uppercase">Teacher workspace</div>
        <h1 id="practice-heading" className="mt-1 text-2xl font-bold tracking-tight">Practice Questions</h1>
        <p className="mt-1 max-w-3xl text-sm text-white/55">Create exam-preparation question sets or build a lesson presentation for teaching. AI drafts are editable and should be reviewed before classroom use.</p>
      </header>

      <div className="grid gap-6 p-5 md:grid-cols-[minmax(260px,340px)_1fr] md:p-7">
        <aside className="space-y-5">
          <div className="grid grid-cols-2 rounded-xl border border-white/10 bg-black/20 p-1" role="tablist" aria-label="Material type">
            <button type="button" role="tab" aria-selected={mode === 'questions'} onClick={() => { setMode('questions'); setError(''); }} className={`rounded-lg px-3 py-2 text-xs font-bold transition ${mode === 'questions' ? 'bg-pine text-[#102016]' : 'text-white/60 hover:text-white'}`}>Practice questions</button>
            <button type="button" role="tab" aria-selected={mode === 'lesson'} onClick={() => { setMode('lesson'); setError(''); }} className={`rounded-lg px-3 py-2 text-xs font-bold transition ${mode === 'lesson' ? 'bg-pine text-[#102016]' : 'text-white/60 hover:text-white'}`}>Teach with slides</button>
          </div>

          <label className={labelClass}>Topic and learning focus
            <textarea className={`${inputClass} min-h-28 resize-y`} value={topic} onChange={e => setTopic(e.target.value)} maxLength={1200} placeholder="e.g. Explain the water cycle, including evaporation, condensation, and precipitation" />
          </label>
          <label className={labelClass}>Learner audience / grade
            <input className={inputClass} value={audience} onChange={e => setAudience(e.target.value)} maxLength={160} placeholder="e.g. Grade 8" />
          </label>

          {mode === 'questions' ? (
            <>
              <label className={labelClass}>Number of questions
                <input className={inputClass} type="number" min={1} max={20} value={count} onChange={e => setCount(Math.min(20, Math.max(1, Number(e.target.value) || 1)))} />
              </label>
              <label className={labelClass}>Difficulty
                <select className={inputClass} value={difficulty} onChange={e => setDifficulty(e.target.value)}>
                  <option>Easy</option><option>Medium</option><option>Hard</option>
                </select>
              </label>
            </>
          ) : (
            <>
              <label className={labelClass}>Lesson content slides (+ separate title slide)
                <input className={inputClass} type="number" min={3} max={15} value={slideCount} onChange={e => setSlideCount(Math.min(15, Math.max(3, Number(e.target.value) || 3)))} />
              </label>
              <label className={labelClass}>PowerPoint color theme
                <select className={inputClass} value={theme} onChange={e => setTheme(e.target.value as PresentationTheme)}>
                  {Object.entries(PRESENTATION_THEMES).map(([key, colors]) => <option key={key} value={key}>{key[0].toUpperCase() + key.slice(1)} · #{colors.accent}</option>)}
                </select>
              </label>
              <p className="rounded-xl border border-white/10 bg-black/20 p-3 text-xs leading-relaxed text-white/55">Export uses separate editable text boxes, circles, and shapes—not slide screenshots. Teacher notes are included in PowerPoint speaker notes.</p>
            </>
          )}

          <button type="button" onClick={generate} disabled={busy || !topic.trim() || !audience.trim()} className="w-full rounded-xl bg-pine px-4 py-3 text-sm font-extrabold text-[#102016] transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50">
            {busy ? 'Generating with AI…' : mode === 'questions' ? 'Generate practice set' : 'Generate lesson slides'}
          </button>
          {error && <p role="alert" className="rounded-xl border border-red-400/20 bg-red-400/10 p-3 text-sm text-red-200">{error}</p>}
          {notice && <p role="status" className="rounded-xl border border-pine/20 bg-pine/10 p-3 text-xs leading-relaxed text-green-100">{notice}</p>}
          {busy && <LatticeLoader status={loaderStatus ?? 'working'} />}
        </aside>

        <div className="min-h-[420px] rounded-2xl border border-white/10 bg-black/15 p-4 md:p-5">
          {!exam && !deck && <div className="grid min-h-[380px] place-items-center text-center"><div className="max-w-sm"><div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl border border-white/10 bg-white/[.04] text-2xl" aria-hidden="true">✦</div><h2 className="mt-4 text-lg font-bold">Your teaching materials will appear here</h2><p className="mt-2 text-sm leading-relaxed text-white/50">Describe a topic and choose whether you need student practice questions or a presentation for a teacher-led lesson.</p></div></div>}

          {exam && <div>
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-white/10 pb-4">
              <div><div className="text-[10px] font-bold tracking-[.16em] text-white/40 uppercase">Student practice set</div><h2 className="mt-1 text-xl font-bold">{exam.title}</h2><p className="mt-1 text-xs text-white/55">{exam.instructions} · {exam.total_marks} marks</p></div>
              <div className="flex flex-wrap gap-2"><button type="button" onClick={() => setShowAnswers(value => !value)} className="rounded-lg border border-white/15 px-3 py-2 text-xs font-semibold text-white/80 hover:bg-white/5">{showAnswers ? 'Hide answers' : 'Show answer key'}</button><button type="button" onClick={downloadQuestions} className="rounded-lg bg-pine px-3 py-2 text-xs font-bold text-[#102016]">Download set</button></div>
            </div>
            <ol className="mt-4 space-y-3">{exam.questions.map((q, index) => <li key={`${q.number}-${index}`} className="rounded-xl border border-white/10 bg-white/[.025] p-4"><div className="flex gap-3"><span className="grid h-7 min-w-7 place-items-center rounded-lg bg-pine/15 px-2 text-xs font-bold text-pine">{q.number}</span><div className="min-w-0 flex-1"><p className="text-sm leading-relaxed text-white/90">{q.text}</p><p className="mt-2 text-[11px] text-white/40">{q.max_marks} marks</p>{showAnswers && <div className="mt-3 space-y-2 border-t border-white/10 pt-3 text-xs leading-relaxed"><p><b className="text-pine">Suggested answer:</b> <span className="text-white/75">{q.expected_answer}</span></p><p><b className="text-pine">Marking guidance:</b> <span className="text-white/65">{q.marking_scheme}</span></p></div>}</div></div></li>)}</ol>
          </div>}

          {deck && <div>
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-white/10 pb-4">
              <div className="min-w-[180px] flex-1"><div className="text-[10px] font-bold tracking-[.16em] text-white/40 uppercase">Editable teacher presentation · {deck.slides.length + 1} total slides</div><label className="mt-1 block"><span className="sr-only">Presentation title</span><input className="w-full border-0 bg-transparent p-0 text-xl font-bold text-white outline-none focus:ring-0" value={deck.title} maxLength={140} onChange={e => setDeck({ ...deck, title: e.target.value })} /></label><label className="mt-1 block"><span className="sr-only">Presentation subtitle</span><input className="w-full border-0 bg-transparent p-0 text-xs text-white/55 outline-none focus:ring-0" value={deck.subtitle} maxLength={240} onChange={e => setDeck({ ...deck, subtitle: e.target.value })} /></label></div>
              <button type="button" onClick={exportDeck} disabled={exporting} className="rounded-lg bg-pine px-4 py-2.5 text-xs font-extrabold text-[#102016] disabled:opacity-60">{exporting ? 'Preparing PowerPoint…' : 'Download editable PPTX'}</button>
            </div>
            <div className="mt-4 space-y-4">{deck.slides.map((slide, index) => <article key={index} className="rounded-xl border border-white/10 bg-white/[.025] p-4"><div className="flex items-center justify-between gap-3"><span className="text-[10px] font-bold tracking-wider text-pine uppercase">Slide {index + 2}</span>{deck.slides.length > 3 && <button type="button" aria-label={`Remove slide ${index + 1}`} onClick={() => setDeck(current => current ? { ...current, slides: current.slides.filter((_, i) => i !== index) } : current)} className="text-xs text-white/45 hover:text-red-200">Remove</button>}</div>
              <input aria-label={`Slide ${index + 1} title`} className="mt-2 w-full rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm font-bold text-white outline-none focus:border-pine/50" value={slide.title} maxLength={140} onChange={e => updateSlide(index, { title: e.target.value })} />
              <><label className={`${labelClass} mt-3`}>Key points (one per line)<textarea className={`${inputClass} min-h-24`} value={slide.key_points.join('\n')} onChange={e => updateSlide(index, { key_points: e.target.value.split('\n').slice(0, 5) })} /></label><label className={`${labelClass} mt-3`}>Explanation<textarea className={`${inputClass} min-h-20`} value={slide.explanation} onChange={e => updateSlide(index, { explanation: e.target.value })} /></label></>
              <label className={`${labelClass} mt-3`}>Teacher speaker notes<textarea className={`${inputClass} min-h-16`} value={slide.speaker_notes} onChange={e => updateSlide(index, { speaker_notes: e.target.value })} /></label>
            </article>)}
              {deck.slides.length < 15 && <button type="button" onClick={() => setDeck(current => current ? { ...current, slides: [...current.slides, createBlankSlide(current.slides.length + 1)] } : current)} className="w-full rounded-xl border border-dashed border-white/20 py-3 text-xs font-semibold text-white/65 hover:border-pine/50 hover:text-white">+ Add editable slide</button>}
            </div>
          </div>}
        </div>
      </div>
    </section>
  );
}
