import { type Candidate, minimumAgeDays } from './config.ts'
export { minimumAgeDays }
import { candidate } from './provider.ts'

export interface ReportedZero {
  id: string
  channelId?: string
  viewLabel: string
  publishedLabel: string
  minAgeDays: number
  seconds: number
  observedAt: number
  tier: 'search-reported'
}

export function reportedZero(node: unknown, now = Date.now()): ReportedZero | undefined {
  const card: Candidate | null = candidate(node)
  if (!card?.seconds) return undefined
  const value = node as { type?: unknown; view_count?: unknown; published?: unknown }
  // Only the renderer's named count field qualifies; an author's name or arbitrary metadata text must not.
  if (value.type !== 'Video') return undefined
  const viewLabel = String(value.view_count ?? '').trim()
  if (!/^(?:No views|0 views?)$/i.test(viewLabel)) return undefined
  const publishedLabel = String(value.published ?? '').trim()
  const age = minimumAgeDays(publishedLabel)
  if (age === undefined || age < 7) return undefined
  return { id: card.id, channelId: card.channelId, viewLabel, publishedLabel,
    minAgeDays: age, seconds: card.seconds, observedAt: now, tier: 'search-reported' }
}
