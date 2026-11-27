import {
  buildDocs, kmeans, clusterLabels, lookKmeans, lookLabel, pca2, neighbours, matcher, galaxy, scatter, countBy,
  uniqueLabels, topicCentroids, nearestTopic, lookCentroids, nearestLook, projectPca, nearestPlaced,
  DURATION_ORDER, formatDuration, formatDate, DAY
} from './core.js'

const $ = (id) => document.getElementById(id)
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e }

// Default view chosen by the user on 2026-11-09.
function defaults() { return { mode: 'scatter', group: 'topic', x: 'upload', y: 'ageNow', k: 16 } }

const state = {
  docs: [], idf: null, topics: null, labels: [], pcs: [],
  ...defaults(), resultLimit: 80, expanded: new Set(),
  query: '', match: null, matched: null, area: null, box: null, boxMode: false, spaceHeld: false,
  pos: null, from: null, to: null, anim: 0, groups: [], axes: null,
  view: { s: 1, x: 0, y: 0 }, shown: Infinity, baked: null, fitS: 0, thumbW: 0, thumbOrder: [], hover: -1, selected: -1, near: [], hot: -1, order: []
}

const CATS = {
  topic: { label: 'Title topic', key: (d) => d.idx.length ? state.labels[state.topics.assign[d.i]] ?? 'Unclustered' : 'No title words', token: 'topic' },
  script: { label: 'Writing system', key: (d) => d.script, token: 'lang' },
  year: { label: 'Upload year', key: (d) => d.year, token: 'year', sort: true },
  duration: { label: 'Duration', key: (d) => d.duration, token: 'dur', order: DURATION_ORDER },
  channel: { label: 'Channel', key: (d) => d.channel || '(unknown)', token: 'channel' },
  term: { label: 'Search term', key: (d) => d.term || '(none)', token: 'term' },
  status: { label: 'Status', key: (d) => d.verified ? 'verified' : 'unverified', token: 'status' },
  // User request 2026-11-20: groups by the colour and layout of the small thumbnail (server fingerprint), not by what is pictured.
  // User request 2026-11-20: clusters computed offline on the user's Mac (/api/map); absent until a map file is deployed.
  meaning: { label: 'Meaning cluster', key: (d) => mapName(d, 'text', 'names1', 'l1'), token: 'meaning' },
  meaningSub: { label: 'Meaning sub-cluster', key: (d) => mapName(d, 'text', 'names2', 'l2'), token: 'sub' },
  visual: { label: 'Thumbnail content', key: (d) => mapName(d, 'image', 'names1', 'l1'), token: 'visual' },
  titleKind: { label: 'Title kind', key: (d) => ({ title: 'normal title' })[state.map?.features?.[d.id]?.[0]] || state.map?.features?.[d.id]?.[0] || 'unknown', token: 'kind' },
  // Thumbnail 404 when the offline run downloaded it: the video was most likely deleted or made private by then.
  gone: { label: 'Still on YouTube', key: (d) => !state.map?.features?.[d.id] ? 'unknown' : state.map.features[d.id][2] ? `gone by ${state.map.thumbsCheckedAt || 'last check'}` : 'yes, at last check', token: 'gone' },
  // Near-duplicate thumbnails (dHash plus SigLIP similarity, computed offline): templates within a channel, or shared across channels.
  reuse: { label: 'Thumbnail reuse', key: (d) => { const f = state.map?.features?.[d.id]; return !f || f.length < 5 ? 'unknown' : !f[3] ? 'unique' : f[4] > 1 ? 'shared across channels' : 'channel template' }, token: 'reuse' },
  repost: { label: 'Repost marker', key: (d) => state.map?.features?.[d.id]?.[1] || 'none', token: 'repost' },
  look: { label: 'Thumbnail look', key: (d) => state.lookAssign?.[d.i] >= 0 ? state.lookLabels[state.lookAssign[d.i]] : 'No thumbnail data', token: 'look' }
}
const NUMS = {
  ageNow: { label: 'Video age (log days)', of: (d) => Number.isFinite(d.upload) ? Math.log10(Math.max(7, (Date.now() - d.upload) / DAY)) : NaN, fmt: (v) => ageLabel(10 ** v) },
  upload: { label: 'Upload date', of: (d) => d.upload, fmt: formatDate },
  found: { label: 'Found date', of: (d) => d.found || NaN, fmt: formatDate },
  duration: { label: 'Duration (log)', of: (d) => d.seconds ? Math.log10(d.seconds) : NaN, fmt: (v) => formatDuration(Math.round(10 ** v)) },
  age: { label: 'Age when found (log days)', of: (d) => Number.isFinite(d.upload) && d.found ? Math.log10(Math.max(1, (d.found - d.upload) / DAY)) : NaN, fmt: (v) => `${Math.round(10 ** v)} d` },
  titleLen: { label: 'Title length', of: (d) => [...d.title].length, fmt: (v) => `${Math.round(v)} chars` },
  pc1: { label: 'Title space PC1', of: (d) => state.pcs[d.i][0], fmt: (v) => v.toFixed(2) },
  pc2: { label: 'Title space PC2', of: (d) => state.pcs[d.i][1], fmt: (v) => v.toFixed(2) },
  channelSize: { label: 'Channel size (videos here)', of: (d) => Math.log2(d.channelSize), fmt: (v) => String(Math.round(2 ** v)) },
  lonely: { label: 'Loneliness (meaning)', of: (d) => d.m?.text >= 0 ? state.map.maps.text.outlier[d.m.text] : NaN, fmt: (v) => v.toFixed(2) },
  termSize: { label: 'Search-term yield (videos)', of: (d) => Math.log2(d.termSize), fmt: (v) => String(Math.round(2 ** v)) }
}

const ageLabel = (days) => days < 60 ? `${Math.round(days)} d` : days < 730 ? `${Math.round(days / 30.4)} mo` : `${(days / 365.25).toFixed(days < 3650 ? 1 : 0)} y`

// ---------- data ----------
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let requests = 0, retries = 0
async function fetchPage(cursor) {
  for (;;) {
    // The public proxy allows 5 requests/second (burst 20): pace after the burst and back off on 429.
    if (requests++ >= 15) await wait(220)
    const response = await fetch('/api/videos?limit=500' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''), { signal: AbortSignal.timeout(20_000) })
    if (response.status === 429 && retries++ < 20) { await wait(Math.max(1000, Number(response.headers.get('retry-after')) * 1000 || 0)); continue }
    if (!response.ok) throw new Error('Archive request failed')
    return response.json()
  }
}
// User request 2026-11-22: the loading pill reads "Loading xx% (xxx videos)" and nothing else; hidden until the count is known.
// Downloads (snapshot + map, by unzipped bytes) are 0–85 %, the preparation steps after them 85–100 %.
const progress = { count: 0, files: {}, prep: 0 }
function showProgress() {
  if (!progress.count) return
  const files = Object.values(progress.files), total = files.reduce((s, f) => s + f.total, 0)
  const download = total ? files.reduce((s, f) => s + Math.min(f.loaded, f.total), 0) / total : 0
  const pct = Math.min(99, Math.floor(progress.prep ? 85 + 15 * progress.prep : 85 * download))
  $('loading').textContent = `Loading ${pct}% (${progress.count.toLocaleString('en-US')} videos)`
  $('loading').hidden = false
}
// Reads a JSON response while counting bytes against the server's x-json-length header.
async function readJson(response, key) {
  const total = Number(response.headers.get('x-json-length')) || 0
  if (!total || !response.body) return response.json()
  const file = progress.files[key] = { loaded: 0, total }
  const reader = response.body.getReader(), chunks = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value); file.loaded += value.length; showProgress()
  }
  file.loaded = total; showProgress()
  return JSON.parse(await new Blob(chunks).text())
}
// Lets the pill repaint between the synchronous preparation steps.
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)))
async function prepStep(fraction, fn) { fn(); progress.prep = fraction; showProgress(); await nextFrame() }
// Fallback when no snapshot has been baked yet: every page of the archive.
async function loadAll(first) {
  const rows = []
  let cursor = null
  do {
    const data = await (rows.length ? fetchPage(cursor) : first)
    rows.push(...data.videos)
    cursor = data.cursor
    if (!progress.count) progress.count = rows.length
    progress.files.pages = { loaded: rows.length, total: Math.max(rows.length, progress.count) }
    showProgress()
  } while (cursor)
  return rows
}
// User request 2026-11-21: the server bakes rows plus clusters once an hour (bake.ts); one gzip download instead of 60+ pages.
async function loadSnapshot() {
  try {
    const response = await fetch('/api/snapshot', { signal: AbortSignal.timeout(60_000) })
    if (!response.ok) return null
    progress.count = Number(response.headers.get('x-archive-videos')) || progress.count
    const snap = await readJson(response, 'snapshot')
    return snap?.version === 1 && Array.isArray(snap.videos) ? snap : null
  } catch { return null }
}
// Videos found after the snapshot was baked: /api/videos pages newest first, so stop at the snapshot's newest row.
async function loadSince(top, first) {
  const older = (v) => v.foundAt < top.time || (v.foundAt === top.time && v.videoId <= top.id)
  const rows = []
  let data = await first
  for (;;) {
    const cut = data.videos.findIndex(older)
    rows.push(...(cut < 0 ? data.videos : data.videos.slice(0, cut)))
    if (cut >= 0 || !data.cursor) return rows
    data = await fetchPage(data.cursor)
  }
}

const LOOK_K = 16
function computeLooks() {
  if (state.baked) {
    const { snap } = state.baked
    state.lookAssign = fromBaked(snap.look.assign)
    state.lookLabels = snap.look.labels
    placeFresh(state.lookAssign, lookCentroids(state.docs, state.lookAssign, snap.look.labels.length), nearestLook)
    return
  }
  const { assign, centroids } = lookKmeans(state.docs, LOOK_K)
  state.lookAssign = assign
  state.lookLabels = uniqueLabels(centroids.map(lookLabel))
}
// Baked per-video arrays follow the snapshot's row order; docs are the newer videos first, then the snapshot's (src maps back).
function fromBaked(values) {
  const { src } = state.baked
  const out = new Int32Array(state.docs.length)
  for (let i = 0; i < out.length; i++) out[i] = src[i] >= 0 ? values[src[i]] : -1
  return out
}
function placeFresh(assign, centroids, nearestOf) {
  const { src } = state.baked
  for (const d of state.docs) if (src[d.i] < 0) assign[d.i] = nearestOf(d, centroids)
}

function mapName(d, which, names, level) {
  const m = state.map?.maps?.[which], r = d.m?.[which]
  return m && r >= 0 ? m[names][m[level][r]] || 'Unnamed' : 'Not embedded yet'
}
async function loadMap() {
  try {
    const response = await fetch('/api/map', { signal: AbortSignal.timeout(30_000) })
    if (!response.ok) return null
    const map = await readJson(response, 'map')
    return map?.version === 1 && map.maps?.text ? map : null
  } catch { return null }
}
function attachMap() {
  const map = state.map
  for (const d of state.docs) d.m = {}
  if (!map) return
  const byId = new Map(state.docs.map((d) => [d.id, d]))
  for (const [which, m] of Object.entries(map.maps)) {
    m.docOf = new Int32Array(m.ids.length).fill(-1)
    m.ids.forEach((id, r) => { const d = byId.get(id); if (d) { d.m[which] = r; m.docOf[r] = d.i } })
  }
}

function computeTopics() {
  const baked = state.baked?.snap.topics?.[state.k]
  if (baked) {
    const assign = fromBaked(baked.assign)
    placeFresh(assign, topicCentroids(state.docs, assign, baked.labels.length), nearestTopic)
    state.topics = { assign }
    state.labels = baked.labels
    return
  }
  const { assign, k } = kmeans(state.docs, state.k)
  state.topics = { assign }
  // Duplicate labels get a number so every topic stays addressable.
  state.labels = uniqueLabels(clusterLabels(state.docs, assign, k, state.idf))
}
function computePcs() {
  if (!state.baked) { state.pcs = pca2(state.docs); return }
  const { snap, src } = state.baked
  state.pcs = state.docs.map((d) => src[d.i] >= 0 ? [snap.pca.pcs[src[d.i] * 2], snap.pca.pcs[src[d.i] * 2 + 1]] : projectPca(d, snap.pca))
}

// ---------- layout ----------
function layout(animate = true) {
  const docs = state.docs
  let next
  if (['meaning', 'visual'].includes(state.mode) && state.map) {
    const m = state.map.maps[state.mode === 'visual' ? 'image' : 'text'] || state.map.maps.text
    const which = m === state.map.maps.text ? 'text' : 'image'
    next = new Float64Array(docs.length * 2)
    const placed = new Uint8Array(docs.length)
    for (const d of docs) { const r = d.m[which]; if (r >= 0) { next[d.i * 2] = m.xy[r * 2]; next[d.i * 2 + 1] = m.xy[r * 2 + 1]; placed[d.i] = 1 } }
    // Thumbnail map: videos without a thumbnail vector (missing or newer) go in a block under the map, not among look-alikes.
    const missing = which === 'image' ? docs.filter((d) => !placed[d.i]) : []
    missing.forEach((d, k) => { next[d.i * 2] = 200 + (k % 200) * 3; next[d.i * 2 + 1] = 1060 + Math.floor(k / 200) * 3; placed[d.i] = 1 })
    // Videos newer than the map file sit next to their most similar placed title, slightly offset.
    // One inverted-index pass (nearestPlaced) instead of a full similarity scan per video (2026-11-21: ~2,300 such videos took seconds).
    const fresh = docs.filter((d) => !placed[d.i])
    nearestPlaced(docs, placed, fresh).forEach((hit, k) => {
      const d = fresh[k], a = (d.i * 2.399) % (Math.PI * 2)
      next[d.i * 2] = (hit >= 0 ? next[hit * 2] : 0) + 6 * Math.cos(a); next[d.i * 2 + 1] = (hit >= 0 ? next[hit * 2 + 1] : 0) + 6 * Math.sin(a)
    })
    // Labels: top clusters, plus sub-clusters once zoomed in (see drawGroupLabels).
    state.groups = []
    for (const [level, names] of [['l1', 'names1'], ['l2', 'names2']]) {
      const acc = new Map()
      for (let r = 0; r < m.ids.length; r++) { const c = m[level][r]; const a = acc.get(c) || { x: 0, y: 0, xx: 0, yy: 0, n: 0 }; const x = m.xy[r * 2], y = m.xy[r * 2 + 1]; a.x += x; a.y += y; a.xx += x * x; a.yy += y * y; a.n++; acc.set(c, a) }
      for (const [c, a] of acc) { const x = a.x / a.n, y = a.y / a.n; state.groups.push({ x, y, r: Math.sqrt(Math.max(1, a.xx / a.n - x * x + a.yy / a.n - y * y)) * 0.8, key: m[names][c] || 'Unnamed', n: a.n, level }) }
    }
    if (missing.length) state.groups.push({ x: 500, y: 1060, r: 80, key: 'Not embedded yet', n: missing.length, level: 'l1' })
    state.axes = null
  } else if (state.mode === 'galaxy') {
    const group = CATS[state.group].key
    const g = galaxy(docs, group, () => '', (d) => d.upload || 0)
    next = g.pos; state.groups = g.groups; state.axes = null
  } else {
    const s = scatter(docs, NUMS[state.x].of, NUMS[state.y].of)
    next = s.pos; state.groups = []; state.axes = { x: s.x, y: s.y }
  }
  state.from = state.pos && animate ? Float64Array.from(state.pos) : Float64Array.from(next)
  state.to = next
  state.pos = Float64Array.from(state.from)
  state.anim = animate ? performance.now() : -Infinity
  fit()
  requestDraw()
}

function fit() {
  const p = state.to
  if (!p || !p.length) return
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
  for (let i = 0; i < p.length; i += 2) { x0 = Math.min(x0, p[i]); x1 = Math.max(x1, p[i]); y0 = Math.min(y0, p[i + 1]); y1 = Math.max(y1, p[i + 1]) }
  const { width, height } = size()
  const pad = state.mode === 'scatter' ? 50 : 30
  const left = leftInset(width), right = state.mode === 'scatter' ? 90 : 0
  const w = width - left - right - pad * 2, h = height - pad * 2 - (state.mode === 'scatter' ? 30 : 0)
  if (state.mode === 'scatter') {
    // Axes use independent x/y scales so both dimensions fill the view.
    state.view = { s: w / ((x1 - x0) || 1), sY: h / ((y1 - y0) || 1), x: left + pad - x0 * (w / ((x1 - x0) || 1)), y: pad - y0 * (h / ((y1 - y0) || 1)) }
  } else {
    const s = Math.min(w / ((x1 - x0) || 1), h / ((y1 - y0) || 1))
    state.view = { s, sY: s, x: left + pad + (w - (x1 - x0) * s) / 2 - x0 * s, y: pad + (h - (y1 - y0) * s) / 2 - y0 * s }
  }
  // Zoom is measured relative to this whole-archive view.
  state.fitS = state.view.s
  requestDraw()
}

// ---------- color ----------

const leftInset = (width) => window.matchMedia('(max-width: 800px)').matches ? 0 : Math.min(280, width * 0.35)

// ---------- drawing ----------
const canvas = $('space'), ctx = canvas.getContext('2d')
let pending = false
function size() { return { width: canvas.clientWidth, height: canvas.clientHeight } }
function requestDraw() { if (!pending) { pending = true; requestAnimationFrame(draw) } }
const sx = (x) => x * state.view.s + state.view.x
const sy = (y) => y * (state.view.sY ?? state.view.s) + state.view.y

function draw() {
  pending = false
  const now = performance.now()
  const { width, height } = size(), dpr = window.devicePixelRatio || 1
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) { canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr) }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  // Transparent canvas: the CSS sky gradient shows through.
  ctx.clearRect(0, 0, width, height)
  if (!state.docs.length) return
  const t = Math.min(1, (now - state.anim) / 700), e = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2
  for (let i = 0; i < state.pos.length; i++) state.pos[i] = state.from[i] + (state.to[i] - state.from[i]) * e
  if (t < 1) requestDraw()

  if (state.mode === 'galaxy' && t === 1) {
    ctx.strokeStyle = 'rgba(170,170,210,0.13)'; ctx.lineWidth = 1
    for (const g of state.groups) { ctx.beginPath(); ctx.arc(sx(g.x), sy(g.y), g.r * state.view.s, 0, Math.PI * 2); ctx.stroke() }
  }
  if (state.axes) drawAxes(width, height)

  // Every video is its thumbnail (user request 2026-11-20). Matches are drawn on top; the rest are faint.
  const tw = thumbWidth(), th = tw * 9 / 16
  const off = [], on = []
  const m = tw
  for (const d of state.docs) {
    if (d.i >= state.shown) break
    // Without a thumbnail fingerprint (none yet, or gone from YouTube) a video is hidden at every zoom for now (user request 2026-11-21).
    if (!d.lookRaw) continue
    const x = sx(state.pos[d.i * 2]), y = sy(state.pos[d.i * 2 + 1])
    if (x < -m || y < -m || x > width + m || y > height + m) continue
    ;(!state.matched || state.matched[d.i] ? on : off).push(d.i)
  }
  ctx.globalAlpha = 0.12
  drawThumbs(off, tw, th, false)
  ctx.globalAlpha = 1
  drawThumbs(on, tw, th, on.length <= MAX_THUMBS)
  state.thumbW = tw
  state.thumbOrder = on
  // 2px surface ring on highlighted marks, then rings for focus (a frame around thumbnails).
  const ring = (i, color, w, extra = 3) => {
    ctx.strokeStyle = color; ctx.lineWidth = w; ctx.beginPath()
    const x = sx(state.pos[i * 2]), y = sy(state.pos[i * 2 + 1]), rw = tw
    ctx.rect(x - rw / 2 - extra, y - rw * 9 / 32 - extra, rw + extra * 2, rw * 9 / 16 + extra * 2)
    ctx.stroke()
  }
  for (const [d] of state.near) ring(d.i, 'rgba(200,202,225,0.7)', 1, 2)
  if (state.selected >= 0) ring(state.selected, '#ffffff', 2, 4)
  if (state.hot >= 0) ring(state.hot, '#ffffff', 2, 4)

  if ((state.mode === 'galaxy' || ['meaning', 'visual'].includes(state.mode)) && t === 1) drawGroupLabels(width)
  if (state.box) {
    const { x0, y0, x1, y1 } = state.box
    // Square corners and no fill (user request 2026-11-21): just the outline.
    ctx.beginPath(); ctx.rect(Math.round(Math.min(x0, x1)) + 0.5, Math.round(Math.min(y0, y1)) + 0.5, Math.round(Math.abs(x1 - x0)), Math.round(Math.abs(y1 - y0)))
    // Marching ants: the dashes crawl around the border while the selection is drawn.
    ctx.strokeStyle = 'rgba(255,255,255,0.4)'; ctx.lineWidth = 1; ctx.setLineDash([4, 3]); ctx.lineDashOffset = -(now / 60) % 7
    ctx.stroke(); ctx.setLineDash([]); ctx.lineDashOffset = 0
    requestDraw()
  }
}

// User requests 2026-11-20: every video is drawn as its thumbnail, without frame or rounded corners, and the size
// grows with the zoom like the dots used to, but more slowly, so zooming in still spreads them apart.
// Small sizes draw the 4×4 colour fingerprint from /api/videos ("look") out of one atlas; larger sizes load the real image
// for at most MAX_THUMBS matches on screen.
// User requests 2026-11-21: real thumbnails load earlier: at any size, once at most MAX_THUMBS matches are on screen.
const MAX_THUMBS = 3000, REAL_FROM = 0, CELL = 6
// User request 2026-11-22: the 2026-11-21 "grow into free space" sizing jumped around when zoomed in close (it took the
// median gap of whatever was on screen). Removed. Second request the same day ("the thumbnails dont stay big. i want that at
// some zoom level thumbnails stop scaling"): thumbnails now grow with the zoom (linear, like the map itself) from 9 px at the
// whole-archive view and stop at THUMB_MAX px wide, reached at about 13× zoom; zooming further only spreads them apart.
const THUMB_MAX = 120
function thumbWidth() {
  const ratio = state.fitS ? state.view.s / state.fitS : 1
  return Math.max(7, Math.min(THUMB_MAX, 9 * ratio))
}

let atlas = null
function buildAtlas() {
  // One 6×6 cell per video: the 4×4 fingerprint with its edge repeated, so smoothing never bleeds into a neighbour.
  const cols = 256, rows = Math.ceil(state.docs.length / cols)
  atlas = document.createElement('canvas'); atlas.width = cols * CELL; atlas.height = Math.max(1, rows * CELL)
  const g = atlas.getContext('2d'), img = g.createImageData(atlas.width, atlas.height), px = img.data
  for (const d of state.docs) {
    const ox = (d.i % cols) * CELL, oy = Math.floor(d.i / cols) * CELL
    const bin = typeof d.lookRaw === 'string' && d.lookRaw.length === 64 ? atob(d.lookRaw.replaceAll('-', '+').replaceAll('_', '/')) : null
    for (let y = 0; y < CELL; y++) for (let x = 0; x < CELL; x++) {
      const c = Math.min(3, Math.max(0, y - 1)) * 4 + Math.min(3, Math.max(0, x - 1)), p = ((oy + y) * atlas.width + ox + x) * 4
      if (bin) { px[p] = bin.charCodeAt(c * 3); px[p + 1] = bin.charCodeAt(c * 3 + 1); px[p + 2] = bin.charCodeAt(c * 3 + 2) }
      else { px[p] = 40; px[p + 1] = 42; px[p + 2] = 52 }
      px[p + 3] = 255
    }
  }
  g.putImageData(img, 0, 0)
}
const thumbs = new Map()
function thumb(id, big) {
  // Above 320 px the 480 px image (4:3 with black bars, cropped when drawn) stays sharp.
  const key = id + (big ? ':hq' : '')
  let img = thumbs.get(key)
  if (!img) {
    if (thumbs.size > 6000) thumbs.delete(thumbs.keys().next().value)
    img = new Image(); img.decoding = 'async'; img.onload = requestDraw
    img.src = `https://i.ytimg.com/vi/${id}/${big ? 'hqdefault' : 'mqdefault'}.jpg`
    thumbs.set(key, img)
  }
  return img
}
function drawThumbs(ids, tw, th, real) {
  const cols = 256, big = tw > 320
  ctx.imageSmoothingEnabled = true
  for (const i of ids) {
    const l = sx(state.pos[i * 2]) - tw / 2, t = sy(state.pos[i * 2 + 1]) - th / 2
    const img = real && tw >= REAL_FROM ? thumb(state.docs[i].id, big) : null
    // hqdefault is 480×360 with black bars: draw only its 16:9 middle (480×270).
    if (img && img.complete && img.naturalWidth) {
      if (big) ctx.drawImage(img, 0, img.naturalHeight * 0.125, img.naturalWidth, img.naturalHeight * 0.75, l, t, tw, th)
      else ctx.drawImage(img, l, t, tw, th)
    } else if (big && real && thumbs.get(state.docs[i].id)?.naturalWidth) ctx.drawImage(thumbs.get(state.docs[i].id), l, t, tw, th)
    else if (atlas) ctx.drawImage(atlas, (i % cols) * CELL + 1, Math.floor(i / cols) * CELL + 1, 4, 4, l, t, tw, th)
  }
}

function drawGroupLabels(width) {
  ctx.font = '12px Arial, Helvetica, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'bottom'
  const placed = []
  for (const g of state.groups) {
    const rad = g.r * state.view.s
    if (rad < 18) continue
    // Map modes: top-cluster names until they get large, then the sub-cluster names take over.
    if (g.level === 'l1' && rad > 160) continue
    if (g.level === 'l2' && rad < 45) continue
    const x = sx(g.x), y = g.level ? sy(g.y) : sy(g.y) - rad - 3
    let text = String(g.key)
    const max = Math.max(60, rad * 2.4)
    while (text.length > 3 && ctx.measureText(text + '…').width > max) text = text.slice(0, -1)
    if (text !== String(g.key)) text += '…'
    const label = `${text} ${g.n}`
    const w = ctx.measureText(label).width
    // User requests 2026-11-21: 6 px padding left/right, solid black, fully rounded (100 px radius, a pill).
    const box = [x - w / 2 - 6, y - 16, x + w / 2 + 6, y + 2]
    if (placed.some((b) => !(box[2] < b[0] || box[0] > b[2] || box[3] < b[1] || box[1] > b[3]))) continue
    placed.push(box)
    ctx.fillStyle = '#000000'; ctx.beginPath(); ctx.roundRect(box[0], box[1], box[2] - box[0], box[3] - box[1], 100); ctx.fill()
    ctx.fillStyle = '#d2d3dc'; ctx.fillText(label, x, y)
  }
}

function drawAxes(width, height) {
  ctx.strokeStyle = 'rgba(170,170,210,0.15)'; ctx.fillStyle = '#91939f'; ctx.lineWidth = 1
  ctx.font = '11px Arial, Helvetica, sans-serif'
  const [x0, x1] = state.axes.x, [y0, y1] = state.axes.y
  const X = NUMS[state.x], Y = NUMS[state.y]
  ctx.textAlign = 'center'; ctx.textBaseline = 'top'
  // Grid steps halve as you zoom in (user request 2026-11-21): the finest step that keeps lines at least ~110 px (x) / 70 px (y) apart.
  const fine = (px0, px1, minGap, coarse) => {
    const span = Math.abs(px1 - px0) || 1
    let step = coarse
    while (step / 2 * span >= minGap && step > 1e-4) step /= 2
    return step
  }
  const visible = (px0, px1, lo, hi, step) => {
    const a = (lo - px0) / (px1 - px0), b = (hi - px0) / (px1 - px0)
    const from = Math.max(0, Math.floor(Math.min(a, b) / step) * step), to = Math.min(1, Math.max(a, b))
    const out = []
    for (let k = Math.round(from / step); k * step <= to + 1e-9; k++) out.push(k * step)
    return out
  }
  const xs = fine(sx(0), sx(100), 110, width < 600 ? 0.5 : 0.25)
  for (const f of visible(sx(0), sx(100), 0, width, xs)) {
    const x = sx(f * 100)
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke()
    ctx.fillText(X.fmt(x0 + f * (x1 - x0)), x, height - 30)
  }
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
  const ys = fine(sy(100), sy(0), 70, 0.25)
  for (const f of visible(sy(100), sy(0), 0, height, ys)) {
    const y = sy(100 - f * 100)
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke()
    ctx.fillText(Y.fmt(y0 + f * (y1 - y0)), width - 84, y - 7)
  }
  ctx.fillStyle = '#d2d3dc'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'
  ctx.fillText(`${X.label} →`, (width + leftInset(width)) / 2, height - 4)
  ctx.save(); ctx.translate(width - 8, height / 2); ctx.rotate(-Math.PI / 2); ctx.fillText(`${Y.label} →`, 0, 0); ctx.restore()
  ctx.fillStyle = '#91939f'; ctx.textAlign = 'left'; ctx.textBaseline = 'top'
  ctx.fillText('unknown values sit left / below the axes', sx(-12), sy(108))
}

// ---------- interaction ----------
function nearest(px, py, radius = 10) {
  // With thumbnails, the topmost thumbnail under the pointer wins.
  if (state.thumbW) {
    for (let k = state.thumbOrder.length - 1; k >= 0; k--) {
      const i = state.thumbOrder[k], tw = state.thumbW, th = tw * 9 / 16
      if (Math.abs(sx(state.pos[i * 2]) - px) <= tw / 2 && Math.abs(sy(state.pos[i * 2 + 1]) - py) <= th / 2) return i
    }
  }
  let best = -1, dist = radius * radius
  for (let i = 0; i < state.docs.length; i++) {
    if (i >= state.shown) break
    if ((state.matched && !state.matched[i]) || !state.docs[i].lookRaw) continue
    const dx = sx(state.pos[i * 2]) - px, dy = sy(state.pos[i * 2 + 1]) - py, d2 = dx * dx + dy * dy
    if (d2 < dist) { dist = d2; best = i }
  }
  return best
}

let drag = null
canvas.addEventListener('pointerdown', (e) => {
  drag = { x: e.clientX, y: e.clientY, vx: state.view.x, vy: state.view.y, moved: false, box: (boxTool() || e.shiftKey) && e.pointerType !== 'touch' }
  canvas.setPointerCapture(e.pointerId)
})
canvas.addEventListener('pointermove', (e) => {
  const rect = canvas.getBoundingClientRect(), px = e.clientX - rect.left, py = e.clientY - rect.top
  if (drag) {
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y
    if (Math.abs(dx) + Math.abs(dy) > 3) { drag.moved = true; if (!drag.box) canvas.classList.add('dragging') }
    if (drag.box) {
      if (drag.moved) { state.box = { x0: drag.x - rect.left, y0: drag.y - rect.top, x1: px, y1: py }; showTooltip(-1); requestDraw() }
      return
    }
    state.view.x = drag.vx + dx; state.view.y = drag.vy + dy
    state.hover = -1; showTooltip(-1)
    requestDraw(); return
  }
  const i = nearest(px, py)
  if (i !== state.hover) { state.hover = i; requestDraw() }
  showTooltip(i, px, py)
})
canvas.addEventListener('pointerup', (e) => {
  const rect = canvas.getBoundingClientRect()
  if (drag && !drag.moved) select(nearest(e.clientX - rect.left, e.clientY - rect.top, 14))
  else if (drag?.box && state.box) selectArea(state.box)
  state.box = null
  drag = null; canvas.classList.remove('dragging')
})
canvas.addEventListener('pointerleave', () => { state.hover = -1; showTooltip(-1); requestDraw() })
canvas.addEventListener('wheel', (e) => {
  e.preventDefault()
  const rect = canvas.getBoundingClientRect(), px = e.clientX - rect.left, py = e.clientY - rect.top
  const f = Math.exp(-e.deltaY * 0.0015)
  state.view.x = px - (px - state.view.x) * f; state.view.y = py - (py - state.view.y) * f; state.view.s *= f; state.view.sY = (state.view.sY ?? state.view.s / f) * f
  requestDraw()
}, { passive: false })
canvas.addEventListener('dblclick', fit)
window.addEventListener('resize', () => { fit() })
// User request 2026-11-21 (swapped from 2026-11-18): dragging moves the map (hand); holding the space bar selects an area.
// S swaps which tool is the default; Shift-drag always selects.
const boxTool = () => state.boxMode !== state.spaceHeld
function showTool() { canvas.classList.toggle('boxing', boxTool()); canvas.classList.toggle('panning', !boxTool()) }
function setSpaceHeld(on) { state.spaceHeld = on; showTool() }
window.addEventListener('keyup', (e) => { if (e.code === 'Space' && state.spaceHeld) { e.preventDefault(); setSpaceHeld(false) } })
window.addEventListener('blur', () => setSpaceHeld(false))
window.addEventListener('keydown', (e) => {
  const typing = ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName)
  if (e.code === 'Space' && !typing) { e.preventDefault(); if (!state.spaceHeld) setSpaceHeld(true); return }
  if (e.key === '/' && !typing) { e.preventDefault(); $('q').focus() }
  if (e.key === 'Escape') { if (typing) document.activeElement.blur(); clearAll() }
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return
  if (e.key === 'f' || e.key === 'F') fit()
  if (e.key === 's' || e.key === 'S') setBoxMode(!state.boxMode)
  if (e.key === 'r' || e.key === 'R') randomVideo()
  if (e.key === '+' || e.key === '=') zoom(1.4)
  if (e.key === '-' || e.key === '_') zoom(1 / 1.4)
  if (e.key === 'ArrowRight' || e.key === 'j' || e.key === 'J') { e.preventDefault(); step(1) }
  if (e.key === 'ArrowLeft' || e.key === 'k' || e.key === 'K') { e.preventDefault(); step(-1) }
})

// ---------- actions ----------
function zoom(f) {
  const { width, height } = size(), px = (width + leftInset(width)) / 2, py = height / 2
  state.view.x = px - (px - state.view.x) * f; state.view.y = py - (py - state.view.y) * f
  state.view.s *= f; state.view.sY = (state.view.sY ?? state.view.s / f) * f
  requestDraw()
}
function randomVideo() {
  const list = current()
  if (!list.length) return
  const d = list[Math.floor(Math.random() * list.length)]
  select(d.i); center(d.i)
}
// Prev/next walk the current matches in the same order as the Matches list.
function step(dir) {
  const order = state.order
  if (!order.length) return
  const at = order.indexOf(state.selected)
  const next = at < 0 ? (dir > 0 ? 0 : order.length - 1) : (at + dir + order.length) % order.length
  if (next >= state.resultLimit) { state.resultLimit = Math.ceil((next + 1) / 200) * 200; renderResults() }
  select(order[next]); center(order[next])
}
function clearAll() {
  $('q').value = ''
  state.area = null
  select(-1); runQuery()
}
// Area selection: the dots inside a dragged rectangle become a filter on top of the search, so the Matches list,
// facets and Prev/Next walk only them (user request 2026-11-18). It keeps the same videos when the layout changes.
function selectArea({ x0, y0, x1, y1 }) {
  const [l, r, t, b] = [Math.min(x0, x1), Math.max(x0, x1), Math.min(y0, y1), Math.max(y0, y1)]
  const area = new Uint8Array(state.docs.length)
  let n = 0
  for (let i = 0; i < state.docs.length; i++) {
    // A new area replaces the old one, so only the search decides which dots can be picked.
    if (state.match && !state.match(state.docs[i])) continue
    const x = sx(state.pos[i * 2]), y = sy(state.pos[i * 2 + 1])
    if (x >= l && x <= r && y >= t && y <= b) { area[i] = 1; n++ }
  }
  if (!n) return
  state.area = area
  runQuery()
  select(state.order[0])
}
function clearArea() { state.area = null; runQuery() }
function setBoxMode(on) {
  state.boxMode = on
  showTool()
}
function flash(button, text) {
  const original = button.textContent
  button.textContent = text; button.classList.add('done')
  setTimeout(() => { button.textContent = original; button.classList.remove('done') }, 1400)
}
async function copyLink() {
  saveHash()
  try { await navigator.clipboard.writeText(location.href); flash($('copy'), 'Copied') }
  catch { window.prompt('Copy this link', location.href) }
}
function resetView() {
  Object.assign(state, defaults())
  state.expanded.clear(); state.resultLimit = 80; state.area = null
  $('q').value = ''
  for (const key of ['group', 'x', 'y']) $(key).value = state[key]
  $('k').value = String(state.k)
  computeTopics(); select(-1)
  setMode(state.mode); runQuery()
}

function describe(d) { return `${d.channel || 'unknown channel'} · ${formatDuration(d.seconds)} · uploaded ${formatDate(d.upload)}` }

function showTooltip(i, px, py) {
  const tip = $('tooltip')
  if (i < 0) { tip.hidden = true; return }
  const d = state.docs[i]
  const img = el('img'); img.alt = ''; img.src = `https://i.ytimg.com/vi/${d.id}/hqdefault.jpg` // 480 px, black bars cropped by object-fit
  tip.replaceChildren(img, el('div', '', d.title || 'Untitled'), el('div', 'meta', describe(d)),
    el('div', 'meta', `${CATS.topic.key(d)} · ${d.script} · ${d.verified ? 'verified' : 'unverified'}`))
  const { width, height } = size()
  tip.style.left = Math.min(px + 14, width - 372) + 'px'
  tip.style.top = Math.min(py + 14, height - 300) + 'px'
  tip.hidden = false
}

// Similar by meaning (offline kNN) when the video is on the map; otherwise the in-browser title match.
function mapNeighbours(d) {
  const m = state.map?.maps?.text, r = d.m?.text
  if (!m || !(r >= 0)) return null
  const out = []
  for (let k = 0; k < 8; k++) { const j = m.docOf[m.nb[r * 8 + k]]; if (j >= 0) out.push([state.docs[j], m.nbSim[r * 8 + k]]) }
  return out
}

function select(i) {
  state.selected = i
  state.near = i >= 0 ? mapNeighbours(state.docs[i]) || neighbours(state.docs, state.docs[i]) : []
  for (const li of $('results').children) li.classList.toggle('current', Number(li.dataset.i) === i)
  renderDetail(); requestDraw()
}

function center(i) {
  const { width, height } = size()
  state.view.x = (width + leftInset(width)) / 2 - state.pos[i * 2] * state.view.s
  state.view.y = height / 2 - state.pos[i * 2 + 1] * (state.view.sY ?? state.view.s)
  requestDraw()
}

const quote = (v) => /[\s"]/.test(v) ? `"${String(v).replaceAll('"', '')}"` : String(v)
function addFilter(token, value) {
  const q = $('q')
  q.value = (q.value.trim() + ' ' + `${token}:${quote(value)}`).trim()
  runQuery()
}

function renderDetail() {
  const box = $('detail')
  if (state.selected < 0) { box.hidden = true; box.replaceChildren(); return }
  const d = state.docs[state.selected]
  const link = el('a', '', d.title || 'Untitled'); link.href = `https://www.youtube.com/watch?v=${d.id}`; link.target = '_blank'; link.rel = 'noopener noreferrer'
  const img = el('img'); img.alt = ''; img.src = `https://i.ytimg.com/vi/${d.id}/hqdefault.jpg`
  const imgLink = el('a'); imgLink.href = link.href; imgLink.target = '_blank'; imgLink.rel = 'noopener noreferrer'; imgLink.append(img)
  const dl = el('dl')
  for (const [k, v] of [['Channel', d.channel || '–'], ['Duration', formatDuration(d.seconds)], ['Uploaded', formatDate(d.upload)], ['Found', formatDate(d.found)],
    ['Topic', CATS.topic.key(d)], ...(state.map ? [['Meaning', `${CATS.meaning.key(d)} › ${CATS.meaningSub.key(d)}`], ...(state.map.maps.image ? [['Thumbnail content', CATS.visual.key(d)]] : []), ['Title kind', CATS.titleKind.key(d)]] : []), ['Thumbnail look', CATS.look.key(d)], ['Writing', d.script], ['Search term', d.term || '–'], ['Status', d.verified ? 'verified zero' : d.fromOldCrawler ? 'unverified (found by the 2024–25 crawler)' : 'unverified (looked like zero once)']]) dl.append(el('dt', '', k), el('dd', '', v))
  const actions = el('div', 'actions')
  for (const [label, key] of [['Same channel', 'channel'], ['Same topic', 'topic'], ...(state.map ? [['Same meaning', 'meaningSub']] : []), ['Same look', 'look'], ['Same term', 'term']]) {
    const b = el('button', '', label); b.type = 'button'
    b.addEventListener('click', () => addFilter(CATS[key].token, CATS[key].key(d)))
    actions.append(b)
  }
  const close = el('button', '', 'Close'); close.type = 'button'; close.addEventListener('click', () => select(-1)); actions.append(close)
  const near = el('ol')
  for (const [n, s] of state.near) {
    const li = el('li', '', `${n.title || 'Untitled'} (${Math.round(s * 100)}%)`); li.tabIndex = 0
    li.addEventListener('click', () => { select(n.i); center(n.i) })
    li.addEventListener('keydown', (e) => { if (e.key === 'Enter') { select(n.i); center(n.i) } })
    near.append(li)
  }
  const nav = el('div', 'nav'), at = state.order.indexOf(d.i), n = state.order.length
  const prev = el('button', '', 'Prev'); prev.type = 'button'; prev.title = 'Previous match (← or K)'; prev.addEventListener('click', () => step(-1))
  const next = el('button', '', 'Next'); next.type = 'button'; next.title = 'Next match (→ or J)'; next.addEventListener('click', () => step(1))
  prev.disabled = next.disabled = !n || (n === 1 && at === 0)
  nav.append(prev, el('span', 'count', at >= 0 ? `${(at + 1).toLocaleString('en-US')} of ${n.toLocaleString('en-US')}` : `not in ${n.toLocaleString('en-US')} matches`), next)
  box.replaceChildren(nav, imgLink, link, dl, actions, el('h2', '', state.near.length ? (d.m?.text >= 0 ? 'Similar by meaning' : 'Similar titles') : 'No similar titles'), near)
  box.hidden = false
}

// ---------- search, results, facets ----------
function runQuery() {
  state.query = $('q').value
  state.resultLimit = 80
  state.match = matcher(state.query, { topic: CATS.topic.key, look: CATS.look.key, meaning: CATS.meaning.key, sub: CATS.meaningSub.key, visual: CATS.visual.key, kind: CATS.titleKind.key, repost: CATS.repost.key, gone: CATS.gone.key, reuse: CATS.reuse.key })
  state.matched = state.match || state.area ? Uint8Array.from(state.docs, (d) => (!state.match || state.match(d)) && (!state.area || state.area[d.i]) ? 1 : 0) : null
  renderResults(); renderFacets(); renderDetail(); saveHash(); requestDraw()
}

function current() { return state.matched ? state.docs.filter((d) => state.matched[d.i]) : state.docs }

function renderResults() {
  const list = current()
  const channels = new Set(list.map((d) => d.channelId || d.channel)).size
  const verified = list.filter((d) => d.verified).length
  $('summary').textContent = `${list.length.toLocaleString('en-US')} of ${state.docs.length.toLocaleString('en-US')} videos · ${channels.toLocaleString('en-US')} channels · ${verified.toLocaleString('en-US')} verified`
  const chip = $('area')
  chip.hidden = !state.area
  if (state.area) {
    const clear = el('button', '', 'Clear area'); clear.type = 'button'; clear.title = 'Show all matches again (Esc clears everything)'; clear.addEventListener('click', clearArea)
    chip.replaceChildren(el('span', '', 'Area selection'), clear)
  }
  const ol = $('results')
  const words = state.query.toLowerCase().split(/\s+/).filter((w) => w && !w.includes(':'))
  const score = (d) => words.reduce((s, w) => s + (d.title.toLowerCase().includes(w) ? 2 : 0) + (d.channel.toLowerCase().includes(w) ? 1 : 0), 0)
  const all = [...list].sort((a, b) => score(b) - score(a) || b.found - a.found)
  state.order = all.map((d) => d.i)
  const sorted = all.slice(0, state.resultLimit)
  const frag = document.createDocumentFragment()
  for (const d of sorted) {
    const li = el('li', d.i === state.selected ? 'current' : ''); li.tabIndex = 0; li.dataset.i = d.i
    const img = el('img'); img.alt = ''; img.loading = 'lazy'; img.src = `https://i.ytimg.com/vi/${d.id}/mqdefault.jpg`
    const text = el('div'); text.append(el('div', 't', d.title || 'Untitled'), el('div', 'meta', describe(d)))
    li.append(img, text)
    li.addEventListener('mouseenter', () => { state.hot = d.i; requestDraw() })
    li.addEventListener('mouseleave', () => { state.hot = -1; requestDraw() })
    li.addEventListener('click', () => { select(d.i); center(d.i) })
    li.addEventListener('keydown', (e) => { if (e.key === 'Enter') { select(d.i); center(d.i) } })
    frag.append(li)
  }
  if (list.length > sorted.length) {
    const li = el('li', 'more'), b = el('button', 'more-button', `Show ${Math.min(200, list.length - sorted.length).toLocaleString('en-US')} more of ${(list.length - sorted.length).toLocaleString('en-US')} remaining`)
    b.type = 'button'; b.addEventListener('click', () => { state.resultLimit += 200; renderResults() })
    li.append(b); frag.append(li)
  }
  ol.replaceChildren(frag)
}

function renderFacets() {
  const list = current()
  const frag = document.createDocumentFragment()
  for (const key of [...(state.map ? ['meaning', 'gone', 'reuse', 'titleKind', 'repost'] : []), 'topic', 'look', 'script', 'year', 'duration', 'channel', 'term', 'status']) {
    const cat = CATS[key]
    let rows = countBy(list, cat.key)
    if (cat.sort) rows.sort((a, b) => String(b[0]).localeCompare(String(a[0])))
    if (cat.order) rows.sort((a, b) => cat.order.indexOf(a[0]) - cat.order.indexOf(b[0]))
    const open = state.expanded.has(key)
    const shown = open ? rows.slice(0, 500) : rows.slice(0, 10)
    const max = Math.max(1, ...shown.map(([, n]) => n))
    const section = el('section', 'facet')
    section.append(el('h2', '', `${cat.label} · ${rows.length}`))
    for (const [value, n] of shown) {
      const b = el('button'); b.type = 'button'; b.title = `Filter: ${cat.token}:${value}`
      const bar = el('span', 'bar'), fill = el('i'); fill.style.width = (n / max * 100) + '%'; bar.append(fill)
      b.append(el('span', '', String(value)), bar, el('span', '', n.toLocaleString('en-US')))
      b.addEventListener('click', () => addFilter(cat.token, value))
      section.append(b)
    }
    if (rows.length > 10) {
      const hidden = rows.length - shown.length
      const b = el('button', 'more-button', open ? (hidden > 0 ? `Show fewer · ${hidden.toLocaleString('en-US')} not listed` : 'Show fewer') : `+ ${(rows.length - 10).toLocaleString('en-US')} more`)
      b.type = 'button'; b.setAttribute('aria-expanded', String(open))
      b.addEventListener('click', () => { if (open) state.expanded.delete(key); else state.expanded.add(key); renderFacets() })
      section.append(b)
    }
    frag.append(section)
  }
  $('facets').replaceChildren(frag)
}

// ---------- controls & URL state ----------
function fill(select, options, value) {
  select.replaceChildren(...Object.entries(options).map(([k, v]) => { const o = el('option', '', v.label ?? v); o.value = k; return o }))
  select.value = value
}
function saveHash() {
  const p = new URLSearchParams({ mode: state.mode, group: state.group, x: state.x, y: state.y, k: String(state.k) })
  if (state.query) p.set('q', state.query)
  history.replaceState(null, '', '#' + p)
}
function readHash() {
  const p = new URLSearchParams(location.hash.slice(1))
  if (['galaxy', 'scatter', ...MAP_MODES].includes(p.get('mode'))) state.mode = p.get('mode')
  if (CATS[p.get('group')]) state.group = p.get('group')
  for (const key of ['x', 'y']) if (NUMS[p.get(key)]) state[key] = p.get(key)
  const k = Number(p.get('k')); if ([8, 16, 24, 32, 48, 64].includes(k)) state.k = k
  if (p.get('q')) $('q').value = p.get('q')
}
const MAP_MODES = ['meaning', 'visual']
function pressModes() {
  document.body.classList.toggle('scatter', state.mode === 'scatter')
  document.body.classList.toggle('mapmode', MAP_MODES.includes(state.mode))
  for (const m of ['galaxy', 'scatter', ...MAP_MODES]) $('mode-' + m).setAttribute('aria-pressed', String(state.mode === m))
  // While loading, all four modes show; afterwards the map modes hide only if there is no map.
  if (state.loaded) { $('mode-meaning').hidden = !state.map; $('mode-visual').hidden = !state.map?.maps?.image }
}
function setMode(mode) {
  state.mode = mode
  pressModes()
  layout(); saveHash()
}

function wire() {
  fill($('group'), CATS, state.group)
  fill($('x'), NUMS, state.x)
  fill($('y'), NUMS, state.y)
  fill($('k'), Object.fromEntries([8, 16, 24, 32, 48, 64].map((n) => [n, `${n} clusters`])), String(state.k))
  $('mode-galaxy').addEventListener('click', () => setMode('galaxy'))
  for (const m of MAP_MODES) $('mode-' + m).addEventListener('click', () => setMode(m))
  $('mode-scatter').addEventListener('click', () => setMode('scatter'))
  $('fit').addEventListener('click', fit)
  setBoxMode(state.boxMode)
  $('random').addEventListener('click', randomVideo)
  $('copy').addEventListener('click', copyLink)
  $('reset').addEventListener('click', resetView)
  $('group').addEventListener('change', (e) => { state.group = e.target.value; layout(); saveHash() })
  $('x').addEventListener('change', (e) => { state.x = e.target.value; layout(); saveHash() })
  $('y').addEventListener('change', (e) => { state.y = e.target.value; layout(); saveHash() })
  $('k').addEventListener('change', (e) => {
    state.k = Number(e.target.value); computeTopics()
    runQuery(); renderDetail(); layout(); saveHash()
  })
  let timer
  $('q').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(runQuery, 120) })
}

async function main() {
  readHash()
  pressModes()
  try {
    // The newest archive page is fetched alongside the snapshot: usually all videos found since the bake fit in it.
    const firstPage = fetchPage(null)
    firstPage.catch(() => {})
    const [snap, map] = await Promise.all([loadSnapshot(), loadMap()])
    let rows, src = null
    if (snap) {
      const fresh = snap.top ? await loadSince(snap.top, firstPage) : (await firstPage).videos
      const freshIds = new Set(fresh.map((v) => v.videoId))
      rows = [...fresh]; src = fresh.map(() => -1)
      snap.videos.forEach((v, j) => { if (!freshIds.has(v.videoId)) { rows.push(v); src.push(j) } })
      src = Int32Array.from(src)
    } else rows = await loadAll(firstPage)
    state.map = map; state.loaded = true
    if (MAP_MODES.includes(state.mode) && !map) state.mode = defaults().mode
    pressModes()
    progress.count = rows.length; progress.prep = 0.01; showProgress()
    await nextFrame()
    await prepStep(0.3, () => { const { docs, idf } = buildDocs(rows); state.docs = docs; state.idf = idf })
    if (snap) state.baked = { snap, src }
    await prepStep(0.4, attachMap)
    await prepStep(0.6, computeTopics)
    await prepStep(0.75, computeLooks)
    await prepStep(0.85, computePcs)
    await prepStep(0.95, buildAtlas)
    wire(); runQuery()
    // User request 2026-11-21: videos appear in batches of 500 per frame instead of all at once.
    state.shown = 0
    layout(false)
    $('loading').hidden = true
    document.body.classList.remove('loading')
    const reveal = () => { state.shown = Math.min(state.docs.length, state.shown + 500); requestDraw(); if (state.shown < state.docs.length) requestAnimationFrame(reveal) }
    requestAnimationFrame(reveal)
  } catch (error) {
    $('loading').textContent = 'Could not load the archive. Please reload.'
    document.body.classList.remove('loading')
    console.error(error)
  }
}
main()
