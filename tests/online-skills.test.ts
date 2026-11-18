import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  ActionController,
  LeaseArbiter,
  MineflayerDriver,
} from '../packages/controller/src/index.js';
import { AStarPlanner } from '../packages/planner/src/index.js';
import { WorldModel } from '../packages/world/src/index.js';
import { InputFrameSchema } from '../packages/contracts/src/index.js';

class Vec {
  constructor(
    public x: number,
    public y: number,
    public z: number,
  ) {}
}
function fixture() {
  const bot = new EventEmitter() as EventEmitter & Record<string, any>;
  bot.game = { dimension: 'minecraft:overworld' };
  bot.entity = { position: new Vec(0, 64, 0), pitch: 0 };
  bot.currentWindow = null;
  bot.setControlState = vi.fn();
  bot.clearControlStates = vi.fn();
  bot.blockAt = () => ({ name: 'chest', boundingBox: 'block' });
  bot.canSeeBlock = () => true;
  return bot;
}
const request = (requestId: string) => ({
  requestId,
  target: { x: 0, y: 64, z: 0 },
  action: 'openContainer',
});

describe('interaction lifecycle', () => {
  it('keeps a timed-out request fenced through window close until settlement and synchronization', async () => {
    vi.useFakeTimers();
    const bot = fixture();
    let resolve!: (v: unknown) => void;
    bot.openContainer = vi.fn(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const arbiter = new LeaseArbiter();
    const driver = new MineflayerDriver(bot, arbiter, { interactionTimeoutMs: 5000 });
    const events: Array<{ type: string; payload: any }> = [];
    driver.subscribe((e) => events.push(e));
    bot.emit('spawn');
    const lease = arbiter.acquire({
      owner: 'one',
      resources: ['interact'],
      priority: 1,
      preemptible: true,
      expiresAt: Date.now() + 30000,
    })!;
    const opening = driver.interact(request('old'), lease);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await opening).toMatchObject({ status: 'uncertain', requestId: 'old' });
    bot.emit('windowClose');
    expect(driver.synchronizeWindow()).toBe(true);
    expect(driver.interactionBarrier).toMatchObject({ requestId: 'old', settled: false });
    expect(await driver.interact(request('new'), lease)).toMatchObject({
      reason: 'interaction_already_pending',
    });
    bot.currentWindow = { id: 4 };
    resolve({ id: 4 });
    await Promise.resolve();
    expect(driver.interactionBarrier).toBeUndefined();
    expect(events.find((e) => e.type === 'interaction.observedOpen')?.payload).toMatchObject({
      requestId: 'old',
      sessionEpoch: 1,
    });
    driver.disconnect();
    vi.useRealTimers();
  });

  it('returns immediately on cancellation but retains the submitted interaction barrier', async () => {
    const bot = fixture();
    bot.openContainer = vi.fn(() => new Promise(() => {}));
    const arbiter = new LeaseArbiter();
    const driver = new MineflayerDriver(bot, arbiter);
    const controller = new ActionController(driver, arbiter);
    bot.emit('spawn');
    const signal = new AbortController();
    const pending = controller.interact(request('old'), {
      owner: 'one',
      priority: 1,
      signal: signal.signal,
    });
    signal.abort();
    expect(await pending).toMatchObject({ status: 'uncertain', reason: 'cancelled_after_submit' });
    expect(driver.interactionBarrier?.requestId).toBe('old');
    driver.disconnect();
  });

  it('does not let a prior-epoch completion release the new request barrier', async () => {
    const bot = fixture();
    const resolves: Array<(window: unknown) => void> = [];
    bot.openContainer = vi.fn(() => new Promise((resolve) => resolves.push(resolve)));
    const arbiter = new LeaseArbiter();
    const driver = new MineflayerDriver(bot, arbiter);
    const controller = new ActionController(driver, arbiter);
    const events: Array<{ type: string; payload: any }> = [];
    driver.subscribe((event) => events.push(event));
    bot.emit('spawn');
    const oldSignal = new AbortController();
    const old = controller.interact(request('old'), {
      owner: 'old',
      priority: 1,
      signal: oldSignal.signal,
    });
    oldSignal.abort();
    await old;
    driver.disconnect();
    bot.emit('spawn');
    const nextSignal = new AbortController();
    const next = controller.interact(request('new'), {
      owner: 'new',
      priority: 1,
      signal: nextSignal.signal,
    });
    resolves[0]!({ id: 6 });
    await Promise.resolve();
    expect(driver.interactionBarrier).toMatchObject({ requestId: 'new', settled: false });
    expect(events.find((e) => e.type === 'interaction.observedOpen')).toMatchObject({
      sessionEpoch: 1,
    });
    expect(events.find((e) => e.type === 'interaction.observedOpen')?.payload).toMatchObject({
      requestId: 'old',
      sessionEpoch: 1,
    });
    nextSignal.abort();
    await next;
    driver.disconnect();
  });
});

describe('driver boundary cases', () => {
  it('rejects out-of-reach and obscured targets without submitting an interaction', async () => {
    const bot = fixture();
    bot.openContainer = vi.fn();
    const arbiter = new LeaseArbiter();
    const driver = new MineflayerDriver(bot, arbiter);
    bot.emit('spawn');
    const lease = arbiter.acquire({
      owner: 'one',
      resources: ['interact'],
      priority: 1,
      preemptible: true,
      expiresAt: Date.now() + 30000,
    })!;
    expect(
      await driver.interact({ ...request('far'), target: { x: 20, y: 64, z: 0 } }, lease),
    ).toMatchObject({ status: 'rejected', reason: 'target_out_of_reach' });
    bot.canSeeBlock = () => false;
    expect(await driver.interact(request('blocked'), lease)).toMatchObject({
      status: 'rejected',
      reason: 'target_not_visible',
    });
    expect(bot.openContainer).not.toHaveBeenCalled();
    driver.disconnect();
  });

  it('does not expose a driver error', async () => {
    const bot = fixture();
    bot.openContainer = () => Promise.reject(new Error('sensitive driver details'));
    const arbiter = new LeaseArbiter();
    const driver = new MineflayerDriver(bot, arbiter);
    bot.emit('spawn');
    const lease = arbiter.acquire({
      owner: 'one',
      resources: ['interact'],
      priority: 1,
      preemptible: true,
      expiresAt: Date.now() + 30000,
    })!;
    expect(await driver.interact(request('error'), lease)).toMatchObject({
      status: 'uncertain',
      reason: 'interaction_driver_error',
    });
    driver.disconnect();
  });

  it('refreshes nearby terrain on entering an already loaded chunk', async () => {
    const bot = fixture();
    bot.blockAt = (p: Vec) => ({
      name: p.y === 63 ? 'stone' : 'air',
      shapes: p.y === 63 ? [[0, 0, 0, 1, 1, 1]] : [],
    });
    const driver = new MineflayerDriver(bot, new LeaseArbiter());
    const world = new WorldModel();
    driver.subscribe((event) => world.ingest(event));
    bot.emit('spawn');
    await driver.importNearby(1);
    expect(world.block(32, 63, 0)).toBeUndefined();
    bot.entity.position = new Vec(16, 64, 0);
    bot.emit('move');
    await vi.waitFor(() => expect(world.block(32, 63, 0)?.name).toBe('stone'));
    driver.disconnect();
  });

  it('yields during imports and coalesces repeated chunk notifications without duplicate blocks', async () => {
    const bot = fixture();
    bot.game.dimension = 'overworld';
    let reads = 0;
    bot.blockAt = (p: Vec) => {
      reads++;
      return { name: p.y === 63 ? 'stone' : 'air', shapes: p.y === 63 ? [[0, 0, 0, 1, 1, 1]] : [] };
    };
    const driver = new MineflayerDriver(bot, new LeaseArbiter());
    const blocks: any[] = [];
    driver.subscribe((event) => {
      if (event.type === 'block') blocks.push(event);
    });
    bot.emit('spawn');
    let heartbeat = false;
    setImmediate(() => {
      heartbeat = true;
    });
    const scan = driver.importNearby(16);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(heartbeat).toBe(true);
    expect(reads).toBeLessThan(33 * 33 * 4);
    for (let i = 0; i < 300; i++) bot.emit('chunkColumnLoad');
    await scan;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(blocks).toHaveLength(33 * 33 * 4);
    expect(reads).toBeLessThanOrEqual(2 * 33 * 33 * 4);
    expect(blocks[0].dimension).toBe('minecraft:overworld');
    driver.disconnect();
  });

  it('revokes control and wakes tick waits on dimension reset before spawning', async () => {
    const bot = fixture();
    const arbiter = new LeaseArbiter();
    const driver = new MineflayerDriver(bot, arbiter);
    const controller = new ActionController(driver, arbiter);
    bot.emit('spawn');
    const pending = controller.runFrames([InputFrameSchema.parse({ forward: true })], {
      owner: 'nav',
      priority: 1,
      preemptible: true,
    });
    bot.emit('respawn');
    expect((await pending).reason).toBeDefined();
    expect(bot.clearControlStates).toHaveBeenCalled();
    driver.disconnect();
  });
});

describe('observed flat terrain', () => {
  it('imports only known cells and removes an unloaded column', () => {
    const bot = fixture();
    bot.blockAt = (p: Vec) =>
      p.x === 0 && p.z === 0
        ? { name: p.y === 63 ? 'stone' : 'air', shapes: p.y === 63 ? [[0, 0, 0, 1, 1, 1]] : [] }
        : null;
    const driver = new MineflayerDriver(bot, new LeaseArbiter());
    const world = new WorldModel();
    driver.subscribe((event) => world.ingest(event));
    bot.emit('spawn');
    driver.importNearby(1);
    expect(world.block(0, 63, 0)?.name).toBe('stone');
    expect(world.block(1, 63, 0)).toBeUndefined();
    bot.emit('chunkColumnUnload', new Vec(0, 0, 0));
    expect(world.block(0, 63, 0)).toBeUndefined();
    driver.disconnect();
  });

  it('does not treat partial collision shapes or water as flat support or clearance', async () => {
    const world = new WorldModel();
    for (let x = 0; x < 3; x++) {
      world.setBlock({ x, y: 63, z: 0 }, x === 1 ? 'oak_slab' : 'stone', true);
      world.setBlock({ x, y: 64, z: 0 }, 'air', false);
      world.setBlock({ x, y: 65, z: 0 }, 'air', false);
    }
    const snapshot = world.snapshot();
    const result = await new AStarPlanner().plan({
      start: { x: 0.5, y: 64, z: 0.5 },
      goal: { x: 2.5, y: 64, z: 0.5 },
      snapshot,
      sessionEpoch: snapshot.sessionEpoch,
      budget: { maxExpansions: 100, deadline: performance.now() + 1000 },
    });
    expect(result.status).toBe('unreachable');
  });
});
