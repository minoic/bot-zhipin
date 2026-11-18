import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { InputFrameSchema, type Vec3 } from '../../../packages/contracts/src/index.js';
import { ActionController, MineflayerDriver } from '../../../packages/controller/src/index.js';
import {
  SkillRegistry,
  type SkillContext,
  type SkillEvidence,
} from '../../../packages/decision/src/index.js';
import { AStarPlanner } from '../../../packages/planner/src/index.js';
import { WorldModel } from '../../../packages/world/src/index.js';

const paramsSchema = z
  .object({
    target: z
      .object({ x: z.number().finite(), y: z.number().finite(), z: z.number().finite() })
      .strict(),
  })
  .strict();
const distance = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.z - b.z);
export function createOnlineSkills(
  world: WorldModel,
  driver: MineflayerDriver,
  controller: ActionController,
): SkillRegistry {
  const registry = new SkillRegistry(),
    planner = new AStarPlanner();
  const navigate = async (target: Vec3, signal: AbortSignal, ctx: SkillContext) => {
    let replans = 0;
    while (replans <= 2) {
      const snapshot = world.snapshot();
      if (snapshot.sessionEpoch !== ctx.sessionEpoch || snapshot.dimension !== ctx.target.dimension)
        throw new Error('session_changed');
      const startY = Math.floor(snapshot.position.y);
      const targetY = Math.floor(target.y);
      if (startY !== targetY)
        throw new Error(
          `navigation_unsupported_height: 当前规划器仅支持同一高度（起点 y=${startY}，目标 y=${targetY}）`,
        );
      const plan = await planner.planInWorker({
        start: snapshot.position,
        goal: target,
        snapshot,
        sessionEpoch: ctx.sessionEpoch,
        budget: { maxExpansions: 5000, deadline: performance.now() + 1000 },
        signal,
      });
      if (plan.status !== 'found') throw new Error(`navigation_${plan.status}`);
      let invalidated = false;
      for (const point of [...plan.path.slice(1), target]) {
        let lastDistance = Infinity,
          unchanged = 0;
        while (distance(world.snapshot().position, point) > 0.25) {
          if (signal.aborted) throw new Error('cancelled');
          if (!world.dependenciesValid(plan.dependencies)) {
            invalidated = true;
            break;
          }
          const position = world.snapshot().position;
          const remaining = distance(position, point);
          if (remaining >= lastDistance - 0.005) unchanged++;
          else unchanged = 0;
          if (unchanged >= 30) throw new Error('navigation_no_progress');
          lastDistance = remaining;
          const yaw = Math.atan2(-(point.x - position.x), -(point.z - position.z));
          const out = await controller.runFrames([InputFrameSchema.parse({ forward: true, yaw })], {
            owner: `${ctx.goalId}:${ctx.taskId}`,
            priority: ctx.priority,
            preemptible: true,
            resources: ['move', 'look'],
            signal,
          });
          if (out.reason) throw new Error(out.reason);
        }
        if (invalidated) break;
      }
      if (invalidated) {
        replans++;
        continue;
      }
      let previous = world.snapshot().position;
      for (let tick = 0; tick < 2; tick++) {
        await driver.waitForTick(signal);
        const next = world.snapshot().position;
        if (distance(previous, next) > 0.08) throw new Error('navigation_not_stopped');
        previous = next;
      }
      const actual = world.snapshot().position;
      if (distance(actual, target) > 0.3 || Math.abs(actual.y - target.y) > 0.25)
        throw new Error('navigation_target_not_observed');
      return;
    }
    throw new Error('navigation_replan_exhausted');
  };
  registry.register({
    id: 'navigate',
    description: 'Navigate to a known reachable position on flat terrain',
    params: paramsSchema,
    resources: ['move', 'look'],
    minTimeoutMs: 100,
    maxTimeoutMs: 120000,
    preemptible: true,
    execute: async (raw, signal, ctx) => {
      const { target } = paramsSchema.parse(raw);
      await navigate(target, signal, ctx);
      return {
        skillId: 'navigate',
        target,
        sessionEpoch: ctx.sessionEpoch,
        observed: true,
      } satisfies SkillEvidence;
    },
    verify: (_p, result) => (result as SkillEvidence)?.observed === true,
  });
  registry.register({
    id: 'openContainer',
    description: 'Navigate next to a known container and open it',
    params: paramsSchema,
    resources: ['move', 'look', 'interact'],
    minTimeoutMs: 100,
    maxTimeoutMs: 120000,
    preemptible: true,
    execute: async (raw, signal, ctx) => {
      const { target } = paramsSchema.parse(raw),
        snapshot = world.snapshot();
      if (![target.x, target.y, target.z].every(Number.isInteger))
        throw new Error('container_target_not_block_coordinate');
      let adjacent: Vec3 | undefined;
      for (const [dx, dz] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const point = {
          x: Math.floor(target.x) + dx + 0.5,
          y: target.y,
          z: Math.floor(target.z) + dz + 0.5,
        };
        const route = await planner.planInWorker({
          start: snapshot.position,
          goal: point,
          snapshot,
          sessionEpoch: ctx.sessionEpoch,
          budget: { maxExpansions: 5000, deadline: performance.now() + 1000 },
          signal,
        });
        const visibility = world.raycast(
          { x: point.x, y: point.y + 1.62, z: point.z },
          { x: target.x + 0.5, y: target.y + 0.5, z: target.z + 0.5 },
        );
        if (route.status === 'found' && visibility.visible) {
          adjacent = point;
          break;
        }
      }
      if (!adjacent) throw new Error('container_no_reachable_neighbor');
      await navigate(adjacent, signal, ctx);
      const requestId = randomUUID();
      let matched = false;
      const unsubscribe = driver.subscribe((event) => {
        const payload = event.payload as {
          requestId?: string;
          sessionEpoch?: number;
          target?: Vec3;
        };
        if (
          event.type === 'interaction.observedOpen' &&
          event.sessionEpoch === ctx.sessionEpoch &&
          payload.sessionEpoch === ctx.sessionEpoch &&
          payload.requestId === requestId &&
          payload.target?.x === target.x &&
          payload.target?.y === target.y &&
          payload.target?.z === target.z
        )
          matched = true;
      });
      try {
        const outcome = await controller.interact(
          { requestId, target, action: 'openContainer' },
          { owner: `${ctx.goalId}:${ctx.taskId}`, priority: ctx.priority, signal },
        );
        if (outcome.reason === 'interaction_already_pending')
          throw new Error('interaction_barrier_active');
        if (outcome.status === 'rejected')
          throw new Error(outcome.reason ?? 'interaction_rejected');
        if (outcome.status !== 'observed' && !matched) {
          const end = Date.now() + 5000;
          while (!matched && Date.now() < end && !signal.aborted)
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        if (signal.aborted) throw new Error('cancelled');
        if (outcome.status !== 'observed' && !matched)
          throw new Error('interaction_outcome_unknown');
        return {
          skillId: 'openContainer',
          target,
          sessionEpoch: ctx.sessionEpoch,
          requestId,
          observed: true,
        } satisfies SkillEvidence;
      } finally {
        unsubscribe();
      }
    },
    verify: (_p, result) =>
      (result as SkillEvidence)?.observed === true && !!(result as SkillEvidence).requestId,
  });
  return registry;
}
