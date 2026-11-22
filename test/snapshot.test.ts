// User request 2026-11-21: hourly server-baked dashboard snapshot (bake.ts, /api/snapshot) and gzip for /api/videos.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { once } from 'node:events'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import http from 'node:http'
import { bakeSnapshot, bakeInWorker, startBaking, slim, TOPIC_KS } from '../bake.ts'
import { createApp } from '../server.ts'
import { memory, video, NOW } from './helpers.ts'
// @ts-ignore plain browser module without type declarations
import * as coreModule from '../public/core.js'
const core: any = coreModule

const WORDS = ['rain', 'ocean', 'guitar', 'lesson', 'minecraft', 'build', 'recipe', 'cake', 'news', 'city', 'train', 'night']
const row = (n: number) => ({
  videoId: String(n).padStart(11, 'a'), title: `${WORDS[n % 12]} ${WORDS[(n * 7) % 12]} ${WORDS[(n * 5 + 1) % 12]} ${n % 5 ? 'video' : ''}`,
  description: 'long text', url: 'https://example.invalid', author: { name: 'C' + (n % 9), id: 'UC' + String(n % 9).padStart(22, 'x') },
  seconds: 30 * n, uploadDate: `20${10 + (n % 10)}-01-01`, meta: { q: n % 2 ? 'rain' : 'ocean', timestamp: 1 }, foundAt: 1_790_000_000_000 - n,
  verification: n % 4 ? 'verified' : 'hint', evidence: { source: n % 10 ? 'youtube/rss' : 'arranging/v1', rawValue: '0' },
  look: n % 6 ? Buffer.from(Array.from({ length: 48 }, (_, j) => (n * 37 + j * (n % 7)) % 256)).toString('base64url') : undefined
})
const rows = Array.from({ length: 300 }, (_, n) => row(n + 1))

test('slim keeps only the fields the dashboard reads', () => {
  const s = slim(rows[9]) as any
  assert.equal(s.description, undefined); assert.equal(s.url, undefined); assert.equal(s.meta.timestamp, undefined)
  assert.deepEqual(s.evidence, { source: 'arranging/v1' })
  assert.equal((slim(rows[0]) as any).evidence, undefined)
  // buildDocs sees the same values from a slim row as from the full one.
  const strip = (d: any) => ({ ...d, look: undefined, idx: [...d.idx], val: [...d.val] })
  assert.deepEqual(core.buildDocs(rows.map(slim)).docs.map(strip), core.buildDocs(rows).docs.map(strip))
})

test('bakeSnapshot matches the clustering the browser would compute', () => {
  const snap = bakeSnapshot(rows, NOW)
  const { docs, idf } = core.buildDocs(rows)
  assert.equal(snap.count, 300)
  assert.deepEqual(snap.top, { time: rows[0].foundAt, id: rows[0].videoId })
  for (const k of TOPIC_KS) {
    const km = core.kmeans(docs, k)
    assert.deepEqual(snap.topics[k].assign, Array.from(km.assign))
    assert.deepEqual(snap.topics[k].labels, core.uniqueLabels(core.clusterLabels(docs, km.assign, km.k, idf)))
  }
  assert.deepEqual(snap.look.assign, Array.from(core.lookKmeans(docs, 16).assign))
  const pcs = core.pca2(docs)
  pcs.forEach(([x, y]: number[], i: number) => { assert.ok(Math.abs(snap.pca.pcs[i * 2] - x) < 1e-3); assert.ok(Math.abs(snap.pca.pcs[i * 2 + 1] - y) < 1e-3) })
})

test('videos newer than the snapshot get the topic, look and PCA position of the baked model', () => {
  const snap = bakeSnapshot(rows, NOW)
  const { docs } = core.buildDocs(rows)
  const assign = Int32Array.from(snap.topics[16].assign)
  const centroids = core.topicCentroids(docs, assign, snap.topics[16].labels.length)
  // A converged k-means assignment is (almost) reproduced by its own centroids.
  const agree = docs.filter((d: any) => core.nearestTopic(d, centroids) === assign[d.i]).length
  assert.ok(agree / docs.length > 0.95, `agreement ${agree}`)
  const lookAssign = Int32Array.from(snap.look.assign)
  const lc = core.lookCentroids(docs, lookAssign, snap.look.labels.length)
  assert.ok(docs.filter((d: any) => core.nearestLook(d, lc) === lookAssign[d.i]).length / docs.length > 0.95)
  assert.equal(core.nearestLook({ look: null }, lc), -1)
  const [x, y] = core.projectPca(docs[5], { comps: snap.pca.comps, mv: snap.pca.mv })
  assert.ok(Math.abs(x - snap.pca.pcs[10]) < 1e-3 && Math.abs(y - snap.pca.pcs[11]) < 1e-3)
})

test('nearestPlaced finds the same best placed title as a full scan', () => {
  const { docs } = core.buildDocs(rows)
  const placed = new Uint8Array(docs.length).map((_, i) => i % 3 ? 1 : 0)
  const targets = docs.filter((d: any) => !placed[d.i])
  const fast = core.nearestPlaced(docs, placed, targets)
  targets.forEach((d: any, k: number) => {
    const dense = new Float64Array(core.DIMS); d.idx.forEach((j: number, m: number) => { dense[j] = d.val[m] })
    let best = -1, top = 0.05
    for (const o of docs) if (placed[o.i] && o !== d) { let s = 0; o.idx.forEach((j: number, m: number) => { s += o.val[m] * dense[j] }); if (s > top + 1e-12) { top = s; best = o.i } }
    if (best !== fast[k]) {
      // Ties may resolve differently; the score must be the same.
      const score = (i: number) => { let s = 0; docs[i].idx.forEach((j: number, m: number) => { s += docs[i].val[m] * dense[j] }); return s }
      assert.ok(best >= 0 && fast[k] >= 0 && Math.abs(score(best) - score(fast[k])) < 1e-9, `target ${d.i}: ${best} vs ${fast[k]}`)
    }
  })
})

test('the bake runs in a worker thread and startBaking writes the file atomically', async (t) => {
  const gz = await bakeInWorker(rows.map(slim))
  const snap = JSON.parse(gunzipSync(gz).toString('utf8'))
  assert.equal(snap.version, 1); assert.equal(snap.videos.length, 300)
  const dir = mkdtempSync(join(tmpdir(), 'yt0-bake-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'snapshot.json.gz'), controller = new AbortController()
  const job = startBaking(() => rows, file, 3_600_000, controller.signal, 0)
  for (let k = 0; k < 200 && !existsSync(file); k++) await new Promise((r) => setTimeout(r, 50))
  assert.equal(JSON.parse(gunzipSync(readFileSync(file)).toString('utf8')).count, 300)
  assert.equal(existsSync(file + '.tmp'), false)
  controller.abort(); await job
})

test('/api/snapshot serves the baked file with gzip and ETag revalidation; /api/videos is gzipped when accepted', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'yt0-snap-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'snapshot.json.gz')
  const store = memory(t)
  for (let n = 1; n <= 40; n++) store.save(video(n), '', NOW)
  const { server } = createApp(store, '', file)
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => { await new Promise<void>((r) => server.close(() => r())) })
  const address = server.address(); assert.ok(address && typeof address !== 'string')
  const base = 'http://127.0.0.1:' + address.port
  const get = (path: string, headers: Record<string, string> = {}) => new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve) =>
    http.get(base + path, { headers }, (res) => { const parts: Buffer[] = []; res.on('data', (c) => parts.push(c)); res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(parts) })) }))
  assert.equal((await get('/api/snapshot')).status, 404)
  const { writeFileSync } = await import('node:fs')
  writeFileSync(file, await bakeInWorker(store.page(1000).map(slim)))
  const first = await get('/api/snapshot', { 'accept-encoding': 'gzip' })
  assert.equal(first.status, 200); assert.equal(first.headers['content-encoding'], 'gzip')
  assert.equal(JSON.parse(gunzipSync(first.body).toString('utf8')).count, 40)
  assert.equal((await get('/api/snapshot', { 'accept-encoding': 'gzip', 'if-none-match': String(first.headers.etag) })).status, 304)
  const plain = await get('/api/snapshot', { 'accept-encoding': 'identity' })
  assert.equal(plain.headers['content-encoding'], undefined); assert.notEqual(plain.headers.etag, first.headers.etag)
  assert.equal(JSON.parse(plain.body.toString('utf8')).count, 40)
  const page = await get('/api/videos?limit=40', { 'accept-encoding': 'gzip' })
  assert.equal(page.headers['content-encoding'], 'gzip')
  assert.equal(JSON.parse(gunzipSync(page.body).toString('utf8')).videos.length, 40)
  const unzipped = await get('/api/videos?limit=40', { 'accept-encoding': 'identity' })
  assert.equal(unzipped.headers['content-encoding'], undefined)
  assert.equal(JSON.parse(unzipped.body.toString('utf8')).videos.length, 40)
})

test('bakes run on clock slots (:00 for the hour) and a restart keeps a file from the current slot', async (t) => {
  const { writeFileSync, statSync } = await import('node:fs')
  const dir = mkdtempSync(join(tmpdir(), 'yt0-slot-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'snapshot.json.gz'), interval = 2000, controller = new AbortController()
  writeFileSync(file, 'from this slot')
  const job = startBaking(() => rows.slice(0, 50), file, interval, controller.signal, 0)
  // No immediate bake: the existing file is from the current slot.
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(readFileSync(file, 'utf8'), 'from this slot')
  for (let k = 0; k < 100 && readFileSync(file).length < 20; k++) await new Promise((r) => setTimeout(r, 50))
  const snap = JSON.parse(gunzipSync(readFileSync(file)).toString('utf8'))
  // The bake started right after a slot boundary.
  assert.ok(snap.bakedAt % interval < 400, `started ${snap.bakedAt % interval} ms after the slot`)
  assert.ok(statSync(file).mtimeMs >= snap.bakedAt)
  controller.abort(); await job
})
