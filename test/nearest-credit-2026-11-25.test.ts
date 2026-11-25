// User decision 2026-11-25: a verified find credits the search that admitted its channel, not the seed at the lineage root.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { memory, video, NOW, channel } from './helpers.ts'

test('a find through a title-derived search credits that search, not its seed', (t) => {
  const store = memory(t)
  store.seed({ term: 'seedterm', window: 'archive' }, NOW)
  const key = (term: string) => String(store.db.prepare("SELECT key FROM tasks WHERE json_extract(payload,'$.term')=?").get(term)!.key)
  const seedKey = key('seedterm')
  const first = 'UC' + 'b'.repeat(22)
  store.channel(first, NOW, false, seedKey)
  // The title of a find through the first channel spawns a new search.
  store.seed({ term: 'titleterm', window: 'archive' }, NOW, 'channel:' + first)
  const titleKey = key('titleterm')
  store.channel(channel, NOW, false, titleKey)
  assert.equal(store.save(video(1), 'channel:' + channel, NOW), true)
  const yieldOf = (k: string) => Number(store.db.prepare('SELECT root_yield FROM tasks WHERE key=?').get(k)!.root_yield)
  assert.equal(yieldOf(titleKey), 1)
  assert.equal(yieldOf(seedKey), 0)
  // The lineage root still records the find for statistics.
  assert.equal(Number(store.db.prepare("SELECT sum(value) n FROM source_metrics WHERE key=? AND name='root_verified_zero'").get(seedKey)!.n), 1)
  // A direct find of a search credits the search itself.
  assert.equal(store.save(video(2), titleKey, NOW), true)
  assert.equal(yieldOf(titleKey), 2)
})
