import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { id } from './helpers.ts'

function gallery(respond: (url: string) => unknown) {
  const nodes = new Map<string, any>(), texts: string[] = [], urls: string[] = [], requests: string[] = []
  function element(tag = ''): any {
    let text = ''
    return { tag, children: [] as any[], value: '', hidden: false, disabled: false, attrs: {} as Record<string,string>,
      classList: { add() {} }, addEventListener() {},
      setAttribute(name: string, value: string) { this.attrs[name] = value },
      append(...items: any[]) { for (const item of items) { if (typeof item === 'string') texts.push(item); this.children.push(...(item?.tag === 'fragment' ? item.children : [item])) } },
      replaceChildren(...items: any[]) { this.children = []; this.append(...items) },
      set textContent(value: unknown) { text = String(value); texts.push(text) }, get textContent() { return text },
      set href(value: string) { urls.push(value) }, set src(value: string) { urls.push(value) },
      set innerHTML(_value: string) { throw new Error('Unsafe HTML assignment') }
    }
  }
  const document = { body: { scrollHeight: 2000 }, getElementById(key: string) { if (!nodes.has(key)) nodes.set(key, element()); return nodes.get(key) },
    querySelector(key: string) { if (!nodes.has(key)) nodes.set(key, element()); return nodes.get(key) },
    createElement: element, createDocumentFragment: () => element('fragment') }
  const context = vm.createContext({ document, AbortSignal, console, window: { addEventListener() {}, innerHeight: 800, scrollY: 0 },
    fetch: async (url: string) => { requests.push(url); const data = await respond(url); return { ok: true, json: async () => data } } })
  vm.runInContext(readFileSync(new URL('../public/site.js', import.meta.url), 'utf8'), context)
  return { context, nodes, texts, urls, requests }
}
const tick = () => new Promise(resolve => setImmediate(resolve))
const row = (n: number, author = 'Author') => ({ videoId: id(n), title: 'Title ' + n, author: { name: author },
  timestamp: '1:00', uploadDate: '2020-01-01', meta: { q: 'term' }, verification: 'verified' })

test('original gallery keeps five filters, combines selections and renders hostile metadata safely', async () => {
  const evil = { ...row(1), title: '<img src=x onerror=alert(1)>', url: 'javascript:alert(1)', thumbnail: 'javascript:bad()' }
  const g = gallery(() => ({ videos: [evil, row(2, 'Different')], cursor: null }))
  await tick()
  assert.equal(g.nodes.get('header').children.length, 5)
  assert.ok(g.nodes.get('header').children.every((select: any) => select.attrs['aria-label']))
  assert.equal(g.nodes.get('v0').children.length, 2)
  assert.ok(g.texts.some(text => text.includes(evil.title)))
  assert.ok(g.urls.every(url => /^https:\/\/(?:www\.youtube\.com\/watch\?v=|i\.ytimg\.com\/vi\/)/.test(url)))
  vm.runInContext("selects.get('author.name').value='Different'; selects.get('title').value='Title 2'; render()", g.context)
  assert.equal(g.nodes.get('v0').children.length, 1)
  vm.runInContext("selects.get('title').value='<img src=x onerror=alert(1)>'; render()", g.context)
  assert.equal(g.nodes.get('v0').children.length, 0, 'filters combine instead of silently ignoring other selections')
  assert.equal(g.nodes.get('more').hidden, true)
})

test('gallery retries the same cursor, prevents concurrent loads, deduplicates and refreshes filter options', async () => {
  let count = 0
  const g = gallery(() => {
    count++
    if (count === 1) return { videos: [row(1)], cursor: 'next_cursor' }
    if (count === 2) throw new Error('temporary failure')
    return { videos: [row(1), row(2, 'New author'), { videoId: 'bad' }], cursor: null }
  })
  await tick()
  await vm.runInContext('Promise.all([load(),load()])', g.context)
  assert.equal(g.requests.length, 2)
  assert.equal(g.nodes.get('more').textContent, 'Retry')
  await vm.runInContext('load()', g.context)
  assert.equal(g.requests[1], '/api/videos?limit=500&cursor=next_cursor')
  assert.equal(g.requests[2], g.requests[1], 'a failed request must not skip a page')
  assert.equal(g.nodes.get('v0').children.length, 2)
  assert.ok(vm.runInContext("selects.get('author.name').children.some(option=>option.value==='New author')", g.context))
  await vm.runInContext('load()', g.context)
  assert.equal(g.requests.length, 3, 'end-of-archive must not repeatedly fetch page one')
})

test('public routing allowlists gallery paths and sends all other paths to a fixed 404', () => {
  const config = JSON.parse(readFileSync(new URL('../deploy/yt0.yml', import.meta.url), 'utf8')).http
  assert.ok(config.routers['yt0-site'].rule.startsWith('Host(`v0.cnrd.computer`) && ('))
  assert.equal(config.routers['yt0-private-deny'].rule, 'Host(`v0.cnrd.computer`)')
  // The old host names only redirect, keeping the path, and never reaches the app.
  const old = config.routers['yt0-old-host']
  assert.equal(old.rule, 'Host(`yt0.cnrd.computer`) || Host(`yt0.c-e.group`)')
  assert.ok(old.priority > config.routers['yt0-site'].priority)
  assert.ok(old.middlewares.includes('yt0-moved'))
  const moved = config.middlewares['yt0-moved'].redirectRegex
  for (const from of ['https://yt0.c-e.group/v1?x=1', 'https://yt0.cnrd.computer/v1?x=1'])
    assert.equal(from.replace(new RegExp(moved.regex), moved.replacement.replace('${1}', '$1')), 'https://v0.cnrd.computer/v1?x=1')
  for (const path of ['/','/site.js','/site.css','/api/videos']) assert.ok(config.routers['yt0-site'].rule.includes('Path(`'+path+'`)'))
  assert.ok(!config.routers['yt0-site'].rule.includes('/api/status'))
  assert.ok(!config.routers['yt0-site'].rule.includes('PathPrefix'))
  assert.ok(config.routers['yt0-site'].priority > config.routers['yt0-private-deny'].priority)
  assert.equal(config.middlewares['yt0-deny'].replacePath.path, '/__not_public__')
  assert.equal(config.middlewares['yt0-root'].replacePathRegex.regex, '^/$')
  assert.equal(config.services.yt0.loadBalancer.servers[0].url, 'http://172.22.0.1:3668')
})

test('empty archives and malformed cursors do not become fake video cards', async () => {
  const empty = gallery(() => ({ videos: [], cursor: null }))
  await tick()
  assert.equal(empty.nodes.get('v0').children.length, 0)
  assert.equal(empty.nodes.get('more').hidden, true)
  const bad = gallery(() => ({ videos: [row(1)], cursor: '../invalid' }))
  await tick()
  assert.equal(bad.nodes.get('v0').children.length, 0)
  assert.equal(bad.nodes.get('more').textContent, 'Retry')
})
