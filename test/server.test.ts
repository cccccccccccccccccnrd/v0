import { existsSync } from 'node:fs'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { createServer } from 'node:net'
import { createApp, decodeCursor } from '../server.ts'
import { openStore } from '../store.ts'
import { cfg, video, id, memory, temp, NOW, until } from './helpers.ts'

test('HTTP uses bounded keyset pagination and exposes health, status, and CSP-protected assets', async (t) => {
  const store=memory(t)
  store.save(video(1),'',NOW);store.save(video(2),'',NOW);store.save(video(3),'',NOW)
  store.setMeta('heartbeat',String(Date.now()))
  store.setMeta('youtube_consent', JSON.stringify({ value: 'private-consent-value' }))
  const {server}=createApp(store)
  server.listen(0,'127.0.0.1')
  await once(server,'listening')
  t.after(async()=>{await new Promise<void>((r)=>server.close(()=>r()))})
  const address=server.address()
  assert.ok(address&&typeof address!=='string')
  const base='http://127.0.0.1:'+address.port
  const first=await (await fetch(base+'/api/videos?limit=2')).json()
  assert.deepEqual(first.videos.map((v:{videoId:string})=>v.videoId),[id(3),id(2)])
  store.save(video(4),'',NOW+1)
  const second=await(await fetch(base+'/api/videos?limit=2&cursor='+first.cursor)).json()
  assert.deepEqual(second.videos.map((v:{videoId:string})=>v.videoId),[id(1)])
  assert.equal(second.cursor,null)
  assert.ok(!JSON.stringify(first).includes('private-consent-value'))
  assert.ok(!(await (await fetch(base+'/api/status')).text()).includes('private-consent-value'))
  // Aston Script (commercial) is deployed from a licensed local copy and is absent from the public repository.
  const script = existsSync(new URL('../public/script.ttf', import.meta.url))
  if (!script) assert.equal((await fetch(base+'/script.ttf')).status, 404)
  for(const path of ['/','/app.js','/core.js','/style.css','/status','/status.js','/status.css','/sharp.woff',...(script ? ['/script.ttf'] : []),'/garamond.woff2','/api/status','/healthz']){
    const response=await fetch(base+path)
    assert.equal(response.status,200,path)
    assert.ok(response.headers.get('content-security-policy')?.includes("script-src 'self'"))
    // only cnrd.computer may embed yt0 (its project preview panel)
    assert.ok(response.headers.get('content-security-policy')?.includes('frame-ancestors https://cnrd.computer https://www.cnrd.computer;'))
  }
  const dashboard = await (await fetch(base+'/')).text()
  assert.ok(dashboard.includes('src="/app.js"'))
  assert.ok((await (await fetch(base+'/status')).text()).includes('src="/status.js"'))
  // Old links to /v2 redirect to the dashboard; the removed V1 pages are gone.
  const moved = await fetch(base+'/v2?x=1', { redirect: 'manual' })
  assert.equal(moved.status, 301); assert.equal(moved.headers.get('location'), '/?x=1')
  for (const path of ['/v1', '/site/', '/site.js']) assert.equal((await fetch(base+path)).status, 404, path)
  for(const query of ['limit=0','limit=501','limit=','limit=1&limit=2','cursor=bad','limit=1.1']){
    assert.equal((await fetch(base+'/api/videos?'+query)).status,400,query)
  }
  assert.equal((await fetch(base+'/api/status',{method:'POST'})).status,405)
  assert.equal((await fetch(base+'/../package.json')).status,404)
  assert.equal((await fetch(base+'/app.js',{method:'HEAD'})).status,200)
  store.setMeta('heartbeat','0')
  assert.equal((await fetch(base+'/healthz')).status,503)
  assert.throws(()=>decodeCursor(Buffer.from(JSON.stringify({time:1,id:12345678901})).toString('base64url')))
})

test('read-only UI renders hostile legacy metadata as text and uses constructed YouTube URLs', async () => {
  const nodes=new Map<string,any>()
  const texts:string[]=[],hrefs:string[]=[]
  function element():any{return{
    value:'',addEventListener(){},append(){},replaceChildren(){},
    set textContent(value:unknown){texts.push(String(value))},
    set href(value:string){hrefs.push(value)},
    set innerHTML(_value:string){throw new Error('Unsafe HTML assignment')}
  }}
  const document={getElementById(id:string){if(!nodes.has(id))nodes.set(id,element());return nodes.get(id)},
    createElement:element,createDocumentFragment:element}
  const context=vm.createContext({document,console,setInterval(){},AbortSignal,
    fetch:async(url:string)=>({ok:true,json:async()=>url.startsWith('/api/videos')
      ?{videos:[],cursor:null}:{videos:[],today:[{name:'http_channel_404',value:3}],queue:[],recentErrors:[],pauseUntil:0,heartbeat:Date.now()}})})
  vm.runInContext(readFileSync(new URL('../public/status.js',import.meta.url),'utf8'),context)
  await new Promise((r)=>setImmediate(r))
  const evil={videoId:id(),title:'<img src=x onerror=alert(1)>',author:{name:'<script>bad()</script>'},
    url:'javascript:alert(1)',verification:'legacy',uploadDate:'unknown'}
  vm.runInContext(`videos.push(${JSON.stringify(evil)});render()`,context)
  assert.ok(texts.some(text=>text.includes('RSS returned HTTP 404 3 times today')))
  assert.ok(texts.includes(evil.title))
  assert.ok(hrefs.every((href)=>href.startsWith('https://www.youtube.com/watch?v=')))
})

test('real entry point starts on an isolated database and shuts down gracefully without network access', async (t) => {
  const dir=temp(t)
  const db=openStore(join(dir,'yt0.sqlite'),cfg)
  db.pause(Date.now()+3_600_000,'offline lifecycle test')
  db.close()
  const portServer=createServer()
  portServer.listen(0,'127.0.0.1')
  await once(portServer,'listening')
  const address=portServer.address()
  assert.ok(address&&typeof address!=='string')
  const port=address.port
  await new Promise<void>((r)=>portServer.close(()=>r()))
  const child=spawn(process.execPath,[new URL('../main.ts',import.meta.url).pathname],{
    env:{...process.env,DATA_DIR:dir,HOST:'127.0.0.1',PORT:String(port)},stdio:['ignore','pipe','pipe']
  })
  let output=''
  child.stdout.on('data',(data)=>{output+=data})
  child.stderr.on('data',(data)=>{output+=data})
  let exited=false
  child.on('exit',()=>{exited=true})
  try{
    await until(()=>output.includes('"event":"listening"')||exited,5000)
    assert.equal(exited,false,output)
    const response=await fetch('http://127.0.0.1:'+port+'/healthz')
    assert.equal(response.status,200)
    assert.equal((await response.json()).paused,true)
    const exit=once(child,'exit')
    child.kill('SIGTERM')
    const [code]=await exit
    assert.equal(code,0,output)
    assert.ok(output.includes('"event":"shutdown"'))
  }finally{
    if(!exited){const exit=once(child,'exit');child.kill('SIGKILL');await exit}
  }
  const after=openStore(join(dir,'yt0.sqlite'),cfg)
  assert.equal(after.summary().today.find((m)=>m.name==='requests'),undefined)
  assert.ok(after.taskCount('search')>0)
  after.close()
})

test('/api/map serves the offline analysis file, gzipped when accepted, and 404 before one exists', async (t) => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { gzipSync } = await import('node:zlib')
  const http = await import('node:http')
  const dir = mkdtempSync(join(tmpdir(), 'yt0-map-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'map.json.gz')
  const { server } = createApp(memory(t), file)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => { await new Promise<void>((r) => server.close(() => r())) })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const base = 'http://127.0.0.1:' + address.port
  assert.equal((await fetch(base + '/api/map')).status, 404)
  writeFileSync(file, gzipSync(JSON.stringify({ version: 1 })))
  assert.deepEqual(await (await fetch(base + '/api/map')).json(), { version: 1 })
  // Without gzip in Accept-Encoding the server decompresses.
  const plain = await new Promise<string>((resolve) => http.get(base + '/api/map', { headers: { 'accept-encoding': 'identity' } }, (res) => {
    assert.equal(res.headers['content-encoding'], undefined); let s = ''; res.on('data', (c) => s += c); res.on('end', () => resolve(s))
  }))
  assert.deepEqual(JSON.parse(plain), { version: 1 })
})
