/**
 * A bench control moved BACK to its default must reach a live kernel.
 *
 * ⚠ `la2aTuningOverrides()` omits default keys and `setParams` merges, so the
 * running preview kept the old value (PR #186 review: Sib guard 100 → 0 → 100,
 * and Reset). The live paths spread `withTuningDefaults` /
 * `withNestedTuningDefaults`; these drive a persistent kernel through exactly
 * the message those paths build.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { LA2AKernel } from '../../src/audio/la2aProcessor.js'
import { SchepsKernel } from '../../src/audio/schepsProcessor.js'
import { LA2A_DEFAULTS, toKernelParams } from '../../src/audio/effects/la2aParams.js'
import { SCHEPS_DEFAULTS, toKernelParams as toSchepsKernelParams } from '../../src/audio/effects/schepsParams.js'
import {
  setLA2ATuning, resetLA2ATuning, withTuningDefaults, withNestedTuningDefaults,
} from '../../src/audio/effects/la2aTuning.js'

const SR = 44100

test('LA Vintage 2A: 100 → 0 → 100 and Reset reach the live kernel', () => {
  const k = new LA2AKernel(SR)
  const push = () => k.setParams(withTuningDefaults(toKernelParams({ ...LA2A_DEFAULTS })))
  try {
    push()
    assert.equal(k.sibDepth, 1)
    setLA2ATuning({ sibilanceGuard: 0, emphasis: 0 }); push()
    assert.equal(k.sibDepth, 0)
    assert.equal(k.emphasisActive, false)
    setLA2ATuning({ sibilanceGuard: 100 }); push()
    assert.equal(k.sibDepth, 1)
    resetLA2ATuning(); push()
    assert.equal(k.emphasisActive, true)
  } finally {
    resetLA2ATuning()
  }
})

test('the bug this guards: without the defaults the stale value stays', () => {
  const k = new LA2AKernel(SR)
  try {
    setLA2ATuning({ sibilanceGuard: 0 })
    k.setParams(toKernelParams({ ...LA2A_DEFAULTS }))
    resetLA2ATuning()
    k.setParams(toKernelParams({ ...LA2A_DEFAULTS }))
    assert.equal(k.sibDepth, 0, 'the merge no longer keeps stale keys — the helper may be redundant')
  } finally {
    resetLA2ATuning()
  }
})

test('Scheps: the nested tuning reaches its embedded kernel the same way', () => {
  const k = new SchepsKernel(SR)
  const push = () => k.setParams(withNestedTuningDefaults(toSchepsKernelParams({ ...SCHEPS_DEFAULTS })))
  try {
    push()
    assert.equal(k.la2a.sibDepth, 1)
    setLA2ATuning({ sibilanceGuard: 0 }); push()
    assert.equal(k.la2a.sibDepth, 0)
    resetLA2ATuning(); push()
    assert.equal(k.la2a.sibDepth, 1)
  } finally {
    resetLA2ATuning()
  }
})

test('the live message changes nothing at defaults', () => {
  const a = new LA2AKernel(SR)
  const b = new LA2AKernel(SR)
  a.setParams(toKernelParams({ ...LA2A_DEFAULTS, peakReduction: 70 }))
  b.setParams(withTuningDefaults(toKernelParams({ ...LA2A_DEFAULTS, peakReduction: 70 })))
  const n = 4096
  const x = new Float32Array(n).map((_, i) => 0.5 * Math.sin(i * 0.07) + 0.1 * Math.sin(i * 1.3))
  const ya = new Float32Array(n); const yb = new Float32Array(n)
  for (let o = 0; o < n; o += 128) {
    a.process([x.subarray(o, o + 128)], [ya.subarray(o, o + 128)], 128)
    b.process([x.subarray(o, o + 128)], [yb.subarray(o, o + 128)], 128)
  }
  for (let i = 0; i < n; i++) assert.equal(yb[i], ya[i])
})
