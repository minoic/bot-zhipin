import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../packages/memory/src/index.js';
import {
  NdjsonRecorder,
  readNdjsonLog,
  recomputeDeterministically,
  replayRecorded,
  VirtualClock,
} from '../packages/replay/src/index.js';

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'bot-zhipin-test-'));
  temporaryDirectories.push(path);
  return path;
}

describe('memory worker', () => {
  it('batches writes, filters scoped/expired facts, searches FTS and recovers persisted rows', async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, 'memory.sqlite');
    const store = new MemoryStore(path);
    await store.ready();
    await store.writeBatch({
      events: [
        {
          sessionId: 's1',
          goalId: 'g1',
          seq: 1,
          at: 1,
          type: 'goal.accepted',
          payload: { text: 'find emerald' },
        },
      ],
      goals: [
        {
          id: 'g1',
          sessionId: 's1',
          revision: 1,
          status: 'active',
          content: { target: 'cave' },
          updatedAt: 2,
        },
      ],
      tasks: [
        {
          id: 't1',
          goalId: 'g1',
          status: 'ready',
          content: { capability: 'navigate' },
          updatedAt: 2,
        },
      ],
      facts: [
        {
          id: 'f1',
          sessionId: 's1',
          goalId: 'g1',
          entityId: 'e1',
          dimension: 'overworld',
          x: 10,
          y: 20,
          z: 30,
          text: 'emerald ore in cave',
          source: 'protocol',
          observedAt: 3,
          expiresAt: 50,
          confidence: 0.9,
          confirmed: true,
        },
        {
          id: 'f2',
          sessionId: 's1',
          goalId: 'g1',
          entityId: 'e1',
          dimension: 'overworld',
          x: 10,
          y: 20,
          z: 30,
          text: 'emerald far away',
          source: 'inference',
          observedAt: 4,
          expiresAt: 8,
          confidence: 0.4,
          confirmed: false,
        },
        {
          id: 'f3',
          sessionId: 'other',
          text: 'emerald ore',
          source: 'protocol',
          observedAt: 4,
          confirmed: true,
        },
      ],
      summaries: [
        {
          id: 'summary-1',
          sessionId: 's1',
          goalId: 'g1',
          text: 'Observed an emerald deposit',
          eventFrom: 1,
          eventTo: 1,
          createdAt: 5,
        },
      ],
    });

    const scoped = await store.search({
      sessionId: 's1',
      goalId: 'g1',
      entityId: 'e1',
      dimension: 'overworld',
      position: { x: 10, y: 20, z: 30, radius: 2 },
      query: 'emerald cave',
      now: 10,
    });
    expect(scoped.facts.map((fact) => fact.id)).toEqual(['f1']);
    expect(scoped.events).toHaveLength(1);
    expect(scoped.summaries[0]?.eventFrom).toBe(1);
    expect((await store.search({ sessionId: 'other' })).facts.map((fact) => fact.id)).toEqual([
      'f3',
    ]);
    await store.close();

    const recovered = new MemoryStore(path);
    await recovered.ready();
    expect(
      (await recovered.search({ sessionId: 's1', query: 'emerald', now: 10 })).facts.map(
        (fact) => fact.id,
      ),
    ).toEqual(['f1']);
    await recovered.close();
  });

  it('remembers a worker startup failure and rejects later operations instead of hanging', async () => {
    const directory = await temporaryDirectory();
    const store = new MemoryStore(join(directory, 'missing', 'memory.sqlite'));
    await expect(store.ready()).rejects.toThrow();
    await expect(store.search({ sessionId: 's1' })).rejects.toThrow();
    await store.close();
  });
});

describe('decision replay', () => {
  it('writes monotonic NDJSON and dispatches records under an injected virtual clock', async () => {
    const path = join(await temporaryDirectory(), 'events.ndjson');
    const recorder = new NdjsonRecorder(path, { sessionEpoch: 3 });
    expect(recorder.append('input.frame', { forward: true })).toBe(true);
    expect(recorder.append('decision.selected', { action: 'navigate' })).toBe(true);
    await recorder.drain();
    await recorder.close();

    const events = await readNdjsonLog(path);
    expect(events.map((event) => event.seq)).toEqual([1, 2]);
    expect(events.every((event) => event.sessionEpoch === 3)).toBe(true);
    expect(events[1]!.at).toBeGreaterThanOrEqual(events[0]!.at);

    const clock = new VirtualClock();
    const seen: string[] = [];
    const outputs = await replayRecorded(
      events,
      (event, virtual) => {
        if (event.type === 'input.frame') virtual.setTimeout(() => seen.push('timer'), 1);
        seen.push(`${virtual.now()}:${event.type}`);
      },
      clock,
    );
    expect(outputs).toHaveLength(2);
    clock.advanceTo(events[1]!.at + 1);
    expect(seen).toEqual([
      `${events[0]!.at}:input.frame`,
      `${events[1]!.at}:decision.selected`,
      'timer',
    ]);
    expect(() => clock.advanceTo(-1)).toThrow(/monotonically/);
  });

  it('recomputes with stable order, seeded randomness, and fixed expansion budgets', async () => {
    const inputs = [
      { seq: 2, seed: 41, maxExpansions: 16, input: { options: ['north', 'south'] } },
      { seq: 1, seed: 41, maxExpansions: 16, input: { options: ['north', 'south'] } },
    ];
    const compute = (
      { options }: { options: string[] },
      context: { random: () => number; maxExpansions: number },
    ) => ({
      choice: options[Math.floor(context.random() * options.length)],
      budget: context.maxExpansions,
    });
    const a = await recomputeDeterministically(inputs, compute);
    const b = await recomputeDeterministically(inputs, compute);
    expect(a).toEqual(b);
    expect(a.map((item) => item.seq)).toEqual([1, 2]);
    expect(a.every((item) => item.matchesExpected === null && item.maxExpansions === 16)).toBe(
      true,
    );
  });
});
