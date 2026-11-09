import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { config, DAY } from '../../config.ts'
import { openStore } from '../../store.ts'
import { controlledFetch, CrawlError } from '../../network.ts'
import { createProvider, candidate, searchQuery } from '../../provider.ts'
import { searchNodes } from '../../page.ts'
import { channel, feedXml, htmlJSON, searchResponse } from '../../test/helpers.ts'

const selfTest = process.argv.includes('--self-test')
assert(selfTest || process.argv.includes('--live'), 'Use --self-test or --live (bounded network experiment)')
process.umask(0o077)
const cfg = config({})
// Separate durable experiment state preserves its own access deadlines across invocations.
const store = openStore(selfTest ? ':memory:' : fileURLToPath(new URL('../../data/research-yield-2026-10-30.sqlite', import.meta.url)), cfg)
const controller = new AbortController()
const timer = setTimeout(() => controller.abort(), 6 * 60_000)
const budget = 16
let requests = 0, numeric = 0, stopped = false
const seen = new Set(), creators = new Set(), results = []
const transport = selfTest ? async input => new Response(String(input).includes('/feeds/') ? feedXml() : htmlJSON('ytInitialData', {
  ...searchResponse(), metadata: { channelMetadataRenderer: { externalId: channel } }
})) : fetch
const fetcher = controlledFetch(store, { ...cfg, ...(selfTest ? { rps: 1000, searchRequestInterval: 1 } : {}) }, controller.signal, async (...args) => {
  assert(requests < budget, 'Actual HTTP request budget exhausted')
  requests++
  return transport(...args)
})
const provider = await createProvider(fetcher, 1)
const before = new Date(Date.now() - 7 * DAY).toISOString().slice(0, 10)
const after = new Date(Date.now() - 187 * DAY).toISOString().slice(0, 10)
const queries = [
  ['word-archive', searchQuery({ term: 'abstemious', window: 'archive' })],
  ['word-older', searchQuery({ term: 'IMG', window: 'older' })],
  ['specific-filename', `"MVI_2379" before:${before}`],
  ['specific-filename-older', `"IMG_0487" before:${before} after:${after}`]
]
try {
  for (const [family, query] of queries) {
    if (Number(store.meta('pause_until') || 0) > Date.now() || store.summary().sourcePauses.length) { stopped = true; break }
    const result = { family, query, cards: 0, zeroHints: 0, newCreators: 0, numeric: 0 }
    try {
      const response = await fetcher('https://www.youtube.com/results?' + new URLSearchParams({ search_query: query, hl: 'en', gl: 'US' }))
      const cards = searchNodes(await response.text()).map(candidate).filter(Boolean)
      result.cards = cards.length
      result.zeroHints = cards.filter(card => card.hint === 'zero').length
      for (const card of cards) {
        if (card.hint !== 'zero' || !card.channelId || creators.has(card.channelId) || creators.size >= 4) continue
        creators.add(card.channelId)
        result.newCreators++
        for (const entry of await provider.channel(card.channelId)) {
          if (!entry.feed || !entry.seconds || seen.has(entry.id)) continue
          const verification = await provider.verify(entry.id, entry)
          if (verification.status === 'zero') { seen.add(entry.id); result.numeric++; numeric++ }
        }
        if (store.summary().sourcePauses.length || Number(store.meta('pause_until') || 0) > Date.now()) { stopped = true; break }
      }
    } catch (error) {
      result.error = error instanceof CrawlError ? error.message : 'Transport, parse or budget failure'
      result.status = error instanceof CrawlError ? error.status : 0
      stopped = true
    }
    results.push(result)
    console.log(JSON.stringify({ time: new Date().toISOString(), ...result }))
    if (stopped) break
  }
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM videos').get().n, 0, 'Research must not write archive records')
  if (selfTest) { assert.equal(results.length, 4); assert.equal(numeric, 1); assert.equal(stopped, false) }
} finally {
  clearTimeout(timer)
  console.log(JSON.stringify({ summary: true, time: new Date().toISOString(), selfTest, requests, budget, numeric, creators: creators.size, stopped,
    httpCountersToday: store.summary().today.filter(metric => String(metric.name).startsWith('http_')),
    archiveUnchanged: store.db.prepare('SELECT count(*) AS n FROM videos').get().n === 0 }))
  store.close()
}
