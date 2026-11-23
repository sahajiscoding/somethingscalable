import { afterEach, describe, expect, it, vi } from 'vitest';
import { generatePracticeSet } from '../src/lib/api';

afterEach(() => vi.unstubAllGlobals());

const questions = Array.from({ length: 3 }, (_, index) => ({
  number: `Q${index + 1}`,
  text: `Question ${index + 1} about photosynthesis`,
  max_marks: 2,
  expected_answer: 'A clear model answer.',
  marking_scheme: 'Award one mark for each key point.',
  keywords: ['chlorophyll', 'light'],
}));

describe('batched Practice Questions API', () => {
  it('requests an entire question set in one backend call with the selected audience', async () => {
    const fetchMock = vi.fn(async (_url: string, _options: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => ({
        exam: {
          title: 'Photosynthesis Practice',
          topic: 'Photosynthesis',
          instructions: 'Answer all questions.',
          total_marks: 6,
          questions,
        },
        model: 'nvidia/nemotron-3.5-super-vl:free',
      }),
    }) as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    const result = await generatePracticeSet({
      topic: 'Explain photosynthesis in plants', grade: 'Class 9', difficulty: 'Medium',
      count: 3, marks: 6, model: 'selected-model',
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe('/api/generate-practice-set');
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({
      topic: 'Explain photosynthesis in plants', grade: 'Class 9', difficulty: 'Medium',
      count: 3, marks: 6, model: 'selected-model',
    });
    expect(result.exam.questions).toHaveLength(3);
  });

  it('uses anonymous Kilo access for the default free-model practice set', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({
        status: 'ok', title: 'Photosynthesis Practice', topic: 'Photosynthesis in plants',
        instructions: 'Answer all questions.', total_marks: 6, questions,
      }) } }] }),
    }) as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    const result = await generatePracticeSet({
      topic: 'Explain photosynthesis in plants', grade: 'Class 9', difficulty: 'Medium', count: 3, marks: 6,
    });

    expect(result.exam.questions).toHaveLength(3);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe('https://ai-gateway.kilo.ai/api/v1/chat/completions');
    expect(fetchMock.mock.calls[0][1].headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.stringify(fetchMock.mock.calls[0][1])).not.toMatch(/authorization|kilo_api_key/i);
  });

  it('rejects vague topics before sending a request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(generatePracticeSet({ topic: 'plants', grade: 'Class 9', difficulty: 'Medium', count: 3, marks: 6 }))
      .rejects.toThrow(/at least three words/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a partial batch instead of presenting an incomplete set', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        exam: { title: 'Partial', topic: 'Plants', instructions: 'Answer all.', total_marks: 6, questions: questions.slice(0, 2) },
        model: 'test-model',
      }),
    }) as unknown as Response));
    await expect(generatePracticeSet({ topic: 'Explain photosynthesis in plants', grade: 'Class 9', difficulty: 'Medium', count: 3, marks: 6, model: 'provider/paid-model' }))
      .rejects.toThrow(/incomplete practice set/i);
  });
});
