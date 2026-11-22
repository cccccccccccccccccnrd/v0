import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
// @ts-ignore plain browser module without type declarations
import * as coreModule from '../public/core.js'
const core: any = coreModule

const row = (n: number, title: string, extra: Record<string, unknown> = {}) => ({
  videoId: String(n).padStart(11, 'a'), title, author: { name: 'C' + (n % 3), id: 'UC' + String(n % 3).padStart(22, 'x') },
  seconds: 60 * n, uploadDate: `20${10 + (n % 10)}-01-01`, meta: { q: n % 2 ? 'rain' : 'ocean' }, foundAt: 1_790_000_000_000 + n,
  verification: n % 4 ? 'verified' : 'hint', ...extra })

test('dashboard core tokenizes multilingual titles, detects scripts and decodes entities', () => {
  assert.deepEqual(core.tokenize('Heavy RAIN & thunder for the night'), ['heavy', 'rain', 'thunder', 'night'])
  assert.deepEqual(core.tokenize('宇宙探索'), ['宇宙', '宙探', '探索'])
  assert.equal(core.scriptOf('Привет мир'), 'Cyrillic')
  assert.equal(core.scriptOf('東京へ行く'), 'Japanese')
  assert.equal(core.scriptOf('123 !!'), 'No letters')
  assert.equal(core.decodeEntities('Rain &amp; Thunder &#39;x&#39;'), "Rain & Thunder 'x'")
})

test('dashboard clustering is deterministic and separates unrelated vocabularies', () => {
  const rows = [
    ...Array.from({ length: 12 }, (_, i) => row(i + 1, `heavy rain thunder storm sleep ${i}`)),
    ...Array.from({ length: 12 }, (_, i) => row(i + 20, `minecraft speedrun world record ${i}`)),
    row(40, '!!!')
  ]
  const { docs, idf } = core.buildDocs(rows)
  const a = core.kmeans(docs, 2), b = core.kmeans(docs, 2)
  assert.deepEqual([...a.assign], [...b.assign])
  assert.equal(new Set(docs.slice(0, 12).map((d: any) => a.assign[d.i])).size, 1)
  assert.equal(new Set(docs.slice(12, 24).map((d: any) => a.assign[d.i])).size, 1)
  assert.notEqual(a.assign[0], a.assign[12])
  assert.equal(a.assign[24], -1)
  const labels = core.clusterLabels(docs, a.assign, a.k, idf)
  assert.ok(labels.some((l: string) => l.includes('rain') || l.includes('thunder')))
  assert.equal(core.neighbours(docs, docs[0], 3).every(([d]: any) => d.i < 12), true)
  const pcs = core.pca2(docs)
  assert.equal(pcs.length, docs.length)
  assert.ok(pcs.every((p: number[]) => p.every(Number.isFinite)))
})

test('dashboard search syntax combines words, fields, comparisons and negation', () => {
  const { docs } = core.buildDocs([row(1, 'Heavy rain'), row(2, 'Ocean waves'), row(3, 'Привет rain'), row(4, 'Deep ocean')])
  const hits = (q: string) => docs.filter(core.matcher(q, {})).map((d: any) => d.title)
  assert.deepEqual(hits('rain'), ['Heavy rain', 'Привет rain'])
  assert.deepEqual(hits('ocean -deep'), ['Ocean waves'])
  assert.deepEqual(hits('lang:cyrillic'), ['Привет rain'])
  assert.deepEqual(hits('dur:>2m'), ['Привет rain', 'Deep ocean'])
  assert.deepEqual(hits('year:<2013'), ['Heavy rain', 'Ocean waves'])
  assert.deepEqual(hits('-status:verified'), ['Deep ocean'])
  assert.deepEqual(hits('title:"heavy rain"'), ['Heavy rain'])
  assert.equal(core.matcher('   ', {}), null)
})

test('dashboard layouts place every video without overlapping group discs', () => {
  const rows = Array.from({ length: 200 }, (_, i) => row(i + 1, `title ${i % 7} word${i % 5}`))
  const { docs } = core.buildDocs(rows)
  const g = core.galaxy(docs, (d: any) => d.channel, (d: any) => d.year)
  assert.equal(g.groups.reduce((s: number, x: any) => s + x.n, 0), 200)
  for (const a of g.groups) for (const b of g.groups) if (a !== b) assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= a.r + b.r)
  assert.ok([...g.pos].every(Number.isFinite))
  const s = core.scatter(docs, (d: any) => d.seconds, (d: any) => d.upload)
  assert.ok([...s.pos].every(Number.isFinite))
})

test('dashboard page is self-contained, CSP-compatible and avoids HTML injection', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
  const js = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8') + readFileSync(new URL('../public/core.js', import.meta.url), 'utf8')
  assert.ok(html.includes('src="/app.js"') && html.includes('href="/style.css"'))
  assert.ok(html.includes('CC BY-SA 4.0'), 'logo font attribution is shown')
  for (const id of ['fit', 'random', 'copy', 'reset']) assert.ok(html.includes(`id="${id}"`), id)
  assert.match(js, /mode: 'scatter', group: 'topic', x: 'upload', y: 'ageNow', k: 16/)
  assert.doesNotMatch(html, /<script>|style="|\son\w+="/)
  assert.doesNotMatch(js, /innerHTML|insertAdjacentHTML|eval\(|new Function|https?:\/\/(?!i\.ytimg\.com|www\.youtube\.com)/)
})

test('thumbnail looks: fingerprints decode, cluster by colour, and get readable labels', () => {
  const look = (r: number, g: number, b: number, centre?: number[]) => Buffer.from(Array.from({ length: 16 }, (_, c) => {
    const x = c % 4, y = Math.floor(c / 4)
    return centre && x > 0 && x < 3 && y > 0 && y < 3 ? centre : [r, g, b]
  }).flat()).toString('base64url')
  const rows = [
    ...[1, 2, 3].map((n) => row(n, 'red ' + n, { look: look(220, 20, 20) })),
    ...[4, 5, 6].map((n) => row(n, 'blue ' + n, { look: look(20, 40, 200) })),
    row(7, 'none'), row(8, 'bad', { look: 'x' })
  ]
  const { docs } = core.buildDocs(rows)
  assert.equal(docs[0].look.length, core.LOOK_DIMS)
  assert.equal(docs[6].look, null)
  assert.equal(docs[7].look, null)
  const { assign, centroids } = core.lookKmeans(docs, 2)
  assert.equal(assign[0], assign[2]); assert.equal(assign[3], assign[5]); assert.notEqual(assign[0], assign[3])
  assert.equal(assign[6], -1)
  assert.deepEqual(centroids.map(core.lookLabel).sort(), ['blue', 'red'])
  assert.equal(core.lookLabel(core.lookFeatures(look(10, 10, 10))), 'black')
  assert.equal(core.lookLabel(core.lookFeatures(look(10, 10, 10, [240, 240, 240]))), 'grey bright centre')
  const match = core.matcher('look:red', { look: (d: any) => d.look ? core.lookLabel(centroids[assign[d.i]]) : 'No thumbnail data' })
  assert.deepEqual(docs.filter(match).map((d: any) => d.i), [0, 1, 2])
})

test('filters work for every category the page passes in (meaning, sub, reuse…), not only the built-in keys', () => {
  const { docs } = core.buildDocs([row(1, 'a'), row(2, 'b')])
  const groups = { sub: (d: any) => d.i === 0 ? 'Rain Sounds' : 'Other', reuse: () => 'channel template' }
  assert.deepEqual(docs.filter(core.matcher('sub:"rain sounds"', groups)).map((d: any) => d.i), [0])
  assert.equal(docs.filter(core.matcher('reuse:"channel template"', groups)).length, 2)
  assert.equal(docs.filter(core.matcher('nosuchkey:x', groups)).length, 0)
})
