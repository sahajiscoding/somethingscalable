import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Practice from '../src/views/Practice';

afterEach(() => vi.unstubAllGlobals());

describe('Practice Questions view', () => {
  it('generates and presents editable lesson slide fields in the separate teaching mode', async () => {
    const slides = Array.from({ length: 3 }, (_, index) => ({
      title: `Concept ${index + 1}`,
      key_points: ['Core point one', 'Core point two', 'Core point three'],
      explanation: 'A useful teacher explanation.',
      speaker_notes: 'Ask students to share an example.',
    }));
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        presentation: { title: 'Water Cycle', subtitle: 'A lesson', audience: 'Grade 8', slides },
        model: 'nvidia/nemotron-3.5-super-vl:free',
      }),
    }) as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    render(<Practice model="" />);
    fireEvent.click(screen.getByRole('tab', { name: /teach with slides/i }));
    fireEvent.change(screen.getByLabelText(/topic and learning focus/i), {
      target: { value: 'Explain the water cycle for learners' },
    });
    fireEvent.change(screen.getByLabelText(/lesson content slides/i), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: /generate lesson slides/i }));

    expect(await screen.findByLabelText('Slide 1 title')).toHaveProperty('value', 'Concept 1');
    expect(await screen.findByText(/editable teacher presentation · 4 total slides/i)).toBeTruthy();
    expect(screen.getByLabelText('Slide 1 title')).toHaveProperty('value', 'Concept 1');
    expect(screen.getAllByLabelText(/key points/i)[0]).toHaveProperty('value', 'Core point one\nCore point two\nCore point three');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe('/api/generate-presentation');
  });
});
