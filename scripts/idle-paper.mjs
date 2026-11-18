import { createBot } from 'mineflayer';

const host = process.env.PAPER_HOST ?? '127.0.0.1';
const port = Number(process.env.PAPER_PORT ?? 25565);
const username = process.env.BOT_USERNAME ?? 'IdleBot';

const bot = createBot({ host, port, username, version: '26.1' });
let stopping = false;

bot.once('spawn', () => {
  bot.clearControlStates();
  console.log(
    JSON.stringify({ event: 'spawn', username, host, port, position: bot.entity.position }),
  );
});

bot.on('error', (error) => {
  console.error(JSON.stringify({ event: 'error', message: error.message }));
  process.exitCode = 1;
});

bot.on('kicked', (reason) => {
  console.error(JSON.stringify({ event: 'kicked', reason }));
  process.exitCode = 1;
});

bot.on('end', () => {
  console.log(JSON.stringify({ event: 'disconnected', username, stopping }));
  if (!stopping) process.exitCode = 1;
});

function stop() {
  if (stopping) return;
  stopping = true;
  bot.clearControlStates();
  bot.quit();
}

process.once('SIGINT', stop);
process.once('SIGTERM', stop);
