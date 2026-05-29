/**
 * Tests for the per-call threading context.
 *
 * Validates that:
 *   1. withThreadLimit sets a value readable via getThreadLimit inside its
 *      callback, and clears it after.
 *   2. Nested withThreadLimit calls inherit the innermost value.
 *   3. The context propagates across awaits (the whole point of
 *      AsyncLocalStorage — a plain mutable global wouldn't survive
 *      interleaved promise chains).
 *
 * Run with:  cd server && npm test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { withThreadLimit, getThreadLimit } from '../pipeline/threadingContext.js'

test('threadingContext: getThreadLimit is undefined outside a withThreadLimit scope', () => {
  assert.equal(getThreadLimit(), undefined)
})

test('threadingContext: getThreadLimit returns the value set by the surrounding withThreadLimit', async () => {
  let observed = null
  await withThreadLimit(4, async () => {
    observed = getThreadLimit()
  })
  assert.equal(observed, 4)
  assert.equal(getThreadLimit(), undefined, 'context should not leak after the callback returns')
})

test('threadingContext: nested withThreadLimit inherits the innermost value', async () => {
  let outerBefore, inner, outerAfter
  await withThreadLimit(8, async () => {
    outerBefore = getThreadLimit()
    await withThreadLimit(2, async () => {
      inner = getThreadLimit()
    })
    outerAfter = getThreadLimit()
  })
  assert.equal(outerBefore, 8)
  assert.equal(inner, 2)
  assert.equal(outerAfter, 8, 'outer context should restore after inner returns')
})

test('threadingContext: value propagates across awaits and parallel promises', async () => {
  // The motivating use case: runChunkedBlock sets the context, then awaits
  // an async dispatch chain that ultimately calls runPython. The value
  // must survive every await and every parallel branch.
  const seen = []
  await withThreadLimit(3, async () => {
    await Promise.all([
      (async () => { await Promise.resolve(); seen.push(getThreadLimit()) })(),
      (async () => { await new Promise(r => setImmediate(r)); seen.push(getThreadLimit()) })(),
      (async () => { await new Promise(r => setTimeout(r, 5));   seen.push(getThreadLimit()) })(),
    ])
  })
  assert.deepEqual(seen, [3, 3, 3], 'all parallel branches should see the same context value')
})
