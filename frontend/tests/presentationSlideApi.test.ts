import { afterEach, describe, expect, it, vi } from 'vitest';
import { generatePresentationSlide } from '../src/lib/api';

const previousSlides = [{
  title: 'Evaporation',
  key_points: ['Sun warms water', 'Liquid becomes vapor', 'Vapor rises'],
  explanation: 'Heat causes surface water to evaporate.',
  speaker_notes: 'Ask learners to name a local example.',
}];

const newSlide = {
  title: 'Saving Water at Home',
  key_points: ['Fix leaks', 'Use less water', 'Reuse water safely'],
  explanation: 'Families can conserve clean water with small daily choices.',
  speaker_notes: 'Ask learners to choose one action to try.',
};

afterEach(() => vi.unstubAllGlobals());

describe('AI-generated additional lesson slides', () => {
  it('generates a single contextual slide through anonymous free-model access', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ status: 'ok', slide: newSlide }) } }] }),
    }) as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    const result = await generatePresentationSlide({
      topic: 'Explain the water cycle and its stages',
      audience: 'Class 9',
      deckTitle: 'The Water Cycle',
      deckSubtitle: 'A connected system',
      description: 'Explain how families can conserve clean water.',
      existingSlides: previousSlides,
    });

    expect(result.slide).toEqual(newSlide);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe('https://ai-gateway.kilo.ai/api/v1/chat/completions');
    expect(fetchMock.mock.calls[0][1].headers).toEqual({ 'Content-Type': 'application/json' });
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(body.messages[1].content).toContain('Explain how families can conserve clean water');
    expect(body.messages[1].content).toContain('Evaporation');
    expect(JSON.stringify(fetchMock.mock.calls[0][1])).not.toMatch(/authorization|kilo_api_key/i);
  });

  it('keeps non-free models on the server route and includes existing-slide context', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ slide: newSlide, model: 'provider/paid-model' }),
    }) as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    await generatePresentationSlide({
      topic: 'Explain the water cycle and its stages',
      audience: 'Class 9',
      deckTitle: 'The Water Cycle',
      deckSubtitle: 'A connected system',
      description: 'Explain how families can conserve clean water.',
      existingSlides: previousSlides,
      model: 'provider/paid-model',
    });

    expect(fetchMock.mock.calls[0][0]).toBe('/api/generate-presentation-slide');
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(body.description).toContain('conserve clean water');
    expect(body.existing_slides[0].title).toBe('Evaporation');
  });
});
