import { mkdir, statfs } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { config, log, MIN_AGE_DAYS } from './config.ts'
import { openStore } from './store.ts'
import { controlledFetch, retryDelay, requestContext } from './network.ts'
import { createProvider } from './provider.ts'
import { runWorkers, seedFile } from './crawler.ts'
import { createApp } from './server.ts'
import { runThumbs } from './thumbs.ts'
import { startBaking } from './bake.ts'

const cfg = config()
process.umask(0o077)
await mkdir(cfg.dataDir, { recursive: true })
const store = openStore(cfg.database, cfg)
while (store.retireChannels()) { /* Drain old unproductive source slots before admitting new ones. */ }
await seedFile(store, new URL('./seeds.txt', import.meta.url))
const controller = new AbortController()
const snapshotFile = resolve(cfg.dataDir, 'snapshot.json.gz')
const { server, stopping } = createApp(store, resolve(cfg.dataDir, 'analysis', 'map.json.gz'), snapshotFile)
store.setMeta('heartbeat', String(Date.now()))
const beat = setInterval(() => { store.setMeta('heartbeat', String(Date.now())) }, 15_000)
store.replenishLegacy()
async function checkStorage() {
  try {
    const disk = await statfs(cfg.dataDir)
    if (!controller.signal.aborted && disk.bavail * disk.bsize < 512 * 1024 ** 2) {
      store.pause(Date.now() + 3_600_000, 'Low disk space: less than 512 MiB free')
      log('low_disk', { freeBytes: disk.bavail * disk.bsize })
    }
  } catch (error) { log('storage_check_failed', { error: String(error) }) }
}
await checkStorage()
const stats = setInterval(() => { store.replenishLegacy(); log('status', store.summary()); void checkStorage() }, 60_000)
const maintenance = setInterval(() => {
  try { store.maintain(cfg.seenTtl) } catch (error) { log('maintenance_failed', { error: String(error) }) }
}, 3_600_000)
const fetcher = controlledFetch(store, cfg, controller.signal)
let ending: Promise<void> | undefined
async function crawl() {
  let failures = 0
  while (!controller.signal.aborted) {
    try {
      const provider = await createProvider(fetcher, cfg.pages, store.isVerified,
        name => store.measure(name, requestContext.getStore()?.sourceKey), (channelId, floor) => store.setFeedFloor(channelId, floor))
      log('crawler_ready', { workers: cfg.workers, requestsPerSecond: cfg.rps, searchRequestIntervalSeconds: cfg.searchRequestInterval / 1000, minAgeDays: MIN_AGE_DAYS,
        verification: cfg.playerFallback ? 'rss+public-search+player-fallback' : 'rss+public-search',
        ...(cfg.playerFallback ? { playerRequestIntervalSeconds: cfg.playerRequestInterval / 1000 } : {}) })
      await runWorkers(store, provider, cfg, controller.signal)
      return
    } catch (error) {
      if (controller.signal.aborted) return
      store.metric('crawler_errors')
      log('crawler_error', { error: String(error) })
      await sleep(retryDelay(failures++), undefined, { signal: controller.signal }).catch(() => {})
    }
  }
}
const workers = crawl()
const thumbJob = runThumbs(store, cfg, controller.signal).catch((error) => { log('thumbs_error', { error: String(error) }) })
// Whole archive, newest first, exactly as /api/videos pages it; the bake worker reads it from the database file itself.
const bakeJob = startBaking({ database: cfg.database }, snapshotFile, cfg.snapshotInterval, controller.signal)
function shutdown() {
  if (ending) return ending
  ending = (async () => {
    log('shutdown')
    stopping()
    controller.abort()
    clearInterval(beat); clearInterval(stats); clearInterval(maintenance)
    await Promise.allSettled([workers, thumbJob, bakeJob, new Promise<void>((resolve) => server.close(() => resolve()))])
    store.close()
  })()
  return ending
}
server.on('error', (error) => {
  log('server_error', { error: error.message })
  process.exitCode = 1
  void shutdown()
})
process.once('SIGINT', () => { void shutdown() })
process.once('SIGTERM', () => { void shutdown() })
server.listen(cfg.port, cfg.host, () => {
  log('listening', { url: `http://${cfg.host}:${cfg.port}`, dataDir: cfg.dataDir })
})
