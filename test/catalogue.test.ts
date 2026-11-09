import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createProvider, parseFeed } from '../provider.ts'
import { controlledFetch, CrawlError } from '../network.ts'
import { executeTask } from '../crawler.ts'
import { memory, cfg, NOW, channel, id, video, feedXml, searchResponse, htmlJSON } from './helpers.ts'

function catalogue(owner = channel, views = 'No views') {
  return htmlJSON('ytInitialData', { ...searchResponse(1, views), metadata: { channelMetadataRenderer: { externalId: owner } } })
}

test('RSS plus a matching public channel catalogue archives without an individual search', async (t) => {
  const store = memory(t), paths: string[] = []
  store.pause(Date.now() + 600_000, 'search unavailable', 'search')
  const provider = await createProvider(controlledFetch(store, { rps: 20, timeout: 1000 }, new AbortController().signal, async input => {
    const path = new URL(String(input)).pathname
    paths.push(path)
    return new Response(path.includes('/feeds/') ? feedXml() : catalogue())
  }), 1)
  store.channel(channel)
  await executeTask(store.claim()!, store, provider, cfg, new AbortController().signal)
  const check = store.claim()
  assert.ok(check)
  assert.equal(check.kind, 'verify')
  await executeTask(check, store, provider, cfg, new AbortController().signal)
  assert.equal(store.page(10).length, 1)
  assert.equal(store.page(10)[0].evidence.source, 'youtube/rss')
  assert.deepEqual(paths, ['/feeds/videos.xml', '/channel/' + channel + '/videos'])
})

test('fifteen matching videos use two HTTP requests rather than fifteen individual metadata searches', async (t) => {
  const store = memory(t)
  store.pause(Date.now() + 600_000, 'search unavailable', 'search')
  const response = searchResponse()
  response.contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer.contents[0].itemSectionRenderer.contents = Array.from({ length: 15 }, (_, index) =>
    searchResponse(index + 1).contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer.contents[0].itemSectionRenderer.contents[0])
  const page = htmlJSON('ytInitialData', { ...response, metadata: { channelMetadataRenderer: { externalId: channel } } })
  const entries = Array.from({ length: 15 }, (_, index) => feedXml(index + 1).match(/<entry>[\s\S]*<\/entry>/)![0]).join('')
  const xml = feedXml().replace(/<entry>[\s\S]*<\/entry>/, entries)
  let requests = 0
  const provider = await createProvider(async input => { requests++; return new Response(String(input).includes('/feeds/') ? xml : page) }, 1)
  store.channel(channel)
  await executeTask(store.claim()!, store, provider, cfg, new AbortController().signal)
  store.pause(Date.now() + 600_000, 'RSS now paused', 'channel')
  for (let count = 0; count < 15; count++) {
    const task = store.claim()
    assert.equal(task?.kind, 'verify')
    await executeTask(task!, store, provider, cfg, new AbortController().signal)
  }
  assert.equal(requests, 2)
  assert.equal(store.page(20).length, 15)
})

test('mismatched catalogue ownership and contradictory positive counts never qualify', async () => {
  for (const mode of ['mismatch','positive']) {
    const provider = await createProvider(async input => new Response(String(input).includes('/feeds/') ? feedXml()
      : catalogue(mode === 'mismatch' ? 'UC' + 'b'.repeat(22) : channel, mode === 'positive' ? '1 view' : 'No views')), 1)
    const items = await provider.channel(channel)
    if (mode === 'mismatch') assert.equal(items[0].seconds, undefined, 'unbound catalogue cannot supply eligibility')
    else assert.equal((await provider.verify(id(), items[0])).status, 'nonzero')
  }
})

test('already archived numeric-zero entries do not spend another catalogue request', async (t) => {
  const store = memory(t)
  store.save(video(), '')
  let requests = 0
  const provider = await createProvider(async () => { requests++; return new Response(feedXml()) }, 1, store.isVerified)
  const items = await provider.channel(channel)
  assert.equal(items[0].hint, 'zero')
  assert.equal(requests, 1)
  assert.equal(store.page(10).length, 1)
})

test('no catalogue request is spent on feeds without numeric-zero observations', async () => {
  let calls = 0
  const provider = await createProvider(async () => { calls++; return new Response(feedXml(1, null)) }, 1)
  assert.equal((await provider.channel(channel))[0].hint, 'unknown')
  assert.equal(calls, 1)
})

test('fresh complete RSS/catalogue evidence can replace unknown cache but not contradictory positives', (t) => {
  const context = { ...parseFeed(feedXml(), channel, NOW + 1000)[0], seconds: 60 }
  const store = memory(t)
  store.remember(id(), 'unknown', NOW)
  assert.equal(store.enqueue({ id: id(), source: 'feed', queryKey: '', candidate: context }, NOW + 1000), true)
  const positive = memory(t)
  positive.remember(id(), 'hint_nonzero', NOW)
  assert.equal(positive.enqueue({ id: id(), source: 'feed', queryKey: '', candidate: context }, NOW + 1000), false)
})

test('complete batch evidence upgrades an unleased queued job without replacing provenance or its lease', (t) => {
  const store = memory(t, { ...cfg, maxPending: 1 })
  const feed = parseFeed(feedXml(), channel, NOW)[0]
  store.enqueue({ id: id(), source: 'original', queryKey: 'original-key', candidate: feed }, NOW)
  const complete = { ...parseFeed(feedXml(), channel, NOW + 1000)[0], seconds: 60 }
  assert.equal(store.enqueue({ id: id(), source: 'batch', queryKey: 'new-key', candidate: complete }, NOW + 1000), true)
  assert.equal(store.taskCount('verify'), 1)
  const task = store.claim(NOW + 1000)!
  const payload = JSON.parse(task.payload)
  assert.equal(payload.source, 'original')
  assert.equal(payload.queryKey, 'original-key')
  assert.equal(payload.candidate.seconds, 60)
  assert.equal(store.enqueue({ id: id(), source: 'batch', queryKey: 'new-key', candidate: { ...complete, seconds: 90 } }, NOW + 2000), false)
  assert.equal(store.owns(task), true)
  assert.equal(JSON.parse(String(store.db.prepare('SELECT payload FROM tasks WHERE id=?').get(task.id)!.payload)).candidate.seconds, 60)
})

test('upgrading an expired job invalidates its old lease before it can discard the fresh evidence', (t) => {
  const store = memory(t)
  store.enqueue({ id: id(), source: 'old', queryKey: '', candidate: parseFeed(feedXml(), channel, NOW)[0] }, NOW)
  const stale = store.claim(NOW)!
  const later = NOW + 121_000
  const complete = { ...parseFeed(feedXml(), channel, later)[0], seconds: 60 }
  assert.equal(store.enqueue({ id: id(), source: 'new', queryKey: '', candidate: complete }, later), true)
  assert.equal(store.owns(stale), false)
  assert.equal(store.claim(later)?.kind, 'verify')
})

test('catalogue cooldowns do not starve independent RSS reads', async (t) => {
  const store = memory(t), paths: string[] = []
  const fetcher = controlledFetch(store, { rps: 20, timeout: 1000 }, new AbortController().signal, async input => {
    const path = new URL(String(input)).pathname
    paths.push(path)
    return path.includes('/feeds/') ? new Response(feedXml()) : new Response('', { status: 302, headers: { location: 'https://www.google.com/sorry/index?private=value' } })
  })
  await assert.rejects(fetcher('https://www.youtube.com/channel/' + channel + '/videos'), error => error instanceof CrawlError && error.scope === 'catalogue')
  assert.ok(Number(store.meta('pause_catalogue_until')) > Date.now())
  const provider = await createProvider(fetcher, 1)
  const entries = await provider.channel(channel)
  assert.equal(entries[0].feed!.rawValue, '0')
  assert.equal(entries[0].seconds, undefined)
  assert.equal(paths.filter(path => path.startsWith('/channel/')).length, 1, 'paused catalogue was not requested again')
  assert.equal(paths.filter(path => path.includes('/feeds/')).length, 1)
  assert.equal(store.meta('pause_channel_until'), undefined)
})

test('a real catalogue HTTP403 still pauses globally and is not treated as missing eligibility', async (t) => {
  const store = memory(t)
  const provider = await createProvider(controlledFetch(store, { rps: 20, timeout: 1000 }, new AbortController().signal,
    async input => String(input).includes('/feeds/') ? new Response(feedXml()) : new Response('', { status: 403 })), 1)
  await assert.rejects(provider.channel(channel), error => error instanceof CrawlError && error.status === 403)
  assert.ok(Number(store.meta('pause_until')) > Date.now())
})
