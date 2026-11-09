import { randomUUID, createHash } from 'node:crypto'
import { existsSync, mkdirSync, openSync, closeSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync, backup } from 'node:sqlite'
import { DAY, MIN_AGE, VIDEO_ID, CHANNEL_ID, searchRange, publicationTime, type Config, type Kind, type Source, type SearchSpec, type Video, type Candidate } from './config.ts'

export interface Task {
  id: number; key: string; kind: Kind; payload: string; token: string
  failures: number; runs: number; found: number; last_found: number; empty_runs: number
}
export interface VerifyPayload { id: string; source: string; queryKey: string; candidate?: Candidate }
const LEASE = 120_000

export async function backupDatabase(source: DatabaseSync, destination: string) {
  if (destination === ':memory:' || existsSync(destination)) throw new Error('Backup destination must be a new file; destination already exists or is invalid')
  mkdirSync(dirname(resolve(destination)), { recursive: true })
  closeSync(openSync(destination, 'wx', 0o600))
  return backup(source, destination)
}

export function openStore(filename: string, limits: Pick<Config, 'maxPending' | 'maxSearches' | 'maxChannels'>) {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true })
  const db = new DatabaseSync(filename, { timeout: 5000 })
  try {
    const version = Number(db.prepare('PRAGMA user_version').get()!.user_version)
    const columns = db.prepare("PRAGMA table_info(videos)").all()
    if (version > 2 || (columns.length && !columns.some((c) => c.name === 'found_at'))) throw new Error('Incompatible database: use a separate V2 data directory and the importer')
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS tasks(
      id INTEGER PRIMARY KEY, key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
      payload TEXT NOT NULL, priority INTEGER NOT NULL, due_at INTEGER NOT NULL,
      locked_until INTEGER NOT NULL DEFAULT 0, token TEXT NOT NULL DEFAULT '',
      failures INTEGER NOT NULL DEFAULT 0, runs INTEGER NOT NULL DEFAULT 0,
      found INTEGER NOT NULL DEFAULT 0, last_found INTEGER NOT NULL DEFAULT 0,
      empty_runs INTEGER NOT NULL DEFAULT 0, last_error TEXT
    ) STRICT;
    CREATE INDEX IF NOT EXISTS tasks_ready ON tasks(priority DESC, due_at, locked_until);
    CREATE INDEX IF NOT EXISTS tasks_kind ON tasks(kind);
    CREATE TABLE IF NOT EXISTS seen(
      video_id TEXT PRIMARY KEY, checked_at INTEGER NOT NULL, status TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS seen_expiry ON seen(checked_at);
    CREATE TABLE IF NOT EXISTS retired_channels(id TEXT PRIMARY KEY, retired_at INTEGER NOT NULL) STRICT;
    CREATE INDEX IF NOT EXISTS tasks_verify_channel ON tasks(json_extract(payload,'$.candidate.channelId')) WHERE kind='verify';
    CREATE TABLE IF NOT EXISTS videos(
      video_id TEXT PRIMARY KEY, found_at INTEGER NOT NULL, source_query TEXT NOT NULL,
      record TEXT NOT NULL, verification TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS videos_newest ON videos(found_at DESC, video_id DESC);
    CREATE INDEX IF NOT EXISTS videos_legacy ON videos(video_id) WHERE verification='legacy';
    CREATE INDEX IF NOT EXISTS videos_channel ON videos(json_extract(record,'$.author.id')) WHERE verification='verified';
    CREATE TABLE IF NOT EXISTS metrics(
      day TEXT NOT NULL, name TEXT NOT NULL, value INTEGER NOT NULL,
      PRIMARY KEY(day,name)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS source_lineage(
      key TEXT PRIMARY KEY, root_key TEXT NOT NULL, parent_key TEXT NOT NULL, first_seen INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS source_metrics(
      day TEXT NOT NULL, key TEXT NOT NULL, name TEXT NOT NULL, value INTEGER NOT NULL,
      PRIMARY KEY(day,key,name)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS counters(name TEXT PRIMARY KEY,n INTEGER NOT NULL) STRICT;
    INSERT OR IGNORE INTO counters SELECT 'task:'||kind,count(*) FROM tasks GROUP BY kind;
    INSERT OR IGNORE INTO counters SELECT 'video:'||verification,count(*) FROM videos GROUP BY verification;
    CREATE TRIGGER IF NOT EXISTS task_added AFTER INSERT ON tasks BEGIN
      INSERT INTO counters VALUES('task:'||NEW.kind,1) ON CONFLICT(name) DO UPDATE SET n=n+1;
    END;
    CREATE TRIGGER IF NOT EXISTS task_removed AFTER DELETE ON tasks BEGIN
      UPDATE counters SET n=n-1 WHERE name='task:'||OLD.kind;
    END;
    CREATE TRIGGER IF NOT EXISTS video_added AFTER INSERT ON videos BEGIN
      INSERT INTO counters VALUES('video:'||NEW.verification,1) ON CONFLICT(name) DO UPDATE SET n=n+1;
    END;
    CREATE TRIGGER IF NOT EXISTS video_changed AFTER UPDATE OF verification ON videos
    WHEN NEW.verification!=OLD.verification BEGIN
      UPDATE counters SET n=n-1 WHERE name='video:'||OLD.verification;
      INSERT INTO counters VALUES('video:'||NEW.verification,1) ON CONFLICT(name) DO UPDATE SET n=n+1;
    END;
    UPDATE tasks SET priority=10 WHERE kind='search' AND priority!=10;
    PRAGMA user_version=2;
  `)
  } catch (error) { db.close(); throw error }
  const metricStmt = db.prepare(`INSERT INTO metrics VALUES(?,?,?)
    ON CONFLICT(day,name) DO UPDATE SET value=value+excluded.value`)
  const insertTask = db.prepare(`INSERT INTO tasks(key,kind,payload,priority,due_at) VALUES(?,?,?,?,?)
    ON CONFLICT(key) DO NOTHING`)
  const lookup = db.prepare('SELECT status,checked_at FROM seen WHERE video_id=?')
  const archived = db.prepare('SELECT verification FROM videos WHERE video_id=?')
  const remember = db.prepare(`INSERT INTO seen VALUES(?,?,?)
    ON CONFLICT(video_id) DO UPDATE SET checked_at=excluded.checked_at,status=excluded.status`)
  const cachedCard = `json_extract(payload,'$.candidate.id')=json_extract(payload,'$.id')
    AND json_type(payload,'$.candidate.channelId')='text'
    AND length(json_extract(payload,'$.candidate.channelId'))=24
    AND substr(json_extract(payload,'$.candidate.channelId'),1,2)='UC'
    AND json_type(payload,'$.candidate.seconds')='integer' AND json_extract(payload,'$.candidate.seconds')>0`
  const cachedFeed = `json_type(payload,'$.candidate.feed')='object'
    AND json_type(payload,'$.candidate.publishedAt')='integer'
    AND json_type(payload,'$.candidate.feed.checkedAt')='integer'
    AND json_type(payload,'$.candidate.feed.rawValue')='text' AND json_extract(payload,'$.candidate.feed.rawValue')='0'
    AND json_extract(payload,'$.candidate.publishedAt')+${MIN_AGE}<=json_extract(payload,'$.candidate.feed.checkedAt')`
  const searchLease = `CASE WHEN kind='search' OR (kind='verify' AND NOT coalesce((${cachedCard}),0))
    THEN (SELECT coalesce(max(busy.locked_until),0) FROM tasks AS busy WHERE busy.kind='search'
      OR (busy.kind='verify' AND NOT coalesce((${cachedCard.replaceAll('payload', 'busy.payload')}),0))) ELSE 0 END`
  // A slow search owns one worker; cached verification and independent sources remain claimable.
  const taskPause = `max(CASE kind WHEN 'search' THEN ? WHEN 'channel' THEN ? ELSE max(?,
    CASE WHEN ${cachedCard} THEN 0 ELSE ? END,
    CASE WHEN (${cachedCard}) AND (${cachedFeed}) THEN 0 ELSE ? END) END,${searchLease})`
  const claimStmt = db.prepare(`UPDATE tasks SET token=?,locked_until=? WHERE id=(
    SELECT id FROM tasks WHERE due_at<=? AND locked_until<=?
    AND ${taskPause} <= ?
    ORDER BY priority + CASE WHEN kind='search' AND found>0 THEN 2 ELSE 0 END
      + CASE WHEN kind='search' AND json_extract(payload,'$.window')=? THEN 1 ELSE 0 END DESC,due_at,id LIMIT 1) RETURNING *`)
  // User decision 2026-11-09: focus search on older uploads, ~50% archive (187+ days), 35% older, 15% recent.
  const WINDOW_TURNS = 'AOAOARAOAOAOARAOAOAR'
  const WINDOW_NAMES: Record<string, SearchSpec['window']> = { A: 'archive', O: 'older', R: 'recent' }
  const decode = (rows: Record<string, unknown>[]) => rows.map((r) => ({
    ...JSON.parse(r.record as string), verification: r.verification, foundAt: r.found_at
  }))
  function metric(name: string, value = 1, now = Date.now()) {
    metricStmt.run(new Date(now).toISOString().slice(0, 10), name, value)
  }
  function sourceMetric(key: string, name: string, now = Date.now()) {
    if (key) db.prepare(`INSERT INTO source_metrics VALUES(?,?,?,1)
      ON CONFLICT(day,key,name) DO UPDATE SET value=value+1`).run(new Date(now).toISOString().slice(0,10), key, name)
  }
  function measure(name: string, key = '', now = Date.now()) {
    metric(name, 1, now)
    sourceMetric(key, name, now)
  }
  function sourceRoot(key: string) {
    return db.prepare('SELECT root_key FROM source_lineage WHERE key=?').get(key)?.root_key as string | undefined
  }
  function observeSource(key: string, parent = '', now = Date.now()) {
    if (key) db.prepare('INSERT OR IGNORE INTO source_lineage VALUES(?,?,?,?)')
      .run(key, parent ? sourceRoot(parent) || '' : key, parent, now)
  }
  function meta(key: string) { return db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value as string | undefined }
  function setMeta(key: string, value: string) {
    db.prepare('INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value)
  }
  db.prepare("INSERT OR IGNORE INTO meta VALUES('measurement_started_at',?)").run(String(Date.now()))
  function pauses() {
    const global = Number(meta('pause_until') || 0)
    const search = Math.max(Number(meta('pause_search_until') || 0), Number(meta('search_next_request_at') || 0))
    const channel = Number(meta('pause_channel_until') || 0)
    return [Math.max(global, search), Math.max(global, channel), Math.max(global, Number(meta('pause_verify_until') || 0)),
      Math.max(global, search), Math.max(global, channel)]
  }
  function taskCount(kind: Kind) { return Number(db.prepare('SELECT n FROM counters WHERE name=?').get('task:' + kind)?.n || 0) }
  function seed(spec: SearchSpec, now = Date.now(), parent = '') {
    if (!spec.term.trim() || spec.term.length > 200 || !['recent','older','archive'].includes(spec.window)) return false
    if (taskCount('search') >= limits.maxSearches) return false
    const normalized = { term: spec.term.trim(), window: spec.window }
    const key = 'search:' + createHash('sha256').update(normalized.term.toLowerCase() + '\0' + normalized.window).digest('hex')
    const added = insertTask.run(key, 'search', JSON.stringify(normalized), 10, now).changes === 1
    if (added) observeSource(key, parent, now)
    return added
  }
  function channel(id: string, now = Date.now(), verified = false, parent = '') {
    if (!CHANNEL_ID.test(id) || taskCount('channel') >= limits.maxChannels) return false
    const prior = db.prepare('SELECT retired_at FROM retired_channels WHERE id=?').get(id)
    if (!verified && prior && Number(prior.retired_at) > now - 7 * DAY) return false
    const added = insertTask.run('channel:' + id, 'channel', JSON.stringify({ id }), verified ? 20 : 15, now).changes === 1
    if (verified) db.prepare('UPDATE tasks SET priority=20 WHERE key=?').run('channel:' + id)
    if (added) {
      db.prepare('DELETE FROM retired_channels WHERE id=?').run(id)
      // Old creator jobs without recorded ancestry stay unattributed.
      observeSource('channel:' + id, parent, now)
    }
    return added
  }
  function retireChannels(now = Date.now()) {
    db.exec('BEGIN IMMEDIATE')
    try {
      const rows = db.prepare(`SELECT id,payload FROM tasks WHERE kind='channel' AND empty_runs>0 AND found=0 AND locked_until<=?
        AND NOT EXISTS(SELECT 1 FROM videos WHERE verification='verified' AND json_extract(record,'$.author.id')=json_extract(tasks.payload,'$.id'))
        AND NOT EXISTS(SELECT 1 FROM tasks AS pending WHERE pending.kind='verify' AND json_extract(pending.payload,'$.candidate.channelId')=json_extract(tasks.payload,'$.id'))
        LIMIT 2000`).all(now)
      for (const row of rows) {
        db.prepare('INSERT INTO retired_channels VALUES(?,?) ON CONFLICT(id) DO UPDATE SET retired_at=excluded.retired_at').run(JSON.parse(String(row.payload)).id, now)
        db.prepare('DELETE FROM tasks WHERE id=?').run(row.id)
      }
      db.exec('COMMIT')
      if (rows.length) metric('channels_retired', rows.length, now)
      return rows.length
    } catch (error) { db.exec('ROLLBACK'); throw error }
  }
  function enqueue(payload: VerifyPayload, now = Date.now(), due = now, hint: 'zero' | 'unknown' = 'unknown') {
    const stored = archived.get(payload.id)?.verification
    // Hint rows stay eligible for background verification and upgrade.
    if (!VIDEO_ID.test(payload.id) || (stored && stored !== 'hint')) return false
    const card = payload.candidate
    const published = card?.feed ? publicationTime(card.feed.uploadDate) : undefined
    const complete = card?.id === payload.id && card.hint === 'zero' && CHANNEL_ID.test(card.channelId || '') &&
      typeof card.seconds === 'number' && Number.isSafeInteger(card.seconds) && card.seconds > 0 &&
      card.feed?.rawValue === '0' && published !== undefined && card.publishedAt === published &&
      Number.isSafeInteger(card.feed.checkedAt) && published + MIN_AGE <= card.feed.checkedAt && card.feed.checkedAt <= now
    const prior = lookup.get(payload.id)
    const cacheAge = prior && ['nonzero','hint_nonzero'].includes(String(prior.status)) ? 7 * DAY : DAY
    const freshUnknown = complete && prior && ['unknown','unavailable'].includes(String(prior.status)) && card.feed!.checkedAt > Number(prior.checked_at)
    if (prior && Number(prior.checked_at) > now - cacheAge && prior.status !== 'queued' && !freshUnknown) return false
    if (complete && db.prepare(`UPDATE tasks SET payload=json_set(payload,'$.candidate',json(?)),
      priority=max(priority,100),due_at=min(due_at,?),locked_until=0,token='' WHERE key=? AND locked_until<=?`)
      .run(JSON.stringify(card), due, 'verify:' + payload.id, now).changes === 1) {
      metric('candidate_upgrades', 1, now)
      return true
    }
    if (taskCount('verify') >= limits.maxPending) return false
    const inserted = insertTask.run('verify:' + payload.id, 'verify', JSON.stringify(payload), hint === 'zero' ? 100 : 80, due).changes === 1
    if (inserted) remember.run(payload.id, now, 'queued')
    return inserted
  }
  function save(video: Video, queryKey: string, now = Date.now()) {
    const proof = video.evidence
    const published = publicationTime(video.uploadDate)
    const player = proof?.source === 'innertube/player' && proof.field === 'videoDetails.viewCount'
    const feed = proof?.source === 'youtube/rss' && proof.field === 'media:statistics/@views'
    if (!VIDEO_ID.test(video.videoId) || video.views !== 0 || !(player || feed) ||
      ![0,'0'].includes(proof.rawValue) || !Number.isSafeInteger(proof.checkedAt) ||
      published === undefined || published + MIN_AGE > proof.checkedAt ||
      (feed && (!Number.isSafeInteger(video.seconds) || video.seconds <= 0 || !CHANNEL_ID.test(video.author.id)))) {
      throw new Error('Refusing a video without explicit zero-view evidence')
    }
    const result = db.prepare(`INSERT INTO videos VALUES(?,?,?,?,'verified')
      ON CONFLICT(video_id) DO UPDATE SET record=excluded.record,verification='verified'
      WHERE videos.verification IN ('legacy','hint')`).run(video.videoId, now, video.meta.q, JSON.stringify(video))
    if (result.changes === 1) {
      db.prepare('UPDATE tasks SET found=found+1 WHERE key=?').run(queryKey)
      metric('verified_zero', 1, now)
      sourceMetric(queryKey, 'verified_zero', now)
      const root = sourceRoot(queryKey)
      if (root) sourceMetric(root, 'root_verified_zero', now)
      metric(root ? 'root_attributed_zero' : 'root_unattributed_zero', 1, now)
    }
    return result.changes === 1
  }
  // User decision 2026-11-09: a zero-view hint ("looked like zero once") is archived immediately, unverified.
  function saveHint(card: Candidate, source: string, now = Date.now()) {
    if (card.hint !== 'zero' || !VIDEO_ID.test(card.id)) return false
    // Unverified hints still require a known upload age of at least seven days.
    const oldEnough = card.publishedAt !== undefined ? card.publishedAt + MIN_AGE <= now : (card.minAgeDays ?? 0) * DAY >= MIN_AGE
    if (!oldEnough) return false
    const seconds = Number.isSafeInteger(card.seconds) && card.seconds! > 0 ? card.seconds! : 0
    const timestamp = !seconds ? '' : seconds < 3600 ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
      : `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
    const channelId = CHANNEL_ID.test(card.channelId || '') ? card.channelId! : ''
    const video: Video = {
      videoId: card.id, title: card.feed?.title || card.title || '', description: card.feed?.description || '',
      url: `https://www.youtube.com/watch?v=${card.id}`, seconds, timestamp, views: 0,
      uploadDate: card.feed?.uploadDate || (card.publishedAt ? new Date(card.publishedAt).toISOString() : ''),
      thumbnail: `https://i.ytimg.com/vi/${card.id}/hqdefault.jpg`,
      author: { name: card.feed?.author || card.author || '', id: channelId, url: channelId ? `https://www.youtube.com/channel/${channelId}` : '' },
      meta: { q: source, timestamp: now },
      evidence: { source: 'youtube/hint', field: 'search-or-feed-hint', rawValue: '0', checkedAt: now }
    }
    const added = db.prepare(`INSERT INTO videos VALUES(?,?,?,?,'hint') ON CONFLICT(video_id) DO NOTHING`)
      .run(card.id, now, source, JSON.stringify(video)).changes === 1
    if (added) metric('hint_zero_saved', 1, now)
    return added
  }
  // One-time backfill of zero-looking candidates already in the database (user decision 2026-11-09).
  // One-time backfill of old-enough zero candidates already queued (user decision 2026-11-09).
  function backfillHints(now = Date.now()) {
    db.exec('BEGIN IMMEDIATE')
    try {
      let added = 0
      for (const row of db.prepare("SELECT payload FROM tasks WHERE kind='verify'").all()) {
        const job = JSON.parse(String(row.payload)) as VerifyPayload
        if (job.candidate?.id === job.id && saveHint(job.candidate, job.source, now)) added++
      }
      db.exec('COMMIT')
      return { added }
    } catch (error) { db.exec('ROLLBACK'); throw error }
  }
  return {
    saveHint, backfillHints,
    db, metric, measure, observeSource, meta, setMeta, seed, channel, retireChannels, enqueue, save, taskCount,
    isVerified: (id: string) => archived.get(id)?.verification === 'verified',
    remember(id: string, status: string, now = Date.now()) { remember.run(id, now, status) },
    pause(until: number, reason: string, scope: Source | 'all' = 'all') {
      const key = scope === 'all' ? 'pause_' : 'pause_' + scope + '_'
      setMeta(key + 'until', String(Math.max(Number(meta(key + 'until') || 0), until)))
      setMeta(key + 'reason', reason.slice(0, 500))
    },
    claim(now = Date.now()): Task | undefined {
      const turn = Number(meta('search_window_turn') || 0)
      const window = WINDOW_NAMES[WINDOW_TURNS[turn % WINDOW_TURNS.length]]
      const task = claimStmt.get(randomUUID(), now + LEASE, now, now, ...pauses(), now, window) as unknown as Task | undefined
      if (task?.kind === 'search') setMeta('search_window_turn', String((turn + 1) % WINDOW_TURNS.length))
      return task
    },
    explore(now = Date.now(), pages = 1) {
      if (pauses()[0] > now) return false
      const [from,to,width] = searchRange('archive', now)
      return db.prepare(`UPDATE tasks SET due_at=? WHERE id=(SELECT id FROM tasks
        WHERE kind='search' AND due_at>? AND locked_until<=? AND ${searchLease}<=? AND failures=0 AND last_error IS NULL
        AND (runs=1 OR (runs>1 AND (runs-1) % CASE json_extract(payload,'$.window')
          WHEN 'recent' THEN ? WHEN 'older' THEN ? ELSE ? END != 0))
        ORDER BY found DESC,runs,due_at,id LIMIT 1)`).run(now, now, now, now, Math.ceil(30/pages), Math.ceil(22/pages), Math.ceil((to-from)/width/pages)).changes === 1
    },
    renew(task: Task, now = Date.now()) {
      return db.prepare('UPDATE tasks SET locked_until=? WHERE id=? AND token=?').run(now + LEASE, task.id, task.token).changes === 1
    },
    owns(task: Task) { return !!db.prepare('SELECT 1 FROM tasks WHERE id=? AND token=?').get(task.id, task.token) },
    finish(task: Task) { db.prepare('DELETE FROM tasks WHERE id=? AND token=?').run(task.id, task.token) },
    defer(task: Task, due: number) {
      db.prepare("UPDATE tasks SET due_at=?,locked_until=0,token='' WHERE id=? AND token=?").run(due, task.id, task.token)
    },
    release(task: Task, due: number, empty = false) {
      db.prepare(`UPDATE tasks SET due_at=?,locked_until=0,token='',failures=0,runs=runs+1,
        last_found=found,empty_runs=CASE WHEN ? THEN empty_runs+1 ELSE 0 END,last_error=NULL
        WHERE id=? AND token=?`).run(due, Number(empty), task.id, task.token)
    },
    fail(task: Task, due: number, error: string) {
      db.prepare(`UPDATE tasks SET due_at=?,locked_until=0,token='',failures=failures+1,last_error=?
        WHERE id=? AND token=?`).run(due, error.slice(0, 500), task.id, task.token)
    },
    page(limit: number, after?: { time: number; id: string }) {
      const rows = after
        ? db.prepare(`SELECT * FROM videos WHERE (found_at,video_id)<(?,?)
            ORDER BY found_at DESC,video_id DESC LIMIT ?`).all(after.time, after.id, limit)
        : db.prepare('SELECT * FROM videos ORDER BY found_at DESC,video_id DESC LIMIT ?').all(limit)
      return decode(rows)
    },
    summary(now = Date.now()) {
      return {
        videos: db.prepare("SELECT substr(name,7) AS verification,n AS count FROM counters WHERE name LIKE 'video:%'").all(),
        measurementStartedAt: Number(meta('measurement_started_at') || 0),
        waits: db.prepare(`SELECT reason,count(*) AS count FROM (SELECT CASE
          WHEN locked_until>? THEN 'leased'
          WHEN kind='verify' AND json_extract(payload,'$.candidate.publishedAt')+${MIN_AGE}>? THEN 'young'
          WHEN due_at>? THEN 'scheduled'
          WHEN ?>? THEN 'global_backoff'
          WHEN ${taskPause}>? THEN 'source_or_dependency'
          WHEN (kind='search' OR (kind='verify' AND NOT coalesce((${cachedCard}),0))) AND ?>? THEN 'search_pacing'
          WHEN kind='search' AND ?>=? THEN 'verification_capacity'
          ELSE 'ready' END AS reason FROM tasks) GROUP BY reason`).all(now, now, now,
            Number(meta('pause_until') || 0), now,
            ...pauses().map((v, i) => i === 0 || i === 3 ? Math.max(Number(meta('pause_until') || 0), Number(meta('pause_search_until') || 0)) : v), now,
            Number(meta('search_next_request_at') || 0), now, taskCount('verify'), limits.maxPending * 0.9),
        queue: db.prepare(`SELECT kind,count(*) AS count,
          sum(CASE WHEN due_at<=? AND locked_until<=? AND
            ${taskPause} <= ? THEN 1 ELSE 0 END) AS ready,
          sum(CASE WHEN locked_until>? THEN 1 ELSE 0 END) AS leased FROM tasks GROUP BY kind`).all(now, now, ...pauses(), now, now),
        today: db.prepare('SELECT name,value FROM metrics WHERE day=?').all(new Date(now).toISOString().slice(0,10)),
        recentErrors: db.prepare(`SELECT kind,failures,last_error AS error FROM tasks
          WHERE last_error IS NOT NULL ORDER BY due_at DESC LIMIT 5`).all(),
        pauseUntil: Number(meta('pause_until') || 0), pauseReason: meta('pause_reason') || null,
        sourcePauses: (['search', 'channel', 'verify', 'catalogue'] as const).map((kind) => ({ kind,
          until: Number(meta('pause_' + kind + '_until') || 0), reason: meta('pause_' + kind + '_reason') || null
        })).filter((p) => p.until > now),
        searchNextRequestAt: Number(meta('search_next_request_at') || 0),
        heartbeat: Number(meta('heartbeat') || 0)
      }
    },
    replenishLegacy(now = Date.now()) {
      const available = Math.min(500, limits.maxPending - taskCount('verify'))
      if (available <= 0) return
      const rows = db.prepare(`SELECT video_id,source_query FROM videos WHERE verification='legacy'
        AND NOT EXISTS(SELECT 1 FROM seen WHERE seen.video_id=videos.video_id)
        AND NOT EXISTS(SELECT 1 FROM tasks WHERE key='verify:'||videos.video_id) LIMIT ?`).all(available)
      for (const row of rows) insertTask.run('verify:' + row.video_id, 'verify',
        JSON.stringify({ id: row.video_id, source: row.source_query, queryKey: '' }), 60, now)
    },
    maintain(ttl: number, now = Date.now()) {
      db.prepare(`DELETE FROM seen WHERE checked_at<? AND NOT EXISTS(
        SELECT 1 FROM tasks WHERE key='verify:'||seen.video_id)`).run(now - ttl)
      retireChannels(now)
      db.prepare('DELETE FROM retired_channels WHERE retired_at<?').run(now - 30 * DAY)
      db.prepare('DELETE FROM metrics WHERE day<?').run(new Date(now - 90 * DAY).toISOString().slice(0,10))
      db.prepare('DELETE FROM source_metrics WHERE day<?').run(new Date(now - 90 * DAY).toISOString().slice(0,10))
      db.exec('PRAGMA wal_checkpoint(PASSIVE)')
    },
    // User decision 2026-11-09: finds of the 2024–25 Arranging Data Into Lists crawler are shown as unverified hints
    // with their saved metadata and original found time; no YouTube requests are made and nothing is queued.
    importOld(records: Iterable<unknown>, now = Date.now()) {
      let added = 0, skipped = 0
      const insert = db.prepare("INSERT INTO videos VALUES(?,?,?,?,'hint') ON CONFLICT(video_id) DO NOTHING")
      db.exec('BEGIN IMMEDIATE')
      try {
        for (const value of records) {
          const v = (value && typeof value === 'object' ? value : {}) as Record<string, any>
          const seconds = Number.isSafeInteger(v.seconds) && v.seconds >= 0 ? v.seconds : 0
          if (typeof v.videoId !== 'string' || !VIDEO_ID.test(v.videoId) || typeof v.title !== 'string' ||
            !Number.isSafeInteger(v.foundAt) || v.foundAt <= 0 || v.foundAt > now ||
            (v.uploadDate && publicationTime(v.uploadDate) === undefined)) { skipped++; continue }
          const author = v.author && typeof v.author === 'object' ? v.author : {}
          const record: Video = { videoId: v.videoId, title: v.title.slice(0, 1000), description: String(v.description || '').slice(0, 5000),
            url: `https://www.youtube.com/watch?v=${v.videoId}`, seconds,
            timestamp: seconds < 3600 ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
              : `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`,
            views: 0, uploadDate: v.uploadDate || '', thumbnail: `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
            author: { name: String(author.name || '').trim(), url: String(author.url || ''), id: CHANNEL_ID.test(author.id) ? author.id : '' },
            meta: { q: String(v.q || 'arranging data into lists'), timestamp: v.foundAt },
            evidence: { source: 'arranging/v1', field: 'v1-search-card', rawValue: 0, checkedAt: v.foundAt } }
          if (insert.run(v.videoId, v.foundAt, record.meta.q, JSON.stringify(record)).changes) added++
          else skipped++
        }
        db.exec('COMMIT')
      } catch (error) { db.exec('ROLLBACK'); throw error }
      metric('imported_old_finds', added, now)
      return { added, skipped }
    },
    importLegacy(records: Iterable<unknown>, now = Date.now()) {
      db.exec('BEGIN IMMEDIATE')
      try {
        let added = 0
        for (const value of records) {
          if (!value || typeof value !== 'object') throw new Error('Invalid legacy record')
          const v = value as Record<string, unknown>
          if (typeof v.videoId !== 'string' || !VIDEO_ID.test(v.videoId) || typeof v.title !== 'string' ||
            !(v.views === null || (typeof v.views === 'number' && Number.isFinite(v.views) && v.views >= 0))) throw new Error('Expected a valid legacy video record')
          const found = (v.meta as { timestamp?: unknown } | undefined)?.timestamp
          const time = typeof found === 'number' && Number.isSafeInteger(found) && found >= 0 ? Math.min(found, now) : now
          const source = (v.meta as { q?: unknown } | undefined)?.q
          const q = typeof source === 'string' ? source : 'legacy import'
          const changes = db.prepare(`INSERT INTO videos VALUES(?,?,?,?,'legacy')
            ON CONFLICT(video_id) DO NOTHING`).run(v.videoId, time, q, JSON.stringify(v)).changes
          if (changes) added++
          // Legacy counts have no V2 evidence; verification is queued separately.
          if (taskCount('verify') < limits.maxPending && archived.get(v.videoId)?.verification !== 'verified') {
            insertTask.run('verify:' + v.videoId, 'verify', JSON.stringify({ id: v.videoId, source: q, queryKey: '' }), 60, now)
          }
        }
        db.exec('COMMIT')
        return added
      } catch (error) { db.exec('ROLLBACK'); throw error }
    },
    backup: (destination: string) => backupDatabase(db, destination),
    close() { db.close() }
  }
}
export type Store = ReturnType<typeof openStore>
