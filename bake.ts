// User request 2026-11-21: the dashboard's title topics, thumbnail looks and PCA are computed on the server once an hour
// ("server bakings every 1h") and served as one gzip file, instead of 60+ API pages and seconds of clustering in every browser.
// The browser loads /api/snapshot, then only the videos found since (via /api/videos) and places those on the baked clusters.
import { Worker } from 'node:worker_threads'
import { rename, stat, writeFile } from 'node:fs/promises'
import { gzip } from 'node:zlib'
import { promisify } from 'node:util'
import { log } from './config.ts'
// @ts-ignore plain browser module without type declarations
import * as coreModule from './public/core.js'
const core: any = coreModule

export const SNAPSHOT_VERSION = 1
export const TOPIC_KS = [8, 16, 24, 32, 48, 64]
const LOOK_K = 16

type Row = Record<string, any>

/** Only the fields the dashboard reads (buildDocs); descriptions, URLs and evidence details stay out of the file. */
export function slim(v: Row) {
  return {
    videoId: v.videoId, title: v.title, author: { name: v.author?.name, id: v.author?.id }, meta: { q: v.meta?.q },
    seconds: v.seconds, uploadDate: v.uploadDate, foundAt: v.foundAt, verification: v.verification,
    ...(v.evidence?.source === 'arranging/v1' ? { evidence: { source: v.evidence.source } } : {}), ...(v.look ? { look: v.look } : {})
  }
}

const round = (x: number, digits: number) => Number.isFinite(x) ? Number(x.toFixed(digits)) : 0

/** Rows newest first, as /api/videos pages them. Pure and deterministic for the same rows. */
export function bakeSnapshot(rows: Row[], now = Date.now()) {
  const videos = rows.map(slim)
  const { docs, idf } = core.buildDocs(videos)
  const topics: Record<string, { assign: number[]; labels: string[] }> = {}
  for (const k of TOPIC_KS) {
    const result = core.kmeans(docs, k)
    topics[k] = { assign: Array.from(result.assign as Int32Array), labels: core.uniqueLabels(core.clusterLabels(docs, result.assign, result.k, idf)) }
  }
  const looks = core.lookKmeans(docs, LOOK_K)
  const pca = core.pcaModel(docs)
  return {
    version: SNAPSHOT_VERSION, bakedAt: now, count: videos.length,
    // Newest row: the browser asks /api/videos for everything found after it.
    top: rows.length ? { time: rows[0].foundAt, id: rows[0].videoId } : null,
    videos, topics,
    look: { assign: Array.from(looks.assign as Int32Array), labels: core.uniqueLabels(looks.centroids.map(core.lookLabel)) },
    pca: { comps: pca.comps.map((c: Float64Array) => Array.from(c, (x) => round(x, 6))), mv: pca.mv, pcs: pca.pcs.flat().map((x: number) => round(x, 4)) }
  }
}

/** Runs in a worker thread so the hourly clustering never blocks the crawler or the HTTP server. */
export function bakeInWorker(rows: Row[], signal?: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./bake-worker.ts', import.meta.url), { workerData: rows, resourceLimits: { maxOldGenerationSizeMb: 256 } })
    worker.once('message', (data: Uint8Array) => resolve(Buffer.from(data.buffer, data.byteOffset, data.byteLength)))
    worker.once('error', reject)
    worker.once('exit', (code) => { if (code) reject(new Error('Bake worker exited with ' + code)) })
    // Shutdown does not wait for a running bake.
    signal?.addEventListener('abort', () => { void worker.terminate() }, { once: true })
  })
}

export const gzipJson = (value: unknown) => promisify(gzip)(JSON.stringify(value))

/**
 * Bakes on the clock: at every multiple of `interval` since the epoch, i.e. at :00 of every hour UTC for the default hour
 * (user request 2026-11-21). At start it bakes after `firstDelay` only when the file is missing or older than the current slot
 * (a restart at :30 keeps the :00 file). Writes atomically so the server never serves a half file.
 */
export function startBaking(readRows: () => Row[], file: string, interval: number, signal: AbortSignal, firstDelay = 30_000) {
  if (!interval) return Promise.resolve()
  return new Promise<void>((resolve) => {
    let timer: NodeJS.Timeout | undefined
    let running: Promise<void> | undefined
    const run = async () => {
      const started = Date.now()
      try {
        const rows = readRows().map(slim)
        const gz = await bakeInWorker(rows, signal)
        if (signal.aborted) return
        await writeFile(file + '.tmp', gz, { mode: 0o644 })
        await rename(file + '.tmp', file)
        log('snapshot_baked', { videos: rows.length, bytes: gz.length, ms: Date.now() - started })
      } catch (error) { if (!signal.aborted) log('snapshot_failed', { error: String(error) }) }
    }
    const untilSlot = () => interval - (Date.now() % interval)
    const schedule = (delay: number) => { timer = setTimeout(() => { running = run().finally(() => { running = undefined; if (!signal.aborted) schedule(untilSlot()) }) }, delay) }
    void stat(file).then((info) => info.mtimeMs, () => 0).then((mtime) => {
      if (!signal.aborted) schedule(mtime >= Date.now() - (Date.now() % interval) ? untilSlot() : firstDelay)
    })
    signal.addEventListener('abort', () => { clearTimeout(timer); void (running || Promise.resolve()).then(() => resolve()) }, { once: true })
  })
}
