const KILO_FREE_GATEWAY_URL = 'https://api.kilo.ai/api/gateway/chat/completions';

export interface KiloMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export class KiloGatewayError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'KiloGatewayError';
    this.status = status;
  }
}

/** Anonymous browser access is intentionally restricted to Kilo's :free models. */
export function isKiloAnonymousFreeModel(model: string): boolean {
  return model.trim().endsWith(':free');
}

function decodeJson(content: string): unknown {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    if (start < 0) throw new KiloGatewayError('The free model returned invalid JSON. Please retry.');
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < trimmed.length; index++) {
      const char = trimmed[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
      } else if (char === '"') inString = true;
      else if (char === '{') depth++;
      else if (char === '}' && --depth === 0) return JSON.parse(trimmed.slice(start, index + 1));
    }
    throw new KiloGatewayError('The free model returned incomplete JSON. Please retry.');
  }
}

function gatewayError(status: number, body: unknown, model: string): KiloGatewayError {
  if (status === 429) {
    return new KiloGatewayError(
      'Kilo anonymous free-model limit reached for this IP (up to 200 requests per hour). Wait and retry, or use another :free model.',
      status,
    );
  }
  if (status === 401 || status === 403) {
    return new KiloGatewayError(
      `Kilo did not allow anonymous access for ${model}. Anonymous browser calls are only enabled for models ending in :free.`,
      status,
    );
  }
  const detail = typeof body === 'object' && body !== null && 'error' in body
    ? String((body as { error?: { message?: string } | string }).error &&
      typeof (body as { error?: { message?: string } }).error === 'object'
      ? (body as { error: { message?: string } }).error.message || ''
      : (body as { error?: string }).error || '')
    : '';
  return new KiloGatewayError(detail || `Kilo free-model request failed (HTTP ${status}).`, status);
}

/**
 * Call Kilo directly from the user's browser without an Authorization header.
 * Never pass a KILO_API_KEY here: anonymous access is limited to :free models.
 */
export async function generateJsonWithKiloFree<T>(input: {
  model: string;
  messages: KiloMessage[];
  temperature?: number;
  maxTokens?: number;
  /** Shared application gate, used only for the same-origin CORS fallback. */
  appSecret?: string;
}): Promise<T> {
  const model = input.model.trim();
  if (!isKiloAnonymousFreeModel(model)) {
    throw new KiloGatewayError('Anonymous direct access is restricted to Kilo models ending in :free.');
  }

  const payload = {
    model,
    messages: input.messages,
    temperature: input.temperature ?? 0.3,
    max_tokens: input.maxTokens ?? 2048,
    stream: false,
    response_format: { type: 'json_object' },
  };

  let response: Response;
  try {
    response = await fetch(KILO_FREE_GATEWAY_URL, {
      method: 'POST',
      mode: 'cors',
      credentials: 'omit',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    // Some free models do not implement JSON mode. Retry once without that
    // optional OpenAI-compatible parameter; never add authentication on retry.
    if (response.status === 400 || response.status === 422) {
      const relaxed = { ...payload } as Record<string, unknown>;
      delete relaxed.response_format;
      response = await fetch(KILO_FREE_GATEWAY_URL, {
        method: 'POST',
        mode: 'cors',
        credentials: 'omit',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(relaxed),
      });
    }
  } catch {
    // Browsers can block the public gateway preflight on some networks. Retry
    // through our same-origin backend, which forwards only :free requests and
    // still omits Kilo Authorization credentials.
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (input.appSecret) headers['X-App-Secret'] = input.appSecret;
      response = await fetch('/api/kilo-free', {
        method: 'POST',
        credentials: 'same-origin',
        headers,
        body: JSON.stringify(payload),
      });
      if (response.status === 400 || response.status === 422) {
        const relaxed = { ...payload } as Record<string, unknown>;
        delete relaxed.response_format;
        response = await fetch('/api/kilo-free', {
          method: 'POST',
          credentials: 'same-origin',
          headers,
          body: JSON.stringify(relaxed),
        });
      }
    } catch {
      throw new KiloGatewayError(
        'Could not reach Kilo directly or through the app server. Check your connection and retry.',
      );
    }
  }

  const body = await response.json().catch(() => ({})) as unknown;
  if (!response.ok) throw gatewayError(response.status, body, model);

  const choice = (body as { choices?: Array<{ message?: { content?: string; reasoning_content?: string } }> })
    ?.choices?.[0]?.message;
  const content = choice?.content?.trim() || choice?.reasoning_content?.trim();
  if (!content) throw new KiloGatewayError('Kilo returned an empty response. Please retry.');
  return decodeJson(content) as T;
}
