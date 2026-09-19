/**
 * The Input knob: one law across the whole travel, and an alignment offset that
 * makes a knob position mean the same reduction on every file.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FET1176Kernel, IN_DRIVE_SPAN_DB_LEGACY } from '../../src/audio/fet1176Processor.js'
import { FET_PUNCH_PRESETS } from '../../src/audio/pluginPresets/fetPunch.js'

const SR = 96000
const driveDbAt = (knob, alignDb) => {
  const k = new FET1176Kernel(SR)
  k.setParams({ inputDrive: knob, ...(alignDb === undefined ? {} : { inputAlignDb: alignDb }) })
  return k.inputDriveDb
}

test('the knob reaches the depth the reference reached', () => {
  assert.ok(Math.abs(driveDbAt(100) - 24) < 1e-9, 'top of travel is +24 dB of drive')
  assert.ok(Math.abs(driveDbAt(0) + 24) < 1e-9, 'bottom is unchanged at -24 dB')
})

/**
 * ⚠ THE SLOPE ONLY EVER FALLS, AND THAT IS WHY THE KNEE WAS ABANDONED. Keeping
 * the old law below knob 80 and adding the extra travel above it preserved every
 * saved preset, but gave a knob whose rate of change bulged: 0.335 dB per unit
 * below the knee, past 0.7 around knob 90, back to 0.384 at the top. A hardware
 * attenuator does not do that. One power law is monotonic by construction, which
 * is what IN_TAPER below 1 is modelling in the first place.
 */
test('the rate of change falls monotonically across the whole travel', () => {
  let prev = Infinity
  for (let knob = 5; knob <= 99; knob += 1) {
    const slope = (driveDbAt(knob + 0.01) - driveDbAt(knob - 0.01)) / 0.02
    assert.ok(slope <= prev + 1e-9, `slope rose at knob ${knob}: ${slope} after ${prev}`)
    prev = slope
  }
})

test('drive rises monotonically and the span is what it claims', () => {
  assert.ok(driveDbAt(100) - driveDbAt(0) > IN_DRIVE_SPAN_DB_LEGACY)
  let prev = -Infinity
  for (let knob = 0; knob <= 100; knob += 0.5) {
    const db = driveDbAt(knob)
    assert.ok(db > prev, `drive fell at knob ${knob}`)
    prev = db
  }
})

/**
 * ⚠ EVERY KNOB POSITION HAS MOVED AND THE FACTORY PRESETS ARE NOW MIS-VOICED.
 * That was accepted deliberately — the owner's call — in exchange for a knob
 * with a smooth rate of change and enough travel to reach the reference. This
 * records the size of the debt rather than letting it go unnoticed: the presets
 * are to be re-cut, and until they are, each one compresses harder than it did.
 */
test('the re-voicing debt is recorded, not silent', () => {
  const legacy = knob => -24 + IN_DRIVE_SPAN_DB_LEGACY * Math.pow(knob / 100, 0.8)
  for (const preset of FET_PUNCH_PRESETS) {
    const knob = preset.params.inputDrive ?? 50
    const shift = driveDbAt(knob) - legacy(knob)
    assert.ok(shift > 0 && shift < 8,
      `${preset.id} at inputDrive ${knob} moved ${shift.toFixed(2)} dB`)
  }
})

/**
 * ⚠ THE OFFSET GOES ON THE DETECTOR, NOT ON `inputLin`. OptoSmooth can ride the
 * side-chain drive because `scDriveDb` is side-chain only; here `inputLin` gains
 * the AUDIO as well, so folding the offset into it would raise the output level
 * and drive the saturator harder — the "input gain that has to undo itself
 * downstream" that dsp/inputAlign.js argues against.
 */
test('alignment does not touch the audio-path gain', () => {
  assert.equal(driveDbAt(55, 0), driveDbAt(55, 12),
    'inputDriveDb must not move with the alignment offset')
})

test('with alignment on, a knob position delivers the same reduction at any level', () => {
  const reduce = (peakDbfs, alignDb) => {
    const k = new FET1176Kernel(SR)
    k.setParams({ outputGainDb: 0, mix: 1, fetDrive: 0, oversample: false,
      inputDrive: 55, ratio: '4', attack: 4, release: 4, inputAlignDb: alignDb })
    const amp = Math.pow(10, peakDbfs / 20)
    const x = new Float32Array(SR)
    for (let i = 0; i < x.length; i++) x[i] = amp * Math.sin(2 * Math.PI * 4000 * i / SR)
    const y = new Float32Array(x.length)
    for (let f = 0; f < x.length; f += 128) {
      const l = Math.min(128, x.length - f)
      k.process([x.subarray(f, f + l)], [y.subarray(f, f + l)], l)
    }
    return k.maxGrDb
  }
  const levels = [-6, -12, -18, -24, -30]
  const raw = levels.map(l => reduce(l, 0))
  const aligned = levels.map(l => reduce(l, -12 - l))

  // The bug, stated as a measurement: unaligned, the knob does nothing on a
  // quiet file and a great deal on a hot one.
  assert.ok(Math.max(...raw) - Math.min(...raw) > 10,
    `unaligned spread should be large; got ${raw.map(v => v.toFixed(2)).join(' / ')}`)
  assert.ok(Math.max(...aligned) - Math.min(...aligned) < 0.01,
    `aligned spread must be flat; got ${aligned.map(v => v.toFixed(2)).join(' / ')}`)
})

/**
 * ⚠ AN ABSENT OFFSET MUST BE A NO-OP, because that is what every caller that has
 * not measured yet sends. The effect wrapper's own seeding — `setParam` gates on
 * `name in params`, so an unseeded key is dropped silently — cannot be asserted
 * here: that module imports a Vite worker URL Node will not resolve, which is
 * what `npm run smoke` is the guard for.
 */
test('an unset offset changes nothing', () => {
  const render = params => {
    const k = new FET1176Kernel(SR)
    k.setParams({ outputGainDb: 0, mix: 1, oversample: false, inputDrive: 70, ...params })
    const x = new Float32Array(SR / 2)
    for (let i = 0; i < x.length; i++) x[i] = 0.3 * Math.sin(2 * Math.PI * 1000 * i / SR)
    const y = new Float32Array(x.length)
    for (let f = 0; f < x.length; f += 128) {
      const l = Math.min(128, x.length - f)
      k.process([x.subarray(f, f + l)], [y.subarray(f, f + l)], l)
    }
    return y
  }
  const absent = render({})
  const zero = render({ inputAlignDb: 0 })
  for (let i = 0; i < absent.length; i++) {
    if (absent[i] !== zero[i]) assert.fail(`sample ${i}: absent is not the same as 0`)
  }
})
