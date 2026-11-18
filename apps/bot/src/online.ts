import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { createBot } from 'mineflayer';
import {
  ActionController,
  LeaseArbiter,
  MineflayerDriver,
} from '../../../packages/controller/src/index.js';
import { WorldModel } from '../../../packages/world/src/index.js';
import { BotRuntime } from './runtime.js';
import { loadConfig } from './config.js';
import { log, openStores, closeStores } from './logging.js';
import { createShutdown } from './shutdown.js';
export async function runOnline() {
  loadConfig();
  const host = process.env.BOT_HOST ?? '127.0.0.1',
    port = Number(process.env.BOT_PORT ?? 25565),
    username = process.env.BOT_USERNAME;
  if (!username) throw new Error('Set BOT_USERNAME before starting the connected bot.');
  await openStores(`${username}-${randomUUID()}`);
  const version = process.env.BOT_VERSION;
  const bot = createBot({ host, port, username, ...(version ? { version } : {}) });
  const arbiter = new LeaseArbiter(),
    driver = new MineflayerDriver(bot, arbiter),
    world = new WorldModel(),
    seq = { value: 0 };
  const controller = new ActionController(driver, arbiter);
  let acceptingLogs = true;
  const emit = (type: string, payload: unknown, epoch = world.snapshot().sessionEpoch) => {
    if (acceptingLogs) log(type, payload, seq, epoch);
  };
  const runtime = new BotRuntime(world, driver, controller, emit);
  const input = createInterface({ input: process.stdin, output: process.stdout });
  let closing: Promise<void> | undefined;
  const lifecycle = createShutdown({
    stop: () => {
      runtime.close();
      input.close();
    },
    quit: () => bot.quit('shutdown'),
    timeout: () => {
      emit('bot.disconnect_timeout', { reason: 'shutdown_timeout' });
      driver.disconnect();
    },
    detach: () => {
      acceptingLogs = false;
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
    },
    closeStores,
  });
  const shutdown = (quit: boolean) => {
    if (!closing) closing = lifecycle.shutdown(quit);
    return closing;
  };
  const onSignal = () => {
    void shutdown(true).catch((error) =>
      process.stderr.write(`shutdown_failed: ${String(error)}\n`),
    );
  };
  input.on('line', (line) => process.stdout.write(`${runtime.command(line)}\n`));
  input.on('close', () => {
    void shutdown(true).catch((error) =>
      process.stderr.write(`shutdown_failed: ${String(error)}\n`),
    );
  });
  driver.subscribe((e) => {
    world.ingest(e);
    if (e.type === 'disconnect' || e.type === 'dimensionReset') runtime.setReady(false);
    emit(`observation.${e.type}`, e, e.sessionEpoch);
  });
  bot.on('spawn', () => {
    const epoch = world.snapshot().sessionEpoch;
    void driver
      .importNearby()
      .then(() => {
        if (closing || world.snapshot().sessionEpoch !== epoch) return;
        runtime.setReady(true);
        emit(
          'bot.ready',
          {
            username,
            host,
            port,
            version: bot.version,
            hint: '在本地终端输入 /goal <目标>，使用 /status 查看状态，/stop 停止。',
          },
          epoch,
        );
      })
      .catch(() => {
        runtime.setReady(false);
        emit('bot.error', { message: 'terrain_import_failed' });
      });
  });
  bot.on('kicked', (reason) => {
    emit('bot.kicked', { reason: String(reason) });
  });
  bot.on('error', (error) => {
    emit('bot.error', { message: error.message });
  });
  bot.on('end', (reason) => {
    emit('bot.disconnected', { reason: String(reason ?? 'unknown') });
    lifecycle.markEnded();
    void shutdown(false).catch((error) =>
      process.stderr.write(`shutdown_failed: ${String(error)}\n`),
    );
  });
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  await new Promise<void>((resolve, reject) => {
    bot.once('spawn', resolve);
    bot.once('error', reject);
  }).catch(async (error) => {
    await shutdown(true);
    throw error;
  });
}
