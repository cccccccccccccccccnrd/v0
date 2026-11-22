const videos = []
let cursor = null
let started = false
let loading = false
const byId = (id) => document.getElementById(id)
function render() {
  const filter = byId('filter').value.toLowerCase()
  const fragment = document.createDocumentFragment()
  for (const v of videos) {
    if (!`${v.title} ${v.author?.name || ''}`.toLowerCase().includes(filter)) continue
    const card = document.createElement('article')
    card.className = 'video'
    const a = document.createElement('a')
    a.href = `https://www.youtube.com/watch?v=${encodeURIComponent(v.videoId)}`
    a.target = '_blank'
    a.rel = 'noopener noreferrer'
    const img = document.createElement('img')
    img.src = `https://i.ytimg.com/vi/${encodeURIComponent(v.videoId)}/hqdefault.jpg`
    img.alt = ''
    img.loading = 'lazy'
    const title = document.createElement('h3')
    title.textContent = v.title
    a.append(img, title)
    const channel = document.createElement('p')
    channel.textContent = v.author?.name || 'Unknown channel'
    const date = document.createElement('p')
    date.textContent = `Uploaded ${v.uploadDate || 'unknown'} · ${v.timestamp || ''}`
    const tag = document.createElement('p')
    tag.className = v.verification === 'verified' ? 'tag' : 'legacy'
    tag.textContent = v.verification === 'verified'
      ? `Verified zero: ${new Date(v.evidence.checkedAt).toLocaleString()}`
      : 'Legacy import — not independently verified'
    card.append(a, channel, date, tag)
    fragment.append(card)
  }
  byId('videos').replaceChildren(fragment)
}
async function load() {
  if (loading || (started && !cursor)) return
  loading = true
  byId('more').disabled = true
  try {
    const response = await fetch('/api/videos?limit=50' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''), { signal: AbortSignal.timeout(15000) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const data = await response.json()
    const existing = new Set(videos.map((v) => v.videoId))
    for (const v of data.videos) if (!existing.has(v.videoId)) { videos.push(v); existing.add(v.videoId) }
    cursor = data.cursor
    started = true
    render()
    byId('message').textContent = videos.length ? `${videos.length} videos loaded. Refresh to see new discoveries.` : 'No discoveries yet. The crawler is working independently.'
    byId('more').hidden = !cursor
  } catch (error) { byId('message').textContent = 'Could not load videos: ' + error.message }
  finally { loading = false; byId('more').disabled = false }
}
async function status() {
  try {
    const response = await fetch('/api/status', { signal: AbortSignal.timeout(15000) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const s = await response.json()
    const counts = Object.fromEntries(s.videos.map((v) => [v.verification, v.count]))
    const today = Object.fromEntries(s.today.map((v) => [v.name, v.value]))
    byId('status').textContent = `${counts.verified || 0} verified · ${counts.legacy || 0} legacy · ${today.requests || 0} requests today · ${today.verified_zero || 0} verified today`
    byId('queue').textContent = s.queue.map((q) => `${q.kind}: ${q.count} jobs (${q.ready} ready, ${q.leased} running)`).join(' · ')
    const errors = s.recentErrors.map((e) => `${e.kind} (${e.failures} failures): ${e.error}`)
    if (today.http_channel_404) errors.push(`RSS returned HTTP 404 ${today.http_channel_404} times today; unavailable feeds are not zero-view evidence.`)
    byId('errors').textContent = errors.join('\n') || 'None'
    const paused = s.pauseUntil > Date.now()
    byId('connection').textContent = s.stopping ? 'Stopping'
      : paused ? `Backing off until ${new Date(s.pauseUntil).toLocaleString()}`
      : Date.now() - s.heartbeat > 60000 ? 'Crawler heartbeat is stale'
      : 'Crawler online' + (s.sourcePauses || []).map((p) => ` · ${p.kind} paused until ${new Date(p.until).toLocaleString()}`).join('')
  } catch (error) { byId('connection').textContent = 'Connection error: ' + error.message }
}
byId('filter').addEventListener('input', render)
byId('more').addEventListener('click', load)
void load()
void status()
setInterval(status, 10000)
