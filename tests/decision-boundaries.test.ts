import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  DecisionRuntime,
  SkillRegistry,
  type SkillContext,
  type SkillEvidence,
} from '../packages/decision/src/index.js';
import { WorldModel } from '../packages/world/src/index.js';

const target = {
  type: 'navigateToPosition' as const,
  position: { x: 4.5, y: 1, z: 0.5 },
  dimension: 'minecraft:overworld',
  forbidBlockBreaking: true as const,
};
const proposal = (id: string, timeoutMs = 1000) => ({
  id,
  capabilityId: 'navigate',
  params: { target: target.position },
  dependsOn: [],
  timeoutMs,
});
const evidence: SkillEvidence = {
  skillId: 'navigate',
  target: target.position,
  sessionEpoch: 0,
  observed: true,
};
const waitUntil = async (condition: () => boolean) => {
  const end = Date.now() + 1000;
  while (!condition()) {
    if (Date.now() > end) throw new Error('test_condition_timeout');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
};
function setup(
  execute: (signal: AbortSignal, context: SkillContext) => Promise<SkillEvidence>,
  preemptible = true,
) {
  const skills = new SkillRegistry();
  skills.register({
    id: 'navigate',
    description: 'navigate',
    params: z
      .object({ target: z.object({ x: z.number(), y: z.number(), z: z.number() }).strict() })
      .strict(),
    resources: ['move'],
    minTimeoutMs: 1,
    maxTimeoutMs: 5000,
    preemptible,
    execute: (_params, signal, context) => execute(signal, context),
    verify: (_params, result) => !!(result as SkillEvidence).observed,
  });
  const snapshot = new WorldModel().snapshot();
  snapshot.position = target.position;
  const events: { type: string; payload: any }[] = [];
  const runtime = new DecisionRuntime(
    skills,
    () => snapshot,
    (type, payload) => events.push({ type, payload }),
  );
  return { runtime, events };
}

describe('decision runtime execution boundaries', () => {
  it('aborts an active preemptible task for a higher priority goal', async () => {
    const starts: { goal: string; signal: AbortSignal }[] = [];
    const { runtime, events } = setup((signal, context) => {
      starts.push({ goal: context.goalId, signal });
      return new Promise(() => {});
    });
    try {
      const low = runtime.create({ sessionId: 's', epoch: 0, target, priority: 0.1 });
      runtime.acceptPlan(low.id, 1, [proposal('low')], 2000);
      await waitUntil(() => starts.length === 1);
      const high = runtime.create({ sessionId: 's', epoch: 0, target, priority: 0.9 });
      runtime.acceptPlan(high.id, 1, [proposal('high')], 2000);
      await waitUntil(() => starts.length === 2);
      expect(starts.map((s) => s.goal)).toEqual([low.id, high.id]);
      expect(starts[0]!.signal.aborted).toBe(true);
      expect(events.some((event) => event.type === 'decision.preempted')).toBe(true);
      expect(
        events.some((event) => event.type === 'task.pending' && event.payload.goalId === low.id),
      ).toBe(true);
    } finally {
      runtime.close();
    }
  });
  it('does not interrupt a non-preemptible task for a higher priority goal', async () => {
    const starts: { goal: string; signal: AbortSignal; finish: (v: SkillEvidence) => void }[] = [];
    const { runtime } = setup(
      (signal, context) =>
        new Promise((finish) => starts.push({ goal: context.goalId, signal, finish })),
      false,
    );
    try {
      const low = runtime.create({ sessionId: 's', epoch: 0, target, priority: 0.1 });
      runtime.acceptPlan(low.id, 1, [proposal('low')], 2000);
      await waitUntil(() => starts.length === 1);
      const high = runtime.create({ sessionId: 's', epoch: 0, target, priority: 0.9 });
      runtime.acceptPlan(high.id, 1, [proposal('high')], 2000);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(starts).toHaveLength(1);
      expect(starts[0]!.signal.aborted).toBe(false);
      starts[0]!.finish(evidence);
      await waitUntil(() => starts.length === 2);
      expect(starts[1]!.goal).toBe(high.id);
    } finally {
      runtime.close();
    }
  });
  it('isolates a new plan generation from a late result of the same goal revision', async () => {
    const starts: { signal: AbortSignal; finish: (v: SkillEvidence) => void }[] = [];
    const { runtime } = setup((signal) => new Promise((finish) => starts.push({ signal, finish })));
    try {
      const goal = runtime.create({ sessionId: 's', epoch: 0, target });
      runtime.acceptPlan(goal.id, 1, [proposal('old')], 2000);
      await waitUntil(() => starts.length === 1);
      runtime.acceptPlan(goal.id, 1, [proposal('new')], 2000);
      await waitUntil(() => starts.length === 2);
      expect(starts[0]!.signal.aborted).toBe(true);
      starts[0]!.finish(evidence);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(runtime.list()[0]).toMatchObject({ status: 'running', generation: 2 });
      expect(runtime.tasksFor(goal.id)[0]?.state).toBe('running');
      starts[1]!.finish(evidence);
      await waitUntil(() => runtime.list()[0]?.status === 'succeeded');
    } finally {
      runtime.close();
    }
  });
  it('reports task timeout as failure and explicit cancellation as cancelled', async () => {
    const { runtime } = setup(() => new Promise(() => {}));
    try {
      const timed = runtime.create({ sessionId: 's', epoch: 0, target });
      runtime.acceptPlan(timed.id, 1, [proposal('timed', 20)], 1000);
      await waitUntil(() => runtime.list().find((g) => g.id === timed.id)?.status === 'failed');
      expect(runtime.list().find((g) => g.id === timed.id)?.reason).toBe('task_timeout');
      const cancelled = runtime.create({ sessionId: 's', epoch: 0, target });
      runtime.acceptPlan(cancelled.id, 1, [proposal('cancel', 1000)], 2000);
      await waitUntil(() => runtime.tasksFor(cancelled.id)[0]?.state === 'running');
      runtime.cancel(cancelled.id);
      await waitUntil(
        () => runtime.list().find((g) => g.id === cancelled.id)?.status === 'cancelled',
      );
      expect(runtime.list().find((g) => g.id === cancelled.id)?.reason).toBeUndefined();
    } finally {
      runtime.close();
    }
  });
  it('aborts an active action when its plan expires', async () => {
    let signal: AbortSignal | undefined;
    const { runtime } = setup((s) => {
      signal = s;
      return new Promise(() => {});
    });
    try {
      const goal = runtime.create({ sessionId: 's', epoch: 0, target });
      runtime.acceptPlan(goal.id, 1, [proposal('expiring', 1000)], 25);
      await waitUntil(() => !!signal);
      await waitUntil(() => runtime.list()[0]?.status === 'failed');
      expect(runtime.list()[0]?.reason).toBe('plan_expired');
      expect(signal!.aborted).toBe(true);
    } finally {
      runtime.close();
    }
  });
  it('rejects wrong target/dimension and rejects invalid batches without partial tasks', () => {
    const { runtime } = setup(() => new Promise(() => {}));
    try {
      expect(() =>
        runtime.create({
          sessionId: 's',
          epoch: 0,
          target: { ...target, dimension: 'minecraft:the_nether' },
        }),
      ).toThrow('target_session_or_dimension_mismatch');
      const goal = runtime.create({ sessionId: 's', epoch: 0, target });
      expect(() =>
        runtime.acceptPlan(
          goal.id,
          1,
          [proposal('valid'), { ...proposal('wrong'), params: { target: { x: 9, y: 1, z: 0 } } }],
          1000,
        ),
      ).toThrow('task_target_mismatch');
      expect(runtime.tasksFor(goal.id)).toEqual([]);
      expect(() =>
        runtime.acceptPlan(
          goal.id,
          1,
          [proposal('valid'), { ...proposal('unknown'), capabilityId: 'other' }],
          1000,
        ),
      ).toThrow('unknown_skill');
      expect(runtime.tasksFor(goal.id)).toEqual([]);
      expect(() =>
        runtime.acceptPlan(
          goal.id,
          1,
          [
            proposal('valid'),
            { ...proposal('invalid'), params: { target: { x: 'wrong', y: 1, z: 0 } } },
          ],
          1000,
        ),
      ).toThrow();
      expect(runtime.tasksFor(goal.id)).toEqual([]);
      expect(runtime.list()[0]?.generation).toBe(0);
    } finally {
      runtime.close();
    }
  });
});
