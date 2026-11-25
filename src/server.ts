import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { gunzipSync, gzip } from 'node:zlib'
import { promisify } from 'node:util'
import { VIDEO_ID } from './config.ts'
import type { Store } from './store.ts'

export function decodeCursor(value: string | null) {
  if (!value) return undefined
  if (value.length > 256 || !/^[\w-]+$/.test(value)) throw new Error('Invalid cursor')
  const cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
  if (!Number.isSafeInteger(cursor.time) || cursor.time < 0 || typeof cursor.id !== 'string' || !VIDEO_ID.test(cursor.id)) throw new Error('Invalid cursor')
  return { time: cursor.time as number, id: cursor.id as string }
}
// User decision 2026-11-20: the analysis map (positions, clusters, names, similar videos) is computed offline on the user's Mac
// and copied to DATA_DIR/analysis/map.json.gz; this server only serves the file.
export function createApp(store: Store, mapFile = '', snapshotFile = '') {
  let stopping = false
  // Pre-gzipped files written by other jobs: the offline map and, since 2026-11-21, the hourly dashboard snapshot (bake.ts).
  const gzFiles = new Map([['/api/map', { file: mapFile, missing: 'No analysis map yet' }], ['/api/snapshot', { file: snapshotFile, missing: 'No snapshot yet' }]])
  const gzCache = new Map<string, { mtime: number; gz: Buffer }>()
  // User decision 2026-11-21: one version only. The dashboard is the root page; the crawler status page moved to /status.
  const assets = new Map([
    ['/', ['index.html', 'text/html; charset=utf-8']],
    ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
    ['/core.js', ['core.js', 'text/javascript; charset=utf-8']],
    ['/style.css', ['style.css', 'text/css; charset=utf-8']],
    ['/status', ['status.html', 'text/html; charset=utf-8']],
    ['/status.js', ['status.js', 'text/javascript; charset=utf-8']],
    ['/status.css', ['status.css', 'text/css; charset=utf-8']],
    // Logo font: Web437 Sharp PC3K Alt-2x by VileR (int10h.org), CC BY-SA 4.0.
    ['/sharp.woff', ['sharp.woff', 'font/woff']],
    // Artwork card fonts from cnrd.computer: Aston Script Bold (TRF) and EB Garamond (SIL OFL).
    ['/script.ttf', ['script.ttf', 'font/ttf']],
    ['/garamond.woff2', ['garamond.woff2', 'font/woff2']]
  ])
  const server = createServer(async (req, res) => {
    const acceptsGzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))
    async function send(status: number, data: unknown, compress = false) {
      const body = JSON.stringify(data)
      // User request 2026-11-21: archive pages are ~0.5 MB of JSON; gzip cuts them about fourfold.
      const gz = compress && acceptsGzip && body.length > 1024 ? await promisify(gzip)(body) : undefined
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...(compress ? { vary: 'accept-encoding' } : {}), ...(gz ? { 'content-encoding': 'gzip' } : {}) })
      res.end(req.method === 'HEAD' ? undefined : gz || body)
    }
    res.setHeader('x-content-type-options', 'nosniff')
    res.setHeader('referrer-policy', 'no-referrer')
    res.setHeader('content-security-policy', "default-src 'self'; img-src https://i.ytimg.com; style-src 'self'; script-src 'self'; frame-ancestors https://cnrd.computer https://www.cnrd.computer; base-uri 'none'; form-action 'self'")
    if (!['GET','HEAD'].includes(req.method || '')) { res.setHeader('allow','GET, HEAD'); send(405, { error: 'Read-only API' }); return }
    if ((req.url?.length || 0) > 4096) { send(414, { error: 'URL too long' }); return }
    try {
      const url = new URL(req.url || '/', 'http://localhost')
      const asset = assets.get(url.pathname)
      // Old shared links to the dashboard keep working.
      if (url.pathname === '/v2') { res.writeHead(301, { location: '/' + url.search }); res.end(); return }
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
        await send(200, { videos, cursor }, true)
      } else if (gzFiles.has(url.pathname)) {
        const { file, missing } = gzFiles.get(url.pathname)!
        let info
        try { info = file ? await stat(file) : undefined } catch { info = undefined }
        if (!info) { send(404, { error: missing }); return }
        let cached = gzCache.get(url.pathname)
        if (cached?.mtime !== info.mtimeMs) gzCache.set(url.pathname, cached = { mtime: info.mtimeMs, gz: await readFile(file) })
        // The file only changes when re-baked, so repeat visits revalidate with an ETag instead of downloading again.
        const etag = '"' + Math.round(info.mtimeMs).toString(36) + '-' + cached.gz.length.toString(36) + (acceptsGzip ? '-gz' : '') + '"'
        const headers: Record<string, string> = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache', vary: 'accept-encoding', etag }
        // User request 2026-11-22: "Loading xx% (xxx videos)". The browser reads the body unzipped, so it needs the
        // unzipped size (gzip trailer; the files are far below 4 GiB) for a percentage, plus the current archive size.
        if (cached.gz.length >= 4) headers['x-json-length'] = String(cached.gz.readUInt32LE(cached.gz.length - 4))
        if (url.pathname === '/api/snapshot') headers['x-archive-videos'] = String(store.videoTotal())
        if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); res.end(); return }
        res.writeHead(200, { ...headers, ...(acceptsGzip ? { 'content-encoding': 'gzip' } : {}) })
        res.end(req.method === 'HEAD' ? undefined : acceptsGzip ? cached.gz : gunzipSync(cached.gz))
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
