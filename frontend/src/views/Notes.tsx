import { useMemo, useState } from 'react';
import { generateNote, modelLabel } from '../lib/api';
import { createNote, deleteNote, searchNotes, sortNotes, updateNote, type Note } from '../lib/notes';

interface NotesProps {
  notes: Note[];
  onChange: (notes: Note[]) => void;
  model?: string;
}

const dateLabel = (timestamp: number) => new Intl.DateTimeFormat(undefined, {
  month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
}).format(timestamp);

const buttonSecondary = 'rounded-xl border border-white/10 bg-white/[.035] px-3.5 py-2.5 text-xs font-semibold text-white/75 transition hover:border-white/20 hover:bg-white/[.07]';

export default function Notes({ notes, onChange, model = '' }: NotesProps) {
  const [selectedId, setSelectedId] = useState<string | null>(notes[0]?.id ?? null);
  const [query, setQuery] = useState('');
  const [aiOpen, setAiOpen] = useState(false);
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiAudience, setAiAudience] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState('');
  const [aiMessage, setAiMessage] = useState('');
  const visibleNotes = useMemo(() => searchNotes(notes, query), [notes, query]);
  const selected = notes.find(note => note.id === selectedId) ?? null;
  const wordCount = selected?.content.trim() ? selected.content.trim().split(/\s+/).length : 0;

  const addNote = () => {
    const note = createNote(crypto.randomUUID());
    onChange([note, ...notes]);
    setSelectedId(note.id);
    setQuery('');
  };

  const createAiNote = async () => {
    if (aiBusy || !aiPrompt.trim()) return;
    setAiBusy(true);
    setAiError('');
    setAiMessage('');
    try {
      const result = await generateNote({
        prompt: aiPrompt.trim(),
        audience: aiAudience.trim() || undefined,
        model: model.trim() || undefined,
      });
      const now = Date.now();
      const note: Note = {
        ...createNote(crypto.randomUUID(), now),
        title: result.note.title,
        content: result.note.content,
      };
      onChange([note, ...notes]);
      setSelectedId(note.id);
      setQuery('');
      setAiPrompt('');
      setAiOpen(false);
      setAiMessage(`AI draft created with ${modelLabel(result.model)}. Review it before use.`);
    } catch (error) {
      setAiError(error instanceof Error ? error.message : String(error));
    } finally {
      setAiBusy(false);
    }
  };

  const edit = (patch: Partial<Pick<Note, 'title' | 'content'>>) => {
    if (selected) onChange(sortNotes(updateNote(notes, selected.id, patch)));
  };

  const removeNote = () => {
    if (!selected) return;
    if (!window.confirm(`Delete “${selected.title || 'Untitled note'}”? This cannot be undone.`)) return;
    const remaining = deleteNote(notes, selected.id);
    onChange(remaining);
    setSelectedId(remaining[0]?.id ?? null);
  };

  const downloadNote = () => {
    if (!selected) return;
    const blob = new Blob([`${selected.title || 'Untitled note'}\n\n${selected.content}`], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${(selected.title || 'note').trim().replace(/[^a-z0-9-_]+/gi, '-').replace(/^-|-$/g, '') || 'note'}.txt`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 100);
  };

  return (
    <section className="overflow-hidden rounded-[26px] border border-white/10 bg-canvas shadow-[0_24px_64px_rgba(0,0,0,.34)]" aria-labelledby="notes-heading">
      <header className="relative overflow-hidden border-b border-white/10 px-5 py-6 md:px-8 md:py-7">
        <div aria-hidden="true" className="pointer-events-none absolute -top-24 right-8 h-56 w-56 rounded-full bg-mint/[.07] blur-3xl" />
        <div className="relative flex flex-wrap items-center justify-between gap-5">
          <div className="flex min-w-[240px] flex-1 items-start gap-4">
            <div aria-hidden="true" className="grid h-12 w-12 flex-none place-items-center rounded-2xl border border-mint/20 bg-mint/[.09] text-xl text-mint shadow-[inset_0_1px_rgba(255,255,255,.08)]">✎</div>
            <div>
              <div className="flex flex-wrap items-center gap-2 text-[10px] font-bold tracking-[.16em] text-mint/80 uppercase">
                Teacher workspace <span aria-hidden="true" className="h-1 w-1 rounded-full bg-mint/50" /> Saved in this browser
              </div>
              <h1 id="notes-heading" className="mt-1 text-2xl font-bold tracking-tight text-white md:text-[28px]">Notes</h1>
              <p className="mt-1 max-w-xl text-sm leading-relaxed text-white/50">Keep lesson ideas, reminders, and feedback close at hand. Your notes stay on this device.</p>
            </div>
          </div>
          <div className="relative flex flex-wrap items-center gap-2">
            <div className="mr-1 rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-center">
              <span className="block text-base font-bold leading-none text-white">{notes.length}</span>
              <span className="mt-1 block text-[9px] font-bold tracking-wider text-white/40 uppercase">{notes.length === 1 ? 'note' : 'notes'}</span>
            </div>
            <button type="button" onClick={addNote} className="rounded-xl bg-mint px-4 py-2.5 text-sm font-extrabold text-[#102016] shadow-[0_5px_16px_rgba(57,199,137,.13)] transition hover:brightness-110">
              + New note
            </button>
            <button type="button" onClick={() => { setAiOpen(open => !open); setAiError(''); }} aria-expanded={aiOpen} className="rounded-xl border border-mint/30 bg-mint/[.07] px-4 py-2.5 text-sm font-bold text-mint transition hover:border-mint/50 hover:bg-mint/[.12]">
              ✦ Draft with AI
            </button>
          </div>
        </div>
      </header>

      {aiOpen && (
        <form className="border-b border-mint/15 bg-[linear-gradient(110deg,rgba(57,199,137,.075),rgba(255,255,255,.015)_62%)] px-5 py-5 md:px-8" onSubmit={event => { event.preventDefault(); void createAiNote(); }}>
          <div className="flex items-start gap-3">
            <div aria-hidden="true" className="mt-0.5 grid h-9 w-9 flex-none place-items-center rounded-xl bg-mint/10 text-mint">✦</div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-sm font-bold text-white">Create a note with AI</h2>
                <span className="text-[10px] text-white/35">A new draft—your existing notes remain untouched</span>
              </div>
              <p className="mt-1 text-xs leading-relaxed text-white/45">Describe the topic and the useful details you want included.</p>
              <label className="mt-4 block">
                <span className="mb-1.5 block text-xs font-semibold text-white/70">What should the note cover?</span>
                <textarea id="ai-note-prompt" aria-label="What should the note cover?" value={aiPrompt} onChange={event => setAiPrompt(event.target.value)} maxLength={2000} required rows={3} placeholder="For example: Make concise revision notes on photosynthesis for Grade 8, with key terms and a short recap." className="w-full resize-y rounded-xl border border-white/10 bg-[#101814]/75 px-3.5 py-3 text-sm leading-6 text-white outline-none placeholder:text-white/30 focus:border-mint/55 focus:ring-2 focus:ring-mint/10" />
                <span aria-hidden="true" className="mt-1 block text-right text-[10px] text-white/30">{aiPrompt.length}/2,000</span>
              </label>
              <label className="mt-2 block max-w-md">
                <span className="mb-1.5 block text-xs font-semibold text-white/70">Audience or level <span className="font-normal text-white/40">(optional)</span></span>
                <input value={aiAudience} onChange={event => setAiAudience(event.target.value)} maxLength={160} placeholder="e.g. Grade 8 students" className="w-full rounded-xl border border-white/10 bg-[#101814]/75 px-3.5 py-2.5 text-sm text-white outline-none placeholder:text-white/30 focus:border-mint/55 focus:ring-2 focus:ring-mint/10" />
              </label>
              {aiError && <p role="alert" className="mt-3 rounded-lg border border-crimson/20 bg-crimson/[.07] px-3 py-2 text-sm text-crimson">AI note creation failed: {aiError}</p>}
              <div className="mt-4 flex flex-wrap items-center gap-2.5">
                <button type="submit" disabled={aiBusy || !aiPrompt.trim()} className="rounded-xl bg-mint px-4 py-2.5 text-sm font-bold text-black transition hover:brightness-90 disabled:cursor-not-allowed disabled:opacity-50">{aiBusy ? 'Writing note…' : 'Generate note'}</button>
                <button type="button" onClick={() => { setAiOpen(false); setAiError(''); }} disabled={aiBusy} className={buttonSecondary + ' disabled:opacity-50'}>Cancel</button>
                <span className="text-[10px] leading-relaxed text-white/35">Your prompt is sent to the configured AI model and is not saved with your notes.</span>
              </div>
            </div>
          </div>
        </form>
      )}
      {aiMessage && <p role="status" className="border-b border-mint/10 bg-mint/[.035] px-5 py-2.5 text-xs text-mint md:px-8">{aiMessage}</p>}

      <div className="grid min-h-[600px] md:grid-cols-[290px_minmax(0,1fr)] lg:grid-cols-[315px_minmax(0,1fr)]">
        <aside className="border-b border-white/10 bg-[#101511]/55 p-4 md:border-r md:border-b-0 md:p-5">
          <div className="mb-3 flex items-center justify-between px-1">
            <h2 className="text-[10px] font-extrabold tracking-[.16em] text-white/45 uppercase">Your library</h2>
            <span className="rounded-full border border-white/10 px-2 py-0.5 text-[10px] font-semibold text-white/45">{visibleNotes.length} shown</span>
          </div>
          <label className="mb-4 block">
            <span className="sr-only">Search notes</span>
            <span className="relative block">
              <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-white/35"><circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.7"/><path d="m16 16 4 4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/></svg>
              <input
                type="search"
                value={query}
                onChange={event => setQuery(event.target.value)}
                placeholder="Search your notes"
                className="w-full rounded-xl border border-white/10 bg-black/25 py-2.5 pr-3 pl-9 text-sm text-white outline-none transition placeholder:text-white/30 focus:border-mint/45 focus:ring-2 focus:ring-mint/[.08]"
              />
            </span>
          </label>
          <div className="max-h-[min(62vh,700px)] space-y-1.5 overflow-y-auto pr-1" aria-label="Notes list">
            {visibleNotes.map(note => (
              <button
                key={note.id}
                type="button"
                onClick={() => setSelectedId(note.id)}
                aria-current={selectedId === note.id ? 'true' : undefined}
                className={`group block w-full rounded-xl border px-3.5 py-3 text-left transition ${selectedId === note.id ? 'border-mint/25 bg-mint/[.085] shadow-[inset_2px_0_0_rgba(57,199,137,.8)]' : 'border-transparent hover:border-white/[.07] hover:bg-white/[.035]'}`}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span aria-hidden="true" className={`grid h-6 w-6 flex-none place-items-center rounded-md text-[10px] ${selectedId === note.id ? 'bg-mint/15 text-mint' : 'bg-white/[.06] text-white/35 group-hover:text-white/65'}`}>✎</span>
                  <span className="block min-w-0 flex-1 truncate text-[13px] font-semibold text-white/90">{note.title.trim() || 'Untitled note'}</span>
                </span>
                <span className="mt-2 block overflow-hidden pl-8 text-xs leading-5 text-white/40 [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2]">{note.content.trim() || 'No additional text yet'}</span>
                <span className="mt-2 block pl-8 text-[10px] text-white/30">Updated {dateLabel(note.updatedAt)}</span>
              </button>
            ))}
            {visibleNotes.length === 0 && (
              <div className="rounded-2xl border border-dashed border-white/10 px-4 py-7 text-center">
                <div aria-hidden="true" className="mx-auto grid h-10 w-10 place-items-center rounded-xl bg-white/[.04] text-lg text-white/40">⌕</div>
                <p className="mt-3 text-xs font-semibold text-white/65">{notes.length ? 'No matching notes' : 'Your library is empty'}</p>
                <p className="mt-1 text-[11px] leading-relaxed text-white/35">{notes.length ? 'Try a different search or clear the filter.' : 'Create a note and your ideas will be easy to find here.'}</p>
                {notes.length > 0 && <button type="button" onClick={() => setQuery('')} className="mt-3 text-xs font-semibold text-mint hover:underline">Clear search</button>}
              </div>
            )}
          </div>
        </aside>

        <div className="flex min-h-[480px] flex-col bg-[radial-gradient(ellipse_at_top_right,rgba(255,255,255,.025),transparent_44%)] p-4 sm:p-6 md:p-7 lg:p-9">
          {selected ? (
            <>
              <div className="mb-6 flex flex-wrap items-center justify-between gap-3 border-b border-white/[.08] pb-4">
                <div className="flex items-center gap-2.5">
                  <span aria-hidden="true" className="grid h-8 w-8 place-items-center rounded-lg bg-white/[.045] text-sm text-mint/75">✎</span>
                  <div>
                    <span className="block text-[9px] font-extrabold tracking-[.16em] text-white/35 uppercase">Editing note</span>
                    <span className="mt-0.5 block text-[11px] text-white/55">Last edited {dateLabel(selected.updatedAt)}</span>
                  </div>
                </div>
                <div className="flex gap-2">
                  <button type="button" onClick={downloadNote} className={buttonSecondary}>Download .txt</button>
                  <button type="button" onClick={removeNote} className="rounded-xl border border-crimson/20 bg-crimson/[.035] px-3.5 py-2.5 text-xs font-semibold text-crimson/90 transition hover:border-crimson/40 hover:bg-crimson/[.09]">Delete</button>
                </div>
              </div>
              <label className="mb-4 block">
                <span className="sr-only">Note title</span>
                <input
                  value={selected.title}
                  onChange={event => edit({ title: event.target.value })}
                  placeholder="Give this note a title"
                  className="w-full border-0 bg-transparent px-0 py-1 text-[26px] font-bold tracking-tight text-white outline-none placeholder:text-white/25 focus:ring-0 sm:text-[30px]"
                />
              </label>
              <label className="flex min-h-[330px] flex-1 flex-col rounded-2xl border border-white/[.07] bg-black/[.12] px-4 py-3 sm:px-5 sm:py-4">
                <span className="sr-only">Note content</span>
                <textarea
                  value={selected.content}
                  onChange={event => edit({ content: event.target.value })}
                  placeholder="Start with a thought, a reminder, or a few key points…"
                  className="min-h-[330px] flex-1 resize-y border-0 bg-transparent text-[15px] leading-7 text-white/80 outline-none placeholder:text-white/25 focus:ring-0"
                />
              </label>
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 px-1 text-[10px] text-white/35">
                <p aria-live="polite" className="flex items-center gap-1.5"><span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-mint/70" /> Saved automatically in this browser</p>
                <p>{wordCount} {wordCount === 1 ? 'word' : 'words'}</p>
              </div>
            </>
          ) : (
            <div className="grid flex-1 place-items-center text-center">
              <div className="max-w-sm px-5 py-8">
                <div aria-hidden="true" className="mx-auto grid h-[62px] w-[62px] place-items-center rounded-[20px] border border-mint/15 bg-mint/[.06] text-2xl text-mint/75 shadow-[0_10px_35px_rgba(0,0,0,.15)]">✎</div>
                <h2 className="mt-5 text-lg font-bold text-white/90">{notes.length ? 'Choose a note to pick up where you left off' : 'Make space for your next good idea'}</h2>
                <p className="mt-2 text-sm leading-relaxed text-white/45">{notes.length ? 'Select a note from your library, or start a fresh one.' : 'Capture a quick reminder, plan a lesson, or draft a note with AI.'}</p>
                <div className="mt-5 flex flex-wrap justify-center gap-2">
                  <button type="button" onClick={addNote} className="rounded-xl bg-mint px-4 py-2.5 text-sm font-bold text-[#102016] transition hover:brightness-110">Create note</button>
                  <button type="button" aria-label="Open AI note writer" onClick={() => { setAiOpen(true); setAiError(''); }} className={buttonSecondary}>✦ Draft with AI</button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
