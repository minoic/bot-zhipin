import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeStores, log, openStores, shouldPrintEvent } from '../apps/bot/src/logging.js';
import { MemoryStore } from '../packages/memory/src/index.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
describe('online logging', () => {
  it('suppresses frequent observations in the terminal while retaining important events', () => {
    for (const type of [
      'observation.block',
      'observation.tick',
      'observation.position',
      'observation.entity',
      'observation.entityGone',
      'observation.blockUnload',
      'observation.chunkUnload',
    ])
      expect(shouldPrintEvent(type)).toBe(false);
    for (const type of [
      'bot.ready',
      'goal.failed',
      'bot.disconnected',
      'model.attempt',
      'observation.spawn',
      'observation.health',
      'observation.dimensionReset',
      'observation.disconnect',
      'observation.interaction.observedOpen',
    ])
      expect(shouldPrintEvent(type)).toBe(true);
  });
  it('flushes queued observations and lifecycle events to SQLite on repeated close', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bot-log-test-'));
    const path = join(dir, 'events.sqlite');
    vi.stubEnv('BOT_DB_PATH', path);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await openStores('test-session');
      const seq = { value: 0 };
      for (let i = 0; i < 300; i++) log('observation.block', { n: i }, seq, 1);
      log('goal.accepted', { id: 'g' }, seq, 1);
      await Promise.all([closeStores(), closeStores()]);
      const store = new MemoryStore(path);
      await store.ready();
      const result = await store.search({ sessionId: 'test-session', limit: 200 });
      expect(result.events.some((event) => event.type === 'goal.accepted')).toBe(true);
      expect(result.events.some((event) => event.type === 'observation.block')).toBe(true);
      await store.close();
    } finally {
      await closeStores();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
