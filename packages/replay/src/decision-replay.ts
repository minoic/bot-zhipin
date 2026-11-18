import { TaskNodeSchema } from '../../contracts/src/index.js';
import { ModelResponseSchema, type ModelResponse } from '../../llm/src/schemas.js';
import { replayRecorded, type ReplayEvent } from './index.js';

export type ReplayedGoal = {
  id: string;
  revision: number;
  status: string;
  generation: number;
  reason?: string;
  question?: string;
  target?: unknown;
  tasks: Record<string, { status: string; task: unknown; result?: unknown }>;
  models: ModelResponse[];
};
export type DecisionReplay = {
  goals: Record<string, ReplayedGoal>;
  /** Recorded acceptance and completion order, without issuing model or game requests. */
  timeline: Array<{ seq: number; at: number; type: string; payload: unknown }>;
};

/** Reconstructs state only from validated recorded responses and scheduler events. */
export async function replayDecision(events: readonly ReplayEvent[]): Promise<DecisionReplay> {
  const goals: Record<string, ReplayedGoal> = Object.create(null) as Record<string, ReplayedGoal>;
  const timeline: DecisionReplay['timeline'] = [];
  await replayRecorded(events, (event) => {
    const payload = event.payload;
    timeline.push({
      seq: event.seq,
      at: event.at,
      type: event.type,
      payload: structuredClone(payload),
    });
    if (event.type === 'goals.stopped' && Array.isArray(payload)) {
      for (const item of payload) {
        if (!item || typeof item !== 'object') continue;
        const row = item as Record<string, unknown>;
        const goal = typeof row.id === 'string' ? goals[row.id] : undefined;
        if (
          goal &&
          !['succeeded', 'failed', 'cancelled'].includes(goal.status) &&
          row.revision === goal.revision &&
          row.status === 'cancelled'
        )
          goal.status = 'cancelled';
      }
      return;
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
    const data = payload as Record<string, unknown>;
    const id =
      typeof data.goalId === 'string'
        ? data.goalId
        : typeof data.id === 'string'
          ? data.id
          : undefined;
    const revision = data.revision;
    if (!id || !Number.isSafeInteger(revision) || (revision as number) < 1) return;
    let goal = goals[id];
    if (event.type === 'goal.accepted') {
      if (
        goal &&
        ((revision as number) < goal.revision ||
          ((revision as number) === goal.revision &&
            ['succeeded', 'failed', 'cancelled'].includes(goal.status)))
      )
        return;
      if (!goal || (revision as number) > goal.revision) {
        goal = {
          id,
          revision: revision as number,
          status: 'planning',
          generation: 0,
          tasks: Object.create(null) as ReplayedGoal['tasks'],
          models: [],
        };
        goals[id] = goal;
      }
      if (data.target !== undefined) goal.target = structuredClone(data.target);
      if (typeof data.status === 'string') goal.status = data.status;
      return;
    }
    if (!goal || ['succeeded', 'failed', 'cancelled'].includes(goal.status)) return;
    if (event.type === 'goal.awaitingClarification' && (revision as number) === goal.revision + 1) {
      goal.revision = revision as number;
      goal.status = 'awaitingClarification';
      if (typeof data.question === 'string') goal.question = data.question;
      return;
    }
    if (revision !== goal.revision) return;
    if (event.type === 'goal.replan.requested' || event.type === 'goal.replanning') {
      goal.status = 'planning';
      if (typeof data.reason === 'string') goal.reason = data.reason;
      return;
    }
    if (event.type === 'goal.target.confirmed' && data.target !== undefined) {
      goal.target = structuredClone(data.target);
      return;
    }
    if (event.type === 'model.intent.accepted' || event.type === 'model.plan.accepted') {
      if (data.response === undefined) return; // Legacy demo recorded already accepted task nodes only.
      const parsed = ModelResponseSchema.parse(data.response);
      if (
        event.type === 'model.intent.accepted' &&
        parsed.kind !== 'intent' &&
        parsed.kind !== 'clarification'
      )
        throw new Error('replay_invalid_model_response_kind');
      if (
        event.type === 'model.plan.accepted' &&
        (parsed.kind !== 'plan' || parsed.goalId !== id || parsed.goalRevision !== revision)
      )
        throw new Error('replay_invalid_model_response_kind');
      goal.models.push(parsed);
      return;
    }
    if (event.type === 'plan.accepted') {
      if (
        !Number.isSafeInteger(data.generation) ||
        (data.generation as number) <= goal.generation ||
        !Array.isArray(data.tasks)
      )
        throw new Error('replay_invalid_plan');
      const tasks = data.tasks.map((task) => TaskNodeSchema.parse(task));
      if (new Set(tasks.map((task) => task.id)).size !== tasks.length)
        throw new Error('replay_invalid_plan');
      goal.generation = data.generation as number;
      goal.tasks = Object.create(null) as ReplayedGoal['tasks'];
      for (const task of tasks) goal.tasks[task.id] = { status: 'pending', task };
      goal.status = 'running';
      delete goal.reason;
      return;
    }
    if (event.type.startsWith('task.')) {
      if (goal.status !== 'running') return;
      if (data.generation !== goal.generation || typeof data.taskId !== 'string') return;
      const task = goal.tasks[data.taskId];
      if (!task || ['succeeded', 'failed', 'cancelled'].includes(goal.status)) return;
      const status = event.type.slice(5);
      if (!['running', 'succeeded', 'failed', 'cancelled', 'pending'].includes(status)) return;
      task.status = status;
      if (data.result !== undefined) task.result = structuredClone(data.result);
      return;
    }
    const status = event.type.slice(5);
    if (
      event.type.startsWith('goal.') &&
      ['running', 'succeeded', 'failed', 'cancelled'].includes(status)
    ) {
      if (['succeeded', 'failed', 'cancelled'].includes(goal.status)) return;
      goal.status = status;
      if (typeof data.reason === 'string') goal.reason = data.reason;
    }
  });
  return { goals, timeline };
}
