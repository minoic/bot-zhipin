import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeStores, log, openStores } from '../apps/bot/src/logging.js';
import { createShutdown } from '../apps/bot/src/shutdown.js';
import { MemoryStore } from '../packages/memory/src/index.js';
import { readNdjsonLog } from '../packages/replay/src/index.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
describe('online shutdown', () => {
  it('records the asynchronous end before closing both stores exactly once', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bot-shutdown-'));
    const db = join(dir, 'events.sqlite'),
      ndjson = join(dir, 'events.ndjson');
    vi.stubEnv('BOT_DB_PATH', db);
    vi.stubEnv('BOT_LOG_PATH', ndjson);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await openStores('shutdown-test');
      const seq = { value: 0 };
      let accepting = true;
      const emit = (type: string) => {
        if (accepting) log(type, {}, seq, 1);
      };
      const close = vi.fn(closeStores),
        stop = vi.fn(() => emit('goals.stopped'));
      let lifecycle: ReturnType<typeof createShutdown>;
      const quit = vi.fn(() =>
        setTimeout(() => {
          emit('observation.disconnect');
          emit('bot.disconnected');
          lifecycle.markEnded();
        }, 10),
      );
      lifecycle = createShutdown({
        stop,
        quit,
        timeout: () => emit('timeout'),
        detach: () => {
          accepting = false;
        },
        closeStores: close,
        timeoutMs: 100,
      });
      await Promise.all([lifecycle.shutdown(true), lifecycle.shutdown(true)]);
      emit('late');
      const records = await readNdjsonLog(ndjson);
      expect(records.map((event) => event.type)).toEqual([
        'goals.stopped',
        'observation.disconnect',
        'bot.disconnected',
      ]);
      const store = new MemoryStore(db);
      await store.ready();
      const events = await store.search({ sessionId: 'shutdown-test', limit: 20 });
      expect(events.events.map((event) => event.type).sort()).toEqual(
        records.map((event) => event.type).sort(),
      );
      await store.close();
      expect(quit).toHaveBeenCalledOnce();
      expect(stop).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledOnce();
      expect(stderr).not.toHaveBeenCalled();
    } finally {
      await closeStores();
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('finishes with a bounded timeout and ignores a late end', async () => {
    const order: string[] = [];
    const lifecycle = createShutdown({
      stop: () => order.push('stop'),
      quit: () => order.push('quit'),
      timeout: () => order.push('timeout'),
      detach: () => order.push('detach'),
      closeStores: async () => {
        order.push('close');
      },
      timeoutMs: 5,
    });
    await lifecycle.shutdown(true);
    lifecycle.markEnded();
    await lifecycle.shutdown(false);
    expect(order).toEqual(['stop', 'quit', 'timeout', 'detach', 'close']);
  });
});
