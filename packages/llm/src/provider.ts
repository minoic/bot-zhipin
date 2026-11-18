import type { ModelResponse } from './schemas.js';

/** Provider-neutral request shape and adapter contract. */
export type ModelRequest = {
  requestId: string;
  goalRevision: number;
  prompt: string;
  context: unknown;
  deadline: number;
  signal: AbortSignal;
};
export interface ProviderAdapter {
  generateIntent(request: ModelRequest): Promise<ModelResponse>;
  proposePlan(request: ModelRequest): Promise<ModelResponse>;
  respond(request: ModelRequest): Promise<ModelResponse>;
  cancel(requestId: string): void;
}
