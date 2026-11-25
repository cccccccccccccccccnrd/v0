import assert from 'node:assert/strict'
import { test } from 'node:test'
import { searchNodes } from '../src/page.ts'
import { candidate } from '../src/provider.ts'
import { enqueueCandidates } from '../src/crawler.ts'
import { DAY } from '../src/config.ts'
import { id, video, memory, NOW, channel, searchResponse, htmlJSON } from './helpers.ts'

test('zero-view hints at least a year old are archived immediately as unverified, then upgraded', (t) => {
  const store = memory(t)
  const items = [
    { id: id(1), hint: 'zero' as const, channelId: channel, seconds: 60, publishedAt: NOW - 366 * DAY, title: 'Old', author: 'Author' },
    { id: id(2), hint: 'positive' as const, channelId: channel, publishedAt: NOW - 370 * DAY },
    { id: id(3), hint: 'unknown' as const, channelId: channel, publishedAt: NOW - 370 * DAY },
    { id: id(4), hint: 'zero' as const, channelId: channel, publishedAt: NOW - 364 * DAY, title: 'Too young' },
    { id: id(5), hint: 'zero' as const, channelId: channel, minAgeDays: 365, title: 'Search label: at least 365 days' },
    { id: id(6), hint: 'zero' as const, channelId: channel, minAgeDays: 364, title: 'Search label: at least 364 days' },
    { id: id(7), hint: 'zero' as const, channelId: channel, title: 'No age known' }
  ]
  enqueueCandidates(store, items, 'q', '', NOW)
  const rows = store.page(10)
  assert.deepEqual(rows.map((v) => [v.videoId, v.verification]).sort(), [[id(1), 'hint'], [id(5), 'hint']])
  const old = rows.find((v) => v.videoId === id(1))!
  assert.equal(old.title, 'Old')
  assert.equal(old.timestamp, '1:00')
  assert.equal(old.evidence.source, 'youtube/hint')
  assert.equal(store.isVerified(id(1)), false)
  // Background verification stays queued and can upgrade the same row.
  assert.ok(store.db.prepare('SELECT 1 FROM tasks WHERE key=?').get('verify:' + id(1)))
  assert.equal(store.save(video(1), '', NOW + 1), true)
  assert.equal(store.page(10).find((v) => v.videoId === id(1))?.verification, 'verified')
  // Repeat hints do not duplicate or downgrade.
  enqueueCandidates(store, items, 'q', '', NOW + 2)
  assert.equal(store.page(10).length, 2)
  assert.equal(store.page(10).find((v) => v.videoId === id(1))?.verification, 'verified')
})

test('search cards carry a title and a conservative age for hint records', () => {
  const html = htmlJSON('ytInitialData', searchResponse(1))
  const card = searchNodes(html).map(candidate).find(Boolean)
  assert.equal(card?.hint, 'zero')
  assert.equal(card?.title, 'A test video')
  assert.ok((card?.minAgeDays ?? 0) >= 7)
})

test('a matured zero candidate is archived as a hint when its check runs, even if verification fails', async (t) => {
  const { executeTask } = await import('../src/crawler.ts')
  const { cfg } = await import('./helpers.ts')
  const store = memory(t)
  const card = { id: id(1), hint: 'zero' as const, channelId: channel, seconds: 60, publishedAt: Date.now() - 366 * DAY, title: 'Matured' }
  store.enqueue({ id: id(1), source: 'q', queryKey: '', candidate: card }, Date.now(), Date.now(), 'zero')
  const provider = { search: async () => [], channel: async () => [], player: async () => ({ id: id(1), status: 'unknown' as const }),
    verify: async () => ({ id: id(1), status: 'unknown' as const, reason: 'missing_rss_entry' as const }) }
  await executeTask(store.claim()!, store, provider, cfg, new AbortController().signal)
  assert.deepEqual(store.page(10).map((v) => [v.videoId, v.verification]), [[id(1), 'hint']])
})

test('search claims split about 75/20/5 between archive, older and recent', (t) => {
  const store = memory(t)
  for (let n = 0; n < 40; n++) for (const window of ['recent', 'older', 'archive'] as const) store.seed({ term: 't' + n, window }, NOW)
  const counts: Record<string, number> = { recent: 0, older: 0, archive: 0 }
  for (let i = 0; i < 40; i++) {
    const task = store.claim(NOW)!
    assert.equal(task.kind, 'search')
    counts[JSON.parse(task.payload).window]++
    store.release(task, NOW + 365 * DAY)
  }
  assert.deepEqual(counts, { archive: 30, older: 8, recent: 2 })
})
