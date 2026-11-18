import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { MemoryStore, type MemoryEvent } from '../../../packages/memory/src/index.js';
import { NdjsonRecorder } from '../../../packages/replay/src/index.js';

let recorder: NdjsonRecorder | undefined;
let memory: MemoryStore | undefined;
let sessionId = 'default';
let closing: Promise<void> | undefined;
let queue: MemoryEvent[] = [];
let flush: Promise<void> | undefined;
let scheduled: NodeJS.Immediate | undefined;
let memoryFailed = false;
let reportedOverflow = false;
let recorderFailed = false;
let recorderOverflow = false;
const maxQueuedEvents = 8192;
const quiet = new Set([
  'observation.block',
  'observation.tick',
  'observation.position',
  'observation.entity',
  'observation.entityGone',
  'observation.blockUnload',
  'observation.chunkUnload',
  'observation.inventory',
]);
export const shouldPrintEvent = (type: string): boolean => !quiet.has(type);
function scheduleFlush() {
  if (scheduled || flush || memoryFailed || !memory || queue.length === 0) return;
  scheduled = setImmediate(() => {
    scheduled = undefined;
    const store = memory;
    if (!store) return;
    const events = queue.splice(0, 128);
    flush = store
      .writeBatch({ events })
      .catch((error) => {
        memoryFailed = true;
        process.stderr.write(`memory_write_failed: ${String(error)}\n`);
      })
      .finally(() => {
        flush = undefined;
        scheduleFlush();
      });
  });
}
function queueMemory(event: MemoryEvent) {
  if (memoryFailed) return;
  if (queue.length >= maxQueuedEvents) {
    const index = queue.findIndex((item) => quiet.has(item.type));
    if (index >= 0) queue.splice(index, 1);
    else {
      if (!reportedOverflow) process.stderr.write('memory_log_backpressure: events were dropped\n');
      reportedOverflow = true;
      return;
    }
    if (!reportedOverflow) process.stderr.write('memory_log_backpressure: events were dropped\n');
    reportedOverflow = true;
  }
  queue.push(event);
  scheduleFlush();
}
export const log = (type: string, payload: unknown, seq: { value: number }, sessionEpoch = 0) => {
  const event = {
    schemaVersion: 1 as const,
    seq: ++seq.value,
    at: performance.now(),
    type,
    sessionEpoch,
    payload,
  };
  if (shouldPrintEvent(type)) process.stdout.write(`${JSON.stringify(event)}\n`);
  if (recorder && !recorderFailed) {
    try {
      if (!recorder.appendEvent(event)) {
        if (!recorderOverflow)
          process.stderr.write('event_log_backpressure: events were dropped\n');
        recorderOverflow = true;
      }
    } catch (error) {
      recorderFailed = true;
      process.stderr.write(`event_log_failed: ${String(error)}\n`);
    }
  }
  if (memory) queueMemory({ sessionId, seq: event.seq, at: event.at, type, payload: event });
};
export async function openStores(id: string) {
  if (closing) await closing;
  closing = undefined;
  queue = [];
  memoryFailed = false;
  recorderFailed = false;
  recorderOverflow = false;
  reportedOverflow = false;
  sessionId = id;
  const dbPath = process.env.BOT_DB_PATH ?? '.data/minecraft-bot.sqlite';
  await mkdir(dirname(dbPath), { recursive: true });
  memory = new MemoryStore(dbPath);
  await memory.ready();
  const logPath = process.env.BOT_LOG_PATH;
  if (logPath) {
    await mkdir(dirname(logPath), { recursive: true });
    recorder = new NdjsonRecorder(logPath);
  }
}
export function closeStores(): Promise<void> {
  if (!closing)
    closing = (async () => {
      try {
        await recorder?.close();
      } finally {
        recorder = undefined;
        try {
          if (scheduled) {
            clearImmediate(scheduled);
            scheduled = undefined;
          }
          if (flush) await flush;
          if (scheduled) {
            clearImmediate(scheduled);
            scheduled = undefined;
          }
          while (memory && queue.length && !memoryFailed)
            await memory.writeBatch({ events: queue.splice(0, 128) });
          await memory?.close();
        } finally {
          memory = undefined;
        }
      }
    })();
  return closing;
}
