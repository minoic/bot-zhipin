import { z } from 'zod';
import { VectorSchema } from '../../contracts/src/index.js';

/** Structured responses accepted from model providers. */
export const IntentProposalSchema = z
  .object({
    kind: z.literal('intent'),
    goal: z
      .object({
        text: z.string().min(1).max(1000),
        type: z.enum(['navigateToPosition', 'openContainerAt']),
        position: VectorSchema,
        dimension: z.string().min(1),
        constraints: z
          .object({
            forbidBlockBreaking: z.literal(true),
            deadline: z.number().finite().optional(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();
export const ClarificationResponseSchema = z
  .object({ kind: z.literal('clarification'), question: z.string().min(1).max(1000) })
  .strict();
export const TaskSuggestionSchema = z
  .object({
    id: z.string().min(1),
    capabilityId: z.string().min(1),
    params: z.record(z.string(), z.unknown()),
    dependsOn: z.array(z.string()),
    timeoutMs: z.number().int().positive(),
  })
  .strict();
export const PlanProposalSchema = z
  .object({
    kind: z.literal('plan'),
    goalId: z.string().min(1),
    goalRevision: z.number().int().positive(),
    tasks: z.array(TaskSuggestionSchema).min(1).max(64),
    validForMs: z.number().int().positive().max(300000),
  })
  .strict();
export const DialogueResponseSchema = z.object({
  kind: z.literal('dialogue'),
  text: z.string().min(1).max(2000),
});
export const ModelResponseSchema = z.discriminatedUnion('kind', [
  IntentProposalSchema,
  ClarificationResponseSchema,
  PlanProposalSchema,
  DialogueResponseSchema,
]);
export type ModelResponse = z.infer<typeof ModelResponseSchema>;
