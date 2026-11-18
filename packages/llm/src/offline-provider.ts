import { GoalSchema } from '../../contracts/src/index.js';
import { DialogueResponseSchema, IntentProposalSchema, PlanProposalSchema } from './schemas.js';
import type { ModelRequest, ProviderAdapter } from './provider.js';
import type { ModelResponse } from './schemas.js';

/** Deterministic provider used by demos and offline tests. */
export class OfflineProvider implements ProviderAdapter {
  #cancelled = new Set<string>();
  cancel(requestId: string) {
    this.#cancelled.add(requestId);
  }
  async generateIntent(req: ModelRequest): Promise<ModelResponse> {
    if (this.#cancelled.has(req.requestId) || req.signal.aborted) throw new Error('cancelled');
    const lines = req.prompt.trim().split('\n');
    const original = lines[0] ?? '';
    if (/不要|禁止|不能|不许|避免|do not|don't|without|avoid/i.test(original))
      return {
        kind: 'clarification',
        question: '离线模式不能确认此约束，请用支持的指令重新提交。',
      };
    const lastAnswer = [...lines]
      .reverse()
      .find((line) => line.startsWith('回答: '))
      ?.slice(4)
      .trim();
    let normalized = (lastAnswer ?? original).trim().replace(/\s+/g, ' ');
    if (
      lastAnswer &&
      /^-?\d+(?:\.\d+)?[ ,]+-?\d+(?:\.\d+)?[ ,]+-?\d+(?:\.\d+)?$/.test(normalized)
    ) {
      if (/打开|开箱|open/i.test(original)) normalized = `打开 ${normalized} 的箱子`;
      else if (/走|前往|navigate|go to/i.test(original)) normalized = `走到 ${normalized}`;
    }
    const supported =
      /^(?:走到|去|前往|navigate to|go to)\s*-?\d+(?:\.\d+)?[ ,]+-?\d+(?:\.\d+)?[ ,]+-?\d+(?:\.\d+)?(?:\s*(?:的箱子旁并打开|的箱子并打开|并打开箱子))?$/i.test(
        normalized,
      ) ||
      /^(?:打开|open(?: the)?(?: chest at)?)\s*-?\d+(?:\.\d+)?[ ,]+-?\d+(?:\.\d+)?[ ,]+-?\d+(?:\.\d+)?(?:\s*的箱子)?$/i.test(
        normalized,
      );
    if (!supported)
      return {
        kind: 'clarification',
        question: '离线模式只支持明确的“走到 x y z”或“打开 x y z 的箱子”，请重新提交完整目标。',
      };
    const numbers = normalized.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
    if (numbers.length !== 3)
      return { kind: 'clarification', question: '请提供唯一的目标坐标，例如 4 1 0。' };
    const world = (req.context as { world?: { dimension?: string } }).world;
    const type = /打开|开箱|open/i.test(req.prompt) ? 'openContainerAt' : 'navigateToPosition';
    return IntentProposalSchema.parse({
      kind: 'intent',
      goal: {
        text: req.prompt,
        type,
        position: { x: numbers[0], y: numbers[1], z: numbers[2] },
        dimension: world?.dimension ?? 'minecraft:overworld',
        constraints: { forbidBlockBreaking: true },
      },
    });
  }
  async proposePlan(req: ModelRequest): Promise<ModelResponse> {
    if (Date.now() > req.deadline) throw new Error('model_deadline_exceeded');
    if (this.#cancelled.has(req.requestId) || req.signal.aborted) throw new Error('cancelled');
    const goal = GoalSchema.parse((req.context as any).goal);
    const intentType = (req.context as any).target?.type;
    if (!goal.target) throw new Error('target_required');
    const tasks = [
      {
        id: `${goal.id}:navigate`,
        capabilityId: intentType === 'openContainerAt' ? 'openContainer' : 'navigate',
        params: { target: goal.target },
        dependsOn: [],
        timeoutMs: 30000,
      },
    ];
    return PlanProposalSchema.parse({
      kind: 'plan',
      goalId: goal.id,
      goalRevision: goal.revision,
      tasks,
      validForMs: 30000,
    });
  }
  async respond(req: ModelRequest): Promise<ModelResponse> {
    if (this.#cancelled.has(req.requestId) || req.signal.aborted) throw new Error('cancelled');
    return DialogueResponseSchema.parse({
      kind: 'dialogue',
      text: '我已根据当前观测整理任务；执行结果仍由运行时确认。',
    });
  }
}
