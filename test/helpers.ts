import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TestContext } from 'node:test'
import { config } from '../config.ts'
import { openStore } from '../store.ts'
import { parsePlayer } from '../provider.ts'

export const NOW = Date.parse('2026-10-25T12:00:00Z')
export const cfg = config({})
export const id = (n = 1) => String(n).padStart(11, 'a')
export const channel = 'UC' + 'a'.repeat(22)
export function raw(n = 1) {
  return {
    playabilityStatus: { status: 'OK', reason: '' },
    videoDetails: { videoId: id(n), viewCount: '0' as unknown, title: 'A test video', author: 'Author', channelId: channel,
      lengthSeconds: '60', shortDescription: '', isCrawlable: true, isPrivate: false, isLive: false, isUpcoming: false },
    microformat: { playerMicroformatRenderer: { uploadDate: '2020-01-01' } }
  }
}
export function feedXml(n = 1, count: string | null = '0', published = '2020-01-01T00:00:00Z') {
  return `<feed><yt:channelId>${channel.slice(2)}</yt:channelId><entry><yt:videoId>${id(n)}</yt:videoId><yt:channelId>${channel}</yt:channelId><title>A test video</title><published>${published}</published><author><name>Author</name></author><media:group><media:description>Test description</media:description><media:community><media:statistics${count === null ? '' : ` views="${count}"`}/></media:community></media:group></entry></feed>`
}
export function searchResponse(n = 1, views = 'No views', duration = '1:00') {
  return { contents: { twoColumnSearchResultsRenderer: { primaryContents: { sectionListRenderer: { contents: [
    { itemSectionRenderer: { contents: [{ videoRenderer: {
      videoId: id(n), title: { simpleText: 'A test video' }, viewCountText: { simpleText: views },
      publishedTimeText: { simpleText: '2 years ago' },
      lengthText: { simpleText: duration }, thumbnailOverlays: [{ thumbnailOverlayTimeStatusRenderer: { style: 'DEFAULT', text: { simpleText: duration } } }], ownerText: { runs: [{ text: 'Author', navigationEndpoint: { browseEndpoint: { browseId: channel } } }] }
    } }] } }
  ] } } } } }
}
export function htmlJSON(name: 'ytInitialData' | 'ytInitialPlayerResponse', value: unknown) {
  return `<script>var ${name} = ${JSON.stringify(value).replaceAll('<', '\\u003c')};</script>`
}
export function video(n = 1, now = NOW) {
  const v = parsePlayer(raw(n), id(n), now).record
  if (!v) throw new Error('Invalid test fixture')
  return v
}
export function temp(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(),'yt0-v2-'))
  t.after(() => rmSync(dir,{recursive:true,force:true}))
  return dir
}
export function memory(t: TestContext, limits = cfg) {
  const store = openStore(':memory:',limits)
  t.after(() => store.close())
  return store
}
export async function until(check: () => boolean, timeout = 3000) {
  const end = Date.now() + timeout
  while (!check()) {
    if (Date.now() > end) throw new Error('Timed out')
    await new Promise((r) => setTimeout(r,5))
  }
}
