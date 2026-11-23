import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateExam, generateNote, generatePracticeSet, generatePresentation, generatePresentationSlide } from '../src/lib/api';
import { KILO_FREE_TEXT_MODELS } from '../src/lib/kilo';

const gateway = 'https://api.kilo.ai/api/gateway/chat/completions';
const backup = 'particle-ai/particle-1:free';
const question = {
  number: 'Q1', text: 'Describe how plants use light energy.', max_marks: 2,
  expected_answer: 'Photosynthesis converts light energy to chemical energy.',
  marking_scheme: 'Award two marks for the conversion.', keywords: ['light', 'photosynthesis'],
};
const slide = {
  title: 'Light and Plants', key_points: ['Light', 'Chlorophyll', 'Glucose'],
  explanation: 'Plants use light to make glucose.', speaker_notes: 'Ask students for examples.',
};

function response(status: number, data: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => data } as Response;
}

function useKeyedFallback(completion: unknown) {
  const fetchMock = vi.fn(async (url: string, _options: RequestInit) => {
    if (url === '/api/research-book') return response(200, { book_research: null });
    if (url === '/api/kilo-keyed') {
      return response(200, { model: backup, choices: [{ message: { content: JSON.stringify(completion) } }] });
    }
    return response(429, { error: 'anonymous quota exceeded' });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function expectFallback(fetchMock: ReturnType<typeof useKeyedFallback>) {
  const calls = fetchMock.mock.calls;
  expect(calls.filter(([url]) => url === gateway)).toHaveLength(KILO_FREE_TEXT_MODELS.length);
  expect(calls.filter(([url]) => url === '/api/kilo-keyed')).toHaveLength(1);
  expect(JSON.stringify(calls)).not.toMatch(/authorization|kilo_api_key/i);
}

afterEach(() => vi.unstubAllGlobals());

describe('generation after anonymous Kilo quota is exhausted', () => {
  it('writes an exam question using the server fallback', async () => {
    const fetchMock = useKeyedFallback(question);
    const result = await generateExam({ topic: 'Photosynthesis in plants', grade: 'Class 9', difficulty: 'Medium', count: 1, marks: 2 });
    expect(result.exam.questions).toEqual([question]);
    expect(result.model).toBe(backup);
    expectFallback(fetchMock);
  });

  it('reports multiple models when different questions use different backups', async () => {
    const fetchMock = vi.fn(async (_url: string, options: RequestInit) => {
      const payload = JSON.parse(String(options.body));
      const number = String(payload.messages[1].content).match(/Generate Question (Q\d+)/)?.[1] || 'Q1';
      if (number === 'Q2' && payload.model === KILO_FREE_TEXT_MODELS[0]) {
        return response(429, { error: 'rate limited' });
      }
      return response(200, {
        model: payload.model,
        choices: [{ message: { content: JSON.stringify({ ...question, number }) } }],
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await generateExam({ topic: 'Photosynthesis in plants', grade: 'Class 9', difficulty: 'Medium', count: 2, marks: 4 });
    expect(result.exam.questions.map(item => item.number)).toEqual(['Q1', 'Q2']);
    expect(result.model).toBe('multiple models');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('writes study notes using the server fallback', async () => {
    const fetchMock = useKeyedFallback({ status: 'ok', title: 'Photosynthesis', content: 'Plants use light energy to make glucose.' });
    const result = await generateNote({ prompt: 'Make revision notes about photosynthesis' });
    expect(result.note.title).toBe('Photosynthesis');
    expect(result.model).toBe(backup);
    expectFallback(fetchMock);
  });

  it('creates a presentation using the server fallback', async () => {
    const fetchMock = useKeyedFallback({ status: 'ok', title: 'Photosynthesis', subtitle: 'How plants make food', slides: [slide] });
    const result = await generatePresentation({ topic: 'Photosynthesis in plants', audience: 'Class 9', slideCount: 1 });
    expect(result.presentation.slides).toEqual([slide]);
    expect(result.model).toBe(backup);
    expectFallback(fetchMock);
  });

  it('creates an additional slide using the server fallback', async () => {
    const fetchMock = useKeyedFallback({ status: 'ok', slide });
    const result = await generatePresentationSlide({
      topic: 'Photosynthesis in plants', audience: 'Class 9', deckTitle: 'Plants',
      deckSubtitle: 'How plants grow', description: 'Explain how plants use light', existingSlides: [],
    });
    expect(result.slide).toEqual(slide);
    expect(result.model).toBe(backup);
    expectFallback(fetchMock);
  });

  it('creates a practice set using the server fallback', async () => {
    const fetchMock = useKeyedFallback({
      status: 'ok', title: 'Plant Practice', topic: 'Photosynthesis in plants',
      instructions: 'Answer all questions.', total_marks: 2, questions: [question],
    });
    const result = await generatePracticeSet({
      topic: 'Photosynthesis in plants', grade: 'Class 9', difficulty: 'Medium', count: 1, marks: 2,
    });
    expect(result.exam.questions).toEqual([question]);
    expect(result.model).toBe(backup);
    expectFallback(fetchMock);
  });
});
