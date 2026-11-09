import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { spawnSync } from 'node:child_process'
import { openStore, backupDatabase } from '../store.ts'
import { config } from '../config.ts'
import { cfg, id, video, memory, temp, NOW, channel } from './helpers.ts'

test('configuration validates resource limits and keeps separate V2 defaults', () => {
  assert.equal(cfg.port,3667)
  assert.equal(cfg.host,'127.0.0.1')
  for (const env of [{WORKERS:'0'},{PORT:'0'},{REQUESTS_PER_SECOND:'NaN'},{SEARCH_PAGES:'Infinity'},{WORKERS:'1.5'},{REQUEST_TIMEOUT_MS:''}]) {
    assert.throws(() => config(env),/Invalid/)
  }
  assert.equal(config({REQUESTS_PER_SECOND:'.5'}).rps,.5)
})

test('source cooldowns persist on disk and leave independent channel jobs runnable', (t) => {
  const filename = join(temp(t), 'db.sqlite')
  const first = openStore(filename, cfg)
  first.seed({ term: 'q', window: 'older' }, NOW)
  first.enqueue({ id: id(), source: 'q', queryKey: '' }, NOW)
  first.pause(NOW + 86_400_000, 'search unavailable', 'search')
  first.close()
  const second = openStore(filename, cfg)
  t.after(() => second.close())
  assert.equal(second.claim(NOW),undefined)
  assert.equal(second.explore(NOW), false)
  second.channel(channel, NOW)
  assert.equal(second.claim(NOW)!.kind, 'channel')
  assert.equal(second.summary(NOW).sourcePauses[0].kind, 'search')
  assert.ok(second.summary(NOW).queue.filter(q => q.kind !== 'channel').every(q => q.ready === 0))
})

test('RSS archive evidence is accepted only with matching provenance, eligibility and duration', (t) => {
  const store = memory(t)
  const record = video()
  record.evidence = { source: 'youtube/rss', field: 'media:statistics/@views', rawValue: '0', checkedAt: NOW }
  assert.equal(store.save(record, '', NOW), true)
  assert.equal(store.save(record, '', NOW + 1), false)
  assert.throws(() => store.save({ ...record, videoId: id(2), seconds: 0 }, '', NOW), /evidence/)
  assert.throws(() => store.save({ ...record, videoId: id(2), uploadDate: new Date(NOW).toISOString() }, '', NOW), /evidence/)
  assert.throws(() => store.save({ ...record, videoId: id(2), evidence: { ...record.evidence, field: 'videoDetails.viewCount' } }, '', NOW), /evidence/)
})

test('empty feeds free source capacity without deleting archives or pending candidate work', (t) => {
  const store=memory(t,{...cfg,maxChannels:2})
  const second='UC'+'b'.repeat(22),third='UC'+'c'.repeat(22)
  store.channel(channel,NOW);store.channel(second,NOW)
  store.db.prepare("UPDATE tasks SET empty_runs=1 WHERE kind='channel'").run()
  store.save(video(),'',NOW)
  store.enqueue({id:id(2),source:'q',queryKey:'',candidate:{id:id(2),hint:'zero',channelId:second}},NOW)
  assert.equal(store.retireChannels(NOW),0,'known archives and pending candidates protect their channels')
  store.finish(store.claim(NOW)!)
  assert.equal(store.retireChannels(NOW),1)
  assert.equal(store.taskCount('channel'),1)
  assert.equal(store.page(10).length,1)
  assert.equal(store.channel(second,NOW+1),false,'a retired empty feed must not churn back immediately')
  assert.equal(store.channel(third,NOW+1),true,'new useful sources have room')
  store.db.prepare("UPDATE tasks SET empty_runs=1 WHERE key=?").run('channel:'+third)
  store.retireChannels(NOW+2)
  assert.equal(store.channel(second,NOW+3,true),true,'verified yield can reactivate a retired source')
  assert.equal(store.db.prepare('SELECT priority FROM tasks WHERE key=?').get('channel:'+second)!.priority,20)
})

test('queue claims are atomic across connections, renewable, and reclaimable after a crash', (t) => {
  const filename=join(temp(t),'db.sqlite')
  const a=openStore(filename,cfg),b=openStore(filename,cfg)
  t.after(()=>{a.close();b.close()})
  a.seed({term:' hello ',window:'recent'},NOW)
  assert.equal(a.seed({window:'recent',term:'HELLO'},NOW),false)
  const task=a.claim(NOW)!
  assert.ok(task)
  assert.equal(b.claim(NOW),undefined)
  assert.equal(a.renew(task,NOW+30_000),true)
  assert.equal(b.claim(NOW+120_001),undefined)
  const recovered=b.claim(NOW+150_001)!
  assert.equal(recovered.id,task.id)
  assert.notEqual(recovered.token,task.token)
  assert.equal(a.owns(task),false)
  a.finish(task)
  assert.equal(a.taskCount('search'),1)
  b.release(recovered,NOW+500_000)
  assert.equal(a.claim(NOW+200_000),undefined)
  assert.ok(a.claim(NOW+500_000))
})

test('idle capacity explores unvisited shards, then respects full-pass cooldown and error backoff', (t) => {
  const store=memory(t)
  store.seed({term:'word',window:'recent'},NOW)
  let task=store.claim(NOW)!
  store.release(task,NOW+86_400_000)
  for(let cycle=1;cycle<=30;cycle++){
    assert.equal(store.explore(NOW),true)
    task=store.claim(NOW)!
    assert.equal(task.runs,cycle)
    store.release(task,NOW+86_400_000)
  }
  assert.equal(store.explore(NOW),false)
  task=store.claim(NOW+86_400_000)!
  store.fail(task,NOW+172_800_000,'rate limit')
  assert.equal(store.explore(NOW+86_400_000),false)
})

test('deduplication and negative cache avoid repeat detail requests without unbounded queues', (t) => {
  const store=memory(t,{...cfg,maxPending:2,maxSearches:1,maxChannels:1})
  assert.equal(store.seed({term:'one',window:'recent'},NOW),true)
  assert.equal(store.seed({term:'two',window:'recent'},NOW),false)
  assert.equal(store.enqueue({id:id(1),source:'q',queryKey:''},NOW),true)
  assert.equal(store.enqueue({id:id(1),source:'q',queryKey:''},NOW),false)
  assert.equal(store.enqueue({id:id(2),source:'q',queryKey:''},NOW),true)
  assert.equal(store.enqueue({id:id(3),source:'q',queryKey:''},NOW),false)
  const first=store.claim(NOW)!
  store.finish(first)
  store.remember(JSON.parse(first.payload).id,'nonzero',NOW)
  assert.equal(store.enqueue({id:JSON.parse(first.payload).id,source:'q',queryKey:''},NOW+1),false)
  assert.equal(store.enqueue({id:JSON.parse(first.payload).id,source:'q',queryKey:''},NOW+7*86_400_000+1),true)
  assert.equal(store.enqueue({id:'bad',source:'q',queryKey:''},NOW),false)
  assert.equal(store.channel('UC'+'a'.repeat(22),NOW),true)
  assert.equal(store.channel('UC'+'b'.repeat(22),NOW),false)
})

test('verified archives persist, retain first evidence, and have transactional constant-time counters', (t) => {
  const path=join(temp(t),'archive.sqlite')
  let store=openStore(path,cfg)
  assert.equal(store.save(video(1),'',NOW),true)
  assert.equal(store.save({...video(1),title:'replacement'},'',NOW+1),false)
  store.save(video(2),'',NOW)
  const metrics=store.summary(NOW).today
  assert.equal(metrics.find((r)=>r.name==='verified_zero')!.value,2)
  assert.equal(store.page(1)[0].videoId,id(2))
  const after=store.page(1)[0]
  assert.equal(store.page(2,{time:after.foundAt,id:after.videoId})[0].title,'A test video')
  store.close()
  store=openStore(path,cfg)
  t.after(()=>store.close())
  assert.equal(store.page(10).length,2)
  assert.equal(store.summary().videos.find((v)=>v.verification==='verified')!.count,2)
  assert.equal(store.enqueue({id:id(1),source:'q',queryKey:''},NOW),false)
  assert.throws(()=>store.save({...video(3),evidence:{...video(3).evidence,rawValue:'1' as '0'}},''),/evidence/)
})

test('legacy import is atomic, idempotent, explicitly unverified, and backfills a bounded verification queue', (t) => {
  const store=memory(t,{...cfg,maxPending:2})
  const legacy=[1,2,3].map((n)=>({...video(n),views:n===3?10:0,meta:{q:'old',timestamp:NOW-1_000_000}}))
  assert.throws(()=>store.importLegacy([legacy[0],{}],NOW),/legacy/)
  assert.equal(store.page(10).length,0)
  assert.equal(store.taskCount('verify'),0)
  assert.equal(store.importLegacy(legacy,NOW),3)
  assert.equal(store.importLegacy(legacy,NOW),0)
  assert.equal(store.taskCount('verify'),2)
  assert.ok(store.page(10).every((v)=>v.verification==='legacy'))
  for(let i=0;i<2;i++) {
    const task=store.claim(NOW)!
    store.remember(JSON.parse(task.payload).id,'nonzero',NOW)
    store.finish(task)
  }
  store.replenishLegacy(NOW)
  assert.equal(store.taskCount('verify'),1)
  assert.equal(JSON.parse(store.claim(NOW)!.payload).id,id(3))
  store.save(video(1),'',NOW)
  const row=store.page(10).find((v)=>v.videoId===id(1))
  assert.equal(row.verification,'verified')
  assert.equal(row.foundAt,NOW-1_000_000)
  assert.equal(store.summary().videos.find((v)=>v.verification==='legacy')!.count,2)
})

test('retention prunes old seen/metrics, never the archive or queued IDs', (t) => {
  const store=memory(t)
  store.remember(id(1),'nonzero',NOW-100_000)
  store.enqueue({id:id(2),source:'q',queryKey:''},NOW-100_000)
  store.save(video(3),'',NOW-100_000)
  store.metric('old',1,NOW-100*86_400_000)
  store.maintain(50_000,NOW)
  const seen=store.db.prepare('SELECT video_id FROM seen').all()
  assert.deepEqual(seen.map((v)=>v.video_id),[id(2)])
  assert.equal(store.page(10).length,1)
  assert.equal(store.db.prepare('SELECT 1 FROM metrics WHERE name=?').get('old'),undefined)
})

test('online backups include committed records and refuse overwrites', async (t) => {
  const store=memory(t)
  store.save(video(),'',NOW)
  const path=join(temp(t),'copy.sqlite')
  await store.backup(path)
  const copy=openStore(path,cfg)
  assert.equal(copy.page(10).length,1)
  copy.close()
  const before=readFileSync(path)
  await assert.rejects(store.backup(path),/exists/)
  assert.deepEqual(readFileSync(path),before)
})

test('a read-only backup connection works while the live WAL writer remains open', async (t) => {
  const dir=temp(t),path=join(dir,'live.sqlite')
  const writer=openStore(path,cfg)
  writer.save(video(1),'',NOW)
  const reader=new DatabaseSync(path,{readOnly:true})
  try{
    const destination=join(dir,'backup.sqlite')
    const copying=backupDatabase(reader,destination)
    writer.save(video(2),'',NOW)
    await copying
    const copy=new DatabaseSync(destination,{readOnly:true})
    assert.equal(copy.prepare('PRAGMA quick_check').get()!.quick_check,'ok')
    assert.ok(Number(copy.prepare('SELECT count(*) AS n FROM videos').get()!.n)>=1)
    copy.close()
    assert.equal(writer.page(10).length,2)
  }finally{reader.close();writer.close()}
})

test('incompatible and future databases are refused without modifying their schema', (t) => {
  const path=join(temp(t),'old.sqlite')
  let source=new DatabaseSync(path)
  source.exec('CREATE TABLE videos(video_id TEXT,record TEXT)')
  source.close()
  assert.throws(()=>openStore(path,cfg),/Incompatible/)
  source=new DatabaseSync(path)
  assert.equal(source.prepare("SELECT name FROM sqlite_master WHERE name='tasks'").get(),undefined)
  source.exec('DROP TABLE videos; PRAGMA user_version=99')
  source.close()
  assert.throws(()=>openStore(path,cfg),/Incompatible/)
})

test('CLI can seed, stream a read-only V1 SQLite import, and back up without launching a crawler', (t) => {
  const dir=temp(t)
  const sourcePath=join(dir,'v1.sqlite')
  const source=new DatabaseSync(sourcePath)
  source.exec('CREATE TABLE videos(record TEXT)')
  source.prepare('INSERT INTO videos VALUES(?)').run(JSON.stringify(video()))
  source.close()
  const seed=join(dir,'seeds.txt')
  writeFileSync(seed,'word\nword\n# comment\nsecond\n')
  const run=(args:string[])=>spawnSync(process.execPath,[new URL('../cli.ts',import.meta.url).pathname,...args],{
    encoding:'utf8',env:{...process.env,DATA_DIR:join(dir,'data')}
  })
  for(const args of [['seed',seed],['import','--sqlite',sourcePath],['backup',join(dir,'backup.sqlite')]]) {
    const result=run(args);assert.equal(result.status,0,result.stderr)
  }
  const db=openStore(join(dir,'data/yt0.sqlite'),cfg)
  assert.equal(db.taskCount('search'),6)
  assert.equal(db.page(10)[0].verification,'legacy')
  db.close()
  const unchanged=new DatabaseSync(sourcePath,{readOnly:true})
  assert.equal(unchanged.prepare('SELECT count(*) AS n FROM videos').get()!.n,1)
  unchanged.close()
})
