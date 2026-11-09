import assert from 'node:assert/strict'
import { test } from 'node:test'
import { controlledFetch, CrawlError } from '../network.ts'
import { memory } from './helpers.ts'

const preference = () => ({ name: 'SOCS', value: 'private-consent-test', domain: '.youtube.com',
  choice: 'reject_optional', expiresAt: Date.now() + 600_000 })
const cfg = { rps: 20, timeout: 1000 }

test('only the authorized necessary preference is sent to the exact secure YouTube origin', async (t) => {
  const store = memory(t)
  store.setMeta('youtube_consent', JSON.stringify(preference()))
  const received: { cookie: string | null; accept: string | null }[] = []
  const fetcher = controlledFetch(store, cfg, new AbortController().signal, async (_input, init) => {
    const headers = new Headers(init?.headers)
    received.push({ cookie: headers.get('cookie'), accept: headers.get('accept') })
    return new Response('ok')
  })
  await fetcher(new Request('https://www.youtube.com/results', { headers: { accept: 'text/html' } }))
  assert.equal(received[0].cookie, 'SOCS=private-consent-test')
  assert.equal(received[0].accept, 'text/html')
  for (const url of ['https://www.google.com/', 'https://consent.youtube.com/', 'http://www.youtube.com/', 'https://www.youtube.com.example.org/', 'https://www.youtube.com:8443/']) await fetcher(url)
  assert.ok(received.slice(1).every(item => item.cookie === null))
})

test('expired, malformed, broader-scope or non-reject preferences are ignored', async (t) => {
  for (const change of [{ expiresAt: Date.now() - 1 }, { choice: 'accept_all' }, { domain: '.google.com' }, { name: 'SID' }, { value: 'bad\r\nHeader: bad' }]) {
    const store = memory(t)
    store.setMeta('youtube_consent', JSON.stringify({ ...preference(), ...change }))
    const fetcher = controlledFetch(store, cfg, new AbortController().signal, async (_input, init) => {
      assert.equal(new Headers(init?.headers).get('cookie'), null)
      return new Response('ok')
    })
    await fetcher('https://www.youtube.com/results')
  }
  const store = memory(t)
  store.setMeta('youtube_consent', 'not json')
  await controlledFetch(store, cfg, new AbortController().signal, async (_input, init) => {
    assert.equal(new Headers(init?.headers).get('cookie'), null)
    return new Response('ok')
  })('https://www.youtube.com/results')
})

test('consent values are neither logged nor forwarded over an external redirect', async (t) => {
  const entries: string[] = []
  t.mock.method(console, 'log', (line: string) => entries.push(line))
  const store = memory(t)
  store.setMeta('youtube_consent', JSON.stringify(preference()))
  let requests = 0
  const fetcher = controlledFetch(store, cfg, new AbortController().signal, async (_input, init) => {
    requests++
    assert.equal(new Headers(init?.headers).get('cookie'), 'SOCS=private-consent-test')
    return new Response('', { status: 302, headers: { location: 'https://example.org/' } })
  })
  await assert.rejects(fetcher('https://www.youtube.com/results'), error => error instanceof CrawlError && error.status === 502)
  assert.equal(requests, 1)
  assert.ok(entries.some(line => line.includes('http_redirect')))
  assert.ok(entries.every(line => !line.includes('private-consent-test')))
})
