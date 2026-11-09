import assert from 'node:assert/strict'
import { mkdirSync, appendFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { config } from '../../config.ts'
import { openStore } from '../../store.ts'
import { controlledFetch } from '../../network.ts'
import { searchNodes } from '../../page.ts'
import { reportedZero } from '../../search-evidence.ts'

process.umask(0o077)
const cfg = config(), store = openStore(cfg.database, cfg)
const output = fileURLToPath(new URL('./', import.meta.url))
mkdirSync(output, { recursive: true, mode: 0o700 })
const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 90_000)
const archiveBefore = Number(store.db.prepare('SELECT count(*) AS n FROM videos').get().n)
const followup = process.argv.includes('--followup')
const budget = followup ? 8 : 16, results = [], eligibleIds = new Set()
let attempts = 0, denied = Number(store.meta('pause_until') || 0) > Date.now()
const channelRefs = followup ? store.db.prepare("SELECT DISTINCT json_extract(record,'$.author.id') AS id FROM videos WHERE verification='verified' LIMIT 2").all().map(row => String(row.id)) : []
const queries = followup ? [
  ['rare-narrow', 'abstemious before:2025-11-01 after:2025-10-01'],
  ['specific-filename', '"IMG_1573" before:2026-10-19'],
  ['specific-filename', '"MVI_2379" before:2026-10-19'],
  ['specific-filename', '"MOV_0034" before:2026-10-19'],
  ['rare-broad', 'scolecophidian before:2026-10-19'],
  ['dated-filename', '"VID_2017" before:2026-10-19'],
  ...channelRefs.filter(id => /^UC[\w-]{22}$/.test(id)).map(id => ['known-channel', id])
] : [
  ['rare-broad', 'abstemious before:2026-10-19'],
  ['rare-narrow', 'abstemious before:2025-11-01 after:2025-10-01'],
  ['filename-broad', 'IMG before:2026-10-19'],
  ['filename-narrow', 'IMG before:2025-11-01 after:2025-10-01'],
  ['exact-filename', '"IMG 0001" before:2026-10-19'],
  ['exact-filename', '"MVI 0001" before:2026-10-19'],
  ['niche', '"field recording" before:2026-10-19'],
  ['rare-broad', 'absquatulate before:2026-10-19']
]
// Ignore only our own transport-failure heuristic during isolated testing, never a site-imposed cooldown.
const experimentStore = { ...store, meta(key) {
  if (key === 'pause_search_until' && store.meta('pause_search_reason') === 'Repeated crawler failures: fetch failed') return '0'
  return store.meta(key)
} }
try {
  for (const rate of followup ? [0.5] : [1, 0.25]) {
    const fetcher = controlledFetch(experimentStore, { ...cfg, rps: Math.min(rate, cfg.rps), timeout: 10_000 }, controller.signal,
      async (input, init) => { assert(attempts < budget); attempts++; return fetch(input, init) })
    for (const [family, query] of queries) {
      if (denied || controller.signal.aborted || attempts >= budget) break
      const start = performance.now(), result = { time: new Date().toISOString(), phase: followup ? 'followup' : 'baseline', parserRevision: 'compact-age-v2', family,
        query: family === 'known-channel' ? 'known previously verified channel' : query,
        sourceHash: createHash('sha256').update(query).digest('hex'), rps: rate }
      try {
        const params = new URLSearchParams({ search_query: query, hl: 'en', gl: 'US' })
        const url = family === 'known-channel' ? `https://www.youtube.com/channel/${query}/videos?hl=en&gl=US` : 'https://www.youtube.com/results?' + params
        const response = await fetcher(url)
        const html = await response.text(), nodes = searchNodes(html)
        const hits = [...new Map(nodes.map(n => reportedZero(n)).filter(Boolean).map(hit => [hit.id, hit])).values()]
        result.http = response.status
        result.bytesDecoded = Buffer.byteLength(html)
        result.cards = nodes.length
        result.namedCountCards = nodes.filter(n => n.type === 'Video' && n.view_count).length
        result.explicitZeroLabels = nodes.filter(n => /^(?:No views|0 views?)$/i.test(String(n.view_count ?? '').trim())).length
        result.eligible = hits.length
        result.newUnique = hits.filter(hit => !eligibleIds.has(hit.id)).length
        result.evidence = hits.map(hit => ({ idHash: createHash('sha256').update(hit.id).digest('hex'),
          viewLabel: hit.viewLabel, publishedLabel: hit.publishedLabel, minAgeDays: hit.minAgeDays, tier: hit.tier }))
        hits.forEach(hit => eligibleIds.add(hit.id))
      } catch (error) {
        result.error = error.message
        result.status = error.status
        result.causeCode = error.cause?.code
        result.causes = error.cause?.errors?.map(e => ({ code: e.code, syscall: e.syscall }))
        if ([403, 429].includes(error.status)) denied = true
      }
      result.durationMs = Math.round(performance.now() - start)
      results.push(result)
      appendFileSync(output + 'autoresearch.jsonl', JSON.stringify(result) + '\n', { mode: 0o600 })
      console.log(JSON.stringify(result))
    }
    if (denied || controller.signal.aborted) break
    await sleep(1000, undefined, { signal: controller.signal }).catch(() => {})
  }
} finally {
  clearTimeout(timer)
  const archiveAfter = Number(store.db.prepare('SELECT count(*) AS n FROM videos').get().n)
  assert.equal(archiveAfter, archiveBefore, 'The benchmark must not modify the archive')
  const summary = { measuredAt: new Date().toISOString(), attempts, trials: results.length, budget,
    successfulPages: results.filter(r => r.http === 200).length,
    eligibleObservations: results.reduce((n, r) => n + (r.eligible || 0), 0), uniqueEligible: eligibleIds.size,
    denied, aborted: controller.signal.aborted, archiveUnchanged: true }
  writeFileSync(output + 'summary.json', JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 })
  console.log('SUMMARY ' + JSON.stringify(summary))
  store.close()
}
