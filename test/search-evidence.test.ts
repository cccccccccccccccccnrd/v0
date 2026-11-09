import assert from 'node:assert/strict'
import { test } from 'node:test'
import { minimumAgeDays, reportedZero } from '../search-evidence.ts'
import { searchNodes } from '../page.ts'
import { htmlJSON, searchResponse, NOW } from './helpers.ts'

test('relative age bounds reject uncertain week/day boundaries without inventing upload timestamps', () => {
  for (const label of ['7 days ago','1 week ago','today','yesterday','2 hours ago','Tomorrow','3.5 weeks ago','1m ago','1h ago','1w ago','7d ago','']) {
    assert.ok((minimumAgeDays(label) ?? 0) < 7, label)
  }
  for (const [label, days] of [['8 days ago',7],['2 weeks ago',7],['1 month ago',14],['1 year ago',180],['Streamed 3 years ago',730],['1y ago',180],['3mo ago',56],['2w ago',7],['8d ago',7]] as const) {
    assert.equal(minimumAgeDays(label), days)
  }
})

test('reported-zero evidence requires the actual count field, old age, valid identity and non-live duration', () => {
  const response=searchResponse()
  const renderer=response.contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer.contents[0].itemSectionRenderer.contents[0].videoRenderer
  const observation=()=>reportedZero(searchNodes(htmlJSON('ytInitialData',response))[0],NOW)
  assert.equal(observation()!.tier,'search-reported')
  assert.equal(observation()!.viewLabel,'No views')
  for(const label of ['Unknown','1 view','0.0K views','', 'No views available']){
    renderer.viewCountText.simpleText=label
    renderer.ownerText.runs[0].text='No views'
    assert.equal(observation(),undefined,label)
  }
  renderer.viewCountText.simpleText='0 views'
  renderer.publishedTimeText.simpleText='1 week ago'
  assert.equal(observation(),undefined)
  renderer.publishedTimeText.simpleText='2 weeks ago'
  assert.equal(observation()!.minAgeDays,7)
  renderer.publishedTimeText.simpleText='1y ago'
  assert.equal(observation()!.minAgeDays,180)
  renderer.ownerText.runs[0].navigationEndpoint.browseEndpoint.browseId=''
  assert.equal(observation()!.channelId,undefined,'an unknown creator does not fabricate or invalidate count/age evidence')
  renderer.thumbnailOverlays[0].thumbnailOverlayTimeStatusRenderer.style='LIVE'
  assert.equal(observation(),undefined)
})
