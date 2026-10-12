/**
 * Run with:  npm test
 *
 * Parallel apply on the gaps material (chunkStitch.js): every chunked plugin
 * stitched against its continuous render, and the case that made the run-in
 * long — the HF Softener's trackers settle slowly through the silent gaps: at
 * 2 s of run-in a seam read −95 dBFS, 33 ms in.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MATERIALS, PLUGINS, SEAM_FLOOR_DBFS, seamDbfs } from './chunkStitch.js'

for (const [name, build] of PLUGINS) {
  test(`chunks stitch into the continuous render (gaps): ${name}`, () => {
    const mat = MATERIALS.gaps()
    const got = seamDbfs(mat, build(mat.xs))
    assert.ok(got < SEAM_FLOOR_DBFS, `worst seam difference ${got.toFixed(1)} dBFS (floor ${SEAM_FLOOR_DBFS})`)
  })
}

test('⚠ a 2 s run-in is NOT enough here: HF Softener, defaults', () => {
  const mat = MATERIALS.gaps()
  const [, build] = PLUGINS.find(([name]) => name === 'HF Softener, defaults')
  const got = seamDbfs(mat, build(mat.xs), { runInS: 2 })
  assert.ok(got > -120, `at 2 s of run-in the seam residue should still show; got ${got.toFixed(1)} dBFS`)
})
