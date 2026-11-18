import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import {
  InputFrameSchema,
  type ClientDriver,
  type ControlLease,
  type InputFrame,
  type Outcome,
  type Vec3,
} from '../../../packages/contracts/src/index.js';
import { ActionController, LeaseArbiter } from '../../../packages/controller/src/index.js';
import {
  GoalStore,
  TaskGraphExecutor,
  SkillRegistry,
  UtilitySelector,
} from '../../../packages/decision/src/index.js';
import { ModelRequestCoordinator, OfflineProvider } from '../../../packages/llm/src/index.js';
import { AStarPlanner } from '../../../packages/planner/src/index.js';
import { WorldModel } from '../../../packages/world/src/index.js';
import { log, openStores, closeStores } from './logging.js';
class DemoDriver implements ClientDriver {
  readonly capabilities = new Set(['move', 'look', 'inventory', 'navigate']);
  position: Vec3 = { x: 0.5, y: 1, z: 0.5 };
  #lease: ControlLease | undefined;
  subscribe() {
    return () => {};
  }
  apply(raw: InputFrame, lease: ControlLease) {
    const frame = InputFrameSchema.parse(raw);
    this.#lease = lease;
    const yaw = frame.yaw ?? 0;
    if (frame.forward) {
      this.position = {
        ...this.position,
        x: this.position.x - Math.sin(yaw) * 0.1,
        z: this.position.z - Math.cos(yaw) * 0.1,
      };
    }
  }
  async interact(req: { requestId: string }): Promise<Outcome> {
    return { status: 'rejected', requestId: req.requestId, reason: 'interaction_not_supported' };
  }
  releaseInputs() {
    this.#lease = undefined;
  }
}
export async function runDemo(
  text = 'navigate to 4 1 0',
  requestedTarget: Vec3 = { x: 4, y: 1, z: 0 },
) {
  const sessionId = randomUUID();
  await openStores(sessionId);
  try {
    const target = {
      ...requestedTarget,
      x: Math.floor(requestedTarget.x) + 0.5,
      z: Math.floor(requestedTarget.z) + 0.5,
    };
    const seq = { value: 0 },
      world = new WorldModel(),
      store = new GoalStore(),
      planner = new AStarPlanner(),
      provider = new ModelRequestCoordinator(new OfflineProvider()),
      driver = new DemoDriver(),
      arbiter = new LeaseArbiter(),
      controller = new ActionController(driver, arbiter);
    const goal = store.upsert({
      id: randomUUID(),
      sessionId,
      revision: 1,
      text,
      target,
      priority: 0.5,
    });
    log('goal.accepted', goal, seq);
    for (let x = -8; x <= 8; x++)
      for (let z = -8; z <= 8; z++) {
        world.setBlock({ x, y: 0, z }, 'stone', true);
        world.setBlock({ x, y: 1, z }, 'air', false);
        world.setBlock({ x, y: 2, z }, 'air', false);
      }
    const proposal = await provider.plan(goal, world.snapshot(), [...driver.capabilities]);
    const skills = new SkillRegistry();
    skills.register({
      id: 'navigate',
      description: 'navigate on known flat terrain',
      params: z
        .object({ target: z.object({ x: z.number(), y: z.number(), z: z.number() }) })
        .strict(),
      resources: ['move', 'look'],
      minTimeoutMs: 1,
      maxTimeoutMs: 30000,
      preemptible: true,
      execute: async () => ({}),
      verify: () => false,
    });
    const acceptedTasks = skills.accept(proposal.tasks, goal.priority);
    store.addTasks(acceptedTasks, goal.id);
    log(
      'model.plan.accepted',
      { requestId: 'offline', goalId: goal.id, revision: goal.revision, tasks: acceptedTasks },
      seq,
    );
    const plan = await planner.plan({
      start: driver.position,
      goal: target,
      snapshot: world.snapshot(),
      sessionEpoch: 0,
      budget: { maxExpansions: 5000, deadline: performance.now() + 1000 },
    });
    log('planner.result', plan, seq);
    const selector = new UtilitySelector();
    const selected = selector.choose(
      [
        {
          id: acceptedTasks[0]!.id,
          capability: 'navigate',
          resources: ['move', 'look'],
          preconditions: [],
          priority: goal.priority,
          progress: 1,
          urgency: 0.5,
          confidence: 1,
          time: 0,
          risk: 0,
          switchingCost: 0,
          preemptible: true,
        },
      ],
      driver.capabilities,
      new Set(),
    );
    if (!selected) throw new Error('no_eligible_navigation_task');
    log('decision.selected', selected, seq);
    const executor = new TaskGraphExecutor(store, driver.capabilities);
    await executor.runReady(
      async (_task, signal) => {
        if (plan.status !== 'found') throw new Error(`navigation_${plan.status}`);
        for (const point of plan.path.slice(1)) {
          if (signal.aborted) throw new Error('cancelled');
          let attempts = 0;
          while (
            Math.hypot(point.x - driver.position.x, point.z - driver.position.z) > 0.15 &&
            attempts < 100
          ) {
            const dx = point.x - driver.position.x,
              dz = point.z - driver.position.z;
            const yaw = Math.atan2(-dx, -dz);
            const out = await controller.runFrames(
              [InputFrameSchema.parse({ forward: true, yaw })],
              {
                owner: 'demo-navigator',
                priority: 1,
                preemptible: true,
                resources: ['move', 'look'],
                tickMs: 1,
                signal,
              },
            );
            if (out.reason) throw new Error(out.reason);
            attempts++;
          }
          if (Math.hypot(point.x - driver.position.x, point.z - driver.position.z) > 0.15)
            throw new Error('simulated_waypoint_not_reached');
          log(
            'observation.position',
            { source: 'deterministic-simulation-fixture', position: driver.position },
            seq,
          );
        }
        return { position: driver.position };
      },
      (_task, result) =>
        Math.hypot((result as any).position.x - target.x, (result as any).position.z - target.z) <
        0.2,
    );
    log(
      'task.results',
      {
        taskStates: acceptedTasks.map((t) => ({ id: t.id, state: store.taskState(t.id) })),
        position: driver.position,
      },
      seq,
    );
    executor.close();
    if (store.taskState(acceptedTasks[0]!.id) !== 'succeeded')
      throw new Error('demo_goal_not_verified');
    log('demo.complete', { goal: text, position: driver.position }, seq);
    return { goal, position: driver.position, state: store.taskState(acceptedTasks[0]!.id) };
  } finally {
    await closeStores();
  }
}
