import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateExam } from '../src/lib/api';

afterEach(() => vi.unstubAllGlobals());

describe('exam authoring through Kilo free models', () => {
  it('generates each question directly from the browser without a shared API key', async () => {
    const question = {
      number: 'Q1',
      text: 'Describe the role of chlorophyll in photosynthesis.',
      max_marks: 2,
      expected_answer: 'Chlorophyll absorbs light energy.',
      marking_scheme: 'One mark for absorbing light; one for energy conversion.',
      keywords: ['chlorophyll', 'light'],
    };
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(question) } }] }),
    }) as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    const result = await generateExam({
      topic: 'Photosynthesis in plants', grade: 'Class 9', difficulty: 'Medium', count: 1, marks: 2,
    });

    expect(result.exam.questions).toEqual([question]);
    expect(result.model).toBe('nvidia/nemotron-3.5-super-vl:free');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe('https://ai-gateway.kilo.ai/api/v1/chat/completions');
    expect(fetchMock.mock.calls[0][1].headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.stringify(fetchMock.mock.calls[0][1])).not.toMatch(/authorization|kilo_api_key/i);
  });
});
