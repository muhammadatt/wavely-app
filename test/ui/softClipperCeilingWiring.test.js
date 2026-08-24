import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { SOFT_CLIPPER_DEFAULTS, toKernelParams } from '../../src/audio/effects/softClipperParams.js'
import { SOFT_CLIPPER_KERNEL_DEFAULTS, processSoftClipperBuffer } from '../../src/audio/softClipperProcessor.js'
import { CEILING_PRESETS, measurePeakCeilingDb } from '../../src/audio/ceilingPresets.js'

/**
 * The ceiling-preset wiring, tested where it can break.
 *
 * The composable and the panel are Vue and out of this suite's reach (see the
 * test-infrastructure note in CLAUDE.md), so the links that CAN be reached are
 * exercised directly and the rest are checked as source invariants — blunt, but
 * it fails when someone deletes the line.
 */

const SR = 48000
const read = p => fs.readFileSync(new URL(p, import.meta.url), 'utf8')

function narration(seconds, peakDb, seed = 11) {
  const n = Math.round(seconds * SR)
  const out = new Float32Array(n)
  const peakAmp = Math.pow(10, peakDb / 20)
  let s = seed
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff }
  const burstN = Math.round(0.012 * SR)
  let i = 0
  let syl = 0
  while (i < n) {
    const sylN = Math.round((0.08 + rnd() * 0.14) * SR)
    const gapN = Math.round((0.02 + rnd() * 0.06) * SR)
    const amp = peakAmp * Math.pow(10, (-16 + 8 * rnd()) / 20)
    const f0 = 100 + rnd() * 60
    const plosive = syl++ % 5 === 0
    for (let j = 0; j < sylN && i < n; j++, i++) {
      const env = Math.sin((Math.PI * j) / sylN) ** 1.5
      const t = i / SR
      let v = (amp * env * (Math.sin(2 * Math.PI * f0 * t) + 0.5 * Math.sin(4 * Math.PI * f0 * t)
        + 0.33 * Math.sin(6 * Math.PI * f0 * t) + 0.25 * Math.sin(8 * Math.PI * f0 * t))) / 2.08
      if (plosive && j < burstN) {
        const pe = 1 - j / burstN
        v += peakAmp * 0.95 * pe * pe * Math.sin((2 * Math.PI * 95 * j) / SR)
      }
      out[i] = v
    }
    for (let j = 0; j < gapN && i < n; j++, i++) out[i] = peakAmp * 0.002 * (rnd() - 0.5)
  }
  return out
}

test('the worker measures the ceiling at the requested percentile', () => {
  const src = read('../../src/workers/processWorker.js')
  assert.match(src, /measurePeakCeilingDb/, 'worker must import the measurement')
  assert.match(src, /case 'softClipperCeiling'/)
  // ⚠ The percentile has to reach it. Dropping `params` here makes every preset
  // return the same ceiling and the whole ladder collapses to one button.
  assert.match(src, /measurePeakCeilingDb\(channelData, sampleRate, params\.percentile\)/)
})

test('processing sends the matching type and forwards the percentile', () => {
  const src = read('../../src/audio/processing.js')
  assert.match(src, /measureInWorker\('softClipperCeiling', segments, start, end, \{ percentile \}/)
  assert.match(src, /export function computeSoftClipperCeiling/)
})

test('a preset writes the ceiling, and turning the knob drops the preset', () => {
  const src = read('../../src/composables/useSoftClipper.js')
  assert.match(src, /fixedThresholdDb\.value = measured/, 'the preset must set the ceiling')
  assert.match(src, /ceilingPreset\.value = preset\.id/)
  // The lamp must go out when the value stops being the preset's.
  const sync = src.slice(src.indexOf('const syncFixedThreshold'))
  assert.match(sync.slice(0, 300), /ceilingPreset\.value = null/)
})

test('a null measurement leaves the ceiling where it is', () => {
  // Moving the knob to some fallback would be worse than not moving it: the
  // user asked for a value derived from this material and there isn't one.
  const src = read('../../src/composables/useSoftClipper.js')
  const fn = src.slice(src.indexOf('async function applyCeilingPreset'))
  assert.match(fn.slice(0, 1200), /if \(measured === null\) return/)
})

test('a region change never re-measures over a hand-set ceiling', () => {
  // Once the ceiling is hand-set it is the user's number; re-measuring on a
  // selection change would overwrite a deliberate choice. `userSetCeiling` is
  // the flag that records that, so the guard has to consult it.
  //
  // ⚠ IT IS NOT SIMPLY "ONLY WHILE A PRESET IS ACTIVE" ANY MORE, and it could
  // not stay that way: the panel's open-time measurement needs a region, the
  // presets are disabled until there is one, and with the old guard a user who
  // opened the panel before selecting got no measurement at all — the ceiling
  // sat at the kernel's arbitrary -10 dBFS until they clicked a button they
  // had no reason to think was waiting for them. The first selection is the
  // moment that measurement becomes possible, so it runs then.
  const src = read('../../src/composables/useSoftClipper.js')
  const fn = src.slice(src.indexOf('function scheduleCeilingPreset'))
  assert.match(fn.slice(0, 400), /userSetCeiling/,
    'a hand-set ceiling can be overwritten by a selection change')
  assert.match(fn.slice(0, 400), /DEFAULT_CEILING_PRESET/,
    'the first selection does not place the opening measurement')
})

test('teardown cancels a pending measurement', () => {
  const src = read('../../src/composables/useSoftClipper.js')
  const teardown = src.slice(src.indexOf('function teardown()'))
  assert.match(teardown.slice(0, 600), /clearTimeout\(ceilingTimer\)/)
})

test('the panel is fixed-only and offers the presets', () => {
  const src = read('../../src/components/panels/SoftClipperModal.vue')
  assert.doesNotMatch(src, /MODE_OPTIONS/, 'the threshold mode switch must be gone')
  assert.doesNotMatch(src, /setThresholdMode/, 'the panel must not set the mode any more')
  assert.match(src, /v-for="p in CEILING_PRESETS"/, 'the presets must be reachable')
  assert.match(src, /applyCeilingPreset\(p\.id\)/)
  assert.match(src, /watch\(\(\) => state\.selection/, 're-measure when the region changes')

  const composable = read('../../src/composables/useSoftClipper.js')
  assert.match(composable, /const thresholdMode = ref\('fixed'\)/,
    'the panel state must default to a fixed ceiling regardless of the kernel default')
})

test('static mode is gone from the kernel and the param contract', () => {
  // It was superseded by a ceiling the user can read and turn. Two
  // parameterisations of one motionless threshold is the duplication this
  // codebase keeps learning not to ship.
  assert.ok(!('staticSpeechLevelDb' in SOFT_CLIPPER_KERNEL_DEFAULTS))
  assert.ok(!('staticSpeechLevelDb' in toKernelParams(SOFT_CLIPPER_DEFAULTS)))
  const kernel = read('../../src/audio/softClipperProcessor.js')
  assert.doesNotMatch(kernel, /staticMode/)
})

test('end to end: measure, set the ceiling, and the curve does more at each step', () => {
  const sig = narration(10, -1)
  let last = Infinity
  for (const preset of CEILING_PRESETS) {
    const ceilingDb = measurePeakCeilingDb([sig], SR, preset.percentile)
    assert.ok(Number.isFinite(ceilingDb))

    const params = toKernelParams({
      ...SOFT_CLIPPER_DEFAULTS,
      thresholdMode: 'fixed',
      fixedThresholdDb: ceilingDb,
    })
    assert.equal(params.fixedThresholdDb, ceilingDb)

    const { metering } = processSoftClipperBuffer([sig], SR, params)
    // Each step down the ladder must touch more of the file than the last —
    // that is the only thing the labels promise.
    assert.ok(metering.engagedFraction > 0 || preset.percentile > 0.95,
      `${preset.id} engaged ${(metering.engagedFraction * 100).toFixed(2)}%`)
    assert.ok(ceilingDb < last, `${preset.id} ceiling ${ceilingDb.toFixed(2)} must sit below the previous`)
    last = ceilingDb
  }
})
