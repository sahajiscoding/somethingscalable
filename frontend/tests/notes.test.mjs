import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createNote,
  deleteNote,
  loadNotes,
  saveNotes,
  searchNotes,
  updateNote,
} from '../src/lib/notes.ts';
import { VIEWS } from '../src/lib/view.ts';

test('Notes is registered as a navigable application view', () => {
  assert.ok(VIEWS.includes('notes'));
});

function memoryStorage(initial = null) {
  let value = initial;
  return {
    getItem() { return value; },
    setItem(_key, next) { value = next; },
    value() { return value; },
  };
}

test('create and update notes retain identity and update edit time', () => {
  const original = createNote('note-1', 10);
  assert.deepEqual(original, {
    id: 'note-1', title: 'Untitled note', content: '', createdAt: 10, updatedAt: 10,
  });
  const edited = updateNote([original], original.id, { title: 'Class plan', content: 'Review fractions' }, 20);
  assert.equal(edited[0].title, 'Class plan');
  assert.equal(edited[0].content, 'Review fractions');
  assert.equal(edited[0].createdAt, 10);
  assert.equal(edited[0].updatedAt, 20);
  assert.equal(original.title, 'Untitled note', 'updates do not mutate existing state');
});

test('delete removes only the selected note', () => {
  const notes = [createNote('one', 1), createNote('two', 2)];
  assert.deepEqual(deleteNote(notes, 'one').map(note => note.id), ['two']);
  assert.equal(deleteNote(notes, 'missing').length, 2);
});

test('search matches title and body without case sensitivity and ignores blank queries', () => {
  const notes = [
    { ...createNote('one', 1), title: 'Fractions', content: 'Equivalent values' },
    { ...createNote('two', 2), title: 'Science', content: 'Plant cells' },
  ];
  assert.deepEqual(searchNotes(notes, '  FRACT ').map(note => note.id), ['one']);
  assert.deepEqual(searchNotes(notes, 'fraction').map(note => note.id), ['one']);
  assert.deepEqual(searchNotes(notes, 'PLANT').map(note => note.id), ['two']);
  assert.equal(searchNotes(notes, '   '), notes);
});

test('notes persist, restore sorted by most recently edited, and discard malformed entries', () => {
  const storage = memoryStorage();
  const notes = [createNote('older', 1), createNote('newer', 9)];
  assert.equal(saveNotes(storage, notes), true);
  assert.deepEqual(loadNotes(storage).map(note => note.id), ['newer', 'older']);

  storage.setItem('notes', JSON.stringify([
    { ...createNote('valid', 4) },
    { id: 'invalid', title: 8 },
  ]));
  assert.deepEqual(loadNotes(storage, 'notes').map(note => note.id), ['valid']);
});

test('storage failures and invalid JSON fail safely', () => {
  assert.deepEqual(loadNotes(null), []);
  assert.equal(saveNotes(null, []), false);
  assert.deepEqual(loadNotes(memoryStorage('{broken')), []);
  const unavailableStorage = { setItem() { throw new Error('quota'); } };
  assert.equal(saveNotes(unavailableStorage, []), false);
});
