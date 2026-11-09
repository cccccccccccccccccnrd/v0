import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parsePlayer, candidate, parseFeed, searchQuery, createProvider } from '../provider.ts'
import { retryAfter, retryDelay, controlledFetch, CrawlError } from '../network.ts'
import { DAY, MIN_AGE } from '../config.ts'
import { raw,id,NOW,memory,feedXml,searchResponse,channel,htmlJSON } from './helpers.ts'

test('only literal raw zero qualifies; missing, coerced, rounded, and malformed values never do', () => {
  for(const value of [0,'0']) {
    const p=raw();p.videoDetails.viewCount=value
    const result=parsePlayer(p,id(),NOW)
    assert.equal(result.status,'zero')
    assert.equal(result.record!.evidence.rawValue,value)
  }
  for(const value of [null,undefined,'','0 views','0abc','0.0',false,NaN,{},-1]) {
    const p=raw();p.videoDetails.viewCount=value
    assert.equal(parsePlayer(p,id(),NOW).status,'unknown',String(value))
  }
  for(const value of ['123',123]) {
    const p=raw();p.videoDetails.viewCount=value
    assert.equal(parsePlayer(p,id(),NOW).status,'nonzero')
  }
})

test('seven-day eligibility is enforced, with a conservative date-only boundary', () => {
  const p=raw()
  p.microformat.playerMicroformatRenderer.uploadDate=new Date(NOW-MIN_AGE).toISOString()
  assert.equal(parsePlayer(p,id(),NOW).status,'zero')
  p.microformat.playerMicroformatRenderer.uploadDate=new Date(NOW-MIN_AGE+1).toISOString()
  assert.equal(parsePlayer(p,id(),NOW).status,'young')
  p.microformat.playerMicroformatRenderer.uploadDate='2026-10-18'
  assert.equal(parsePlayer(p,id(),NOW).status,'young')
  p.microformat.playerMicroformatRenderer.uploadDate='2026-10-17'
  assert.equal(parsePlayer(p,id(),NOW).status,'zero')
  for(const date of ['','0','2020-02-31','yesterday','2020-13-01']) {
    p.microformat.playerMicroformatRenderer.uploadDate=date
    assert.equal(parsePlayer(p,id(),NOW).status,'unknown',date)
  }
})

test('public search uses English labels and distinct narrow shards, never private API pagination', async () => {
  const queries:string[]=[]
  const provider=await createProvider(async(input)=>{
    const url=new URL(input instanceof Request?input.url:String(input))
    assert.equal(url.pathname,'/results');assert.equal(url.searchParams.get('hl'),'en')
    queries.push(url.searchParams.get('search_query')!)
    return new Response(htmlJSON('ytInitialData',searchResponse()))
  },2)
  const found=await provider.search({term:'IMG',window:'recent'},0)
  await provider.search({term:'IMG',window:'recent'},1)
  assert.equal(found[0].hint,'zero')
  assert.equal(new Set(queries).size,4)
})

test('public metadata is usable without playable streams, but private/live/login/bot responses are not zero', () => {
  const p=raw()
  p.playabilityStatus.status='UNPLAYABLE'
  assert.equal(parsePlayer(p,id(),NOW).status,'zero')
  p.videoDetails.viewCount='1000000'
  assert.equal(parsePlayer(p,id(),NOW).status,'nonzero')
  p.videoDetails.viewCount='0'
  p.videoDetails.isCrawlable=false
  assert.equal(parsePlayer(p,id(),NOW).status,'unavailable')
  p.playabilityStatus.status='OK'
  p.videoDetails.isPrivate=true
  assert.equal(parsePlayer(p,id(),NOW).status,'unavailable')
  p.videoDetails.isPrivate=false;p.videoDetails.isLive=true
  assert.equal(parsePlayer(p,id(),NOW).status,'unavailable')
  p.videoDetails.isLive=false;p.videoDetails.videoId=id(2)
  assert.equal(parsePlayer(p,id(),NOW).status,'unavailable')
  p.videoDetails.videoId=id();p.playabilityStatus.status='LOGIN_REQUIRED'
  assert.equal(parsePlayer(p,id(),NOW).status,'unavailable')
  p.playabilityStatus.reason="Sign in to confirm you're not a bot"
  assert.throws(()=>parsePlayer(p,id(),NOW),CrawlError)
})

test('legacy and modern search cards are hints, not verification evidence', () => {
  assert.equal(candidate({video_id:id(),view_count:'No views'})!.hint,'zero')
  assert.equal(candidate({video_id:id(),view_count:'1.2K views'})!.hint,'positive')
  const card={content_id:id(),content_type:'VIDEO',metadata:{metadata:{metadata_rows:[
    {metadata_parts:[{text:'Author'},{text:'0 views'},{text:'2 weeks ago'}]}
  ]}}}
  assert.equal(candidate(card)!.hint,'zero')
  assert.equal(candidate({video_id:id(),view_count:'Unknown'})!.hint,'unknown')
  assert.equal(candidate({video_id:'bad',view_count:'0 views'}),null)
  assert.equal(candidate({video_id:id(),is_live:true}),null)
  assert.equal(candidate({...card,content_type:'PLAYLIST'}),null)
})

test('modern cards retain channel and duration but reject live/upcoming badges', () => {
  const row = { metadata_parts: [{ text: { toString: () => 'Author', endpoint: { payload: { browseId: channel } } } }] as unknown[], badges: [] as { text: string }[] }
  const card = { content_id: id(), content_type: 'VIDEO', duration: { seconds: 60 }, metadata: { metadata: { metadata_rows: [row] } } }
  assert.equal(candidate(card)!.channelId, channel)
  assert.equal(candidate(card)!.seconds, 60)
  for (const text of ['LIVE', 'UPCOMING']) {
    row.badges = [{ text }]
    assert.equal(candidate(card), null)
  }
  row.badges = []
  for (const text of ['Premieres in 10 days', 'Scheduled for October 31', '123 watching now']) {
    row.metadata_parts.push({ text })
    assert.equal(candidate(card), null)
    row.metadata_parts.pop()
  }
})

test('dated searches target eligible age windows without relying on the search index for proof', () => {
  const query = searchQuery({term:'test',window:'recent'},NOW)
  const [,before,after] = query.match(/before:(\S+) after:(\S+)/)!
  assert.equal(Date.parse(before)-Date.parse(after),DAY)
  assert.ok(Date.parse(before)<=NOW-MIN_AGE)
  assert.ok(searchQuery({term:'音楽',window:'older'},NOW).startsWith('音楽 before:'))
  assert.ok(searchQuery({term:'IMG',window:'archive'},NOW).includes('after:'))
})

test('later cycles rotate narrow date shards rather than fetching the same first results forever', () => {
  for(const [window,width] of [['recent',1],['older',7],['archive',30]] as const){
    const queries=new Set<string>()
    for(let cycle=1;cycle<=10;cycle++){
      const query=searchQuery({term:'test',window},NOW,cycle)
      queries.add(query)
      const [,before,after]=query.match(/before:(\S+) after:(\S+)/)!
      assert.ok(Date.parse(before)-Date.parse(after)<=width*DAY)
      assert.ok(Date.parse(before)<=NOW-MIN_AGE)
      assert.ok(Date.parse(after)>=Date.UTC(2005,0,1))
    }
    assert.equal(queries.size,10)
  }
})

test('RSS handles multiple entries and refuses entities/oversized bodies', () => {
  const xml=`<?xml version="1.0"?><feed xmlns:yt="http://www.youtube.com/xml/schemas/2015"><entry><yt:videoId>${id()}</yt:videoId><published>2020-01-01T00:00:00Z</published></entry><entry><yt:videoId>bad</yt:videoId><published>bad</published></entry></feed>`
  assert.deepEqual(parseFeed(xml),[{id:id(),hint:'unknown',publishedAt:Date.parse('2020-01-01T00:00:00Z')}])
  assert.deepEqual(parseFeed('<feed/>'),[])
  assert.throws(()=>parseFeed('<!DOCTYPE x><feed/>'))
  assert.throws(()=>parseFeed('x'.repeat(1_000_001)))
})

test('RSS preserves literal count evidence and binds it to the requested channel', () => {
  const entry = parseFeed(feedXml(), channel, NOW)[0]
  assert.equal(entry.hint, 'zero')
  assert.equal(entry.channelId, channel)
  assert.equal(entry.feed!.rawValue, '0')
  assert.equal(entry.feed!.checkedAt, NOW)
  for (const count of [null, '', '00', '0.0', '0abc', 'false', ' 0 ', '&#48;']) {
    assert.equal(parseFeed(feedXml(1, count), channel, NOW)[0].hint, 'unknown', String(count))
  }
  assert.equal(parseFeed(feedXml(1, '25'), channel, NOW)[0].hint, 'positive')
  assert.deepEqual(parseFeed(feedXml(), 'UC' + 'b'.repeat(22), NOW), [])
  assert.throws(() => parseFeed('<html>challenge</html>', channel, NOW))
  assert.throws(() => parseFeed('<feed><entry></feed>', channel, NOW))
  assert.deepEqual(parseFeed(feedXml(1,'0','2020-02-31T00:00:00Z'),channel,NOW),[])
})

test('native RSS roots may omit UC while entry channel IDs include it', () => {
  const xml = feedXml()
  assert.equal(parseFeed(xml, channel, NOW).length, 1)
  const prefixedRoot = xml.replace(`<yt:channelId>${channel.slice(2)}</yt:channelId>`, `<yt:channelId>${channel}</yt:channelId>`)
  assert.equal(parseFeed(prefixedRoot, channel, NOW).length, 1)
  assert.equal(parseFeed(xml, channel, NOW)[0].channelId, channel)
  assert.deepEqual(parseFeed(xml, 'UC' + 'b'.repeat(22), NOW), [])
  assert.deepEqual(parseFeed(xml.replace(channel.slice(2), 'b'.repeat(22)), channel, NOW), [])
})

test('real provider verifies RSS with public search metadata, never a private API', async () => {
  const paths: string[] = []
  const transport: typeof fetch = async (input) => {
    const url = input instanceof Request ? input.url : String(input)
    paths.push(new URL(url).pathname)
    assert.ok(!url.includes('/youtubei/'), 'private API must not be on the verification path')
    return new Response(url.includes('/feeds/') ? feedXml() : htmlJSON('ytInitialData',searchResponse()))
  }
  const provider = await createProvider(transport, 1)
  const result = await provider.verify(id())
  assert.equal(result.status, 'zero')
  assert.equal(result.record!.evidence.source, 'youtube/rss')
  assert.equal(result.record!.evidence.rawValue, '0')
  assert.equal(result.record!.seconds, 60)
  assert.deepEqual(paths, ['/results','/feeds/videos.xml'])
})

test('feed observations reuse matching metadata but never age an early zero into eligibility', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  let calls = 0
  let xml = feedXml()
  const provider = await createProvider(async () => { calls++; return new Response(xml) }, 1)
  const card = { id: id(), hint: 'zero' as const, channelId: channel, seconds: 60 }
  const old = parseFeed(feedXml(), channel, NOW)[0]
  assert.equal((await provider.verify(id(), { ...old, seconds: 60 })).status, 'zero')
  assert.equal(calls, 0, 'already observed RSS counts need no second feed request')
  xml = feedXml(1, '17')
  const young = parseFeed(feedXml(1, '0', new Date(NOW - DAY).toISOString()), channel, NOW)[0]
  assert.notEqual((await provider.verify(id(), { ...young, seconds: 60 })).status, 'zero')
  assert.equal(calls, 1, 'an early zero must be fetched again after aging')
  t.mock.timers.tick(60_001)
  xml = feedXml(1, null)
  assert.equal((await provider.verify(id(), card)).status, 'unknown')
  xml = feedXml()
  assert.equal((await provider.verify(id(), { ...card, hint: 'positive' })).status, 'nonzero')
})

test('RSS rejects missing duration, mismatched IDs, live cards, and contradictory positive hints', async () => {
  for(const mode of ['duration','live','id','positive','channel']){
    const value=searchResponse(mode==='id'?2:1,mode==='positive'?'1 view':'No views',mode==='duration'?'':'1:00')
    const card=value.contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer.contents[0].itemSectionRenderer.contents[0].videoRenderer
    if(mode==='live')card.thumbnailOverlays[0].thumbnailOverlayTimeStatusRenderer.style='LIVE'
    if(mode==='channel')card.ownerText.runs[0].navigationEndpoint.browseEndpoint.browseId='UC'+'b'.repeat(22)
    const provider=await createProvider(async(input)=>new Response(String(input).includes('/feeds/')?feedXml():htmlJSON('ytInitialData',value)),1)
    assert.notEqual((await provider.verify(id())).status,'zero',mode)
  }
})

test('a source cooldown frees a worker instead of occupying it while another source is available', async (t) => {
  const store = memory(t)
  store.pause(Date.now() + DAY, 'search unavailable', 'search')
  let calls = 0
  const fetcher = controlledFetch(store, { rps: 20, timeout: 1000 }, new AbortController().signal,
    async () => { calls++; return new Response('<feed/>') })
  await assert.rejects(fetcher('https://www.youtube.com/youtubei/v1/search'), (error: unknown) => error instanceof CrawlError && error.scope === 'search')
  await fetcher('https://www.youtube.com/feeds/videos.xml')
  assert.equal(calls, 1)
  assert.equal(store.meta('pause_until'), undefined)
})

test('an RSS HTTP 500 pauses RSS but leaves search requests available', async (t) => {
  const store = memory(t)
  const fetcher = controlledFetch(store, { rps: 20, timeout: 1000 }, new AbortController().signal,
    async (input) => new Response('', { status: String(input).includes('/feeds/') ? 500 : 200, headers: { 'retry-after': '60' } }))
  await assert.rejects(fetcher('https://www.youtube.com/feeds/videos.xml'), (error: unknown) => error instanceof CrawlError && error.scope === 'channel')
  assert.equal(store.meta('pause_until'), undefined)
  assert.ok(Number(store.meta('pause_channel_until')) > Date.now())
  assert.equal((await fetcher('https://www.youtube.com/youtubei/v1/search')).status, 200)
})

test('feed parsing failures retain their RSS error scope', async () => {
  const provider = await createProvider(async () => new Response('<feed><entry></feed>'), 1)
  await assert.rejects(provider.channel(channel), (error: unknown) => error instanceof CrawlError && error.scope === 'channel')
})

test('public search parsing failures never fall back to a private API', async () => {
  const provider = await createProvider(async () => new Response('<html>Unavailable</html>'), 1)
  await assert.rejects(provider.verify(id()), (error: unknown) => error instanceof CrawlError && error.scope === 'search')
})

test('Retry-After and exponential jitter are bounded and never overflow Date', () => {
  assert.equal(retryAfter('30',NOW),NOW+30_000)
  assert.equal(retryAfter(new Date(NOW+DAY).toUTCString(),NOW),NOW+DAY)
  assert.equal(retryAfter('bad',NOW),0)
  assert.equal(retryAfter('9999999999999999999999999999',NOW),0)
  assert.equal(retryDelay(0,()=>.5),5000)
  assert.equal(retryDelay(100,()=>.5),3_600_000)
})

test('global pacing applies to concurrent requests, not just worker starts', async (t) => {
  const store=memory(t)
  const starts:number[]=[]
  const fake:typeof fetch=async()=>{starts.push(performance.now());return new Response('{}')}
  const fetcher=controlledFetch(store,{rps:20,timeout:1000},new AbortController().signal,fake)
  await Promise.all([fetcher('https://www.youtube.com'),fetcher('https://www.youtube.com'),fetcher('https://www.youtube.com')])
  assert.equal(starts.length,3)
  assert.ok(starts[1]-starts[0]>=40)
  assert.ok(starts[2]-starts[1]>=40)
})

test('streamed HTTP bodies are bounded even without a Content-Length header', async (t) => {
  const store=memory(t)
  const fake:typeof fetch=async()=>new Response(new ReadableStream({start(controller){
    controller.enqueue(new Uint8Array(5*1024**2))
    controller.enqueue(new Uint8Array(4*1024**2))
    controller.close()
  }}))
  const fetcher=controlledFetch(store,{rps:20,timeout:1000},new AbortController().signal,fake)
  const response=await fetcher('https://www.youtube.com')
  await assert.rejects(response.arrayBuffer(),/exceeded 8 MiB/)
})

test('429 pauses persist across fetch instances and cancellation interrupts cooldown waits', async (t) => {
  const store=memory(t)
  const controller=new AbortController()
  let calls=0
  const fake:typeof fetch=async()=>{calls++;return new Response('',{status:429,headers:{'retry-after':'600'}})}
  const fetcher=controlledFetch(store,{rps:20,timeout:1000},controller.signal,fake)
  await assert.rejects(fetcher('https://www.youtube.com'),CrawlError)
  assert.ok(Number(store.meta('pause_until'))>=Date.now()+590_000)
  const second=controlledFetch(store,{rps:20,timeout:1000},controller.signal,fake)
  const rejection=assert.rejects(second('https://www.youtube.com'))
  controller.abort()
  await rejection
  assert.equal(calls,1)
})

test('gone videos and unavailable feeds are negative results, never false zero records or rapid retries', async (t) => {
  const store=memory(t)
  const fake:typeof fetch=async()=>new Response('',{status:404})
  const provider=await createProvider(controlledFetch(store,{rps:20,timeout:1000},new AbortController().signal,fake),1)
  assert.equal((await provider.verify(id())).status,'unavailable')
  assert.deepEqual(await provider.channel('UC'+'a'.repeat(22)),[])
  assert.equal(store.summary().today.find(m => m.name === 'http_channel_404')!.value, 1)
  assert.equal(store.summary().today.find(m => m.name === 'http_search_404')!.value, 1)
  assert.equal(store.meta('pause_until'),undefined)
})

test('timeouts and caller cancellation reach the underlying HTTP transport', async (t) => {
  const store=memory(t)
  const hold=setTimeout(()=>{},1000)
  t.after(()=>clearTimeout(hold))
  const fake:typeof fetch=async(_input,init)=>new Promise((_resolve,reject)=>{
    init!.signal!.addEventListener('abort',()=>reject(init!.signal!.reason),{once:true})
  })
  const fetcher=controlledFetch(store,{rps:20,timeout:20},new AbortController().signal,fake)
  await assert.rejects(fetcher('https://www.youtube.com'),/timeout|aborted/i)
})
