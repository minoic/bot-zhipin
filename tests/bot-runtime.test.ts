import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BotRuntime } from '../apps/bot/src/runtime.js';
import {
  ActionController,
  LeaseArbiter,
  MineflayerDriver,
} from '../packages/controller/src/index.js';
import { WorldModel } from '../packages/world/src/index.js';
import { SkillRegistry } from '../packages/decision/src/index.js';
import { AStarPlanner } from '../packages/planner/src/index.js';
import { z } from 'zod';
import {
  OfflineProvider,
  type ProviderAdapter,
  type ModelResponse,
} from '../packages/llm/src/index.js';

class Vec {
  constructor(
    public x: number,
    public y: number,
    public z: number,
  ) {}
}
const fixtures: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of fixtures.splice(0)) cleanup();
  vi.restoreAllMocks();
});

function makeRuntime(
  openContainer: () => Promise<unknown> = async () => ({ id: 1, title: 'Chest' }),
  provider?: ProviderAdapter,
  startX = 1.5,
  skills?: SkillRegistry,
) {
  const bot = new EventEmitter() as EventEmitter & Record<string, any>;
  bot.game = { dimension: 'minecraft:overworld' };
  bot.entity = { position: new Vec(startX, 64, 0.5), pitch: 0 };
  bot.currentWindow = null;
  let forward = false,
    yaw = 0;
  bot.setControlState = vi.fn((key: string, value: boolean) => {
    if (key === 'forward') forward = value;
  });
  bot.clearControlStates = vi.fn(() => {
    forward = false;
  });
  bot.look = vi.fn((value: number) => {
    yaw = value;
  });
  bot.blockAt = () => ({ name: 'chest', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] });
  bot.canSeeBlock = () => true;
  bot.openContainer = vi.fn(openContainer);
  const world = new WorldModel(),
    arbiter = new LeaseArbiter();
  const driver = new MineflayerDriver(bot, arbiter, { interactionTimeoutMs: 30 });
  const controller = new ActionController(driver, arbiter);
  const events: { type: string; payload: any }[] = [];
  driver.subscribe((event) => world.ingest(event));
  bot.emit('spawn');
  driver.importNearby(0);
  for (let x = -3; x <= 4; x++)
    for (let z = -3; z <= 3; z++) {
      world.setBlock({ x, y: 63, z }, 'stone', true);
      world.setBlock({ x, y: 64, z }, 'air', false);
      world.setBlock({ x, y: 65, z }, 'air', false);
    }
  world.setBlock({ x: 0, y: 64, z: 0 }, 'chest', true);
  const runtime = new BotRuntime(
    world,
    driver,
    controller,
    (type, payload) => events.push({ type, payload }),
    { ...(provider ? { provider } : {}), ...(skills ? { skills } : {}) },
  );
  runtime.setReady(true);
  const ticks = setInterval(() => {
    if (forward) {
      bot.entity.position.x -= Math.sin(yaw) * 0.1;
      bot.entity.position.z -= Math.cos(yaw) * 0.1;
      bot.emit('move');
    }
    bot.emit('physicsTick');
  }, 5);
  fixtures.push(() => {
    clearInterval(ticks);
    runtime.close();
    driver.disconnect();
  });
  return { bot, runtime, driver, world, events };
}
const settled = (runtime: BotRuntime, id: string) =>
  runtime.status().find((goal) => goal.id === id);
const idOf = (reply: string) => reply.match(/已接受 (\S+)/)![1]!;
const waitStatus = (runtime: BotRuntime, id: string, status: string, timeout = 2500) =>
  vi.waitFor(() => expect(settled(runtime, id)?.status).toBe(status), { timeout, interval: 10 });

function recoveringSkill(failures: number): SkillRegistry {
  const registry = new SkillRegistry();
  let attempts = 0;
  registry.register({
    id: 'navigate',
    description: 'test navigation',
    params: z.object({ target: z.object({ x: z.number(), y: z.number(), z: z.number() }) }),
    resources: ['move'],
    minTimeoutMs: 100,
    maxTimeoutMs: 120000,
    preemptible: true,
    execute: async (raw, _signal, context) => {
      if (++attempts <= failures) throw new Error('navigation_no_progress');
      return {
        skillId: 'navigate',
        target: (raw as { target: { x: number; y: number; z: number } }).target,
        sessionEpoch: context.sessionEpoch,
        observed: true,
      };
    },
    verify: () => true,
  });
  return registry;
}

describe('local command integration', () => {
  it.each([65, 63])(
    'reports unsupported height %i once without a model replan',
    async (targetY) => {
      const provider = new OfflineProvider();
      const intent = vi.spyOn(provider, 'generateIntent');
      const plan = vi.spyOn(provider, 'proposePlan');
      const search = vi.spyOn(AStarPlanner.prototype, 'planInWorker');
      const { runtime, events } = makeRuntime(undefined, provider);
      const id = idOf(runtime.command(`/goal 走到 1 ${targetY} 0`));

      await waitStatus(runtime, id, 'failed');
      expect(settled(runtime, id)?.reason).toBe(
        `navigation_unsupported_height: 当前规划器仅支持同一高度（起点 y=64，目标 y=${targetY}）`,
      );
      expect(events.filter((event) => event.type === 'goal.failed')).toHaveLength(1);
      expect(events.filter((event) => event.type === 'goal.replan.requested')).toHaveLength(0);
      expect(intent).toHaveBeenCalledTimes(1);
      expect(plan).toHaveBeenCalledTimes(1);
      expect(search).not.toHaveBeenCalled();
    },
  );

  it('uses block-height semantics for fractional navigation targets', async () => {
    const search = vi.spyOn(AStarPlanner.prototype, 'planInWorker');
    const { runtime } = makeRuntime();
    const id = idOf(runtime.command('/goal 走到 1 64.1 0'));
    await waitStatus(runtime, id, 'succeeded');
    expect(search).toHaveBeenCalledTimes(1);
  });

  it('still replans when a same-height route is unreachable', async () => {
    const provider = new OfflineProvider();
    const plan = vi.spyOn(provider, 'proposePlan');
    const { runtime, events } = makeRuntime(undefined, provider);
    const id = idOf(runtime.command('/goal 走到 8 64 0'));
    await waitStatus(runtime, id, 'failed');
    expect(settled(runtime, id)?.reason).toBe('navigation_unreachable');
    expect(events.filter((event) => event.type === 'goal.replan.requested')).toHaveLength(2);
    expect(plan).toHaveBeenCalledTimes(3);
  });

  it('replans twice in the same revision and increments generation', async () => {
    const { runtime, events } = makeRuntime(undefined, undefined, 1.5, recoveringSkill(2));
    const id = idOf(runtime.command('/goal 走到 1 64 0'));
    await waitStatus(runtime, id, 'succeeded');
    const accepted = events.filter(
      (event) => event.type === 'plan.accepted' && event.payload.goalId === id,
    );
    expect(accepted.map((event) => [event.payload.revision, event.payload.generation])).toEqual([
      [1, 1],
      [1, 2],
      [1, 3],
    ]);
    expect(events.filter((event) => event.type === 'goal.replan.requested')).toHaveLength(2);
  });

  it('stops after at most two replans when failures continue', async () => {
    const { runtime, events } = makeRuntime(undefined, undefined, 1.5, recoveringSkill(10));
    const id = idOf(runtime.command('/goal 走到 1 64 0'));
    await waitStatus(runtime, id, 'failed');
    expect(events.filter((event) => event.type === 'goal.replan.requested')).toHaveLength(2);
    expect(events.filter((event) => event.type === 'plan.accepted')).toHaveLength(3);
  });

  it('ignores a late replan after the user stops the goal', async () => {
    const offline = new OfflineProvider();
    let calls = 0;
    let firstPlan!: ModelResponse;
    let release!: (value: ModelResponse) => void;
    const provider: ProviderAdapter = {
      generateIntent: (req) => offline.generateIntent(req),
      proposePlan: async (req) => {
        if (++calls === 1) return (firstPlan = await offline.proposePlan(req));
        return new Promise((resolve) => {
          release = resolve;
        });
      },
      respond: (req) => offline.respond(req),
      cancel: () => {},
    };
    const { runtime, events } = makeRuntime(undefined, provider, 1.5, recoveringSkill(1));
    const id = idOf(runtime.command('/goal 走到 1 64 0'));
    await vi.waitFor(() => expect(release).toBeDefined());
    runtime.command('/stop');
    release(firstPlan);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(settled(runtime, id)?.status).toBe('cancelled');
    expect(events.filter((event) => event.type === 'plan.accepted')).toHaveLength(1);
  });
  it('stops active, queued and clarification goals without resuming the queue', async () => {
    const { runtime, bot } = makeRuntime(() => new Promise(() => {}));
    const active = idOf(runtime.command('/goal 打开 0 64 0 的箱子'));
    await vi.waitFor(() => expect(bot.openContainer).toHaveBeenCalledOnce());
    const queued = idOf(runtime.command('/goal 走到 1 64 0'));
    const clarify = idOf(runtime.command('/goal 打开那个箱子'));
    await waitStatus(runtime, clarify, 'awaitingClarification');
    expect(JSON.parse(runtime.command('/status'))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: clarify, revision: 2, status: 'awaitingClarification' }),
      ]),
    );
    runtime.command('/stop');
    for (const id of [active, queued, clarify])
      expect(settled(runtime, id)?.status).toBe('cancelled');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(bot.openContainer).toHaveBeenCalledOnce();
    expect(settled(runtime, queued)?.status).toBe('cancelled');
  });

  it('requires an explicit ID when multiple goals exist and replaces only the chosen goal', async () => {
    const { runtime } = makeRuntime();
    const a = idOf(runtime.command('/goal 打开那个箱子'));
    const b = idOf(runtime.command('/goal 带我过去'));
    await waitStatus(runtime, a, 'awaitingClarification');
    await waitStatus(runtime, b, 'awaitingClarification');
    expect(runtime.command('/replace 走到 1 64 0')).toContain('请指定 --goal');
    expect(runtime.command(`/replace --goal ${a} 打开另一个箱子`)).toContain(`已替换 ${a}`);
    await vi.waitFor(() => expect(settled(runtime, a)?.revision).toBe(4));
    expect(settled(runtime, b)).toMatchObject({ revision: 2, status: 'awaitingClarification' });
    expect(runtime.command(`/clarify ${a} 2 走到 1 64 0`)).toContain('已过期');
  });

  it('accepts a current clarification and rejects a stale answer', async () => {
    const { runtime } = makeRuntime();
    const id = idOf(runtime.command('/goal 打开那个箱子'));
    await waitStatus(runtime, id, 'awaitingClarification');
    expect(runtime.command(`/clarify ${id} 1 走到 1 64 0`)).toContain('已过期');
    expect(runtime.command(`/clarify ${id} 2 0 64 0`)).toContain('已接收');
    await waitStatus(runtime, id, 'succeeded');
  });

  it('completes navigation after observed position and braking ticks', async () => {
    const { runtime, world } = makeRuntime();
    const id = idOf(runtime.command('/goal 走到 3 64 0'));
    await waitStatus(runtime, id, 'succeeded');
    expect(world.snapshot().position.x).toBeGreaterThan(3.2);
  });

  it('opens the specified adjacent container after observed interaction', async () => {
    const { runtime, bot, world } = makeRuntime(undefined, undefined, 3.5);
    const id = idOf(runtime.command('/goal 打开 0 64 0 的箱子'));
    await waitStatus(runtime, id, 'succeeded');
    expect(bot.openContainer).toHaveBeenCalledOnce();
    expect(world.snapshot().position.x).toBeLessThan(1.8);
  });

  it('fails after bounded reconciliation while an unresolved interaction remains fenced', async () => {
    const { runtime, driver } = makeRuntime(() => new Promise(() => {}));
    const id = idOf(runtime.command('/goal 打开 0 64 0 的箱子'));
    await waitStatus(runtime, id, 'failed', 7500);
    expect(settled(runtime, id)?.reason).toBe('interaction_outcome_unknown');
    expect(driver.interactionBarrier).toMatchObject({ settled: false });
  }, 10000);

  it('does not reactivate a replaced goal when an old model result arrives', async () => {
    let release!: (response: ModelResponse) => void;
    const offline = new OfflineProvider();
    let calls = 0;
    const provider: ProviderAdapter = {
      generateIntent: (req) =>
        ++calls === 1
          ? new Promise((resolve) => {
              release = resolve;
            })
          : offline.generateIntent(req),
      proposePlan: (req) => offline.proposePlan(req),
      respond: (req) => offline.respond(req),
      cancel: () => {},
    };
    const { runtime, events } = makeRuntime(undefined, provider);
    const id = idOf(runtime.command('/goal 走到 2 64 0'));
    await vi.waitFor(() => expect(release).toBeDefined());
    expect(runtime.command(`/replace --goal ${id} 走到 1 64 0`)).toContain('已替换');
    release({ kind: 'clarification', question: 'late old question' });
    await waitStatus(runtime, id, 'succeeded');
    expect(settled(runtime, id)?.revision).toBe(2);
    expect(
      events.some(
        (e) =>
          e.type === 'goal.awaitingClarification' && e.payload.question === 'late old question',
      ),
    ).toBe(false);
  });

  it('does not reactivate a stopped goal when its model result arrives', async () => {
    let release!: (response: ModelResponse) => void;
    const offline = new OfflineProvider();
    const provider: ProviderAdapter = {
      generateIntent: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
      proposePlan: (req) => offline.proposePlan(req),
      respond: (req) => offline.respond(req),
      cancel: () => {},
    };
    const { runtime, events } = makeRuntime(undefined, provider);
    const id = idOf(runtime.command('/goal 走到 2 64 0'));
    await vi.waitFor(() => expect(release).toBeDefined());
    runtime.command('/stop');
    release({ kind: 'clarification', question: 'late stopped question' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled(runtime, id)?.status).toBe('cancelled');
    expect(
      events.some(
        (e) =>
          e.type === 'goal.awaitingClarification' && e.payload.question === 'late stopped question',
      ),
    ).toBe(false);
  });
});
