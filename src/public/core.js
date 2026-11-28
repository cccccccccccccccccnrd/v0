// yt0 dashboard analysis core: pure functions, no DOM. Imported by app.js and by tests.
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
      found: Number(v.foundAt) || 0, verified: v.verification === 'verified', fromOldCrawler: v.evidence?.source === 'arranging/v1', script: scriptOf(title), tokens,
      duration: durationBucket(Number(v.seconds) || 0), look: lookFeatures(v.look), lookRaw: v.look
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

// ---------- thumbnail look (user request 2026-11-20) ----------
// The server sends a 4×4 RGB average of each small thumbnail (48 bytes, base64url). Each cell becomes
// lightness plus two colour-opponent axes, so distance follows how alike two thumbnails look at a glance.
export const LOOK_DIMS = 48
export function lookFeatures(text) {
  if (typeof text !== 'string' || text.length !== 64 || !/^[\w-]+$/.test(text)) return null
  const bin = atob(text.replaceAll('-', '+').replaceAll('_', '/'))
  const f = new Float32Array(LOOK_DIMS)
  for (let c = 0; c < 16; c++) {
    const r = bin.charCodeAt(c * 3) / 255, g = bin.charCodeAt(c * 3 + 1) / 255, b = bin.charCodeAt(c * 3 + 2) / 255
    f[c * 3] = (r + g + b) / 3; f[c * 3 + 1] = (r - g) * 0.8; f[c * 3 + 2] = ((r + g) / 2 - b) * 0.8
  }
  return f
}
const sq = (a, b) => { let s = 0; for (let j = 0; j < LOOK_DIMS; j++) { const t = a[j] - b[j]; s += t * t } return s }

/** Euclidean k-means++ on look vectors; deterministic for a seed. Docs without a look get -1. */
export function lookKmeans(docs, k, seed = 5, iterations = 30) {
  const live = docs.filter((d) => d.look)
  const assign = new Int32Array(docs.length).fill(-1)
  if (!live.length) return { assign, centroids: [] }
  k = Math.max(1, Math.min(k, live.length))
  const random = rng(seed)
  const centroids = [Float64Array.from(live[Math.floor(random() * live.length)].look)]
  const best = new Float64Array(live.length).fill(Infinity)
  while (centroids.length < k) {
    let total = 0
    for (let i = 0; i < live.length; i++) { best[i] = Math.min(best[i], sq(live[i].look, centroids.at(-1))); total += best[i] }
    let pick = random() * total, chosen = live.length - 1
    for (let i = 0; i < live.length; i++) { pick -= best[i]; if (pick <= 0) { chosen = i; break } }
    centroids.push(Float64Array.from(live[chosen].look))
  }
  for (let it = 0; it < iterations; it++) {
    let moved = 0
    for (const d of live) {
      let top = Infinity, arg = 0
      for (let c = 0; c < centroids.length; c++) { const s = sq(d.look, centroids[c]); if (s < top) { top = s; arg = c } }
      if (assign[d.i] !== arg) { assign[d.i] = arg; moved++ }
    }
    const sums = centroids.map(() => new Float64Array(LOOK_DIMS)), counts = new Int32Array(centroids.length)
    for (const d of live) { const s = sums[assign[d.i]]; counts[assign[d.i]]++; for (let j = 0; j < LOOK_DIMS; j++) s[j] += d.look[j] }
    for (let c = 0; c < centroids.length; c++) if (counts[c]) { for (let j = 0; j < LOOK_DIMS; j++) sums[c][j] /= counts[c]; centroids[c] = sums[c] }
    if (!moved) break
  }
  return { assign, centroids }
}

/** Names a look cluster by its average tone and colour, plus "bright centre"/"dark centre" when the middle stands out. */
export function lookLabel(centroid) {
  let l = 0, a = 0, b = 0, mid = 0, edge = 0
  for (let c = 0; c < 16; c++) {
    l += centroid[c * 3] / 16; a += centroid[c * 3 + 1] / 16; b += centroid[c * 3 + 2] / 16
    const x = c % 4, y = Math.floor(c / 4)
    if (x > 0 && x < 3 && y > 0 && y < 3) mid += centroid[c * 3] / 4; else edge += centroid[c * 3] / 12
  }
  const tone = l < 0.22 ? 'dark' : l > 0.68 ? 'light' : ''
  // Back to mean RGB for a standard hue angle.
  const s = (b / 0.8 + 3 * l) / 1.5, R = (s + a / 0.8) / 2, G = (s - a / 0.8) / 2, B = 3 * l - s
  const max = Math.max(R, G, B), min = Math.min(R, G, B)
  let hue
  if (max - min > 0.08) {
    const h = max === R ? (60 * ((G - B) / (max - min)) + 360) % 360 : max === G ? 60 * ((B - R) / (max - min)) + 120 : 60 * ((R - G) / (max - min)) + 240
    hue = h < 15 ? 'red' : h < 45 ? 'orange' : h < 70 ? 'yellow' : h < 160 ? 'green' : h < 200 ? 'teal' : h < 260 ? 'blue' : h < 300 ? 'purple' : h < 340 ? 'pink' : 'red'
  } else hue = tone === 'dark' ? 'black' : tone === 'light' ? 'white' : 'grey'
  const words = [hue === 'black' || hue === 'white' ? '' : tone, hue].filter(Boolean)
  if (mid - edge > 0.12) words.push('bright centre')
  else if (edge - mid > 0.12) words.push('dark centre')
  return words.join(' ')
}

function dot(d, dense) {
  let s = 0
  for (let k = 0; k < d.idx.length; k++) s += d.val[k] * dense[d.idx[k]]
  return s
}

/** Spherical k-means++ on title vectors; deterministic for a seed. Empty titles form their own group. */
// User request 2026-11-28: no "Unclustered" bucket; any shared word is enough (was a 0.05 similarity floor).
export function kmeans(docs, k, seed = 7, iterations = 25, minSimilarity = 1e-9) {
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
  // Titles sharing no word with any centroid stay apart instead of padding cluster 0.
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
export function pca2(docs, seed = 3) { return pcaModel(docs, seed).pcs }

/** pca2 plus the components, so videos added later can be projected without recomputing (projectPca). */
export function pcaModel(docs, seed = 3) {
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
  return { comps, mv, pcs: docs.map((d) => [dot(d, comps[0]) - mv[0], dot(d, comps[1]) - mv[1]]) }
}
export function projectPca(d, model) { return [dot(d, model.comps[0]) - model.mv[0], dot(d, model.comps[1]) - model.mv[1]] }

// ---------- baked snapshot helpers (user request 2026-11-21: cluster on the server every hour, not in every browser) ----------

/** Duplicate labels get a number so every group stays addressable. */
export function uniqueLabels(labels) {
  const seen = new Map()
  return labels.map((l) => { const n = (seen.get(l) || 0) + 1; seen.set(l, n); return n > 1 ? `${l} (${n})` : l })
}

/** Title-topic centroids rebuilt from an assignment (normalised member sums, as at the end of kmeans). */
export function topicCentroids(docs, assign, k) {
  const sums = Array.from({ length: k }, () => new Float64Array(DIMS))
  for (const d of docs) { const c = assign[d.i]; if (c >= 0) for (let j = 0; j < d.idx.length; j++) sums[c][d.idx[j]] += d.val[j] }
  for (const s of sums) { let norm = 0; for (const v of s) norm += v * v; norm = Math.sqrt(norm); if (norm > 0) for (let j = 0; j < DIMS; j++) s[j] /= norm }
  return sums
}
/** Topic for a video the clustering did not see; -1 like kmeans when it shares almost nothing with any topic. */
export function nearestTopic(d, centroids, minSimilarity = 1e-9) {
  if (!d.idx.length) return -1
  let top = minSimilarity, arg = -1
  for (let c = 0; c < centroids.length; c++) { const s = dot(d, centroids[c]); if (s >= top) { top = s; arg = c } }
  return arg
}
export function lookCentroids(docs, assign, k) {
  const sums = Array.from({ length: k }, () => new Float64Array(LOOK_DIMS)), counts = new Int32Array(k)
  for (const d of docs) { const c = assign[d.i]; if (c >= 0 && d.look) { counts[c]++; for (let j = 0; j < LOOK_DIMS; j++) sums[c][j] += d.look[j] } }
  sums.forEach((s, c) => { if (counts[c]) for (let j = 0; j < LOOK_DIMS; j++) s[j] /= counts[c] })
  return sums
}
export function nearestLook(d, centroids) {
  if (!d.look) return -1
  let top = Infinity, arg = -1
  for (let c = 0; c < centroids.length; c++) { const s = sq(d.look, centroids[c]); if (s < top) { top = s; arg = c } }
  return arg
}

/**
 * For each target doc, the most similar title among docs with placed[i] set (cosine > 0.05), or -1.
 * Same similarity as neighbours(), but through an inverted index, so thousands of lookups stay fast.
 */
export function nearestPlaced(docs, placed, targets) {
  const postings = new Map()
  for (const d of docs) if (placed[d.i]) for (let j = 0; j < d.idx.length; j++) {
    let p = postings.get(d.idx[j]); if (!p) postings.set(d.idx[j], p = []); p.push(d.i, d.val[j])
  }
  const score = new Float64Array(docs.length), touched = []
  return targets.map((d) => {
    for (let j = 0; j < d.idx.length; j++) {
      const p = postings.get(d.idx[j]); if (!p) continue
      for (let k = 0; k < p.length; k += 2) { if (!score[p[k]]) touched.push(p[k]); score[p[k]] += d.val[j] * p[k + 1] }
    }
    let best = -1, top = 0.05
    for (const i of touched) { if (i !== d.i && score[i] > top) { top = score[i]; best = i } score[i] = 0 }
    touched.length = 0
    return best
  })
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
      case 'look': hit = (groupsOf.look?.(d) || '').toLowerCase() === v; break
      case 'status': hit = (d.verified ? 'verified' : 'unverified') === v; break
      // Any other key the page provides a category for (meaning, sub, visual, kind, repost, gone, reuse…): exact, case-insensitive.
      default: hit = groupsOf[p.key] ? String(groupsOf[p.key](d) ?? '').toLowerCase() === v : false
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
