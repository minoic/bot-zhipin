import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { PlanRequest, Snapshot, Vec3 } from '../../packages/contracts/src/index.js';
import { AStarPlanner, beamSearch, type MotionState } from '../../packages/planner/src/index.js';

function corridor(length: number): Snapshot {
  const blocks = new Map<string, { name: string; solid: boolean; revision: number }>();
  let revision = 0;
  for (let x = 0; x < length; x++) {
    blocks.set(`${x},63,0`, { name: 'stone', solid: true, revision: ++revision });
    blocks.set(`${x},64,0`, { name: 'air', solid: false, revision: ++revision });
    blocks.set(`${x},65,0`, { name: 'air', solid: false, revision: ++revision });
  }
  return {
    sessionEpoch: 2,
    dimension: 'minecraft:overworld',
    revision,
    blocks,
    entities: new Map(),
    position: { x: 0.5, y: 64, z: 0.5 },
    inventoryRevision: 0,
  };
}

function request(
  snapshot: Snapshot,
  start: Vec3,
  goal: Vec3,
  overrides: Partial<PlanRequest['budget']> = {},
): PlanRequest {
  return {
    start,
    goal,
    snapshot,
    sessionEpoch: snapshot.sessionEpoch,
    budget: { maxExpansions: 10_000, deadline: performance.now() + 2_000, ...overrides },
  };
}

describe('AStarPlanner safe baseline', () => {
  it('plans in a worker under the production tsx entry point', () => {
    const fixture = fileURLToPath(new URL('../fixtures/planner-worker.ts', import.meta.url));
    const result = spawnSync(process.execPath, ['--import', 'tsx', fixture], {
      encoding: 'utf8',
      timeout: 15_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('plans only through known flat cells and records support and clearance dependencies', async () => {
    const snapshot = corridor(3);
    const result = await new AStarPlanner().plan(
      request(snapshot, { x: 0.5, y: 64, z: 0.5 }, { x: 2.5, y: 64, z: 0.5 }),
    );

    expect(result.status).toBe('found');
    expect(result.path).toEqual([
      { x: 0.5, y: 64, z: 0.5 },
      { x: 1.5, y: 64, z: 0.5 },
      { x: 2.5, y: 64, z: 0.5 },
    ]);
    expect(result.dependencies).toMatchObject({
      '0,63,0': expect.any(Number),
      '1,64,0': expect.any(Number),
      '2,65,0': expect.any(Number),
    });
  });

  it('fails closed when a target or adjacent route cell is unknown', async () => {
    const original = corridor(3);
    const blocks = new Map(original.blocks);
    blocks.delete('1,65,0');
    const snapshot = { ...original, blocks };
    const result = await new AStarPlanner().plan(
      request(snapshot, { x: 0.5, y: 64, z: 0.5 }, { x: 2.5, y: 64, z: 0.5 }),
    );
    expect(result.status).toBe('unreachable');
    expect(result.path).toEqual([]);
  });

  it('refuses uncalibrated elevation changes instead of inventing jump or fall edges', async () => {
    const snapshot = corridor(2);
    const result = await new AStarPlanner().plan(
      request(snapshot, { x: 0.5, y: 64, z: 0.5 }, { x: 1.5, y: 65, z: 0.5 }),
    );
    expect(result.status).toBe('unreachable');
  });

  it('honors expansion and deadline budgets', async () => {
    const planner = new AStarPlanner();
    const snapshot = corridor(20);
    const limited = await planner.plan(
      request(
        snapshot,
        { x: 0.5, y: 64, z: 0.5 },
        { x: 19.5, y: 64, z: 0.5 },
        { maxExpansions: 1 },
      ),
    );
    const expired = await planner.plan(
      request(
        snapshot,
        { x: 0.5, y: 64, z: 0.5 },
        { x: 19.5, y: 64, z: 0.5 },
        { deadline: performance.now() - 1 },
      ),
    );
    expect(limited.status).toBe('budget-exhausted');
    expect(limited.expansions).toBe(1);
    expect(expired.status).toBe('budget-exhausted');
    expect(expired.expansions).toBe(0);
  });

  it('matches in-process and worker results and bounds worker admission', async () => {
    const planner = new AStarPlanner({ maxWorkers: 1, maxQueue: 0 });
    const req = request(corridor(12), { x: 0.5, y: 64, z: 0.5 }, { x: 11.5, y: 64, z: 0.5 });
    const expected = await planner.plan(req);
    const first = planner.planInWorker(req);
    const rejected = await planner.planInWorker(req);
    expect(rejected.status).toBe('budget-exhausted');
    expect(await first).toEqual(expected);
  });

  it('rejects stale sessions and already-cancelled worker requests', async () => {
    const planner = new AStarPlanner();
    const snapshot = corridor(2);
    expect(
      (
        await planner.plan({
          ...request(snapshot, snapshot.position, { x: 1.5, y: 64, z: 0.5 }),
          sessionEpoch: 3,
        })
      ).status,
    ).toBe('cancelled');
    const abort = new AbortController();
    abort.abort();
    expect(
      (
        await planner.planInWorker({
          ...request(snapshot, snapshot.position, { x: 1.5, y: 64, z: 0.5 }),
          signal: abort.signal,
        })
      ).status,
    ).toBe('cancelled');
  });
});

describe('beamSearch safety gate', () => {
  const initial: MotionState = {
    position: { x: 0, y: 64, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    onGround: true,
    input: { forward: false, left: false, right: false, jump: false },
  };
  const simulate = (state: MotionState): MotionState => ({
    ...state,
    position: { ...state.position, x: state.position.x + 0.1 },
  });

  it('requires calibrated physics and bounded positive search parameters', () => {
    expect(() =>
      beamSearch(
        initial,
        simulate,
        { x: 1, y: 64, z: 0 },
        { ticks: 8, width: 16, calibrated: false },
      ),
    ).toThrow('physics_model_uncalibrated');
    expect(() =>
      beamSearch(
        initial,
        simulate,
        { x: 1, y: 64, z: 0 },
        { ticks: 65, width: 16, calibrated: true },
      ),
    ).toThrow('ticks_out_of_range');
    expect(() =>
      beamSearch(
        initial,
        simulate,
        { x: 1, y: 64, z: 0 },
        { ticks: 8, width: 0, calibrated: true },
      ),
    ).toThrow('beam_width_out_of_range');
  });
});
