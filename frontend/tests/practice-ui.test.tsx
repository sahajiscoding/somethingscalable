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

  it('makes exam-practice slides when requested without switching away from slide mode', async () => {
    const slideDeck = {
      status: 'ok',
      title: 'Class 9 Exam Practice',
      subtitle: 'Questions for revision',
      slides: [{
        title: 'Question 1: Force and acceleration',
        key_points: ['A 2 kg object accelerates at 3 m/s². Calculate the force acting on it.', 'Show the formula used.', 'Write the answer with units.'],
        explanation: '2 marks',
        speaker_notes: 'Answer: 6 N. Award one mark for F = ma and one mark for the correct answer and unit.',
      }],
    };
    const fetchMock = vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => url === '/api/research-book'
        ? { book_research: null }
        : { choices: [{ message: { content: JSON.stringify(slideDeck) } }] },
    }) as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    render(<Practice model="" />);
    fireEvent.click(screen.getByRole('tab', { name: /teach with slides/i }));
    fireEvent.change(screen.getByLabelText(/topic and learning focus/i), {
      target: { value: 'All chapters practice questions' },
    });
    fireEvent.change(screen.getByLabelText(/textbook or syllabus reference/i), {
      target: { value: 'Ganita Manjari Part 1 and 2' },
    });
    fireEvent.click(screen.getByRole('button', { name: /generate slides/i }));

    expect(await screen.findByLabelText('Slide 1 title')).toHaveValue('Question 1: Force and acceleration');
    expect(screen.getByRole('tab', { name: /teach with slides/i })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /practice questions/i })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByLabelText('Key points (one per line)')).toHaveValue(
      'A 2 kg object accelerates at 3 m/s². Calculate the force acting on it.\nShow the formula used.\nWrite the answer with units.',
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/research-book');
    const request = JSON.parse(String(fetchMock.mock.calls[1][1].body));
    expect(fetchMock.mock.calls[1][0]).toBe('https://api.kilo.ai/api/gateway/chat/completions');
    expect(request.messages[1].content).toContain('actual exam-practice question slides');
    expect(request.messages[1].content).toContain('Teacher-specified textbook reference: Ganita Manjari Part 1 and 2');
  });

  it('creates question-only practice slides without putting answers in the prompt notes guidance', async () => {
    const deck = {
      status: 'ok',
      title: 'Fractions Practice',
      subtitle: 'Questions only',
      slides: [{
        title: 'Question 1: Compare fractions',
        key_points: ['Compare 3/4 and 5/8.', 'Show your working.', 'State which fraction is greater.'],
        explanation: 'Practice question only.',
        speaker_notes: 'Give students time to solve independently.',
      }],
    };
    const fetchMock = vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => url === '/api/research-book'
        ? { book_research: null }
        : { choices: [{ message: { content: JSON.stringify(deck) } }] },
    }) as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    render(<Practice model="" />);
    fireEvent.click(screen.getByRole('tab', { name: /teach with slides/i }));
    const style = screen.getByLabelText(/slide style/i);
    expect(within(style).getByRole('option', { name: /questions only \(no answers anywhere\)/i })).toHaveValue('question-only');
    fireEvent.change(screen.getByLabelText(/topic and learning focus/i), {
      target: { value: 'Practice questions on fractions, questions only without answers' },
    });
    fireEvent.click(screen.getByRole('button', { name: /generate slides/i }));

    expect(await screen.findByText(/Question-only practice slides generated/i)).toBeInTheDocument();
    const prompt = JSON.parse(String(fetchMock.mock.calls[1][1].body)).messages[1].content;
    expect(prompt).toContain('absolutely no answers');
    expect(prompt).toContain('Do not include answers, solutions, hints');
    expect(screen.getByRole('tab', { name: /teach with slides/i })).toHaveAttribute('aria-selected', 'true');
  });

  it('uses uploaded PDF reference text when generating the slide deck', async () => {
    const resources = [{ name: 'source.pdf', text: 'Evaporation changes liquid water to vapor.', truncated: false, page_count: 1 }];
    const slides = Array.from({ length: 3 }, (_, index) => ({
      title: `Water cycle ${index + 1}`,
      key_points: ['Water changes state.', 'The Sun supplies energy.', 'Water returns as precipitation.'],
      explanation: 'An explanation grounded in the source.',
      speaker_notes: 'Teacher reference: source.pdf.',
    }));
    const fetchMock = vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => url === '/api/presentation-resources'
        ? { resources }
        : url === '/api/research-book'
          ? { book_research: null }
          : { choices: [{ message: { content: JSON.stringify({ status: 'ok', title: 'Water Cycle', subtitle: 'From the source', slides }) } }] },
    }) as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    render(<Practice model="" />);
    fireEvent.click(screen.getByRole('tab', { name: /teach with slides/i }));
    const file = new File(['Evaporation changes liquid water to vapor.'], 'source.pdf', { type: 'application/pdf' });
    fireEvent.change(screen.getByLabelText(/pdfs and teaching resources/i), { target: { files: [file] } });
    expect(await screen.findByText(/source.pdf/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/topic and learning focus/i), {
      target: { value: 'Explain the water cycle to students' },
    });
    fireEvent.click(screen.getByRole('button', { name: /generate slides/i }));

    expect(await screen.findByLabelText('Slide 1 title')).toHaveValue('Water cycle 1');
    const prompt = JSON.parse(String(fetchMock.mock.calls[2][1].body)).messages[1].content;
    expect(prompt).toContain('source.pdf');
    expect(prompt).toContain('Evaporation changes liquid water to vapor.');
  });

  it('auto-detects a teaching deck that asks to include practice questions', async () => {
    const slides = Array.from({ length: 3 }, (_, index) => ({
      title: `Photosynthesis ${index + 1}`,
      key_points: ['Plants use light energy.', 'Carbon dioxide and water are reactants.', 'Glucose stores chemical energy.'],
      explanation: 'A short explanation for the class.',
      speaker_notes: 'Teacher notes and answer guidance.',
    }));
    const fetchMock = vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => url === '/api/research-book'
        ? { book_research: null }
        : { choices: [{ message: { content: JSON.stringify({ status: 'ok', title: 'Photosynthesis', subtitle: 'Learn and practise', slides }) } }] },
    }) as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    render(<Practice model="" />);
    fireEvent.click(screen.getByRole('tab', { name: /teach with slides/i }));
    fireEvent.change(screen.getByLabelText(/topic and learning focus/i), {
      target: { value: 'Teach photosynthesis and include practice questions' },
    });
    fireEvent.click(screen.getByRole('button', { name: /generate slides/i }));

    expect(await screen.findByText(/Teaching and practice slides generated/i)).toBeInTheDocument();
    const request = JSON.parse(String(fetchMock.mock.calls[1][1].body));
    expect(request.messages[1].content).toContain('mixed teaching-and-practice deck');
    expect(screen.getByRole('tab', { name: /teach with slides/i })).toHaveAttribute('aria-selected', 'true');
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
    expect(screen.getByLabelText(/content slides/i)).not.toHaveAttribute('max');
    fireEvent.change(screen.getByLabelText(/topic and learning focus/i), {
      target: { value: 'Explain the water cycle for learners' },
    });
    fireEvent.change(screen.getByLabelText(/textbook or syllabus reference/i), {
      target: { value: 'Ganita Manjari Part 1' },
    });
    fireEvent.change(screen.getByLabelText(/content slides/i), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: /generate slides/i }));

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
    expect(fetchMock.mock.calls[1][0]).toBe('https://api.kilo.ai/api/gateway/chat/completions');
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
    fireEvent.click(screen.getByRole('button', { name: /generate slides/i }));
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
