import { createBot } from 'mineflayer';

const host = process.env.PAPER_HOST ?? '127.0.0.1';
const port = Number(process.env.PAPER_PORT ?? 25565);
const username = process.env.BOT_USERNAME ?? 'protocol-smoke';
const timeoutMs = 60_000;

/** @param {number} attempt */
async function smokeConnection(attempt) {
  const bot = createBot({ host, port, username, version: '26.1' });
  await new Promise(
    (
      /** @type {(value?: void | PromiseLike<void>) => void} */ resolve,
      /** @type {(reason?: unknown) => void} */ reject,
    ) => {
      let spawned = false;
      let stopping = false;
      let settled = false;
      let physicsTicks = 0;
      let loadedColumns = 0;
      /** @type {ReturnType<typeof setTimeout> | undefined} */
      let observationTimer;

      const timeout = setTimeout(
        () => fail(new Error(`Attempt ${attempt} timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
      const cleanup = () => {
        clearTimeout(timeout);
        if (observationTimer) clearTimeout(observationTimer);
      };
      /** @param {Error} error */
      const fail = (error) => {
        if (settled) return;
        settled = true;
        stopping = true;
        cleanup();
        bot.quit();
        reject(error);
      };

      bot.on('error', (error) => fail(error));
      bot.on('kicked', (reason) => fail(new Error(`Kicked: ${JSON.stringify(reason)}`)));
      bot.on('end', () => {
        if (stopping) {
          if (!settled) {
            settled = true;
            cleanup();
            resolve();
          }
        } else {
          fail(
            new Error(
              `Connection ${attempt} ended unexpectedly${spawned ? ' after spawn' : ' before spawn'}`,
            ),
          );
        }
      });
      bot.on('physicsTick', () => {
        physicsTicks += 1;
      });
      bot.once('spawn', () => {
        spawned = true;
        bot.world.on('chunkColumnLoad', () => {
          loadedColumns += 1;
        });
        const registryVersion = bot.registry?.version.minecraftVersion;
        if (registryVersion !== '26.1') {
          fail(new Error(`Unexpected registry ${registryVersion}`));
          return;
        }
        const spawnPosition = bot.entity.position;
        observationTimer = setTimeout(() => {
          if (physicsTicks < 20) {
            fail(new Error(`Expected >=20 physics ticks, got ${physicsTicks}`));
            return;
          }
          if (loadedColumns < 1) {
            fail(new Error('No terrain chunks loaded'));
            return;
          }
          console.log(
            JSON.stringify({
              attempt,
              username,
              registryVersion,
              spawn: spawnPosition,
              inventorySlots: bot.inventory.items().length,
              physicsTicks,
              loadedColumns,
            }),
          );
          stopping = true;
          bot.quit();
        }, 1500);
      });
    },
  );
}

try {
  await smokeConnection(1);
  await new Promise((resolve) => setTimeout(resolve, 5000));
  await smokeConnection(2);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
