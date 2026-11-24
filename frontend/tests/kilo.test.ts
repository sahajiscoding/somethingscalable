import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateJsonWithKiloFree, isKiloAnonymousFreeModel, KILO_FREE_TEXT_MODELS } from '../src/lib/kilo';

const gateway = 'https://api.kilo.ai/api/gateway/chat/completions';
const message = [{ role: 'user' as const, content: 'Return a JSON object.' }];

function reply(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function success(content: string, model?: string): Response {
  return reply(200, { model, choices: [{ message: { content } }] });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Kilo free-model client', () => {
  it('allows :free IDs plus the explicitly known free routes, but not paid models', () => {
    expect(isKiloAnonymousFreeModel('nvidia/model:free')).toBe(true);
    expect(isKiloAnonymousFreeModel('reflection/beam-free')).toBe(true);
    expect(isKiloAnonymousFreeModel('stealth/glyph-cluster')).toBe(true);
    expect(isKiloAnonymousFreeModel('kilo-auto/free')).toBe(true);
    expect(isKiloAnonymousFreeModel('reflection/beam')).toBe(false);
    expect(isKiloAnonymousFreeModel('provider/paid-model')).toBe(false);
  });

  it('calls the gateway directly without an API key or credentials', async () => {
    const fetchMock = vi.fn(async (_url: string, _options: RequestInit) => success('{"status":"ok","value":7}'));
    vi.stubGlobal('fetch', fetchMock);
    const onModelUsed = vi.fn();

    const result = await generateJsonWithKiloFree<{ status: string; value: number }>({
      model: 'nvidia/model:free', messages: message, onModelUsed,
    });

    expect(result).toEqual({ status: 'ok', value: 7 });
    expect(onModelUsed).toHaveBeenCalledWith('nvidia/model:free');
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe(gateway);
    expect(options.credentials).toBe('omit');
    expect(options.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(String(options.body)).model).toBe('nvidia/model:free');
    expect(JSON.stringify(options)).not.toMatch(/authorization|kilo_api_key/i);
  });

  it('uses the same-origin anonymous relay when the browser blocks Kilo', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(success('{"status":"ok"}'));
    vi.stubGlobal('fetch', fetchMock);

    const result = await generateJsonWithKiloFree<{ status: string }>({
      model: 'nvidia/model:free', messages: message, appSecret: 'test-app-secret',
    });

    expect(result).toEqual({ status: 'ok' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe(gateway);
    expect(fetchMock.mock.calls[0][1].headers).toEqual({ 'Content-Type': 'application/json' });
    expect(fetchMock.mock.calls[1][0]).toBe('/api/kilo-free');
    expect(fetchMock.mock.calls[1][1].credentials).toBe('same-origin');
    expect(fetchMock.mock.calls[1][1].headers).toEqual({
      'Content-Type': 'application/json', 'X-App-Secret': 'test-app-secret',
    });
    expect(JSON.stringify(fetchMock.mock.calls[1][1])).not.toMatch(/authorization|kilo_api_key/i);
  });

  it('rotates through the free models after a 429 without retrying the same model', async () => {
    const fetchMock = vi.fn(async (_url: string, options: RequestInit) => {
      const model = JSON.parse(String(options.body)).model;
      return model === KILO_FREE_TEXT_MODELS[0]
        ? reply(429, { error: 'rate limited' })
        : success('{"ok":true}', model);
    });
    vi.stubGlobal('fetch', fetchMock);
    const onModelUsed = vi.fn();
    const result = await generateJsonWithKiloFree({
      model: KILO_FREE_TEXT_MODELS[0], messages: message, onModelUsed,
    });

    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([, opts]) => JSON.parse(String(opts.body)).model))
      .toEqual(KILO_FREE_TEXT_MODELS.slice(0, 2));
    expect(onModelUsed).toHaveBeenCalledWith(KILO_FREE_TEXT_MODELS[1]);
    expect(fetchMock.mock.calls.every(([url]) => url === gateway)).toBe(true);
  });

  it('keeps using the anonymous relay when direct access is blocked and a model is rate-limited', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(reply(429, { error: 'rate limited' }))
      .mockResolvedValueOnce(success('{"ok":true}'));
    vi.stubGlobal('fetch', fetchMock);
    const result = await generateJsonWithKiloFree({ model: KILO_FREE_TEXT_MODELS[0], messages: message });

    expect(result).toEqual({ ok: true });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([gateway, '/api/kilo-free', '/api/kilo-free']);
    expect(JSON.parse(String(fetchMock.mock.calls[2][1].body)).model).toBe(KILO_FREE_TEXT_MODELS[1]);
  });

  it('does not switch models for an unavailable selected model', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(503, { error: 'temporarily unavailable' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(generateJsonWithKiloFree({ model: 'particle-ai/particle-1:free', messages: message }))
      .rejects.toThrow(/temporarily unavailable/i);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body)).model).toBe('particle-ai/particle-1:free');
  });

  it('retries incomplete JSON once on the same selected model with a larger output budget', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(success('{"status":"ok","value":'))
      .mockResolvedValueOnce(success('{"status":"ok","value":7}'));
    vi.stubGlobal('fetch', fetchMock);

    const result = await generateJsonWithKiloFree({
      model: 'particle-ai/particle-1:free', messages: message, maxTokens: 1024,
    });

    expect(result).toEqual({ status: 'ok', value: 7 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    const retry = JSON.parse(String(fetchMock.mock.calls[1][1].body));
    expect(first.model).toBe('particle-ai/particle-1:free');
    expect(retry.model).toBe(first.model);
    expect(retry.max_tokens).toBe(2048);
    expect(retry.messages.at(-2)).toEqual({ role: 'assistant', content: '{"status":"ok","value":' });
    expect(retry.messages.at(-1).content).toMatch(/complete requested JSON object from the beginning/i);
  });

  it('retries an empty selected-model completion once without switching models', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(success(''))
      .mockResolvedValueOnce(success('{"status":"ok","value":9}'));
    vi.stubGlobal('fetch', fetchMock);

    const result = await generateJsonWithKiloFree({
      model: 'particle-ai/particle-1:free', messages: message, maxTokens: 1024,
    });

    expect(result).toEqual({ status: 'ok', value: 9 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const initial = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    const retry = JSON.parse(String(fetchMock.mock.calls[1][1].body));
    expect(initial.model).toBe('particle-ai/particle-1:free');
    expect(retry.model).toBe(initial.model);
    expect(retry.max_tokens).toBe(2048);
    expect(retry.messages.at(-1).content).toMatch(/previous response was empty/i);
  });

  it('reads text blocks from structured message content', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(200, {
      model: 'nvidia/model:free',
      choices: [{ message: { content: [{ type: 'output_text', text: '{"ok":true}' }] } }],
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(generateJsonWithKiloFree({ model: 'nvidia/model:free', messages: message }))
      .resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('does not switch models for a malformed selected-model completion', async () => {
    const fetchMock = vi.fn().mockResolvedValue(success('not JSON'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(generateJsonWithKiloFree({ model: 'particle-ai/particle-1:free', messages: message }))
      .rejects.toThrow(/invalid JSON/i);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('retries an unsupported JSON mode without that option for the same free model', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(reply(400, { error: 'unsupported response format' }))
      .mockResolvedValueOnce(success('{"ok":true}'));
    vi.stubGlobal('fetch', fetchMock);
    const result = await generateJsonWithKiloFree({ model: 'stealth/glyph-cluster', messages: message });
    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[1][1].body))).toMatchObject({ model: 'stealth/glyph-cluster' });
    expect(JSON.parse(String(fetchMock.mock.calls[1][1].body))).not.toHaveProperty('response_format');
  });

  it('uses the server key after all anonymous free models hit the limit', async () => {
    const fetchMock = vi.fn(async (url: string, _options: RequestInit) =>
      url === '/api/kilo-keyed'
        ? success('{"answer":42}', 'particle-ai/particle-1:free')
        : reply(429, { error: 'rate limited' }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const onModelUsed = vi.fn();

    const result = await generateJsonWithKiloFree({
      model: KILO_FREE_TEXT_MODELS[0], messages: message, appSecret: 'gate', onModelUsed,
    });

    expect(result).toEqual({ answer: 42 });
    expect(onModelUsed).toHaveBeenCalledWith('particle-ai/particle-1:free');
    expect(fetchMock).toHaveBeenCalledTimes(KILO_FREE_TEXT_MODELS.length + 1);
    const direct = fetchMock.mock.calls.slice(0, -1);
    expect(direct.map(([, opts]) => JSON.parse(String(opts.body)).model)).toEqual([...KILO_FREE_TEXT_MODELS]);
    expect(direct.every(([url, opts]) => url === gateway && opts.credentials === 'omit')).toBe(true);
    expect(direct.every(([, opts]) => JSON.stringify(opts.headers) === '{"Content-Type":"application/json"}')).toBe(true);
    const [url, options] = fetchMock.mock.calls.at(-1)!;
    expect(url).toBe('/api/kilo-keyed');
    expect(options.credentials).toBe('same-origin');
    expect(options.headers).toEqual({ 'Content-Type': 'application/json', 'X-App-Secret': 'gate' });
    expect(JSON.parse(String(options.body)).messages).toEqual(message);
    expect(JSON.stringify(fetchMock.mock.calls)).not.toMatch(/authorization|kilo_api_key/i);
  });

  it('does not use backups or the keyed route when the selected model request times out', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url: string, options: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const pending = generateJsonWithKiloFree({ model: KILO_FREE_TEXT_MODELS[0], messages: message });
    const rejection = expect(pending).rejects.toThrow(/could not reach Kilo/i);
    await vi.advanceTimersByTimeAsync(120_000);
    await rejection;
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([gateway, '/api/kilo-free']);
  });

  it('shows a clear error if no server key is configured', async () => {
    const fetchMock = vi.fn(async (url: string) => url === '/api/kilo-keyed'
      ? reply(503, { error: 'Anonymous Kilo access failed and no KILO_API_KEY is configured on the server.' })
      : reply(429, { error: 'rate limited' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(generateJsonWithKiloFree({ model: KILO_FREE_TEXT_MODELS[0], messages: message }))
      .rejects.toThrow(/no KILO_API_KEY.*configured/i);
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe('/api/kilo-keyed');
  });

  it('never sends paid models through the anonymous or keyed free client', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(generateJsonWithKiloFree({ model: 'provider/paid-model', messages: message }))
      .rejects.toThrow(/ending in :free/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
