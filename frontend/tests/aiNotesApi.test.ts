import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateNote } from '../src/lib/api';

afterEach(() => vi.unstubAllGlobals());

describe('AI note API client', () => {
  it('posts the teacher request and returns a complete model-written draft', async () => {
    const fetchMock = vi.fn(async (_url: string, _options: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => ({
        note: { title: 'Photosynthesis', content: 'Plants convert light energy into chemical energy.' },
        model: 'nvidia/nemotron-3.5-super-vl:free',
      }),
    }) as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    const result = await generateNote({ prompt: 'Summarize photosynthesis for Grade 8', audience: 'Grade 8', model: 'model-override' });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe('/api/generate-note');
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({
      prompt: 'Summarize photosynthesis for Grade 8', audience: 'Grade 8', model: 'model-override',
    });
    expect(result.note.title).toBe('Photosynthesis');
    expect(result.model).toBe('nvidia/nemotron-3.5-super-vl:free');
  });

  it('rejects a one-word prompt before making a backend request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(generateNote({ prompt: 'poop.' })).rejects.toThrow(/specific topic/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces backend errors rather than inventing note content', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 502,
      json: async () => ({ error: 'gateway unavailable' }),
    }) as unknown as Response));
    await expect(generateNote({ prompt: 'Create a note' })).rejects.toThrow('gateway unavailable');
  });

  it('rejects incomplete model responses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ note: { title: '', content: '' }, model: 'test' }),
    }) as unknown as Response));
    await expect(generateNote({ prompt: 'Create a note' })).rejects.toThrow('incomplete note');
  });
});
