import { createBot } from 'mineflayer';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';

// A second Mineflayer connection observes server-replicated entities. It is
// independent of the subject client's local physics simulation, but is not a
// vanilla-client baseline or an authoritative Paper plugin sampler.
const host = process.env.PAPER_HOST ?? '127.0.0.1';
const port = Number(process.env.PAPER_PORT ?? 25565);
const username = process.env.OBSERVER_USERNAME ?? 'paper-observer';
const subject = process.env.OBSERVE_USERNAME;
const durationMs = integerEnv('OBSERVE_DURATION_MS', 60_000, 1_000, 300_000);
const observerId = randomUUID();
let seq = 0;
const bot = createBot({ host, port, username, version: '26.1' });
const start = performance.now();
/** @param {string} type @param {unknown} payload */
const emit = (type, payload) =>
  console.log(
    JSON.stringify({
      schemaVersion: 1,
      observerId,
      seq: ++seq,
      at: performance.now(),
      type,
      payload,
    }),
  );
let finished = false;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let startupTimer;
/** @type {ReturnType<typeof setInterval> | undefined} */
let sampleTimer;

/** @param {{id:number;type:string;username?:string;name?:string;position:{x:number;y:number;z:number};velocity?:{x:number;y:number;z:number};onGround?:boolean}} entity */
function snapshot(entity) {
  if (
    entity.type !== 'player' ||
    (subject && entity.username !== subject && entity.name !== subject)
  )
    return;
  emit('paper.observer.entity', {
    observerUsername: username,
    subjectUsername: entity.username ?? entity.name ?? null,
    entityId: entity.id,
    position: { x: entity.position.x, y: entity.position.y, z: entity.position.z },
    velocity: entity.velocity
      ? { x: entity.velocity.x, y: entity.velocity.y, z: entity.velocity.z }
      : null,
    onGround: entity.onGround ?? null,
    ageMs: performance.now() - start,
  });
}

/** @param {Error} [error] */
function stop(error) {
  if (finished) return;
  finished = true;
  clearTimeout(startupTimer);
  clearInterval(sampleTimer);
  if (error) {
    emit('paper.observer.failed', { message: error.message });
    process.exitCode = 1;
  }
  bot.quit();
}

startupTimer = setTimeout(() => stop(new Error('observer timed out waiting for spawn')), 60_000);
bot.on('error', (error) => stop(error));
bot.on('kicked', (reason) => stop(new Error(`kicked: ${JSON.stringify(reason)}`)));
bot.once('spawn', () => {
  clearTimeout(startupTimer);
  bot.clearControlStates();
  emit('paper.observer.ready', {
    observerUsername: username,
    minecraftVersion: bot.registry?.version.minecraftVersion,
    subject: subject ?? null,
    durationMs,
  });
  for (const entity of Object.values(bot.entities)) snapshot(entity);
  bot.on('entityMoved', snapshot);
  bot.on('entitySpawn', snapshot);
  sampleTimer = setInterval(() => {
    for (const entity of Object.values(bot.entities)) snapshot(entity);
    if (performance.now() - start >= durationMs) stop();
  }, 100);
});
bot.on('end', () => {
  if (!finished) {
    finished = true;
    clearTimeout(startupTimer);
    clearInterval(sampleTimer);
    process.exitCode = 1;
  }
  emit('paper.observer.ended', { durationObservedMs: performance.now() - start });
});
process.once('SIGINT', () => stop());
process.once('SIGTERM', () => stop());

/** @param {string} name @param {number} fallback @param {number} min @param {number} max */
function integerEnv(name, fallback, min, max) {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isInteger(value) || value < min || value > max)
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return value;
}
