import { afterEach, describe, expect, it, vi } from 'vitest';
import { generatePresentation } from '../src/lib/api';

afterEach(() => vi.unstubAllGlobals());

describe('practice presentation API client', () => {
  it('posts topic, audience, slide count, and the selected model', async () => {
    const slides = Array.from({ length: 3 }, (_, index) => ({
      title: `Slide ${index + 1}`,
      key_points: ['First point', 'Second point', 'Third point'],
      explanation: 'A clear explanation.',
      speaker_notes: 'A teacher note.',
    }));
    const fetchMock = vi.fn(async (_url: string, _options: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => ({
        presentation: { title: 'The Water Cycle', subtitle: 'How water moves', audience: 'Grade 8', slides },
        model: 'nvidia/nemotron-3.5-super-vl:free',
      }),
    }) as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    const result = await generatePresentation({
      topic: 'Explain the water cycle', audience: 'Grade 8', slideCount: 3, model: 'selected-model',
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe('/api/generate-presentation');
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({
      topic: 'Explain the water cycle', audience: 'Grade 8', slide_count: 3, model: 'selected-model',
    });
    expect(result.presentation.slides).toHaveLength(3);
  });

  it('counts words with whitespace, rejecting vague prompts before fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(generatePresentation({ topic: 'water', audience: 'Grade 8', slideCount: 5 })).rejects.toThrow(/at least three words/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects incomplete decks rather than returning an unusable preview', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ presentation: { title: 'Broken', slides: [] }, model: 'test' }),
    }) as unknown as Response));
    await expect(generatePresentation({ topic: 'Explain the water cycle', audience: 'Grade 8', slideCount: 3 })).rejects.toThrow(/incomplete slide deck/i);
  });
});
