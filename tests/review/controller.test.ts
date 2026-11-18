import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  InputFrameSchema,
  type ClientDriver,
  type ControlLease,
  type InputFrame,
  type Outcome,
} from '../../packages/contracts/src/index.js';
import {
  ActionController,
  LeaseArbiter,
  MineflayerDriver,
} from '../../packages/controller/src/index.js';

function fakeBot() {
  const bot = new EventEmitter() as EventEmitter & Record<string, any>;
  bot.game = { dimension: 'minecraft:overworld' };
  bot.entity = { position: { x: 0, y: 64, z: 0 }, pitch: 0 };
  bot.controls = new Map<string, boolean>();
  bot.setControlState = (key: string, value: boolean) => bot.controls.set(key, value);
  bot.clearControlStates = () => {
    for (const key of ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'])
      bot.controls.set(key, false);
  };
  bot.look = () => undefined;
  return bot;
}

const lease = (
  owner: string,
  resources: string[],
  priority: number,
  expiresAt = Date.now() + 60_000,
  preemptible = true,
) => ({
  owner,
  resources,
  priority,
  expiresAt,
  preemptible,
});

describe('LeaseArbiter', () => {
  it('does not mutate current ownership when an invalid request is denied', () => {
    const arbiter = new LeaseArbiter();
    const current = arbiter.acquire(lease('current', ['move'], 1))!;
    expect(arbiter.acquire(lease('invalid', [], 100))).toBeUndefined();
    expect(arbiter.valid(current)).toBe(true);
  });

  it('expires holders and permits the next valid owner to take the resource', () => {
    const arbiter = new LeaseArbiter();
    const start = Date.now();
    const current = arbiter.acquire(lease('expired', ['move'], 1, start + 100))!;
    const next = arbiter.acquire(lease('next', ['move'], 1, start + 10_000), start + 101)!;
    expect(arbiter.valid(current, start + 101)).toBe(false);
    expect(arbiter.valid(next, start + 101)).toBe(true);
  });

  it('rejects partial-copy leases and keeps multi-channel takeover atomic', () => {
    const arbiter = new LeaseArbiter();
    const mover = arbiter.acquire(lease('mover', ['move'], 2))!;
    const protectedLook = arbiter.acquire(
      lease('look-lock', ['look'], 10, Date.now() + 60_000, false),
    )!;
    expect(arbiter.valid({ ...mover, resources: ['move'] })).toBe(false);
    expect(arbiter.acquire(lease('combined', ['move', 'look'], 20))).toBeUndefined();
    expect(arbiter.valid(mover)).toBe(true);
    expect(arbiter.valid(protectedLook)).toBe(true);
    expect(arbiter.valid({ ...mover, resources: [] })).toBe(false);
    expect(() => {
      (mover.resources as string[]).push('look');
    }).toThrow();
  });

  it('revokes all channels held by a preempted lease before the new owner writes', () => {
    const arbiter = new LeaseArbiter();
    const bot = fakeBot();
    const driver = new MineflayerDriver(bot, arbiter);
    bot.emit('spawn');
    const mover = arbiter.acquire(lease('mover', ['move', 'look'], 1))!;
    driver.apply(InputFrameSchema.parse({ forward: true }), mover);
    expect(bot.controls.get('forward')).toBe(true);

    const looker = arbiter.acquire(lease('looker', ['look'], 2))!;
    expect(arbiter.valid(mover)).toBe(false);
    expect(bot.controls.get('forward')).toBe(false);
    driver.apply(InputFrameSchema.parse({ yaw: 1 }), looker);
    expect(() => driver.apply(InputFrameSchema.parse({ forward: true }), mover)).toThrow(
      'stale_control_lease',
    );
    driver.disconnect();
  });

  it('clears held input when an active lease expires', () => {
    const arbiter = new LeaseArbiter();
    const bot = fakeBot();
    const driver = new MineflayerDriver(bot, arbiter);
    bot.emit('spawn');
    const current = arbiter.acquire(lease('short', ['move'], 1, Date.now() + 60_000))!;
    driver.apply(InputFrameSchema.parse({ forward: true }), current);
    arbiter.expire(Date.now() + 60_001);
    expect(bot.controls.get('forward')).toBe(false);
    driver.disconnect();
  });

  it('serializes container opens and reports observed only after a server window opens', async () => {
    class Vec {
      constructor(
        public x: number,
        public y: number,
        public z: number,
      ) {}
    }
    const arbiter = new LeaseArbiter();
    const bot = fakeBot();
    bot.entity.position = new Vec(0, 64, 0);
    bot.blockAt = vi.fn(() => ({ name: 'chest', boundingBox: 'block' }));
    bot.canSeeBlock = vi.fn(() => true);
    let openWindow!: (window: { id: number; title: string }) => void;
    bot.openContainer = vi.fn(
      () =>
        new Promise((resolve) => {
          openWindow = resolve;
        }),
    );
    const driver = new MineflayerDriver(bot, arbiter);
    bot.emit('spawn');
    const owner = arbiter.acquire(lease('interactor', ['interact'], 1))!;
    const request = { requestId: 'first', target: { x: 0, y: 64, z: 0 }, action: 'openContainer' };

    const first = driver.interact(request, owner);
    await Promise.resolve();
    const duplicate = await driver.interact({ ...request, requestId: 'second' }, owner);
    expect(duplicate).toMatchObject({ status: 'uncertain', reason: 'interaction_already_pending' });
    expect(bot.openContainer).toHaveBeenCalledTimes(1);
    openWindow({ id: 7, title: 'Chest' });
    expect(await first).toMatchObject({ status: 'observed', evidence: { windowId: 7 } });
    driver.disconnect();
  });

  it('returns uncertain on container timeout and keeps the pending interaction fenced', async () => {
    class Vec {
      constructor(
        public x: number,
        public y: number,
        public z: number,
      ) {}
    }
    vi.useFakeTimers();
    const arbiter = new LeaseArbiter();
    const bot = fakeBot();
    bot.entity.position = new Vec(0, 64, 0);
    bot.blockAt = () => ({ name: 'chest', boundingBox: 'block' });
    bot.canSeeBlock = () => true;
    bot.openContainer = () => new Promise(() => undefined);
    const driver = new MineflayerDriver(bot, arbiter);
    bot.emit('spawn');
    const owner = arbiter.acquire(lease('interactor', ['interact'], 1))!;
    try {
      const pending = driver.interact(
        { requestId: 'timeout', target: { x: 0, y: 64, z: 0 }, action: 'openContainer' },
        owner,
      );
      await vi.advanceTimersByTimeAsync(10_001);
      expect(await pending).toMatchObject({
        status: 'uncertain',
        reason: 'interaction_timed_out_pending',
      });
      expect(
        await driver.interact(
          { requestId: 'retry', target: { x: 0, y: 64, z: 0 }, action: 'openContainer' },
          owner,
        ),
      ).toMatchObject({ status: 'uncertain', reason: 'interaction_already_pending' });
    } finally {
      driver.disconnect();
      vi.useRealTimers();
    }
  });
});

function cancellableDriver(arbiter: LeaseArbiter) {
  let forward = false;
  let releases = 0;
  const driver: ClientDriver & {
    waitForTick(signal?: AbortSignal): Promise<void>;
    state(): { forward: boolean; releases: number };
  } = {
    capabilities: new Set(['move']),
    subscribe: () => () => undefined,
    apply(frame: InputFrame, current: ControlLease) {
      if (!arbiter.valid(current)) throw new Error('stale_control_lease');
      forward = frame.forward;
    },
    async interact(request): Promise<Outcome> {
      return { status: 'rejected', requestId: request.requestId };
    },
    releaseInputs() {
      forward = false;
      releases++;
    },
    waitForTick(signal) {
      return new Promise((resolve, reject) => {
        const abort = () => reject(new Error('cancelled'));
        if (signal?.aborted) return abort();
        signal?.addEventListener('abort', abort, { once: true });
        void resolve;
      });
    },
    state: () => ({ forward, releases }),
  };
  return driver;
}

describe('ActionController lifecycle', () => {
  it('does not let an old action cleanup clear a newer owner input', async () => {
    const arbiter = new LeaseArbiter();
    const driver = cancellableDriver(arbiter);
    const controller = new ActionController(driver, arbiter);
    const oldRun = controller.runFrames([InputFrameSchema.parse({ forward: true })], {
      owner: 'old',
      priority: 1,
      preemptible: true,
    });
    await Promise.resolve();
    const newRun = controller.runFrames([InputFrameSchema.parse({ forward: true })], {
      owner: 'new',
      priority: 2,
      preemptible: true,
    });
    await Promise.resolve();

    expect((await oldRun).reason).toBe('cancelled');
    expect(driver.state()).toEqual({ forward: true, releases: 0 });
    arbiter.clear();
    await newRun;
  });

  it('wakes a tick waiter on disconnect instead of hanging the action forever', async () => {
    const arbiter = new LeaseArbiter();
    const bot = fakeBot();
    const driver = new MineflayerDriver(bot, arbiter);
    bot.emit('spawn');
    const controller = new ActionController(driver, arbiter);
    const pending = controller.runFrames([InputFrameSchema.parse({ forward: true })], {
      owner: 'waiter',
      priority: 1,
      preemptible: true,
    });
    await Promise.resolve();
    driver.disconnect();
    const result = await pending;
    expect(result.completed).toBe(1);
    expect(result.reason).toBe('disconnected');
  });

  it('does not apply a frame when the caller signal was already cancelled', async () => {
    const arbiter = new LeaseArbiter();
    const driver = cancellableDriver(arbiter);
    const controller = new ActionController(driver, arbiter);
    const signal = new AbortController();
    signal.abort();
    const result = await controller.runFrames([InputFrameSchema.parse({ forward: true })], {
      owner: 'cancelled',
      priority: 1,
      preemptible: true,
      signal: signal.signal,
    });
    expect(result).toEqual({ completed: 0, reason: 'cancelled' });
    expect(driver.state()).toEqual({ forward: false, releases: 0 });
  });
});
