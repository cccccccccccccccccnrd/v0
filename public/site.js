const archive = []
const seen = new Set()
const selects = new Map()
const fields = [['title', 'Title'], ['author.name', 'Author'], ['timestamp', 'Duration'], ['uploadDate', 'Upload date'], ['meta.q', 'Search term']]
const grid = document.getElementById('v0')
const status = document.getElementById('status')
const more = document.getElementById('more')
let cursor
let loading = false
let finished = false
let error = ''

function field(video, path) {
  return String(path.split('.').reduce((value, key) => value?.[key], video) ?? '')
}

for (const [path, label] of fields) {
  const select = document.createElement('select')
  select.id = path
  select.setAttribute('aria-label', label)
  select.addEventListener('change', render)
  selects.set(path, select)
  document.querySelector('header').append(select)
}

function updateFilters() {
  for (const [path, label] of fields) {
    const select = selects.get(path)
    const selected = select.value
    const placeholder = document.createElement('option')
    placeholder.value = ''
    placeholder.textContent = label
    select.replaceChildren(placeholder)
    for (const value of [...new Set(archive.map(video => field(video, path)))].filter(Boolean).sort()) {
      const option = document.createElement('option')
      option.value = value
      option.textContent = value
      select.append(option)
    }
    select.value = selected
  }
}

function render() {
  // shortcut: filters cover loaded pages only; add server-side filtering when whole-archive filtering is needed.
  const videos = archive.filter(video => fields.every(([path]) => !selects.get(path).value || field(video, path) === selects.get(path).value))
  const fragment = document.createDocumentFragment()
  for (const video of videos) {
    const card = document.createElement('div')
    card.classList.add('v')
    const caption = document.createElement('p')
    const date = document.createElement('span')
    date.textContent = field(video, 'uploadDate').slice(0, 10)
    const title = field(video, 'title') || 'Untitled'
    const unverified = video.verification === 'verified' ? '' : ' [unverified]'
    caption.append(date, ` ${title} (${field(video, 'timestamp')})${unverified}`)
    const link = document.createElement('a')
    link.href = `https://www.youtube.com/watch?v=${video.videoId}`
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
    const image = document.createElement('img')
    image.src = `https://i.ytimg.com/vi/${video.videoId}/hqdefault.jpg`
    image.alt = title
    image.loading = 'lazy'
    link.append(image)
    card.append(caption, link)
    fragment.append(card)
  }
  grid.replaceChildren(fragment)
  status.textContent = `${videos.length} shown · ${archive.length} loaded. Filters apply to loaded pages.${loading ? ' Loading…' : ''}${error ? ' Could not load more. Please retry.' : ''}`
  more.hidden = finished
  more.disabled = loading
  more.textContent = error ? 'Retry' : loading ? 'Loading…' : 'Load more'
}

async function load() {
  if (loading || finished) return
  loading = true
  error = ''
  render()
  try {
    const response = await fetch('/api/videos?limit=500' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''), { signal: AbortSignal.timeout(15_000) })
    if (!response.ok) throw new Error('Archive request failed')
    const data = await response.json()
    if (!Array.isArray(data.videos) || !(data.cursor === null || (typeof data.cursor === 'string' && /^[\w-]{1,256}$/.test(data.cursor)))) throw new Error('Invalid archive response')
    for (const video of data.videos) {
      if (!video || typeof video.videoId !== 'string' || !/^[\w-]{11}$/.test(video.videoId) || seen.has(video.videoId)) continue
      seen.add(video.videoId)
      archive.push(video)
    }
    cursor = data.cursor
    finished = cursor === null
    updateFilters()
  } catch (failure) {
    error = failure instanceof Error ? failure.message : 'Archive unavailable'
  } finally {
    loading = false
    render()
  }
}

more.addEventListener('click', load)
window.addEventListener('scroll', () => {
  if (window.innerHeight + Math.ceil(window.scrollY) >= document.body.scrollHeight - 100) void load()
}, { passive: true })
void load()
