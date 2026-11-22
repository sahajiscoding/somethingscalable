import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Practice from '../src/views/Practice';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

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
        presentation: { title: 'Water Cycle', subtitle: 'A lesson', audience: 'Class 9', slides },
        model: 'nvidia/nemotron-3.5-super-vl:free',
      }),
    }) as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    render(<Practice model="" />);
    fireEvent.click(screen.getByRole('tab', { name: /teach with slides/i }));
    const audience = screen.getByLabelText(/learner audience/i);
    expect(within(audience).getAllByRole('option').map(option => option.textContent)).toEqual([
      'Class 1', 'Class 2', 'Class 3', 'Class 4', 'Class 5', 'Class 6', 'Class 7', 'Class 8', 'Class 9', 'College',
    ]);
    expect(audience).toHaveProperty('value', 'Class 9');
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
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body)).audience).toBe('Class 9');
  });

  it('streams each generated practice question and updates the ready count as it arrives', async () => {
    const pendingRequests: Array<{ url: string; body: Record<string, unknown>; resolve: (response: Response) => void }> = [];
    const fetchMock = vi.fn((url: string, options: RequestInit) => new Promise<Response>(resolve => {
      pendingRequests.push({ url, body: JSON.parse(String(options.body)), resolve });
    }));
    vi.stubGlobal('fetch', fetchMock);

    render(<Practice />);
    fireEvent.change(screen.getByLabelText(/topic and learning focus/i), {
      target: { value: 'Explain photosynthesis in plants' },
    });
    fireEvent.change(screen.getByLabelText(/number of questions/i), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: /generate practice set/i }));

    expect(await screen.findByText(/0 \/ 2 ready/i)).toBeTruthy();
    await waitFor(() => expect(pendingRequests).toHaveLength(2));
    expect(pendingRequests.every(request => request.url === '/api/generate-exam-question')).toBe(true);
    expect(pendingRequests.map(request => request.body.number).sort()).toEqual(['Q1', 'Q2']);

    const respond = (request: typeof pendingRequests[number]) => request.resolve({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        question: {
          number: request.body.number,
          text: `Question ${request.body.number} about photosynthesis`,
          max_marks: 2,
          expected_answer: 'A complete model answer.',
          marking_scheme: 'Award marks for each key point.',
          keywords: ['light', 'chlorophyll'],
        },
        model: 'test-model',
      }),
    } as Response);

    respond(pendingRequests.find(request => request.body.number === 'Q1')!);
    expect(await screen.findByText(/1 \/ 2 ready/i)).toBeTruthy();
    expect(screen.getByRole('progressbar', { name: /practice questions generated/i })).toHaveAttribute('aria-valuenow', '1');

    respond(pendingRequests.find(request => request.body.number === 'Q2')!);
    expect(await screen.findByText(/2 \/ 2 questions/i)).toBeTruthy();
    expect(screen.getByRole('progressbar', { name: /practice questions generated/i })).toHaveAttribute('aria-valuenow', '2');
  });
});
