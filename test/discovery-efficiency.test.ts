import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { createProvider } from '../provider.ts'
import { openStore } from '../store.ts'
import { MIN_AGE } from '../config.ts'
import { CrawlError } from '../network.ts'
import { cfg, memory, temp, NOW, channel, id, feedXml } from './helpers.ts'

test('cold searches explore every age band, weighted toward older uploads, instead of draining one band', (t) => {
  const store = memory(t)
  for (let n = 0; n < 100; n++) for (const window of ['recent', 'older', 'archive'] as const) store.seed({ term: 'term' + n, window }, NOW)
  const bands: Record<string, number> = {}
  for (let n = 0; n < 30; n++) {
    const task = store.claim(NOW)!
    const band = JSON.parse(task.payload).window
    bands[band] = (bands[band] || 0) + 1
    store.release(task, NOW + 86_400_000)
  }
  // User decision 2026-11-09: about 50% archive, 35% older, 15% recent.
  assert.deepEqual(bands, { archive: 15, older: 11, recent: 4 })
})

test('due searches with real verified yield outrank cold terms without shortening cooldowns', (t) => {
  const store = memory(t)
  store.seed({ term: 'cold', window: 'archive' }, NOW)
  store.seed({ term: 'productive', window: 'older' }, NOW)
  store.db.exec("UPDATE tasks SET found=3 WHERE json_extract(payload,'$.term')='productive'")
  const productive = store.claim(NOW)!
  assert.equal(JSON.parse(productive.payload).term, 'productive')
  store.release(productive, NOW + 86_400_000)
  const cold = store.claim(NOW)!
  assert.equal(JSON.parse(cold.payload).term, 'cold')
  store.release(cold, NOW + 86_400_000)
  assert.equal(store.claim(NOW), undefined)
  store.pause(NOW + 1000, 'existing denial', 'search')
  assert.equal(store.claim(NOW + 1), undefined)
})

test('existing search priorities upgrade without changing progress, failure state or deadlines', (t) => {
  const path = join(temp(t), 'queue.sqlite')
  const first = openStore(path, cfg)
  first.seed({ term: 'old', window: 'archive' }, NOW)
  first.db.exec("UPDATE tasks SET priority=12,runs=7,failures=2,last_error='existing denial',due_at=1799999999999")
  first.close()
  const second = openStore(path, cfg)
  t.after(() => second.close())
  const row = second.db.prepare('SELECT priority,runs,failures,last_error,due_at FROM tasks').get()!
  assert.deepEqual({ ...row }, { priority: 10, runs: 7, failures: 2, last_error: 'existing denial', due_at: 1799999999999 })
})

test('fifteen concurrent and sequential same-creator checks share one actual RSS request', async () => {
  const entries = Array.from({ length: 15 }, (_, n) => feedXml(n + 1).match(/<entry>[\s\S]*<\/entry>/)![0]).join('')
  let requests = 0
  const provider = await createProvider(async () => { requests++; return new Response(`<feed><yt:channelId>${channel}</yt:channelId>${entries}</feed>`) }, 1)
  const check = (n: number) => provider.verify(id(n), { id: id(n), hint: 'zero', channelId: channel, seconds: 60 })
  const first = await Promise.all(Array.from({ length: 4 }, (_, n) => check(n + 1)))
  const rest = []
  for (let n = 5; n <= 15; n++) rest.push(await check(n))
  assert.ok([...first, ...rest].every(result => result.status === 'zero' && result.record!.evidence.rawValue === '0'))
  assert.equal(requests, 1)
})

test('RSS reuse expires, never caches failures, and refreshes observations made before eligibility', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW })
  let requests = 0
  const published = new Date(NOW - MIN_AGE + 1000).toISOString()
  const provider = await createProvider(async () => { requests++; return new Response(feedXml(1, requests === 1 ? '0' : '5', published)) }, 1)
  const card = { id: id(), hint: 'zero' as const, channelId: channel, seconds: 60 }
  assert.equal((await provider.verify(id(), card)).status, 'young')
  t.mock.timers.tick(1001)
  assert.equal((await provider.verify(id(), { ...card, publishedAt: Date.parse(published) })).status, 'nonzero')
  assert.equal(requests, 2, 'a cached pre-cutoff zero must be refreshed even within the cache lifetime')
  t.mock.timers.tick(60_001)
  await provider.verify(id(), card)
  assert.equal(requests, 3)

  let attempts = 0
  const failing = await createProvider(async () => {
    if (++attempts === 1) throw new Error('temporary transport failure')
    return new Response(feedXml())
  }, 1)
  await assert.rejects(failing.verify(id(), card), /temporary transport failure/)
  assert.equal((await failing.verify(id(), card)).status, 'zero')
  assert.equal(attempts, 2)
})

test('coalesced missing feeds remain unknown for every waiter and are not cached', async () => {
  let requests = 0
  const provider = await createProvider(async () => { requests++; throw new CrawlError('HTTP 404', 404) }, 1)
  const card = { id: id(), hint: 'zero' as const, channelId: channel, seconds: 60 }
  const results = await Promise.all([provider.verify(id(), card), provider.verify(id(), card)])
  assert.ok(results.every(result => result.status === 'unknown'))
  assert.equal(requests, 1)
  assert.equal((await provider.verify(id(), card)).status, 'unknown')
  assert.equal(requests, 2)
})

test('RSS cache is channel-bound, capacity-bounded, and retains unknown rather than inventing zero', async () => {
  let requests = 0
  const provider = await createProvider(async () => { requests++; return new Response('<feed/>') }, 1)
  const channels = Array.from({ length: 65 }, (_, n) => 'UC' + String(n).padStart(22, 'a'))
  for (const creator of channels) await provider.channel(creator)
  await provider.channel(channels[0])
  assert.equal(requests, 66, 'the oldest of 65 creators has been evicted from the 64-entry cache')

  const unknown = await createProvider(async () => new Response(feedXml(1, null)), 1)
  const card = { id: id(), hint: 'zero' as const, channelId: channel, seconds: 60 }
  for (let n = 0; n < 2; n++) assert.equal((await unknown.verify(id(), card)).status, 'unknown')
})
