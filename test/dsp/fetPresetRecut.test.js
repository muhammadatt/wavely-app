/**
 * Run with:  npm test
 *
 * THE FACTORY PRESETS STILL DO WHAT THEY WERE CUT TO DO.
 *
 * ⚠⚠ THIS EXISTS BECAUSE DOING NOTHING IS A RE-VOICING. Five module-level
 * constants moved under these presets during the FET re-tune — the Input span
 * (40 -> 48 dB), the release endpoints (1.51x faster), the release depth
 * schedule, the attack depth schedule and the knee law — and not one of them is
 * reachable from a patch. Left on their stored dials the presets had drifted
 * **+1.72 / +2.13 / -0.68 / +7.82 dB** of average gain reduction, silently,
 * because nothing in the suite was watching what a preset DELIVERS.
 *
 * So this pins the delivery, not the dials. The targets below are what each
 * preset produced on the as-cut kernel (commit 57e1877), measured by
 * `scripts/fet-recut-presets.mjs`, which is also what to re-run if this fails
 * for a good reason.
 *
 * ⚠ A FAILURE HERE IS NOT NECESSARILY A BUG. It means a kernel change moved
 * what the presets do. That is sometimes correct and sometimes not — but it
 * must be a decision, which is the whole point of failing rather than drifting.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FET_PUNCH_PRESETS } from '../../src/audio/pluginPresets/fetPunch.js'
import { narration, meterGr } from '../../scripts/fet-recut-presets.mjs'

/** Average gain reduction on the narration fixture, as-cut kernel, dB. */
const AS_CUT_AVG_GR = {
  'factory:vocal-punch': 4.21,
  'factory:consonant-control': 5.46,
  'factory:gentle-ride': 3.24,
  'factory:parallel-thickener': 6.54,
}

/**
 * ⚠ 0.15 dB, AND IT IS NOT ARBITRARY. The re-cut lands the four presets at
 * -0.05 / +0.06 / -0.10 / -0.04 dB, so this is about half a dB of headroom over
 * the worst of them — tight enough that the +7.82 dB drift this file exists to
 * catch could never hide in it, loose enough that a fixture or rounding change
 * does not cry wolf.
 */
const TOLERANCE_DB = 0.15

const kernelParams = (p) => ({
  inputDrive: p.inputDrive,
  attack: p.attack,
  release: p.release,
  ratio: p.ratio,
  fetDrive: p.fetDrive,
  scHpfHz: p.scHpf,
  mix: p.mix,
})

const NEW = await import('../../src/audio/fet1176Processor.js')
const x = narration()

for (const preset of FET_PUNCH_PRESETS) {
  const want = AS_CUT_AVG_GR[preset.id]
  if (want === undefined) continue
  test(`${preset.id} still delivers what it was cut to deliver`, () => {
    const got = meterGr(NEW, kernelParams(preset.params), x).avg
    assert.ok(Math.abs(got - want) < TOLERANCE_DB,
      `${preset.id}: ${got.toFixed(2)} dB of average reduction against the ${want} it was cut for ` +
      `(${(got - want >= 0 ? '+' : '') + (got - want).toFixed(2)}). A kernel change has re-voiced it — ` +
      're-run `npm run fet:recut` and decide whether that was intended.')
  })
}

/**
 * ⚠ ALL-BUTTONS IS EXCLUDED ON PURPOSE AND THAT MUST NOT ROT INTO AN OVERSIGHT.
 * Its law has no captures behind it from either reference, and CLA-76's stairs
 * captures already say `ALL_KNEE_DB` and `ALL_THRESHOLD_DROP_DB` are too big —
 * so it keeps its original dials and its drift until that law is measured.
 */
test('all-buttons is left un-recut, deliberately and visibly', () => {
  const all = FET_PUNCH_PRESETS.find(p => p.id === 'factory:all-buttons-in')
  assert.ok(all, 'the preset must still exist')
  assert.equal(all.params.ratio, 'all')
  assert.equal(AS_CUT_AVG_GR[all.id], undefined,
    'if all-buttons ever gains a target here, its law has been measured — say so in the note above')
  // The original dials, unchanged. A quiet edit to these is the thing to catch.
  assert.deepEqual(
    { inputDrive: all.params.inputDrive, attack: all.params.attack, release: all.params.release },
    { inputDrive: 70, attack: 7, release: 7 })
})

/**
 * `output` must stay canonicalised. The percentile makeup is solved per FILE, so
 * a stored output would be another file's answer applied to this one.
 */
test('no preset stores a makeup gain', () => {
  for (const p of FET_PUNCH_PRESETS) {
    assert.equal(p.params.output, 0, `${p.id} stores an output gain`)
    assert.equal(p.params.autoMakeup, true, `${p.id} does not leave the makeup to AUTO`)
  }
})
