import assert from 'node:assert/strict';
import { AStarPlanner } from '../../packages/planner/src/index.js';
import type { Snapshot } from '../../packages/contracts/src/index.js';

const blocks = new Map<string, { name: string; solid: boolean; revision: number }>();
for (let x = 0; x <= 4; x++) {
  blocks.set(`${x},63,0`, { name: 'stone', solid: true, revision: x * 3 + 1 });
  blocks.set(`${x},64,0`, { name: 'air', solid: false, revision: x * 3 + 2 });
  blocks.set(`${x},65,0`, { name: 'air', solid: false, revision: x * 3 + 3 });
}
const snapshot: Snapshot = {
  sessionEpoch: 1,
  dimension: 'minecraft:overworld',
  revision: 15,
  blocks,
  entities: new Map(),
  position: { x: 0.5, y: 64, z: 0.5 },
  inventoryRevision: 0,
};
const planner = new AStarPlanner();
const request = {
  start: snapshot.position,
  goal: { x: 4.5, y: 64, z: 0.5 },
  snapshot,
  sessionEpoch: snapshot.sessionEpoch,
  budget: { maxExpansions: 5000, deadline: performance.now() + 5000 },
};
const result = await planner.planInWorker(request);
assert.equal(result.status, 'found');
assert.deepEqual(result.path.at(-1), request.goal);
assert.deepEqual(result, await planner.plan(request));

const unreachable = await planner.planInWorker({
  ...request,
  goal: { x: 5.5, y: 64, z: 0.5 },
});
assert.equal(unreachable.status, 'unreachable');
