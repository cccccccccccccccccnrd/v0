import { setTimeout as sleep } from 'node:timers/promises'
import { AsyncLocalStorage } from 'node:async_hooks'
import { log, type Config, type Source } from './config.ts'
import type { Store } from './store.ts'

export const requestContext = new AsyncLocalStorage<{ sourceKey?: string; purpose?: 'keyword' | 'metadata' }>()

export class CrawlError extends Error {
  status: number
  retryAt: number
  scope: Source | 'all'
  constructor(message: string, status = 0, retryAt = 0, scope: Source | 'all' = 'all') {
    super(message)
    this.name = 'CrawlError'
    this.status = status
    this.retryAt = retryAt
    this.scope = scope
  }
}
export function retryAfter(value: string | null, now = Date.now()) {
  if (!value) return 0
  if (/^\d+$/.test(value)) {
    const time = now + Number(value) * 1000
    return Number.isSafeInteger(time) && time <= 8.64e15 ? time : 0
  }
  const time = Date.parse(value)
  return Number.isFinite(time) && time > now ? time : 0
}
export function retryDelay(failures: number, random = Math.random) {
  return Math.min(3_600_000, Math.round(5000 * 2 ** Math.min(failures, 10) * (0.8 + random() * 0.4)))
}

function networkErrorDetails(value: unknown, depth = 0): Record<string, unknown> {
  if (!(value instanceof Error)) return { name: 'NonError' }
  const error = value as Error & { code?: unknown; syscall?: unknown }
  const details: Record<string, unknown> = { name: /^[A-Za-z0-9_]{1,64}$/.test(error.name) ? error.name : 'Error' }
  if ((typeof error.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code)) ||
    (typeof error.code === 'number' && Number.isSafeInteger(error.code))) details.code = error.code
  if (typeof error.syscall === 'string' && /^(?:connect|read|write|getaddrinfo|recv|send)$/.test(error.syscall)) details.syscall = error.syscall
  if (error.code === 'UND_ERR_SOCKET' && error.message === 'other side closed') details.reason = 'peer_closed'
  if (error.message === 'redirect count exceeded') details.reason = 'redirect_limit'
  if (depth < 3) {
    if (error.cause !== undefined) details.cause = networkErrorDetails(error.cause, depth + 1)
    if (error instanceof AggregateError) details.errors = error.errors.slice(0, 4).map(item => networkErrorDetails(item, depth + 1))
  }
  return details
}

export function controlledFetch(store: Store, cfg: Pick<Config, 'rps' | 'timeout'> & Partial<Pick<Config, 'searchRequestInterval'>>, signal: AbortSignal, transport: typeof fetch = fetch) {
  let next = 0
  return async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    let url = new URL(input instanceof Request ? input.url : String(input))
    url.hash = ''
    const origin = url.origin
    const path = url.pathname
    const scope = path.startsWith('/channel/') ? 'catalogue' : path.includes('/feeds/') ? 'channel' : (path.endsWith('/search') || path === '/results') ? 'search' : (path.endsWith('/player') || path === '/watch') ? 'verify' : undefined
    const requestSignal = input instanceof Request ? input.signal : undefined
    const operationSignal = AbortSignal.any([signal, ...(init?.signal ? [init.signal] : []), ...(requestSignal ? [requestSignal] : [])])
    const visited = new Set([url.href])
    let target = input
    while (true) {
      const hopSignal = operationSignal
      while (true) {
        hopSignal.throwIfAborted()
        const sourcePause = scope ? Number(store.meta('pause_' + scope + '_until') || 0) : 0
        if (sourcePause > Date.now()) throw new CrawlError('Source is cooling down', 0, sourcePause, scope)
        const searchNext = scope === 'search' ? Number(store.meta('search_next_request_at') || 0) : 0
        const wait = Math.max(next, searchNext, Number(store.meta('pause_until') || 0)) - Date.now()
        if (wait <= 0) {
          next = Date.now() + 1000 / cfg.rps
          if (scope === 'search' && cfg.searchRequestInterval) store.setMeta('search_next_request_at', String(Date.now() + cfg.searchRequestInterval))
          break
        }
        await sleep(Math.min(wait, 1000), undefined, { signal: hopSignal })
      }
      const deadline = AbortSignal.timeout(cfg.timeout)
      store.metric('requests')
      const context = requestContext.getStore()
      const purpose = scope === 'search' ? context?.purpose || 'search_unclassified'
        : scope === 'channel' ? 'rss' : scope === 'catalogue' ? 'catalogue' : 'other'
      store.measure('requests_' + purpose, context?.sourceKey)
      let response: Response
      const started = performance.now()
      try {
        const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
        if (url.origin === 'https://www.youtube.com' && !headers.has('cookie')) {
          try {
            const preference = JSON.parse(store.meta('youtube_consent') || 'null') as Record<string, unknown> | null
            if (preference?.name === 'SOCS' && preference.choice === 'reject_optional' && preference.domain === '.youtube.com' &&
              typeof preference.expiresAt === 'number' && Number.isSafeInteger(preference.expiresAt) && preference.expiresAt > Date.now() &&
              typeof preference.value === 'string' && /^[A-Za-z0-9_%+./=-]{1,4096}$/.test(preference.value)) {
              headers.set('cookie', 'SOCS=' + preference.value)
              store.metric('consent_cookie_used')
            }
          } catch { /* Invalid or expired preferences fall back to anonymous requests, never broader credentials. */ }
        }
        response = await transport(target, { ...init, headers, redirect: 'manual',
          signal: AbortSignal.any([operationSignal, deadline]) })
      } catch (error) {
        store.metric('network_errors')
        store.measure('request_error_' + purpose, context?.sourceKey)
        log('network_error', { source: scope || 'other', elapsedMs: Math.round(performance.now() - started),
          cancelled: operationSignal.aborted, error: networkErrorDetails(error) })
        throw error
      }
      store.metric(`http_${scope || 'other'}_${response.status}`)
      store.measure(`response_${purpose}_${response.status}`, context?.sourceKey)
      if (scope === 'channel') store.measure(`feed_response_${response.status}`, 'channel:' + url.searchParams.get('channel_id'))
      if ([301,302,303,307,308].includes(response.status) && response.headers.has('location')) {
        const location = response.headers.get('location')!
        const retry = retryAfter(response.headers.get('retry-after'))
        await response.body?.cancel()
        let destination: URL
        try { destination = new URL(location, url); destination.hash = '' }
        catch { throw new CrawlError('Invalid upstream redirect', 508, 0, scope) }
        const cycle = visited.has(destination.href)
        const endpoint = /^\/(?:sorry|consent|signin)(?:\/|$)/.test(destination.pathname) ? 'access-check'
          : ['/results','/feeds/videos.xml','/watch','/m','/supported_browsers','/oops'].includes(destination.pathname) ? destination.pathname : 'other'
        log('http_redirect', { source: scope || 'other', status: response.status, hop: visited.size,
          sameOrigin: destination.origin === origin, targetHost: destination.hostname, endpoint, cycle,
          changedFields: ['search_query','hl','gl','app','persist_app','persist_hl','persist_gl','ucbcb','sp']
            .filter(key => JSON.stringify(url.searchParams.getAll(key)) !== JSON.stringify(destination.searchParams.getAll(key))) })
        store.metric('redirect_responses')
        if (retry > Date.now()) {
          store.pause(retry, 'Redirect Retry-After', scope || 'all')
          store.metric('throttled')
          throw new CrawlError('Redirect Retry-After', response.status, retry, scope)
        }
        if (['consent.youtube.com','accounts.google.com'].includes(destination.hostname) || /^\/(?:sorry|consent|signin)(?:\/|$)/.test(destination.pathname)) {
          const until = Date.now() + 30 * 60_000
          store.pause(until, 'YouTube consent or verification redirect', scope || 'all')
          store.metric('throttled')
          throw new CrawlError('YouTube consent or verification redirect', 429, until, scope)
        }
        if (destination.origin !== origin || destination.username || destination.password) {
          throw new CrawlError('External or credential-bearing redirect refused', 502, 0, scope)
        }
        if (cycle || visited.size >= 4) {
          store.metric('redirect_loops')
          throw new CrawlError('Upstream redirect cycle or hop limit', 508, 0, scope)
        }
        const method = init?.method || (input instanceof Request ? input.method : 'GET')
        if (!['GET','HEAD'].includes(method.toUpperCase())) throw new CrawlError('Metadata redirect requires GET or HEAD', 508, 0, scope)
        visited.add(destination.href)
        url = destination
        target = input instanceof Request ? new Request(url, input) : url.href
        continue
      }
      if (!response.ok) {
        const code = response.status
        const retry = retryAfter(response.headers.get('retry-after'))
        const until = Math.max(retry,
          Date.now() + (code === 403 ? 30 * 60_000 : code === 429 ? 5 * 60_000 : code >= 500 ? 30_000 : 0))
        await response.body?.cancel()
        const failureScope = code >= 500 ? scope || 'all' : 'all'
        // Ordinary 5xx retries belong to the job; explicit Retry-After also cools its source.
        if (code === 403 || code === 429 || (code >= 500 && retry > Date.now())) {
          store.pause(until, `HTTP ${code}`, failureScope)
          store.metric('throttled')
        }
        throw new CrawlError(`YouTube HTTP ${code}`, code, until, failureScope)
      }
      if (!response.body) return response
      let bytes = 0
      const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          bytes += chunk.byteLength
          if (bytes > 8 * 1024 ** 2) throw new CrawlError('YouTube response exceeded 8 MiB', 0, 0, scope)
          controller.enqueue(chunk)
        }
      }))
      const bounded = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
      Object.defineProperty(bounded, 'url', { value: response.url || url.href })
      return bounded
    }
  }
}
