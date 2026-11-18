import type { PlanRequest, PlanResult, Snapshot, Vec3 } from '../../contracts/src/index.js';
import { Worker } from 'node:worker_threads';
import { search, type SearchInput } from './search.js';

const empty = (status: PlanResult['status'], expansions = 0): PlanResult => ({
  status,
  path: [],
  dependencies: {},
  expansions,
  cost: 0,
});

function inputFor(req: PlanRequest): SearchInput {
  return {
    start: req.start,
    goal: req.goal,
    blocks: Object.fromEntries(req.snapshot.blocks),
    maxExpansions: Math.max(0, Math.floor(req.budget.maxExpansions)),
    deadlineEpochMs: Date.now() + Math.max(0, req.budget.deadline - performance.now()),
  };
}
function cancelled(s: Snapshot, r: PlanRequest) {
  return r.signal?.aborted === true || r.sessionEpoch !== s.sessionEpoch;
}

export class AStarPlanner {
  readonly #maxWorkers: number;
  readonly #maxQueue: number;
  #activeWorkers = 0;
  #queue: Array<() => void> = [];

  constructor(options: { maxWorkers?: number; maxQueue?: number } = {}) {
    const maxWorkers = options.maxWorkers ?? 1;
    const maxQueue = options.maxQueue ?? 8;
    this.#maxWorkers = Number.isFinite(maxWorkers) ? Math.max(1, Math.floor(maxWorkers)) : 1;
    this.#maxQueue = Number.isFinite(maxQueue) ? Math.max(0, Math.floor(maxQueue)) : 8;
  }

  async plan(req: PlanRequest): Promise<PlanResult> {
    if (cancelled(req.snapshot, req)) return empty('cancelled');
    const result = search(inputFor(req));
    return cancelled(req.snapshot, req) ? empty('cancelled', result.expansions) : result;
  }

  planInWorker(req: PlanRequest): Promise<PlanResult> {
    if (cancelled(req.snapshot, req)) return Promise.resolve(empty('cancelled'));
    if (this.#activeWorkers >= this.#maxWorkers && this.#queue.length >= this.#maxQueue) {
      return Promise.resolve(empty('budget-exhausted'));
    }

    const data = inputFor(req);
    return new Promise((resolve, reject) => {
      let settled = false;
      let started = false;
      let worker: Worker | undefined;
      const cleanup = () => req.signal?.removeEventListener('abort', abort);
      const finish = (result: PlanResult) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (started) this.#activeWorkers--;
        resolve(result);
        this.#drain();
      };
      const abort = () => {
        if (settled) return;
        settled = true;
        cleanup();
        if (!started) {
          const index = this.#queue.indexOf(start);
          if (index >= 0) this.#queue.splice(index, 1);
          resolve(empty('cancelled'));
          return;
        }
        void worker?.terminate().finally(() => {
          this.#activeWorkers--;
          resolve(empty('cancelled'));
          this.#drain();
        });
      };
      const start = () => {
        if (settled) return;
        started = true;
        this.#activeWorkers++;
        worker = new Worker(new URL('./worker.mjs', import.meta.url), {
          workerData: data,
          // Node 24 can strip the types in search.ts without inheriting the parent loader.
          execArgv: [],
        });
        worker.once('message', (result: PlanResult) => {
          finish(cancelled(req.snapshot, req) ? empty('cancelled', result.expansions) : result);
        });
        worker.once('error', (error) => {
          if (settled) return;
          settled = true;
          cleanup();
          this.#activeWorkers--;
          reject(error);
          this.#drain();
        });
        worker.once('exit', (code) => {
          if (settled) return;
          settled = true;
          cleanup();
          this.#activeWorkers--;
          if (code === 0) resolve(empty('budget-exhausted'));
          else
            reject(new Error(`Planner worker exited with code ${code} before returning a result`));
          this.#drain();
        });
      };

      req.signal?.addEventListener('abort', abort, { once: true });
      if (this.#activeWorkers < this.#maxWorkers) start();
      else this.#queue.push(start);
    });
  }

  #drain() {
    while (this.#activeWorkers < this.#maxWorkers && this.#queue.length > 0) this.#queue.shift()!();
  }
}

export type MotionState = {
  position: Vec3;
  velocity: Vec3;
  onGround: boolean;
  input: { forward: boolean; left: boolean; right: boolean; jump: boolean };
};

export function beamSearch(
  initial: MotionState,
  simulate: (state: MotionState, input: MotionState['input']) => MotionState,
  goal: Vec3,
  opts: { ticks: number; width: number; calibrated: boolean },
) {
  if (!opts.calibrated) throw new Error('physics_model_uncalibrated');
  if (!Number.isInteger(opts.ticks) || opts.ticks < 1 || opts.ticks > 64)
    throw new RangeError('ticks_out_of_range');
  if (!Number.isInteger(opts.width) || opts.width < 1 || opts.width > 256)
    throw new RangeError('beam_width_out_of_range');

  const moves: MotionState['input'][] = [
    { forward: true, left: false, right: false, jump: false },
    { forward: true, left: false, right: false, jump: true },
    { forward: true, left: true, right: false, jump: false },
    { forward: true, left: false, right: true, jump: false },
    { forward: false, left: false, right: false, jump: false },
  ];
  const score = (state: MotionState) =>
    Math.hypot(state.position.x - goal.x, state.position.y - goal.y, state.position.z - goal.z) +
    Math.hypot(state.velocity.x, state.velocity.y, state.velocity.z) * 0.1;
  let beam = [
    {
      state: initial,
      frames: [] as MotionState['input'][],
      score: score(initial),
    },
  ];
  for (let tick = 0; tick < opts.ticks; tick++) {
    const next: typeof beam = [];
    for (const item of beam) {
      for (const move of moves) {
        const state = simulate(item.state, move);
        const finite = [
          state.position.x,
          state.position.y,
          state.position.z,
          state.velocity.x,
          state.velocity.y,
          state.velocity.z,
        ].every(Number.isFinite);
        if (!finite || state.position.y < 0) continue;
        next.push({
          state,
          frames: [...item.frames, move],
          score: score(state),
        });
      }
    }
    beam = next.sort((a, b) => a.score - b.score).slice(0, opts.width);
    if (beam.length === 0) return undefined;
  }
  return beam[0];
}
