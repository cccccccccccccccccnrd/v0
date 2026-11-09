import { createHash } from 'node:crypto'
import { XMLParser } from 'fast-xml-parser'
import { DAY, MIN_AGE, VIDEO_ID, CHANNEL_ID, searchRange, publicationTime, minimumAgeDays, log, type Candidate, type SearchSpec, type Verification, type Video } from './config.ts'
import { CrawlError, requestContext } from './network.ts'
import { searchNodes, pageJSON } from './page.ts'

type ObjectValue = Record<string, unknown>
const object = (v: unknown): ObjectValue => v && typeof v === 'object' && !Array.isArray(v) ? v as ObjectValue : {}
const string = (v: unknown) => typeof v === 'string' ? v : ''
const text = (v: unknown) => typeof v === 'string' ? v : v && typeof v === 'object' ? String(v) : ''

export function searchQuery(spec: SearchSpec, now = Date.now(), cycle = 0) {
  let [from, to, width] = searchRange(spec.window, now)
  const buckets = Math.ceil((to - from) / width)
  const offset = createHash('sha256').update(spec.term.toLowerCase()).digest().readUInt32BE(0)
  from += ((offset + cycle) % buckets) * width
  to = Math.min(to, from + width)
  const date = (days: number) => new Date(now - days * DAY).toISOString().slice(0, 10)
  return `${spec.term} before:${date(from)} after:${date(to)}`
}

export function candidate(node: unknown): Candidate | null {
  const n = object(node)
  const id = string(n.video_id) || string(n.content_id)
  if (!VIDEO_ID.test(id) || n.is_live === true || n.is_upcoming === true ||
    (n.content_type && !['VIDEO','SHORT'].includes(String(n.content_type)))) return null
  const metadata = object(object(n.metadata).metadata)
  const rows = Array.isArray(metadata.metadata_rows) ? metadata.metadata_rows : []
  const image = object(n.content_image)
  const overlays = object(image.primary_thumbnail).overlays || image.overlays
  const badges = [...rows.flatMap((row) => Array.isArray(object(row).badges) ? object(row).badges as unknown[] : []),
    ...(Array.isArray(overlays) ? overlays.flatMap((v) => Array.isArray(object(v).badges) ? object(v).badges as unknown[] : []) : [])]
  if (badges.some((v) => /(?:^|[_\s])(?:LIVE|UPCOMING)(?:$|[_\s])/i.test(
    [text(object(v).text), string(object(v).style)].join(' ')))) return null
  const labels = [text(n.view_count), ...rows.flatMap((row) => {
    const parts = object(row).metadata_parts
    return Array.isArray(parts) ? parts.map((p) => text(object(p).text)) : []
  })]
  if (labels.some((v) => /^(?:premieres\b|premiering\b|scheduled for\b|starts in\b|upcoming\b|live now\b|[\d.,]+[KMB]?\s+watching\b)/i.test(v.trim()))) return null
  const hint = labels.some((v) => /^(?:no|0) views?$/i.test(v.trim())) ? 'zero'
    : labels.some((v) => /\b[1-9][\d,.]*\s*[KMB]?\s+views?\b/i.test(v)) ? 'positive' : 'unknown'
  const parts = rows.flatMap((row) => {
    const values = object(row).metadata_parts
    return Array.isArray(values) ? values.map((p) => object(p).text) : []
  })
  const channelId = [string(object(n.author).id), ...parts.map((p) =>
    string(object(object(object(p).endpoint).payload).browseId))].find((v) => CHANNEL_ID.test(v))
  const seconds = object(n.duration).seconds
  const title = (text(n.title) || text(object(n.metadata).title)).trim().slice(0, 1000)
  const author = text(object(n.author).name).trim().slice(0, 200)
  const minAgeDays = minimumAgeDays(text(n.published))
  return { id, hint, ...(channelId ? { channelId } : {}), ...(title ? { title } : {}), ...(author ? { author } : {}),
    ...(minAgeDays !== undefined ? { minAgeDays } : {}),
    ...(typeof seconds === 'number' && Number.isSafeInteger(seconds) && seconds > 0 ? { seconds } : {}) }
}

export function parsePlayer(value: unknown, id: string, now = Date.now()): Verification {
  const raw = object(value)
  const playability = object(raw.playabilityStatus)
  const reason = string(playability.reason)
  if (/bot|unusual traffic|confirm.*human/i.test(reason)) throw new CrawlError('YouTube requested a human verification; pausing', 429, now + 30 * 60_000, 'verify')
  const details = object(raw.videoDetails)
  // Metadata does not require playable streams; WEB may return UNPLAYABLE without player JS.
  const publicMetadata = playability.status === 'OK' || (playability.status === 'UNPLAYABLE' && details.isCrawlable === true)
  if (!publicMetadata) return { id, status: 'unavailable' }
  if (details.videoId !== id || details.isPrivate === true || details.isLive === true || details.isUpcoming === true) return { id, status: 'unavailable' }
  const count = details.viewCount
  if (!(count === '0' || count === 0)) {
    const knownPositive = (typeof count === 'string' && /^[1-9]\d*$/.test(count)) ||
      (typeof count === 'number' && Number.isFinite(count) && count > 0)
    return { id, status: knownPositive ? 'nonzero' : 'unknown' }
  }
  const micro = object(object(raw.microformat).playerMicroformatRenderer)
  const date = string(micro.uploadDate) || string(micro.publishDate)
  const upperBound = publicationTime(date)
  if (upperBound === undefined) return { id, status: 'unknown' }
  if (upperBound + MIN_AGE > now) return { id, status: 'young', retryAt: upperBound + MIN_AGE }
  const channelId = string(details.channelId)
  const title = string(details.title)
  const length = details.lengthSeconds
  const seconds = typeof length === 'string' && /^\d+$/.test(length) ? Number(length) : length
  if (!title || !CHANNEL_ID.test(channelId) || typeof seconds !== 'number' ||
    !Number.isSafeInteger(seconds) || seconds < 0) return { id, status: 'unknown' }
  const timestamp = seconds < 3600 ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2,'0')}`
    : `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2,'0')}:${String(seconds % 60).padStart(2,'0')}`
  const record: Video = {
    videoId: id, title: title.slice(0, 1000), description: string(details.shortDescription).slice(0, 5000),
    url: `https://www.youtube.com/watch?v=${id}`, seconds, timestamp, views: 0,
    uploadDate: date, thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    author: { name: string(details.author), id: channelId, url: `https://www.youtube.com/channel/${channelId}` },
    meta: { q: '', timestamp: now },
    evidence: { source: 'innertube/player', field: 'videoDetails.viewCount', rawValue: count, checkedAt: now }
  }
  return { id, status: 'zero', record }
}

export function parseFeed(xml: string, requestedChannel?: string, now = Date.now()): Candidate[] {
  if (xml.length > 1_000_000 || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Unexpected channel feed')
  const parsed = new XMLParser({ processEntities: false, ignoreAttributes: false,
    parseAttributeValue: false, parseTagValue: false, trimValues: false, isArray: (tag) => tag === 'entry' }).parse(xml, true)
  if (!Object.hasOwn(parsed, 'feed')) throw new CrawlError('Unexpected channel feed', 0, 0, 'channel')
  const feed = object(parsed.feed)
  const rawChannel = string(feed['yt:channelId'])
  // YouTube's feed root uses the bare account ID; entries normally include UC.
  const feedChannel = /^[\w-]{22}$/.test(rawChannel) ? 'UC' + rawChannel : rawChannel
  const entries = feed.entry
  if (!Array.isArray(entries)) return []
  return entries.flatMap((entry): Candidate[] => {
    const id = string(entry['yt:videoId'])
    const uploadDate = string(entry.published)
    const publishedAt = publicationTime(uploadDate)
    const channelId = string(entry['yt:channelId']) || feedChannel
    if (!VIDEO_ID.test(id) || publishedAt === undefined ||
      (requestedChannel && channelId !== requestedChannel) ||
      (feedChannel && channelId !== feedChannel)) return []
    const group = object(entry['media:group'])
    const count = object(object(group['media:community'])['media:statistics'])['@_views']
    const hint = count === '0' ? 'zero' : typeof count === 'string' && /^[1-9]\d*$/.test(count) ? 'positive' : 'unknown'
    const title = string(entry.title).trim()
    return [{ id, hint, publishedAt,
      ...(CHANNEL_ID.test(channelId) ? { channelId } : {}),
      ...(hint === 'zero' && title && CHANNEL_ID.test(channelId) ? { feed: {
        title: title.slice(0, 1000), description: string(group['media:description']).slice(0, 5000),
        author: string(object(entry.author).name), uploadDate, rawValue: '0' as const, checkedAt: now
      } } : {}) }]
  })
}

export class PartialSearchError extends Error {
  candidates: Candidate[]
  constructor(candidates: Candidate[], cause: unknown) {
    super('Search partially completed', { cause })
    this.candidates = candidates
  }
}

export interface Provider {
  search(spec: SearchSpec, cycle?: number): Promise<Candidate[]>
  verify(id: string, context?: Candidate): Promise<Verification>
  channel(id: string): Promise<Candidate[]>
}
export async function createProvider(fetcher: typeof fetch, pages: number, isVerified: (id: string) => boolean = () => false,
  measure: (name: string) => void = () => {}): Promise<Provider> {
  const feeds = new Map<string, { at: number; result: Promise<Candidate[]> }>()
  async function readFeed(id: string, freshAfter = 0): Promise<Candidate[]> {
    if (!CHANNEL_ID.test(id)) throw new Error('Invalid channel ID')
    let pending = feeds.get(id)
    if (!pending || pending.at <= Date.now() - 60_000 || pending.at < freshAfter) {
      measure('rss_cache_miss')
      pending = { at: Date.now(), result: (async () => {
        const response = await fetcher(`https://www.youtube.com/feeds/videos.xml?channel_id=${id}`)
        return parseFeed(await response.text(), id)
      })() }
      feeds.delete(id)
      if (feeds.size >= 64) feeds.delete(feeds.keys().next().value!)
      feeds.set(id, pending)
    } else measure('rss_cache_reuse')
    try {
      return await pending.result
    } catch (error) {
      if (feeds.get(id) === pending) feeds.delete(id)
      if (error instanceof CrawlError && [404,410].includes(error.status)) return []
      if (error instanceof CrawlError) throw error
      throw new CrawlError(error instanceof Error ? error.message : String(error), 0, 0, 'channel')
    }
  }
  async function readSearch(query: string, purpose: 'keyword' | 'metadata'): Promise<Candidate[]> {
    try {
      const params = new URLSearchParams({ search_query: query, hl: 'en', gl: 'US' })
      const response = await requestContext.run({ ...requestContext.getStore(), purpose },
        () => fetcher(`https://www.youtube.com/results?${params}`))
      return searchNodes(await response.text()).map(candidate).filter((v) => v !== null)
    } catch (error) {
      if (error instanceof CrawlError) throw error
      throw new CrawlError(error instanceof Error ? error.message : String(error), 0, 0, 'search')
    }
  }
  return {
    async search(spec, cycle = 0) {
      const found = new Map<string, Candidate>()
      try {
        for (let page = 0; page < pages; page++) {
          for (const item of await readSearch(searchQuery(spec, Date.now(), cycle * pages + page), 'keyword')) found.set(item.id, item)
        }
        return [...found.values()]
      } catch (error) {
        if (found.size) throw new PartialSearchError([...found.values()], error)
        if (error instanceof CrawlError) throw error
        throw new CrawlError(error instanceof Error ? error.message : String(error), 0, 0, 'search')
      }
    },
    async verify(id, context) {
      if (!VIDEO_ID.test(id)) throw new Error('Invalid video ID')
      try {
        let card = context?.id === id ? context : undefined
        if (!card?.channelId || !card.seconds) card = (await readSearch(id, 'metadata')).find((v) => v.id === id)
        if (!card?.channelId || !CHANNEL_ID.test(card.channelId)) return { id, status: 'unknown', reason: 'missing_card' }
        if (card.hint === 'positive') return { id, status: 'nonzero', reason: 'positive_hint' }
        let entry = context?.id === id && context.channelId === card.channelId ? context : undefined
        // Only a fresh count observed after the age cutoff qualifies.
        if (!entry?.feed || entry.publishedAt === undefined || entry.publishedAt + MIN_AGE > entry.feed.checkedAt) {
          entry = (await readFeed(card.channelId, entry?.publishedAt === undefined ? 0 : entry.publishedAt + MIN_AGE)).find((v) => v.id === id)
        }
        if (!entry) return { id, status: 'unknown', reason: 'missing_rss_entry' }
        if (entry.publishedAt! + MIN_AGE > Date.now()) return { id, status: 'young', reason: 'young', retryAt: entry.publishedAt! + MIN_AGE }
        if (entry.hint === 'positive') return { id, status: 'nonzero', reason: 'positive_count' }
        const feed = entry.feed
        if (!feed || feed.rawValue !== '0') return { id, status: 'unknown', reason: 'missing_rss_evidence' }
        if (entry.publishedAt! + MIN_AGE > feed.checkedAt) return { id, status: 'unknown', reason: 'pre_cutoff_observation' }
        if (!Number.isSafeInteger(card.seconds) || card.seconds! <= 0) return { id, status: 'unknown', reason: 'missing_duration' }
        const seconds = card.seconds!
        const timestamp = seconds < 3600 ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
          : `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
        return { id, status: 'zero', reason: 'verified', record: {
          videoId: id, title: feed.title, description: feed.description, url: `https://www.youtube.com/watch?v=${id}`,
          seconds, timestamp, views: 0, uploadDate: feed.uploadDate, thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
          author: { name: feed.author, id: card.channelId, url: `https://www.youtube.com/channel/${card.channelId}` },
          meta: { q: '', timestamp: feed.checkedAt },
          evidence: { source: 'youtube/rss', field: 'media:statistics/@views', rawValue: '0', checkedAt: feed.checkedAt }
        } }
      } catch (error) {
        if (error instanceof CrawlError && [404,410].includes(error.status)) return { id, status: 'unavailable', reason: 'unavailable' }
        throw error
      }
    },
    async channel(id) {
      const entries = await readFeed(id)
      if (!entries.some(entry => entry.hint === 'zero' && entry.publishedAt !== undefined && entry.publishedAt + MIN_AGE <= Date.now() && !isVerified(entry.id))) return entries
      try {
        const response = await fetcher(`https://www.youtube.com/channel/${id}/videos?hl=en&gl=US`)
        const html = await response.text()
        const raw = object(pageJSON(html, 'ytInitialData'))
        const owner = string(object(object(raw.metadata).channelMetadataRenderer).externalId)
        if (owner !== id) throw new CrawlError('Channel catalogue identity unavailable', 0, 0, 'channel')
        const cards = new Map(searchNodes(html).map(candidate).filter(card => card && card.seconds && (!card.channelId || card.channelId === id))
          .map(card => [card!.id, card!]))
        const enriched = entries.map(entry => {
          const card = cards.get(entry.id)
          return card ? { ...entry, seconds: card.seconds, hint: card.hint === 'positive' ? 'positive' as const : entry.hint } : entry
        })
        log('catalogue_complete', { feedEntries: entries.length, withEligibility: enriched.filter(entry => entry.hint === 'zero' && entry.seconds).length })
        return enriched
      } catch (error) {
        if (error instanceof CrawlError && error.scope === 'all' && [403,429].includes(error.status)) throw error
        log('catalogue_unavailable', { status: error instanceof CrawlError ? error.status : 0,
          reason: error instanceof CrawlError && error.message === 'Channel catalogue identity unavailable' ? 'identity' : 'unavailable' })
        return entries
      }
    }
  }
}
