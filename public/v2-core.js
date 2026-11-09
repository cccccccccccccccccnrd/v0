// yt0 /v2 analysis core: pure functions, no DOM. Imported by v2.js and by tests.
export const DIMS = 4096
const DAY = 86_400_000

const STOP = new Set(('will more still every down into another want just like over after before about than then there here some any very much also only even back way make made don’t it’s i’m de ve ll re to in is of on at it an be by or as so do up we us no if me my am are amp vs ft feat ep ft. the and for you your with this that from are was were what how why who when where not but all can '
  + 'has have had his her its our their they them she him our out get got one two new video videos official part shorts short '
  + 'de la el en los las del que por con una un le les des du et est pour au sur pas ce il je der die das und ist mit von zu ein eine '
  + 'den dem im auf für nicht sich auch e o os as um uma do da dos das em no na nos nas com para por que é di il lo gli che per non '
  + 've bir bu da ile için и в на с по не что как это из к за от у о а но я ты мы вы он она они')
  .split(' '))

const SCRIPTS = [
  ['Hangul', /\p{Script=Hangul}/u], ['Japanese', /[\p{Script=Hiragana}\p{Script=Katakana}]/u], ['Chinese', /\p{Script=Han}/u],
  ['Cyrillic', /\p{Script=Cyrillic}/u], ['Arabic', /\p{Script=Arabic}/u], ['Hebrew', /\p{Script=Hebrew}/u],
  ['Greek', /\p{Script=Greek}/u], ['Devanagari', /\p{Script=Devanagari}/u], ['Bengali', /\p{Script=Bengali}/u],
  ['Tamil', /\p{Script=Tamil}/u], ['Telugu', /\p{Script=Telugu}/u], ['Thai', /\p{Script=Thai}/u],
  ['Georgian', /\p{Script=Georgian}/u], ['Armenian', /\p{Script=Armenian}/u], ['Latin', /\p{Script=Latin}/u]
]
const DENSE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u

export function scriptOf(text) {
  const counts = new Map()
  for (const ch of String(text || '')) {
    if (!/\p{L}/u.test(ch)) continue
    const hit = SCRIPTS.find(([, re]) => re.test(ch))
    const name = hit ? hit[0] : 'Other'
    counts.set(name, (counts.get(name) || 0) + 1)
  }
  if (!counts.size) return 'No letters'
  // Japanese titles mix kana and Han; any kana means Japanese.
  if (counts.has('Japanese')) return 'Japanese'
  return [...counts].sort((a, b) => b[1] - a[1])[0][0]
}

export function tokenize(text) {
  const out = []
  const clean = String(text || '').normalize('NFKC').toLowerCase()
  for (const word of clean.match(/[\p{L}\p{N}][\p{L}\p{N}\p{M}'’_-]*/gu) || []) {
    if (DENSE.test(word)) {
      // Unspaced scripts: character bigrams stand in for words.
      const chars = [...word].filter((c) => /\p{L}/u.test(c))
      if (chars.length === 1) out.push(chars[0])
      for (let i = 0; i + 1 < chars.length; i++) out.push(chars[i] + chars[i + 1])
      continue
    }
    const w = word.replace(/^['’_-]+|['’_-]+$/g, '')
    if ([...w].length < 2 || /^\d+$/.test(w) || STOP.has(w)) continue
    out.push(w)
  }
  return out
}

function hash(token) {
  let h = 2166136261
  for (let i = 0; i < token.length; i++) { h ^= token.charCodeAt(i); h = Math.imul(h, 16777619) }
  return (h >>> 0) % DIMS
}

export function rng(seed = 1) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function durationBucket(s) {
  if (!s) return 'Unknown'
  if (s < 30) return '< 30 s'
  if (s < 60) return '30–60 s'
  if (s < 300) return '1–5 min'
  if (s < 1200) return '5–20 min'
  if (s < 3600) return '20–60 min'
  return '1 h +'
}
export const DURATION_ORDER = ['< 30 s', '30–60 s', '1–5 min', '5–20 min', '20–60 min', '1 h +', 'Unknown']

const ENTITIES = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' }
export function decodeEntities(text) {
  return String(text || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => e[0] === '#'
    ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e.toLowerCase()] ?? m)
}

/** Turn API rows into analysable documents with TF-IDF title vectors. */
export function buildDocs(rows) {
  const docs = rows.map((v, i) => {
    const upload = Date.parse(v.uploadDate || '')
    const title = decodeEntities(v.title)
    const tokens = tokenize(title)
    return {
      i, id: v.videoId, title, channel: decodeEntities(v.author?.name), channelId: v.author?.id || '',
      term: v.meta?.q || '', seconds: Number(v.seconds) || 0, upload: Number.isFinite(upload) ? upload : NaN,
      found: Number(v.foundAt) || 0, verified: v.verification === 'verified', fromV1: v.evidence?.source === 'arranging/v1', script: scriptOf(title), tokens,
      duration: durationBucket(Number(v.seconds) || 0)
    }
  })
  const df = new Map()
  for (const d of docs) for (const t of new Set(d.tokens)) df.set(t, (df.get(t) || 0) + 1)
  const n = docs.length || 1
  const idf = new Map([...df].map(([t, c]) => [t, Math.log((1 + n) / (1 + c)) + 1]))
  const channelSize = new Map(), termSize = new Map()
  for (const d of docs) {
    channelSize.set(d.channelId || d.channel, (channelSize.get(d.channelId || d.channel) || 0) + 1)
    termSize.set(d.term, (termSize.get(d.term) || 0) + 1)
  }
  for (const d of docs) {
    const weights = new Map()
    for (const t of d.tokens) { const h = hash(t); weights.set(h, (weights.get(h) || 0) + idf.get(t)) }
    let norm = 0
    for (const w of weights.values()) norm += w * w
    norm = Math.sqrt(norm) || 1
    d.idx = Int32Array.from(weights.keys())
    d.val = Float32Array.from([...weights.values()].map((w) => w / norm))
    d.year = Number.isFinite(d.upload) ? String(new Date(d.upload).getUTCFullYear()) : 'Unknown'
    d.channelSize = channelSize.get(d.channelId || d.channel)
    d.termSize = termSize.get(d.term)
  }
  return { docs, idf }
}

function dot(d, dense) {
  let s = 0
  for (let k = 0; k < d.idx.length; k++) s += d.val[k] * dense[d.idx[k]]
  return s
}

/** Spherical k-means++ on title vectors; deterministic for a seed. Empty titles form their own group. */
export function kmeans(docs, k, seed = 7, iterations = 25, minSimilarity = 0.05) {
  const live = docs.filter((d) => d.idx.length)
  const assign = new Int32Array(docs.length).fill(-1)
  if (!live.length) return { assign, centroids: [], k: 0 }
  k = Math.max(1, Math.min(k, live.length))
  const random = rng(seed)
  const centroids = []
  const best = new Float64Array(live.length).fill(Infinity)
  const densify = (d) => { const c = new Float64Array(DIMS); for (let j = 0; j < d.idx.length; j++) c[d.idx[j]] = d.val[j]; return c }
  centroids.push(densify(live[Math.floor(random() * live.length)]))
  while (centroids.length < k) {
    const c = centroids.at(-1)
    let total = 0
    for (let i = 0; i < live.length; i++) { const dist = 1 - dot(live[i], c); best[i] = Math.min(best[i], Math.max(0, dist)); total += best[i] * best[i] }
    let pick = random() * total, chosen = live.length - 1
    for (let i = 0; i < live.length; i++) { pick -= best[i] * best[i]; if (pick <= 0) { chosen = i; break } }
    centroids.push(densify(live[chosen]))
  }
  for (let it = 0; it < iterations; it++) {
    let moved = 0
    for (const d of live) {
      let top = -Infinity, arg = 0
      for (let c = 0; c < centroids.length; c++) { const s = dot(d, centroids[c]); if (s > top) { top = s; arg = c } }
      if (assign[d.i] !== arg) { assign[d.i] = arg; moved++ }
    }
    const sums = centroids.map(() => new Float64Array(DIMS))
    for (const d of live) { const s = sums[assign[d.i]]; for (let j = 0; j < d.idx.length; j++) s[d.idx[j]] += d.val[j] }
    for (let c = 0; c < centroids.length; c++) {
      let norm = 0
      for (const v of sums[c]) norm += v * v
      norm = Math.sqrt(norm)
      if (norm > 0) { for (let j = 0; j < DIMS; j++) sums[c][j] /= norm; centroids[c] = sums[c] }
    }
    if (!moved) break
  }
  // Titles sharing almost nothing with any centroid stay unclustered instead of padding cluster 0.
  for (const d of live) { let top = 0; for (const c of centroids) top = Math.max(top, dot(d, c)); if (top < minSimilarity) assign[d.i] = -1 }
  return { assign, centroids, k: centroids.length }
}

/** Short human labels for clusters: most distinctive real words in each. */
export function clusterLabels(docs, assign, k, idf) {
  const counts = Array.from({ length: k }, () => new Map())
  for (const d of docs) {
    const c = assign[d.i]
    if (c < 0) continue
    for (const t of new Set(d.tokens)) counts[c].set(t, (counts[c].get(t) || 0) + 1)
  }
  return counts.map((m) => [...m].map(([t, c]) => [t, c * idf.get(t) * (t.length > 2 || DENSE.test(t) ? 1 : 0.5)])
    .sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t]) => t).join(' · ') || 'misc')
}

/** First two principal components of the title vectors (power iteration with deflation). */
export function pca2(docs, seed = 3) {
  const n = docs.length
  const mean = new Float64Array(DIMS)
  for (const d of docs) for (let j = 0; j < d.idx.length; j++) mean[d.idx[j]] += d.val[j] / n
  const random = rng(seed)
  const comps = []
  for (let c = 0; c < 2; c++) {
    let v = Float64Array.from({ length: DIMS }, () => random() - 0.5)
    for (let it = 0; it < 40; it++) {
      const next = new Float64Array(DIMS)
      const mv = mean.reduce((s, m, j) => s + m * v[j], 0)
      for (const d of docs) {
        const p = dot(d, v) - mv
        for (let j = 0; j < d.idx.length; j++) next[d.idx[j]] += p * d.val[j]
      }
      let sp = 0
      for (const d of docs) sp += dot(d, v) - mv
      for (let j = 0; j < DIMS; j++) next[j] -= mean[j] * sp
      for (const prev of comps) { const proj = next.reduce((s, x, j) => s + x * prev[j], 0); for (let j = 0; j < DIMS; j++) next[j] -= proj * prev[j] }
      const norm = Math.sqrt(next.reduce((s, x) => s + x * x, 0)) || 1
      v = next.map((x) => x / norm)
    }
    comps.push(v)
  }
  const mv = comps.map((v) => mean.reduce((s, m, j) => s + m * v[j], 0))
  return docs.map((d) => [dot(d, comps[0]) - mv[0], dot(d, comps[1]) - mv[1]])
}

export function neighbours(docs, target, count = 12) {
  if (!target.idx.length) return []
  const dense = new Float64Array(DIMS)
  for (let j = 0; j < target.idx.length; j++) dense[target.idx[j]] = target.val[j]
  return docs.filter((d) => d !== target && d.idx.length).map((d) => [d, dot(d, dense)])
    .filter(([, s]) => s > 0.05).sort((a, b) => b[1] - a[1]).slice(0, count)
}

/** Query: free words AND-match title/channel/term; key:value filters; "quoted values" allowed. */
export function parseQuery(text) {
  const parts = []
  for (const m of String(text || '').matchAll(/(-?)(?:(\w+):)?(?:"([^"]*)"|(\S+))/g)) {
    const value = (m[3] ?? m[4] ?? '').toLowerCase()
    if (!value && !m[2]) continue
    parts.push({ negate: m[1] === '-', key: (m[2] || '').toLowerCase(), value })
  }
  return parts
}

function compare(op, actual, expected) {
  return op === '<' ? actual < expected : op === '>' ? actual > expected : actual === expected
}

export function matcher(text, groupsOf) {
  const parts = parseQuery(text)
  if (!parts.length) return null
  return (d) => parts.every((p) => {
    let hit
    const v = p.value
    const num = /^([<>]?)(\d+(?:\.\d+)?)(s|m|h)?$/.exec(v)
    switch (p.key) {
      case '': hit = d.title.toLowerCase().includes(v) || d.channel.toLowerCase().includes(v) || d.term.toLowerCase().includes(v); break
      case 'title': hit = d.title.toLowerCase().includes(v); break
      case 'channel': hit = d.channel.toLowerCase().includes(v); break
      case 'term': hit = d.term.toLowerCase() === v || d.term.toLowerCase().includes(v); break
      case 'lang': case 'script': hit = d.script.toLowerCase() === v; break
      case 'year': hit = num ? compare(num[1], Number(d.year), Number(num[2])) : d.year.toLowerCase() === v; break
      case 'dur': hit = num ? compare(num[1], d.seconds, Number(num[2]) * (num[3] === 'm' ? 60 : num[3] === 'h' ? 3600 : 1)) : d.duration.toLowerCase() === v; break
      case 'topic': hit = (groupsOf.topic?.(d) || '').toLowerCase() === v; break
      case 'status': hit = (d.verified ? 'verified' : 'unverified') === v; break
      default: hit = false
    }
    return p.negate ? !hit : hit
  })
}

/** Lay groups out as packed discs; inside each, a sunflower whose wedges follow a secondary key. */
export function galaxy(docs, groupKey, wedgeKey, order = (d) => 0) {
  const groups = new Map()
  for (const d of docs) { const g = groupKey(d); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(d) }
  const list = [...groups].map(([key, members]) => ({ key, members, r: Math.sqrt(members.length) * 1.15 + 1.5 }))
    .sort((a, b) => b.members.length - a.members.length || String(a.key).localeCompare(String(b.key)))
  // Greedy spiral packing, biggest first.
  const placed = []
  const golden = Math.PI * (3 - Math.sqrt(5))
  let cursor = 0
  for (const g of list) {
    if (!placed.length) { g.x = 0; g.y = 0; placed.push(g); continue }
    // Smaller groups follow outward from the last placement, which keeps packing near-linear.
    for (let step = Math.max(0, cursor - 400); ; step++) {
      const radius = 0.6 * Math.sqrt(step), angle = step * golden
      const x = radius * Math.cos(angle), y = radius * Math.sin(angle)
      if (placed.every((p) => Math.hypot(p.x - x, p.y - y) >= p.r + g.r + 1.2)) { g.x = x; g.y = y; placed.push(g); cursor = step; break }
    }
  }
  const pos = new Float64Array(docs.length * 2)
  for (const g of list) {
    const n = g.members.length
    const seats = Array.from({ length: n }, (_, i) => {
      const r = Math.sqrt((i + 0.5) / n) * (g.r - 1), a = i * golden
      return [r * Math.cos(a), r * Math.sin(a), Math.atan2(Math.sin(a), Math.cos(a))]
    }).sort((a, b) => a[2] - b[2])
    const members = [...g.members].sort((a, b) => String(wedgeKey(a)).localeCompare(String(wedgeKey(b))) || order(a) - order(b))
    members.forEach((d, i) => { pos[d.i * 2] = g.x + seats[i][0]; pos[d.i * 2 + 1] = g.y + seats[i][1] })
  }
  return { pos, groups: list.map(({ key, x, y, r, members }) => ({ key, x, y, r, n: members.length })) }
}

/** Scatter on two numeric dimensions; values are rank-free, linear in the given transforms, jittered for ties. */
export function scatter(docs, xOf, yOf, seed = 11) {
  const random = rng(seed)
  const pos = new Float64Array(docs.length * 2)
  const xs = docs.map(xOf), ys = docs.map(yOf)
  const range = (vals) => { const f = vals.filter(Number.isFinite); return f.length ? [Math.min(...f), Math.max(...f)] : [0, 1] }
  const [x0, x1] = range(xs), [y0, y1] = range(ys)
  const sx = 100 / ((x1 - x0) || 1), sy = 100 / ((y1 - y0) || 1)
  docs.forEach((d, i) => {
    const x = Number.isFinite(xs[i]) ? (xs[i] - x0) * sx : -8 - random() * 4
    const y = Number.isFinite(ys[i]) ? (ys[i] - y0) * sy : -8 - random() * 4
    pos[i * 2] = x + (random() - 0.5) * 0.6
    pos[i * 2 + 1] = 100 - y + (random() - 0.5) * 0.6
  })
  return { pos, x: [x0, x1], y: [y0, y1] }
}

export function countBy(docs, keyOf) {
  const m = new Map()
  for (const d of docs) { const k = keyOf(d); m.set(k, (m.get(k) || 0) + 1) }
  return [...m].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
}

export const formatDuration = (s) => !s ? '–' : s < 3600 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
  : `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
export const formatDate = (t) => Number.isFinite(t) && t > 0 ? new Date(t).toISOString().slice(0, 10) : '–'
export { DAY }
