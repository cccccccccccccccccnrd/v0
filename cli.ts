import { readFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { config, log } from './config.ts'
import { openStore, backupDatabase } from './store.ts'
import { seedFile } from './crawler.ts'

const [command, arg, extra] = process.argv.slice(2)
if (!['seed','import','backup','backfill-hints','import-old'].includes(command) || (!arg && command !== 'backfill-hints')) {
  throw new Error('Usage: npm run seed -- seeds.txt | npm run import -- export.json | npm run import -- --sqlite /path/V1.sqlite | npm run backup -- /new/path.sqlite | node cli.ts backfill-hints | node cli.ts import-old finds.json')
}
process.umask(0o077)
const cfg = config()
if (command === 'backup') {
  const source = new DatabaseSync(cfg.database, { readOnly: true })
  try { await backupDatabase(source, arg); log('backup_complete', { destination: arg }) }
  finally { source.close() }
} else {
const store = openStore(cfg.database, cfg)
try {
  if (command === 'import-old') {
    // Normalised finds of the 2024–25 Arranging Data Into Lists crawler (see raw/2026-11-09-arranging-2024-ids.md).
    log('old_finds_imported', store.importOld(JSON.parse(await readFile(arg, 'utf8'))))
  } else if (command === 'backfill-hints') {
    log('hints_backfilled', store.backfillHints())
  } else if (command === 'seed') {
    log('seeded', { added: await seedFile(store, arg) })
  } else if (arg === '--sqlite') {
    if (!extra) throw new Error('Provide the V1 SQLite filename')
    const source = new DatabaseSync(extra, { readOnly: true })
    try {
      function* records() {
        for (const row of source.prepare('SELECT record FROM videos').iterate()) yield JSON.parse(row.record as string)
      }
      log('legacy_imported', { added: store.importLegacy(records()) })
    } finally { source.close() }
  } else {
    const data = JSON.parse(await readFile(arg, 'utf8'))
    const videos: unknown = Array.isArray(data) ? data : data?.videos
    if (!Array.isArray(videos)) throw new Error('Expected an array or a V1 stats export')
    log('legacy_imported', { added: store.importLegacy(videos) })
  }
} finally { store.close() }
}
