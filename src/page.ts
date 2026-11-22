import { Parser, YTNodes } from 'youtubei.js'
import { CrawlError } from './network.ts'

export function pageJSON(html: string, name: 'ytInitialData' | 'ytInitialPlayerResponse') {
  if (html.length > 8 * 1024 ** 2) throw new Error('Public page exceeded 8 MiB')
  const assignment = new RegExp(`^\\s*(?:var\\s+)?(?:${name}|window\\["${name}"\\])\\s*=\\s*`)
  for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    const script = match[1]
    const prefix = assignment.exec(script)
    if (!prefix || script[prefix[0].length] !== '{') continue
    const start = prefix[0].length
    let depth = 0, quoted = false, escaped = false
    for (let i = start; i < script.length; i++) {
      const char = script[i]
      if (quoted) {
        if (escaped) escaped = false
        else if (char === '\\') escaped = true
        else if (char === '"') quoted = false
      } else if (char === '"') quoted = true
      else if (char === '{') depth++
      else if (char === '}' && --depth === 0) return JSON.parse(script.slice(start, i + 1)) as unknown
    }
    throw new Error('Incomplete public page JSON')
  }
  throw new CrawlError('Public page metadata unavailable; no challenge is bypassed', 0, 0,
    name === 'ytInitialData' ? 'search' : 'verify')
}

export function searchNodes(html: string) {
  const raw = pageJSON(html, 'ytInitialData')
  const response = Parser.parseResponse(raw as Parameters<typeof Parser.parseResponse>[0])
  if (!response.contents_memo) throw new CrawlError('Public search layout unavailable', 0, 0, 'search')
  return response.contents_memo.getType(YTNodes.Video, YTNodes.LockupView)
}
