import { test } from 'node:test'
import assert from 'node:assert/strict'
import { crossingRuns } from '../../src/components/meters/clipperRuns.js'

const runsOf = (peaks, threshold = 0.5) =>
  crossingRuns(peaks, 0, peaks.length, peaks.length, threshold)

test('separate crossings stay separate', () => {
  // The bug: one shared path joined these two, filling the gap between them
  // with a triangle over signal that never crossed.
  assert.deepEqual(runsOf([0.1, 0.9, 0.1, 0.1, 0.8, 0.1]), [[1, 1], [4, 4]])
})

test('adjacent crossing columns are one run', () => {
  assert.deepEqual(runsOf([0.1, 0.9, 0.8, 0.7, 0.1]), [[1, 3]])
})

test('a run touching either end is closed at that end', () => {
  assert.deepEqual(runsOf([0.9, 0.9, 0.1]), [[0, 1]])
  assert.deepEqual(runsOf([0.1, 0.9, 0.9]), [[1, 2]])
  assert.deepEqual(runsOf([0.9, 0.9, 0.9]), [[0, 2]])
})

test('nothing crossing yields nothing to draw', () => {
  assert.deepEqual(runsOf([0.1, 0.2, 0.5]), [])
})

test('the threshold itself is not a crossing', () => {
  // Strict, matching the kernel's own "did this peak cross" pairing: a peak
  // exactly at the ceiling has had nothing taken off it.
  assert.deepEqual(runsOf([0.5, 0.5]), [])
})

test('walks the ring from an arbitrary start, wrapping', () => {
  // capacity 6, oldest column at index 4 — the arrangement the scope reads.
  const ring = [0.9, 0.1, 0.1, 0.1, 0.1, 0.8]
  assert.deepEqual(crossingRuns(ring, 4, 6, 6, 0.5), [[1, 2]])
})
