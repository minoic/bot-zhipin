/** Runtime validation schemas shared by every package. */
import { z } from 'zod';

export const VectorSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  z: z.number().finite(),
});
export type Vec3 = z.infer<typeof VectorSchema>;
export const GoalSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  revision: z.number().int().positive(),
  text: z.string().min(1).max(1000),
  target: VectorSchema.optional(),
  priority: z.number().min(0).max(1).default(0.5),
  deadline: z.number().finite().optional(),
});
export type Goal = z.infer<typeof GoalSchema>;
export const ObservationSchema = z.object({
  sessionEpoch: z.number().int().nonnegative(),
  dimension: z.string(),
  seq: z.number().int().nonnegative(),
  observedAt: z.number().finite(),
  source: z.enum(['protocol', 'server', 'visual', 'inference']),
  type: z.string(),
  payload: z.unknown(),
});
export type Observation = z.infer<typeof ObservationSchema>;
export const TaskNodeSchema = z.object({
  id: z.string().min(1),
  capabilityId: z.string().min(1),
  params: z.record(z.string(), z.unknown()).default({}),
  dependsOn: z.array(z.string()).default([]),
  priority: z.number().min(0).max(1).default(0.5),
  timeoutMs: z.number().int().positive().default(30000),
  successCondition: z.string().min(1),
  resources: z.array(z.string()).default([]),
  preemptible: z.boolean().default(true),
});
export type TaskNode = z.infer<typeof TaskNodeSchema>;
export const InputFrameSchema = z.object({
  forward: z.boolean().default(false),
  back: z.boolean().default(false),
  left: z.boolean().default(false),
  right: z.boolean().default(false),
  jump: z.boolean().default(false),
  sprint: z.boolean().default(false),
  sneak: z.boolean().default(false),
  yaw: z.number().finite().optional(),
  pitch: z.number().finite().optional(),
  slot: z.number().int().min(0).max(8).optional(),
});
export type InputFrame = z.infer<typeof InputFrameSchema>;
export const LeaseSchema = z.object({
  owner: z.string().min(1),
  generation: z.number().int().positive(),
  resources: z.array(z.string().min(1)).min(1),
  priority: z.number().finite(),
  preemptible: z.boolean(),
  expiresAt: z.number().finite(),
});
export type ControlLease = z.infer<typeof LeaseSchema>;
