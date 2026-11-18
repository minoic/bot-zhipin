import { GoalSchema, TaskNodeSchema, type Goal, type TaskNode } from '../../contracts/src/index.js';

export type TaskState =
  | 'pending'
  | 'ready'
  | 'running'
  | 'succeeded'
  | 'blocked'
  | 'failed'
  | 'cancelled';

/** 管理已校验的目标、任务依赖和执行状态。 */
export class GoalStore {
  #goals = new Map<string, Goal>();
  #tasks = new Map<string, TaskNode>();
  #state = new Map<string, TaskState>();
  #taskGoal = new Map<string, { id: string; revision: number }>();
  #events: Array<{ type: string; at: number; data: unknown }> = [];
  #listeners = new Set<() => void>();
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  upsert(raw: Goal): Goal {
    const next = GoalSchema.parse(raw);
    const old = this.#goals.get(next.id);
    if (old && next.revision <= old.revision) throw new Error('stale_goal_revision');
    if (old) {
      for (const [taskId, binding] of this.#taskGoal)
        if (
          binding.id === old.id &&
          binding.revision === old.revision &&
          this.#state.get(taskId) !== 'succeeded'
        )
          this.#state.set(taskId, 'cancelled');
    }
    this.#goals.set(next.id, next);
    this.#events.push({
      type: 'goal.accepted',
      at: Date.now(),
      data: structuredClone(next),
    });
    for (const listener of this.#listeners) listener();
    return structuredClone(next);
  }
  addTasks(nodes: TaskNode[], goalId?: string): void {
    const parsed = nodes.map((n) => TaskNodeSchema.parse(n));
    const staged = new Map(this.#tasks);
    const batchIds = new Set<string>();
    for (const n of parsed) {
      if (staged.has(n.id) || batchIds.has(n.id)) throw new Error(`duplicate_task:${n.id}`);
      batchIds.add(n.id);
      staged.set(n.id, n);
    }
    for (const n of parsed)
      for (const dep of n.dependsOn)
        if (!staged.has(dep)) throw new Error(`unknown_dependency:${dep}`);
    this.#assertAcyclic(staged);
    const goal = this.#goals.get(goalId ?? '');
    for (const n of parsed) {
      this.#tasks.set(n.id, n);
      this.#state.set(n.id, 'pending');
      if (goal) this.#taskGoal.set(n.id, { id: goal.id, revision: goal.revision });
    }
    this.refresh();
  }
  #assertAcyclic(tasks: ReadonlyMap<string, TaskNode>): void {
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (id: string): void => {
      if (visiting.has(id)) throw new Error('task_graph_cycle');
      if (visited.has(id)) return;
      visiting.add(id);
      for (const dependency of tasks.get(id)?.dependsOn ?? []) visit(dependency);
      visiting.delete(id);
      visited.add(id);
    };
    for (const id of tasks.keys()) visit(id);
  }
  refresh(): void {
    for (const [id, node] of this.#tasks) {
      if (!['pending', 'blocked'].includes(this.#state.get(id) ?? '')) continue;
      const deps = node.dependsOn.map((dep) => this.#state.get(dep));
      this.#state.set(
        id,
        deps.some((s) => s === 'failed' || s === 'cancelled')
          ? 'blocked'
          : deps.every((s) => s === 'succeeded')
            ? 'ready'
            : 'pending',
      );
    }
  }
  ready(): TaskNode[] {
    this.refresh();
    return structuredClone(
      [...this.#tasks.values()].filter((n) => this.#state.get(n.id) === 'ready'),
    );
  }
  mark(id: string, state: TaskState, detail?: unknown): void {
    if (!this.#tasks.has(id)) throw new Error(`unknown_task:${id}`);
    if (this.#state.get(id) === 'cancelled' && state !== 'cancelled') return;
    this.#state.set(id, state);
    this.#events.push({
      type: 'task.' + state,
      at: Date.now(),
      data: { id, detail },
    });
    this.refresh();
  }
  taskState(id: string): TaskState | undefined {
    return this.#state.get(id);
  }
  taskCurrent(id: string): boolean {
    const binding = this.#taskGoal.get(id);
    return !binding || this.#goals.get(binding.id)?.revision === binding.revision;
  }
  get goalEvents() {
    return structuredClone(this.#events);
  }
  get currentGoals() {
    return structuredClone([...this.#goals.values()]);
  }
}
