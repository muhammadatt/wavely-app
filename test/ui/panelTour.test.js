import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { badgePlace, contains, hitBoxes, stackOrder, stepIndex } from '../../src/components/tour/tourGeometry.js'
import { HELP } from '../../src/content/help/index.js'
import { helpTourSpots, tourImage } from '../../src/content/help/tour.js'

const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

test('a small hotspot grows to the minimum size in free space', () => {
  const [h] = hitBoxes([{ x: 100, y: 100, w: 20, h: 10 }], { w: 400, h: 400 }, 40)
  assert.deepEqual(h, { x: 90, y: 85, w: 40, h: 40 })
})

test('a box already big enough is left alone', () => {
  const box = { x: 10, y: 10, w: 100, h: 80 }
  assert.deepEqual(hitBoxes([box], { w: 400, h: 400 }, 40)[0], box)
})

test('growth stops halfway to a neighbour, never into it', () => {
  const a = { x: 100, y: 100, w: 30, h: 10 }
  const b = { x: 100, y: 120, w: 30, h: 10 } // 10 px below a
  const [ha, hb] = hitBoxes([a, b], { w: 400, h: 400 }, 44)
  assert.equal(ha.y + ha.h, 115)
  assert.equal(hb.y, 115)
  assert.ok(!overlaps(ha, b) && !overlaps(hb, a))
})

test('a nested box ignores its parent; the stacking puts it on top', () => {
  const gain = { x: 0, y: 0, w: 200, h: 200 }
  const auto = { x: 20, y: 180, w: 20, h: 10 }
  const [, h] = hitBoxes([gain, auto], { w: 400, h: 400 }, 32)
  assert.equal(h.w, 32)
  assert.equal(h.h, 32)
  const z = stackOrder([gain, auto])
  assert.ok(z[1] > z[0])
  assert.ok(contains(gain, auto))
})

test('hit areas are clamped to the image', () => {
  const [h] = hitBoxes([{ x: 0, y: 0, w: 4, h: 4 }], { w: 400, h: 400 }, 44)
  assert.deepEqual(h, { x: 0, y: 0, w: 24, h: 24 })
})

test('on every tour page no grown hit area covers another control', () => {
  for (const id of Object.keys(HELP)) {
    let shots
    try { shots = JSON.parse(readFileSync(new URL(`../../src/content/help/shots/${id}.json`, import.meta.url), 'utf8')) } catch { continue }
    const img = tourImage(shots)
    const spots = helpTourSpots(HELP[id].controls, shots)
    const boxes = spots.map(s => s.at)
    // 44 px at a phone's ~0.45 scale is ~98 image px: the hardest case.
    for (const min of [32, 98]) {
      const hits = hitBoxes(boxes, img, min)
      hits.forEach((h, i) => boxes.forEach((o, j) => {
        if (i === j || contains(o, boxes[i]) || contains(boxes[i], o) || overlaps(boxes[i], o)) return
        assert.ok(!overlaps(h, o), `${id}: ${spots[i].id}'s hit area covers ${spots[j].id} at ${min}`)
      }))
    }
  }
})

test('arrow keys step through the controls and wrap', () => {
  assert.equal(stepIndex('ArrowRight', 0, 3), 1)
  assert.equal(stepIndex('ArrowDown', 2, 3), 0)
  assert.equal(stepIndex('ArrowLeft', 0, 3), 2)
  assert.equal(stepIndex('ArrowUp', 1, 3), 0)
  assert.equal(stepIndex('Home', 2, 3), 0)
  assert.equal(stepIndex('End', 0, 3), 2)
  assert.equal(stepIndex('Enter', 0, 3), null)
  assert.equal(stepIndex('ArrowRight', 0, 0), null)
})

test('badges sit in the corner of a large box and beside a short one', () => {
  assert.equal(badgePlace({ x: 100, y: 0, w: 100, h: 100 }), 'corner')
  assert.equal(badgePlace({ x: 100, y: 0, w: 100, h: 20 }), 'side')
  assert.equal(badgePlace({ x: 4, y: 0, w: 100, h: 20 }), 'inside')
})
