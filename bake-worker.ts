// Worker entry for bake.ts: clusters the rows it is given and returns the gzipped snapshot.
import { parentPort, workerData } from 'node:worker_threads'
import { bakeSnapshot, gzipJson } from './bake.ts'

const gz = new Uint8Array(await gzipJson(bakeSnapshot(workerData)))
parentPort!.postMessage(gz, [gz.buffer])
