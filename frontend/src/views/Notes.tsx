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

  const addNote = () => {
    const note = createNote(crypto.randomUUID());
    onChange([note, ...notes]);
    setSelectedId(note.id);
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
    <section className="overflow-hidden rounded-2xl border border-white/10 bg-canvas shadow-[0_20px_44px_rgba(0,0,0,.32)]" aria-labelledby="notes-heading">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-white/10 px-5 py-5 md:px-7">
        <div>
          <div className="text-[11px] font-bold tracking-[.18em] text-white/45 uppercase">Teacher workspace</div>
          <h1 id="notes-heading" className="mt-1 text-2xl font-bold tracking-tight">Notes</h1>
          <p className="mt-1 text-sm text-white/50">Capture lesson ideas, reminders, and feedback. Notes are saved in this browser only.</p>
        </div>
        <button type="button" onClick={() => { setAiOpen(open => !open); setAiError(''); }} className="rounded-xl border border-mint/40 bg-mint/10 px-4 py-2.5 text-sm font-bold text-mint transition hover:bg-mint/15">
          ✦ Draft with AI
        </button>
      </header>

      {aiOpen && (
        <form className="border-b border-white/10 bg-mint/[.04] px-5 py-5 md:px-7" onSubmit={event => { event.preventDefault(); void createAiNote(); }}>
          <h2 className="text-sm font-bold text-white">Create a note with AI</h2>
          <p className="mt-1 text-xs text-white/45">Describe what you need. The AI draft becomes a new note; existing notes are left unchanged.</p>
          <label className="mt-3 block">
            <span className="mb-1.5 block text-xs font-semibold text-white/70">What should the note cover?</span>
            <textarea value={aiPrompt} onChange={event => setAiPrompt(event.target.value)} maxLength={2000} required rows={3} placeholder="For example: Make concise revision notes on photosynthesis for Grade 8, with key terms and a short recap." className="w-full resize-y rounded-xl border border-white/15 bg-black/35 px-3.5 py-3 text-sm leading-6 text-white outline-none placeholder:text-white/35 focus:border-mint/60" />
          </label>
          <label className="mt-3 block max-w-lg">
            <span className="mb-1.5 block text-xs font-semibold text-white/70">Audience or level <span className="font-normal text-white/40">(optional)</span></span>
            <input value={aiAudience} onChange={event => setAiAudience(event.target.value)} maxLength={160} placeholder="e.g. Grade 8 students" className="w-full rounded-xl border border-white/15 bg-black/35 px-3.5 py-2.5 text-sm text-white outline-none placeholder:text-white/35 focus:border-mint/60" />
          </label>
          {aiError && <p role="alert" className="mt-3 text-sm text-crimson">AI note creation failed: {aiError}</p>}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button type="submit" disabled={aiBusy || !aiPrompt.trim()} className="rounded-xl bg-mint px-4 py-2.5 text-sm font-bold text-black transition hover:brightness-90 disabled:cursor-not-allowed disabled:opacity-50">{aiBusy ? 'Writing note…' : 'Generate note'}</button>
            <button type="button" onClick={() => { setAiOpen(false); setAiError(''); }} disabled={aiBusy} className="rounded-xl border border-white/15 px-4 py-2.5 text-sm font-semibold text-white/70 hover:bg-white/5 disabled:opacity-50">Cancel</button>
            <span className="text-[11px] text-white/40">Your prompt is sent to the configured AI model; it is not stored with your notes.</span>
          </div>
        </form>
      )}
      {aiMessage && <p role="status" className="border-b border-white/10 px-5 py-2.5 text-xs text-mint md:px-7">{aiMessage}</p>}

      <div className="grid min-h-[560px] md:grid-cols-[280px_minmax(0,1fr)]">
        <aside className="border-b border-white/10 bg-white/[.025] p-4 md:border-r md:border-b-0">
          <button type="button" onClick={addNote} className="mb-3 w-full rounded-xl bg-mint px-4 py-2.5 text-sm font-bold text-black transition hover:brightness-90">
            + New note
          </button>
          <label className="mb-3 block">
            <span className="sr-only">Search notes</span>
            <input
              type="search"
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder="Search notes…"
              className="w-full rounded-xl border border-white/10 bg-black/35 px-3.5 py-2.5 text-sm text-white outline-none placeholder:text-white/35 focus:border-mint/60"
            />
          </label>
          <div className="space-y-1" aria-label="Notes list">
            {visibleNotes.map(note => (
              <button
                key={note.id}
                type="button"
                onClick={() => setSelectedId(note.id)}
                aria-current={selectedId === note.id ? 'true' : undefined}
                className={`block w-full rounded-xl border px-3.5 py-3 text-left transition ${selectedId === note.id ? 'border-mint/35 bg-mint/10' : 'border-transparent hover:bg-white/5'}`}
              >
                <span className="block truncate text-sm font-semibold text-white">{note.title.trim() || 'Untitled note'}</span>
                <span className="mt-1 block truncate text-xs text-white/45">{note.content.trim() || 'No additional text'}</span>
                <span className="mt-2 block text-[10px] text-white/35">{dateLabel(note.updatedAt)}</span>
              </button>
            ))}
            {visibleNotes.length === 0 && (
              <p className="px-2 py-5 text-center text-xs leading-relaxed text-white/40">
                {notes.length ? 'No notes match your search.' : 'No notes yet. Create one to get started.'}
              </p>
            )}
          </div>
        </aside>

        <div className="flex min-h-[420px] flex-col p-5 md:p-7">
          {selected ? (
            <>
              <div className="mb-5 flex flex-wrap items-center justify-between gap-3 border-b border-white/10 pb-4">
                <span className="text-xs text-white/40">Edited {dateLabel(selected.updatedAt)}</span>
                <div className="flex gap-2">
                  <button type="button" onClick={downloadNote} className="rounded-lg border border-white/15 px-3 py-2 text-xs font-semibold text-white/75 hover:bg-white/5">Download .txt</button>
                  <button type="button" onClick={removeNote} className="rounded-lg border border-crimson/35 px-3 py-2 text-xs font-semibold text-crimson hover:bg-crimson/10">Delete</button>
                </div>
              </div>
              <label className="mb-3 block">
                <span className="sr-only">Note title</span>
                <input
                  value={selected.title}
                  onChange={event => edit({ title: event.target.value })}
                  placeholder="Note title"
                  className="w-full border-0 bg-transparent text-2xl font-bold tracking-tight text-white outline-none placeholder:text-white/30"
                />
              </label>
              <label className="flex min-h-[330px] flex-1 flex-col">
                <span className="sr-only">Note content</span>
                <textarea
                  value={selected.content}
                  onChange={event => edit({ content: event.target.value })}
                  placeholder="Start writing…"
                  className="min-h-[330px] flex-1 resize-y border-0 bg-transparent text-[15px] leading-7 text-white/80 outline-none placeholder:text-white/30"
                />
              </label>
              <p className="mt-3 text-[11px] text-white/35" aria-live="polite">Changes save automatically in this browser.</p>
            </>
          ) : (
            <div className="grid flex-1 place-items-center text-center">
              <div>
                <div aria-hidden="true" className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-white/5 text-2xl">✎</div>
                <h2 className="font-semibold text-white/80">Your notes, all in one place</h2>
                <p className="mt-1 text-sm text-white/40">Create a note to get started.</p>
                <button type="button" onClick={addNote} className="mt-4 rounded-xl bg-mint px-4 py-2.5 text-sm font-bold text-black hover:brightness-90">Create a note</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
