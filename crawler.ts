import { readFile } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { DAY, MIN_AGE, log, type Config, type SearchSpec, type Candidate } from './config.ts'
import type { Store, Task, VerifyPayload } from './store.ts'
import { CrawlError, retryDelay, requestContext } from './network.ts'
import { PartialSearchError, type Provider } from './provider.ts'

export async function seedFile(store: Store, path: string | URL, now = Date.now()) {
  const terms = (await readFile(path, 'utf8')).split(/\r?\n/).map((v) => v.trim()).filter((v) => v && !v.startsWith('#'))
  let added = 0
  // A large word list must not fsync once per age-band job or leave a partial import.
  store.db.exec('BEGIN IMMEDIATE')
  try {
    for (const term of new Set(terms)) {
      for (const window of ['recent','older','archive'] as const) if (store.seed({ term, window }, now)) added++
    }
    store.db.exec('COMMIT')
    return added
  } catch (error) { store.db.exec('ROLLBACK'); throw error }
}
export function titleTerms(title: string) {
  const stop = new Set(['the','and','this','that','with','from','video','shorts','how','for','you','your','what','into','have','will'])
  return [...new Set(title.toLowerCase().match(/[\p{L}][\p{L}\p{N}_-]{2,30}/gu) || [])]
    .filter((v) => !stop.has(v)).slice(-2)
}
function nextSearch(task: Task, cfg: Config, added: number) {
  const productive = task.found > task.last_found
  return Math.min(7 * DAY, productive ? cfg.searchInterval / 2
    : cfg.searchInterval * (added ? 1 : 2 ** Math.min(task.empty_runs + 1, 5)))
}
export function enqueueCandidates(store: Store, items: Candidate[], source: string, queryKey: string, now = Date.now(), cycle = 0) {
  let added = 0
  let unknown = 0
  const offset = items.length ? cycle % items.length : 0
  const sorted = [...items.slice(offset), ...items.slice(0, offset)].sort((a,b) => Number(b.hint === 'zero') - Number(a.hint === 'zero'))
  // Feed capacity is reserved for explicit-zero hints and verified discoveries.
  const channels = new Set<string>()
  for (const item of sorted) {
    if (item.hint === 'zero' && item.channelId && channels.size < 3 && !channels.has(item.channelId)) {
      channels.add(item.channelId)
      if (store.channel(item.channelId, now, false, queryKey)) store.metric('channels_queued', 1, now)
    }
  }
  for (const item of sorted) if (item.hint === 'zero') store.saveHint(item, source, now)
  for (const item of sorted) {
    if (item.hint === 'positive') { store.remember(item.id, 'hint_nonzero', now); continue }
    if (item.hint === 'unknown' && unknown >= 1) continue
    const due = Math.max(now, (item.publishedAt ?? 0) + MIN_AGE)
    if (store.enqueue({ id: item.id, source, queryKey, candidate: item }, now, due, item.hint)) {
      added++
      if (item.hint === 'unknown') unknown++
    }
    if (added >= 40) break
  }
  store.metric('candidates_queued', added, now)
  return added
}
export async function executeTask(task: Task, store: Store, provider: Provider, cfg: Config, signal: AbortSignal) {
  const payload = JSON.parse(task.payload)
  signal.throwIfAborted()
  if (task.kind === 'verify') {
    const job = payload as VerifyPayload
    if (store.isVerified(job.id)) { store.measure('verification_already_archived', job.queryKey); store.finish(task); return }
    // A matured zero hint is archived (unverified) before the check, whatever the check finds.
    if (job.candidate?.id === job.id) store.saveHint(job.candidate, job.source)
    const result = await requestContext.run({ sourceKey: job.queryKey }, () => provider.verify(job.id, job.candidate))
    signal.throwIfAborted()
    if (!store.owns(task)) return
    store.metric('checks_' + result.status)
    store.measure('verification_' + (result.reason || result.status), job.queryKey)
    if (result.status === 'young' && result.retryAt) {
      store.release(task, result.retryAt + 60_000)
      return
    }
    if (result.status === 'zero' && result.record) {
      result.record.meta.q = job.source
      const saved = store.save(result.record, job.queryKey)
      if (saved) {
        log('zero_found', { id: job.id, title: result.record.title, query: job.source })
        store.channel(result.record.author.id, Date.now(), true, job.queryKey)
        for (const term of titleTerms(result.record.title)) store.seed({ term, window: 'older' }, Date.now(), job.queryKey)
      }
    }
    store.remember(job.id, result.status)
    store.finish(task)
  } else {
    if (task.kind === 'search' && store.taskCount('verify') >= cfg.maxPending * 0.9) {
      store.defer(task, Date.now() + 15 * 60_000)
      return
    }
    const source = task.kind === 'search' ? (payload as SearchSpec).term : 'channel:' + payload.id
    let items: Candidate[]
    if (task.kind === 'search') store.observeSource(task.key)
    try { items = await requestContext.run({ sourceKey: task.key }, () => task.kind === 'search'
      ? provider.search(payload as SearchSpec, task.runs) : provider.channel(payload.id)) }
    catch (error) {
      if (error instanceof PartialSearchError) {
        if (!signal.aborted && store.owns(task)) {
          const added = enqueueCandidates(store, error.candidates, source, task.key, Date.now(), task.runs)
          store.metric('partial_searches')
          log('search_partial', { candidates: error.candidates.length, queued: added })
        }
        throw error.cause
      }
      throw error
    }
    signal.throwIfAborted()
    if (!store.owns(task)) return
    const added = enqueueCandidates(store, items, source, task.key, Date.now(), task.runs)
    store.metric(task.kind + '_runs')
    const delay = task.kind === 'search' ? nextSearch(task, cfg, added)
      : task.found > task.last_found ? DAY / 4 : DAY / 2
    store.release(task, Date.now() + delay, added === 0)
    if (task.kind === 'channel' && added === 0) store.retireChannels()
    log(task.kind + '_complete', { source, window: payload.window, cycle: task.runs, results: items.length, queued: added, nextInSeconds: Math.round(delay / 1000) })
  }
}
export async function runWorkers(store: Store, provider: Provider, cfg: Config, outerSignal: AbortSignal) {
  const group = new AbortController()
  const signal = AbortSignal.any([outerSignal, group.signal])
  async function worker(index: number) {
    while (!signal.aborted) {
      const pause = Number(store.meta('pause_until') || 0)
      const task = pause > Date.now() ? undefined : store.claim()
      if (!task) {
        if (pause <= Date.now() && store.taskCount('verify') < cfg.maxPending * 0.9 && store.explore(Date.now(), cfg.pages)) continue
        await sleep(1000, undefined, { signal }).catch(() => {})
        continue
      }
      const heartbeat = setInterval(() => { store.renew(task) }, 30_000)
      heartbeat.unref()
      try {
        log('task_started', { worker: index, kind: task.kind, key: task.key })
        await executeTask(task, store, provider, cfg, signal)
        store.setMeta('failure_streak_' + task.kind, '0')
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (!signal.aborted && error instanceof CrawlError && error.status === 0 && error.retryAt > Date.now()) {
          store.defer(task, error.retryAt)
          continue
        }
        const next = signal.aborted ? Date.now() : Math.max(Date.now() + retryDelay(task.failures),
          error instanceof CrawlError ? error.retryAt : 0,
          task.kind === 'verify' && task.failures >= 4 ? Date.now() + DAY : 0)
        if (error instanceof CrawlError && ([403,429].includes(error.status) ||
          (error.scope !== 'all' && error.status < 500 && error.retryAt > 0))) store.pause(next, message, error.scope)
        if (signal.aborted) store.defer(task, next)
        else store.fail(task, next, message)
        if (!signal.aborted) {
          const scope = error instanceof CrawlError && error.scope !== 'all' ? error.scope : task.kind
          const key = 'failure_streak_' + scope
          const streak = Number(store.meta(key) || 0) + 1
          store.setMeta(key, String(streak))
          if (streak >= 5) store.pause(Date.now() + Math.min(3_600_000, 60_000 * 2 ** Math.min(streak - 5, 6)), 'Repeated crawler failures: ' + message, scope)
          store.metric('task_errors')
          store.measure('task_error_' + task.kind, task.kind === 'verify' ? JSON.parse(task.payload).queryKey : task.key)
          log('task_failed', { worker: index, kind: task.kind, error: message, retryAt: new Date(next).toISOString() })
        }
      } finally { clearInterval(heartbeat) }
    }
  }
  const workers = Array.from({ length: cfg.workers }, (_, i) => worker(i + 1))
  try { await Promise.all(workers) }
  catch (error) { group.abort(); await Promise.allSettled(workers); throw error }
}
