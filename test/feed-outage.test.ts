import assert from 'node:assert/strict'
import { test } from 'node:test'
import { controlledFetch, CrawlError, FEED_OUTAGE_CHANNELS } from '../src/network.ts'
import { memory } from './helpers.ts'

const feed = (n: number) => `https://www.youtube.com/feeds/videos.xml?channel_id=UC${String(n).padStart(22, 'a')}`

test('many different channels returning 404 in a row pause RSS; a 200 in between resets the count', async (t) => {
  const store = memory(t)
  let status = 404
  const fetcher = controlledFetch(store, { rps: 50, timeout: 1000 }, new AbortController().signal, async () => new Response('<feed/>', { status }))
  for (let n = 0; n < FEED_OUTAGE_CHANNELS - 1; n++) await assert.rejects(fetcher(feed(n)))
  status = 200
  await fetcher(feed(100))
  status = 404
  for (let n = 0; n < FEED_OUTAGE_CHANNELS - 1; n++) await assert.rejects(fetcher(feed(n)))
  assert.equal(store.meta('pause_channel_until'), undefined, 'a recent 200 means individual channels, not an outage')
  await assert.rejects(fetcher(feed(0)))
  assert.equal(store.meta('pause_channel_until'), undefined, 'the same channel twice does not count twice')
  await assert.rejects(fetcher(feed(FEED_OUTAGE_CHANNELS)))
  assert.ok(Number(store.meta('pause_channel_until')) > Date.now())
  assert.equal(store.meta('pause_until'), undefined, 'search is not paused')
  await assert.rejects(fetcher(feed(1)), (e: unknown) => e instanceof CrawlError && e.message === 'Source is cooling down')
  status = 200
  await fetcher('https://www.youtube.com/results?search_query=x')
})
