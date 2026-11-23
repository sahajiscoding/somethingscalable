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

  it('accepts a shorter complete deck when the model cannot return every requested slide', async () => {
    const slides = Array.from({ length: 3 }, (_, index) => ({
      title: `Slide ${index + 1}`,
      key_points: ['One point', 'Another point', 'Final point'],
      explanation: 'A complete explanation.',
      speaker_notes: 'A useful teaching note.',
    }));
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        presentation: { title: 'The Water Cycle', subtitle: '', audience: 'Class 9', slides },
        model: 'provider/paid-model',
      }),
    }) as unknown as Response));

    const result = await generatePresentation({
      topic: 'Explain the water cycle and its stages', audience: 'Class 9', slideCount: 15, model: 'provider/paid-model',
    });

    expect(result.presentation.slides).toHaveLength(3);
  });

  it('counts words with whitespace, rejecting vague prompts before fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(generatePresentation({ topic: 'water', audience: 'Grade 8', slideCount: 5 })).rejects.toThrow(/at least three words/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends an explicitly named book to the free lookup flow and returns source references', async () => {
    const slides = Array.from({ length: 3 }, (_, index) => ({
      title: `Slide ${index + 1}`,
      key_points: ['First point', 'Second point', 'Third point'],
      explanation: 'A clear explanation.',
      speaker_notes: 'A teacher note.',
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
        : { choices: [{ message: { content: JSON.stringify({ status: 'ok', title: 'Ganita Manjari', subtitle: 'Part 1', slides }) } }] },
    }) as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    const result = await generatePresentation({
      topic: 'Teach algebra concepts to class nine', audience: 'Class 9', slideCount: 3,
      bookTitle: '  Ganita Manjari Part 1  ',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/research-book');
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body)).book_title).toBe('Ganita Manjari Part 1');
    expect(fetchMock.mock.calls[1][0]).toBe('https://api.kilo.ai/api/gateway/chat/completions');
    expect(fetchMock.mock.calls[1][1].credentials).toBe('omit');
    expect(fetchMock.mock.calls[1][1].headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(String(fetchMock.mock.calls[1][1].body)).messages[1].content).toContain('Ganita Manjari Part 1');
    expect(result.bookResearch).toEqual(bookResearch);
  });

  it('rejects incomplete decks rather than returning an unusable preview', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ presentation: { title: 'Broken', slides: [] }, model: 'test' }),
    }) as unknown as Response));
    await expect(generatePresentation({ topic: 'Explain the water cycle', audience: 'Grade 8', slideCount: 3, model: 'provider/paid-model' })).rejects.toThrow(/no usable slides/i);
  });
});
