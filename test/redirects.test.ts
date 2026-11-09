import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { controlledFetch, CrawlError } from '../network.ts'
import { memory } from './helpers.ts'

const cfg = { rps: 20, timeout: 1000 }

test('real native fetch cannot hide a local HTTP redirect loop or its request count', async (t) => {
  let requests = 0
  const server = createServer((req, res) => {
    requests++
    res.writeHead(302, { location: req.url! })
    res.end()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const store = memory(t)
  const fetcher = controlledFetch(store, cfg, new AbortController().signal)
  await assert.rejects(fetcher('http://127.0.0.1:' + address.port + '/loop'), error => error instanceof CrawlError && error.status === 508)
  assert.equal(requests, 1)
  assert.equal(store.summary().today.find(row => row.name === 'requests')!.value, 1)
})

test('redirect hops are manual, globally paced, counted and cancel discarded bodies', async (t) => {
  const store = memory(t), starts: number[] = []
  let cancelled = 0
  const transport: typeof fetch = async (_input, init) => {
    assert.equal(init?.redirect, 'manual')
    starts.push(performance.now())
    return starts.length === 1 ? new Response(new ReadableStream({ cancel() { cancelled++ } }),
      { status: 302, headers: { location: '/results?canonical=1' } }) : new Response('ok')
  }
  const fetcher = controlledFetch(store, cfg, new AbortController().signal, transport)
  const response = await fetcher('https://www.youtube.com/results')
  assert.equal(await response.text(), 'ok')
  assert.equal(starts.length, 2)
  assert.ok(starts[1] - starts[0] >= 40)
  assert.equal(cancelled, 1)
  assert.equal(store.summary().today.find(m => m.name === 'requests')!.value, 2)
  assert.equal(store.summary().today.find(m => m.name === 'http_search_302')!.value, 1)
})

test('a self-redirect is stopped after one HTTP request instead of twenty hidden hops', async (t) => {
  let calls = 0
  const store = memory(t)
  const fetcher = controlledFetch(store, cfg, new AbortController().signal, async input => {
    calls++
    return new Response('', { status: 302, headers: { location: String(input) } })
  })
  await assert.rejects(fetcher('https://www.youtube.com/results'), error => error instanceof CrawlError && error.status === 508 && error.scope === 'search')
  assert.equal(calls, 1)
  assert.equal(store.meta('pause_until'), undefined)
})

test('non-repeating redirects are bounded to four actual requests', async (t) => {
  let calls = 0
  const fetcher = controlledFetch(memory(t), cfg, new AbortController().signal, async () => {
    calls++
    return new Response('', { status: 307, headers: { location: '/results?hop=' + calls } })
  })
  await assert.rejects(fetcher('https://www.youtube.com/results'), error => error instanceof CrawlError && error.status === 508)
  assert.equal(calls, 4)
})

test('cross-origin, credential-bearing and downgraded redirects are never followed', async (t) => {
  for (const location of ['https://example.org/private', 'http://www.youtube.com/results', 'https://user:password@www.youtube.com/results']) {
    let calls = 0
    const fetcher = controlledFetch(memory(t), cfg, new AbortController().signal, async () => {
      calls++
      return new Response('', { status: 302, headers: { location } })
    })
    await assert.rejects(fetcher('https://www.youtube.com/results'), CrawlError)
    assert.equal(calls, 1)
  }
})

test('consent redirects pause their source instead of accepting consent or following another identity', async (t) => {
  const store = memory(t)
  let calls = 0
  const fetcher = controlledFetch(store, cfg, new AbortController().signal, async () => {
    calls++
    return new Response('', { status: 302, headers: { location: 'https://consent.youtube.com/m?continue=private-value' } })
  })
  await assert.rejects(fetcher('https://www.youtube.com/results'), error => error instanceof CrawlError && error.scope === 'search' && error.retryAt > Date.now())
  assert.equal(calls, 1)
  assert.ok(Number(store.meta('pause_search_until')) > Date.now())
})

test('redirect Retry-After and actual HTTP429 on a later hop remain authoritative', async (t) => {
  const delayed = memory(t)
  const fetcher = controlledFetch(delayed, cfg, new AbortController().signal,
    async () => new Response('', { status: 302, headers: { location: '/results?next=1', 'retry-after': '60' } }))
  await assert.rejects(fetcher('https://www.youtube.com/results'), CrawlError)
  assert.ok(Number(delayed.meta('pause_search_until')) > Date.now() + 50_000)
  const store = memory(t)
  let calls = 0
  const limited = controlledFetch(store, cfg, new AbortController().signal, async () => ++calls === 1
    ? new Response('', { status: 302, headers: { location: '/results?next=1' } })
    : new Response('', { status: 429, headers: { 'retry-after': '600' } }))
  await assert.rejects(limited('https://www.youtube.com/results'), error => error instanceof CrawlError && error.status === 429)
  assert.equal(calls, 2)
  assert.ok(Number(store.meta('pause_until')) > Date.now() + 590_000)
})
