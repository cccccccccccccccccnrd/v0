import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { VIDEO_ID } from './config.ts'
import type { Store } from './store.ts'

export function decodeCursor(value: string | null) {
  if (!value) return undefined
  if (value.length > 256 || !/^[\w-]+$/.test(value)) throw new Error('Invalid cursor')
  const cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
  if (!Number.isSafeInteger(cursor.time) || cursor.time < 0 || typeof cursor.id !== 'string' || !VIDEO_ID.test(cursor.id)) throw new Error('Invalid cursor')
  return { time: cursor.time as number, id: cursor.id as string }
}
export function createApp(store: Store) {
  let stopping = false
  const assets = new Map([
    ['/', ['index.html', 'text/html; charset=utf-8']],
    ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
    ['/style.css', ['style.css', 'text/css; charset=utf-8']],
    ['/site/', ['site.html', 'text/html; charset=utf-8']],
    ['/v1', ['site.html', 'text/html; charset=utf-8']],
    ['/site.js', ['site.js', 'text/javascript; charset=utf-8']],
    ['/site.css', ['site.css', 'text/css; charset=utf-8']],
    ['/v2', ['v2.html', 'text/html; charset=utf-8']],
    ['/v2.js', ['v2.js', 'text/javascript; charset=utf-8']],
    ['/v2-core.js', ['v2-core.js', 'text/javascript; charset=utf-8']],
    ['/v2.css', ['v2.css', 'text/css; charset=utf-8']],
    // Logo font: Web437 Sharp PC3K Alt-2x by VileR (int10h.org), CC BY-SA 4.0.
    ['/v2-sharp.woff', ['v2-sharp.woff', 'font/woff']],
    // Artwork card fonts from cnrd.computer: Aston Script Bold (TRF) and EB Garamond (SIL OFL).
    ['/v2-script.ttf', ['v2-script.ttf', 'font/ttf']],
    ['/v2-garamond.woff2', ['v2-garamond.woff2', 'font/woff2']]
  ])
  const server = createServer(async (req, res) => {
    function send(status: number, data: unknown) {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify(data))
    }
    res.setHeader('x-content-type-options', 'nosniff')
    res.setHeader('referrer-policy', 'no-referrer')
    res.setHeader('content-security-policy', "default-src 'self'; img-src https://i.ytimg.com; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
    if (!['GET','HEAD'].includes(req.method || '')) { res.setHeader('allow','GET, HEAD'); send(405, { error: 'Read-only API' }); return }
    if ((req.url?.length || 0) > 4096) { send(414, { error: 'URL too long' }); return }
    try {
      const url = new URL(req.url || '/', 'http://localhost')
      const asset = assets.get(url.pathname)
      if (asset) {
        let contents: Buffer
        // The licensed script font is not in the public repository; a missing optional asset is a 404, not a 500.
        try { contents = await readFile(new URL('./public/' + asset[0], import.meta.url)) }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { send(404, { error: 'Not found' }); return } throw error }
        res.writeHead(200, { 'content-type': asset[1] })
        res.end(req.method === 'HEAD' ? undefined : contents)
      } else if (url.pathname === '/api/videos') {
        let after: ReturnType<typeof decodeCursor>
        let limit: number
        try {
          if (url.searchParams.getAll('limit').length > 1 || url.searchParams.getAll('cursor').length > 1) throw new Error()
          const raw = url.searchParams.get('limit') ?? '50'
          if (!/^\d+$/.test(raw)) throw new Error()
          limit = Number(raw)
          if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error()
          after = decodeCursor(url.searchParams.get('cursor'))
        } catch { send(400, { error: 'Expected limit 1–500 and a valid cursor' }); return }
        const rows = store.page(limit + 1, after)
        const videos = rows.slice(0, limit)
        const last = videos.at(-1)
        const cursor = rows.length > limit && last ? Buffer.from(JSON.stringify({ time: last.foundAt, id: last.videoId })).toString('base64url') : null
        send(200, { videos, cursor })
      } else if (url.pathname === '/api/status') {
        send(200, { ...store.summary(), stopping })
      } else if (url.pathname === '/healthz') {
        const heartbeat = Number(store.meta('heartbeat') || 0)
        const healthy = !stopping && heartbeat > Date.now() - 60_000
        send(healthy ? 200 : 503, { healthy, paused: Number(store.meta('pause_until') || 0) > Date.now() })
      } else {
        send(404, { error: 'Not found' })
      }
    } catch {
      if (!res.headersSent) send(500, { error: 'Internal server error' })
      else res.destroy()
    }
  })
  server.requestTimeout = 15_000
  server.headersTimeout = 10_000
  return { server, stopping: () => { stopping = true } }
}
