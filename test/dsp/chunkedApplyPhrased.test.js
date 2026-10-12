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
  const got = seamDbfs(mat, build(mat.xs), { runInS: 2 })
  assert.ok(got > -120, `at 2 s of run-in the seam residue should still show; got ${got.toFixed(1)} dBFS`)
})
