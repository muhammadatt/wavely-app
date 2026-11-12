/**
 * Run with:  npm test
 *
 * Parallel apply on the phrased material (chunkStitch.js): every chunked plugin
 * stitched against its continuous render, and the case that made the run-in
 * long — Scheps' opto cell releases slowly through the phrasing: at 2 s of
 * run-in a seam read −115 dBFS at the seam sample.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MATERIALS, PLUGINS, SEAM_FLOOR_DBFS, seamDbfs } from './chunkStitch.js'

for (const [name, build] of PLUGINS) {
  test(`chunks stitch into the continuous render (phrased): ${name}`, () => {
    const mat = MATERIALS.phrased()
    const got = seamDbfs(mat, build(mat.xs))
    assert.ok(got < SEAM_FLOOR_DBFS, `worst seam difference ${got.toFixed(1)} dBFS (floor ${SEAM_FLOOR_DBFS})`)
  })
}

test('⚠ a 2 s run-in is NOT enough here: Scheps Parallel', () => {
  const mat = MATERIALS.phrased()
  const [, build] = PLUGINS.find(([name]) => name === 'Scheps Parallel')
  /**
   * ⚠ PINNED TO THE KERNEL WITHOUT THE SIBILANCE GUARD, the one this residue was
   * measured on: with the guard the 2 s seam settles to −128.9 dBFS (−113.9
   * without), which says the guard is easier to stitch, not that 2 s is enough.
   * The canary is about how long a kernel takes to settle on this material.
   */
  const b = build(mat.xs)
  const unguarded = {
    ...b,
    stages: b.stages.map(s => ({
      ...s,
      kernelParams: { ...s.kernelParams, la2aTuning: { ...(s.kernelParams.la2aTuning ?? {}), sibilanceGuard: 0 } },
    })),
  }
  const got = seamDbfs(mat, unguarded, { runInS: 2 })
  assert.ok(got > -120, `at 2 s of run-in the seam residue should still show; got ${got.toFixed(1)} dBFS`)
})
