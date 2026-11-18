import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  TaskNodeSchema,
  type Snapshot,
  type TaskNode,
  type Vec3,
} from '../../contracts/src/index.js';

export const TargetSchema = z
  .object({
    type: z.enum(['navigateToPosition', 'openContainerAt']),
    position: z.object({ x: z.number().finite(), y: z.number().finite(), z: z.number().finite() }),
    dimension: z.string().min(1),
    forbidBlockBreaking: z.literal(true).default(true),
    deadline: z.number().finite().optional(),
  })
  .strict();
export type Target = z.infer<typeof TargetSchema>;
export type SkillDefinition = {
  id: string;
  description: string;
  params: z.ZodType;
  resources: string[];
  minTimeoutMs: number;
  maxTimeoutMs: number;
  preemptible: boolean;
  execute: (params: unknown, signal: AbortSignal, context: SkillContext) => Promise<unknown>;
  verify: (params: unknown, result: unknown) => boolean;
};
export type SkillContext = {
  sessionId: string;
  goalId: string;
  revision: number;
  generation: number;
  sessionEpoch: number;
  taskId: string;
  priority: number;
  target: Target;
};
export const TaskSuggestionSchema = z
  .object({
    id: z.string().min(1),
    capabilityId: z.string().min(1),
    params: z.unknown(),
    dependsOn: z.array(z.string()).default([]),
    timeoutMs: z.number().int().positive(),
  })
  .strict();
export type TaskSuggestion = z.infer<typeof TaskSuggestionSchema>;

/** Model task IDs are local aliases. Runtime policy owns all authority and task identities. */
export class SkillRegistry {
  #skills = new Map<string, SkillDefinition>();
  register(skill: SkillDefinition): void {
    if (this.#skills.has(skill.id)) throw new Error('duplicate_skill');
    this.#skills.set(skill.id, skill);
  }
  get(id: string): SkillDefinition | undefined {
    return this.#skills.get(id);
  }
  descriptions() {
    return [...this.#skills.values()].map(
      ({ id, description, params, minTimeoutMs, maxTimeoutMs }) => ({
        id,
        description,
        parameters: z.toJSONSchema(params),
        minTimeoutMs,
        maxTimeoutMs,
      }),
    );
  }
  accept(suggestions: unknown, priority: number): TaskNode[] {
    const batch = z.array(TaskSuggestionSchema).min(1).max(64).parse(suggestions);
    const aliases = new Map<string, string>();
    for (const task of batch) {
      if (aliases.has(task.id)) throw new Error('duplicate_task');
      aliases.set(task.id, randomUUID());
    }
    const tasks = batch.map((task) => {
      const skill = this.#skills.get(task.capabilityId);
      if (!skill) throw new Error(`unknown_skill:${task.capabilityId}`);
      const params = skill.params.parse(task.params);
      if (task.timeoutMs < skill.minTimeoutMs || task.timeoutMs > skill.maxTimeoutMs)
        throw new Error('invalid_timeout');
      const dependsOn = task.dependsOn.map((id) => {
        const mapped = aliases.get(id);
        if (!mapped) throw new Error(`unknown_dependency:${id}`);
        return mapped;
      });
      return TaskNodeSchema.parse({
        id: aliases.get(task.id),
        capabilityId: task.capabilityId,
        params,
        dependsOn,
        priority,
        timeoutMs: task.timeoutMs,
        successCondition: `verified:${skill.id}`,
        resources: skill.resources,
        preemptible: skill.preemptible,
      });
    });
    const visiting = new Set<string>(),
      visited = new Set<string>();
    const byId = new Map(tasks.map((task) => [task.id, task]));
    const visit = (id: string) => {
      if (visiting.has(id)) throw new Error('task_graph_cycle');
      if (visited.has(id)) return;
      visiting.add(id);
      for (const dep of byId.get(id)!.dependsOn) visit(dep);
      visiting.delete(id);
      visited.add(id);
    };
    for (const task of tasks) visit(task.id);
    return tasks;
  }
}

export type SkillEvidence = {
  skillId: string;
  target: Vec3;
  sessionEpoch: number;
  requestId?: string;
  observed: boolean;
};
export function goalObserved(
  target: Target,
  snapshot: Snapshot,
  evidence: readonly SkillEvidence[],
): boolean {
  if (snapshot.dimension !== target.dimension) return false;
  const same = (a: Vec3, b: Vec3) => a.x === b.x && a.y === b.y && a.z === b.z;
  if (target.type === 'openContainerAt')
    return evidence.some(
      (e) =>
        e.skillId === 'openContainer' &&
        e.observed &&
        !!e.requestId &&
        e.sessionEpoch === snapshot.sessionEpoch &&
        same(e.target, target.position),
    );
  const p = snapshot.position,
    t = target.position;
  return (
    Math.hypot(p.x - t.x, p.z - t.z) <= 0.3 &&
    Math.abs(p.y - t.y) <= 0.25 &&
    evidence.some(
      (e) =>
        e.skillId === 'navigate' &&
        e.observed &&
        e.sessionEpoch === snapshot.sessionEpoch &&
        same(e.target, target.position),
    )
  );
}
