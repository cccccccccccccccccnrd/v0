import assert from 'node:assert/strict'
import { test } from 'node:test'
import { minimumAgeDays } from '../src/config.ts'

test('relative age bounds reject uncertain week/day boundaries without inventing upload timestamps', () => {
  for (const label of ['7 days ago','1 week ago','today','yesterday','2 hours ago','Tomorrow','3.5 weeks ago','1m ago','1h ago','1w ago','7d ago','']) {
    assert.ok((minimumAgeDays(label) ?? 0) < 7, label)
  }
  for (const [label, days] of [['8 days ago',7],['2 weeks ago',7],['1 month ago',14],['1 year ago',180],['Streamed 3 years ago',730],['1y ago',180],['3mo ago',56],['2w ago',7],['8d ago',7]] as const) {
    assert.equal(minimumAgeDays(label), days)
  }
})
