import assert from 'node:assert/strict'
import { test } from 'node:test'
import { executeTask, runWorkers } from '../crawler.ts'
import { createProvider, parseFeed, type Provider } from '../provider.ts'
import { controlledFetch, CrawlError } from '../network.ts'
import { memory, cfg, NOW, id, channel, feedXml, searchResponse, htmlJSON, until } from './helpers.ts'

const card = () => ({ id: id(), hint: 'zero' as const, channelId: channel, seconds: 60 })
const cached = () => ({ ...parseFeed(feedXml(), channel, NOW)[0], seconds: 60 })

test('a failed later search slice preserves useful earlier candidates and the original failure', async (t) => {
  const store = memory(t)
  const failure = new CrawlError('HTTP429', 429, Date.now() + 600_000)
  let calls = 0
  const provider = await createProvider(async () => {
    if (++calls === 2) throw failure
    return new Response(htmlJSON('ytInitialData', searchResponse()))
  }, 2)
  store.seed({ term: 'term', window: 'archive' })
  const task = store.claim()!
  await assert.rejects(executeTask(task, store, provider, cfg, new AbortController().signal), error => error === failure)
  assert.equal(store.taskCount('verify'), 1)
  assert.equal(store.taskCount('channel'), 1)
  assert.equal(store.owns(task), true, 'the worker still handles original failure/backoff')
})

test('cancelled partial searches cannot enqueue stale results', async (t) => {
  const store = memory(t), controller = new AbortController()
  let calls = 0
  const provider = await createProvider(async () => {
    if (++calls === 2) { controller.abort(); throw controller.signal.reason }
    return new Response(htmlJSON('ytInitialData', searchResponse()))
  }, 2)
  store.seed({ term: 'term', window: 'archive' })
  await assert.rejects(executeTask(store.claim()!, store, provider, cfg, controller.signal))
  assert.equal(store.taskCount('verify'), 0)
})

test('cached search eligibility allows healthy RSS verification while search is paused', async (t) => {
  const store = memory(t), paths: string[] = []
  store.pause(Date.now() + 600_000, 'search cooling down', 'search')
  store.enqueue({ id: id(), source: 'cached', queryKey: '', candidate: card() })
  assert.equal(store.summary().queue.find(row => row.kind === 'verify')!.ready, 1)
  const task = store.claim()
  assert.ok(task)
  const provider = await createProvider(controlledFetch(store, cfg, new AbortController().signal, async input => {
    paths.push(new URL(String(input)).pathname)
    return new Response(feedXml())
  }), 1)
  await executeTask(task, store, provider, cfg, new AbortController().signal)
  assert.deepEqual(paths, ['/feeds/videos.xml'])
  assert.equal(store.page(10).length, 1)
})

test('already eligible cached RSS evidence needs no network while both sources are paused', async (t) => {
  const store = memory(t)
  store.pause(Date.now() + 600_000, 'search cooling down', 'search')
  store.pause(Date.now() + 600_000, 'RSS cooling down', 'channel')
  store.enqueue({ id: id(), source: 'cached', queryKey: '', candidate: cached() })
  const task = store.claim()
  assert.ok(task)
  const provider = await createProvider(async () => { throw new Error('Unexpected network request') }, 1)
  await executeTask(task, store, provider, cfg, new AbortController().signal)
  assert.equal(store.page(10).length, 1)
  assert.equal(store.page(10)[0].evidence.checkedAt, NOW, 'original observation time is preserved')
})

test('already-paused requests defer without manufacturing failures or overwriting the access-check reason', async (t) => {
  const store = memory(t), controller = new AbortController()
  store.seed({ term: 'first', window: 'archive' })
  store.seed({ term: 'second', window: 'archive' })
  let calls = 0
  store.setMeta('failure_streak_search', '1')
  const provider: Provider = {
    async search() {
      calls++
      store.pause(Date.now() + 600_000, 'verification redirect', 'search')
      throw new CrawlError('Source is cooling down', 0, Number(store.meta('pause_search_until')), 'search')
    },
    async channel() { return [] }, async verify(id) { return { id, status: 'unknown' } }
  }
  const running = runWorkers(store, provider, { ...cfg, workers: 2 }, controller.signal)
  try { await until(() => calls === 1 && Number(store.db.prepare('SELECT sum(locked_until) AS n FROM tasks').get()!.n) === 0) }
  finally { controller.abort(); await running }
  assert.equal(store.meta('pause_search_reason'), 'verification redirect')
  assert.equal(store.meta('failure_streak_search'), '1')
  assert.equal(store.db.prepare('SELECT sum(failures) AS n FROM tasks').get()!.n, 0)
})

test('missing dependencies, early RSS zeros and global/verification pauses still block claims', (t) => {
  for (const mode of ['missing-card','missing-feed','early-feed','global','verify']) {
    const store = memory(t)
    const candidate = mode === 'missing-card' ? { id: id(), hint: 'zero' as const } : mode === 'missing-feed' ? card() : cached()
    if (mode === 'early-feed' && 'feed' in candidate) candidate.publishedAt = NOW - 1000
    store.enqueue({ id: id(), source: 'cached', queryKey: '', candidate })
    store.pause(Date.now() + 600_000, 'paused', mode === 'global' ? 'all' : mode === 'verify' ? 'verify' : mode === 'missing-card' ? 'search' : 'channel')
    assert.equal(store.claim(), undefined, mode)
  }
})
