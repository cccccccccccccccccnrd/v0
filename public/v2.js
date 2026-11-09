import {
  buildDocs, kmeans, clusterLabels, pca2, neighbours, matcher, galaxy, scatter, countBy,
  DURATION_ORDER, formatDuration, formatDate, DAY
} from './v2-core.js'

// User choice 2026-11-09: pure RGBCMYK highlight colors (red, green, blue, cyan, magenta, yellow, black).
const SERIES = ['#ff0000', '#00ff00', '#0000ff', '#00ffff', '#ff00ff', '#ffff00', '#000000']
const SERIES_NAMES = ['red', 'green', 'blue', 'cyan', 'magenta', 'yellow', 'black']
const OTHER = '#6d6f7c'
const $ = (id) => document.getElementById(id)
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e }

// Default view chosen by the user on 2026-11-09.
function defaults() { return { mode: 'scatter', group: 'topic', color: 'year', x: 'upload', y: 'ageNow', k: 16 } }

const state = {
  docs: [], idf: null, topics: null, labels: [], pcs: [],
  ...defaults(), resultLimit: 80, expanded: new Set(),
  pinned: [], query: '', match: null, matched: null,
  pos: null, from: null, to: null, anim: 0, groups: [], axes: null,
  view: { s: 1, x: 0, y: 0 }, hover: -1, selected: -1, near: [], hot: -1, order: []
}

const CATS = {
  topic: { label: 'Title topic', key: (d) => d.idx.length ? state.labels[state.topics.assign[d.i]] ?? 'Unclustered' : 'No title words', token: 'topic' },
  script: { label: 'Writing system', key: (d) => d.script, token: 'lang' },
  year: { label: 'Upload year', key: (d) => d.year, token: 'year', sort: true },
  duration: { label: 'Duration', key: (d) => d.duration, token: 'dur', order: DURATION_ORDER },
  channel: { label: 'Channel', key: (d) => d.channel || '(unknown)', token: 'channel' },
  term: { label: 'Search term', key: (d) => d.term || '(none)', token: 'term' },
  status: { label: 'Status', key: (d) => d.verified ? 'verified' : 'unverified', token: 'status' }
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
  termSize: { label: 'Search-term yield (videos)', of: (d) => Math.log2(d.termSize), fmt: (v) => String(Math.round(2 ** v)) }
}

const ageLabel = (days) => days < 60 ? `${Math.round(days)} d` : days < 730 ? `${Math.round(days / 30.4)} mo` : `${(days / 365.25).toFixed(days < 3650 ? 1 : 0)} y`

// ---------- data ----------
async function loadAll() {
  const rows = []
  let cursor = null
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  let requests = 0, retries = 0
  do {
    // The public proxy allows 5 requests/second (burst 20): pace after the burst and back off on 429.
    if (requests++ >= 15) await wait(220)
    const response = await fetch('/api/videos?limit=500' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''), { signal: AbortSignal.timeout(20_000) })
    if (response.status === 429 && retries++ < 20) { await wait(Math.max(1000, Number(response.headers.get('retry-after')) * 1000 || 0)); continue }
    if (!response.ok) throw new Error('Archive request failed')
    const data = await response.json()
    rows.push(...data.videos)
    cursor = data.cursor
    $('loading').textContent = `Loading archive… ${rows.length.toLocaleString('en-US')} videos`
  } while (cursor)
  return rows
}

function computeTopics() {
  const { assign, k } = kmeans(state.docs, state.k)
  state.topics = { assign }
  state.labels = clusterLabels(state.docs, assign, k, state.idf)
  // Duplicate labels get a number so every topic stays addressable.
  const seen = new Map()
  state.labels = state.labels.map((l) => { const n = (seen.get(l) || 0) + 1; seen.set(l, n); return n > 1 ? `${l} (${n})` : l })
}

// ---------- layout ----------
function layout(animate = true) {
  const docs = state.docs
  let next
  if (state.mode === 'galaxy') {
    const group = CATS[state.group].key, wedge = CATS[state.color].key
    const g = galaxy(docs, group, wedge, (d) => d.upload || 0)
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
  requestDraw()
}

// ---------- color ----------
function colorKeys() { return countBy(state.docs, CATS[state.color].key) }
function defaultPins() { state.pinned = colorKeys().slice(0, SERIES.length).map(([k]) => k) }
function slotOf(d) { return state.pinned.indexOf(CATS[state.color].key(d)) }

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

  const r = state.mode === 'scatter' ? Math.max(1.6, Math.min(6, 2 * Math.sqrt(state.view.s / 8))) : Math.max(1.3, Math.min(6, 0.42 * state.view.s))
  const batches = Array.from({ length: SERIES.length + 2 }, () => []) // dimmed, other, then one per series slot
  for (const d of state.docs) {
    const on = !state.matched || state.matched[d.i]
    const slot = slotOf(d)
    batches[!on ? 0 : slot < 0 ? 1 : slot + 2].push(d.i)
  }
  const fills = ['rgba(109,111,124,0.16)', OTHER, ...SERIES]
  batches.forEach((ids, b) => {
    ctx.fillStyle = fills[b]
    ctx.beginPath()
    for (const i of ids) { const x = sx(state.pos[i * 2]), y = sy(state.pos[i * 2 + 1]); if (x < -10 || y < -10 || x > width + 10 || y > height + 10) continue; ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, Math.PI * 2) }
    ctx.fill()
    // Black (K) dots get a light rim so they stay visible on the dark background.
    if (fills[b] === '#000000') { ctx.strokeStyle = 'rgba(255,255,255,0.75)'; ctx.lineWidth = 1; ctx.stroke() }
  })
  // 2px surface ring on highlighted marks, then rings for focus.
  const ring = (i, color, w, extra = 3) => { ctx.strokeStyle = color; ctx.lineWidth = w; ctx.beginPath(); ctx.arc(sx(state.pos[i * 2]), sy(state.pos[i * 2 + 1]), r + extra, 0, Math.PI * 2); ctx.stroke() }
  for (const [d] of state.near) ring(d.i, 'rgba(200,202,225,0.7)', 1, 2)
  if (state.selected >= 0) ring(state.selected, '#ffffff', 2, 4)
  if (state.hot >= 0) ring(state.hot, '#ffffff', 2, 4)
  if (state.hover >= 0) ring(state.hover, '#eef7ff', 1.5, 3)

  if (state.mode === 'galaxy' && t === 1) drawGroupLabels(width)
}

function drawGroupLabels(width) {
  ctx.font = '12px Arial, Helvetica, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'bottom'
  const placed = []
  for (const g of state.groups) {
    const rad = g.r * state.view.s
    if (rad < 18) continue
    const x = sx(g.x), y = sy(g.y) - rad - 3
    let text = String(g.key)
    const max = Math.max(60, rad * 2.4)
    while (text.length > 3 && ctx.measureText(text + '…').width > max) text = text.slice(0, -1)
    if (text !== String(g.key)) text += '…'
    const label = `${text} ${g.n}`
    const w = ctx.measureText(label).width
    const box = [x - w / 2 - 2, y - 14, x + w / 2 + 2, y]
    if (placed.some((b) => !(box[2] < b[0] || box[0] > b[2] || box[3] < b[1] || box[1] > b[3]))) continue
    placed.push(box)
    ctx.fillStyle = 'rgba(0,0,10,0.75)'; ctx.fillRect(box[0], box[1], box[2] - box[0], 14)
    ctx.fillStyle = '#d2d3dc'; ctx.fillText(label, x, y)
  }
}

function drawAxes(width, height) {
  ctx.strokeStyle = 'rgba(170,170,210,0.10)'; ctx.fillStyle = '#91939f'; ctx.lineWidth = 1
  ctx.font = '11px Arial, Helvetica, sans-serif'
  const [x0, x1] = state.axes.x, [y0, y1] = state.axes.y
  const X = NUMS[state.x], Y = NUMS[state.y]
  ctx.textAlign = 'center'; ctx.textBaseline = 'top'
  const step = width < 600 ? 0.5 : 0.25
  for (let f = 0; f <= 1.0001; f += step) {
    const x = sx(f * 100)
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke()
    ctx.fillText(X.fmt(x0 + f * (x1 - x0)), x, height - 30)
  }
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
  for (let f = 0; f <= 1.0001; f += 0.25) {
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
  let best = -1, dist = radius * radius
  for (let i = 0; i < state.docs.length; i++) {
    if (state.matched && !state.matched[i]) continue
    const dx = sx(state.pos[i * 2]) - px, dy = sy(state.pos[i * 2 + 1]) - py, d2 = dx * dx + dy * dy
    if (d2 < dist) { dist = d2; best = i }
  }
  return best
}

let drag = null
canvas.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, vx: state.view.x, vy: state.view.y, moved: false }; canvas.setPointerCapture(e.pointerId) })
canvas.addEventListener('pointermove', (e) => {
  const rect = canvas.getBoundingClientRect(), px = e.clientX - rect.left, py = e.clientY - rect.top
  if (drag) {
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y
    if (Math.abs(dx) + Math.abs(dy) > 3) { drag.moved = true; canvas.classList.add('dragging') }
    state.view.x = drag.vx + dx; state.view.y = drag.vy + dy
    requestDraw(); return
  }
  const i = nearest(px, py)
  if (i !== state.hover) { state.hover = i; requestDraw() }
  showTooltip(i, px, py)
})
canvas.addEventListener('pointerup', (e) => {
  const rect = canvas.getBoundingClientRect()
  if (drag && !drag.moved) select(nearest(e.clientX - rect.left, e.clientY - rect.top, 14))
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
window.addEventListener('keydown', (e) => {
  const typing = ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName)
  if (e.key === '/' && !typing) { e.preventDefault(); $('q').focus() }
  if (e.key === 'Escape') { if (typing) document.activeElement.blur(); clearAll() }
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return
  if (e.key === 'f' || e.key === 'F') fit()
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
  document.querySelector('#results li.current')?.scrollIntoView({ block: 'nearest' })
}
function clearAll() {
  $('q').value = ''
  select(-1); runQuery()
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
  state.expanded.clear(); state.resultLimit = 80
  $('q').value = ''
  for (const key of ['group', 'color', 'x', 'y']) $(key).value = state[key]
  $('k').value = String(state.k)
  computeTopics(); defaultPins(); renderLegend(); select(-1)
  setMode(state.mode); runQuery()
}

function describe(d) { return `${d.channel || 'unknown channel'} · ${formatDuration(d.seconds)} · uploaded ${formatDate(d.upload)}` }

function showTooltip(i, px, py) {
  const tip = $('tooltip')
  if (i < 0) { tip.hidden = true; return }
  const d = state.docs[i]
  const img = el('img'); img.alt = ''; img.src = `https://i.ytimg.com/vi/${d.id}/mqdefault.jpg`
  tip.replaceChildren(img, el('div', '', d.title || 'Untitled'), el('div', 'meta', describe(d)),
    el('div', 'meta', `${CATS.topic.key(d)} · ${d.script} · ${d.verified ? 'verified' : 'unverified'}`))
  const { width, height } = size()
  tip.style.left = Math.min(px + 14, width - 272) + 'px'
  tip.style.top = Math.min(py + 14, height - 230) + 'px'
  tip.hidden = false
}

function select(i) {
  state.selected = i
  state.near = i >= 0 ? neighbours(state.docs, state.docs[i]) : []
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
    ['Topic', CATS.topic.key(d)], ['Writing', d.script], ['Search term', d.term || '–'], ['Status', d.verified ? 'verified zero' : d.fromV1 ? 'unverified (found by the 2024–25 crawler)' : 'unverified (looked like zero once)']]) dl.append(el('dt', '', k), el('dd', '', v))
  const actions = el('div', 'actions')
  for (const [label, key] of [['Same channel', 'channel'], ['Same topic', 'topic'], ['Same term', 'term']]) {
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
  box.replaceChildren(nav, imgLink, link, dl, actions, el('h2', '', state.near.length ? 'Similar titles' : 'No similar titles'), near)
  box.hidden = false
}

// ---------- search, results, facets ----------
function runQuery() {
  state.query = $('q').value
  state.resultLimit = 80
  state.match = matcher(state.query, { topic: CATS.topic.key })
  state.matched = state.match ? Uint8Array.from(state.docs, (d) => state.match(d) ? 1 : 0) : null
  renderResults(); renderFacets(); renderDetail(); saveHash(); requestDraw()
}

function current() { return state.matched ? state.docs.filter((d) => state.matched[d.i]) : state.docs }

function renderResults() {
  const list = current()
  const channels = new Set(list.map((d) => d.channelId || d.channel)).size
  const secs = list.map((d) => d.seconds).filter(Boolean).sort((a, b) => a - b)
  const verified = list.filter((d) => d.verified).length
  $('summary').textContent = `${list.length.toLocaleString('en-US')} of ${state.docs.length.toLocaleString('en-US')} videos · ${channels.toLocaleString('en-US')} channels · ${verified.toLocaleString('en-US')} verified · median ${formatDuration(secs[Math.floor(secs.length / 2)] || 0)}`
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
  for (const key of ['topic', 'script', 'year', 'duration', 'channel', 'term', 'status']) {
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

function renderLegend() {
  const legend = $('legend')
  const rows = colorKeys()
  const frag = document.createDocumentFragment()
  frag.append(el('p', 'hint', `${CATS[state.color].label}: click to color (max ${SERIES.length}: R G B C M Y K)`))
  const ordered = [...state.pinned.filter((k) => k !== null).map((k) => rows.find(([r]) => r === k) || [k, 0]), ...rows.filter(([k]) => !state.pinned.includes(k))]
  for (const [key, n] of ordered.slice(0, 40)) {
    const slot = state.pinned.indexOf(key)
    const b = el('button'); b.type = 'button'; b.setAttribute('aria-pressed', String(slot >= 0))
    const sw = el('span', `swatch ${slot >= 0 ? 's' + slot : 'empty'}`); if (slot >= 0) sw.title = SERIES_NAMES[slot]
    b.append(sw, el('span', '', String(key)), el('span', '', n.toLocaleString('en-US')))
    b.addEventListener('click', () => {
      if (slot >= 0) state.pinned[slot] = null
      else { const free = state.pinned.indexOf(null); if (free >= 0) state.pinned[free] = key; else if (state.pinned.length < SERIES.length) state.pinned.push(key); else state.pinned[SERIES.length - 1] = key }
      renderLegend(); requestDraw()
    })
    frag.append(b)
  }
  frag.append(Object.assign(el('span', 'hint', ''), { textContent: 'gray = everything else' }))
  legend.replaceChildren(frag)
}

// ---------- controls & URL state ----------
function fill(select, options, value) {
  select.replaceChildren(...Object.entries(options).map(([k, v]) => { const o = el('option', '', v.label ?? v); o.value = k; return o }))
  select.value = value
}
function saveHash() {
  const p = new URLSearchParams({ mode: state.mode, group: state.group, color: state.color, x: state.x, y: state.y, k: String(state.k) })
  if (state.query) p.set('q', state.query)
  history.replaceState(null, '', '#' + p)
}
function readHash() {
  const p = new URLSearchParams(location.hash.slice(1))
  if (['galaxy', 'scatter'].includes(p.get('mode'))) state.mode = p.get('mode')
  for (const key of ['group', 'color']) if (CATS[p.get(key)]) state[key] = p.get(key)
  for (const key of ['x', 'y']) if (NUMS[p.get(key)]) state[key] = p.get(key)
  const k = Number(p.get('k')); if ([8, 16, 24, 32, 48, 64].includes(k)) state.k = k
  if (p.get('q')) $('q').value = p.get('q')
}
function setMode(mode) {
  state.mode = mode
  document.body.classList.toggle('scatter', mode === 'scatter')
  $('mode-galaxy').setAttribute('aria-pressed', String(mode === 'galaxy'))
  $('mode-scatter').setAttribute('aria-pressed', String(mode === 'scatter'))
  layout(); saveHash()
}

function wire() {
  fill($('group'), CATS, state.group)
  fill($('color'), CATS, state.color)
  fill($('x'), NUMS, state.x)
  fill($('y'), NUMS, state.y)
  fill($('k'), Object.fromEntries([8, 16, 24, 32, 48, 64].map((n) => [n, `${n} clusters`])), String(state.k))
  $('mode-galaxy').addEventListener('click', () => setMode('galaxy'))
  $('mode-scatter').addEventListener('click', () => setMode('scatter'))
  $('fit').addEventListener('click', fit)
  $('random').addEventListener('click', randomVideo)
  $('copy').addEventListener('click', copyLink)
  $('reset').addEventListener('click', resetView)
  $('group').addEventListener('change', (e) => { state.group = e.target.value; layout(); saveHash() })
  $('color').addEventListener('change', (e) => { state.color = e.target.value; defaultPins(); renderLegend(); if (state.mode === 'galaxy') layout(); else requestDraw(); saveHash() })
  $('x').addEventListener('change', (e) => { state.x = e.target.value; layout(); saveHash() })
  $('y').addEventListener('change', (e) => { state.y = e.target.value; layout(); saveHash() })
  $('k').addEventListener('change', (e) => {
    state.k = Number(e.target.value); computeTopics()
    if (state.color === 'topic') defaultPins()
    renderLegend(); runQuery(); renderDetail(); layout(); saveHash()
  })
  let timer
  $('q').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(runQuery, 120) })
}

async function main() {
  readHash()
  document.body.classList.toggle('scatter', state.mode === 'scatter')
  $('mode-galaxy').setAttribute('aria-pressed', String(state.mode === 'galaxy'))
  $('mode-scatter').setAttribute('aria-pressed', String(state.mode === 'scatter'))
  try {
    const rows = await loadAll()
    $('loading').textContent = `Clustering ${rows.length.toLocaleString('en-US')} titles…`
    await new Promise((r) => setTimeout(r, 20))
    const { docs, idf } = buildDocs(rows)
    state.docs = docs; state.idf = idf
    computeTopics()
    state.pcs = pca2(docs)
    wire(); defaultPins(); renderLegend(); runQuery(); layout(false)
    $('loading').hidden = true
  } catch (error) {
    $('loading').textContent = 'Could not load the archive. Please reload.'
    console.error(error)
  }
}
main()
