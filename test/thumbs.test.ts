import test from 'node:test'
import assert from 'node:assert/strict'
import { openStore } from '../store.ts'
import { fingerprint, runThumbs, DecodeError, LOOK_BYTES } from '../thumbs.ts'
import { cfg, id, video, NOW } from './helpers.ts'

const pixels = new Uint8Array(LOOK_BYTES).fill(200)
const reply = (status: number) => (async () => new Response(status === 200 ? new Uint8Array(10) : null, { status })) as unknown as typeof fetch

test('thumbnail fingerprints: 4×4 RGB as base64url, empty when missing or unreadable, errors otherwise', async () => {
  const decode = async () => pixels
  assert.equal(await fingerprint(id(1), { fetch: reply(200), decode }), Buffer.from(pixels).toString('base64url'))
  assert.equal((await fingerprint(id(1), { fetch: reply(200), decode })).length, 64)
  assert.equal(await fingerprint(id(1), { fetch: reply(404), decode }), '')
  assert.equal(await fingerprint(id(1), { fetch: reply(200), decode: async () => { throw new DecodeError('bad') } }), '')
  assert.equal(await fingerprint('bad id', { fetch: reply(200), decode }), '')
  await assert.rejects(fingerprint(id(1), { fetch: reply(429), decode }), /429/)
})

test('the thumbnail job fills looks newest first and the page API returns them', async () => {
  const store = openStore(':memory:', cfg)
  store.save(video(1), '', NOW)
  store.save(video(2), '', NOW + 1)
  assert.deepEqual(store.thumbsPending(), [id(2), id(1)])
  const seen: string[] = []
  const controller = new AbortController()
  const fetcher = (async (url: string) => {
    seen.push(url)
    if (seen.length === 2) controller.abort()
    return new Response(url.includes(id(1)) ? null : new Uint8Array(10), { status: url.includes(id(1)) ? 404 : 200 })
  }) as unknown as typeof fetch
  await runThumbs(store, { ...cfg, thumbInterval: 1 }, controller.signal, { fetch: fetcher, decode: async () => pixels })
  assert.deepEqual(seen, [`https://i.ytimg.com/vi/${id(2)}/default.jpg`, `https://i.ytimg.com/vi/${id(1)}/default.jpg`])
  assert.deepEqual(store.thumbsPending(), [])
  const page = store.page(10)
  assert.equal(page[0].look, Buffer.from(pixels).toString('base64url'))
  assert.equal('look' in page[1], false)
  store.close()
})

test('the thumbnail job is off at interval 0', async () => {
  const store = openStore(':memory:', cfg)
  store.save(video(1), '', NOW)
  await runThumbs(store, { ...cfg, thumbInterval: 0 }, new AbortController().signal, { fetch: reply(200), decode: async () => pixels })
  assert.deepEqual(store.thumbsPending(), [id(1)])
  store.close()
})
