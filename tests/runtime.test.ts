import { describe, expect, it } from 'vitest';
import type {
  ClientDriver,
  ControlLease,
  InputFrame,
  Outcome,
} from '../packages/contracts/src/index.js';
import { ActionController, LeaseArbiter } from '../packages/controller/src/index.js';
import { GoalStore, TaskGraphExecutor } from '../packages/decision/src/index.js';
import {
  ModelRequestCoordinator,
  OfflineProvider,
  buildContext,
  classifyRequestText,
} from '../packages/llm/src/index.js';
import { WorldModel } from '../packages/world/src/index.js';
import { goalRequestFixtures } from './fixtures/goal-requests.js';
import { PluginHost } from '../packages/plugins/src/index.js';

describe('world observations', () => {
  it('advances revisions, ignores stale sequence, and isolates snapshots', () => {
    const world = new WorldModel();
    world.setBlock({ x: 0, y: 0, z: 0 }, 'stone', true);
    const snapshot = world.snapshot();
    expect(snapshot.blocks.size).toBe(1);
    const event = {
      sessionEpoch: 0,
      dimension: 'minecraft:overworld',
      seq: 0,
      observedAt: 0,
      source: 'protocol' as const,
      type: 'block',
      payload: { position: { x: 1, y: 0, z: 0 }, name: 'stone', solid: true },
    };
    expect(world.ingest(event)).toBe(true);
    expect(world.ingest(event)).toBe(false);
    (snapshot.blocks as Map<string, { name: string; solid: boolean; revision: number }>).clear();
    expect(world.snapshot().blocks.size).toBe(2);
    expect(world.raycast({ x: 0.5, y: 0.5, z: 0.5 }, { x: 1.5, y: 0.5, z: 0.5 }).visible).toBe(
      false,
    );
  });
  it('invalidates observations across dimensions and fails closed through unknown space', () => {
    const world = new WorldModel();
    world.setBlock({ x: 0, y: 0, z: 0 }, 'air', false);
    expect(
      world.raycast({ x: 0.5, y: 0.5, z: 0.5 }, { x: 2.5, y: 0.5, z: 0.5 }).unknown,
    ).toBeDefined();
    world.ingest({
      sessionEpoch: 0,
      dimension: 'minecraft:the_nether',
      seq: 2,
      observedAt: 1,
      source: 'protocol',
      type: 'position',
      payload: { position: { x: 4, y: 5, z: 6 } },
    });
    expect(world.snapshot().dimension).toBe('minecraft:the_nether');
    expect(world.snapshot().blocks.size).toBe(0);
  });
  it('rejects malformed and independent server samples from online world state', () => {
    const world = new WorldModel();
    expect(
      world.ingest({
        sessionEpoch: 0,
        dimension: 'minecraft:overworld',
        seq: 0,
        observedAt: 1,
        source: 'server',
        type: 'block',
        payload: { position: { x: 0, y: 0, z: 0 }, name: 'stone', solid: true },
      }),
    ).toBe(false);
    expect(
      world.ingest({
        sessionEpoch: 1,
        dimension: 'minecraft:the_nether',
        seq: 1,
        observedAt: 1,
        source: 'protocol',
        type: 'position',
        payload: null,
      } as any),
    ).toBe(false);
    expect(world.snapshot().sessionEpoch).toBe(0);
    expect(world.snapshot().revision).toBe(0);
  });
});

describe('control leases', () => {
  it('denies non-preemptible conflicts and rejects revoked or forged leases', () => {
    const arbiter = new LeaseArbiter(),
      a = arbiter.acquire({
        owner: 'a',
        priority: 1,
        preemptible: false,
        resources: ['move'],
        expiresAt: Date.now() + 10000,
      })!;
    expect(
      arbiter.acquire({
        owner: 'b',
        priority: 10,
        preemptible: true,
        resources: ['move'],
        expiresAt: Date.now() + 10000,
      }),
    ).toBeUndefined();
    const b = arbiter.acquire({
      owner: 'c',
      priority: 2,
      preemptible: true,
      resources: ['look'],
      expiresAt: Date.now() + 10000,
    })!;
    expect(arbiter.valid({ ...b, owner: 'forged' })).toBe(false);
    expect(arbiter.valid(a)).toBe(true);
  });
  it('supports sequential frame actions after input release', async () => {
    let count = 0;
    const driver: ClientDriver = {
      capabilities: new Set(['move']),
      subscribe: () => () => {},
      apply: () => {
        count++;
      },
      interact: async (req) => ({ status: 'rejected', requestId: req.requestId }),
      releaseInputs: () => {},
    };
    const arbiter = new LeaseArbiter(),
      controller = new ActionController(driver, arbiter),
      frame = {
        forward: true,
        back: false,
        left: false,
        right: false,
        jump: false,
        sprint: false,
        sneak: false,
      };
    expect(
      (
        await controller.runFrames([frame], {
          owner: 'one',
          priority: 1,
          preemptible: true,
          tickMs: 0,
        })
      ).completed,
    ).toBe(1);
    expect(
      (
        await controller.runFrames([frame], {
          owner: 'two',
          priority: 1,
          preemptible: true,
          tickMs: 0,
        })
      ).completed,
    ).toBe(1);
    expect(count).toBe(2);
  });
});

describe('goal, task graph and model boundary', () => {
  it('classifies all fixed acceptance requests by their expected outcomes', () => {
    expect(goalRequestFixtures.length).toBeGreaterThanOrEqual(30);
    expect(new Set(goalRequestFixtures.map((f) => f.category)).size).toBe(6);
    for (const fixture of goalRequestFixtures) {
      expect(classifyRequestText(fixture.input), fixture.id).toBe(fixture.expected);
      if (fixture.target) expect(Object.values(fixture.target).every(Number.isFinite)).toBe(true);
    }
  });
  it('unblocks dependent tasks only after observed success', async () => {
    const store = new GoalStore();
    store.addTasks([
      {
        id: 'one',
        capabilityId: 'test',
        params: {},
        dependsOn: [],
        priority: 0.5,
        timeoutMs: 1000,
        successCondition: 'observed',
        resources: [],
        preemptible: true,
      },
      {
        id: 'two',
        capabilityId: 'test',
        params: {},
        dependsOn: ['one'],
        priority: 0.5,
        timeoutMs: 1000,
        successCondition: 'observed',
        resources: [],
        preemptible: true,
      },
    ]);
    expect(store.ready().map((t) => t.id)).toEqual(['one']);
    const exec = new TaskGraphExecutor(store, new Set(['test']));
    await exec.runReady(
      async () => ({ ok: true }),
      (_t, r) => (r as any).ok,
    );
    expect(store.ready().map((t) => t.id)).toEqual(['two']);
    await exec.runReady(
      async () => ({ ok: true }),
      (_t, r) => (r as any).ok,
    );
    expect(store.taskState('two')).toBe('succeeded');
    exec.close();
  });

  it('rejects cyclic task batches without storing partial tasks', () => {
    const store = new GoalStore();
    const task = (id: string, dependency: string) => ({
      id,
      capabilityId: 'test',
      params: {},
      dependsOn: [dependency],
      priority: 0.5,
      timeoutMs: 1000,
      successCondition: 'observed',
      resources: [],
      preemptible: true,
    });

    expect(() => store.addTasks([task('first', 'second'), task('second', 'first')])).toThrow(
      'task_graph_cycle',
    );
    expect(store.taskState('first')).toBeUndefined();
    expect(store.taskState('second')).toBeUndefined();
  });

  it('rejects unknown dependencies without storing partial tasks', () => {
    const store = new GoalStore();
    expect(() =>
      store.addTasks([
        {
          id: 'valid',
          capabilityId: 'test',
          params: {},
          dependsOn: [],
          priority: 0.5,
          timeoutMs: 1000,
          successCondition: 'observed',
          resources: [],
          preemptible: true,
        },
        {
          id: 'invalid',
          capabilityId: 'test',
          params: {},
          dependsOn: ['missing'],
          priority: 0.5,
          timeoutMs: 1000,
          successCondition: 'observed',
          resources: [],
          preemptible: true,
        },
      ]),
    ).toThrow('unknown_dependency:missing');
    expect(store.taskState('valid')).toBeUndefined();
  });
  it('fences in-flight results after goal revision changes', async () => {
    const store = new GoalStore();
    store.upsert({
      id: 'g',
      sessionId: 's',
      revision: 1,
      text: 'go',
      target: { x: 1, y: 1, z: 1 },
      priority: 0.5,
    });
    store.addTasks(
      [
        {
          id: 't',
          capabilityId: 'test',
          params: {},
          dependsOn: [],
          priority: 0.5,
          timeoutMs: 1000,
          successCondition: 'ok',
          resources: [],
          preemptible: true,
        },
      ],
      'g',
    );
    const exec = new TaskGraphExecutor(store, new Set(['test']));
    let release!: (v: unknown) => void;
    const pending = exec.runReady(
      () =>
        new Promise((r) => {
          release = r;
        }),
      () => true,
    );
    await new Promise((r) => setTimeout(r, 0));
    store.upsert({
      id: 'g',
      sessionId: 's',
      revision: 2,
      text: 'new goal',
      target: { x: 2, y: 1, z: 1 },
      priority: 0.5,
    });
    release({ ok: true });
    const result = await pending;
    expect(result[0]?.state).toBe('cancelled');
    expect(store.taskState('t')).toBe('cancelled');
    exec.close();
  });
  it('validates the offline planner output and bounds context', async () => {
    const world = new WorldModel(),
      goal = {
        id: 'g',
        sessionId: 's',
        revision: 1,
        text: 'navigate',
        target: { x: 3, y: 1, z: 2 },
        priority: 0.5,
      };
    const output = await new ModelRequestCoordinator(new OfflineProvider()).plan(
      goal,
      world.snapshot(),
      ['navigate'],
    );
    expect(output.goalRevision).toBe(1);
    const ctx = buildContext({ goal, snapshot: world.snapshot(), capabilities: ['navigate'] });
    expect((ctx.goal as any).sessionId).toBe('s');
    expect(() =>
      buildContext({ goal, snapshot: world.snapshot(), capabilities: [], maxBytes: 5 }),
    ).toThrow('context_budget_exceeded');
  });

  it('trims context to its UTF-8 byte budget', () => {
    const world = new WorldModel();
    world.ingest({
      sessionEpoch: 0,
      dimension: '测试世界',
      seq: 0,
      observedAt: 1,
      source: 'protocol',
      type: 'entity',
      payload: { id: 1, position: { x: 1, y: 1, z: 1 } },
    });
    const context = buildContext({
      goal: {
        id: 'g',
        sessionId: 's',
        revision: 1,
        text: '测试目标',
        priority: 0.5,
      },
      snapshot: world.snapshot(),
      capabilities: ['导航'],
      maxBytes: 300,
    });

    expect(context.world.nearbyEntities).toHaveLength(0);
    expect(new TextEncoder().encode(JSON.stringify(context)).byteLength).toBeLessThanOrEqual(300);
  });
});

describe('plugin lifecycle', () => {
  it('fences captured context and unsubscribes exactly once on unload', async () => {
    let release!: () => void,
      submitCount = 0,
      offCount = 0,
      ctx: any;
    const snapshot = new WorldModel().snapshot(),
      host = new PluginHost({
        allowlist: ['test'],
        capabilities: new Set(['navigate']),
        snapshot: () => snapshot,
        submitGoal: async () => {
          submitCount++;
          return { accepted: true };
        },
        onResult: () => () => {
          offCount++;
        },
      });
    const loading = host.load({
      manifest: {
        id: 'test',
        apiVersion: 1,
        capabilities: ['navigate'],
        subscriptions: ['result'],
      },
      start: async (context) => {
        ctx = context;
        context.onResult(() => {});
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(host.loaded).toEqual(['test']);
    expect(await host.unload('test')).toBe(true);
    expect(
      await ctx.submitGoal({ id: 'g', sessionId: 's', revision: 1, text: 'x', priority: 0.5 }),
    ).toEqual({ accepted: false, reason: 'plugin_unloaded' });
    expect(submitCount).toBe(0);
    expect(offCount).toBe(1);
    expect(() => ctx.observe()).toThrow('plugin_unloaded');
    release();
    await loading;
    expect(host.loaded).toEqual([]);
  });
});
