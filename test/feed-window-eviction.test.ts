import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DAY } from '../src/config.ts'
import { createProvider, feedFloor, FEED_SIZE } from '../src/provider.ts'
import { executeTask } from '../src/crawler.ts'
import { join } from 'node:path'
import { openStore } from '../src/store.ts'
import { cfg, channel, id, memory, temp } from './helpers.ts'

function fullFeed(oldest: string) {
  const entries = Array.from({ length: FEED_SIZE }, (_, i) => `<entry><yt:videoId>${id(100 + i)}</yt:videoId><yt:channelId>${channel}</yt:channelId><title>t</title><published>${i === FEED_SIZE - 1 ? oldest : '2026-11-01T00:00:00Z'}</published><author><name>A</name></author><media:group><media:description></media:description><media:community><media:statistics views="3"/></media:community></media:group></entry>`)
  return `<feed><yt:channelId>${channel.slice(2)}</yt:channelId>${entries.join('')}</feed>`
}

test('only a full feed sets a floor, and every feed read reports it', async () => {
  assert.equal(feedFloor([{ id: id(1), hint: 'zero', publishedAt: 1 }]), undefined, 'a short feed lists everything')
  const floors: [string, number][] = []
  const provider = await createProvider(async () => new Response(fullFeed('2026-10-01T00:00:00Z')), 1, () => false, () => {}, (c, f) => floors.push([c, f]))
  const result = await provider.verify(id(1), { id: id(1), hint: 'zero', channelId: channel })
  assert.equal(result.reason, 'missing_rss_entry')
  assert.deepEqual(floors, [[channel, Date.parse('2026-10-01T00:00:00Z')]])
})

test('candidates past the feed window are not queued and queued ones finish without a request', async (t) => {
  const store = memory(t)
  const now = Date.parse('2026-11-14T00:00:00Z')
  const floor = Date.parse('2026-10-01T00:00:00Z')
  store.setFeedFloor(channel, floor, now)
  const old = { id: id(1), hint: 'zero' as const, channelId: channel, publishedAt: floor - DAY }
  assert.equal(store.enqueue({ id: id(1), source: 'q', queryKey: '', candidate: old }, now, now, 'zero'), false)
  assert.equal(store.outOfFeed({ id: id(2), hint: 'zero', channelId: channel, minAgeDays: 60 }, now), true, '"2 months ago" is certainly older')
  assert.equal(store.outOfFeed({ id: id(2), hint: 'zero', channelId: channel, minAgeDays: 7 }, now), false, 'a lower bound that could be newer is kept')
  assert.equal(store.outOfFeed({ id: id(2), hint: 'zero', channelId: channel, publishedAt: floor }, now), false)

  // A task queued before the floor was known.
  const fresh = memory(t)
  fresh.enqueue({ id: id(1), source: 'q', queryKey: '', candidate: old }, now, now, 'zero')
  fresh.setFeedFloor(channel, floor, now)
  let requests = 0
  const provider = { verify: async () => { requests++; throw new Error('no request expected') } } as never
  await executeTask(fresh.claim(Date.now())!, fresh, provider, cfg, new AbortController().signal)
  assert.equal(requests, 0)
  assert.equal(fresh.taskCount('verify'), 0)
})

test('the feed floor only moves forward', (t) => {
  const store = memory(t)
  store.setFeedFloor(channel, 200, 1)
  store.setFeedFloor(channel, 100, 2)
  assert.equal(store.outOfFeed({ id: id(1), hint: 'zero', channelId: channel, publishedAt: 150 }), true)
})

test('long-unproductive searches are retired for good; productive ones stay', (t) => {
  const store = memory(t)
  const now = Date.now()
  store.seed({ term: 'dead', window: 'older' }, now)
  store.seed({ term: 'young', window: 'older' }, now)
  store.seed({ term: 'rooted', window: 'older' }, now)
  store.seed({ term: 'direct', window: 'older' }, now)
  const key = (term: string) => store.db.prepare("SELECT key FROM tasks WHERE json_extract(payload,'$.term')=?").get(term)!.key as string
  store.db.prepare("UPDATE tasks SET runs=2,empty_runs=2 WHERE kind='search'").run()
  store.db.prepare("UPDATE tasks SET runs=1,empty_runs=1 WHERE key=?").run(key('young'))
  store.db.prepare("UPDATE tasks SET found=1 WHERE key=?").run(key('direct'))
  store.db.prepare("INSERT INTO source_metrics VALUES('2026-11-13',?,'root_verified_zero',1)").run(key('rooted'))
  assert.equal(store.retireSearches(now), 1)
  assert.equal(store.taskCount('search'), 3)
  assert.equal(store.seed({ term: 'Dead', window: 'older' }, now), false, 'a retired search is not re-added by the word list or a title')
  assert.equal(store.seed({ term: 'dead', window: 'recent' }, now), true, 'other windows of the same word are separate')
})

test('a feed 404 during verification is retried later; channel runs still read it as empty', async (t) => {
  const { CrawlError } = await import('../src/network.ts')
  const fetcher = async () => { throw new CrawlError('YouTube HTTP 404', 404, 0, 'channel') }
  const provider = await createProvider(fetcher as never, 1)
  const result = await provider.verify(id(1), { id: id(1), hint: 'zero', channelId: channel })
  assert.equal(result.reason, 'feed_unavailable')
  assert.ok(result.retryAt! > Date.now())
  assert.deepEqual(await provider.channel(channel), [])

  const store = memory(t)
  store.enqueue({ id: id(1), source: 'q', queryKey: '', candidate: { id: id(1), hint: 'zero', channelId: channel } }, Date.now(), Date.now(), 'zero')
  for (let attempt = 0; attempt < 4; attempt++) {
    store.db.prepare("UPDATE tasks SET due_at=0 WHERE kind='verify'").run()
    const task = store.claim()
    assert.ok(task, 'attempt ' + attempt)
    await executeTask(task, store, provider, cfg, new AbortController().signal)
  }
  assert.equal(store.taskCount('verify'), 0, 'after three retries the check gives up')
  assert.equal(store.db.prepare("SELECT value FROM metrics WHERE name='verify_feed_retry'").get()!.value, 3)
})

test('archive searches are never retired, and retired ones come back once', (t) => {
  const dir = temp(t)
  const file = join(dir, 'db.sqlite')
  let store = openStore(file, cfg)
  const now = Date.now()
  store.seed({ term: 'old', window: 'archive' }, now)
  store.db.prepare("UPDATE tasks SET runs=5,empty_runs=5 WHERE kind='search'").run()
  assert.equal(store.retireSearches(now), 0)
  store.db.prepare("INSERT INTO retired_searches VALUES('search:x','gone','archive',2,1),('search:y','dead','older',2,1)").run()
  store.db.prepare("DELETE FROM meta WHERE key='archive_searches_restored'").run()
  store.close()
  store = openStore(file, cfg)
  t.after(() => store.close())
  assert.equal(store.taskCount('search'), 2)
  assert.equal(JSON.parse(String(store.db.prepare("SELECT payload FROM tasks WHERE key='search:x'").get()!.payload)).term, 'gone')
  assert.deepEqual(store.db.prepare('SELECT key FROM retired_searches').all().map((r) => r.key), ['search:y'])
  store.db.prepare("INSERT INTO retired_searches VALUES('search:z','later','archive',2,1)").run()
  store.close()
  store = openStore(file, cfg)
  assert.equal(store.taskCount('search'), 2, 'the restore runs only once')
})
