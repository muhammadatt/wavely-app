/**
 * Run with:  npm test
 *
 * VOCAL CHAIN DYNAMICS — panel params and the kernel mapping.
 *
 * ⚠ THE LOAD-BEARING TEST IS `nothing measured can reach a preset`. The section
 * is macro-driven: a saved patch is a density, a voicing and a blend, which
 * describe an INTENTION. The threshold, the two drives, the two alignment
 * offsets and the blend's correlation all describe THE FILE, and one of them in
 * a preset applies another recording's gain staging to this one — the
 * portability failure the whole alignment mechanism exists to remove, arriving
 * one level up.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DYNAMICS_DEFAULTS, DYNAMICS_MEASURED_KEYS, DYNAMICS_LATENCY_SAMPLES,
  toKernelParams, toLiveKernelParams, dynamicsPreRollSeconds,
} from '../../src/audio/effects/dynamicsParams.js'
import {
  DYNAMICS_KERNEL_DEFAULTS, DynamicsKernel,
} from '../../src/audio/dynamicsProcessor.js'

test('nothing measured can reach a preset', () => {
  for (const key of DYNAMICS_MEASURED_KEYS) {
    assert.ok(!(key in DYNAMICS_DEFAULTS),
      `${key} is measured from the file and must not be a panel param`)
  }
  // And the panel holds only the four things a patch should describe.
  assert.deepEqual(Object.keys(DYNAMICS_DEFAULTS).sort(),
    ['density', 'mix', 'outputDb', 'voicing'])
})

test('an un-solved panel maps to the kernel\'s own defaults', () => {
  const mapped = toKernelParams(DYNAMICS_DEFAULTS)
  // The clipper stays off: its threshold is measured, and absent means bypass
  // rather than "clip at zero".
  assert.equal(mapped.clipThresholdDb, null)
  assert.equal(mapped.squash, DYNAMICS_KERNEL_DEFAULTS.squash)
  assert.equal(mapped.fetAlignDb, 0)
})

test('a live push CLEARS the measured keys when no solve is in force', () => {
  /**
   * The kernel MERGES a partial, so an omitted key means "unchanged", not
   * "none" — and a stale alignment left armed on a running node is a compressor
   * doing a different amount of work from what the panel says. Measured, silent
   * and preview-only when this shipped on OptoSmooth; see effects/measuredKeys.js.
   */
  const live = toLiveKernelParams(DYNAMICS_DEFAULTS, null)
  for (const key of DYNAMICS_MEASURED_KEYS) {
    assert.equal(live[key], null, `${key} was not cleared`)
  }
  // With a solve in force nothing is cleared — the values ARE the solve.
  const solved = { clipThresholdDb: -12, fetDrive: 40, fetAlignDb: 1.1, squash: 37, optoAlignDb: 8.4, correlation: 0.95, densityDb: -0.2 }
  const withSolve = toLiveKernelParams(DYNAMICS_DEFAULTS, solved)
  for (const key of DYNAMICS_MEASURED_KEYS) {
    assert.equal(withSolve[key], solved[key], `${key} did not survive`)
  }
})

test('⚠ Mix is the panel\'s and overrides the solve\'s', () => {
  /**
   * The solve measures the blend at Mix 1, the worst case, precisely so the mix
   * law stays valid wherever the knob lands afterwards — the same reasoning
   * Scheps uses for sizing its ceiling knee at Mix 1. So a user's Mix must win
   * over the voicing's, and null must mean "take the voicing's".
   */
  const solved = { mix: 0.4 }
  assert.equal(toKernelParams({ ...DYNAMICS_DEFAULTS, mix: null }, solved).mix, 0.4)
  assert.equal(toKernelParams({ ...DYNAMICS_DEFAULTS, mix: 0.8 }, solved).mix, 0.8)
  // Zero is a real setting — clip and FET with no opto — not "unset".
  assert.equal(toKernelParams({ ...DYNAMICS_DEFAULTS, mix: 0 }, solved).mix, 0)
})

test('the mapping produces params the kernel actually reads', () => {
  const solved = { clipThresholdDb: -11, fetDrive: 38, fetAlignDb: 1.0, squash: 33, optoAlignDb: 7.9, correlation: 0.94, densityDb: 0.1, fetRatio: '8', character: 'presence' }
  const mapped = toKernelParams({ ...DYNAMICS_DEFAULTS, outputDb: 2 }, solved)
  const kernelKeys = new Set(Object.keys(DYNAMICS_KERNEL_DEFAULTS))
  for (const key of Object.keys(mapped)) {
    assert.ok(kernelKeys.has(key), `${key} is not a kernel param — it will be ignored`)
  }
  // And the solve's ballistics and character come through, not just its levels.
  assert.equal(mapped.fetRatio, '8')
  assert.equal(mapped.character, 'presence')
  assert.equal(mapped.outputDb, 2)
})

test('the published latency matches what the kernel reports', () => {
  // The apply path trims this constant; a disagreement splices every applied
  // region late by the difference and drops that much of its tail.
  assert.equal(DYNAMICS_LATENCY_SAMPLES, new DynamicsKernel(44100).latencySamples)
})

test('the pre-roll follows the solve\'s ballistics, not the panel\'s', () => {
  // Ballistics arrive with the solve, so the apply path's pre-roll has to be
  // computed from the MAPPED params rather than from panel state.
  const slow = toKernelParams(DYNAMICS_DEFAULTS, { fetRelease: 1, fetRatio: 'all' })
  const fast = toKernelParams(DYNAMICS_DEFAULTS, { fetRelease: 7, fetRatio: '4' })
  assert.ok(dynamicsPreRollSeconds(slow) > dynamicsPreRollSeconds(fast) * 5,
    'a slow release must ask for far more pre-roll than a fast one')
})
