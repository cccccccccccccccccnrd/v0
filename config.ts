import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DAY = 86_400_000
export const MIN_AGE = 7 * DAY
export const VIDEO_ID = /^[\w-]{11}$/
export const CHANNEL_ID = /^UC[\w-]{22}$/

export function config(env = process.env) {
  function number(key: string, fallback: number, min: number, max: number, integer = true) {
    const value = env[key] === undefined ? fallback : Number(env[key])
    if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
      throw new Error(`Invalid ${key}: expected ${integer ? 'an integer' : 'a number'} between ${min} and ${max}`)
    }
    return value
  }
  const dataDir = resolve(env.DATA_DIR || fileURLToPath(new URL('./data', import.meta.url)))
  return {
    dataDir, database: resolve(dataDir, 'yt0.sqlite'),
    host: env.HOST || '127.0.0.1',
    port: number('PORT', 3667, 1, 65535),
    workers: number('WORKERS', 4, 1, 32),
    rps: number('REQUESTS_PER_SECOND', 1, 0.05, 20, false),
    searchRequestInterval: number('SEARCH_REQUEST_INTERVAL_SECONDS', 60, 1, 3600, false) * 1000,
    timeout: number('REQUEST_TIMEOUT_MS', 20_000, 1000, 120_000),
    pages: number('SEARCH_PAGES', 2, 1, 5),
    maxPending: number('MAX_PENDING', 20_000, 100, 1_000_000),
    maxSearches: number('MAX_SEARCHES', 10_000, 10, 50_000),
    maxChannels: number('MAX_CHANNELS', 2000, 0, 50_000),
    searchInterval: number('SEARCH_INTERVAL_HOURS', 6, 0.5, 168, false) * 3_600_000,
    seenTtl: number('SEEN_TTL_DAYS', 30, 1, 365) * DAY
  }
}
export type Config = ReturnType<typeof config>
export type Kind = 'search' | 'channel' | 'verify'
export type Source = Kind | 'catalogue'
export interface SearchSpec { term: string; window: 'recent' | 'older' | 'archive' }
export function searchRange(window: SearchSpec['window'], now = Date.now()): [number, number, number] {
  return window === 'recent' ? [7,37,1] : window === 'older' ? [37,187,7]
    : [187,Math.floor((now - Date.UTC(2005,0,1)) / DAY),30]
}
export function publicationTime(date: string) {
  const published = Date.parse(date)
  const day = Date.parse(date.slice(0, 10) + 'T00:00:00Z')
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(date) ||
    !Number.isFinite(published) || !Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== date.slice(0, 10)) return undefined
  // Date-only sources must wait through the end of the UTC day.
  return published + (/^\d{4}-\d{2}-\d{2}$/.test(date) ? DAY : 0)
}
export interface Candidate {
  id: string; hint: 'zero' | 'positive' | 'unknown'; publishedAt?: number
  channelId?: string; seconds?: number; title?: string; author?: string
  /** Conservative lower bound on upload age from a relative search label. */
  minAgeDays?: number
  feed?: { title: string; description: string; author: string; uploadDate: string; rawValue: '0'; checkedAt: number }
}
export interface Verification {
  id: string
  status: 'zero' | 'nonzero' | 'unknown' | 'young' | 'unavailable'
  reason?: 'verified' | 'young' | 'missing_card' | 'positive_hint' | 'positive_count' | 'missing_rss_entry' | 'missing_rss_evidence' | 'pre_cutoff_observation' | 'missing_duration' | 'unavailable'
  retryAt?: number
  record?: Video
}
export interface Video {
  videoId: string
  title: string
  description: string
  url: string
  seconds: number
  timestamp: string
  views: 0
  uploadDate: string
  thumbnail: string
  author: { name: string; url: string; id: string }
  meta: { q: string; timestamp: number }
  evidence: { source: 'innertube/player' | 'youtube/rss' | 'youtube/hint' | 'arranging/v1'; field: 'videoDetails.viewCount' | 'media:statistics/@views' | 'search-or-feed-hint' | 'v1-search-card'; rawValue: '0' | 0; checkedAt: number }
}
export function log(event: string, data: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ time: new Date().toISOString(), event, ...data }))
}

export function minimumAgeDays(label: string) {
  const match = /^(?:Streamed |Premiered )?(\d+)\s*(d|days?|w|wks?|weeks?|mo|months?|y|yrs?|years?) ago$/i.exec(label.trim())
  if (!match) return undefined
  const count = Number(match[1])
  if (!Number.isSafeInteger(count) || count < 1 || count > 1000) return undefined
  const unit = match[2].toLowerCase()
  // Relative labels are not exact timestamps: leave a full-unit margin, with conservative long-unit floors.
  return unit === 'd' || unit.startsWith('day') ? count - 1 : unit.startsWith('w') ? (count - 1) * 7
    : unit.startsWith('mo') ? Math.max(14, (count - 1) * 28) : Math.max(180, (count - 1) * 365)
}
