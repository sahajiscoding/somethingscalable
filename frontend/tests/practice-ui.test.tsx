import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Practice from '../src/views/Practice';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Practice Questions view', () => {
  it('uses a shrinkable preview column to prevent horizontal overflow on narrower layouts', () => {
    render(<Practice />);
    const section = screen.getByRole('region', { name: 'Practice Questions' });
    const columns = section.querySelector('.grid');
    const preview = section.querySelector('.grid > div');

    expect(columns).toHaveClass('min-w-0');
    expect(columns?.className).toContain('minmax(0,1fr)');
    expect(preview).toHaveClass('min-w-0');
  });

  it('generates and presents editable lesson slide fields in the separate teaching mode', async () => {
    const slides = Array.from({ length: 3 }, (_, index) => ({
      title: `Concept ${index + 1}`,
      key_points: ['Core point one', 'Core point two', 'Core point three'],
      explanation: 'A useful teacher explanation.',
      speaker_notes: 'Ask students to share an example.',
    }));
    const bookResearch = {
      query: 'Ganita Manjari Part 1',
      sources: [{
        provider: 'Google Books',
        title: 'Ganita Manjari Part 1',
        authors: ['A. Teacher'],
        published_date: '2024',
        description: 'Class 9 mathematics.',
        categories: ['Mathematics'],
        url: 'https://books.google.com/books?id=example',
      }],
    };
    const fetchMock = vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => url === '/api/research-book'
        ? { book_research: bookResearch }
        : { choices: [{ message: { content: JSON.stringify({ status: 'ok', title: 'Water Cycle', subtitle: 'A lesson', slides }) } }] },
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
    fireEvent.change(screen.getByLabelText(/specific book title/i), {
      target: { value: 'Ganita Manjari Part 1' },
    });
    fireEvent.change(screen.getByLabelText(/lesson content slides/i), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: /generate lesson slides/i }));

    expect(await screen.findByLabelText('Slide 1 title')).toHaveProperty('value', 'Concept 1');
    expect(await screen.findByText(/editable teacher presentation · 4 total slides/i)).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Free book search sources' })).toHaveTextContent('Ganita Manjari Part 1');
    expect(screen.getByRole('link', { name: 'Ganita Manjari Part 1' })).toHaveAttribute('href', 'https://books.google.com/books?id=example');
    expect(screen.getByLabelText('Slide 1 title')).toHaveProperty('value', 'Concept 1');
    expect(screen.getAllByLabelText(/key points/i)[0]).toHaveProperty('value', 'Core point one\nCore point two\nCore point three');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/research-book');
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body)).topic).toBe('Explain the water cycle for learners');
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body)).book_title).toBe('Ganita Manjari Part 1');
    expect(fetchMock.mock.calls[1][0]).toBe('https://ai-gateway.kilo.ai/api/v1/chat/completions');
    expect(fetchMock.mock.calls[1][1].credentials).toBe('omit');
    expect(fetchMock.mock.calls[1][1].headers).toEqual({ 'Content-Type': 'application/json' });
  });

  it('adds an AI-generated single slide from the teacher description', async () => {
    const slides = Array.from({ length: 3 }, (_, index) => ({
      title: `Concept ${index + 1}`,
      key_points: ['Core point one', 'Core point two', 'Core point three'],
      explanation: 'A useful teacher explanation.',
      speaker_notes: 'Ask students to share an example.',
    }));
    let modelCalls = 0;
    const fetchMock = vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => url === '/api/research-book'
        ? { book_research: null }
        : { choices: [{ message: { content: JSON.stringify(modelCalls++ === 0
          ? { status: 'ok', title: 'Water Cycle', subtitle: 'A lesson', slides }
          : { status: 'ok', slide: {
            title: 'Saving Water at Home',
            key_points: ['Fix leaks', 'Use less water', 'Reuse water safely'],
            explanation: 'Families can conserve clean water with small daily choices.',
            speaker_notes: 'Ask learners to choose one action to try.',
          } }) } }] },
    }) as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    render(<Practice model="" />);
    fireEvent.click(screen.getByRole('tab', { name: /teach with slides/i }));
    fireEvent.change(screen.getByLabelText(/topic and learning focus/i), {
      target: { value: 'Explain the water cycle and its stages' },
    });
    fireEvent.click(screen.getByRole('button', { name: /generate lesson slides/i }));
    expect(await screen.findByLabelText('Slide 1 title')).toHaveValue('Concept 1');

    fireEvent.change(screen.getByRole('textbox', { name: 'Describe the new slide' }), {
      target: { value: 'Explain how families can conserve clean water' },
    });
    fireEvent.click(screen.getByRole('button', { name: '+ Add 1 new slide' }));

    expect(await screen.findByLabelText('Slide 4 title')).toHaveValue('Saving Water at Home');
    expect(screen.getByRole('status')).toHaveTextContent(/one new editable slide generated/i);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('streams each generated practice question and updates the ready count as it arrives', async () => {
    const pendingRequests: Array<{ url: string; body: Record<string, unknown>; resolve: (response: Response) => void }> = [];
    const fetchMock = vi.fn((url: string, options: RequestInit) => new Promise<Response>(resolve => {
      pendingRequests.push({ url, body: JSON.parse(String(options.body)), resolve });
    }));
    vi.stubGlobal('fetch', fetchMock);

    render(<Practice model="provider/paid-model" />);
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
