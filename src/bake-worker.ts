// Worker entry for bake.ts: reads the archive itself (or takes the rows it is given), clusters it and returns the gzipped snapshot.
import { parentPort, workerData } from 'node:worker_threads'
import { bakeSnapshot, gzipJson, readSlimRows } from './bake.ts'

const rows = Array.isArray(workerData) ? workerData : readSlimRows(workerData.database)
const gz = new Uint8Array(await gzipJson(bakeSnapshot(rows)))
parentPort!.postMessage({ gz, count: rows.length }, [gz.buffer])
