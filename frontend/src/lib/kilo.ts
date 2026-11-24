const KILO_FREE_GATEWAY_URL = 'https://api.kilo.ai/api/gateway/chat/completions';
const ANONYMOUS_BUDGET_MS = 120_000;
const ANONYMOUS_REQUEST_TIMEOUT_MS = 90_000;
const KEYED_REQUEST_TIMEOUT_MS = 260_000;

async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  if (timeoutMs <= 0) throw new Error('Kilo request time budget exhausted.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Keep in sync with KILO_FREE_TEXT_MODELS in engine.py. The three IDs without
// a ':free' suffix are explicitly known free routes; a similar name alone
// doesn't mean a model is free.
export const KILO_FREE_TEXT_MODELS = [
  'nvidia/nemotron-3.5-super-vl:free',
  'baidu/ernie-5.5-flash-preview:free',
  'particle-ai/particle-1:free',
  'stealth/glyph-cluster',
  'reflection/beam-free',
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'dots-studio/dots-3-note-preview:free',
  'nvidia/nemotron-3.5-lightning:free',
  'kilo-auto/free',
] as const;

export interface KiloMessage {
  role: 'system' | 'user' | 'assistant';
  // Browser generation is text-only. Scanned images go through the server's
  // vision-aware engine instead, which only uses image-capable backups.
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

/** Anonymous access is restricted to :free IDs and explicitly known free routes. */
export function isKiloAnonymousFreeModel(model: string): boolean {
  const id = model.trim();
  return id.endsWith(':free') || (KILO_FREE_TEXT_MODELS as readonly string[]).includes(id);
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
      else if (char === '}' && --depth === 0) {
        try {
          return JSON.parse(trimmed.slice(start, index + 1));
        } catch {
          throw new KiloGatewayError('The free model returned invalid JSON. Please retry.');
        }
      }
    }
    throw new KiloGatewayError('The free model returned incomplete JSON. Please retry.');
  }
}

function errorDetail(body: unknown): string {
  if (typeof body !== 'object' || body === null || !('error' in body)) return '';
  const error = (body as { error?: unknown }).error;
  if (typeof error === 'string') return error;
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return String((error as { message?: unknown }).message || '');
  }
  return '';
}

function gatewayError(status: number, body: unknown, model: string): KiloGatewayError {
  if (status === 429) {
    return new KiloGatewayError(
      'Kilo anonymous free-model limit reached for this IP (up to 200 requests per hour).',
      status,
    );
  }
  if (status === 401 || status === 403) {
    return new KiloGatewayError(`Kilo did not allow anonymous access for ${model}.`, status);
  }
  return new KiloGatewayError(errorDetail(body) || `Kilo free-model request failed (HTTP ${status}).`, status);
}

function completion(body: unknown): { content: string; model?: string } {
  const data = body as {
    model?: unknown;
    choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
  } | null;
  const choice = data?.choices?.[0]?.message;
  const content = choice?.content?.trim() || choice?.reasoning_content?.trim();
  if (!content) throw new KiloGatewayError('Kilo returned an empty response. Please retry.');
  return { content, model: typeof data?.model === 'string' ? data.model : undefined };
}

/**
 * Use free models anonymously first. If those fail, the same-origin server can
 * use its configured Kilo key; that key is never present in browser code.
 */
export async function generateJsonWithKiloFree<T>(input: {
  model: string;
  messages: KiloMessage[];
  temperature?: number;
  maxTokens?: number;
  /** Shared application gate, sent only to the same-origin server. */
  appSecret?: string;
  /** Reports which model produced the valid response, including a backup. */
  onModelUsed?: (model: string) => void;
}): Promise<T> {
  const model = input.model.trim();
  if (!isKiloAnonymousFreeModel(model)) {
    throw new KiloGatewayError('Anonymous direct access is restricted to Kilo models ending in :free or known free routes.');
  }

  const payload = {
    model,
    messages: input.messages,
    temperature: input.temperature ?? 0.3,
    max_tokens: input.maxTokens ?? 2048,
    stream: false,
    response_format: { type: 'json_object' },
  };
  const serverHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
  if (input.appSecret) serverHeaders['X-App-Secret'] = input.appSecret;
  const anonymousDeadline = Date.now() + ANONYMOUS_BUDGET_MS;
  let useAnonymousRelay = false;

  function anonymousFetch(url: string, options: RequestInit): Promise<Response> {
    return fetchWithTimeout(url, options, Math.min(ANONYMOUS_REQUEST_TIMEOUT_MS, anonymousDeadline - Date.now()));
  }

  async function anonymousRequest(body: Record<string, unknown>): Promise<Response> {
    if (!useAnonymousRelay) {
      try {
        return await anonymousFetch(KILO_FREE_GATEWAY_URL, {
          method: 'POST',
          mode: 'cors',
          credentials: 'omit',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch {
        // A browser/CORS failure can be specific to the direct connection.
        // Keep using the anonymous relay for the remaining candidates.
        useAnonymousRelay = true;
      }
    }
    return anonymousFetch('/api/kilo-free', {
      method: 'POST',
      credentials: 'same-origin',
      headers: serverHeaders,
      body: JSON.stringify(body),
    });
  }

  const candidates = Array.from(new Set<string>([model, ...KILO_FREE_TEXT_MODELS]));
  let rateLimitReached = false;
  for (const candidate of candidates) {
    if (Date.now() >= anonymousDeadline) break;
    const candidatePayload = { ...payload, model: candidate };
    let response: Response;
    try {
      response = await anonymousRequest(candidatePayload);
      // Models such as Glyph Cluster do not implement JSON mode, even though
      // they can still be prompted to return JSON as plain text.
      if (response.status === 400 || response.status === 422) {
        const relaxed: Record<string, unknown> = { ...candidatePayload };
        delete relaxed.response_format;
        response = await anonymousRequest(relaxed);
      }
    } catch {
      throw new KiloGatewayError('The anonymous free-model request could not reach Kilo or the app server. Check your connection and retry.');
    }

    const body = await response.json().catch(() => ({})) as unknown;
    if (!response.ok) {
      const detail = errorDetail(body);
      if (useAnonymousRelay && response.status === 401 && detail === 'Missing or invalid X-App-Secret header.') {
        throw new KiloGatewayError(detail, 401);
      }
      if (response.status === 429) {
        rateLimitReached = true;
        continue;
      }
      throw gatewayError(response.status, body, candidate);
    }
    let result: { content: string; model?: string };
    let parsed: T;
    try {
      result = completion(body);
      parsed = decodeJson(result.content) as T;
    } catch (error) {
      throw error instanceof KiloGatewayError
        ? error
        : new KiloGatewayError('Kilo returned an unusable response. Please retry.');
    }
    input.onModelUsed?.(result.model || candidate);
    return parsed;
  }

  if (!rateLimitReached) {
    throw new KiloGatewayError('The selected free model request did not complete. Please retry.');
  }

  let response: Response;
  try {
    response = await fetchWithTimeout('/api/kilo-keyed', {
      method: 'POST',
      credentials: 'same-origin',
      headers: serverHeaders,
      body: JSON.stringify(payload),
    }, KEYED_REQUEST_TIMEOUT_MS);
  } catch {
    throw new KiloGatewayError('Free models were unavailable and the app server fallback could not be reached. Check your connection and retry.');
  }
  const body = await response.json().catch(() => ({})) as unknown;
  if (!response.ok) {
    throw new KiloGatewayError(
      errorDetail(body) || `The app server could not use the configured Kilo key (HTTP ${response.status}).`,
      response.status,
    );
  }
  const result = completion(body);
  const parsed = decodeJson(result.content) as T;
  input.onModelUsed?.(result.model || model);
  return parsed;
}
