import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DAY } from '../config.ts'
import { executeTask } from '../crawler.ts'
import { controlledFetch, CrawlError } from '../network.ts'
import { createProvider } from '../provider.ts'
import { cfg, channel, htmlJSON, id, memory, raw, video } from './helpers.ts'

const on = { ...cfg, playerFallback: true, playerRequestInterval: 120_000 }
const card = (n = 1) => ({ id: id(n), hint: 'zero' as const, channelId: channel, seconds: 60, publishedAt: Date.parse('2020-01-01'), title: 'T' })
function fake(rss: object, player: () => Promise<any> = async () => ({ id: id(1), status: 'zero', record: video(1, Date.now()) })) {
  const calls = { verify: 0, player: 0 }
  return { calls, provider: { search: async () => [], channel: async () => [],
    verify: async () => { calls.verify++; return { id: id(1), ...rss } as any },
    player: async () => { calls.player++; return player() } } }
}

test('a matured zero that RSS cannot prove is verified from the watch page', async (t) => {
  const store = memory(t)
  store.enqueue({ id: id(1), source: 'q', queryKey: '', candidate: card() }, Date.now(), Date.now(), 'zero')
  const { calls, provider } = fake({ status: 'unknown', reason: 'missing_rss_entry' })
  await executeTask(store.claim()!, store, provider as any, on, new AbortController().signal)
  assert.deepEqual(calls, { verify: 1, player: 1 })
  const [row] = store.page(10)
  assert.equal(row.verification, 'verified')
  assert.equal(row.evidence.source, 'innertube/player')
  assert.equal(store.taskCount('verify'), 0)
})

test('the fallback is off unless enabled and never runs for proven RSS results', async (t) => {
  for (const [settings, rss] of [[cfg, { status: 'unknown', reason: 'missing_rss_entry' }], [on, { status: 'nonzero', reason: 'positive_count' }]] as const) {
    const store = memory(t)
    store.enqueue({ id: id(1), source: 'q', queryKey: '', candidate: card() }, Date.now(), Date.now(), 'zero')
    const { calls, provider } = fake(rss)
    await executeTask(store.claim()!, store, provider as any, settings, new AbortController().signal)
    assert.equal(calls.player, 0)
  }
})

test('watch-page checks are paced: a busy slot defers the task without another RSS request', async (t) => {
  const store = memory(t)
  for (const n of [1, 2]) store.enqueue({ id: id(n), source: 'q', queryKey: '', candidate: card(n) }, Date.now(), Date.now(), 'zero')
  const { calls, provider } = fake({ status: 'unknown', reason: 'missing_card' })
  await executeTask(store.claim()!, store, provider as any, on, new AbortController().signal)
  await executeTask(store.claim()!, store, provider as any, on, new AbortController().signal)
  assert.deepEqual(calls, { verify: 2, player: 1 })
  const waiting = store.db.prepare("SELECT payload,due_at FROM tasks WHERE kind='verify'").get() as any
  assert.equal(JSON.parse(waiting.payload).player, true)
  assert.ok(waiting.due_at >= Date.now() + 119_000)
  // When due, a deferred task goes straight to the watch page.
  store.setMeta('player_next_request_at', '0')
  store.db.prepare("UPDATE tasks SET due_at=0").run()
  await executeTask(store.claim()!, store, provider as any, on, new AbortController().signal)
  assert.deepEqual(calls, { verify: 2, player: 2 })
})

test('a watch-page bot check or refusal stops only the fallback, for a day', async (t) => {
  const store = memory(t)
  const bot = { ...raw(1), playabilityStatus: { status: 'LOGIN_REQUIRED', reason: "Sign in to confirm you're not a bot" } }
  const provider = await createProvider(controlledFetch(store, { rps: 20, timeout: 1000 }, new AbortController().signal,
    async () => new Response(htmlJSON('ytInitialPlayerResponse', bot))), 1)
  await assert.rejects(provider.player(id(1)), (e: CrawlError) => e.scope === 'player' && e.retryAt > Date.now() + DAY - 60_000)
  const refused = memory(t)
  const blocked = await createProvider(controlledFetch(refused, { rps: 20, timeout: 1000 }, new AbortController().signal,
    async () => new Response('', { status: 429 })), 1)
  await assert.rejects(blocked.player(id(1)), (e: CrawlError) => e.scope === 'player')
  assert.ok(Number(refused.meta('pause_player_until')) > Date.now() + DAY - 60_000)
  assert.equal(refused.meta('pause_until'), undefined, 'search and RSS keep running')
  assert.ok(refused.playerSlot(120_000) > Date.now())
})
