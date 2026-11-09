import assert from 'node:assert/strict'
import { test } from 'node:test'
import { searchNodes } from '../page.ts'
import { candidate } from '../provider.ts'
import { enqueueCandidates } from '../crawler.ts'
import { DAY } from '../config.ts'
import { id, video, memory, NOW, channel, searchResponse, htmlJSON } from './helpers.ts'

test('zero-view hints at least seven days old are archived immediately as unverified, then upgraded', (t) => {
  const store = memory(t)
  const items = [
    { id: id(1), hint: 'zero' as const, channelId: channel, seconds: 60, publishedAt: NOW - 8 * DAY, title: 'Old', author: 'Author' },
    { id: id(2), hint: 'positive' as const, channelId: channel, publishedAt: NOW - 30 * DAY },
    { id: id(3), hint: 'unknown' as const, channelId: channel, publishedAt: NOW - 30 * DAY },
    { id: id(4), hint: 'zero' as const, channelId: channel, publishedAt: NOW - 6 * DAY, title: 'Too young' },
    { id: id(5), hint: 'zero' as const, channelId: channel, minAgeDays: 7, title: 'Search label 8 days ago' },
    { id: id(6), hint: 'zero' as const, channelId: channel, minAgeDays: 6, title: 'Search label 7 days ago' },
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

test('backfill archives only queued zero candidates that are already seven days old', (t) => {
  const store = memory(t)
  const old = { id: id(1), hint: 'zero' as const, channelId: channel, seconds: 90, publishedAt: NOW - 10 * DAY, title: 'Waiting' }
  const young = { id: id(2), hint: 'zero' as const, channelId: channel, seconds: 90, publishedAt: NOW - 2 * DAY, title: 'Young' }
  store.enqueue({ id: id(1), source: 'q', queryKey: '', candidate: old }, NOW - 20 * DAY, NOW, 'zero')
  store.enqueue({ id: id(2), source: 'q', queryKey: '', candidate: young }, NOW - 20 * DAY, NOW + 5 * DAY, 'zero')
  assert.deepEqual(store.backfillHints(NOW), { added: 1 })
  assert.deepEqual(store.backfillHints(NOW), { added: 0 })
  assert.deepEqual(store.page(10).map((v) => [v.videoId, v.verification, v.title]), [[id(1), 'hint', 'Waiting']])
  assert.ok(store.db.prepare('SELECT 1 FROM tasks WHERE key=?').get('verify:' + id(1)))
  // Once matured, the young one is archived when its verification task runs (or by a later backfill).
  assert.deepEqual(store.backfillHints(NOW + 5 * DAY), { added: 1 })
})

test('a matured zero candidate is archived as a hint when its check runs, even if verification fails', async (t) => {
  const { executeTask } = await import('../crawler.ts')
  const { cfg } = await import('./helpers.ts')
  const store = memory(t)
  const card = { id: id(1), hint: 'zero' as const, channelId: channel, seconds: 60, publishedAt: Date.now() - 8 * DAY, title: 'Matured' }
  store.enqueue({ id: id(1), source: 'q', queryKey: '', candidate: card }, Date.now(), Date.now(), 'zero')
  const provider = { search: async () => [], channel: async () => [],
    verify: async () => ({ id: id(1), status: 'unknown' as const, reason: 'missing_rss_entry' as const }) }
  await executeTask(store.claim()!, store, provider, cfg, new AbortController().signal)
  assert.deepEqual(store.page(10).map((v) => [v.videoId, v.verification]), [[id(1), 'hint']])
})

test('search claims favour older upload windows about 50/35/15 without starving recent', (t) => {
  const store = memory(t)
  for (let n = 0; n < 40; n++) for (const window of ['recent', 'older', 'archive'] as const) store.seed({ term: 't' + n, window }, NOW)
  const counts: Record<string, number> = { recent: 0, older: 0, archive: 0 }
  for (let i = 0; i < 40; i++) {
    const task = store.claim(NOW)!
    assert.equal(task.kind, 'search')
    counts[JSON.parse(task.payload).window]++
    store.release(task, NOW + 365 * DAY)
  }
  assert.deepEqual(counts, { archive: 20, older: 14, recent: 6 })
})
