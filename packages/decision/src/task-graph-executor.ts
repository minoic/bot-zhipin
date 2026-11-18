import type { TaskNode } from '../../contracts/src/index.js';
import { GoalStore, type TaskState } from './goal-store.js';

/** Runs ready tasks sequentially and fences stale or timed-out results. */
export class TaskGraphExecutor {
  #store: GoalStore;
  #capabilities: ReadonlySet<string>;
  #controllers = new Map<string, AbortController>();
  #unsubscribe: () => void;
  constructor(store: GoalStore, capabilities: ReadonlySet<string>) {
    this.#store = store;
    this.#capabilities = capabilities;
    this.#unsubscribe = store.subscribe(() => {
      for (const [id, c] of this.#controllers) if (!store.taskCurrent(id)) c.abort();
    });
  }
  async runReady(
    execute: (task: TaskNode, signal: AbortSignal) => Promise<unknown>,
    verify: (task: TaskNode, result: unknown) => boolean,
  ): Promise<
    Array<{
      taskId: string;
      state: TaskState;
      result?: unknown;
      error?: string;
    }>
  > {
    const results = [];
    for (const task of this.#store.ready()) {
      if (!this.#store.taskCurrent(task.id)) continue;
      if (!this.#capabilities.has(task.capabilityId)) {
        this.#store.mark(task.id, 'failed', 'capability_missing');
        results.push({
          taskId: task.id,
          state: 'failed' as const,
          error: 'capability_missing',
        });
        continue;
      }
      const controller = new AbortController();
      this.#controllers.set(task.id, controller);
      this.#store.mark(task.id, 'running');
      let timer: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      try {
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
            reject(new Error('task_timeout'));
          }, task.timeoutMs);
        });
        const aborted = new Promise<never>((_, reject) => {
          controller.signal.addEventListener(
            'abort',
            () => reject(new Error(timedOut ? 'task_timeout' : 'task_cancelled')),
            { once: true },
          );
        });
        const result = await Promise.race([execute(task, controller.signal), timeout, aborted]);
        if (controller.signal.aborted || !this.#store.taskCurrent(task.id))
          throw new Error('task_cancelled');
        if (!verify(task, result)) throw new Error('success_condition_not_observed');
        this.#store.mark(task.id, 'succeeded', result);
        results.push({ taskId: task.id, state: 'succeeded' as const, result });
      } catch (e) {
        const state: TaskState = controller.signal.aborted && !timedOut ? 'cancelled' : 'failed';
        this.#store.mark(task.id, state, timedOut ? 'task_timeout' : undefined);
        results.push({
          taskId: task.id,
          state,
          error: e instanceof Error ? e.message : String(e),
        });
      } finally {
        if (timer) clearTimeout(timer);
        this.#controllers.delete(task.id);
      }
    }
    return results;
  }
  cancel(taskId: string): boolean {
    const c = this.#controllers.get(taskId);
    if (!c) return false;
    c.abort();
    return true;
  }
  cancelAll(): void {
    for (const c of this.#controllers.values()) c.abort();
  }
  close(): void {
    this.cancelAll();
    this.#unsubscribe();
  }
}
