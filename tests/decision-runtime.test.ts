import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  DecisionRuntime,
  SkillRegistry,
  UtilitySelector,
  goalObserved,
  type SkillEvidence,
} from '../packages/decision/src/index.js';
import { WorldModel } from '../packages/world/src/index.js';

const wait = () => new Promise((resolve) => setTimeout(resolve, 10));
const target = {
  type: 'navigateToPosition' as const,
  position: { x: 4.5, y: 1, z: 0.5 },
  dimension: 'minecraft:overworld',
  forbidBlockBreaking: true as const,
};
const suggestion = (id: string, dependsOn: string[] = []) => ({
  id,
  capabilityId: 'navigate',
  params: { target: target.position },
  dependsOn,
  timeoutMs: 1000,
});
const registry = (fn: (signal: AbortSignal) => Promise<SkillEvidence>) => {
  const skills = new SkillRegistry();
  skills.register({
    id: 'navigate',
    description: 'navigate',
    params: z
      .object({ target: z.object({ x: z.number(), y: z.number(), z: z.number() }) })
      .strict(),
    resources: ['move'],
    minTimeoutMs: 1,
    maxTimeoutMs: 2000,
    preemptible: true,
    execute: (_p, signal) => fn(signal),
    verify: (_p, r) => !!(r as SkillEvidence).observed,
  });
  return skills;
};
describe('decision runtime', () => {
  it('rejects invalid plans atomically and assigns runtime authority', () => {
    const skills = registry(async () => {
      throw new Error('unused');
    });
    expect(() => skills.accept([suggestion('a', ['b']), suggestion('b', ['a'])], 0.3)).toThrow(
      'task_graph_cycle',
    );
    expect(() => skills.accept([{ ...suggestion('a'), resources: ['admin'] }], 0.3)).toThrow();
    const [task] = skills.accept([suggestion('a')], 0.3);
    expect(task?.id).not.toBe('a');
    expect(task?.resources).toEqual(['move']);
    expect(task?.priority).toBe(0.3);
  });
  it('runs a multilayer graph but rejects success without position observation', async () => {
    const world = new WorldModel();
    const skills = registry(async () => ({
      skillId: 'navigate',
      target: target.position,
      sessionEpoch: 0,
      observed: true,
    }));
    const runtime = new DecisionRuntime(skills, () => world.snapshot());
    const goal = runtime.create({ sessionId: 's', epoch: 0, target });
    runtime.acceptPlan(goal.id, 1, [suggestion('a'), suggestion('b', ['a'])], 1000);
    await wait();
    expect(runtime.list()[0]?.status).toBe('failed');
    expect(runtime.list()[0]?.reason).toBe('goal_evidence_missing');
    runtime.close();
  });
  it('keeps cancelled goals terminal when an operation finishes late', async () => {
    let finish!: (value: SkillEvidence) => void;
    const skills = registry(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const runtime = new DecisionRuntime(skills, () => new WorldModel().snapshot());
    const goal = runtime.create({ sessionId: 's', epoch: 0, target });
    runtime.acceptPlan(goal.id, 1, [suggestion('a')], 1000);
    await wait();
    runtime.cancel(goal.id);
    finish({ skillId: 'navigate', target: target.position, sessionEpoch: 0, observed: true });
    await wait();
    expect(runtime.list()[0]?.status).toBe('cancelled');
    runtime.close();
  });
  it('requires interaction evidence for a container and exact requested coordinates', () => {
    const world = new WorldModel();
    const snapshot = world.snapshot();
    snapshot.position = { x: 4.5, y: 1, z: 0.5 };
    expect(
      goalObserved({ ...target, position: { x: 4.9, y: 1, z: 0.5 } }, snapshot, [
        { skillId: 'navigate', target: { x: 4.9, y: 1, z: 0.5 }, sessionEpoch: 0, observed: true },
      ]),
    ).toBe(false);
    expect(
      goalObserved({ ...target, type: 'openContainerAt' }, snapshot, [
        { skillId: 'navigate', target: target.position, sessionEpoch: 0, observed: true },
      ]),
    ).toBe(false);
  });
  it('switches to a higher priority and compares updated current utility', () => {
    const selector = new UtilitySelector({ holdMs: 0, hysteresis: 0.1 });
    const base = {
      capability: 'navigate',
      resources: [],
      preconditions: [],
      priority: 1,
      progress: 0,
      urgency: 0,
      confidence: 0,
      time: 0,
      risk: 0,
      switchingCost: 0,
      preemptible: true,
    };
    const choose = (a: number, b: number, priority = 1) =>
      selector.choose(
        [
          { ...base, id: 'a', progress: a },
          { ...base, id: 'b', progress: b, priority },
        ],
        new Set(['navigate']),
        new Set(),
        1000,
      );
    expect(choose(10, 0)?.id).toBe('a');
    expect(choose(0, 1)?.id).toBe('b');
    expect(choose(100, 0, 2)?.id).toBe('b');
  });
});
