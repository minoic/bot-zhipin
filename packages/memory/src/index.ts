import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';

export type MemoryEvent = {
  id?: string;
  sessionId: string;
  goalId?: string | null;
  seq: number;
  at: number;
  type: string;
  payload: unknown;
};
export type MemoryGoal = {
  id: string;
  sessionId: string;
  revision: number;
  status: string;
  content: unknown;
  updatedAt: number;
};
export type MemoryTask = {
  id: string;
  goalId: string;
  status: string;
  content: unknown;
  updatedAt: number;
};
export type MemoryFact = {
  id?: string;
  sessionId: string;
  goalId?: string | null;
  entityId?: string | null;
  dimension?: string | null;
  x?: number | null;
  y?: number | null;
  z?: number | null;
  text: string;
  source: string;
  observedAt: number;
  expiresAt?: number | null;
  confidence?: number | null;
  confirmed: boolean;
  metadata?: unknown;
};
export type MemorySummary = {
  id: string;
  sessionId: string;
  goalId?: string | null;
  text: string;
  eventFrom: number;
  eventTo: number;
  createdAt: number;
};
export type MemorySearch = {
  sessionId: string;
  goalId?: string;
  entityId?: string;
  dimension?: string;
  position?: { x: number; y: number; z: number; radius: number };
  query?: string;
  now?: number;
  limit?: number;
};
export type MemoryWriteBatch = {
  events?: MemoryEvent[];
  goals?: MemoryGoal[];
  tasks?: MemoryTask[];
  facts?: MemoryFact[];
  summaries?: MemorySummary[];
};
type WorkerReply =
  | { id: number; ok: true; value?: unknown }
  | { id: number; ok: false; error: string };

/** SQLite is owned by a worker; batched writes never run on the caller's tick loop. */
export class MemoryStore {
  private readonly worker: Worker;
  private nextId = 0;
  private closed = false;
  private failure: Error | undefined;
  private closing: Promise<void> | undefined;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();

  constructor(path: string) {
    this.worker = new Worker(new URL('./sqlite-worker.mjs', import.meta.url), {
      workerData: { path },
    });
    this.worker.on('message', (reply: WorkerReply) => {
      const pending = this.pending.get(reply.id);
      if (!pending) return;
      this.pending.delete(reply.id);
      if (reply.ok) pending.resolve(reply.value);
      else pending.reject(new Error(reply.error));
    });
    this.worker.on('error', (error) => this.fail(error));
    this.worker.on('exit', (code) => {
      if (!this.closed) this.fail(new Error(`memory worker exited (${code})`));
    });
  }

  async ready(): Promise<void> {
    await this.request('ready', {});
  }
  async writeBatch(batch: MemoryWriteBatch): Promise<void> {
    if (this.closed) throw new Error('memory_store_closed');
    if (this.closing) throw new Error('memory_store_closing');
    if (this.failure) throw this.failure;
    await this.request('writeBatch', batch);
  }
  async appendEvent(event: MemoryEvent): Promise<void> {
    await this.writeBatch({ events: [{ ...event, id: event.id ?? randomUUID() }] });
  }
  async search(
    input: MemorySearch,
  ): Promise<{ events: MemoryEvent[]; facts: MemoryFact[]; summaries: MemorySummary[] }> {
    if (this.closing) throw new Error('memory_store_closing');
    return (await this.request('search', input)) as {
      events: MemoryEvent[];
      facts: MemoryFact[];
      summaries: MemorySummary[];
    };
  }
  async close(): Promise<void> {
    if (this.closed) return;
    if (!this.closing) {
      this.closing = (async () => {
        if (this.failure) {
          this.closed = true;
          await this.worker.terminate();
          return;
        }
        await this.request('close', {});
        this.closed = true;
        await this.worker.terminate();
      })();
    }
    await this.closing;
  }
  private request<T>(op: string, payload: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new Error('memory_store_closed'));
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      try {
        this.worker.postMessage({ id, op, payload });
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
  private rejectAll(error: Error): void {
    for (const item of this.pending.values()) item.reject(error);
    this.pending.clear();
  }
  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    this.rejectAll(error);
  }
}
