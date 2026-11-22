export interface Note {
  id: string;
  title: string;
  content: string;
  createdAt: number;
  updatedAt: number;
}

export const NOTES_STORAGE_KEY = 'wht-notes-v1';

export function isSpecificNotePrompt(prompt: string): boolean {
  const terms = prompt.trim().split(/\s+/).filter(term => /[\p{L}\p{N}]/u.test(term));
  return terms.length >= 3;
}

const isNote = (value: unknown): value is Note => {
  if (typeof value !== 'object' || value === null) return false;
  const note = value as Partial<Note>;
  return (
    typeof note.id === 'string' &&
    typeof note.title === 'string' &&
    typeof note.content === 'string' &&
    typeof note.createdAt === 'number' &&
    Number.isFinite(note.createdAt) &&
    typeof note.updatedAt === 'number' &&
    Number.isFinite(note.updatedAt)
  );
};

export function sortNotes(notes: Note[]): Note[] {
  return [...notes].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function loadNotes(storage: Pick<Storage, 'getItem'> | null, key = NOTES_STORAGE_KEY): Note[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return sortNotes(parsed.filter(isNote));
  } catch {
    return [];
  }
}

export function saveNotes(storage: Pick<Storage, 'setItem'> | null, notes: Note[], key = NOTES_STORAGE_KEY): boolean {
  if (!storage) return false;
  try {
    storage.setItem(key, JSON.stringify(notes));
    return true;
  } catch {
    return false;
  }
}

export function createNote(id: string, now = Date.now()): Note {
  return { id, title: 'Untitled note', content: '', createdAt: now, updatedAt: now };
}

export function updateNote(notes: Note[], id: string, patch: Partial<Pick<Note, 'title' | 'content'>>, now = Date.now()): Note[] {
  return notes.map(note => note.id === id ? { ...note, ...patch, updatedAt: now } : note);
}

export function deleteNote(notes: Note[], id: string): Note[] {
  return notes.filter(note => note.id !== id);
}

export function searchNotes(notes: Note[], query: string): Note[] {
  const term = query.trim().toLocaleLowerCase();
  if (!term) return notes;
  return notes.filter(note => `${note.title}\n${note.content}`.toLocaleLowerCase().includes(term));
}
