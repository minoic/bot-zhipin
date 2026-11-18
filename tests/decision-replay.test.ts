import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  NdjsonRecorder,
  readNdjsonLog,
  replayDecision,
  type ReplayEvent,
} from '../packages/replay/src/index.js';

const event = (seq: number, type: string, payload: unknown): ReplayEvent => ({
  schemaVersion: 1,
  seq,
  at: seq * 10,
  sessionEpoch: 1,
  type,
  payload,
});
const task = {
  id: 't1',
  capabilityId: 'navigate',
  params: { target: { x: 4, y: 1, z: 0 } },
  dependsOn: [],
  priority: 0.5,
  timeoutMs: 30000,
  successCondition: 'verified:navigate',
  resources: ['move'],
  preemptible: true,
};
const response = {
  kind: 'plan',
  goalId: 'g1',
  goalRevision: 1,
  tasks: [
    {
      id: 'local',
      capabilityId: 'navigate',
      params: { target: { x: 4, y: 1, z: 0 } },
      dependsOn: [],
      timeoutMs: 30000,
    },
  ],
  validForMs: 30000,
};

describe('caller-owned event recording', () => {
  it('persists caller sequence/time and permits retry after backpressure', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bot-replay-'));
    try {
      const path = join(dir, 'events.ndjson');
      const recorder = new NdjsonRecorder(path, { maxPending: 1 });
      const first = event(10, 'goal.accepted', { id: 'g1', revision: 1 });
      const second = event(11, 'goal.failed', { id: 'g1', revision: 1, reason: 'test' });
      expect(recorder.appendEvent(first)).toBe(true);
      expect(recorder.appendEvent(second)).toBe(false);
      await recorder.drain();
      expect(recorder.appendEvent(second)).toBe(true);
      expect(() => recorder.appendEvent(second)).toThrow('invalid_replay_event_order');
      expect(() => recorder.appendEvent({ ...event(12, 'x', {}), at: 1 })).toThrow(
        'invalid_replay_event_order',
      );
      expect(() => recorder.append('x', {})).toThrow('ndjson_mixed_sequence_sources');
      await recorder.close();
      expect(await readNdjsonLog(path)).toEqual([first, second]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('recorded decision replay', () => {
  it('reconstructs validated model, plan and task acceptance order without executing actions', async () => {
    const records = [
      event(1, 'goal.accepted', { id: 'g1', revision: 1 }),
      event(2, 'plan.accepted', { goalId: 'g1', revision: 1, generation: 1, tasks: [task] }),
      event(3, 'model.plan.accepted', { goalId: 'g1', revision: 1, response }),
      event(4, 'task.running', { goalId: 'g1', revision: 1, generation: 1, taskId: 't1' }),
      event(5, 'task.succeeded', {
        goalId: 'g1',
        revision: 1,
        generation: 1,
        taskId: 't1',
        result: { observed: true },
      }),
      event(6, 'goal.failed', { id: 'g1', revision: 1, reason: 'goal_evidence_missing' }),
      event(7, 'task.running', { goalId: 'g1', revision: 1, generation: 0, taskId: 't1' }),
    ];
    const result = await replayDecision(records);
    expect(result.goals.g1).toMatchObject({
      revision: 1,
      status: 'failed',
      reason: 'goal_evidence_missing',
      generation: 1,
      tasks: { t1: { status: 'succeeded', result: { observed: true } } },
      models: [response],
    });
    expect(result.timeline.map((row) => row.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
  it('rejects malformed or mismatched model results and duplicate sequences', async () => {
    const accepted = event(1, 'goal.accepted', { id: 'g1', revision: 1 });
    await expect(
      replayDecision([
        accepted,
        event(2, 'model.plan.accepted', {
          goalId: 'g1',
          revision: 1,
          response: { ...response, goalId: 'wrong' },
        }),
      ]),
    ).rejects.toThrow('replay_invalid_model_response_kind');
    await expect(
      replayDecision([
        accepted,
        event(2, 'model.intent.accepted', {
          goalId: 'g1',
          revision: 1,
          response: { kind: 'intent', goal: {} },
        }),
      ]),
    ).rejects.toThrow();
    await expect(replayDecision([accepted, accepted])).rejects.toThrow(/sequence/);
  });
  it('replays a recovery and new generation without accepting old task results', async () => {
    const second = { ...task, id: 't2' };
    const records = [
      event(1, 'goal.accepted', { id: 'g1', revision: 1 }),
      event(2, 'plan.accepted', { goalId: 'g1', revision: 1, generation: 1, tasks: [task] }),
      event(3, 'task.running', { goalId: 'g1', revision: 1, generation: 1, taskId: 't1' }),
      event(4, 'goal.replan.requested', {
        id: 'g1',
        revision: 1,
        reason: 'navigation_no_progress',
        attempt: 1,
      }),
      event(5, 'goal.replanning', { id: 'g1', revision: 1, generation: 1, status: 'planning' }),
      event(6, 'plan.accepted', { goalId: 'g1', revision: 1, generation: 2, tasks: [second] }),
      event(7, 'task.succeeded', {
        goalId: 'g1',
        revision: 1,
        generation: 1,
        taskId: 't1',
        result: { observed: true },
      }),
      event(8, 'task.running', { goalId: 'g1', revision: 1, generation: 2, taskId: 't2' }),
    ];
    const replay = await replayDecision(records);
    expect(replay.goals.g1).toMatchObject({
      revision: 1,
      generation: 2,
      status: 'running',
      tasks: { t2: { status: 'running' } },
    });
    expect(replay.goals.g1?.tasks.t1).toBeUndefined();
    expect(replay.goals.g1?.reason).toBeUndefined();
  });
  it('starts an explicitly accepted replacement revision after the old revision is cancelled', async () => {
    const records = [
      event(1, 'goal.accepted', { id: 'g1', revision: 1 }),
      event(2, 'goal.cancelled', { id: 'g1', revision: 1 }),
      event(3, 'goal.accepted', { id: 'g1', revision: 2, text: 'new goal' }),
      event(4, 'goal.failed', { id: 'g1', revision: 1, reason: 'stale' }),
      event(5, 'goal.awaitingClarification', { id: 'g1', revision: 3, question: 'where?' }),
    ];
    const replay = await replayDecision(records);
    expect(replay.goals.g1).toMatchObject({
      revision: 3,
      status: 'awaitingClarification',
      question: 'where?',
    });
  });
  it('does not let a late plan or same-revision acceptance revive a cancelled goal', async () => {
    const records = [
      event(1, 'goal.accepted', { id: 'g1', revision: 1 }),
      event(2, 'goal.cancelled', { id: 'g1', revision: 1 }),
      event(3, 'plan.accepted', { goalId: 'g1', revision: 1, generation: 1, tasks: [task] }),
      event(4, 'goal.accepted', { id: 'g1', revision: 1, status: 'running' }),
      event(5, 'goal.awaitingClarification', { id: 'g1', revision: 2, question: 'late' }),
    ];
    const replay = await replayDecision(records);
    expect(replay.goals.g1).toMatchObject({
      revision: 1,
      generation: 0,
      status: 'cancelled',
      tasks: {},
    });
  });
  it('keeps cancellation terminal when late results arrive and handles new clarification revisions', async () => {
    const records = [
      event(1, 'goal.accepted', { id: 'g1', revision: 1 }),
      event(2, 'goal.awaitingClarification', { id: 'g1', revision: 2, question: 'where?' }),
      event(3, 'goal.accepted', { id: 'g1', revision: 2 }),
      event(4, 'plan.accepted', { goalId: 'g1', revision: 2, generation: 1, tasks: [task] }),
      event(5, 'goal.cancelled', { id: 'g1', revision: 2 }),
      event(6, 'task.succeeded', {
        goalId: 'g1',
        revision: 2,
        generation: 1,
        taskId: 't1',
        result: {},
      }),
      event(7, 'goal.succeeded', { id: 'g1', revision: 2 }),
    ];
    const result = await replayDecision(records);
    expect(result.goals.g1).toMatchObject({
      revision: 2,
      status: 'cancelled',
      tasks: { t1: { status: 'pending' } },
    });
  });
});
