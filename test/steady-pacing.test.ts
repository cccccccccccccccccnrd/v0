import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { config } from '../config.ts'
import { controlledFetch, CrawlError } from '../network.ts'
import { openStore } from '../store.ts'
import { cfg, memory, temp, NOW, id, channel } from './helpers.ts'

const network = { rps: 20, timeout: 1000, searchRequestInterval: 150 }

test('search defaults to one actual request per minute and validates its independent interval', () => {
  assert.equal(config({}).searchRequestInterval, 60_000)
  assert.equal(config({ SEARCH_REQUEST_INTERVAL_SECONDS: '120' }).searchRequestInterval, 120_000)
  for (const value of ['0', '-1', '', 'NaN', '3601']) assert.throws(() => config({ SEARCH_REQUEST_INTERVAL_SECONDS: value }), /Invalid/)
})

test('concurrent searches are evenly spaced while independent RSS uses only the global gate', async (t) => {
  const store = memory(t), events: { path: string; time: number }[] = []
  const fetcher = controlledFetch(store, network, new AbortController().signal, async input => {
    events.push({ path: new URL(String(input)).pathname, time: performance.now() })
    return new Response('ok')
  })
  await fetcher('https://www.youtube.com/results?first=1')
  await Promise.all([fetcher('https://www.youtube.com/results?second=1'), fetcher('https://www.youtube.com/feeds/videos.xml')])
  assert.deepEqual(events.map(e => e.path), ['/results', '/feeds/videos.xml', '/results'])
  assert.ok(events[2].time - events[0].time >= 130)
  assert.ok(Number(store.meta('search_next_request_at')) > Date.now())
})

test('a new fetch instance cannot reset the persisted search request deadline', async (t) => {
  const store = memory(t), starts: number[] = []
  const transport: typeof fetch = async () => { starts.push(performance.now()); return new Response('ok') }
  await controlledFetch(store, network, new AbortController().signal, transport)('https://www.youtube.com/results')
  await controlledFetch(store, network, new AbortController().signal, transport)('https://www.youtube.com/results')
  assert.ok(starts[1] - starts[0] >= 130)
})

test('persisted search pacing gates only work that still needs search', (t) => {
  const file = join(temp(t), 'state.sqlite')
  let store = openStore(file, cfg)
  store.seed({ term: 'first', window: 'archive' }, NOW)
  store.setMeta('search_next_request_at', String(NOW + 60_000))
  store.close()
  store = openStore(file, cfg)
  t.after(() => store.close())
  store.channel(channel, NOW)
  store.enqueue({ id: id(), source: 'needs-search', queryKey: '' }, NOW)
  store.enqueue({ id: id(2), source: 'needs-rss', queryKey: '', candidate: { id: id(2), hint: 'zero', channelId: channel, seconds: 60 } }, NOW)
  const cached = store.claim(NOW)!
  assert.equal(cached.kind, 'verify')
  assert.equal(JSON.parse(cached.payload).id, id(2))
  store.finish(cached)
  const feed = store.claim(NOW)!
  assert.equal(feed.kind, 'channel')
  store.release(feed, NOW + 120_000)
  assert.equal(store.claim(NOW), undefined)
  assert.ok(store.summary(NOW).queue.every(row => row.ready === 0))
  assert.equal(store.claim(NOW + 60_000)?.kind, 'verify')
})

test('only one search-dependent task can hold a lease while healthy cached/RSS work continues', (t) => {
  const file = join(temp(t), 'state.sqlite'), a = openStore(file, cfg), b = openStore(file, cfg)
  t.after(() => { a.close(); b.close() })
  a.seed({ term: 'first', window: 'archive' }, NOW)
  a.seed({ term: 'second', window: 'archive' }, NOW)
  const search = a.claim(NOW)!
  a.enqueue({ id: id(), source: 'needs-search', queryKey: '' }, NOW)
  a.enqueue({ id: id(2), source: 'cached-card', queryKey: '', candidate: { id: id(2), hint: 'zero', channelId: channel, seconds: 60 } }, NOW)
  a.channel(channel, NOW)
  const verification = b.claim(NOW)!
  assert.equal(JSON.parse(verification.payload).id, id(2))
  assert.equal(b.claim(NOW)?.kind, 'channel')
  assert.equal(b.claim(NOW), undefined)
  a.finish(search)
  assert.equal(b.claim(NOW)?.kind, 'verify')
  assert.equal(b.claim(NOW), undefined, 'a verification needing search also owns the search slot')
})

test('idle exploration does not advance jobs while the search slot is busy', (t) => {
  const store = memory(t)
  store.seed({ term: 'active', window: 'archive' }, NOW)
  const active = store.claim(NOW)!
  store.seed({ term: 'later', window: 'archive' }, NOW)
  store.db.prepare("UPDATE tasks SET runs=1,due_at=? WHERE key!=?").run(NOW + 3_600_000, active.key)
  assert.equal(store.explore(NOW), false)
  store.finish(active)
  assert.equal(store.explore(NOW), true)
})

test('normal redirect pacing waits do not consume the HTTP timeout', async (t) => {
  const store = memory(t)
  let requests = 0
  const fetcher = controlledFetch(store, { ...network, timeout: 30 }, new AbortController().signal, async () => ++requests === 1
    ? new Response('', { status: 302, headers: { location: '/results?canonical=1' } }) : new Response('ok'))
  assert.equal(await (await fetcher('https://www.youtube.com/results')).text(), 'ok')
  assert.equal(requests, 2)
})

test('pacing never shortens source backoff or counts waiting as an HTTP request', async (t) => {
  const store = memory(t), until = Date.now() + 600_000
  store.setMeta('search_next_request_at', String(Date.now() + 100))
  store.pause(until, 'verification redirect', 'search')
  const fetcher = controlledFetch(store, network, new AbortController().signal, async () => { throw new Error('No transport call allowed') })
  await assert.rejects(fetcher('https://www.youtube.com/results'), error => error instanceof CrawlError && error.retryAt === until)
  assert.equal(store.meta('pause_search_reason'), 'verification redirect')
  assert.ok(!store.summary().today.some(row => row.name === 'requests'))
})

test('shutdown interrupts gentle pacing without sending a second search', async (t) => {
  const store = memory(t), controller = new AbortController()
  let requests = 0
  const fetcher = controlledFetch(store, { ...network, searchRequestInterval: 60_000 }, controller.signal, async () => { requests++; return new Response('ok') })
  await fetcher('https://www.youtube.com/results')
  const waiting = assert.rejects(fetcher('https://www.youtube.com/results'))
  controller.abort()
  await waiting
  assert.equal(requests, 1)
})
