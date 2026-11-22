import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DAY } from '../src/config.ts'
import { createProvider } from '../src/provider.ts'
import { channel, feedXml, htmlJSON, id, memory, searchResponse } from './helpers.ts'

const catalogue = (views = 'No views') => htmlJSON('ytInitialData', { ...searchResponse(1, views), metadata: { channelMetadataRenderer: { externalId: channel } } })
function provider(feed: string, page = catalogue()) {
  const paths: string[] = []
  return { paths, ready: createProvider(async (input) => {
    const url = new URL(String(input))
    paths.push(url.pathname)
    return new Response(url.pathname.includes('/feeds/') ? feed : page)
  }, 1) }
}
const noDuration = { id: id(1), hint: 'zero' as const, channelId: channel }

test('a known channel without a duration is verified by RSS plus the channel page, with no search by ID', async () => {
  const p = provider(feedXml())
  const result = await (await p.ready).verify(id(1), noDuration)
  assert.equal(result.status, 'zero')
  assert.equal(result.record!.seconds, 60)
  assert.equal(result.record!.evidence.source, 'youtube/rss')
  assert.deepEqual(p.paths, ['/feeds/videos.xml', `/channel/${channel}/videos`])
})

test('an entry missing from RSS costs one feed request and nothing else', async () => {
  const p = provider(feedXml(2))
  assert.equal((await (await p.ready).verify(id(1), noDuration)).reason, 'missing_rss_entry')
  assert.deepEqual(p.paths, ['/feeds/videos.xml'])
})

test('the channel page can still veto a zero; without a duration an RSS zero is verified blank, with no search by ID', async () => {
  const positive = provider(feedXml(), catalogue('3 views'))
  assert.equal((await (await positive.ready).verify(id(1), noDuration)).status, 'nonzero')
  const blank = provider(feedXml(), htmlJSON('ytInitialData', searchResponse(1)))
  const result = await (await blank.ready).verify(id(1), noDuration)
  assert.equal(result.status, 'zero')
  assert.equal(result.record!.seconds, 0)
  assert.equal(result.record!.timestamp, '')
  assert.deepEqual(blank.paths, ['/feeds/videos.xml', `/channel/${channel}/videos`])
})

test('verify tasks with a known channel are not held back by search pacing', (t) => {
  const store = memory(t)
  store.setMeta('search_next_request_at', String(Date.now() + DAY))
  store.enqueue({ id: id(1), source: 'q', queryKey: '', candidate: noDuration }, Date.now(), Date.now(), 'zero')
  store.enqueue({ id: id(2), source: 'q', queryKey: '' }, Date.now(), Date.now(), 'unknown')
  const task = store.claim()
  assert.equal(task?.key, 'verify:' + id(1))
  assert.equal(store.claim(), undefined, 'a task that needs a search by ID still waits for the search slot')
})
