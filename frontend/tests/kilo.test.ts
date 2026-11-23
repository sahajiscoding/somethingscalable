import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateJsonWithKiloFree, isKiloAnonymousFreeModel } from '../src/lib/kilo';

afterEach(() => vi.unstubAllGlobals());

describe('anonymous Kilo free-model client', () => {
  it('restricts direct unauthenticated requests to model IDs ending in :free', () => {
    expect(isKiloAnonymousFreeModel('nvidia/model:free')).toBe(true);
    expect(isKiloAnonymousFreeModel('provider/model')).toBe(false);
  });

  it('calls the documented gateway directly with no API key or credentials', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: '{"status":"ok","value":7}' } }] }),
    }) as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    const result = await generateJsonWithKiloFree<{ status: string; value: number }>({
      model: 'nvidia/model:free',
      messages: [{ role: 'user', content: 'Return a JSON object.' }],
    });

    expect(result).toEqual({ status: 'ok', value: 7 });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.kilo.ai/api/gateway/chat/completions');
    expect((options as RequestInit).credentials).toBe('omit');
    expect((options as RequestInit).headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(String((options as RequestInit).body)).model).toBe('nvidia/model:free');
    expect(JSON.stringify(options)).not.toMatch(/authorization|kilo_api_key/i);
  });

  it('falls back to the same-origin anonymous relay when the browser blocks Kilo', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: '{"status":"ok"}' } }] }),
      } as Response);
    vi.stubGlobal('fetch', fetchMock);

    const result = await generateJsonWithKiloFree<{ status: string }>({
      model: 'nvidia/model:free',
      messages: [{ role: 'user', content: 'Return a JSON object.' }],
      appSecret: 'test-app-secret',
    });

    expect(result).toEqual({ status: 'ok' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.kilo.ai/api/gateway/chat/completions');
    expect(fetchMock.mock.calls[0][1].headers).toEqual({ 'Content-Type': 'application/json' });
    expect(fetchMock.mock.calls[1][0]).toBe('/api/kilo-free');
    expect(fetchMock.mock.calls[1][1].credentials).toBe('same-origin');
    expect(fetchMock.mock.calls[1][1].headers).toEqual({
      'Content-Type': 'application/json', 'X-App-Secret': 'test-app-secret',
    });
    expect(JSON.stringify(fetchMock.mock.calls[1][1])).not.toMatch(/authorization|kilo_api_key/i);
  });

  it('never sends paid models through anonymous access', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(generateJsonWithKiloFree({
      model: 'provider/paid-model',
      messages: [{ role: 'user', content: 'test' }],
    })).rejects.toThrow(/ending in :free/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not retry an anonymous request with an API key after a rate limit', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 429,
      json: async () => ({ error: { message: 'rate limited' } }),
    }) as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);
    await expect(generateJsonWithKiloFree({
      model: 'nvidia/model:free',
      messages: [{ role: 'user', content: 'test' }],
    })).rejects.toThrow(/200 requests per hour/i);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
