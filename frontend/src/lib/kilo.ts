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

function contentText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    return value.map(part => {
      if (typeof part === 'string') return part;
      if (typeof part === 'object' && part !== null && 'text' in part) {
        const text = (part as { text?: unknown }).text;
        return typeof text === 'string' ? text : '';
      }
      return '';
    }).filter(Boolean).join('\n').trim();
  }
  if (typeof value === 'object' && value !== null && 'text' in value) {
    const text = (value as { text?: unknown }).text;
    return typeof text === 'string' ? text.trim() : '';
  }
  return '';
}

function completion(body: unknown): { content: string; model?: string } {
  const data = body as {
    model?: unknown;
    choices?: Array<{
      text?: unknown;
      message?: { content?: unknown; reasoning_content?: unknown; refusal?: unknown };
    }>;
  } | null;
  const choice = data?.choices?.[0];
  const message = choice?.message;
  const content = contentText(message?.content) || contentText(message?.reasoning_content) ||
    contentText(message?.refusal) || contentText(choice?.text);
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

  async function requestCandidate(body: Record<string, unknown>): Promise<Response> {
    let response = await anonymousRequest(body);
    // Some free routes reject JSON mode. Retry the same model without it.
    if (response.status === 400 || response.status === 422) {
      const relaxed: Record<string, unknown> = { ...body };
      delete relaxed.response_format;
      response = await anonymousRequest(relaxed);
    }
    return response;
  }

  const candidates = Array.from(new Set<string>([model, ...KILO_FREE_TEXT_MODELS]));
  let rateLimitReached = false;
  for (const candidate of candidates) {
    if (Date.now() >= anonymousDeadline) break;
    const candidatePayload = { ...payload, model: candidate };
    let response: Response;
    try {
      response = await requestCandidate(candidatePayload);
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
    let retryAttempted = false;

    async function retrySameModel(partialContent?: string): Promise<{ content: string; model?: string } | null> {
      const currentMaxTokens = Number(candidatePayload.max_tokens) || 2048;
      let retryMessages: KiloMessage[];
      if (partialContent) {
        retryMessages = [
          ...input.messages,
          { role: 'assistant', content: partialContent },
          { role: 'user', content: 'Your previous JSON response was cut off. Restart and return the complete requested JSON object from the beginning. Keep every field concise and do not add commentary.' },
        ];
      } else {
        let lastUserIndex = -1;
        for (let index = input.messages.length - 1; index >= 0; index--) {
          if (input.messages[index].role === 'user') {
            lastUserIndex = index;
            break;
          }
        }
        const retryReminder = 'The previous response was empty. Return the complete requested JSON object now, with concise fields and no commentary.';
        retryMessages = input.messages.map((message, index) => index === lastUserIndex
          ? { ...message, content: `${message.content}\n\n${retryReminder}` }
          : message);
      }
      const retryPayload = {
        ...candidatePayload,
        max_tokens: Math.min(16384, Math.max(currentMaxTokens + 1024, currentMaxTokens * 2)),
        messages: retryMessages,
      };
      const retryResponse = await requestCandidate(retryPayload);
      const retryBody = await retryResponse.json().catch(() => ({})) as unknown;
      if (retryResponse.status === 429) {
        rateLimitReached = true;
        return null;
      }
      if (!retryResponse.ok) throw gatewayError(retryResponse.status, retryBody, candidate);
      try {
        return completion(retryBody);
      } catch (error) {
        if (error instanceof KiloGatewayError && /empty response/i.test(error.message)) {
          throw new KiloGatewayError('Kilo returned an empty response twice. Please retry or select another model.');
        }
        throw error;
      }
    }

    try {
      try {
        result = completion(body);
      } catch (error) {
        if (!(error instanceof KiloGatewayError) || !/empty response/i.test(error.message)) throw error;
        retryAttempted = true;
        const retryResult = await retrySameModel();
        if (!retryResult) continue;
        result = retryResult;
      }

      try {
        parsed = decodeJson(result.content) as T;
      } catch (error) {
        if (!(error instanceof KiloGatewayError) || !/incomplete JSON/i.test(error.message)) throw error;
        if (retryAttempted) {
          throw new KiloGatewayError('Kilo returned an empty or incomplete response after retrying the selected model. Please try again.');
        }

        // A capped free-model completion can be cut off mid-JSON. Retry only
        // the same model once, with more output budget and a concise restart
        // instruction. Model backups remain reserved for actual rate limits.
        retryAttempted = true;
        const retryResult = await retrySameModel(result.content);
        if (!retryResult) continue;
        result = retryResult;
        try {
          parsed = decodeJson(result.content) as T;
        } catch (retryError) {
          if (retryError instanceof KiloGatewayError && /incomplete JSON/i.test(retryError.message)) {
            throw new KiloGatewayError('The free model response was truncated twice. Try fewer slides or a smaller source file.');
          }
          throw retryError;
        }
      }
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
