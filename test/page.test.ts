import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pageJSON, searchNodes } from '../page.ts'
import { candidate } from '../provider.ts'
import { searchResponse, id } from './helpers.ts'

test('public page JSON is read without evaluation, including braces and escapes in strings', () => {
  const raw = { text: '}; { "quoted" \\ text', nested: { value: 0 }, list: [{ a: 1 }] }
  for (const prefix of ['var ytInitialData', 'ytInitialData', 'window["ytInitialData"]']) {
    assert.deepEqual(pageJSON(`<script nonce="abc">${prefix} = ${JSON.stringify(raw)};throw new Error('never execute')</script>`, 'ytInitialData'), raw)
  }
  assert.throws(() => pageJSON('<p>ytInitialData = {"forged":0}</p>', 'ytInitialData'))
  assert.throws(() => pageJSON('<script>other = "ytInitialData = {}";</script>', 'ytInitialData'))
  assert.throws(() => pageJSON('<script>var ytInitialData = {"incomplete":</script>', 'ytInitialData'))
  assert.throws(() => pageJSON('<html>Sign in or complete a challenge</html>', 'ytInitialPlayerResponse'))
})

test('the existing renderer parser handles public search HTML without an API session', () => {
  const html = `<script>var ytInitialData = ${JSON.stringify(searchResponse())};</script>`
  const nodes = searchNodes(html)
  assert.equal(nodes.length, 1)
  assert.equal(candidate(nodes[0])!.id, id())
  assert.equal(candidate(nodes[0])!.hint, 'zero')
})
