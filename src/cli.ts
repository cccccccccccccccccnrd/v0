import { DatabaseSync } from 'node:sqlite'
import { config, log } from './config.ts'
import { openStore, backupDatabase } from './store.ts'
import { seedFile } from './crawler.ts'

const [command, arg] = process.argv.slice(2)
if (!['seed','backup'].includes(command) || !arg) {
  throw new Error('Usage: npm run seed -- seeds.txt | npm run backup -- /new/path.sqlite')
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
  log('seeded', { added: await seedFile(store, arg) })
} finally { store.close() }
}
