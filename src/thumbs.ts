// User decision 2026-11-20: a slow background job fingerprints each archived video's small thumbnail
// (colour and layout only) so the page can group videos by how their thumbnails look.
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { log, VIDEO_ID, type Config } from './config.ts'
import { retryDelay } from './network.ts'
import type { Store } from './store.ts'

/** 4×4 cells × RGB = 48 bytes, sent to the page as 64 base64url characters. */
export const LOOK_BYTES = 48
const MAX_IMAGE = 256 * 1024

export class DecodeError extends Error {}

/** Crops the 4:3 letterbox bars of default.jpg to 16:9 and averages it down to 4×4 RGB with ffmpeg. */
export function ffmpegDecode(binary: string, timeout = 10_000) {
  return (image: Uint8Array) => new Promise<Uint8Array>((resolve, reject) => {
    const child = spawn(binary, ['-v', 'error', '-nostdin', '-i', 'pipe:0', '-frames:v', '1',
      '-vf', 'crop=iw:ih*3/4:0:ih/8,scale=4:4:flags=area', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
    { stdio: ['pipe', 'pipe', 'ignore'] })
    const chunks: Buffer[] = []
    const timer = setTimeout(() => { child.kill('SIGKILL') }, timeout)
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.stdout.on('data', (c: Buffer) => chunks.push(c))
    child.stdin.on('error', () => {})
    child.on('close', (code) => {
      clearTimeout(timer)
      const out = Buffer.concat(chunks)
      if (code === 0 && out.length === LOOK_BYTES) resolve(out)
      else reject(new DecodeError(`ffmpeg exit ${code}, ${out.length} bytes`))
    })
    child.stdin.end(image)
  })
}

export interface ThumbDeps { fetch: typeof fetch; decode: (image: Uint8Array) => Promise<Uint8Array> }

/** Returns the look, or '' when the thumbnail is missing or unreadable. Throws on errors worth retrying. */
export async function fingerprint(id: string, deps: ThumbDeps, timeout = 20_000) {
  if (!VIDEO_ID.test(id)) return ''
  const response = await deps.fetch(`https://i.ytimg.com/vi/${id}/default.jpg`, { signal: AbortSignal.timeout(timeout), redirect: 'error' })
  if (response.status === 404 || response.status === 410) { await response.body?.cancel(); return '' }
  if (!response.ok) { await response.body?.cancel(); throw new Error(`thumbnail HTTP ${response.status}`) }
  const image = new Uint8Array(await response.arrayBuffer())
  if (image.length > MAX_IMAGE) return ''
  try { return Buffer.from(await deps.decode(image)).toString('base64url') }
  catch (error) { if (error instanceof DecodeError) return ''; throw error }
}

export async function runThumbs(store: Store, cfg: Pick<Config, 'thumbInterval' | 'ffmpeg' | 'timeout'>, signal: AbortSignal,
  deps: ThumbDeps = { fetch, decode: ffmpegDecode(cfg.ffmpeg) }) {
  if (!cfg.thumbInterval) return
  const wait = (ms: number) => sleep(ms, undefined, { signal }).catch(() => {})
  let failures = 0
  while (!signal.aborted) {
    const ids = store.thumbsPending(50)
    if (!ids.length) { await wait(600_000); continue }
    for (const id of ids) {
      if (signal.aborted) return
      const paused = Number(store.meta('pause_until') || 0) - Date.now()
      if (paused > 0) { await wait(Math.min(paused, 60_000)); break }
      try {
        const look = await fingerprint(id, deps, cfg.timeout)
        store.saveLook(id, look)
        store.metric(look ? 'thumbs_saved' : 'thumbs_missing')
        failures = 0
      } catch (error) {
        if (signal.aborted) return
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') { log('thumbs_disabled', { reason: 'ffmpeg not found' }); return }
        store.metric('thumbs_failed')
        log('thumb_failed', { error: String(error).slice(0, 200), failures })
        await wait(retryDelay(failures++))
        break
      }
      await wait(cfg.thumbInterval)
    }
  }
}
