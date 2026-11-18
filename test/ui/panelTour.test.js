import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { contains, placeBadges, hitBoxes, stackOrder, stepIndex } from '../../src/components/tour/tourGeometry.js'
import { HELP } from '../../src/content/help/index.js'
import { helpTour, helpPage } from '../../src/content/help/tour.js'

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
    const tour = helpTour(HELP[id].controls, shots)
    if (!tour) continue
    const img = tour.image
    const spots = tour.spots
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

test('a badge goes outside its box where there is room', () => {
  const img = { w: 400, h: 300 }
  // Room on the left: beside the top of a tall box, centred beside a short one.
  assert.deepEqual(placeBadges([{ x: 100, y: 100, w: 80, h: 80 }], img, 18, 2), [{ x: 80, y: 100 }])
  assert.deepEqual(placeBadges([{ x: 100, y: 100, w: 60, h: 20 }], img, 18, 2), [{ x: 80, y: 101 }])
  // At the image's left edge a tall box uses its own top-left corner, a short one goes above.
  assert.deepEqual(placeBadges([{ x: 5, y: 100, w: 60, h: 60 }], img, 18, 2), [{ x: 8, y: 103 }])
  assert.deepEqual(placeBadges([{ x: 5, y: 100, w: 60, h: 20 }], img, 18, 2), [{ x: 5, y: 80 }])
})

test('badges keep clear of other controls and of each other', () => {
  // A row of chips 4 px apart (the EQ band's ON / S / x): left and above are
  // taken by the neighbour and the knob over them, so each goes below.
  const chips = [0, 1, 2].map(i => ({ x: 100 + i * 28, y: 200, w: 24, h: 20 }))
  const knob = { x: 90, y: 150, w: 100, h: 45 }
  const boxes = [knob, ...chips]
  const placed = placeBadges(boxes, { w: 400, h: 300 }, 18, 2)
  const rect = p => ({ x: p.x, y: p.y, w: 18, h: 18 })
  const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
  placed.forEach((p, i) => {
    boxes.forEach((b, j) => { if (i !== j) assert.ok(!overlaps(rect(p), b), `badge ${i} covers box ${j}`) })
    placed.forEach((q, j) => { if (i !== j) assert.ok(!overlaps(rect(p), rect(q)), `badges ${i} and ${j} overlap`) })
  })
})

test('a nested box may put its badge over its parent', () => {
  const gain = { x: 100, y: 50, w: 150, h: 150 }
  const auto = { x: 105, y: 180, w: 30, h: 15 }
  const [, b] = placeBadges([gain, auto], { w: 400, h: 300 }, 18, 2)
  assert.ok(b.x >= 0 && b.y >= 0)
})

test('on every help screenshot no badge covers another control or number', () => {
  const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
  let fallbacks = 0
  for (const id of Object.keys(HELP)) {
    let shots
    try { shots = JSON.parse(readFileSync(new URL(`../../src/content/help/shots/${id}.json`, import.meta.url), 'utf8')) } catch { continue }
    const tour = helpTour(HELP[id].controls, shots)
    if (!tour) continue
    const img = tour.image
    const boxes = tour.spots.map(s => s.at)
    const placed = placeBadges(boxes, img, 18, 3).map(p => ({ ...p, w: 18, h: 18 }))
    placed.forEach((p, i) => {
      const clear = boxes.every((b, j) => i === j || contains(b, boxes[i]) || !overlaps(p, b))
        && placed.every((q, j) => i === j || !overlaps(p, q))
      if (!clear) fallbacks++
    })
  }
  // The inside fallback may still touch something; it should be the rare case.
  assert.ok(fallbacks <= 6, `${fallbacks} badges fell back to a crowded place`)
})

test('with no free place a badge goes inside its own box, never off the picture', () => {
  // A tall box filling the picture, a smaller control in its top-left corner:
  // every place beside it is off the picture and its corner is taken, so the
  // fallback runs — and the last candidate for a tall box (below) is off the
  // bottom edge.
  const image = { w: 30, h: 60 }
  const boxes = [{ x: 0, y: 0, w: 30, h: 60 }, { x: 2, y: 2, w: 20, h: 20 }]
  const [b] = placeBadges(boxes, image, 18, 2)
  assert.deepEqual(b, { x: 3, y: 3 })
})

test('the tour numbers the controls the page lists, in the same order', () => {
  for (const id of Object.keys(HELP)) {
    let shots = null
    try { shots = JSON.parse(readFileSync(new URL(`../../src/content/help/shots/${id}.json`, import.meta.url))) } catch { continue }
    const { controls, tour } = helpPage(HELP[id].controls, shots)
    if (!tour) continue
    const listed = controls.map(c => c.shot).filter(s => tour.spots.some(t => t.id === s))
    assert.deepEqual(tour.spots.map(s => s.id), listed, id)
  }
})
