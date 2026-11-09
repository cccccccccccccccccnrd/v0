import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { DAY, MIN_AGE } from '../config.ts'
import { controlledFetch, requestContext, CrawlError } from '../network.ts'
import { createProvider, parseFeed } from '../provider.ts'
import { executeTask } from '../crawler.ts'
import { openStore } from '../store.ts'
import { cfg, memory, temp, NOW, channel, id, video, feedXml, htmlJSON, searchResponse } from './helpers.ts'

const network = { rps: 20, timeout: 1000 }
function count(store: ReturnType<typeof openStore>, name: string, key?: string) {
  return Number(key ? store.db.prepare('SELECT sum(value) n FROM source_metrics WHERE key=? AND name=?').get(key, name)!.n || 0
    : store.db.prepare('SELECT sum(value) n FROM metrics WHERE name=?').get(name)!.n || 0)
}

test('actual request purposes distinguish even ID-shaped keywords from metadata lookups', async t => {
  const store = memory(t)
  const fetcher = controlledFetch(store, network, new AbortController().signal, async input => {
    const url = new URL(String(input))
    if (url.pathname.includes('/feeds/')) return new Response(feedXml(2))
    return new Response(htmlJSON('ytInitialData', searchResponse(url.searchParams.get('search_query') === id(2) ? 2 : 1)))
  })
  const provider = await createProvider(fetcher, 1)
  await requestContext.run({ sourceKey: 'search:keyword' }, () => provider.search({ term: id(), window: 'older' }))
  assert.equal((await requestContext.run({ sourceKey: 'channel:creator' }, () => provider.verify(id(2)))).reason, 'verified')
  assert.equal(count(store, 'requests'), 3)
  assert.equal(count(store, 'requests_keyword', 'search:keyword'), 1)
  assert.equal(count(store, 'requests_metadata', 'channel:creator'), 1)
  assert.equal(count(store, 'requests_rss', 'channel:creator'), 1)
  assert.equal(count(store, 'response_keyword_200', 'search:keyword'), 1)
  assert.equal(count(store, 'feed_response_200', 'channel:' + channel), 1)
  assert.equal(requestContext.getStore(), undefined)
})

test('concurrent async contexts stay isolated and purpose counts include redirect hops and failures', async t => {
  const store = memory(t)
  let calls = 0
  const fetcher = controlledFetch(store, network, new AbortController().signal, async (_input, init) => {
    assert.equal(new Headers(init?.headers).has('x-purpose'), false)
    calls++
    if (calls === 1) return new Response('', { status: 302, headers: { location: '/results?canonical=1' } })
    if (requestContext.getStore()?.purpose === 'metadata') return new Response('', { status: 500 })
    return new Response('ok')
  })
  const a = requestContext.run({ sourceKey: 'search:a', purpose: 'keyword' }, () => fetcher('https://www.youtube.com/results'))
  const b = requestContext.run({ sourceKey: 'channel:b', purpose: 'metadata' }, () => fetcher('https://www.youtube.com/results'))
  const rejected = assert.rejects(b, error => error instanceof CrawlError && error.status === 500)
  await a
  await rejected
  assert.equal(count(store, 'requests_keyword', 'search:a'), 2)
  assert.equal(count(store, 'requests_metadata', 'channel:b'), 1)
  assert.equal(count(store, 'response_metadata_500', 'channel:b'), 1)
  assert.equal(count(store, 'response_keyword_302', 'search:a'), 1)
  assert.equal(count(store, 'requests'), 3)
  assert.equal(requestContext.getStore(), undefined)
})

test('cooldown waits do not become requests, while RSS reuse is counted separately', async t => {
  const store = memory(t)
  let calls = 0
  const fetcher = controlledFetch(store, network, new AbortController().signal, async () => { calls++; return new Response(feedXml()) })
  const provider = await createProvider(fetcher, 1, store.isVerified,
    name => store.measure(name, requestContext.getStore()?.sourceKey))
  const card = { id: id(), hint: 'zero' as const, channelId: channel, seconds: 60 }
  await requestContext.run({ sourceKey: 'search:root' }, () => Promise.all([provider.verify(id(), card), provider.verify(id(), card)]))
  assert.equal(calls, 1)
  assert.equal(count(store, 'requests_rss'), 1)
  assert.equal(count(store, 'rss_cache_miss'), 1)
  assert.equal(count(store, 'rss_cache_reuse', 'search:root'), 1)
  store.pause(Date.now() + DAY, 'existing denial', 'search')
  await assert.rejects(requestContext.run({ sourceKey: 'search:root', purpose: 'keyword' }, () => fetcher('https://www.youtube.com/results')))
  assert.equal(count(store, 'requests_keyword'), 0)
  assert.equal(count(store, 'requests'), 1)
})

test('verification reasons explain rejected evidence without changing qualification', async () => {
  const card = { id: id(), hint: 'zero' as const, channelId: channel, seconds: 60 }
  const cases = [
    { xml: feedXml(), card, reason: 'verified', status: 'zero' },
    { xml: feedXml(2), card, reason: 'missing_rss_entry', status: 'unknown' },
    { xml: feedXml(1, null), card, reason: 'missing_rss_evidence', status: 'unknown' },
    { xml: feedXml(1, '5'), card, reason: 'positive_count', status: 'nonzero' },
    { xml: feedXml(), card: { ...card, hint: 'positive' as const }, reason: 'positive_hint', status: 'nonzero' },
    { xml: feedXml(1, '0', new Date(Date.now() - DAY).toISOString()), card, reason: 'young', status: 'young' }
  ]
  for (const item of cases) {
    const provider = await createProvider(async () => new Response(item.xml), 1)
    const result = await provider.verify(id(), item.card)
    assert.equal(result.reason, item.reason)
    assert.equal(result.status, item.status)
    assert.equal(Boolean(result.record), result.status === 'zero')
  }
  const missing = await createProvider(async () => new Response(htmlJSON('ytInitialData', searchResponse(2))), 1)
  assert.equal((await missing.verify(id())).reason, 'missing_card')
})

test('first-touch root credit survives channel expansion, title learning and duplicate discoveries', t => {
  const store = memory(t)
  store.seed({ term: 'original', window: 'older' }, NOW)
  const root = store.claim(NOW)!
  store.channel(channel, NOW, false, root.key)
  store.seed({ term: 'learned', window: 'older' }, NOW, 'channel:' + channel)
  const learned = store.db.prepare("SELECT key FROM tasks WHERE json_extract(payload,'$.term')='learned'").get()!.key as string
  store.observeSource(learned, 'search:replacement', NOW + 1)
  const lineage = store.db.prepare('SELECT root_key,parent_key FROM source_lineage WHERE key=?').get(learned)!
  assert.equal(lineage.root_key, root.key)
  assert.equal(lineage.parent_key, 'channel:' + channel)
  const record = video()
  assert.equal(store.save(record, learned, NOW), true)
  assert.equal(store.save({ ...record, title: 'must not replace original' }, root.key, NOW + 1), false)
  assert.equal(count(store, 'root_verified_zero', root.key), 1)
  assert.equal(count(store, 'verified_zero', learned), 1)
  assert.equal(count(store, 'root_attributed_zero'), 1)
  assert.equal(store.db.prepare('SELECT found FROM tasks WHERE key=?').get(root.key)!.found, 0, 'measurement must not affect scheduler credit')
  assert.equal(store.page(1)[0].title, record.title)
})

test('legacy channel ancestry stays unknown and instrumentation initialization preserves existing data', t => {
  const file = join(temp(t), 'state.sqlite')
  const store = openStore(file, cfg)
  store.channel(channel, NOW)
  store.db.prepare('DELETE FROM source_lineage').run()
  store.pause(NOW + DAY, 'original cooldown', 'channel')
  store.setMeta('youtube_consent', 'private fixture')
  store.seed({ term: 'new descendant', window: 'older' }, NOW, 'channel:' + channel)
  const descendant = store.db.prepare("SELECT key FROM tasks WHERE json_extract(payload,'$.term')='new descendant'").get()!.key as string
  store.save(video(), descendant, NOW)
  assert.equal(count(store, 'root_unattributed_zero'), 1)
  const tables = ['tasks', 'videos', 'seen', 'retired_channels', 'metrics', 'counters', 'meta', 'source_lineage', 'source_metrics']
  const before = tables.map(table => store.db.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all())
  const started = store.meta('measurement_started_at')
  store.close()
  const reopened = openStore(file, cfg)
  t.after(() => reopened.close())
  assert.deepEqual(tables.map(table => reopened.db.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all()), before)
  assert.equal(reopened.meta('measurement_started_at'), started)
  assert.equal(reopened.meta('pause_channel_until'), String(NOW + DAY))
})

test('queue wait states distinguish age, schedules, pacing, backoff and active leases', t => {
  const store = memory(t)
  store.seed({ term: 'due', window: 'older' }, NOW)
  const young = parseFeed(feedXml(2, '0', new Date(NOW - DAY).toISOString()), channel, NOW)[0]
  store.enqueue({ id: id(2), source: 'young', queryKey: '', candidate: young }, NOW, NOW + MIN_AGE)
  store.channel(channel, NOW + DAY)
  const waits = () => Object.fromEntries<number>(store.summary(NOW).waits.map(row => [String(row.reason), Number(row.count)]))
  assert.deepEqual(waits(), { ready: 1, scheduled: 1, young: 1 })
  store.setMeta('search_next_request_at', String(NOW + 60_000))
  assert.equal(waits().search_pacing, 1)
  store.pause(NOW + DAY, 'search unavailable', 'search')
  assert.equal(waits().source_or_dependency, 1)
  store.pause(NOW + DAY, 'global unavailable')
  assert.equal(waits().global_backoff, 1)
  assert.equal(waits().young, 1)
  store.db.prepare("DELETE FROM meta WHERE key LIKE 'pause_%' OR key='search_next_request_at'").run()
  store.claim(NOW)
  assert.equal(waits().leased, 1)
  assert.equal(Object.values(waits()).reduce((a, b) => a + b, 0), 3)
})

test('crawler threads new channel/title ancestry and records verification outcomes end to end', async t => {
  const store = memory(t)
  const provider = await createProvider(async input => new Response(String(input).includes('/feeds/') ? feedXml()
    : htmlJSON('ytInitialData', searchResponse())), 1)
  store.seed({ term: 'starter', window: 'older' })
  const root = store.claim()!
  await executeTask(root, store, provider, cfg, new AbortController().signal)
  const verify = store.claim()!
  assert.equal(verify.kind, 'verify')
  await executeTask(verify, store, provider, cfg, new AbortController().signal)
  assert.equal(count(store, 'verification_verified', root.key), 1)
  const sources = store.db.prepare('SELECT * FROM source_lineage WHERE parent_key=?').all(root.key)
  assert.ok(sources.some(row => row.key === 'channel:' + channel))
  assert.ok(sources.some(row => String(row.key).startsWith('search:')))
  assert.ok(sources.every(row => row.root_key === root.key))
})

test('upgrade from a pre-measurement database is additive and preserves all prior rows', t => {
  const file = join(temp(t), 'old.sqlite')
  const old = openStore(file, cfg)
  old.seed({ term: 'before', window: 'recent' }, NOW)
  old.save(video(), '', NOW)
  old.pause(NOW + DAY, 'existing cooldown')
  old.setMeta('search_next_request_at', String(NOW + 60_000))
  old.db.exec("DROP TABLE source_lineage; DROP TABLE source_metrics; DELETE FROM meta WHERE key='measurement_started_at'")
  const tables = ['tasks', 'videos', 'seen', 'retired_channels', 'metrics', 'counters', 'meta']
  const before = tables.map(table => old.db.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all())
  old.close()
  const upgraded = openStore(file, cfg)
  t.after(() => upgraded.close())
  const after = tables.map(table => upgraded.db.prepare(`SELECT * FROM ${table} ${table === 'meta' ? "WHERE key!='measurement_started_at'" : ''} ORDER BY 1,2`).all())
  assert.deepEqual(after, before)
  assert.equal(upgraded.db.prepare('SELECT count(*) n FROM source_lineage').get()!.n, 0)
  assert.equal(upgraded.db.prepare('SELECT count(*) n FROM source_metrics').get()!.n, 0)
  assert.ok(Number(upgraded.meta('measurement_started_at')) > 0)
})

test('catalogue batches and repeated unavailable feeds have separate honest cost counters', async t => {
  const store = memory(t)
  const page = htmlJSON('ytInitialData', { ...searchResponse(), metadata: { channelMetadataRenderer: { externalId: channel } } })
  const fetcher = controlledFetch(store, network, new AbortController().signal, async input => new Response(String(input).includes('/feeds/') ? feedXml() : page))
  const provider = await createProvider(fetcher, 1)
  await requestContext.run({ sourceKey: 'channel:' + channel }, () => provider.channel(channel))
  assert.equal(count(store, 'requests_catalogue'), 1)
  assert.equal(count(store, 'requests_rss'), 1)
  assert.equal(count(store, 'requests_metadata'), 0)
  const missing = await createProvider(controlledFetch(store, network, new AbortController().signal,
    async () => new Response('', { status: 404 })), 1)
  await missing.channel(channel)
  await missing.channel(channel)
  assert.equal(count(store, 'response_rss_404'), 2)
  assert.equal(count(store, 'feed_response_404', 'channel:' + channel), 2)
  assert.equal(count(store, 'requests_rss'), 3, 'measurement must not suppress existing retries')
})

test('source measurement retention never expires lineage or the archive', t => {
  const store = memory(t)
  store.seed({ term: 'origin', window: 'older' }, NOW)
  const root = store.claim(NOW)!
  store.measure('requests_keyword', root.key, NOW - 100 * DAY)
  store.measure('requests_keyword', root.key, NOW)
  store.save(video(), root.key, NOW)
  store.maintain(DAY, NOW)
  assert.equal(count(store, 'requests_keyword', root.key), 1)
  assert.equal(store.db.prepare('SELECT count(*) n FROM source_lineage').get()!.n, 1)
  assert.equal(store.page(1).length, 1)
})
