import type { Goal, Snapshot } from '../../contracts/src/index.js';
import { ModelResponseSchema } from './schemas.js';
import { buildContext } from './context.js';
import type { ProviderAdapter } from './provider.js';
import { ModelProviderError } from './openai-compatible-provider.js';

/** 新规划请求会取消前一请求，并拦截已过期的响应。 */
export class ModelRequestCoordinator {
  #provider: ProviderAdapter;
  #active = new Map<string, { id: string; controller: AbortController; revision: number }>();
  #calls = new Map<string, number>();
  #tail: Promise<void> = Promise.resolve();
  #seq = 0;
  #maxCalls: number;
  constructor(provider: ProviderAdapter, maxCalls = 8) {
    this.#provider = provider;
    this.#maxCalls = maxCalls;
  }
  async plan(goal: Goal, snapshot: Snapshot, capabilities: string[], timeoutMs = 10000) {
    const parsed = await this.request(
      'plan',
      goal,
      'plan',
      buildContext({ goal, snapshot, capabilities }),
      timeoutMs,
    );
    if (
      parsed.kind !== 'plan' ||
      parsed.goalRevision !== goal.revision ||
      parsed.goalId !== goal.id
    )
      throw new Error('stale_model_response');
    return parsed;
  }
  async request(
    kind: 'intent' | 'plan' | 'dialogue',
    goal: Goal,
    prompt: string,
    context: unknown,
    timeoutMs = 10000,
  ) {
    if (new TextEncoder().encode(JSON.stringify({ prompt, context })).byteLength > 6000)
      throw new Error('context_budget_exceeded');
    const key = JSON.stringify([goal.sessionId, goal.id]);
    const previous = this.#active.get(key);
    if (previous) {
      previous.controller.abort();
      this.#provider.cancel(previous.id);
    }
    const id = `req-${++this.#seq}`,
      controller = new AbortController(),
      revision = goal.revision;
    this.#active.set(key, { id, controller, revision });
    const deadline = Date.now() + timeoutMs;
    const timer = setTimeout(() => controller.abort('timeout'), timeoutMs);
    const predecessor = this.#tail;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#tail = predecessor.then(() => gate);
    try {
      const aborted = new Promise<never>((_, reject) =>
        controller.signal.addEventListener(
          'abort',
          () =>
            reject(
              new Error(
                controller.signal.reason === 'timeout' ? 'model_timeout' : 'model_cancelled',
              ),
            ),
          { once: true },
        ),
      );
      await Promise.race([predecessor, aborted]);
      let retried = false,
        repaired = false;
      for (;;) {
        if (controller.signal.aborted)
          throw new Error(
            controller.signal.reason === 'timeout' ? 'model_timeout' : 'model_cancelled',
          );
        const used = this.#calls.get(key) ?? 0;
        if (used >= this.#maxCalls) throw new Error('model_budget_exhausted');
        this.#calls.set(key, used + 1);
        const method =
          kind === 'intent'
            ? this.#provider.generateIntent.bind(this.#provider)
            : kind === 'plan'
              ? this.#provider.proposePlan.bind(this.#provider)
              : this.#provider.respond.bind(this.#provider);
        try {
          const response = await Promise.race([
            method({
              requestId: id,
              goalRevision: revision,
              prompt: repaired
                ? `${prompt}\nReturn a corrected JSON object matching the required schema.`
                : prompt,
              context,
              deadline,
              signal: controller.signal,
            }),
            aborted,
          ]);
          const parsed = ModelResponseSchema.safeParse(response);
          if (
            !parsed.success ||
            (parsed.data.kind !== kind &&
              !(kind === 'intent' && parsed.data.kind === 'clarification'))
          )
            throw new ModelProviderError('model_invalid_output');
          if (controller.signal.aborted || this.#active.get(key)?.id !== id)
            throw new Error('stale_model_response');
          return parsed.data;
        } catch (error) {
          if (!(error instanceof ModelProviderError)) throw error;
          if (error.code === 'model_invalid_output' && !repaired) {
            repaired = true;
            continue;
          }
          const transient =
            error.code === 'model_network_error' ||
            error.code === 'model_rate_limited' ||
            (error.code === 'model_http_error' && [500, 502, 503, 504].includes(error.status ?? 0));
          if (!transient || retried) throw error;
          retried = true;
          const delay = error.retryAfterMs ?? 0;
          if (Date.now() + delay >= deadline) throw new Error('model_timeout');
          if (delay > 0) {
            let delayTimer: ReturnType<typeof setTimeout> | undefined;
            try {
              await Promise.race([
                new Promise<void>((resolve) => {
                  delayTimer = setTimeout(resolve, delay);
                }),
                aborted,
              ]);
            } finally {
              if (delayTimer) clearTimeout(delayTimer);
            }
          }
        }
      }
    } finally {
      clearTimeout(timer);
      if (this.#active.get(key)?.id === id) this.#active.delete(key);
      release();
    }
  }
  cancel(goal?: Pick<Goal, 'sessionId' | 'id'>): void {
    const key = goal && JSON.stringify([goal.sessionId, goal.id]);
    for (const [scope, active] of this.#active) {
      if (key && scope !== key) continue;
      active.controller.abort();
      this.#provider.cancel(active.id);
      this.#active.delete(scope);
    }
  }
}
