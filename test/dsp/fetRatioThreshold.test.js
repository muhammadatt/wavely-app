/**
 * Run with:  npm test
 *
 * THE RATIO-DEPENDENT THRESHOLD A/B.
 *
 * ⚠ THE TWO REFERENCES DISAGREE AND THE HARDWARE SIDES AGAINST US. FETish holds
 * its threshold fixed across all four ratio buttons — 16 captures, four buttons
 * at four Input positions, identical to the printed digit every time, 0.00 dB of
 * spread. CLA-76 moves it 3.88-4.11 dB, monotone in ratio, at every drive. The
 * UA manual agrees with CLA-76: "selecting higher ratios also raises the
 * threshold level" (via Moore, JARP 2012), and FETish therefore contradicts its
 * own documentation.
 *
 * So `'fixed'` ships — it reproduces one reference exactly — and `'moving'` is a
 * bench switch for deciding by ear whether to follow the hardware instead. This
 * pins both sides, because the interesting failure is a switch that looks wired
 * and does nothing.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  FET1176Kernel, ratioThresholdOffsetDb, RATIO_THRESHOLD_PER_OCTAVE_DB,
} from '../../src/audio/fet1176Processor.js'

const thresholdOf = (ratio, mode) => {
  const k = new FET1176Kernel(44100)
  k.setParams({ ratio, ratioThreshold: mode })
  return k.thresholdDb
}

test('fixed is what ships, and holds one threshold for every button', () => {
  const vals = ['4', '8', '12', '20'].map(r => thresholdOf(r, 'fixed'))
  assert.equal(new Set(vals).size, 1, `fixed must not move: ${vals.join(' / ')}`)
  // The default must BE fixed — the A/B is opt-in, not opt-out.
  assert.equal(thresholdOf('20', undefined), thresholdOf('4', undefined))
})

/**
 * ⚠ THE NUMBERS ARE CLA-76'S OWN, not a shape chosen to look tidy. Measured
 * offsets against its ratio 4: +1.778 at 8:1, +2.673 at 12:1, +3.975 at 20:1,
 * which a line in log2(ratio) fits at 1.712 dB per octave with a worst residual
 * of 0.135 dB over all 16 captures.
 */
test('moving reproduces CLA-76 measured offsets', () => {
  const want = { 8: 1.778, 12: 2.673, 20: 3.975 }
  const base = thresholdOf('4', 'moving')
  assert.equal(base, thresholdOf('4', 'fixed'), 'ratio 4 is the anchor and must not move')
  for (const [ratio, offset] of Object.entries(want)) {
    const got = thresholdOf(ratio, 'moving') - base
    assert.ok(Math.abs(got - offset) < 0.15,
      `ratio ${ratio}: ${got.toFixed(3)} dB against a measured ${offset}`)
  }
})

test('the offset is monotone in the ratio, and zero at the anchor', () => {
  assert.equal(ratioThresholdOffsetDb('4'), 0)
  const seq = ['4', '8', '12', '20'].map(r => ratioThresholdOffsetDb(r))
  for (let i = 1; i < seq.length; i++) assert.ok(seq[i] > seq[i - 1], 'must rise with ratio')
  assert.ok(RATIO_THRESHOLD_PER_OCTAVE_DB > 0, 'the threshold RISES with ratio, it does not fall')
})

/**
 * ⚠ AND IT HAS TO REACH THE AUDIO. A raised threshold means LESS overshoot at
 * the same Input, so the higher buttons must compress less — which is the whole
 * audible consequence of the switch and the thing being auditioned.
 */
test('moving reduces compression on the higher buttons, and leaves ratio 4 alone', () => {
  const grOf = (ratio, mode) => {
    const k = new FET1176Kernel(44100)
    k.setParams({ inputDrive: 60, ratio, attack: 1, release: 7, fetDrive: 0,
      oversample: false, outputGainDb: 0, mix: 1, ratioThreshold: mode })
    const n = 44100
    const x = new Float32Array(n)
    const amp = Math.pow(10, -12 / 20)
    for (let i = 0; i < n; i++) x[i] = amp * Math.sin(2 * Math.PI * 1000 * i / 44100)
    k.process([x], [new Float32Array(n)], n)
    return k.getMetering().maxGainReductionDb
  }
  assert.ok(Math.abs(grOf('4', 'moving') - grOf('4', 'fixed')) < 1e-9,
    'the anchor button must render identically under both')
  for (const ratio of ['8', '12', '20']) {
    assert.ok(grOf(ratio, 'moving') < grOf(ratio, 'fixed') - 0.5,
      `ratio ${ratio} must compress less under the moving threshold`)
  }
})

/**
 * ⚠ ALL-BUTTONS IS OUT OF SCOPE AND MUST STAY OUT. It carries its own
 * `ALL_THRESHOLD_DROP_DB` from the base threshold; folding it into this switch
 * would silently change a mode whose law is still being measured.
 */
test('all-buttons is untouched by the switch', () => {
  assert.equal(thresholdOf('all', 'moving'), thresholdOf('all', 'fixed'))
})

/**
 * ⚠ A BENCH KEY, NOT A PATCH KEY. It must never be serialised into a preset —
 * the same rule every other bench control follows.
 */
test('the switch is bench state and never reaches a preset', async () => {
  const { FET_PUNCH_PARAM_KEYS } = await import('../../src/audio/pluginPresets/fetPunch.js')
  assert.ok(!FET_PUNCH_PARAM_KEYS.includes('ratioThreshold'))
  const { FET1176_DEFAULTS } = await import('../../src/audio/effects/fet1176Params.js')
  assert.ok(!('ratioThreshold' in FET1176_DEFAULTS))
})
