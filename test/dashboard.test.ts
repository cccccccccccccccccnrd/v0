import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { test } from 'node:test'
import { MIN_AGE, config, searchRange } from '../config.ts'

const html = readFileSync(new URL('../dashboard.html', import.meta.url), 'utf8')
const learned = html.match(/<table id="learned-table">([\s\S]*?)<\/table>/)![1]
const entries = [...learned.matchAll(/<tr><td><bdi lang="([^"]+)">([^<]+)<\/bdi><\/td><td>([^<]+)<\/td><td>(\d+)<\/td><td>(\d+)<\/td><\/tr>/g)]

test('standalone dashboard is dated, self-contained and translates every displayed Chinese term', () => {
  assert.match(html, /This file does not update automatically/)
  assert.match(html, /background: #000; color: #fff/)
  assert.match(html, /font-family: Arial, sans-serif/)
  assert.match(html, /h1, h2, h3, th, strong \{ font-weight: normal; \}/)
  assert.match(html, /<time datetime="\d{4}-\d{2}-\d{2}T/)
  assert.match(html, /translations are for reading only/i)
  assert.match(html, /default-src 'none'/)
  assert.doesNotMatch(html, /<script[^>]+src=|<link[^>]+rel="stylesheet"|<iframe|<canvas|<svg|\bfetch\s*\(/i)
  assert.equal(entries.length, 30)
  for (const [, language, term, english] of entries) {
    assert.ok(english.trim())
    if (language === 'zh') {
      assert.notEqual(english, term)
      assert.doesNotMatch(english, /\p{Script=Han}/u)
    }
  }
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1])
  assert.equal(new Set(ids).size, ids.length)
  for (const [, id] of html.matchAll(/href="#([^"]+)"/g)) assert.ok(ids.includes(id))
})

test('dashboard documents historical retention and the deployed RSS qualification rules', () => {
  const retention = html.match(/<section aria-labelledby="retention">([\s\S]*?)<\/section>/)![1]
  const qualifications = html.match(/<section aria-labelledby="qualifications">([\s\S]*?)<\/section>/)![1]
  assert.match(retention, /Clicking a video does not remove it from yt0/)
  assert.match(retention, /even if they later gain views/)
  assert.match(retention, /not automatically rechecked or overwritten/)
  assert.match(retention, /no automatic age expiry/)
  assert.match(retention, /not a copy of the video/)
  assert.equal(MIN_AGE / 3_600_000, 168)
  assert.match(qualifications, /t_obs − t_pub ≥ 168h/)
  assert.match(qualifications, /dateOnly\(pub\) \? utcDayStart\(pub\) \+ 24h : timestamp\(pub\)/)
  assert.match(qualifications, /<pre><code>/)
  assert.doesNotMatch(qualifications, /<ol>|<li>/)
  for (const rule of [/validTime\(t_pub, t_obs\)/, /rss\.statistics\.@views === "0"/,
    /validIds\(video, channel\)/, /identitiesMatch\(rss, metadata\)/, /trim\(rss\.title\) ≠ ""/,
    /metadata\.matches\(video, channel\)/, /isSafeInteger\(duration_s\) ∧ duration_s &gt; 0/,
    /¬flags\.any\(LIVE, UPCOMING, SCHEDULED, PREMIERING\)/, /metadata\.viewHint ≠ POSITIVE/,
    /archiveOnce\(video/, /source: "youtube\/rss"/, /field: "media:statistics\/@views"/,
    /rawValue: "0"/, /checkedAt: t_obs/, /Refresh pre-cutoff zero observations/,
    /no maximum age/, /Shorts allowed/, /Legacy imports require independent qualification/]) {
    assert.match(qualifications, rule)
  }
})

test('search flowchart separates discovery, numeric proof and feedback without live dependencies', () => {
  const flow = html.match(/<section aria-labelledby="search-flow">([\s\S]*?)<\/section>/)![1]
  assert.match(flow, /<figure aria-labelledby="flow-caption">/)
  assert.equal([...flow.matchAll(/<ol class="flow-steps"/g)].length, 2)
  for (const label of ['keyword-path', 'channel-path', 'verification-gate']) assert.match(flow, new RegExp(`id="${label}"`))
  for (const rule of [/two slices per run by default/, /at most one unknown/, /up to 40 verification candidates/,
    /up to three creators/, /limited recent feed, not the full upload history/, /Check ownership and match video IDs/,
    /exact-video-ID search/, /views="0"/, /age ≥ 168 hours/, /Search hints alone never qualify/,
    /Too young → wait → verify again/, /Unknown ≠ zero/, /up to two eligible words/,
    /Channel credit does not flow back/, /after 6 hours/, /otherwise 12 hours/,
    /60 seconds apart by default/, /a video that has aged out of RSS/i,
    /statistics elsewhere on this page remain the dated November 2 snapshot/]) assert.match(flow, rule)
  assert.equal(MIN_AGE / 3_600_000, 168)
  const defaults = config({})
  assert.equal(defaults.pages, 2)
  assert.equal(defaults.searchRequestInterval / 1000, 60)
  assert.deepEqual(['recent', 'older', 'archive'].map(window => searchRange(window as 'recent' | 'older' | 'archive')[2]), [1, 7, 30])
  assert.doesNotMatch(flow, /<script|<iframe|<img|<svg|<canvas|\bfetch\s*\(/i)
})

test('snapshot table totals agree without treating overlapping periods as independent', () => {
  const bodies = [...html.matchAll(/<tbody>([\s\S]*?)<\/tbody>/g)].map(match => match[1])
  const counts = (body: string) => [...body.matchAll(/<td>([\d,]+)<\/td>\s*<\/tr>/g)].map(match => Number(match[1].replaceAll(',', '')))
  const discoveries = counts(bodies[0])
  assert.equal(counts(bodies[1]).reduce((sum, n) => sum + n, 0), discoveries[0])
  assert.equal(counts(bodies[2]).reduce((sum, n) => sum + n, 0), discoveries[1])
  assert.equal(counts(bodies[3]).reduce((sum, n) => sum + n, 0), counts(bodies[6])[0])
  assert.equal(counts(bodies[5]).reduce((sum, n) => sum + n, 0), 704)
  assert.equal(discoveries[4], 490)
  assert.equal(discoveries[5], 18)
})

test('learned-term filter searches both scripts, handles no results and resets', () => {
  let onInput: () => void = () => {}
  const input = { value: '', addEventListener(event: string, handler: () => void) {
    assert.equal(event, 'input'); onInput = handler
  } }
  const output = { textContent: '' }
  const rows = entries.map(([, , term, english]) => ({
    hidden: false, cells: [{ textContent: term }, { textContent: english }]
  }))
  const context = vm.createContext({ document: {
    getElementById: (id: string) => id === 'term-filter' ? input : output,
    querySelectorAll: () => rows
  } })
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)![1], context)
  for (const query of ['COSMIC CIVILIZATION', '宇宙文明']) {
    input.value = query; onInput()
    assert.equal(rows.filter(row => !row.hidden).length, 1)
    assert.equal(output.textContent, '1 of 30 terms shown.')
  }
  input.value = '<img src=x onerror=alert(1)>'; onInput()
  assert.ok(rows.every(row => row.hidden))
  assert.equal(output.textContent, '0 of 30 terms shown.')
  input.value = '   '; onInput()
  assert.ok(rows.every(row => !row.hidden))
  assert.equal(output.textContent, '30 of 30 terms shown.')
})
