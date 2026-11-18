import { createServer, type Server, type RequestListener } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../apps/bot/src/config.js';
import {
  ModelProviderError,
  OpenAICompatibleProvider,
  type ModelAttempt,
} from '../packages/llm/src/openai-compatible-provider.js';
import type { ModelRequest } from '../packages/llm/src/provider.js';
import { ModelRequestCoordinator } from '../packages/llm/src/request-coordinator.js';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});
async function server(handler: RequestListener): Promise<string> {
  const instance = createServer(handler);
  servers.push(instance);
  await new Promise<void>((resolve) => instance.listen(0, '127.0.0.1', resolve));
  const address = instance.address();
  if (!address || typeof address === 'string') throw new Error('missing_address');
  return `http://127.0.0.1:${address.port}/v1`;
}
function request(timeout = 1000): ModelRequest {
  return {
    requestId: 'request-1',
    goalRevision: 1,
    prompt: 'return dialogue JSON',
    context: { goal: 'test' },
    deadline: Date.now() + timeout,
    signal: new AbortController().signal,
  };
}
function envelope(content: string, usage?: unknown) {
  return JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }], usage });
}

describe('OpenAI chat completions adapter', () => {
  it('sends JSON mode request and reports actual usage and configured cost', async () => {
    let received: { path?: string | undefined; authorization?: string | undefined; body?: any } =
      {};
    const baseUrl = await server((req, res) => {
      let data = '';
      req.on('data', (chunk) => {
        data += chunk;
      });
      req.on('end', () => {
        received = {
          path: req.url,
          authorization: req.headers.authorization,
          body: JSON.parse(data),
        };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          envelope('{"kind":"dialogue","text":"done"}', {
            prompt_tokens: 20,
            completion_tokens: 10,
            total_tokens: 30,
          }),
        );
      });
    });
    const attempts: ModelAttempt[] = [];
    const provider = new OpenAICompatibleProvider({
      baseUrl,
      apiKey: 'secret',
      model: 'test-model',
      prices: { inputPerMillion: 2, outputPerMillion: 4 },
      onAttempt: (event) => attempts.push(event),
    });
    expect(await provider.respond(request())).toEqual({ kind: 'dialogue', text: 'done' });
    expect(received.path).toBe('/v1/chat/completions');
    expect(received.authorization).toBe('Bearer secret');
    expect(received.body.response_format).toEqual({ type: 'json_object' });
    expect(received.body.messages[0].content).toContain('JSON');
    expect(attempts[0]).toMatchObject({
      kind: 'dialogue',
      status: 'success',
      model: 'test-model',
      usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
      cost: 0.00008,
    });
    expect(JSON.stringify(attempts)).not.toContain('secret');
  });
  it('marks a successful response with no usage or price as unavailable', async () => {
    const attempts: ModelAttempt[] = [];
    const baseUrl = await server((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(envelope('{"kind":"dialogue","text":"done"}'));
    });
    const provider = new OpenAICompatibleProvider({
      baseUrl,
      apiKey: 'secret',
      model: 'test',
      onAttempt: (event) => attempts.push(event),
    });
    expect(await provider.respond(request())).toEqual({ kind: 'dialogue', text: 'done' });
    expect(attempts[0]).toMatchObject({ status: 'success', usage: null, cost: null });
  });
  it('rejects late success when a transport ignores abort', async () => {
    let finish!: (response: Response) => void;
    const attempts: ModelAttempt[] = [];
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'secret',
      model: 'test',
      fetch: async () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
      onAttempt: (event) => attempts.push(event),
    });
    const controller = new AbortController();
    const pending = provider.respond({ ...request(), signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'model_cancelled' });
    finish(new Response(envelope('{"kind":"dialogue","text":"late"}'), { status: 200 }));
    await Promise.resolve();
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ status: 'model_cancelled', usage: null, cost: null });
  });
  it('classifies authentication and rate limiting without leaking response bodies', async () => {
    for (const [httpStatus, code] of [
      [401, 'model_auth_failed'],
      [429, 'model_rate_limited'],
    ] as const) {
      const baseUrl = await server((_req, res) => {
        res.writeHead(httpStatus, { 'retry-after': '2' });
        res.end('secret authorization: Bearer secret');
      });
      const provider = new OpenAICompatibleProvider({ baseUrl, apiKey: 'secret', model: 'test' });
      const error = await provider.proposePlan(request()).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ModelProviderError);
      expect(error).toMatchObject({ code, status: httpStatus, retryAfterMs: 2000 });
      expect(String(error)).not.toContain('secret');
    }
  });
  it('rejects malformed output and incomplete choices, and represents missing usage as unknown', async () => {
    const attempts: ModelAttempt[] = [];
    let count = 0;
    const baseUrl = await server((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        count++ === 0
          ? envelope('not JSON')
          : JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '{}' } }] }),
      );
    });
    const provider = new OpenAICompatibleProvider({
      baseUrl,
      apiKey: 'secret',
      model: 'test',
      onAttempt: (event) => attempts.push(event),
    });
    await expect(provider.generateIntent(request())).rejects.toMatchObject({
      code: 'model_invalid_output',
    });
    await expect(provider.respond(request())).rejects.toMatchObject({
      code: 'model_invalid_output',
    });
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({ usage: null, cost: null, status: 'model_invalid_output' });
  });
  it('distinguishes timeout, external cancellation and rejects late results', async () => {
    const baseUrl = await server((_req, res) => {
      setTimeout(() => {
        if (!res.destroyed) res.end(envelope('{"kind":"dialogue","text":"late"}'));
      }, 200);
    });
    const provider = new OpenAICompatibleProvider({ baseUrl, apiKey: 'secret', model: 'test' });
    await expect(provider.respond(request(20))).rejects.toMatchObject({ code: 'model_timeout' });
    const controller = new AbortController();
    const pending = provider.respond({
      ...request(),
      requestId: 'other',
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'model_cancelled' });
    const explicit = provider.respond({ ...request(), requestId: 'third' });
    provider.cancel('third');
    await expect(explicit).rejects.toMatchObject({ code: 'model_cancelled' });
  });
  it('reports network errors without exposing transport details', async () => {
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'secret',
      model: 'test',
      fetch: async () => {
        throw new Error('secret authentication header');
      },
    });
    const error = await provider.respond(request()).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'model_network_error' });
    expect(String(error)).not.toContain('secret');
  });
});

describe('coordinator and HTTP adapter integration', () => {
  const goal = { id: 'g1', sessionId: 's1', revision: 1, text: 'test', priority: 0.5 };
  it('repairs malformed JSON once and charges both attempts against the goal budget', async () => {
    let attempts = 0;
    const baseUrl = await server((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(envelope(++attempts === 1 ? 'bad json' : '{"kind":"dialogue","text":"done"}'));
    });
    const provider = new OpenAICompatibleProvider({ baseUrl, apiKey: 'secret', model: 'test' });
    const coordinator = new ModelRequestCoordinator(provider, 2);
    expect(await coordinator.request('dialogue', goal, 'report', {})).toEqual({
      kind: 'dialogue',
      text: 'done',
    });
    expect(attempts).toBe(2);
    await expect(coordinator.request('dialogue', goal, 'report', {})).rejects.toThrow(
      'model_budget_exhausted',
    );
    expect(attempts).toBe(2);
  });
  it('enforces a UTF-8 byte budget on all request contexts and prompts before HTTP calls', async () => {
    let attempts = 0;
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'secret',
      model: 'test',
      fetch: async () => {
        attempts++;
        return new Response(envelope('{"kind":"dialogue","text":"ok"}'), { status: 200 });
      },
    });
    const coordinator = new ModelRequestCoordinator(provider, 8);
    await expect(
      coordinator.request('dialogue', goal, 'report', { text: '文'.repeat(2100) }),
    ).rejects.toThrow('context_budget_exceeded');
    await expect(coordinator.request('intent', goal, '文'.repeat(2100), {})).rejects.toThrow(
      'context_budget_exceeded',
    );
    expect(attempts).toBe(0);
    await expect(
      coordinator.request('dialogue', goal, 'report', { text: '文'.repeat(1000) }),
    ).resolves.toEqual({ kind: 'dialogue', text: 'ok' });
    expect(attempts).toBe(1);
  });
  it('cancels one queued scope without aborting the active scope or later requests', async () => {
    let attempts = 0;
    let started!: () => void;
    let release!: () => void;
    const start = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'secret',
      model: 'test',
      fetch: async () => {
        attempts++;
        if (attempts === 1) {
          started();
          await gate;
        }
        return new Response(envelope('{"kind":"dialogue","text":"ok"}'), { status: 200 });
      },
    });
    const coordinator = new ModelRequestCoordinator(provider, 8);
    const active = coordinator.request('dialogue', goal, 'report', {});
    await start;
    const queuedGoal = { ...goal, id: 'queued' };
    const queued = coordinator.request('dialogue', queuedGoal, 'report', {});
    coordinator.cancel(queuedGoal);
    await expect(queued).rejects.toThrow('model_cancelled');
    expect(attempts).toBe(1);
    release();
    await expect(active).resolves.toEqual({ kind: 'dialogue', text: 'ok' });
    await expect(
      coordinator.request('dialogue', { ...goal, id: 'next' }, 'report', {}),
    ).resolves.toEqual({ kind: 'dialogue', text: 'ok' });
    expect(attempts).toBe(2);
  });
  it('keeps another goal queued when the active goal is cancelled', async () => {
    let attempts = 0;
    let started!: () => void;
    const start = new Promise<void>((resolve) => {
      started = resolve;
    });
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'secret',
      model: 'test',
      fetch: async () => {
        attempts++;
        if (attempts === 1) {
          started();
          return new Promise<Response>(() => {});
        }
        return new Response(envelope('{"kind":"dialogue","text":"ok"}'), { status: 200 });
      },
    });
    const coordinator = new ModelRequestCoordinator(provider, 8);
    const active = coordinator.request('dialogue', goal, 'report', {});
    await start;
    const other = coordinator.request('dialogue', { ...goal, id: 'other' }, 'report', {});
    coordinator.cancel(goal);
    await expect(active).rejects.toThrow('model_cancelled');
    await expect(other).resolves.toEqual({ kind: 'dialogue', text: 'ok' });
    expect(attempts).toBe(2);
  });
  it('retries one temporary 429 and does not retry authentication failures', async () => {
    let attempts = 0;
    const baseUrl = await server((_req, res) => {
      attempts++;
      if (attempts === 1) {
        res.writeHead(429, { 'retry-after': '0' });
        res.end();
        return;
      }
      if (attempts === 3) {
        res.writeHead(401);
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(envelope('{"kind":"dialogue","text":"ok"}'));
    });
    const provider = new OpenAICompatibleProvider({ baseUrl, apiKey: 'secret', model: 'test' });
    const coordinator = new ModelRequestCoordinator(provider, 8);
    expect(await coordinator.request('dialogue', goal, 'report', {})).toEqual({
      kind: 'dialogue',
      text: 'ok',
    });
    expect(attempts).toBe(2);
    await expect(coordinator.request('dialogue', goal, 'report', {})).rejects.toMatchObject({
      code: 'model_auth_failed',
    });
    expect(attempts).toBe(3);
  });
});
describe('LLM configuration', () => {
  it('defaults to offline and requires explicit remote configuration', () => {
    expect(loadConfig({})).toMatchObject({
      provider: 'offline',
      requestTimeoutMs: 10000,
      maxCallsPerGoal: 8,
      maxConcurrentRequests: 1,
    });
    expect(() => loadConfig({ LLM_PROVIDER: 'openai-compatible' })).toThrow('LLM_BASE_URL');
    expect(() => loadConfig({ LLM_PROVIDER: 'other' })).toThrow('invalid_llm_provider');
    expect(() => loadConfig({ LLM_MAX_CALLS_PER_GOAL: '0' })).toThrow('LLM_MAX_CALLS_PER_GOAL');
    expect(() => loadConfig({ LLM_MAX_CONCURRENT_REQUESTS: '2' })).toThrow(
      'LLM_MAX_CONCURRENT_REQUESTS',
    );
    expect(
      loadConfig({
        LLM_PROVIDER: 'openai-compatible',
        LLM_BASE_URL: 'https://example.com/v1',
        LLM_API_KEY: 'key',
        LLM_MODEL: 'test',
      }).provider,
    ).toBe('openai-compatible');
  });
});
