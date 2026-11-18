import { randomUUID } from 'node:crypto';
import type { Goal, Snapshot, Vec3 } from '../../../packages/contracts/src/index.js';
import { ActionController, MineflayerDriver } from '../../../packages/controller/src/index.js';
import {
  DecisionRuntime,
  type SkillRegistry,
  type Target,
} from '../../../packages/decision/src/index.js';
import {
  ModelRequestCoordinator,
  OfflineProvider,
  OpenAICompatibleProvider,
  type ProviderAdapter,
} from '../../../packages/llm/src/index.js';
import { WorldModel } from '../../../packages/world/src/index.js';
import { loadConfig } from './config.js';
import { createOnlineSkills } from './skills.js';

type Entry = {
  goal: Goal;
  status: 'planning' | 'awaitingClarification' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  question?: string;
  reason?: string;
  token: number;
  history: string[];
  target?: Target;
  replans: number;
};
function observations(snapshot: Snapshot, target?: Vec3) {
  const center = target ?? snapshot.position;
  const blocks = [...snapshot.blocks.entries()]
    .map(([key, block]) => {
      const [x, y, z] = key.split(',').map(Number);
      return { x: x!, y: y!, z: z!, name: block.name, revision: block.revision };
    })
    .filter(
      (block) =>
        Math.abs(block.x - center.x) <= 3 &&
        Math.abs(block.y - center.y) <= 2 &&
        Math.abs(block.z - center.z) <= 3 &&
        block.name !== 'air' &&
        block.name !== 'cave_air' &&
        block.name !== 'void_air',
    )
    .sort(
      (a, b) =>
        Math.hypot(a.x - center.x, a.y - center.y, a.z - center.z) -
          Math.hypot(b.x - center.x, b.y - center.y, b.z - center.z) ||
        a.x - b.x ||
        a.y - b.y ||
        a.z - b.z,
    )
    .slice(0, 16);
  return {
    dimension: snapshot.dimension,
    position: snapshot.position,
    epoch: snapshot.sessionEpoch,
    revision: snapshot.revision,
    nearbyBlocks: blocks,
  };
}
export class BotRuntime {
  #entries = new Map<string, Entry>();
  #coordinator: ModelRequestCoordinator;
  #decision: DecisionRuntime;
  #sessionId = randomUUID();
  #closed = false;
  #ready = false;
  constructor(
    private readonly world: WorldModel,
    driver: MineflayerDriver,
    private readonly controller: ActionController,
    private readonly log: (type: string, payload: unknown) => void,
    options: { provider?: ProviderAdapter; skills?: SkillRegistry } = {},
  ) {
    const config = loadConfig();
    const provider: ProviderAdapter =
      options.provider ??
      (config.provider === 'offline'
        ? new OfflineProvider()
        : new OpenAICompatibleProvider({
            baseUrl: config.baseUrl!,
            apiKey: config.apiKey!,
            model: config.model!,
            onAttempt: (event) => log('model.attempt', event),
          }));
    this.#coordinator = new ModelRequestCoordinator(provider, config.maxCallsPerGoal);
    this.#timeoutMs = config.requestTimeoutMs;
    this.#skills = options.skills ?? createOnlineSkills(world, driver, controller);
    this.#decision = new DecisionRuntime(
      this.#skills,
      () => world.snapshot(),
      (type, payload) => {
        const data = payload as {
          id?: string;
          goalId?: string;
          revision?: number;
          status?: Entry['status'];
          reason?: string;
        };
        const entry = this.#entries.get(data.id ?? data.goalId ?? '');
        if (
          entry &&
          data.revision === entry.goal.revision &&
          data.status &&
          ['running', 'succeeded', 'failed', 'cancelled'].includes(data.status)
        ) {
          entry.status = data.status;
          if (data.reason) entry.reason = data.reason;
          if (
            data.status === 'failed' &&
            data.reason &&
            /^(navigation_(?:unreachable|budget-exhausted|no_progress|replan_exhausted|not_stopped)|plan_expired)$/.test(
              data.reason,
            ) &&
            entry.replans < 2 &&
            entry.target &&
            this.#ready &&
            !this.#closed
          ) {
            entry.replans++;
            entry.status = 'planning';
            const token = ++entry.token;
            this.log('goal.replan.requested', {
              id: entry.goal.id,
              revision: entry.goal.revision,
              attempt: entry.replans,
              reason: data.reason,
            });
            queueMicrotask(() => void this.#plan(entry, token));
            return;
          }
        }
        log(type, payload);
      },
    );
  }
  #timeoutMs: number;
  #skills: ReturnType<typeof createOnlineSkills>;
  setReady(ready: boolean) {
    this.#ready = ready;
    if (!ready) this.stop();
  }
  status() {
    return [...this.#entries.values()].map(({ goal, status, question, reason }) => ({
      id: goal.id,
      revision: goal.revision,
      status,
      ...(question ? { question } : {}),
      ...(reason ? { reason } : {}),
    }));
  }
  command(line: string): string {
    const trimmed = line.trim();
    if (trimmed === '/status') return JSON.stringify(this.status());
    if (trimmed === '/stop' || /^(停下|停止)$/.test(trimmed)) {
      this.stop();
      return '已停止所有目标。';
    }
    if (this.#closed) return '运行时已关闭。';
    if (trimmed.startsWith('/goal ')) return this.submit(trimmed.slice(6));
    if (trimmed.startsWith('/replace ')) {
      const input = trimmed.slice(9).trim(),
        match = input.match(/^--goal\s+(\S+)\s+(.+)$/s);
      const active = [...this.#entries.values()].filter(
        (e) => !['succeeded', 'failed', 'cancelled'].includes(e.status),
      );
      if (!match && active.length !== 1)
        return `请指定 --goal <goalId>；候选: ${active.map((e) => e.goal.id).join(', ') || '无'}`;
      const entry = match ? this.#entries.get(match[1]!) : active[0];
      if (!entry || ['succeeded', 'failed', 'cancelled'].includes(entry.status))
        return '目标不存在或已结束。';
      this.#cancel(entry);
      entry.goal.revision++;
      entry.goal.text = match ? match[2]! : input;
      entry.status = 'planning';
      entry.token++;
      entry.history = [];
      entry.replans = 0;
      delete entry.target;
      delete entry.question;
      delete entry.reason;
      this.log('goal.accepted', {
        id: entry.goal.id,
        revision: entry.goal.revision,
        text: entry.goal.text,
      });
      void this.#interpret(entry, entry.goal.text, entry.token);
      return `已替换 ${entry.goal.id} revision=${entry.goal.revision}`;
    }
    if (trimmed.startsWith('/clarify ')) {
      const match = trimmed.match(/^\/clarify\s+(\S+)\s+(\d+)\s+(.+)$/s);
      if (!match) return '用法: /clarify <goalId> <revision> <回复>';
      const entry = this.#entries.get(match[1]!);
      if (
        !entry ||
        entry.status !== 'awaitingClarification' ||
        entry.goal.revision !== Number(match[2])
      )
        return '澄清已过期或目标不可用。';
      entry.history.push(`问题: ${entry.question ?? ''}\n回答: ${match[3]}`);
      entry.status = 'planning';
      entry.token++;
      delete entry.question;
      void this.#interpret(entry, `${entry.goal.text}\n${entry.history.join('\n')}`, entry.token);
      return `已接收澄清 ${entry.goal.id}`;
    }
    return '用法: /goal、/status、/stop、/replace、/clarify';
  }
  submit(text: string): string {
    if (!text.trim() || this.#closed) return '目标为空或运行时已关闭。';
    if (!this.#ready) return '尚未连接并完成初始观测。';
    const goal: Goal = {
      id: randomUUID(),
      sessionId: this.#sessionId,
      revision: 1,
      text: text.trim(),
      priority: 0.5,
    };
    const entry: Entry = { goal, status: 'planning', token: 1, history: [], replans: 0 };
    this.#entries.set(goal.id, entry);
    this.log('goal.accepted', { id: goal.id, revision: goal.revision, text: goal.text });
    void this.#interpret(entry, goal.text, entry.token);
    return `已接受 ${goal.id} revision=1`;
  }
  #cancel(entry: Entry) {
    entry.token++;
    this.#coordinator.cancel(entry.goal);
    this.#decision.cancel(entry.goal.id);
    entry.status = 'cancelled';
  }
  stop() {
    for (const entry of this.#entries.values())
      if (!['succeeded', 'failed', 'cancelled'].includes(entry.status)) this.#cancel(entry);
    this.controller.resetSession();
    this.log('goals.stopped', this.status());
  }
  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.stop();
    this.#decision.close();
  }
  async #interpret(entry: Entry, prompt: string, token: number) {
    const epoch = this.world.snapshot().sessionEpoch;
    try {
      const snapshot = this.world.snapshot();
      const response = await this.#coordinator.request(
        'intent',
        entry.goal,
        prompt,
        { world: observations(snapshot), skills: this.#skills.descriptions() },
        this.#timeoutMs,
      );
      if (
        entry.token !== token ||
        entry.status !== 'planning' ||
        this.world.snapshot().sessionEpoch !== epoch
      )
        return;
      this.log('model.intent.accepted', {
        goalId: entry.goal.id,
        revision: entry.goal.revision,
        response,
      });
      if (response.kind === 'clarification') {
        entry.goal.revision++;
        entry.status = 'awaitingClarification';
        entry.question = response.question;
        this.log('goal.awaitingClarification', {
          id: entry.goal.id,
          revision: entry.goal.revision,
          question: entry.question,
        });
        return;
      }
      if (response.kind !== 'intent') throw new Error('model_invalid_output');
      const intent = response.goal;
      const position =
        intent.type === 'navigateToPosition'
          ? {
              x: Number.isInteger(intent.position.x) ? intent.position.x + 0.5 : intent.position.x,
              y: intent.position.y,
              z: Number.isInteger(intent.position.z) ? intent.position.z + 0.5 : intent.position.z,
            }
          : intent.position;
      const target: Target = {
        type: intent.type,
        position,
        dimension: intent.dimension,
        forbidBlockBreaking: intent.constraints.forbidBlockBreaking,
        ...(intent.constraints.deadline === undefined
          ? {}
          : { deadline: intent.constraints.deadline }),
      };
      this.log('goal.target.confirmed', {
        id: entry.goal.id,
        revision: entry.goal.revision,
        target,
        coordinateSemantics: 'integer navigation x/z denote block centers',
      });
      entry.goal.target = position;
      entry.target = target;
      await this.#plan(entry, token);
    } catch (error) {
      if (entry.token !== token || entry.status === 'cancelled') return;
      entry.status = 'failed';
      entry.reason = error instanceof Error ? error.message : 'unknown_failure';
      this.log('goal.failed', {
        id: entry.goal.id,
        revision: entry.goal.revision,
        reason: entry.reason,
      });
    }
  }
  async #plan(entry: Entry, token: number) {
    const target = entry.target;
    if (!target || entry.token !== token || entry.status !== 'planning' || !this.#ready) return;
    const snapshot = this.world.snapshot(),
      epoch = snapshot.sessionEpoch;
    try {
      const priorTasks = this.#decision.tasksFor(entry.goal.id);
      this.#decision.create({
        id: entry.goal.id,
        revision: entry.goal.revision,
        sessionId: entry.goal.sessionId,
        epoch,
        target,
        priority: entry.goal.priority,
        recovery: entry.replans > 0,
      });
      const plan = await this.#coordinator.request(
        'plan',
        entry.goal,
        'plan',
        {
          goal: entry.goal,
          target,
          world: observations(snapshot, target.position),
          skills: this.#skills.descriptions(),
          currentTasks: priorTasks,
          recentFailures: entry.reason ? [entry.reason] : [],
        },
        this.#timeoutMs,
      );
      if (
        entry.token !== token ||
        entry.status !== 'planning' ||
        this.world.snapshot().sessionEpoch !== epoch
      )
        return;
      if (
        plan.kind !== 'plan' ||
        plan.goalId !== entry.goal.id ||
        plan.goalRevision !== entry.goal.revision
      )
        throw new Error('stale_model_response');
      this.#decision.acceptPlan(entry.goal.id, entry.goal.revision, plan.tasks, plan.validForMs);
      entry.status = 'running';
      delete entry.reason;
      this.log('model.plan.accepted', {
        goalId: entry.goal.id,
        revision: entry.goal.revision,
        response: plan,
      });
    } catch (error) {
      if (entry.token !== token) return;
      entry.status = 'failed';
      entry.reason = error instanceof Error ? error.message : 'unknown_failure';
      this.log('plan.rejected', {
        id: entry.goal.id,
        revision: entry.goal.revision,
        reason: entry.reason,
      });
      if (!this.#decision.failPlanning(entry.goal.id, entry.goal.revision, entry.reason))
        this.log('goal.failed', {
          id: entry.goal.id,
          revision: entry.goal.revision,
          reason: entry.reason,
        });
    }
  }
}
