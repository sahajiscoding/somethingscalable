import React, { useState } from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Notes from '../src/views/Notes';
import type { Note } from '../src/lib/notes';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function Harness({ initial = [] }: { initial?: Note[] }) {
  const [notes, setNotes] = useState(initial);
  return <Notes notes={notes} onChange={setNotes} model="test-model" />;
}

const makeNote = (id: string, title: string, content: string): Note => ({
  id, title, content, createdAt: 1, updatedAt: 1,
});

describe('Notes user workflows', () => {
  it('creates a note and retains edits in the active notes state', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '+ New note' }));
    const title = screen.getByRole('textbox', { name: 'Note title' });
    const content = screen.getByRole('textbox', { name: 'Note content' });
    fireEvent.change(title, { target: { value: 'Class plan' } });
    fireEvent.change(content, { target: { value: 'Review fractions tomorrow.' } });
    expect(screen.getByRole('textbox', { name: 'Note title' })).toHaveValue('Class plan');
    expect(screen.getByRole('textbox', { name: 'Note content' })).toHaveValue('Review fractions tomorrow.');
    expect(screen.getByRole('button', { name: /Class plan/ })).toBeInTheDocument();
  });

  it('searches notes by body text and allows selection from matching results', () => {
    render(<Harness initial={[
      makeNote('a', 'Science', 'Plant cells and photosynthesis'),
      makeNote('b', 'Maths', 'Equivalent fractions'),
    ]} />);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search notes' }), { target: { value: 'PHOTOSYNTHESIS' } });
    expect(screen.getByRole('button', { name: /Science/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Maths/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Science/ }));
    expect(screen.getByRole('textbox', { name: 'Note content' })).toHaveValue('Plant cells and photosynthesis');
  });

  it('deletes the selected note only after confirmation', () => {
    vi.stubGlobal('confirm', vi.fn(() => true));
    render(<Harness initial={[makeNote('a', 'Keep this', 'One'), makeNote('b', 'Remove this', 'Two')]} />);
    fireEvent.click(screen.getByRole('button', { name: /Remove this/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(screen.queryByRole('button', { name: /Remove this/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Keep this/ })).toBeInTheDocument();
  });

  it('downloads the selected note as a text file', async () => {
    const createUrl = vi.fn(() => 'blob:note');
    const revokeUrl = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createUrl });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeUrl });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    render(<Harness initial={[makeNote('a', 'Lesson notes', 'Key points')]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Download .txt' }));
    expect(createUrl).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
    await waitFor(() => expect(revokeUrl).toHaveBeenCalledWith('blob:note'));
  });

  it('creates a new AI-written note from the request and optional audience', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(JSON.parse(String(init.body))).toMatchObject({
        prompt: 'Explain photosynthesis with key terms', audience: 'Grade 8', model: 'test-model',
      });
      return {
        ok: true,
        status: 200,
        json: async () => ({ note: { title: 'Photosynthesis', content: 'Plants use light to make glucose.' }, model: 'test-model' }),
      } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<Harness initial={[makeNote('existing', 'Existing note', 'Keep my work')]} />);
    fireEvent.click(screen.getByRole('button', { name: '✦ Draft with AI' }));
    fireEvent.change(screen.getByLabelText('What should the note cover?'), { target: { value: 'Explain photosynthesis with key terms' } });
    fireEvent.change(screen.getByLabelText(/Audience or level/), { target: { value: 'Grade 8' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate note' }));
    expect(await screen.findByRole('textbox', { name: 'Note title' })).toHaveValue('Photosynthesis');
    expect(screen.getByRole('textbox', { name: 'Note content' })).toHaveValue('Plants use light to make glucose.');
    expect(screen.getByRole('button', { name: /Existing note/ })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/AI draft created/);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('asks for a specific topic instead of saving a note for a one-word prompt', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '✦ Draft with AI' }));
    fireEvent.change(screen.getByLabelText('What should the note cover?'), { target: { value: 'poop.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate note' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/specific topic/i);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText('Your library is empty')).toBeInTheDocument();
  });

  it('shows AI failures without creating a fallback note', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 502,
      json: async () => ({ error: 'gateway unavailable' }),
    }) as Response));
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '✦ Draft with AI' }));
    fireEvent.change(screen.getByLabelText('What should the note cover?'), { target: { value: 'Make a note about atoms' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate note' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/gateway unavailable/);
    await waitFor(() => expect(screen.getByText('Your library is empty')).toBeInTheDocument());
  });
});
