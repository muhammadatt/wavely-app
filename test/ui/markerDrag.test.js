/**
 * Grabbing a marker by its flag in the waveform's ruler gutter.
 *
 * Run with:  npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hitMarker, inMarkerLane, MARKER_GRAB_PX } from '../../src/audio/markerDrag.js'
import { RULER_GUTTER_HEIGHT } from '../../src/audio/renderer.js'

// Markers at 2 s and 5 s, at 100 px/s with the view at the start of the file,
// put their flags at 200 px and 500 px.
const MARKERS = [{ id: 'a', time: 2 }, { id: 'b', time: 5 }]
const VIEW = { scrollLeft: 0, pixelsPerSecond: 100 }

const hit = (xPx, opts = {}) => hitMarker({ markers: MARKERS, xPx, ...VIEW, ...opts })

test('a marker is grabbable at its own position', () => {
  assert.equal(hit(200), 'a')
  assert.equal(hit(500), 'b')
})

test('the grab radius reaches either side, and stops', () => {
  assert.equal(hit(200 + MARKER_GRAB_PX), 'a')
  assert.equal(hit(200 - MARKER_GRAB_PX), 'a')
  assert.equal(hit(200 + MARKER_GRAB_PX + 1), null)
  assert.equal(hit(200 - MARKER_GRAB_PX - 1), null)
})

test('empty space between markers grabs nothing', () => {
  assert.equal(hit(350), null)
})

test('two markers inside one grab radius are still individually reachable', () => {
  // 4 px apart at this zoom — closer than the grab radius, so both are in
  // range of a click between them. Aiming at one has to get that one.
  const close = [{ id: 'left', time: 3 }, { id: 'right', time: 3.04 }]
  const at = xPx => hitMarker({ markers: close, xPx, ...VIEW })
  assert.equal(at(300), 'left')
  assert.equal(at(304), 'right')
})

test('no markers, no zoom and no array all return null rather than throwing', () => {
  assert.equal(hitMarker({ markers: [], xPx: 10, ...VIEW }), null)
  assert.equal(hitMarker({ markers: undefined, xPx: 10, ...VIEW }), null)
  assert.equal(hitMarker({ markers: MARKERS, xPx: 10, scrollLeft: 0, pixelsPerSecond: 0 }), null)
})

test('scrolling the view moves the hit target with the marker', () => {
  // Scrolled 1 s in, the marker at 2 s draws at 100 px, not 200.
  const scrolled = { markers: MARKERS, scrollLeft: 1, pixelsPerSecond: 100 }
  assert.equal(hitMarker({ ...scrolled, xPx: 100 }), 'a')
  assert.equal(hitMarker({ ...scrolled, xPx: 200 }), null)
})

test('the marker lane is the ruler gutter and nothing below it', () => {
  assert.equal(inMarkerLane(0, RULER_GUTTER_HEIGHT), true)
  assert.equal(inMarkerLane(RULER_GUTTER_HEIGHT, RULER_GUTTER_HEIGHT), true)
  assert.equal(inMarkerLane(RULER_GUTTER_HEIGHT + 1, RULER_GUTTER_HEIGHT), false)
  // Above the canvas is not the lane either — a drag that ran off the top
  // must not read as still being in the gutter.
  assert.equal(inMarkerLane(-1, RULER_GUTTER_HEIGHT), false)
})
