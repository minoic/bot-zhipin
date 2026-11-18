import { parentPort, workerData } from 'node:worker_threads';
import { search } from './search.ts';

parentPort.postMessage(search(workerData));
