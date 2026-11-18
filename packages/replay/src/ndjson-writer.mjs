import { open } from 'node:fs/promises';
import { parentPort, workerData } from 'node:worker_threads';

const file = await open(workerData.path, 'a');
let writes = Promise.resolve();
let failure;

parentPort.on('message', ({ id, op, payload }) => {
  if (op === 'append') {
    writes = writes.then(async () => {
      if (failure) throw failure;
      await file.write(`${payload.line}\n`);
    });
  } else if (op === 'flush') {
    writes = writes.then(async () => {
      if (failure) throw failure;
      await file.sync();
    });
  } else if (op === 'close') {
    writes = writes.then(async () => {
      if (failure) throw failure;
      await file.sync();
      await file.close();
    });
  } else {
    parentPort.postMessage({ id, ok: false, error: `unknown writer operation: ${op}` });
    return;
  }
  writes.then(
    () => parentPort.postMessage({ id, ok: true }),
    (error) => {
      failure = error instanceof Error ? error : new Error(String(error));
      parentPort.postMessage({ id, ok: false, error: failure.message });
    },
  );
});
