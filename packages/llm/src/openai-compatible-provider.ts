import type { ModelRequest, ProviderAdapter } from './provider.js';
import type { ModelResponse } from './schemas.js';

export type ModelErrorCode =
  | 'model_not_configured'
  | 'model_auth_failed'
  | 'model_rate_limited'
  | 'model_invalid_output'
  | 'model_network_error'
  | 'model_timeout'
  | 'model_cancelled'
  | 'model_http_error';

/** Errors deliberately exclude remote response bodies, URLs and authentication headers. */
export class ModelProviderError extends Error {
  constructor(
    readonly code: ModelErrorCode,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(code);
    this.name = 'ModelProviderError';
  }
}
export type ModelUsage = { inputTokens: number; outputTokens: number; totalTokens: number };
export type ModelAttempt = {
  requestId: string;
  kind: 'intent' | 'plan' | 'dialogue';
  model: string;
  elapsedMs: number;
  status: 'success' | ModelErrorCode;
  usage: ModelUsage | null;
  cost: number | null;
};
export type OpenAICompatibleOptions = {
  baseUrl: string;
  apiKey: string;
  model: string;
  fetch?: typeof fetch;
  onAttempt?: (event: ModelAttempt) => void;
  prices?: { inputPerMillion: number; outputPerMillion: number };
};
function retryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}
function readUsage(value: unknown): ModelUsage | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const numbers = [raw.prompt_tokens, raw.completion_tokens, raw.total_tokens];
  if (!numbers.every((v) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0))
    return null;
  return {
    inputTokens: numbers[0] as number,
    outputTokens: numbers[1] as number,
    totalTokens: numbers[2] as number,
  };
}

/** Exactly one API attempt. Retries, budgeting and schema validation belong to the coordinator. */
export class OpenAICompatibleProvider implements ProviderAdapter {
  readonly #endpoint: string;
  readonly #apiKey: string;
  readonly #model: string;
  readonly #fetch: typeof fetch;
  readonly #onAttempt: OpenAICompatibleOptions['onAttempt'];
  readonly #prices: OpenAICompatibleOptions['prices'];
  readonly #active = new Map<string, AbortController>();
  constructor(options: OpenAICompatibleOptions) {
    if (!options.baseUrl || !options.apiKey || !options.model)
      throw new ModelProviderError('model_not_configured');
    let url: URL;
    try {
      url = new URL(options.baseUrl);
      if (
        !['https:', 'http:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error();
    } catch {
      throw new ModelProviderError('model_not_configured');
    }
    this.#endpoint = `${url.toString().replace(/\/+$/, '')}/chat/completions`;
    this.#apiKey = options.apiKey;
    this.#model = options.model;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#onAttempt = options.onAttempt;
    this.#prices = options.prices;
    if (
      this.#prices &&
      ![this.#prices.inputPerMillion, this.#prices.outputPerMillion].every(
        (n) => Number.isFinite(n) && n >= 0,
      )
    )
      throw new ModelProviderError('model_not_configured');
  }
  generateIntent(request: ModelRequest): Promise<ModelResponse> {
    return this.#request('intent', request);
  }
  proposePlan(request: ModelRequest): Promise<ModelResponse> {
    return this.#request('plan', request);
  }
  respond(request: ModelRequest): Promise<ModelResponse> {
    return this.#request('dialogue', request);
  }
  cancel(requestId: string): void {
    this.#active.get(requestId)?.abort('cancelled');
  }

  async #request(kind: ModelAttempt['kind'], request: ModelRequest): Promise<ModelResponse> {
    if (this.#active.has(request.requestId)) throw new ModelProviderError('model_http_error');
    const started = performance.now();
    const controller = new AbortController();
    const relay = () => controller.abort('cancelled');
    if (request.signal.aborted) controller.abort('cancelled');
    else request.signal.addEventListener('abort', relay, { once: true });
    const remaining = request.deadline - Date.now();
    if (remaining <= 0 && !controller.signal.aborted) controller.abort('timeout');
    const timer =
      remaining > 0 ? setTimeout(() => controller.abort('timeout'), remaining) : undefined;
    this.#active.set(request.requestId, controller);
    let usage: ModelUsage | null = null;
    let status: ModelAttempt['status'] = 'success';
    try {
      const abortError = () =>
        new ModelProviderError(
          controller.signal.reason === 'timeout' ? 'model_timeout' : 'model_cancelled',
        );
      if (controller.signal.aborted) throw abortError();
      const cancelled = new Promise<never>((_, reject) =>
        controller.signal.addEventListener('abort', () => reject(abortError()), { once: true }),
      );
      const contracts = {
        intent:
          'Return {"kind":"intent","goal":{"text":string,"type":"navigateToPosition"|"openContainerAt","position":{"x":number,"y":number,"z":number},"dimension":string,"constraints":{"forbidBlockBreaking":true,"deadline"?:number}}} or {"kind":"clarification","question":string} when the target or constraints are ambiguous. Do not guess coordinates or dimension.',
        plan: 'Return {"kind":"plan","goalId":string,"goalRevision":number,"tasks":[{"id":string,"capabilityId":string,"params":object,"dependsOn":string[],"timeoutMs":number}],"validForMs":number}. Task ids are only local aliases; dependencies must refer to aliases in the same plan. Include all steps required by the goal. Use only the supplied skills and preserve the confirmed target and constraints.',
        dialogue:
          'Return {"kind":"dialogue","text":string}. Describe only facts established by the runtime.',
      };
      const body = {
        model: this.#model,
        stream: false,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: `Return exactly one JSON object for the ${kind} request. Output contract: ${contracts[kind]} Do not call tools or claim actions succeeded; observations and execution are controlled by the runtime. Do not assign priorities, resources or preemption permissions.`,
          },
          {
            role: 'user',
            content: JSON.stringify({ request: request.prompt, context: request.context }),
          },
        ],
      };
      const response = await Promise.race([
        this.#fetch(this.#endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${this.#apiKey}` },
          body: JSON.stringify(body),
          signal: controller.signal,
        }),
        cancelled,
      ]);
      if (!response.ok) {
        const code =
          response.status === 401 || response.status === 403
            ? 'model_auth_failed'
            : response.status === 429
              ? 'model_rate_limited'
              : 'model_http_error';
        throw new ModelProviderError(
          code,
          response.status,
          retryAfter(response.headers.get('retry-after')),
        );
      }
      let payload: any;
      try {
        payload = await Promise.race([response.json(), cancelled]);
      } catch (error) {
        if (error instanceof ModelProviderError) throw error;
        if (controller.signal.aborted) throw abortError();
        if (error instanceof SyntaxError) throw new ModelProviderError('model_invalid_output');
        throw new ModelProviderError('model_network_error');
      }
      usage = readUsage(payload?.usage);
      const choice = payload?.choices?.[0];
      if (
        !choice ||
        choice.finish_reason !== 'stop' ||
        choice.message?.refusal ||
        typeof choice.message?.content !== 'string'
      )
        throw new ModelProviderError('model_invalid_output');
      try {
        const parsed: unknown = JSON.parse(choice.message.content);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
        if (controller.signal.aborted) throw abortError();
        return parsed as ModelResponse;
      } catch (error) {
        if (error instanceof ModelProviderError) throw error;
        throw new ModelProviderError('model_invalid_output');
      }
    } catch (error) {
      const safeError =
        error instanceof ModelProviderError
          ? error
          : controller.signal.aborted
            ? new ModelProviderError(
                controller.signal.reason === 'timeout' ? 'model_timeout' : 'model_cancelled',
              )
            : new ModelProviderError('model_network_error');
      status = safeError.code;
      throw safeError;
    } finally {
      if (timer) clearTimeout(timer);
      request.signal.removeEventListener('abort', relay);
      if (this.#active.get(request.requestId) === controller)
        this.#active.delete(request.requestId);
      const cost =
        usage && this.#prices
          ? (usage.inputTokens * this.#prices.inputPerMillion +
              usage.outputTokens * this.#prices.outputPerMillion) /
            1_000_000
          : null;
      try {
        this.#onAttempt?.({
          requestId: request.requestId,
          kind,
          model: this.#model,
          elapsedMs: performance.now() - started,
          status,
          usage,
          cost,
        });
      } catch {
        /* Telemetry must not alter request results. */
      }
    }
  }
}
