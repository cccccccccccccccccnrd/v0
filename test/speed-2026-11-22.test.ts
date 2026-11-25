// User decision 2026-11-22: searches ranked by root yield with a 20% exploration share, and first-read catalogue hints.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { executeTask } from '../src/crawler.ts'
import { openStore } from '../src/store.ts'
import { cfg, id, video, memory, temp, NOW, channel } from './helpers.ts'

const searchKey = (store: ReturnType<typeof memory>, term: string) =>
  String(store.db.prepare("SELECT key FROM tasks WHERE json_extract(payload,'$.term')=?").get(term)!.key)

test('verified finds of a channel credit its root search, which is then claimed first and decays per run', (t) => {
  const store = memory(t)
  store.seed({ term: 'cold', window: 'archive' }, NOW)
  store.seed({ term: 'fruitful', window: 'archive' }, NOW)
  const root = searchKey(store, 'fruitful')
  // The channel was found by the search; its verified find counts for the search (root), not as a direct find.
  store.channel(channel, NOW, false, root)
  assert.equal(store.save(video(1), 'channel:' + channel, NOW), true)
  const row = () => store.db.prepare('SELECT root_yield,found FROM tasks WHERE key=?').get(root)!
  assert.equal(row().root_yield, 1)
  assert.equal(row().found, 0)
  store.db.exec("DELETE FROM tasks WHERE kind='channel'")
  const first = store.claim(NOW)!
  assert.equal(JSON.parse(first.payload).term, 'fruitful')
  store.release(first, NOW + 1000)
  assert.ok(Math.abs(Number(row().root_yield) - 0.9) < 1e-9)
  assert.equal(JSON.parse(store.claim(NOW)!.payload).term, 'cold')
})

test('every fifth search turn prefers a term that never ran over a productive one', (t) => {
  const store = memory(t)
  store.seed({ term: 'proven', window: 'archive' }, NOW)
  store.seed({ term: 'untried', window: 'archive' }, NOW)
  store.db.exec("UPDATE tasks SET runs=4,root_yield=5 WHERE json_extract(payload,'$.term')='proven'")
  store.setMeta('search_window_turn', '4') // turn 5 of the pattern: archive, explore
  assert.equal(JSON.parse(store.claim(NOW)!.payload).term, 'untried')
  store.db.exec("UPDATE tasks SET locked_until=0,token=''")
  store.setMeta('search_window_turn', '0') // ordinary archive turn
  assert.equal(JSON.parse(store.claim(NOW)!.payload).term, 'proven')
})

test("a channel's first read saves catalogue zero-view uploads beyond its feed as hints; later reads do not fetch it", async (t) => {
  const store = memory(t)
  store.channel(channel, NOW)
  let catalogueCalls = 0
  const provider = {
    search: async () => [], verify: async () => ({ id: id(1), status: 'unknown' as const }), player: async () => ({ id: id(1), status: 'unknown' as const }),
    channel: async () => [{ id: id(1), hint: 'zero' as const, channelId: channel }],
    catalogue: async () => {
      catalogueCalls++
      return [
        { id: id(1), hint: 'zero' as const, channelId: channel, minAgeDays: 400, title: 'Also in the feed' },
        { id: id(2), hint: 'zero' as const, channelId: channel, minAgeDays: 400, title: 'Old, beyond the feed' },
        { id: id(3), hint: 'zero' as const, channelId: channel, minAgeDays: 14, title: 'Too young' },
        { id: id(4), hint: 'positive' as const, channelId: channel, minAgeDays: 400, title: 'Has views' }
      ]
    }
  }
  const first = store.claim()!
  assert.equal(first.kind, 'channel')
  await executeTask(first, store, provider, cfg, new AbortController().signal)
  assert.equal(catalogueCalls, 1)
  const hints = store.page(10).map((v) => [v.videoId, v.verification, v.title])
  assert.deepEqual(hints, [[id(2), 'hint', 'Old, beyond the feed']])
  assert.equal(store.db.prepare("SELECT value FROM metrics WHERE name='catalogue_hints_saved'").get()!.value, 1)
  // No verification check is queued for a catalogue-only upload.
  assert.equal(store.db.prepare('SELECT 1 FROM tasks WHERE key=?').get('verify:' + id(2)), undefined)
  store.db.exec("DELETE FROM tasks WHERE kind='verify'; UPDATE tasks SET due_at=0 WHERE kind='channel'")
  const again = store.db.prepare("SELECT * FROM tasks WHERE kind='channel'").get()!
  assert.equal(again.runs, 1)
  const second = store.claim()!
  assert.equal(second.kind, 'channel')
  await executeTask(second, store, provider, cfg, new AbortController().signal)
  assert.equal(catalogueCalls, 1)
})

test('an older database gets the root_yield column, filled from the last seven days of root finds', (t) => {
  const file = join(temp(t), 'old.sqlite')
  const store = openStore(file, cfg)
  store.seed({ term: 'fruitful', window: 'older' }, NOW)
  store.seed({ term: 'quiet', window: 'older' }, NOW)
  const key = searchKey(store, 'fruitful')
  store.close()
  // Simulate the pre-2026-11-22 schema: no root_yield column, root finds only in source_metrics.
  const raw = new DatabaseSync(file)
  raw.exec('ALTER TABLE tasks DROP COLUMN root_yield')
  const today = new Date().toISOString().slice(0, 10), old = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10)
  raw.prepare("INSERT INTO source_metrics VALUES(?,?,'root_verified_zero',4)").run(today, key)
  raw.prepare("INSERT INTO source_metrics VALUES(?,?,'root_verified_zero',50)").run(old, key)
  raw.close()
  const reopened = openStore(file, cfg)
  t.after(() => reopened.close())
  assert.deepEqual(reopened.db.prepare("SELECT json_extract(payload,'$.term') term,root_yield FROM tasks ORDER BY term").all().map((r) => [r.term, r.root_yield]),
    [['fruitful', 4], ['quiet', 0]])
})

test('channel-page lockups: "No views", counts and ages come from accessibility labels', async () => {
  const { lockupLabels, withLabels } = await import('../src/provider.ts')
  const lockup = (contentId: string, views: string, age: string) => ({ lockupViewModel: { contentId, metadata: { lockupMetadataViewModel: { metadata: { contentMetadataViewModel: { metadataRows: [{ metadataParts: [
    { text: { content: views === 'No views' ? '0' : views.split(' ')[0] }, accessibilityLabel: views }, { text: { content: '2y ago' }, accessibilityLabel: age }] }] } } } } } })
  const raw = { contents: { items: [lockup(id(1), 'No views', '2 years ago'), lockup(id(2), '3 views', '5 months ago'), { other: lockup(id(3), '1,204 views', '3 weeks ago') }] } }
  const labels = lockupLabels(raw)
  assert.deepEqual(labels.get(id(1)), ['No views', '2 years ago'])
  const zero = withLabels({ id: id(1), hint: 'unknown' }, labels.get(id(1)))
  assert.equal(zero.hint, 'zero'); assert.equal(zero.minAgeDays, 365)
  const few = withLabels({ id: id(2), hint: 'unknown' }, labels.get(id(2)))
  assert.equal(few.hint, 'positive'); assert.equal(few.views, 3); assert.equal(few.minAgeDays, 112)
  const many = withLabels({ id: id(3), hint: 'unknown' }, labels.get(id(3)))
  assert.equal(many.hint, 'positive'); assert.equal(many.views, 1204); assert.equal(many.minAgeDays, 14)
  // Visible text wins; labels only fill gaps.
  assert.equal(withLabels({ id: id(1), hint: 'positive', minAgeDays: 30 }, labels.get(id(1))).hint, 'positive')
  assert.equal(withLabels({ id: id(1), hint: 'positive', minAgeDays: 30 }, labels.get(id(1))).minAgeDays, 30)
  assert.equal(withLabels({ id: id(4), hint: 'unknown' }).hint, 'unknown')
})
