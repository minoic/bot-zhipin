import type { Goal, Snapshot } from '../../contracts/src/index.js';

/** Builds a bounded, clone-safe context for a model request. */
export function buildContext(input: {
  goal: Goal;
  snapshot: Snapshot;
  capabilities: string[];
  recentFailures?: string[];
  maxBytes?: number;
}) {
  const max = input.maxBytes ?? 6000;
  const context = {
    goal: structuredClone(input.goal),
    world: {
      dimension: input.snapshot.dimension,
      position: input.snapshot.position,
      revision: input.snapshot.revision,
      nearbyEntities: [...input.snapshot.entities].slice(0, 16).map(([id, e]) => ({
        id,
        position: e.position,
        observedAt: e.observedAt,
      })),
      inventoryRevision: input.snapshot.inventoryRevision,
    },
    capabilities: input.capabilities,
    recentFailures: (input.recentFailures ?? []).slice(-5),
  };
  let json = JSON.stringify(context);
  while (new TextEncoder().encode(json).byteLength > max && context.world.nearbyEntities.length) {
    context.world.nearbyEntities.pop();
    json = JSON.stringify(context);
  }
  if (new TextEncoder().encode(json).byteLength > max) throw new Error('context_budget_exceeded');
  return JSON.parse(json) as typeof context;
}
