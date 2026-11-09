import assert from 'node:assert/strict'
import { test } from 'node:test'
import { controlledFetch } from '../network.ts'
import { memory } from './helpers.ts'

test('transport diagnostics retain native error codes without altering the thrown error or cooldowns', async (t) => {
  const entries: Record<string, any>[] = []
  t.mock.method(console, 'log', (line: string) => entries.push(JSON.parse(line)))
  const store = memory(t)
  const native = Object.assign(new Error('private message'), { code: 'ECONNRESET', syscall: 'read' })
  const failure = new TypeError('fetch failed', { cause: native })
  const fetcher = controlledFetch(store, { rps: 1, timeout: 1000 }, new AbortController().signal, async () => { throw failure })
  await assert.rejects(fetcher('https://www.youtube.com/results?search_query=private-query'), error => error === failure)
  const entry = entries.find(value => value.event === 'network_error')
  assert.ok(entry)
  assert.equal(entry.source, 'search')
  assert.equal(entry.error.cause.code, 'ECONNRESET')
  assert.equal(entry.error.cause.syscall, 'read')
  assert.equal(entry.cancelled, false)
  assert.ok(entry.elapsedMs >= 0)
  assert.equal(store.meta('pause_until'), undefined)
  assert.equal(store.meta('pause_search_until'), undefined)
  assert.ok(!JSON.stringify(entry).includes('private'))
})

test('known redirect-limit rejection is distinguished without printing arbitrary native messages', async (t) => {
  const entries: Record<string, any>[] = []
  t.mock.method(console, 'log', (line: string) => entries.push(JSON.parse(line)))
  const failure = new TypeError('fetch failed', { cause: new Error('redirect count exceeded') })
  const fetcher = controlledFetch(memory(t), { rps: 1, timeout: 1000 }, new AbortController().signal, async () => { throw failure })
  await assert.rejects(fetcher('https://www.youtube.com/results'))
  assert.equal(entries.find(value => value.event === 'network_error')!.error.cause.reason, 'redirect_limit')
})

test('diagnostics bound aggregate/circular errors and exclude messages, addresses, headers and credentials', async (t) => {
  const entries: Record<string, any>[] = []
  t.mock.method(console, 'log', (line: string) => entries.push(JSON.parse(line)))
  const native = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET',
    socket: { remoteAddress: 'private-address' }, headers: { authorization: 'private-token' } })
  const failure = new AggregateError(Array(20).fill(native), 'private-message')
  failure.cause = failure
  const fetcher = controlledFetch(memory(t), { rps: 1, timeout: 1000 }, new AbortController().signal, async () => { throw failure })
  await assert.rejects(fetcher('https://www.youtube.com/results'))
  const entry = entries.find(value => value.event === 'network_error')!
  assert.equal(entry.error.errors.length, 4)
  assert.equal(entry.error.errors[0].reason, 'peer_closed')
  assert.ok(JSON.stringify(entry).length < 5000)
  assert.ok(!JSON.stringify(entry).includes('private'))
})
