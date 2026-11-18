import { createBot } from 'mineflayer';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';

// Repeatable protocol/runtime probe. It records only measurements observed by
// this client; it does not claim that local physics ticks are server ticks.
const host = process.env.PAPER_HOST ?? '127.0.0.1';
const port = Number(process.env.PAPER_PORT ?? 25565);
const username = process.env.BOT_USERNAME ?? 'acceptance-probe';
const repeats = integerEnv('PROBE_REPEATS', 2, 1, 50);
const settleMs = integerEnv('PROBE_SETTLE_MS', 5_000, 500, 30_000);
const timeoutMs = 60_000;
const runId = randomUUID();

/** @param {string} type @param {unknown} payload */
function emit(type, payload) {
  console.log(
    JSON.stringify({ schemaVersion: 1, runId, seq: ++seq, at: performance.now(), type, payload }),
  );
}
let seq = 0;

/** @param {number} index */
async function attempt(index) {
  const attemptId = `${runId}:${index}`;
  // Reuse one offline identity so every iteration exercises a real reconnect.
  const bot = createBot({ host, port, username, version: '26.1' });
  const startedAt = performance.now();
  return new Promise(
    (
      /** @type {(value: unknown) => void} */ resolve,
      /** @type {(reason: Error) => void} */ reject,
    ) => {
      let done = false;
      let spawnedAt = 0;
      let lastTick = 0;
      let hasTick = false;
      let ticks = 0;
      /** @type {number[]} */
      const intervals = [];
      /** @type {ReturnType<typeof setTimeout> | undefined} */
      let timer;
      /** @type {ReturnType<typeof setTimeout> | undefined} */
      let settleTimer;
      /** @param {Error} [error] */
      const finish = (error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearTimeout(settleTimer);
        if (error) {
          bot.quit();
          reject(error);
        } else {
          const sorted = [...intervals].sort((a, b) => a - b);
          /** @param {number} p */
          const percentile = (p) =>
            sorted.length
              ? sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]
              : null;
          const result = {
            attempt: index,
            username: bot.username,
            protocolVersion: bot.version,
            minecraftVersion: bot.registry?.version.minecraftVersion ?? null,
            connectMs: spawnedAt - startedAt,
            observationMs: performance.now() - spawnedAt,
            physicsTicks: ticks,
            tickIntervalMs: {
              median: percentile(0.5),
              p95: percentile(0.95),
              max: sorted.at(-1) ?? null,
            },
            loadedColumns: bot.world?.getColumns()?.length ?? null,
            inventory: bot.inventory
              .items()
              .map(({ name, count, slot }) => ({ name, count, slot })),
            position: bot.entity.position,
          };
          emit('paper.probe.completed', result);
          bot.quit();
          resolve(result);
        }
      };
      timer = setTimeout(
        () => finish(new Error(`probe ${index} timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
      bot.on('error', (error) => finish(error));
      bot.on('kicked', (reason) => finish(new Error(`kicked: ${JSON.stringify(reason)}`)));
      bot.on('end', () => {
        if (!done) finish(new Error('connection ended before probe completed'));
      });
      bot.on('physicsTick', () => {
        const now = performance.now();
        if (hasTick) intervals.push(now - lastTick);
        lastTick = now;
        hasTick = true;
        ticks += 1;
      });
      bot.once('spawn', () => {
        spawnedAt = performance.now();
        const chunksBefore = bot.world.getColumns().length;
        const inventoryBefore = bot.inventory.items().length;
        emit('paper.probe.spawned', {
          attempt: index,
          username: bot.username,
          minecraftVersion: bot.registry?.version.minecraftVersion,
          chunksBefore,
          inventoryItems: inventoryBefore,
        });
        settleTimer = setTimeout(() => {
          const columns = bot.world.getColumns().length;
          if (bot.registry?.version.minecraftVersion !== '26.1')
            return finish(
              new Error(`expected registry 26.1, got ${bot.registry?.version.minecraftVersion}`),
            );
          if (ticks < 20) return finish(new Error(`expected >=20 physics ticks, got ${ticks}`));
          if (columns < 1) return finish(new Error('no terrain columns loaded'));
          finish();
        }, settleMs);
      });
    },
  );
}

/** @param {string} name @param {number} fallback @param {number} min @param {number} max */
function integerEnv(name, fallback, min, max) {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

try {
  const results = [];
  for (let i = 1; i <= repeats; i += 1) {
    results.push(await attempt(i));
    if (i < repeats) await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  emit('paper.probe.summary', { runId, host, port, repeats, results });
} catch (error) {
  emit('paper.probe.failed', { message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
}
