import type { ControlLease, Goal, InputFrame, Observation, TaskNode, Vec3 } from './schemas.js';

/** Cross-package runtime contracts that do not need validation schemas. */
export type Outcome = {
  status: 'observed' | 'rejected' | 'timedOut' | 'uncertain';
  requestId: string;
  evidence?: unknown;
  reason?: string;
};
export type Snapshot = {
  sessionEpoch: number;
  dimension: string;
  revision: number;
  blocks: ReadonlyMap<string, { name: string; solid: boolean; revision: number }>;
  entities: ReadonlyMap<number, { position: Vec3; velocity: Vec3; observedAt: number }>;
  position: Vec3;
  inventoryRevision: number;
  inventory?: unknown[];
};
export type PlanRequest = {
  start: Vec3;
  goal: Vec3;
  snapshot: Snapshot;
  sessionEpoch: number;
  budget: { maxExpansions: number; deadline: number };
  signal?: AbortSignal;
};
export type PlanResult = {
  status: 'found' | 'unreachable' | 'budget-exhausted' | 'cancelled';
  path: Vec3[];
  dependencies: Record<string, number>;
  expansions: number;
  cost: number;
};
export type ClientDriver = {
  readonly capabilities: ReadonlySet<string>;
  subscribe(emit: (event: Observation) => void): () => void;
  apply(frame: InputFrame, lease: ControlLease): void;
  interact(
    request: { requestId: string; target: Vec3; action: string },
    lease: ControlLease,
  ): Promise<Outcome>;
  releaseInputs(): void;
};
export type PluginManifest = {
  id: string;
  apiVersion: 1;
  capabilities: string[];
  subscriptions: string[];
};
export type PluginContext = {
  observe(): Readonly<Snapshot>;
  submitGoal(goal: Goal): Promise<{ accepted: boolean; reason?: string }>;
  onResult(listener: (result: unknown) => void): () => void;
};
export type BotPlugin = {
  manifest: PluginManifest;
  start(ctx: PluginContext, signal: AbortSignal): Promise<void>;
};
