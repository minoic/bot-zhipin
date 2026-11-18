import { performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';

export type ReplayEvent<T = unknown> = {
  schemaVersion: 1;
  seq: number;
  at: number;
  type: string;
  sessionEpoch?: number;
  payload: T;
};

type LogReply = { id: number; ok: true } | { id: number; ok: false; error: string };

/** Bounded, asynchronous NDJSON writer. append returns false when the worker is saturated. */
export class NdjsonRecorder {
  private readonly worker: Worker;
  private seq = 0;
  private lastAt = -Infinity;
  private mode: 'generated' | 'external' | undefined;
  private requestId = 0;
  private pending = 0;
  private dropped = 0;
  private closed = false;
  private failure: Error | undefined;
  private closing: Promise<void> | undefined;
  private readonly maxPending: number;
  private readonly requests = new Map<
    number,
    { resolve: () => void; reject: (error: Error) => void }
  >();
  private readonly sessionEpoch: number | undefined;

  constructor(path: string, options: { maxPending?: number; sessionEpoch?: number } = {}) {
    this.maxPending = Math.max(1, Math.trunc(options.maxPending ?? 8192));
    this.sessionEpoch = options.sessionEpoch;
    this.worker = new Worker(new URL('./ndjson-writer.mjs', import.meta.url), {
      workerData: { path },
    });
    this.worker.on('message', (reply: LogReply) => {
      this.pending -= 1;
      const request = this.requests.get(reply.id);
      if (!reply.ok) {
        const error = new Error(reply.error);
        if (request) {
          this.requests.delete(reply.id);
          request.reject(error);
        }
        this.fail(error);
        return;
      }
      if (!request) return;
      this.requests.delete(reply.id);
      request.resolve();
    });
    this.worker.on('error', (error) => this.fail(error));
    this.worker.on('exit', (code) => {
      if (!this.closed) this.fail(new Error(`NDJSON writer exited (${code})`));
    });
  }

  append(type: string, payload: unknown): boolean {
    if (this.mode === 'external') throw new Error('ndjson_mixed_sequence_sources');
    this.mode = 'generated';
    if (this.closed) throw new Error('ndjson_recorder_closed');
    if (this.failure) throw this.failure;
    if (this.pending >= this.maxPending) {
      this.dropped += 1;
      return false;
    }
    if (this.dropped && type !== 'log.dropped') {
      const count = this.dropped;
      this.dropped = 0;
      if (!this.enqueue('log.dropped', { count })) this.dropped += count;
      if (this.pending >= this.maxPending) {
        this.dropped += 1;
        return false;
      }
    }
    return this.enqueue(type, payload);
  }

  /** Append a caller-owned event unchanged so multiple stores share sequence and time. */
  appendEvent(event: ReplayEvent): boolean {
    if (this.mode === 'generated') throw new Error('ndjson_mixed_sequence_sources');
    if (this.closed) throw new Error('ndjson_recorder_closed');
    if (this.failure) throw this.failure;
    if (
      event.schemaVersion !== 1 ||
      !Number.isSafeInteger(event.seq) ||
      event.seq <= this.seq ||
      !Number.isFinite(event.at) ||
      event.at < 0 ||
      event.at < this.lastAt ||
      typeof event.type !== 'string' ||
      !event.type ||
      (event.sessionEpoch !== undefined &&
        (!Number.isSafeInteger(event.sessionEpoch) || event.sessionEpoch < 0))
    )
      throw new Error('invalid_replay_event_order');
    const line = JSON.stringify(event);
    if (this.pending >= this.maxPending) return false;
    const posted = this.post('append', { line });
    if (posted) {
      this.mode = 'external';
      this.seq = event.seq;
      this.lastAt = event.at;
    }
    return posted;
  }
  async drain(): Promise<void> {
    if (this.failure) throw this.failure;
    if (this.dropped) {
      const count = this.dropped;
      this.dropped = 0;
      if (!this.enqueue('log.dropped', { count })) {
        this.dropped = count;
        throw new Error('ndjson_log_backpressure');
      }
    }
    await this.request('flush');
  }

  async close(): Promise<void> {
    if (this.closed) return;
    if (!this.closing) {
      this.closing = (async () => {
        if (!this.failure) {
          await this.drain();
          await this.request('close');
        }
        this.closed = true;
        await this.worker.terminate();
      })();
    }
    await this.closing;
  }

  private enqueue(type: string, payload: unknown): boolean {
    const at = performance.now();
    const event: ReplayEvent = {
      schemaVersion: 1,
      seq: ++this.seq,
      at,
      type,
      ...(this.sessionEpoch === undefined ? {} : { sessionEpoch: this.sessionEpoch }),
      payload,
    };
    try {
      const posted = this.post('append', { line: JSON.stringify(event) });
      if (!posted) this.seq -= 1;
      return posted;
    } catch (error) {
      this.seq -= 1;
      throw error;
    }
  }

  private post(op: string, payload: unknown): boolean {
    if (this.pending >= this.maxPending && op === 'append') return false;
    const id = ++this.requestId;
    this.pending += 1;
    try {
      this.worker.postMessage({ id, op, payload });
    } catch (error) {
      this.pending -= 1;
      const failure = error instanceof Error ? error : new Error(String(error));
      this.fail(failure);
      throw failure;
    }
    return true;
  }

  private request(op: string): Promise<void> {
    if (this.closed) return Promise.reject(new Error('ndjson_recorder_closed'));
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      this.requests.set(id, { resolve, reject });
      this.pending += 1;
      try {
        this.worker.postMessage({ id, op });
      } catch (error) {
        this.requests.delete(id);
        this.pending -= 1;
        const failure = error instanceof Error ? error : new Error(String(error));
        this.fail(failure);
        reject(failure);
      }
    });
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const request of this.requests.values()) request.reject(error);
    this.requests.clear();
  }
}

export class VirtualClock {
  private time = 0;
  private timerId = 0;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();
  now(): number {
    return this.time;
  }
  setTimeout(callback: () => void, delayMs: number): number {
    if (!Number.isFinite(delayMs) || delayMs < 0)
      throw new RangeError('delay must be finite and non-negative');
    const id = ++this.timerId;
    this.timers.set(id, { at: this.time + delayMs, callback });
    return id;
  }
  clearTimeout(id: number): void {
    this.timers.delete(id);
  }
  advanceTo(at: number): void {
    if (!Number.isFinite(at) || at < this.time)
      throw new RangeError('virtual time must advance monotonically');
    while (true) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= at)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      this.time = next[1].at;
      this.timers.delete(next[0]);
      next[1].callback();
    }
    this.time = at;
  }
}

export async function readNdjsonLog(path: string): Promise<ReplayEvent[]> {
  const { readFile } = await import('node:fs/promises');
  const content = await readFile(path, 'utf8');
  const events: ReplayEvent[] = [];
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let event: ReplayEvent;
    try {
      event = JSON.parse(line) as ReplayEvent;
    } catch (error) {
      throw new Error(`invalid NDJSON at line ${index + 1}: ${String(error)}`);
    }
    if (
      event.schemaVersion !== 1 ||
      !Number.isSafeInteger(event.seq) ||
      !Number.isFinite(event.at) ||
      typeof event.type !== 'string'
    ) {
      throw new Error(`invalid replay event at line ${index + 1}`);
    }
    events.push(event);
  }
  return events;
}

/** Replays recorded scheduler/input/model events in log order with injected virtual time. */
export async function replayRecorded<T>(
  events: readonly ReplayEvent[],
  dispatch: (event: ReplayEvent, clock: VirtualClock) => T | Promise<T>,
  clock = new VirtualClock(),
): Promise<T[]> {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  let priorSeq = -1;
  const results: T[] = [];
  for (const event of ordered) {
    if (event.seq <= priorSeq)
      throw new Error(`duplicate or non-increasing event sequence ${event.seq}`);
    priorSeq = event.seq;
    clock.advanceTo(event.at);
    results.push(await dispatch(event, clock));
  }
  return results;
}

export type RecomputeInput<T> = {
  seq: number;
  seed: number;
  maxExpansions: number;
  input: T;
  expected?: unknown;
};
export type RecomputeResult = {
  seq: number;
  seed: number;
  maxExpansions: number;
  output: unknown;
  matchesExpected: boolean | null;
};

/** Recomputes from recorded inputs under a seeded RNG and fixed expansion budget, independent of wall time. */
export async function recomputeDeterministically<T>(
  inputs: readonly RecomputeInput<T>[],
  compute: (
    input: T,
    context: { random: () => number; maxExpansions: number },
  ) => unknown | Promise<unknown>,
): Promise<RecomputeResult[]> {
  const ordered = [...inputs].sort((a, b) => a.seq - b.seq);
  const results: RecomputeResult[] = [];
  for (const item of ordered) {
    if (
      !Number.isSafeInteger(item.seed) ||
      !Number.isSafeInteger(item.maxExpansions) ||
      item.maxExpansions < 1
    )
      throw new Error(`invalid deterministic replay budget at seq ${item.seq}`);
    const output = await compute(item.input, {
      random: seededRandom(item.seed),
      maxExpansions: item.maxExpansions,
    });
    results.push({
      seq: item.seq,
      seed: item.seed,
      maxExpansions: item.maxExpansions,
      output,
      matchesExpected:
        item.expected === undefined ? null : stableJson(item.expected) === stableJson(output),
    });
  }
  return results;
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function stableJson(value: unknown): string {
  return JSON.stringify(canonical(value));
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}

export { replayDecision, type DecisionReplay, type ReplayedGoal } from './decision-replay.js';
