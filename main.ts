import { mkdir, statfs } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { config, log } from './config.ts'
import { openStore } from './store.ts'
import { controlledFetch, retryDelay, requestContext } from './network.ts'
import { createProvider } from './provider.ts'
import { runWorkers, seedFile } from './crawler.ts'
import { createApp } from './server.ts'

const cfg = config()
process.umask(0o077)
await mkdir(cfg.dataDir, { recursive: true })
const store = openStore(cfg.database, cfg)
while (store.retireChannels()) { /* Drain old unproductive source slots before admitting new ones. */ }
await seedFile(store, new URL('./seeds.txt', import.meta.url))
const controller = new AbortController()
const { server, stopping } = createApp(store)
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
        name => store.measure(name, requestContext.getStore()?.sourceKey))
      log('crawler_ready', { workers: cfg.workers, requestsPerSecond: cfg.rps, searchRequestIntervalSeconds: cfg.searchRequestInterval / 1000, minAgeDays: 7, verification: 'rss+public-search' })
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
function shutdown() {
  if (ending) return ending
  ending = (async () => {
    log('shutdown')
    stopping()
    controller.abort()
    clearInterval(beat); clearInterval(stats); clearInterval(maintenance)
    await Promise.allSettled([workers, new Promise<void>((resolve) => server.close(() => resolve()))])
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
