import assert from 'node:assert/strict'
import { test } from 'node:test'
import { id, video, memory, NOW, channel } from './helpers.ts'

test('old Arranging Data Into Lists finds are archived as unverified hints with their saved metadata', (t) => {
  const store = memory(t)
  assert.equal(store.save(video(1), '', NOW), true)
  const found = Date.UTC(2024, 10, 9)
  const result = store.importOld([
    { videoId: id(1), title: 'Already verified', foundAt: found },
    { videoId: id(2), title: 'Old find', description: 'd', seconds: 3725, uploadDate: '2024-11-01', author: { name: ' A ', url: 'https://youtube.com/@a' }, q: 'gadgets', foundAt: found },
    { videoId: id(3), title: 'With channel', seconds: 9, uploadDate: '', author: { name: 'B', id: channel }, foundAt: found },
    { videoId: id(2), title: 'Duplicate', foundAt: found },
    { videoId: 'bad', title: 'x', foundAt: found },
    { videoId: id(4), title: 'Future', foundAt: NOW + 1 },
    { videoId: id(5), title: 'Bad date', uploadDate: '2024-13-40', foundAt: found }
  ], NOW)
  assert.deepEqual(result, { added: 2, skipped: 5 })
  const rows = store.page(10)
  assert.equal(rows.find((v) => v.videoId === id(1))?.title, 'A test video')
  const old = rows.find((v) => v.videoId === id(2))!
  assert.equal(old.verification, 'hint')
  assert.equal(old.foundAt, found)
  assert.equal(old.timestamp, '1:02:05')
  assert.equal(old.author.name, 'A')
  assert.equal(old.author.id, '')
  assert.equal(old.meta.q, 'gadgets')
  assert.equal(old.evidence.source, 'arranging/v1')
  assert.equal(rows.find((v) => v.videoId === id(3))?.author.id, channel)
  // Nothing is queued: imported finds make no YouTube requests.
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM tasks').get()!.n, 0)
})
