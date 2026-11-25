// User decision 2026-11-25: videos must be at least a year old; long waits for young uploads are not worth keeping.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { executeTask } from '../src/crawler.ts'
import { DAY, MIN_AGE, MIN_AGE_DAYS, WAIT_HORIZON, searchRange } from '../src/config.ts'
import { cfg, id, memory, channel } from './helpers.ts'

test('the minimum age is one year and the search windows start there', () => {
  assert.equal(MIN_AGE_DAYS, 365)
  assert.deepEqual(searchRange('recent'), [365, 395, 1])
  assert.deepEqual(searchRange('older'), [395, 730, 7])
  assert.equal(searchRange('archive')[0], 730)
})

test('maintenance drops checks that would wait beyond the horizon and keeps those due soon', (t) => {
  const store = memory(t), now = Date.now()
  const card = (n: number, publishedAt: number) => ({ id: id(n), hint: 'zero' as const, channelId: channel, publishedAt })
  // Queued under the old 21-day rule: due "now", but a year away under the new one.
  store.db.prepare("INSERT INTO tasks(key,kind,payload,priority,due_at) VALUES(?,?,?,?,?)").run('verify:' + id(1), 'verify', JSON.stringify({ id: id(1), source: 'q', queryKey: '', candidate: card(1, now - 30 * DAY) }), 10, now)
  store.db.prepare("INSERT INTO tasks(key,kind,payload,priority,due_at) VALUES(?,?,?,?,?)").run('verify:' + id(2), 'verify', JSON.stringify({ id: id(2), source: 'q', queryKey: '', candidate: card(2, now - MIN_AGE + 2 * DAY) }), 10, now)
  store.db.prepare("INSERT INTO tasks(key,kind,payload,priority,due_at) VALUES(?,?,?,?,?)").run('verify:' + id(3), 'verify', JSON.stringify({ id: id(3), source: 'q', queryKey: '' }), 10, now)
  store.maintain(DAY, now)
  assert.deepEqual(store.db.prepare("SELECT key FROM tasks WHERE kind='verify' ORDER BY key").all().map((r) => r.key), ['verify:' + id(2), 'verify:' + id(3)])
  assert.equal(store.db.prepare("SELECT value FROM metrics WHERE name='checks_young_dropped'").get()!.value, 1)
})

test('a check that finds the upload too young waits only within the horizon', async (t) => {
  const store = memory(t)
  const run = async (n: number, retryAt: number) => {
    store.enqueue({ id: id(n), source: 'q', queryKey: '' }, Date.now(), Date.now())
    const provider = { search: async () => [], channel: async () => [], player: async () => ({ id: id(n), status: 'unknown' as const }),
      verify: async () => ({ id: id(n), status: 'young' as const, reason: 'young' as const, retryAt }) }
    await executeTask(store.claim()!, store, provider, cfg, new AbortController().signal)
  }
  await run(1, Date.now() + 200 * DAY)
  assert.equal(store.db.prepare('SELECT 1 FROM tasks WHERE key=?').get('verify:' + id(1)), undefined, 'far from mature: dropped')
  await run(2, Date.now() + WAIT_HORIZON - DAY)
  assert.ok(Number(store.db.prepare('SELECT due_at FROM tasks WHERE key=?').get('verify:' + id(2))!.due_at) > Date.now() + WAIT_HORIZON - 2 * DAY, 'close to mature: waits')
})
