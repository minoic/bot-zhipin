import { randomUUID } from 'node:crypto';
import type { Snapshot, TaskNode } from '../../contracts/src/index.js';
import {
  goalObserved,
  SkillRegistry,
  TargetSchema,
  type SkillEvidence,
  type Target,
} from './skill-registry.js';
import { UtilitySelector, type Candidate } from './utility-selector.js';

export type RuntimeGoalStatus =
  | 'planning'
  | 'running'
  | 'awaitingClarification'
  | 'succeeded'
  | 'failed'
  | 'cancelled';
export type RuntimeGoal = {
  id: string;
  sessionId: string;
  revision: number;
  epoch: number;
  generation: number;
  target: Target;
  priority: number;
  status: RuntimeGoalStatus;
  reason?: string;
};
type Entry = {
  goal: RuntimeGoal;
  tasks: TaskNode[];
  states: Map<string, 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled'>;
  evidence: SkillEvidence[];
  expiresAt: number;
};
type Active = { entry: Entry; task: TaskNode; controller: AbortController };

/** One action slot, event-driven scheduling and fencing across session, revision and plan generation. */
export class DecisionRuntime {
  #entries = new Map<string, Entry>();
  #active: Active | undefined;
  #scheduled = false;
  #closed = false;
  #selector = new UtilitySelector();
  constructor(
    private readonly skills: SkillRegistry,
    private readonly snapshot: () => Snapshot,
    private readonly emit: (type: string, payload: unknown) => void = () => {},
    private readonly utility: (
      goal: RuntimeGoal,
      task: TaskNode,
    ) => Pick<
      Candidate,
      'progress' | 'urgency' | 'confidence' | 'time' | 'risk' | 'switchingCost'
    > = () => ({ progress: 0, urgency: 0, confidence: 0, time: 0, risk: 0, switchingCost: 0 }),
  ) {}
  create(input: {
    sessionId: string;
    epoch: number;
    target: Target;
    priority?: number;
    id?: string;
    revision?: number;
    recovery?: boolean;
  }): RuntimeGoal {
    const target = TargetSchema.parse(input.target);
    const current = this.snapshot();
    if (current.sessionEpoch !== input.epoch || current.dimension !== target.dimension)
      throw new Error('target_session_or_dimension_mismatch');
    if (target.deadline !== undefined && target.deadline <= Date.now())
      throw new Error('goal_deadline_exceeded');
    const priority = input.priority ?? 0.5;
    if (!Number.isFinite(priority) || priority < 0 || priority > 1)
      throw new Error('invalid_priority');
    const id = input.id ?? randomUUID();
    const prior = this.#entries.get(id);
    if (prior && !['cancelled', 'failed', 'succeeded'].includes(prior.goal.status))
      throw new Error('goal_already_active');
    if (
      prior &&
      (input.revision ?? 1) <= prior.goal.revision &&
      !(input.recovery && prior.goal.status === 'failed' && input.revision === prior.goal.revision)
    )
      throw new Error('stale_goal_revision');
    if (
      input.recovery &&
      (!prior || prior.goal.status !== 'failed' || input.revision !== prior.goal.revision)
    )
      throw new Error('invalid_goal_recovery');
    const goal: RuntimeGoal = {
      id,
      sessionId: input.sessionId,
      revision: input.revision ?? 1,
      epoch: input.epoch,
      generation: prior?.goal.generation ?? 0,
      target,
      priority,
      status: 'planning',
    };
    this.#entries.set(goal.id, { goal, tasks: [], states: new Map(), evidence: [], expiresAt: 0 });
    this.emit(
      prior?.goal.status === 'failed' && prior.goal.revision === goal.revision
        ? 'goal.replanning'
        : 'goal.accepted',
      structuredClone(goal),
    );
    return structuredClone(goal);
  }
  list(): RuntimeGoal[] {
    return [...this.#entries.values()].map((e) => structuredClone(e.goal));
  }
  tasksFor(goalId: string) {
    const entry = this.#entries.get(goalId);
    return entry
      ? entry.tasks.map((task) => ({
          id: task.id,
          capabilityId: task.capabilityId,
          state: entry.states.get(task.id),
        }))
      : [];
  }
  acceptPlan(goalId: string, revision: number, suggestions: unknown, validForMs: number): void {
    const entry = this.#entries.get(goalId);
    if (
      !entry ||
      entry.goal.revision !== revision ||
      !['planning', 'running'].includes(entry.goal.status)
    )
      throw new Error('stale_goal');
    if (!Number.isInteger(validForMs) || validForMs < 1 || validForMs > 300000)
      throw new Error('invalid_plan_expiry');
    const tasks = this.skills.accept(suggestions, entry.goal.priority);
    const required = entry.goal.target.type === 'openContainerAt' ? 'openContainer' : 'navigate';
    if (!tasks.some((task) => task.capabilityId === required))
      throw new Error('required_skill_missing');
    for (const task of tasks) {
      const point = (task.params as { target?: { x: number; y: number; z: number } }).target;
      const t = entry.goal.target.position;
      if (!point || ![point.x, point.y, point.z].every(Number.isFinite))
        throw new Error('task_target_missing');
      const same = point.x === t.x && point.y === t.y && point.z === t.z;
      const adjacent =
        point.y === t.y &&
        Math.abs(Math.floor(point.x) - Math.floor(t.x)) +
          Math.abs(Math.floor(point.z) - Math.floor(t.z)) ===
          1;
      if (
        task.capabilityId === 'openContainer'
          ? !same
          : entry.goal.target.type === 'navigateToPosition'
            ? !same
            : task.capabilityId !== 'navigate' || !adjacent
      )
        throw new Error('task_target_mismatch');
    }
    if (this.#active?.entry === entry) this.#active.controller.abort();
    entry.goal.generation++;
    entry.tasks = tasks;
    entry.states = new Map(tasks.map((task) => [task.id, 'pending']));
    entry.evidence = [];
    entry.expiresAt = Date.now() + validForMs;
    entry.goal.status = 'running';
    const timer = setTimeout(() => this.wake(), validForMs);
    timer.unref?.();
    if (entry.goal.target.deadline !== undefined) {
      const deadlineTimer = setTimeout(
        () => this.wake(),
        Math.max(0, entry.goal.target.deadline - Date.now()),
      );
      deadlineTimer.unref?.();
    }
    this.emit('plan.accepted', { goalId, revision, generation: entry.goal.generation, tasks });
    this.wake();
  }
  cancel(goalId: string): void {
    const entry = this.#entries.get(goalId);
    if (!entry || ['succeeded', 'failed', 'cancelled'].includes(entry.goal.status)) return;
    entry.goal.status = 'cancelled';
    for (const [id, state] of entry.states)
      if (state !== 'succeeded') entry.states.set(id, 'cancelled');
    if (this.#active?.entry === entry) this.#active.controller.abort();
    this.emit('goal.cancelled', structuredClone(entry.goal));
    this.wake();
  }
  failPlanning(goalId: string, revision: number, reason: string): boolean {
    const entry = this.#entries.get(goalId);
    if (!entry || entry.goal.revision !== revision || entry.goal.status !== 'planning')
      return false;
    entry.goal.status = 'failed';
    entry.goal.reason = reason;
    this.emit('goal.failed', structuredClone(entry.goal));
    return true;
  }
  cancelAll(): void {
    for (const id of this.#entries.keys()) this.cancel(id);
  }
  close(): void {
    this.#closed = true;
    this.cancelAll();
  }
  wake(): void {
    if (this.#closed || this.#scheduled) return;
    this.#scheduled = true;
    queueMicrotask(() => {
      this.#scheduled = false;
      this.#schedule();
    });
  }
  #schedule(): void {
    if (this.#closed) return;
    const now = Date.now();
    for (const entry of this.#entries.values()) {
      if (entry.goal.status !== 'running') continue;
      if (
        entry.goal.epoch !== this.snapshot().sessionEpoch ||
        entry.goal.target.dimension !== this.snapshot().dimension ||
        now >= entry.expiresAt ||
        (entry.goal.target.deadline !== undefined && now >= entry.goal.target.deadline)
      ) {
        entry.goal.status = 'failed';
        entry.goal.reason =
          entry.goal.epoch !== this.snapshot().sessionEpoch ||
          entry.goal.target.dimension !== this.snapshot().dimension
            ? 'session_changed'
            : entry.goal.target.deadline !== undefined && now >= entry.goal.target.deadline
              ? 'goal_deadline_exceeded'
              : 'plan_expired';
        if (this.#active?.entry === entry) this.#active.controller.abort();
        this.emit('goal.failed', structuredClone(entry.goal));
      }
    }
    const ready = [...this.#entries.values()].flatMap((entry) =>
      entry.goal.status !== 'running'
        ? []
        : entry.tasks
            .filter(
              (task) =>
                entry.states.get(task.id) === 'pending' &&
                task.dependsOn.every((dep) => entry.states.get(dep) === 'succeeded'),
            )
            .map((task) => ({ entry, task })),
    );
    const available = this.#active
      ? [...ready, { entry: this.#active.entry, task: this.#active.task }]
      : ready;
    const candidates: Candidate[] = available.map(({ entry, task }) => ({
      id: task.id,
      capability: task.capabilityId,
      resources: task.resources,
      preconditions: [],
      priority: entry.goal.priority,
      ...this.utility(structuredClone(entry.goal), structuredClone(task)),
      preemptible: task.preemptible,
    }));
    const caps = new Set(this.skills.descriptions().map((s) => s.id));
    const selected = this.#selector.choose(candidates, caps, new Set());
    const next = available.find(({ task }) => task.id === selected?.id);
    if (this.#active) {
      if (next && next.task.id !== this.#active.task.id && this.#active.task.preemptible) {
        this.emit('decision.preempted', {
          goalId: this.#active.entry.goal.id,
          revision: this.#active.entry.goal.revision,
          generation: this.#active.entry.goal.generation,
          taskId: this.#active.task.id,
          nextGoalId: next.entry.goal.id,
          nextTaskId: next.task.id,
        });
        this.#active.controller.abort('preempted');
      }
      return;
    }
    if (!next) return;
    this.emit('decision.selected', {
      goalId: next.entry.goal.id,
      revision: next.entry.goal.revision,
      generation: next.entry.goal.generation,
      taskId: next.task.id,
    });
    void this.#run(next.entry, next.task);
  }
  async #run(entry: Entry, task: TaskNode): Promise<void> {
    const skill = this.skills.get(task.capabilityId)!;
    const controller = new AbortController(),
      generation = entry.goal.generation,
      revision = entry.goal.revision,
      epoch = entry.goal.epoch;
    this.#active = { entry, task, controller };
    entry.states.set(task.id, 'running');
    this.emit('task.running', { goalId: entry.goal.id, revision, generation, taskId: task.id });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort('task_timeout');
    }, task.timeoutMs);
    try {
      const aborted = new Promise<never>((_, reject) =>
        controller.signal.addEventListener('abort', () => reject(new Error('task_aborted')), {
          once: true,
        }),
      );
      const result = await Promise.race([
        skill.execute(task.params, controller.signal, {
          sessionId: entry.goal.sessionId,
          goalId: entry.goal.id,
          revision,
          generation,
          sessionEpoch: epoch,
          taskId: task.id,
          priority: entry.goal.priority,
          target: structuredClone(entry.goal.target),
        }),
        aborted,
      ]);
      if (
        controller.signal.aborted ||
        entry.goal.status !== 'running' ||
        entry.goal.generation !== generation ||
        entry.goal.revision !== revision ||
        this.snapshot().sessionEpoch !== epoch
      )
        throw new Error('stale_task');
      if (!skill.verify(task.params, result)) throw new Error('success_condition_not_observed');
      entry.states.set(task.id, 'succeeded');
      const evidence = result as SkillEvidence;
      if (evidence?.skillId === task.capabilityId && evidence.sessionEpoch === epoch)
        entry.evidence.push(structuredClone(evidence));
      this.emit('task.succeeded', {
        goalId: entry.goal.id,
        revision,
        generation,
        taskId: task.id,
        result,
      });
      if (entry.tasks.every((t) => entry.states.get(t.id) === 'succeeded')) {
        if (goalObserved(entry.goal.target, this.snapshot(), entry.evidence))
          entry.goal.status = 'succeeded';
        else {
          entry.goal.status = 'failed';
          entry.goal.reason = 'goal_evidence_missing';
        }
        this.emit(`goal.${entry.goal.status}`, structuredClone(entry.goal));
      }
    } catch (error) {
      if (
        entry.goal.status === 'running' &&
        entry.goal.generation === generation &&
        entry.goal.revision === revision
      ) {
        if (controller.signal.reason === 'preempted' && !timedOut) {
          entry.states.set(task.id, 'pending');
          this.emit('task.pending', {
            goalId: entry.goal.id,
            revision,
            generation,
            taskId: task.id,
          });
        } else {
          entry.states.set(task.id, 'failed');
          entry.goal.status = 'failed';
          entry.goal.reason = timedOut
            ? 'task_timeout'
            : error instanceof Error
              ? error.message
              : 'task_failed';
          this.emit('goal.failed', structuredClone(entry.goal));
        }
      }
    } finally {
      clearTimeout(timer);
      if (this.#active?.controller === controller) this.#active = undefined;
      this.wake();
    }
  }
}
