import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { executeTask, enqueueCandidates, runWorkers, titleTerms, seedFile } from '../crawler.ts'
import { CrawlError } from '../network.ts'
import { createProvider, type Provider } from '../provider.ts'
import { cfg, id, raw, video, memory, NOW, until, channel, feedXml, searchResponse, htmlJSON } from './helpers.ts'

const empty:Provider={
  async search(){return []},async verify(id){return {id,status:'unknown'}},async channel(){return []}
}

test('bulk seed failures roll back every inserted job and counter', async (t) => {
  const store = memory(t)
  store.db.exec(`CREATE TEMP TRIGGER fail_seed BEFORE INSERT ON tasks
    WHEN NEW.kind='search' AND json_extract(NEW.payload,'$.term')='VID'
    BEGIN SELECT RAISE(ABORT,'injected seed failure'); END;`)
  await assert.rejects(seedFile(store, new URL('../seeds.txt', import.meta.url), NOW), /injected seed failure/)
  assert.equal(store.taskCount('search'), 0)
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM tasks').get()!.n, 0)
})

test('the complete bundled word list fits all three age bands and reseeds idempotently', async (t) => {
  const path = new URL('../seeds.txt', import.meta.url)
  const terms = new Set((await readFile(path, 'utf8')).split(/\r?\n/).map(v => v.trim().toLowerCase()).filter(v => v && !v.startsWith('#')))
  assert.equal(terms.size, 2341)
  for (const word of ['img', 'willie', '010', 'bad']) assert.ok(terms.has(word), word)
  const store = memory(t)
  assert.equal(await seedFile(store, path, NOW), terms.size * 3)
  assert.equal(store.taskCount('search'), terms.size * 3)
  const jobs = new Set(store.db.prepare("SELECT payload FROM tasks WHERE kind='search'").all().map(row => {
    const spec = JSON.parse(String(row.payload))
    return spec.term.toLowerCase() + '\0' + spec.window
  }))
  for (const term of terms) for (const band of ['recent','older','archive']) assert.ok(jobs.has(term + '\0' + band))
  assert.equal(await seedFile(store, path, NOW + 1), 0)
})

test('100 repeat discoveries cause one verification, not 100 detail requests', async (t) => {
  const store=memory(t)
  const candidates=[{id:id(),hint:'zero' as const}]
  for(let i=0;i<100;i++)enqueueCandidates(store,candidates,'term','',Date.now())
  assert.equal(store.taskCount('verify'),1)
  let requests=0
  const provider:Provider={...empty,async verify(){requests++;return {id:id(),status:'zero',record:video(1,Date.now())}}}
  await executeTask(store.claim()!,store,provider,cfg,new AbortController().signal)
  for(let i=0;i<100;i++)enqueueCandidates(store,candidates,'term','',Date.now())
  assert.equal(requests,1)
  assert.equal(store.taskCount('verify'),0)
  assert.equal(store.page(10).length,1)
  assert.equal(store.summary().today.find((m)=>m.name==='verified_zero')!.value,1)
  store.enqueue({id:id(2),source:'q',queryKey:''})
  const unacknowledged=store.claim()!
  store.save(video(2,Date.now()),'')
  await executeTask(unacknowledged,store,provider,cfg,new AbortController().signal)
  assert.equal(requests,1,'a committed archive record needs no refetch after a missed acknowledgement')
  assert.equal(store.taskCount('verify'),0)
})

test('public search and RSS reach the durable archive without private API requests', async (t) => {
  const store = memory(t)
  const paths: string[] = []
  const provider = await createProvider(async (input) => {
    const url = input instanceof Request ? input.url : String(input)
    paths.push(new URL(url).pathname)
    assert.ok(!url.includes('/youtubei/'))
    return new Response(url.includes('/feeds/') ? feedXml() : htmlJSON('ytInitialData', searchResponse()))
  }, 1)
  store.seed({ term: 'q', window: 'older' })
  const search = store.claim()!
  await executeTask(search, store, provider, cfg, new AbortController().signal)
  assert.equal(store.taskCount('channel'), 1)
  const check = store.claim()!
  assert.equal(check.kind, 'verify')
  await executeTask(check, store, provider, cfg, new AbortController().signal)
  const saved = store.page(10)
  assert.equal(saved.length, 1)
  assert.equal(saved[0].evidence.source, 'youtube/rss')
  assert.equal(saved[0].evidence.rawValue, '0')
  assert.equal(saved[0].meta.q, 'q')
  assert.equal(store.db.prepare('SELECT found FROM tasks WHERE id=?').get(search.id)!.found, 1)
  assert.deepEqual(paths, ['/results', '/feeds/videos.xml'])
})

test('candidate priority favors explicit zero; unknown work and young feed entries are bounded', (t) => {
  const store=memory(t)
  const items=Array.from({length:20},(_,n)=>({id:id(n+1),hint:'unknown' as const}))
  const count=enqueueCandidates(store,[...items,{id:id(99),hint:'zero'},
    {id:id(98),hint:'positive'},{id:id(97),hint:'zero',publishedAt:NOW}],'term','',NOW)
  assert.equal(count,3)
  assert.equal(JSON.parse(store.claim(NOW)!.payload).id,id(99))
  assert.equal(store.taskCount('verify'),3)
  assert.equal(store.db.prepare("SELECT due_at FROM tasks WHERE key=?").get('verify:' + id(97))!.due_at, NOW + 7 * 86_400_000)
  assert.equal(store.db.prepare('SELECT status FROM seen WHERE video_id=?').get(id(98))!.status,'hint_nonzero')
})

test('unknown sampling rotates through a feed instead of checking the same five entries forever', (t) => {
  const store=memory(t)
  const items=Array.from({length:15},(_,n)=>({id:id(n+1),hint:'unknown' as const}))
  for(let cycle=0;cycle<15;cycle++)enqueueCandidates(store,items,'feed','',NOW,cycle)
  assert.equal(store.taskCount('verify'),15)
})

test('search jobs persist adaptive schedules, credit later verified yield, and respect backpressure', async (t) => {
  const store=memory(t)
  store.seed({term:'empty',window:'older'})
  const task=store.claim()!
  await executeTask(task,store,empty,cfg,new AbortController().signal)
  let row=store.db.prepare('SELECT * FROM tasks WHERE id=?').get(task.id)!
  assert.ok(Number(row.due_at)>Date.now()+cfg.searchInterval)
  store.db.prepare('UPDATE tasks SET found=2,due_at=0 WHERE id=?').run(task.id)
  const next=store.claim()!
  await executeTask(next,store,empty,cfg,new AbortController().signal)
  row=store.db.prepare('SELECT * FROM tasks WHERE id=?').get(task.id)!
  assert.ok(Number(row.due_at)<Date.now()+cfg.searchInterval)
  const guarded=memory(t,{...cfg,maxPending:1})
  guarded.seed({term:'backpressure',window:'older'})
  const search=guarded.claim()!
  guarded.enqueue({id:id(),source:'term',queryKey:''})
  let called=false
  await executeTask(search,guarded,{...empty,async search(){called=true;return []}},
    {...cfg,maxPending:1},new AbortController().signal)
  assert.equal(called,false)
  assert.equal(guarded.taskCount('search'),1)
})

test('young videos are delayed, unknown counts are never archived, and stale leases cannot write', async (t) => {
  const store=memory(t)
  store.enqueue({id:id(),source:'q',queryKey:''})
  let task=store.claim()!
  const retry=Date.now()+86_400_000
  await executeTask(task,store,{...empty,async verify(){return {id:id(),status:'young',retryAt:retry}}},
    cfg,new AbortController().signal)
  assert.equal(store.page(10).length,0)
  assert.ok(Number(store.db.prepare('SELECT due_at FROM tasks WHERE id=?').get(task.id)!.due_at)>retry)
  store.db.prepare('UPDATE tasks SET due_at=0').run()
  task=store.claim()!
  await executeTask(task,store,empty,cfg,new AbortController().signal)
  assert.equal(store.taskCount('verify'),0)
  assert.equal(store.page(10).length,0)
  store.enqueue({id:id(2),source:'q',queryKey:''})
  task=store.claim()!
  await executeTask(task,store,{...empty,async verify(){
    store.claim(Date.now()+120_001)
    return {id:id(2),status:'zero',record:video(2)}
  }},cfg,new AbortController().signal)
  assert.equal(store.page(10).length,0)
})

test('bounded workers overlap I/O and release all work on shutdown', async (t) => {
  const store=memory(t)
  for(let n=1;n<=6;n++)store.enqueue({id:id(n),source:'q',queryKey:'',candidate:{id:id(n),hint:'zero',channelId:channel,seconds:60}})
  let active=0,peak=0,done=0
  const provider:Provider={...empty,async verify(id){
    active++;peak=Math.max(peak,active)
    await sleep(20)
    active--;done++
    return {id,status:'unknown'}
  }}
  const controller=new AbortController()
  const workers=runWorkers(store,provider,{...cfg,workers:3},controller.signal)
  try{await until(()=>done===6)}
  finally{controller.abort();await workers}
  assert.equal(peak,3)
  assert.equal(active,0)
  assert.equal(store.taskCount('verify'),0)
})

test('rate limits persist a global pause and failed jobs remain resumable', async (t) => {
  const store=memory(t)
  store.seed({term:'q',window:'older'})
  let calls=0
  const controller=new AbortController()
  const workers=runWorkers(store,{...empty,async search(){
    calls++;throw new CrawlError('throttled',429,Date.now()+600_000)
  }},{...cfg,workers:2},controller.signal)
  try{await until(()=>!!store.meta('pause_until'))}
  finally{controller.abort();await workers}
  assert.equal(calls,1)
  assert.equal(store.taskCount('search'),1)
  assert.ok(Number(store.meta('pause_until'))>Date.now()+590_000)
  assert.equal(store.db.prepare('SELECT failures FROM tasks').get()!.failures,1)
})

test('shutdown releases interrupted tasks without counting normal cancellation as failure', async (t) => {
  const store=memory(t)
  store.enqueue({id:id(),source:'q',queryKey:''})
  let finish: (()=>void)|undefined
  const controller=new AbortController()
  const workers=runWorkers(store,{...empty,async verify(id){
    await new Promise<void>((r)=>{finish=r});return {id,status:'unknown'}
  }},{...cfg,workers:1},controller.signal)
  await until(()=>!!finish)
  controller.abort();finish!();await workers
  const task=store.db.prepare('SELECT * FROM tasks').get()!
  assert.equal(task.failures,0)
  assert.equal(task.locked_until,0)
  assert.equal(task.last_error,null)
})

test('repeated parser/protocol failures open only the failing source circuit', async (t) => {
  const store=memory(t)
  for(let n=0;n<5;n++)store.seed({term:'broken'+n,window:'recent'})
  const controller=new AbortController()
  const workers=runWorkers(store,{...empty,async search(){throw new Error('schema changed')}},
    {...cfg,workers:1},controller.signal)
  try{await until(()=>!!store.meta('pause_search_until'))}
  finally{controller.abort();await workers}
  assert.equal(store.meta('failure_streak_search'),'5')
  assert.ok(Number(store.meta('pause_search_until'))>Date.now())
  assert.equal(store.meta('pause_until'),undefined)
  assert.equal(store.taskCount('search'),5)
})

test('a verification-only challenge does not stop channel or search work', async (t) => {
  const store=memory(t)
  store.enqueue({id:id(),source:'q',queryKey:''})
  store.seed({term:'q',window:'older'})
  store.channel(channel)
  const controller=new AbortController()
  let searches=0,feeds=0,checks=0
  const workers=runWorkers(store,{...empty,
    async verify(){checks++;throw new CrawlError('challenge',429,Date.now()+600_000,'verify')},
    async search(){searches++;return []},async channel(){feeds++;return []}
  },{...cfg,workers:1},controller.signal)
  try{await until(()=>searches>0&&feeds>0)}finally{controller.abort();await workers}
  assert.equal(checks,1)
  assert.equal(store.meta('pause_until'),undefined)
  assert.ok(Number(store.meta('pause_verify_until'))>Date.now())
  assert.equal(store.summary().sourcePauses[0].kind,'verify')
})

test('one broken feed backs off its own job without starving a healthy feed', async (t) => {
  const store=memory(t)
  store.channel(channel)
  store.channel('UC'+'b'.repeat(22))
  const controller=new AbortController()
  let calls=0
  const workers=runWorkers(store,{...empty,async channel(id){
    calls++
    if(id===channel)throw new CrawlError('HTTP 500',500,Date.now()+30_000,'channel')
    return []
  }},{...cfg,workers:1},controller.signal)
  try{await until(()=>calls===2)}finally{controller.abort();await workers}
  assert.equal(store.meta('pause_channel_until'),undefined)
  assert.equal(store.meta('pause_until'),undefined)
  assert.equal(store.db.prepare('SELECT failures FROM tasks WHERE key=?').get('channel:'+channel)!.failures,1)
})

test('positive search hints cannot fill the feed source pool', (t) => {
  const store=memory(t)
  const items=Array.from({length:8},(_,n)=>({id:id(n+1),hint:'positive' as const,channelId:'UC'+String(n).padStart(22,'a')}))
  enqueueCandidates(store,items,'q','',NOW)
  assert.equal(store.taskCount('channel'),0)
  assert.equal(store.taskCount('verify'),0)
  assert.equal(store.page(10).length,0)
})

test('unexpected database errors drain sibling workers before the pool is restarted', async (t) => {
  const store=memory(t)
  store.enqueue({id:id(),source:'q',queryKey:''})
  let claims=0,active=0
  const broken={...store,claim(){
    if(++claims===1)throw new Error('disk error')
    return store.claim()
  }}
  const provider:Provider={...empty,async verify(id){
    active++;await sleep(20);active--;return {id,status:'unknown'}
  }}
  await assert.rejects(runWorkers(broken,provider,{...cfg,workers:2},new AbortController().signal),/disk error/)
  assert.equal(active,0)
  assert.equal(store.page(10).length,0)
})

test('title exploration remains bounded and includes non-English tokens', () => {
  assert.ok(titleTerms('How to test abstemiously').includes('abstemiously'))
  assert.ok(titleTerms('日本語の音楽 練習動画').length>0)
  assert.equal(titleTerms('the and for').length,0)
  assert.ok(titleTerms('one two three four five').length<=2)
})
